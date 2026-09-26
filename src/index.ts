import TelegramBot, { TelegramApi } from '@codebam/cf-workers-telegram-bot';
import OpenAI from "openai";

import telegramifyMarkdown from "telegramify-markdown"
//@ts-ignore
import { Buffer } from 'node:buffer';
import { isJPEGBase64 } from './isJpeg';
import { extractAllOGInfo } from "./og"
import { logModelError } from './logModelError';
import { formatRichTelegramMessage } from './richFormat';
function dispatchContent(content: string): { type: "text", text: string } | { type: "image_url", image_url: { url: string } } {
	if (content.startsWith("data:image/jpeg;base64,")) {
		return ({
			"type": "image_url",
			"image_url": {
				"url": content
			},
		})
	}
	return ({
		"type": "text",
		"text": content,
	});
}

function getMessageLink(r: { groupId: string, messageId: number }) {
	return `https://t.me/c/${parseInt(r.groupId.slice(2))}/${r.messageId}`;
}

function getSendTime(r: R) {
	return new Date(r.timeStamp).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function escapeMarkdownV2(text: string) {
	// 注意：反斜杠 \ 本身也需要转义，所以正则表达式中是 \\\\
	// 或者直接在字符串中使用 \
	const reservedChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
	// 正则表达式需要转义特殊字符
	const escapedChars = reservedChars.map(char => '\\' + char).join('');
	const regex = new RegExp(`([${escapedChars}])`, 'g');
	return text.replace(regex, '\\$1');
}

/**
 * 将数字转换为上标数字
 * @param {number} num - 要转换的数字
 * @returns {string} 上标形式的数字
 */
export function toSuperscript(num: number) {
	const superscripts = {
		'0': '⁰',
		'1': '¹',
		'2': '²',
		'3': '³',
		'4': '⁴',
		'5': '⁵',
		'6': '⁶',
		'7': '⁷',
		'8': '⁸',
		'9': '⁹'
	};

	return num
		.toString()
		.split('')
		.map(digit => superscripts[digit as keyof typeof superscripts])
		.join('');
}
/**
 * 处理 Markdown 文本中的重复链接，将其转换为顺序编号的格式
 * @param {string} text - 输入的 Markdown 文本
 * @param {Object} options - 配置选项
 * @param {string} options.prefix - 链接文本的前缀，默认为"链接"
 * @param {boolean} options.useEnglish - 是否使用英文(link1)而不是中文(链接1)，默认为 false
 * @returns {string} 处理后的 Markdown 文本
 */
export function processMarkdownLinks(text: string, options: { prefix: string, useEnglish: boolean } = {
	prefix: '引用',
	useEnglish: false
}) {
	const {
		prefix,
		useEnglish
	} = options;

	// 用于存储已经出现过的链接
	const linkMap = new Map();
	let linkCounter = 1;

	// 匹配 markdown 链接的正则表达式
	const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;

	return text.replace(linkPattern, (match, displayText, url) => {
		// 只处理显示文本和 URL 完全相同的情况
		if (displayText !== url) {
			return match; // 保持原样
		}

		// 如果这个 URL 已经出现过，使用已存在的编号
		if (!linkMap.has(url)) {
			linkMap.set(url, linkCounter++);
		}
		const linkNumber = linkMap.get(url);

		// 根据选项决定使用中文还是英文格式
		const linkPrefix = useEnglish ? 'link' : prefix;

		// 返回新的格式 [链接1](原URL) 或 [link1](原URL)
		return `[${linkPrefix}${toSuperscript(linkNumber)}](${url})`;
	});
}

type R = {
	groupId: string;
	userName: string;
	content: string;
	messageId: number;
	timeStamp: number;
}
export const BOT_COMMANDS = [
	{ command: "summary", description: "概括群聊消息（如 /summary 10 或 /summary 10h）" },
	{ command: "ask", description: "基于近期群聊记录回答问题（私聊回复答案）" },
	{ command: "query", description: "搜索群聊历史记录中的关键词" },
	{ command: "status", description: "检查机器人当前运行状态" },
	{ command: "help", description: "查看机器人的功能与指令说明" },
];

export async function registerBotCommands(token: string) {
	try {
		const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ commands: BOT_COMMANDS }),
		});
		if (!res.ok) {
			console.error("Failed to register bot commands:", res.status, await res.text());
		}
	} catch (e) {
		console.error("Failed to register bot commands:", e);
	}
}

function getModelName(env: Env): string {
	return env.AI_MODEL || env.MODEL || "";
}

function getTelegramToken(env: Env): string {
	return env.TELEGRAM_BOT_TOKEN || env.SECRET_TELEGRAM_API_TOKEN || "";
}

function getApiKey(env: Env): string {
	return env.AI_API_KEY || env.OPENAI_API_KEY || env.GEMINI_API_KEY || "";
}

function getBaseUrl(env: Env): string | undefined {
	return env.AI_BASE_URL || env.BASE_URL || undefined;
}

// Share GPT request settings across commands and scheduled summaries.
const completionOptions = {
	max_completion_tokens: 4096,
	reasoning_effort: "none",
} as const;

function getGenModel(env: Env) {
	const baseURL = getBaseUrl(env);
	const openai = new OpenAI({
		apiKey: getApiKey(env),
		...(baseURL ? { baseURL } : {}),
		timeout: 999999999999,
	});
	return openai;
}

// System prompts for different scenarios
const SYSTEM_PROMPTS = {
	summarizeChat: `你是一个专业的群聊总结助手。你的任务是用层次清晰、富于视觉表现力且符合群聊氛围的结构概括对话内容。
对话将按以下格式提供：
====================
用户名:
发言内容
相应链接
====================

请严格遵循以下排版规范输出：
1. **【💡 核心要点速览】**：
   在开头用 2~4 个精炼要点概括今日群聊最核心的共识、进展或突发热点，使用 📌 或 💡 开头。

2. **【📊 议题简表】（必须输出标准 Markdown 表格）**：
   梳理本次讨论的核心议题，输出简洁的 Markdown 表格：
   | 议题分类 | 核心结论 / 共识 |
   | :--- | :--- |
   | ... | ... |
   （精炼概括，通常包含 2~5 个关键议题）

3. **【💬 详细脉络与讨论溯源】（放入 <details> 标签中实现折叠）**：
   在表格之后，使用 <details> 标签将详细讨论与引用包裹起来，示例：
   <details>
   <summary>💬 点击展开详细讨论与消息溯源</summary>
   1. **议题一**：记录具体的讨论经过，必须用 Markdown 链接引用发言原消息，格式如：[引用1](链接)
   2. **议题二**：记录具体的讨论经过，引用相关言论 [引用2](链接)
   若有包含图片内容，请在相应议题中进行生动的描述。
   </details>

4. 整体风格专业干练，捕捉对话真实情绪，层次分明。`,

	answerQuestion: `你是一个群聊智能问答助手。你的任务是基于提供的群聊记录精准回答用户的问题。
群聊记录将按以下格式提供：
====================
用户名:
发言内容
相应链接
====================

请遵循以下排版规范：
1. **直接回答**：在最开头直接了当回答用户的问题，条理清晰。
2. **证据与对话溯源（使用 <details> 折叠）**：
   如果回答需要引用多条原始记录作为依据，将依据来源放在 <details> 标签中：
   <details>
   <summary>🔍 依据来源与原消息引用</summary>
   - 发言人: "原发言简述" [引用1](链接)
   </details>
3. 链接格式：必须使用 [引用1](链接) 并在两侧留有适当空格。
4. 如果群聊记录中找不到相关答案，请诚实说明，切勿编造。`
};

function getCommandVar(str: string, delim: string) {
	return str.slice(str.indexOf(delim) + delim.length);
}

function messageTemplate(s: string, modelName: string) {
	const header = modelName ? `下面由 ${escapeMarkdownV2(modelName)} 概括群聊信息\n` : `群聊信息概括如下：\n`;
	return header + s + `\n本开源项目[地址](https://github\\.com/cuteys/ChatGist)`;
}
/**
 * 
 * @param text 
 * @description I dont know why, but llm keep output tme.cat, so we need to fix it
 * @returns 
 */
function fixLink(text: string) {
	return text.replace(/tme\.cat/g, "t.me/c").replace(/\/c\/c/g, "/c");
}
function getUserName(msg: any) {
	if (msg?.sender_chat?.title) {
		return msg.sender_chat.title as string;
	}
	return msg.from?.first_name as string || "anonymous";
}
export default {
	async scheduled(
		controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	) {
		console.debug("Scheduled task starting:", new Date().toISOString());
		const date = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
		// Clean up oldest 4000 messages
		if (date.getHours() === 0 && date.getMinutes() < 5) {
			await env.DB.prepare(`
					DELETE FROM Messages
					WHERE id IN (
						SELECT id
						FROM (
							SELECT
								id,
								ROW_NUMBER() OVER (
									PARTITION BY groupId
									ORDER BY timeStamp DESC
								) as row_num
							FROM Messages
						) ranked
						WHERE row_num > 3000
					);`)
				.run();
		}
		const cache = caches.default;
		const cacheKey = new Request(`https://dummy-url/${getTelegramToken(env)}`);
		const cachedResponse = await cache.match(cacheKey);
		let groups: any[] = [];
		if (cachedResponse) {
			console.debug("Using cached response");
			groups = await cachedResponse.json();
		}
		else {
			console.debug("Fetching groups");
			groups = (await env.DB.prepare(`
		WITH MessageCounts AS (
			SELECT
				groupId,
				COUNT(*) as message_count
			FROM Messages
			WHERE timeStamp >= ?1 - (24 * 3600 * 1000)
			GROUP BY groupId
		)
		SELECT groupId, message_count
		FROM MessageCounts
		WHERE message_count > 10
		ORDER BY message_count DESC
		LIMIT 20;
		`).bind(Date.now()).all()).results;
			ctx.waitUntil(
				cache.put(cacheKey, new Response(JSON.stringify(groups), {
					headers: {
						'content-type': 'application/json',
						"Cache-Control": "s-maxage=10000", // > 7200 < 86400
					},
				})));
		}
		const batch = Math.floor(date.getMinutes() / 6);  // 0 <= batch < 10

		console.debug("Batch:", batch);
		console.debug("Found groups:", groups.length, JSON.stringify(groups));
		const model = getModelName(env);
		if (!model) {
			console.error("AI_MODEL is not configured, skipping scheduled summary.");
			return;
		}
		for (const [id, group] of groups.entries()) {
			if (id % 10 !== batch) {
				continue;
			}
			console.debug(`Processing group ${id + 1}/${groups.length}: ${group.groupId}`);
			const { results } = await env.DB.prepare('SELECT * FROM Messages WHERE groupId=? AND timeStamp >= ? ORDER BY timeStamp ASC')
				.bind(group.groupId, Date.now() - 24 * 60 * 60 * 1000)
				.all()

			const result = await getGenModel(env).chat.completions.create({
				model,
				messages: [
					{
						"role": "system",
						content: SYSTEM_PROMPTS.summarizeChat,
					},
					{
						"role": "user",
						content: results.flatMap(
							(r: any) => [
								dispatchContent(`====================`),
								dispatchContent(`${r.userName}:`),
								dispatchContent(r.content),
								dispatchContent(getMessageLink(r)),
							]
						)
					}],
				...completionOptions,
			})
			if ([-1001687785734].includes(parseInt(group.groupId as string))) {
				// todo: use cloudflare r2 to store skip list
				continue;
			}
			console.debug("send message to", group.groupId);

			// Use fetch to send message directly to Telegram API
			const res = await fetch(`https://api.telegram.org/bot${getTelegramToken(env)}/sendMessage`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					chat_id: group.groupId,
					text: messageTemplate(
						fixLink(
							formatRichTelegramMessage(
								processMarkdownLinks(result.choices[0].message.content || ""),
								{ isSummary: true }
							)
						),
						model
					),
					parse_mode: "MarkdownV2",
				}),
			});
			if (!res?.ok) {
				console.error("Failed to send reply", res?.statusText, await res?.text());
			}
		}
		// clean up old images
		if (date.getHours() === 0 && date.getMinutes() < 5) {
			ctx.waitUntil(env.DB.prepare(`
					DELETE
					FROM Messages
					WHERE timeStamp < ? AND content LIKE 'data:image/jpeg;base64,%'`)
				.bind(Date.now() - 24 * 60 * 60 * 1000)
				.run());
		}
		console.debug("cron processed");
	},
	fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
		const botToken = getTelegramToken(env);
		if (request.method === "GET") {
			const url = new URL(request.url);
			if (url.pathname === "/setcommands") {
				await registerBotCommands(botToken);
				return new Response(JSON.stringify({ ok: true, message: "Commands registered to Telegram", commands: BOT_COMMANDS }), {
					headers: { "Content-Type": "application/json; charset=utf-8" },
				});
			}
			return new Response("Telegram Summary Bot is running.");
		}

		await new TelegramBot(botToken)
			.on('start', async (ctx) => {
				await registerBotCommands(botToken);
				const startText = escapeMarkdownV2(`你好！我是群聊总结与问答助手。
请将我添加到群组中使用。

可用指令说明：
• /summary <数量/时间> - 概括群聊内容（如 /summary 10 或 /summary 10h）
• /ask <问题> - 基于群聊记录回答提问（私聊发送答案）
• /query <关键词> - 检索群聊历史消息
• /status - 检查机器人运行状态
• /help - 查看指令使用帮助`);
				await ctx.reply(startText, "MarkdownV2");
				return new Response('ok');
			})
			.on('help', async (ctx) => {
				const helpText = escapeMarkdownV2(`群聊总结机器人使用指南：

• /summary <数量/时间>
  概括群聊消息
  示例：/summary 20（最新20条）或 /summary 12h（最近12小时）

• /ask <问题>
  基于群聊近期聊天记录回答问题（私聊回复答案）
  示例：/ask 大家刚刚在讨论什么？

• /query <关键词>
  在群聊历史记录中检索关键词
  示例：/query 部署

• /status
  检查机器人运行状态

• /help
  查看本帮助指南

提示：请在 @BotFather 中将机器人隐私模式（Privacy Mode）设为 Disable，并确保在群内拥有读取消息权限。`);
				await ctx.reply(helpText, "MarkdownV2");
				return new Response('ok');
			})
			.on('setcommands', async (ctx) => {
				await registerBotCommands(botToken);
				await ctx.reply('已向 Telegram 同步注册中文指令列表！');
				return new Response('ok');
			})
			.on('status', async (ctx) => {
				const res = (await ctx.reply('机器人运行正常（我家还蛮大的）'))!;
				if (!res.ok) {
					console.error(`Error sending message:`, res);
				}
				return new Response('ok');
			})
			.on("query", async (ctx) => {
				const groupId = ctx.update.message!.chat.id;
				const messageText = ctx.update.message!.text || "";
				if (!messageText.split(" ")[1]) {
					const res = (await ctx.reply('请输入要查询的关键词'))!;
					if (!res.ok) {
						console.error(`Error sending message:`, res);
					}
					return new Response('ok');
				}
				const { results } = await env.DB.prepare(`
					SELECT * FROM Messages
					WHERE groupId=? AND content GLOB ?
					ORDER BY timeStamp DESC
					LIMIT 2000`)
					.bind(groupId, `*${messageText.split(" ")[1]}*`)
					.all();
				const res = (await ctx.reply(
					escapeMarkdownV2(`查询结果:
${results.map((r: any) => `${r.userName}: ${r.content} ${r.messageId == null ? "" : `[link](https://t.me/c/${parseInt(r.groupId.slice(2))}/${r.messageId})`}`).join('\n')}`), "MarkdownV2"))!;
				if (!res.ok) {
					console.error(`Error sending message:`, res.status, res.statusText, await res.text());
				}
				return new Response('ok');
			})
			.on("ask", async (ctx) => {
				const model = getModelName(env);
				if (!model) {
					await ctx.reply('未配置 AI_MODEL 环境变量，无法处理请求。');
					return new Response('ok');
				}
				const groupId = ctx.update.message!.chat.id;
				const userId = ctx.update.message!.from!.id;
				const messageText = ctx.update.message!.text || "";
				if (!messageText.split(" ")[1]) {
					const res = (await ctx.reply('请输入要问的问题'))!;
					if (!res.ok) {
						console.error(`Error sending message:`, res);
					}
					return new Response('ok');
				}
				let res = await ctx.api.sendMessage(ctx.bot.api.toString(), {
					"chat_id": userId,
					"parse_mode": "MarkdownV2",
					"text": "bot 已经收到你的问题, 请稍等",
					reply_to_message_id: -1,
				});
				if (!res.ok) {
					await ctx.reply(`请开启和 bot 的私聊, 不然无法接收消息`);
					return new Response('ok');
				}
				const { results } = await env.DB.prepare(`
					WITH latest_1000 AS (
						SELECT * FROM Messages
						WHERE groupId=?
						ORDER BY timeStamp DESC
						LIMIT 1000
					)
					SELECT * FROM latest_1000
					ORDER BY timeStamp ASC
					`)
					.bind(groupId)
					.all();
				let result;
				try {
					result = await getGenModel(env)
						.chat.completions.create({
							model,
							messages: [
								{
									"role": "system",
									content: SYSTEM_PROMPTS.answerQuestion,
								},
								{
									"role": "user",
									content: results.flatMap(
										(r: any) => [
											dispatchContent(`====================`),
											dispatchContent(`${r.userName}:`),
											dispatchContent(r.content),
											dispatchContent(getMessageLink(r)),
										]
									)
								},
								{
									"role": "user",
									content: `问题：${getCommandVar(messageText, " ")}`
								}
							],
							...completionOptions,
						});
				} catch (e) {
					logModelError(e, { command: 'ask', model }, [getApiKey(env), getTelegramToken(env)]);
					await ctx.reply('回答失败，AI 服务暂时无法完成请求，请稍后重试。');
					return new Response('ok');
				}
				const raw = result.choices[0].message.content || "";
				const response_text = fixLink(
					formatRichTelegramMessage(
						processMarkdownLinks(raw),
						{ isSummary: false }
					)
				);

				res = await ctx.api.sendMessage(ctx.bot.api.toString(), {
					"chat_id": userId,
					"parse_mode": "MarkdownV2",
					"text": response_text,
					reply_to_message_id: -1,
				});
				if (!res.ok) {
					let reason = (await res.json() as any)?.promptFeedback?.blockReason;
					if (reason) {
						await ctx.reply(`无法回答, 理由 ${reason}`);
						return new Response('ok');
					}
					await ctx.reply(`发送失败`);
				}
				return new Response('ok');
			})
			.on("summary", async (bot) => {
				const groupId = bot.update.message!.chat.id;
				if (bot.update.message!.text!.split(" ").length === 1) {
					await bot.reply('请输入要查询的时间范围/消息数量, 如 /summary 114h 或 /summary 514');
					return new Response('ok');
				}
				const summary = bot.update.message!.text!.split(" ")[1];
				let results: Record<string, unknown>[];
				try {
					const test = parseInt(summary);
					if (Number.isNaN(test)) {
						throw new Error("not a number");
					}
					if (test < 0) {
						throw new Error("negative number");
					}
					if (!Number.isFinite(test)) {
						throw new Error("infinite number");
					}
				}
				catch (e: any) {
					await bot.reply('请输入要查询的时间范围/消息数量, 如 /summary 114h 或 /summary 514  ' + e.message);
					return new Response('ok');
				}
				if (summary.endsWith("h")) {
					results = (await env.DB.prepare(`
						SELECT *
						FROM Messages
						WHERE groupId=? AND timeStamp >= ?
						ORDER BY timeStamp ASC
						`)
						.bind(groupId, Date.now() - parseInt(summary) * 60 * 60 * 1000)
						.all()).results;
				}
				else {
					results = (await env.DB.prepare(`
						WITH latest_n AS (
							SELECT * FROM Messages
							WHERE groupId=?
							ORDER BY timeStamp DESC
							LIMIT ?
						)
						SELECT * FROM latest_n
						ORDER BY timeStamp ASC
						`)
						.bind(groupId, Math.min(parseInt(summary), 4000))
						.all()).results;
				}
				if (results.length > 0) {
					const model = getModelName(env);
					if (!model) {
						await bot.reply('未配置 AI_MODEL 环境变量，无法处理请求。');
						return new Response('ok');
					}
					try {
						const result = await getGenModel(env).chat.completions.create(
							{
								model,
								messages: [
									{
										"role": "system",
										content: SYSTEM_PROMPTS.summarizeChat,
									},
									{
										"role": "user",
										content: results.flatMap(
											(r: any) => [
												dispatchContent(`====================`),
												dispatchContent(`${r.userName}:`),
												dispatchContent(r.content),
												dispatchContent(getMessageLink(r)),
											]
										)
									}
								],
								...completionOptions,
							})


						const raw = result.choices[0].message.content || "";
						const formatted = formatRichTelegramMessage(
							processMarkdownLinks(raw),
							{ isSummary: true }
						);
						let res = await bot.reply(
							messageTemplate(fixLink(formatted), model),
							'MarkdownV2'
						);
						if (!res?.ok) {
							console.error("Failed to send reply", res?.statusText, await res?.text());
						}
					}
					catch (e) {
						logModelError(e, { command: 'summary', model }, [getApiKey(env), getTelegramToken(env)]);
						await bot.reply('概括失败，暂时无法完成请求，请稍后重试。');
					}
				}

				return new Response('ok');
			})
			.on(':message', async (bot) => {
				if (!bot.update.message!.chat.type.includes('group')) {
					await bot.reply('我是群聊总结机器人，请将我添加到群组中使用。\n发送 /help 可查看指令说明。');
					return new Response('ok');
				}

				switch (bot.update_type) {
					case 'message': {
						const msg = bot.update.message!;
						const groupId = msg.chat.id;
						let content = msg.text || "";
						const fwd = msg.forward_from?.last_name;
						const replyTo = msg.reply_to_message?.message_id;
						if (fwd) {
							content = `转发自 ${fwd}: ${content}`;
						}
						if (replyTo) {
							content = `回复 ${getMessageLink({ groupId: groupId.toString(), messageId: replyTo })}: ${content}`;
						}
						if (content.startsWith("http") && !content.includes(" ")) {
							content = await extractAllOGInfo(content);
						}
						const messageId = msg.message_id;
						const groupName = msg.chat.title || "anonymous";
						const timeStamp = Date.now();
						const userName = getUserName(msg);
						try {
							await env.DB.prepare(`
								INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)`)
								.bind(
									getMessageLink({ groupId: groupId.toString(), messageId }),
									groupId,
									timeStamp,
									userName, // not interested in user id
									content,
									messageId,
									groupName
								)
								.run();
						}
						catch (e) {
							console.error(e);
						}
						return new Response('ok');

					}
					case "photo": {
						const msg = bot.update.message!;
						const groupId = msg.chat.id;
						const messageId = msg.message_id;
						const groupName = msg.chat.title || "anonymous";
						const timeStamp = Date.now();
						const userName = getUserName(msg);
						const photo = msg.photo![msg.photo!.length - 1];
						const file = await bot.getFile(photo.file_id).then((response) => response.arrayBuffer());
						if (!(isJPEGBase64(Buffer.from(file).toString("base64")).isValid)) {
							console.error("not a jpeg");
							return new Response('ok');
						}
						try {
							await env.DB.prepare(`
							INSERT OR REPLACE INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)`)
								.bind(
									getMessageLink({ groupId: groupId.toString(), messageId }),
									groupId,
									timeStamp,
									userName, // not interested in user id
									"data:image/jpeg;base64," + Buffer.from(file).toString("base64"),
									messageId,
									groupName
								)
								.run();
						}
						catch (e) {
							console.error(e);
						}
						return new Response('ok');
					}
				}
				return new Response('ok');
			})
			.on(":edited_message", async (ctx) => {
				const msg = ctx.update.edited_message!;
				const groupId = msg.chat.id;
				const content = msg.text || "";
				const messageId = msg.message_id;
				const groupName = msg.chat.title || "anonymous";
				const timeStamp = Date.now();
				const userName = getUserName(msg);
				try {
					await env.DB.prepare(`
					INSERT OR REPLACE INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)`)
						.bind(
							getMessageLink({ groupId: groupId.toString(), messageId }),
							groupId,
							timeStamp,
							userName, // not interested in user id
							content,
							messageId,
							groupName
						)
						.run();
				}
				catch (e) {
					console.error(e);
				}
				return new Response('ok');
			})
			.handle(request.clone());
		return new Response('ok');
	},
};
