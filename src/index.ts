import TelegramBot from '@codebam/cf-workers-telegram-bot';
import OpenAI from "openai";
//@ts-ignore
import { Buffer } from 'node:buffer';
import { isJPEG } from './isJpeg';
import { extractAllOGInfo } from "./og";
import { logModelError } from './logModelError';
import {
	formatRichTelegramMessage,
	formatForTelegramRichMessage,
	sendTelegramRichMessage,
	deleteTelegramMessage,
	normalizeSpacing,
} from './richFormat';
import {
	initWhitelistTables,
	isSuperAdmin,
	isAdmin,
	isGroupWhitelisted,
	addGroupToWhitelist,
	removeGroupFromWhitelist,
	getWhitelistedGroups,
	addAdmin,
	removeAdmin,
	getAdmins,
} from './whitelist';
import {
	initQuotaTables,
	checkAndIncrementQuota,
	getUserQuotaStatus,
	cleanOldQuotaRecords,
} from './quota';

function dispatchContent(content: string): { type: "text", text: string } | { type: "image_url", image_url: { url: string } } {
	if (content.startsWith("data:image/jpeg;base64,")) {
		return ({
			"type": "image_url",
			"image_url": {
				"url": content
			},
		});
	}
	return ({
		"type": "text",
		"text": content,
	});
}

function getMessageLink(r: { groupId: string, messageId: number }) {
	return `https://t.me/c/${parseInt(r.groupId.slice(2))}/${r.messageId}`;
}

function escapeMarkdownV2(text: string) {
	const reservedChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
	const escapedChars = reservedChars.map(char => '\\' + char).join('');
	const regex = new RegExp(`([${escapedChars}])`, 'g');
	return text.replace(regex, '\\$1');
}

/**
 * 将数字转换为上标数字
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
 */
export function processMarkdownLinks(text: string, options: { prefix: string, useEnglish: boolean } = {
	prefix: '引用',
	useEnglish: false
}) {
	const { prefix, useEnglish } = options;
	const linkMap = new Map();
	let linkCounter = 1;
	const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;

	return text.replace(linkPattern, (match, displayText, url) => {
		if (displayText !== url) {
			return match;
		}
		if (!linkMap.has(url)) {
			linkMap.set(url, linkCounter++);
		}
		const linkNumber = linkMap.get(url);
		const linkPrefix = useEnglish ? 'link' : prefix;
		return `[${linkPrefix}${toSuperscript(linkNumber)}](${url})`;
	});
}

export const BOT_COMMANDS = [
	{ command: "summary", description: "概括群聊消息（如 /summary 20 或 /summary 12h）" },
	{ command: "ask", description: "基于群聊记录提问（私聊推送答案）" },
	{ command: "query", description: "在群聊历史中检索关键词" },
	{ command: "quota", description: "查询今日剩余指令使用配额" },
	{ command: "status", description: "检查运行状态与群组授权" },
	{ command: "help", description: "查看功能与指令使用帮助" },
	{ command: "addgroup", description: "【超管】将当前群或指定群加入白名单" },
	{ command: "delgroup", description: "【超管】将群组移出白名单" },
	{ command: "whitelist", description: "【超管】查看已授权白名单群组" },
	{ command: "addadmin", description: "【超管】添加管理员（免流特权）" },
	{ command: "deladmin", description: "【超管】移除管理员" },
	{ command: "admins", description: "【超管】查看所有管理员列表" },
	{ command: "setcommands", description: "【超管】同步更新指令菜单" },
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

/**
 * 动态获取大模型调用配置
 * 避免向非推理模型传递 reasoning_effort 导致 400 Bad Request
 */
function getCompletionOptions(model: string) {
	const isReasoning = model.startsWith("o1") || model.startsWith("o3");
	if (isReasoning) {
		return {
			max_completion_tokens: 4096,
			reasoning_effort: "none" as const,
		};
	}
	return {
		max_tokens: 4096,
	};
}

function getGenModel(env: Env) {
	const baseURL = getBaseUrl(env);
	return new OpenAI({
		apiKey: getApiKey(env),
		...(baseURL ? { baseURL } : {}),
		timeout: 60000, // 60秒合理超时保护
	});
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
   梳理本次讨论的核心议题，输出紧凑精炼的 Markdown 原生表格：
   | 议题分类 | 核心结论 / 共识 |
   |:---|:---|
   | ... | ... |
   （精炼概括 2~5 个关键议题，表格内容单行简要概括，严禁在表格内换行或填充过多字数）

3. **【💬 详细脉络与讨论溯源】（放入 <details> 标签中实现折叠）**：
   在表格之后，使用 <details> 标签将详细讨论与引用包裹起来，示例：
   <details>
   <summary>💬 点击展开详细讨论与消息溯源</summary>
   1. **议题一**：记录具体的讨论经过，必须用 Markdown 链接引用发言原消息，格式如：[引用1](链接)
   2. **议题二**：记录具体的讨论经过，引用相关言论 [引用2](链接)
   若有包含图片内容，请在相应议题中进行生动的描述。
   </details>

4. **【排版与间距严格规范】**：
   - 紧凑布局：每个大标题之间、表格与标题之间仅保留单个换行空行，严禁输出连续多个空行或大面积空白！
   - 标题命名规范：一律使用【💡 核心要点速览】、【📊 议题简表】、【💬 详细脉络与讨论溯源】，括号和内部字符之间不留多余空格。
   - 整体风格专业干练，捕捉对话真实情绪，层次分明。`,

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
	const header = modelName ? `下面由 ${escapeMarkdownV2(modelName)} 概括群聊信息\n\n` : `群聊信息概括如下：\n\n`;
	return normalizeSpacing(header + s + `\n\n本开源项目[地址](https://github\\.com/cuteys/ChatGist)`);
}

function richMessageTemplate(s: string, modelName: string) {
	const header = modelName ? `下面由 ${modelName} 概括群聊信息\n\n` : `群聊信息概括如下：\n\n`;
	return normalizeSpacing(header + s + `\n\n本开源项目 [地址](https://github.com/cuteys/ChatGist)`);
}

/**
 * 修正大模型偶尔输出的异常 Telegram 链接协议或拼写 (如 tme.cat -> t.me/c)
 */
function fixLink(text: string) {
	return text.replace(/tme\.cat/g, "t.me/c").replace(/\/c\/c/g, "/c");
}

function getUserName(msg: any): string {
	if (msg?.sender_chat?.title) {
		return msg.sender_chat.title as string;
	}
	const parts = [msg?.from?.first_name, msg?.from?.last_name].filter(Boolean);
	if (parts.length > 0) {
		return parts.join(" ");
	}
	return msg?.from?.username || "anonymous";
}

// -------------------------------------------------------------
// 管理员与白名单公共操作函数（避免指令之间重复复制代码）
// -------------------------------------------------------------

async function requireSuperAdmin(ctx: any, env: Env, userId: string): Promise<boolean> {
	if (isSuperAdmin(env, userId)) {
		return true;
	}
	const isGroup = ctx.update.message?.chat?.type?.includes('group');
	if (!isGroup) {
		await ctx.reply(`❌ 权限不足：仅系统超级管理员可执行该管理指令。\n您的 Telegram 用户 ID 为：${userId}`);
	}
	return false;
}

async function handleAddGroup(ctx: any, env: Env, userId: string, targetGroupId?: string, targetGroupName?: string) {
	const chat = ctx.update.message?.chat;
	const isGroup = chat && (chat.type === 'group' || chat.type === 'supergroup');

	let gid = targetGroupId || "";
	let gname = targetGroupName || "";

	if (!gid) {
		if (isGroup && chat) {
			gid = chat.id.toString();
			gname = chat.title || "未命名群组";
		} else {
			await ctx.reply("⚠️ 请在群内发送 /addgroup，或在私聊中指定群组 ID，例如：\n/addgroup -1001234567890 测试群");
			return;
		}
	} else if (!gname) {
		gname = (isGroup && chat && gid === chat.id.toString()) ? (chat.title || "群组") : "未命名群组";
	}

	const success = await addGroupToWhitelist(env, gid, gname, userId);
	if (success) {
		await ctx.reply(`✅ 成功将群组加入白名单！\n• 群组名称：${gname}\n• 群组 ID：${gid}\n• 操作人：${userId}\n\n机器人现已开始记录此群消息并响应群内指令。`);
	} else {
		await ctx.reply(`❌ 添加群组到白名单失败，请检查数据库配置。`);
	}
}

async function handleDelGroup(ctx: any, env: Env, targetGroupId?: string) {
	const chat = ctx.update.message?.chat;
	const isGroup = chat && (chat.type === 'group' || chat.type === 'supergroup');

	let gid = targetGroupId || "";
	if (!gid) {
		if (isGroup && chat) {
			gid = chat.id.toString();
		} else {
			await ctx.reply("⚠️ 请在群内发送 /delgroup，或在私聊中指定群组 ID，例如：\n/delgroup -1001234567890");
			return;
		}
	}

	const success = await removeGroupFromWhitelist(env, gid);
	if (success) {
		await ctx.reply(`✅ 已成功将群组 (${gid}) 移出白名单。\n机器人将不再记录该群消息并不再响应指令。`);
	} else {
		await ctx.reply(`❌ 移除群组失败，请稍后重试。`);
	}
}

async function handleListGroups(ctx: any, env: Env) {
	const groups = await getWhitelistedGroups(env);
	if (groups.length === 0) {
		await ctx.reply("📋 当前暂无白名单群组。\n超级管理员可在目标群内直接发送 /addgroup 将其加入白名单。");
		return;
	}
	let msg = `📋 白名单群组列表（共 ${groups.length} 个）：\n\n`;
	groups.forEach((g, idx) => {
		const timeStr = new Date(g.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
		msg += `${idx + 1}. 【${g.groupName}】\n   • ID: ${g.groupId}\n   • 添加人: ${g.addedBy || "未知"}\n   • 时间: ${timeStr}\n\n`;
	});
	msg += "💡 提示：在群内发送 /delgroup 可移出白名单。";
	await ctx.reply(msg);
}

async function handleAddAdmin(ctx: any, env: Env, userId: string, targetUserId?: string, targetUserName?: string) {
	if (!targetUserId) {
		await ctx.reply("⚠️ 请输入要添加的管理员 Telegram 用户 ID，例如：\n/addadmin 123456789 张三");
		return;
	}
	const name = targetUserName || "管理员";
	const success = await addAdmin(env, targetUserId, name, userId);
	if (success) {
		await ctx.reply(`✅ 成功添加数据库管理员！\n• 用户名：${name}\n• 用户 ID：${targetUserId}\n• 操作人：${userId}`);
	} else {
		await ctx.reply(`❌ 添加管理员失败，请检查数据库配置。`);
	}
}

async function handleDelAdmin(ctx: any, env: Env, targetUserId?: string) {
	if (!targetUserId) {
		await ctx.reply("⚠️ 请输入要移除的管理员 Telegram 用户 ID，例如：\n/deladmin 123456789");
		return;
	}
	const envAdminStr = env.ADMIN_USER_IDS || env.ADMIN_USER_ID || "";
	const envAdmins = envAdminStr.split(",").map((s) => s.trim()).filter(Boolean);
	if (envAdmins.includes(targetUserId)) {
		await ctx.reply(`⚠️ 用户 ${targetUserId} 是环境变量超级管理员，无法通过指令删除。如需移除请在环境变量中修改。`);
		return;
	}
	const success = await removeAdmin(env, targetUserId);
	if (success) {
		await ctx.reply(`✅ 成功移除数据库管理员：${targetUserId}`);
	} else {
		await ctx.reply(`❌ 移除管理员失败，请检查数据库。`);
	}
}

async function handleListAdmins(ctx: any, env: Env) {
	const { envAdmins, dbAdmins } = await getAdmins(env);
	let msg = `👑 管理员列表：\n\n`;

	msg += `【环境变量超级管理员】\n`;
	if (envAdmins.length === 0) {
		msg += `• 未配置 (可通过 ADMIN_USER_IDS 设置)\n`;
	} else {
		envAdmins.forEach((id) => {
			msg += `• ID: ${id}\n`;
		});
	}

	msg += `\n【数据库管理员】（共 ${dbAdmins.length} 位）\n`;
	if (dbAdmins.length === 0) {
		msg += `• 暂无动态添加的管理员（超级管理员可通过 /addadmin 添加）\n`;
	} else {
		dbAdmins.forEach((adm, idx) => {
			const timeStr = new Date(adm.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
			msg += `${idx + 1}. ${adm.userName} (ID: ${adm.userId})\n   • 添加人: ${adm.addedBy || "未知"}\n   • 时间: ${timeStr}\n`;
		});
	}

	await ctx.reply(msg);
}

export default {
	async scheduled(
		controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	) {
		console.debug("Scheduled task starting:", new Date().toISOString());
		await initWhitelistTables(env);
		await initQuotaTables(env);
		const date = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
		// Clean up oldest 3000 messages and old quota records
		if (date.getHours() === 0 && date.getMinutes() < 5) {
			await cleanOldQuotaRecords(env);
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
				m.groupId,
				COUNT(*) as message_count
			FROM Messages m
			INNER JOIN WhitelistGroups w ON m.groupId = w.groupId
			WHERE m.timeStamp >= ?1 - (24 * 3600 * 1000)
			GROUP BY m.groupId
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
						"Cache-Control": "s-maxage=10000",
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
				.all();

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
				...getCompletionOptions(model),
			});

			console.debug("send message to", group.groupId);

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
			return new Response("ChatGist Bot is running.");
		}

		// 适配 Telegram Webhook 请求
		const reqUrl = new URL(request.url);
		let botRequest = request;

		if (request.method === "POST") {
			let body: any;
			try {
				body = (await request.json()) as any;
			} catch (e) {
				return new Response("bad request", { status: 400 });
			}

			// 兼容编辑消息（将 edited_message 规整为 message，以便统一入库与处理）
			if (!body?.message && body?.edited_message) {
				body.message = body.edited_message;
			}

			// 过滤非消息类型的更新（如 my_chat_member、chat_member、message_reaction 等）
			// 立即返回 200 OK 确认接收，防止 cf-workers-telegram-bot 将未知更新回退到 :message 并因缺少 message 对象报错
			if (!body?.message) {
				return new Response("ok");
			}

			// 兼容带 @botname 的指令（如 /status@chatgist_bot 归一化为 /status）
			if (body.message?.text && body.message.text.startsWith("/")) {
				body.message.text = body.message.text.replace(/^(\/[a-zA-Z0-9_]+)@[a-zA-Z0-9_]+/, "$1");
			}

			// 群组白名单拦截门禁
			const msg = body.message;
			const chat = msg?.chat;
			const isGroup = chat && (chat.type === "group" || chat.type === "supergroup");

			if (isGroup) {
				const groupId = chat.id.toString();
				const isWhitelisted = await isGroupWhitelisted(env, groupId);
				if (!isWhitelisted) {
					const userId = msg?.from?.id?.toString() || "";
					const text = (msg?.text || "").trim();
					const cmd = text.startsWith("/")
						? text.split(/\s+/)[0].slice(1).toLowerCase()
						: "";
					const allowedAdminCommands = [
						"addgroup",
						"delgroup",
						"whitelist",
						"groups",
						"admin",
						"admins",
						"addadmin",
						"deladmin",
						"setcommands",
					];

					const senderIsSuperAdmin = isSuperAdmin(env, userId);
					if (!senderIsSuperAdmin || !allowedAdminCommands.includes(cmd)) {
						// 非白名单群组：静默忽略，不记录也不响应
						return new Response("ok");
					}
				}
			}

			reqUrl.pathname = `/${botToken}`;
			botRequest = new Request(reqUrl.toString(), {
				method: "POST",
				headers: request.headers,
				body: JSON.stringify(body),
			});
		} else {
			reqUrl.pathname = `/${botToken}`;
			botRequest = new Request(reqUrl.toString(), request);
		}

		const res = await new TelegramBot(botToken)
			.on('start', async (ctx) => {
				const userId = ctx.update.message?.from?.id?.toString() || "";
				const superAdmin = isSuperAdmin(env, userId);
				const admin = await isAdmin(env, userId);

				let startText = "";
				if (superAdmin) {
					startText = `你好！系统超级管理员 👑\n\n` +
						`您拥有本机器人的最高控制权限，不受任何使用频次限制。\n\n` +
						`【超级管理员专属指令】\n` +
						`• /addgroup - 授权当前群或指定群\n` +
						`• /delgroup - 移出白名单\n` +
						`• /whitelist - 查看白名单群组列表\n` +
						`• /addadmin <用户ID> [备注] - 添加免流管理员\n` +
						`• /deladmin <用户ID> - 移除管理员\n` +
						`• /admins - 查看管理员列表\n` +
						`• /setcommands - 向 Telegram 同步指令菜单\n\n` +
						`【常规群聊指令】\n` +
						`• /summary 20 - 概括最近 20 条消息\n` +
						`• /ask <问题> - 智能问答（私聊推送答案）\n` +
						`• /query <关键词> - 检索历史消息\n` +
						`• /quota - 查看今日剩余配额\n` +
						`• /status - 检查运行状态\n` +
						`• /help - 查看详细使用帮助`;
				} else if (admin) {
					startText = `你好！管理员 🛡️\n\n` +
						`您享有本机器人【无限次免流特权】，使用 /summary、/ask、/query 没有任何频次限制！\n\n` +
						`【群聊可用指令】\n` +
						`• /summary <数量/时间> - 概括群聊内容（无限制）\n` +
						`• /ask <问题> - 基于群聊记录智能问答（无限制）\n` +
						`• /query <关键词> - 检索群聊历史消息（无限制）\n` +
						`• /quota - 查看指令特权状态\n` +
						`• /status - 检查机器人运行状态\n` +
						`• /help - 查看详细使用帮助`;
				} else {
					startText = `你好！我是 ChatGist 群聊智能助手 💬⚡\n\n` +
						`💡 您的 Telegram 用户 ID 为：\`${userId}\`\n` +
						`（若您是机器人部署者，请在 Cloudflare Workers 环境变量 ADMIN_USER_IDS 中添加此 ID 以获取超级管理权限）\n\n` +
						`【可用指令与每日配额】\n` +
						`• /summary <数量/时间> - 概括群聊消息（每日限 5 次）\n` +
						`• /ask <问题> - 基于群聊记录智能回答（每日限 10 次）\n` +
						`• /query <关键词> - 检索群聊历史消息（每日限 20 次）\n` +
						`• /quota - 查看今日剩余使用配额\n` +
						`• /status - 检查运行状态与群组授权\n` +
						`• /help - 查看完整使用指南\n\n` +
						`提示：机器人仅在已授权群组中工作，每日配额于北京时间 00:00 自动刷新。`;
				}

				await ctx.reply(escapeMarkdownV2(startText), "MarkdownV2");
				return new Response('ok');
			})
			.on('help', async (ctx) => {
				const chat = ctx.update.message?.chat;
				const isGroup = Boolean(chat && (chat.type === 'group' || chat.type === 'supergroup' || chat.type?.includes('group')));
				const userId = ctx.update.message?.from?.id?.toString() || "";
				const superAdmin = isSuperAdmin(env, userId);
				const admin = await isAdmin(env, userId);

				let helpText = "";

				if (superAdmin) {
					helpText = `👑【超级管理员使用指南】
您拥有本机器人的最高控制权限，不受任何使用频次限制。

🛠️ 白名单与权限管理：
• /addgroup [群ID] [名称] - 将群组加入白名单（群内直接发送即可一键授权当前群）
• /delgroup [群ID] - 将群组移出白名单
• /whitelist - 查看所有已授权的白名单群组
• /addadmin <用户ID> [备注] - 添加数据库管理员（为其赋予免流特权）
• /deladmin <用户ID> - 移除管理员
• /admins - 查看所有超级管理员及数据库管理员列表
• /setcommands - 向 Telegram 同步注册所有中文指令菜单

💬 群聊常用指令：
• /summary <数量/时间> - 概括群聊消息（如 /summary 20 或 /summary 12h）
• /ask <问题> - 基于近期群聊记录提问（私聊推送答案）
• /query <关键词> - 检索群聊历史消息
• /quota - 检查今日剩余配额
• /status - 检查机器人运行状态与群组授权状态

💡 提示：在未授权群组内，机器人对普通成员完全静默，仅响应您的管理指令。`;
				} else if (admin) {
					helpText = `🛡️【管理员使用指南】
您已被系统授权为机器人管理员，享有【无限次免流特权】！

💬 群聊可用指令（无使用频次限制）：
• /summary <数量/时间>
  概括群聊消息（如 /summary 20 或 /summary 12h）
  输出富文本表格与折叠消息溯源

• /ask <问题>
  基于近期群聊记录提问，答案私聊推送给您
  示例：/ask 大家刚才在讨论什么？

• /query <关键词>
  检索群聊历史消息并提供原发言直达链接
  示例：/query 部署

• /quota
  查看指令免流特权状态

• /status
  检查机器人运行状态及当前群组授权状态

• /help
  查看本帮助指南

ℹ️ 权限说明：群组白名单与管理员权限由系统超级管理员负责统一维护。`;
				} else {
					helpText = `📖【ChatGist 群聊助手使用指南】
欢迎使用群聊智能总结与检索助手！

💬 可用群聊指令：
• /summary <数量/时间>
  概括近期群聊重点与核心议题
  示例：/summary 20（最新20条）或 /summary 12h（最近12小时）
  ⚠️ 每日限额：5 次

• /ask <问题>
  基于近期群聊记录回答您的问题（私聊推送答案，不打扰群友）
  示例：/ask 大家刚才在讨论什么？
  ⚠️ 每日限额：10 次

• /query <关键词>
  在群聊历史记录中检索关键词及原消息链接
  示例：/query 部署
  ⚠️ 每日限额：20 次

• /quota
  快速查看您今日的剩余配额

• /status
  检查机器人运行状态及群组授权

• /help
  查看本指令使用指南

ℹ️ 使用须知：
1. 您的 Telegram 用户 ID 为：${userId}
2. 机器人仅在管理员授权的白名单群组中记录与响应；
3. /ask 首次使用请先私聊机器人发起对话；
4. 每日使用额度于北京时间 00:00 自动刷新。`;
				}

				if (isGroup) {
					// 群内触发：避免群内长文本刷屏，优先尝试私聊发送详细指南
					let sentToPm = false;
					try {
						const pmRes = await ctx.api.sendMessage(ctx.bot.api.toString(), {
							chat_id: userId,
							parse_mode: "MarkdownV2",
							text: escapeMarkdownV2(helpText),
							reply_to_message_id: -1,
						});
						sentToPm = Boolean(pmRes?.ok);
					} catch (e) {
						sentToPm = false;
					}

					if (sentToPm) {
						await ctx.reply("📖 完整使用指南已私聊发送给您，请查看私聊消息（避免群内刷屏）。");
					} else {
						await ctx.reply("📖 为避免群内长消息刷屏，使用指南需在私聊中查看。\n👉 请先私聊机器人并发送 /help 获取完整说明。");
					}
					return new Response('ok');
				}

				// 私聊触发：直接发送完整使用指南
				await ctx.reply(escapeMarkdownV2(helpText), "MarkdownV2");
				return new Response('ok');
			})
			.on('setcommands', async (ctx) => {
				const userId = ctx.update.message?.from?.id?.toString() || "";
				if (!(await requireSuperAdmin(ctx, env, userId))) return new Response('ok');
				await registerBotCommands(botToken);
				await ctx.reply('✅ 已向 Telegram 同步注册指令列表！');
				return new Response('ok');
			})
			.on('status', async (ctx) => {
				const chat = ctx.update.message?.chat;
				const isGroup = chat && (chat.type === "group" || chat.type === "supergroup");
				const userId = ctx.update.message?.from?.id?.toString() || "";
				const superAdmin = isSuperAdmin(env, userId);
				const admin = await isAdmin(env, userId);

				let statusText = '🤖 机器人运行状态正常\n';
				if (superAdmin) {
					statusText += '👑 身份：系统超级管理员（无限制）\n';
				} else if (admin) {
					statusText += '🛡️ 身份：数据库管理员（无使用次数限制）\n';
				} else {
					statusText += '👤 身份：普通用户\n';
				}

				if (isGroup) {
					const whitelisted = await isGroupWhitelisted(env, chat.id.toString());
					statusText += whitelisted ? '📍 当前群组：已授权（白名单）\n' : '📍 当前群组：未授权\n';
				}

				if (!admin) {
					const quota = await getUserQuotaStatus(env, userId);
					statusText += `\n📊 今日使用配额（次日 00:00 自动刷新）：\n` +
						`• 总结 (/summary): ${quota.summary.current}/${quota.summary.limit} 次\n` +
						`• 问答 (/ask): ${quota.ask.current}/${quota.ask.limit} 次\n` +
						`• 检索 (/query): ${quota.query.current}/${quota.query.limit} 次`;
				}

				const res = (await ctx.reply(statusText))!;
				if (!res.ok) {
					console.error(`Error sending message:`, res);
				}
				return new Response('ok');
			})
			.on('quota', async (ctx) => {
				const userId = ctx.update.message?.from?.id?.toString() || "";
				const admin = await isAdmin(env, userId);
				if (admin) {
					await ctx.reply("🛡️ 您享有【无限次免流特权】，使用 /summary、/ask、/query 无任何调用频次限制。");
					return new Response('ok');
				}
				const quota = await getUserQuotaStatus(env, userId);
				const text = `📊 今日使用配额（次日 00:00 自动刷新）：\n` +
					`• 总结 (/summary): ${quota.summary.current}/${quota.summary.limit} 次\n` +
					`• 问答 (/ask): ${quota.ask.current}/${quota.ask.limit} 次\n` +
					`• 检索 (/query): ${quota.query.current}/${quota.query.limit} 次`;
				await ctx.reply(text);
				return new Response('ok');
			})
			.on('addgroup', async (ctx) => {
				const userId = ctx.update.message?.from?.id?.toString() || "";
				if (!(await requireSuperAdmin(ctx, env, userId))) return new Response('ok');
				const parts = (ctx.update.message?.text || "").trim().split(/\s+/).slice(1);
				await handleAddGroup(ctx, env, userId, parts[0], parts.slice(1).join(" "));
				return new Response('ok');
			})
			.on('delgroup', async (ctx) => {
				const userId = ctx.update.message?.from?.id?.toString() || "";
				if (!(await requireSuperAdmin(ctx, env, userId))) return new Response('ok');
				const parts = (ctx.update.message?.text || "").trim().split(/\s+/).slice(1);
				await handleDelGroup(ctx, env, parts[0]);
				return new Response('ok');
			})
			.on('whitelist', async (ctx) => {
				const userId = ctx.update.message?.from?.id?.toString() || "";
				if (!(await requireSuperAdmin(ctx, env, userId))) return new Response('ok');
				const parts = (ctx.update.message?.text || "").trim().split(/\s+/).slice(1);
				const subCmd = parts[0]?.toLowerCase();
				if (subCmd === 'add') {
					await handleAddGroup(ctx, env, userId, parts[1], parts.slice(2).join(" "));
				} else if (subCmd === 'del' || subCmd === 'remove') {
					await handleDelGroup(ctx, env, parts[1]);
				} else {
					await handleListGroups(ctx, env);
				}
				return new Response('ok');
			})
			.on('groups', async (ctx) => {
				const userId = ctx.update.message?.from?.id?.toString() || "";
				if (!(await requireSuperAdmin(ctx, env, userId))) return new Response('ok');
				await handleListGroups(ctx, env);
				return new Response('ok');
			})
			.on('addadmin', async (ctx) => {
				const userId = ctx.update.message?.from?.id?.toString() || "";
				if (!(await requireSuperAdmin(ctx, env, userId))) return new Response('ok');
				const parts = (ctx.update.message?.text || "").trim().split(/\s+/).slice(1);
				await handleAddAdmin(ctx, env, userId, parts[0], parts.slice(1).join(" "));
				return new Response('ok');
			})
			.on('deladmin', async (ctx) => {
				const userId = ctx.update.message?.from?.id?.toString() || "";
				if (!(await requireSuperAdmin(ctx, env, userId))) return new Response('ok');
				const parts = (ctx.update.message?.text || "").trim().split(/\s+/).slice(1);
				await handleDelAdmin(ctx, env, parts[0]);
				return new Response('ok');
			})
			.on('admins', async (ctx) => {
				const userId = ctx.update.message?.from?.id?.toString() || "";
				if (!(await requireSuperAdmin(ctx, env, userId))) return new Response('ok');
				await handleListAdmins(ctx, env);
				return new Response('ok');
			})
			.on('admin', async (ctx) => {
				const userId = ctx.update.message?.from?.id?.toString() || "";
				if (!(await requireSuperAdmin(ctx, env, userId))) return new Response('ok');
				const parts = (ctx.update.message?.text || "").trim().split(/\s+/).slice(1);
				const subCmd = parts[0]?.toLowerCase();
				if (subCmd === 'add') {
					await handleAddAdmin(ctx, env, userId, parts[1], parts.slice(2).join(" "));
				} else if (subCmd === 'del' || subCmd === 'remove') {
					await handleDelAdmin(ctx, env, parts[1]);
				} else {
					await handleListAdmins(ctx, env);
				}
				return new Response('ok');
			})
			.on("query", async (ctx) => {
				const msg = ctx.update?.message;
				if (!msg || !msg.chat) return new Response('ok');
				const groupId = msg.chat.id.toString();
				const userId = msg.from?.id?.toString() || "";
				const quota = await checkAndIncrementQuota(env, userId, 'query');
				if (!quota.allowed) {
					await ctx.reply(`⚠️ 您今日的 /query 检索次数已达上限（${quota.current}/${quota.limit} 次）。配额将在次日 00:00 自动刷新。`);
					return new Response('ok');
				}
				const messageText = msg.text || "";
				const keyword = messageText.split(/\s+/).slice(1).join(" ").trim();
				if (!keyword) {
					await ctx.reply('⚠️ 请输入要查询的关键词，例如：/query 部署');
					return new Response('ok');
				}

				// 立即反馈状态提示
				let statusMessageId: number | undefined;
				try {
					const initRes = await ctx.reply(`🔍 正在检索关键词【${keyword}】，请稍候...`);
					if (initRes?.ok) {
						const initData: any = await initRes.json();
						statusMessageId = initData?.result?.message_id;
					}
				} catch (e) {
					console.error("Failed to send query status", e);
				}

				const { results } = await env.DB.prepare(`
					SELECT * FROM Messages
					WHERE groupId = ? AND content NOT LIKE 'data:image%' AND content GLOB ?
					ORDER BY timeStamp DESC
					LIMIT 50`)
					.bind(groupId, `*${keyword}*`)
					.all();

				if (statusMessageId) {
					await deleteTelegramMessage(getTelegramToken(env), groupId, statusMessageId);
				}

				if (!results || results.length === 0) {
					await ctx.reply(`🔍 未找到包含关键词【${keyword}】的相关历史消息。`);
					return new Response('ok');
				}

				const MAX_DISPLAY = 15;
				const displayList = results.slice(0, MAX_DISPLAY);
				let outputLines = [`🔍 关键词【${keyword}】检索结果（共找到 ${results.length} 条）：\n`];
				for (const r of displayList as any[]) {
					const contentPreview = r.content.length > 80 ? r.content.slice(0, 80) + '...' : r.content;
					const link = r.messageId ? ` [链接](https://t.me/c/${parseInt(r.groupId.slice(2))}/${r.messageId})` : '';
					outputLines.push(`• ${r.userName}：${contentPreview}${link}`);
				}
				if (results.length > MAX_DISPLAY) {
					outputLines.push(`\nℹ️ 结果较多，仅展示最近 ${MAX_DISPLAY} 条记录。`);
				}

				const responseText = normalizeSpacing(outputLines.join('\n'));
				const res = await ctx.reply(escapeMarkdownV2(responseText), "MarkdownV2");
				if (!res?.ok) {
					console.error(`Error sending message:`, res?.status, res?.statusText, await res?.text());
				}
				return new Response('ok');
			})
			.on("ask", async (ctx) => {
				const model = getModelName(env);
				if (!model) {
					await ctx.reply('未配置 AI_MODEL 环境变量，无法处理请求。');
					return new Response('ok');
				}
				const msg = ctx.update?.message;
				if (!msg || !msg.chat) return new Response('ok');
				const groupId = msg.chat.id.toString();
				const userId = msg.from?.id?.toString() || "";
				const quota = await checkAndIncrementQuota(env, userId, 'ask');
				if (!quota.allowed) {
					await ctx.reply(`⚠️ 您今日的 /ask 提问次数已达上限（${quota.current}/${quota.limit} 次）。配额将在次日 00:00 自动刷新。`);
					return new Response('ok');
				}
				const messageText = ctx.update.message!.text || "";
				const question = getCommandVar(messageText, " ").trim();
				if (!question) {
					await ctx.reply('⚠️ 请输入要问的问题，例如：/ask 大家刚才在讨论什么？');
					return new Response('ok');
				}

				// 群内发指令时，在群内回复即时反馈
				const isGroup = msg.chat.type?.includes('group');
				let groupAckMessageId: number | undefined;
				if (isGroup) {
					try {
						const ackRes = await ctx.reply("⏳ 收到提问，正在分析近期群聊并在私聊中为您推送解答...");
						if (ackRes?.ok) {
							const ackData: any = await ackRes.json();
							groupAckMessageId = ackData?.result?.message_id;
						}
					} catch (e) {
						console.error("Failed to send ack in group", e);
					}
				}

				let res = await ctx.api.sendMessage(ctx.bot.api.toString(), {
					"chat_id": userId,
					"parse_mode": "MarkdownV2",
					"text": "bot 已经收到你的问题, 请稍等",
					reply_to_message_id: -1,
				});
				if (!res.ok) {
					if (groupAckMessageId) {
						await deleteTelegramMessage(getTelegramToken(env), groupId, groupAckMessageId);
					}
					await ctx.reply(`请先在私聊中向机器人发送 /start 发起对话，否则无法私信推送答案。`);
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
									content: `问题：${question}`
								}
							],
							...getCompletionOptions(model),
						});
				} catch (e) {
					if (groupAckMessageId) {
						await deleteTelegramMessage(getTelegramToken(env), groupId, groupAckMessageId);
					}
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
						if (groupAckMessageId) {
							await deleteTelegramMessage(getTelegramToken(env), groupId, groupAckMessageId);
						}
						return new Response('ok');
					}
					await ctx.reply(`发送失败`);
				}
				if (groupAckMessageId) {
					await deleteTelegramMessage(getTelegramToken(env), groupId, groupAckMessageId);
				}
				return new Response('ok');
			})
			.on("summary", async (bot) => {
				const msg = bot.update?.message;
				if (!msg || !msg.chat) return new Response('ok');
				const groupId = msg.chat.id.toString();
				const userId = msg.from?.id?.toString() || "";
				const quota = await checkAndIncrementQuota(env, userId, 'summary');
				if (!quota.allowed) {
					await bot.reply(`⚠️ 您今日的 /summary 总结次数已达上限（${quota.current}/${quota.limit} 次）。配额将在次日 00:00 自动刷新。`);
					return new Response('ok');
				}

				const parts = (msg.text || "").trim().split(/\s+/);
				let summary = parts[1];
				let isDefault = false;
				if (!summary) {
					summary = "50"; // 默认总结最近 50 条消息
					isDefault = true;
				}

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
					await bot.reply('⚠️ 请输入有效的时间范围或消息数量，例如：\n• /summary 20（最近 20 条）\n• /summary 12h（最近 12 小时）');
					return new Response('ok');
				}

				// 立即反馈执行状态，避免用户等待时产生无响应的错觉
				let statusMessageId: number | undefined;
				try {
					const initRes = await bot.reply("⏳ 正在读取群聊记录并生成总结，请稍候...");
					if (initRes?.ok) {
						const initData: any = await initRes.json();
						statusMessageId = initData?.result?.message_id;
					}
				} catch (e) {
					console.error("Failed to send initial status message:", e);
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

				if (!results || results.length === 0) {
					if (statusMessageId) {
						await deleteTelegramMessage(getTelegramToken(env), groupId, statusMessageId);
					}
					await bot.reply('📋 在指定范围暂无群聊消息记录，无需总结。');
					return new Response('ok');
				}

				const model = getModelName(env);
				if (!model) {
					if (statusMessageId) {
						await deleteTelegramMessage(getTelegramToken(env), groupId, statusMessageId);
					}
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
							...getCompletionOptions(model),
						});

					const raw = result.choices[0].message.content || "";
					const processedMarkdown = processMarkdownLinks(raw);

					// 1. 优先尝试 Telegram Bot API 原生富文本发送 (支持 Native Tables 原生富文本表格)
					const richContent = richMessageTemplate(
						fixLink(formatForTelegramRichMessage(processedMarkdown)),
						model
					);
					const finalRichContent = isDefault
						? `💡（未指定参数，默认总结近期 50 条消息）\n\n` + richContent
						: richContent;

					const richRes = await sendTelegramRichMessage(
						getTelegramToken(env),
						groupId,
						finalRichContent,
						msg.message_id
					);

					if (richRes.ok) {
						if (statusMessageId) {
							await deleteTelegramMessage(getTelegramToken(env), groupId, statusMessageId);
						}
					} else {
						console.error("sendRichMessage failed, fallback to standard reply:", richRes.description);
						// 2. 降级回退：使用 standard sendMessage
						const formatted = formatRichTelegramMessage(
							processedMarkdown,
							{ isSummary: true }
						);
						let replyContent = messageTemplate(fixLink(formatted), model);
						if (isDefault) {
							replyContent = `💡（未指定参数，默认总结近期 50 条消息）\n\n` + replyContent;
						}
						let res = await bot.reply(
							replyContent,
							'MarkdownV2'
						);
						if (!res?.ok) {
							console.error("Failed to send reply with MarkdownV2, falling back to plain text:", res?.statusText, await res?.text());
							const plainText = replyContent.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');
							await bot.reply(plainText);
						}
						if (statusMessageId) {
							await deleteTelegramMessage(getTelegramToken(env), groupId, statusMessageId);
						}
					}
				}
				catch (e) {
					if (statusMessageId) {
						await deleteTelegramMessage(getTelegramToken(env), groupId, statusMessageId);
					}
					logModelError(e, { command: 'summary', model }, [getApiKey(env), getTelegramToken(env)]);
					await bot.reply('概括失败，暂时无法完成请求，请稍后重试。');
				}

				return new Response('ok');
			})
			.on(':message', async (bot) => {
				const msg = bot.update?.message;
				if (!msg || !msg.chat) {
					return new Response('ok');
				}
				if (!msg.chat.type || !msg.chat.type.includes('group')) {
					await bot.reply('我是群聊总结机器人，请将我添加到群组中使用。\n发送 /help 可查看指令说明。');
					return new Response('ok');
				}

				switch (bot.update_type) {
					case 'message': {
						const groupId = msg.chat.id.toString();
						if (!(await isGroupWhitelisted(env, groupId))) {
							return new Response('ok');
						}
						let content = msg.text || "";
						const fwd = msg.forward_from?.last_name;
						const replyTo = msg.reply_to_message?.message_id;
						if (fwd) {
							content = `转发自 ${fwd}: ${content}`;
						}
						if (replyTo) {
							content = `回复 ${getMessageLink({ groupId, messageId: replyTo })}: ${content}`;
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
								INSERT OR REPLACE INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)`)
								.bind(
									getMessageLink({ groupId, messageId }),
									groupId,
									timeStamp,
									userName,
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
						const groupId = msg.chat.id.toString();
						if (!(await isGroupWhitelisted(env, groupId))) {
							return new Response('ok');
						}
						const messageId = msg.message_id;
						const groupName = msg.chat.title || "anonymous";
						const timeStamp = Date.now();
						const userName = getUserName(msg);

						// 智能降级与压缩机制：
						// Telegram 会自动生成多档清晰度规格 (从缩略图到高分原图)
						// 倒序优先选择体积 <= 950KB 的最清晰尺寸，若全部超出则逐级回退，彻底解决大于 1MB 图片无法识别的问题
						const candidatePhotos = [...(msg.photo || [])].reverse();
						let file: ArrayBuffer | null = null;

						for (const p of candidatePhotos) {
							// 若 Telegram 明确标注了文件大小且超过 950KB，跳过该超大档位
							if (p.file_size && p.file_size > 950 * 1024) {
								continue;
							}
							try {
								const buf = await bot.getFile(p.file_id).then((response) => response.arrayBuffer());
								if (buf.byteLength <= 1024 * 1024) {
									file = buf;
									break;
								}
							} catch (err) {
								console.error("Error downloading photo tier:", err);
							}
						}

						// 极端保底：若候选全超出，则下载 Telegram 最小缩略图 (通常 < 50KB)
						if (!file && msg.photo && msg.photo.length > 0) {
							try {
								file = await bot.getFile(msg.photo[0].file_id).then((response) => response.arrayBuffer());
							} catch (err) {
								console.error("Error downloading fallback thumbnail:", err);
							}
						}

						if (!file || !isJPEG(file)) {
							console.error("not a valid jpeg or failed to download photo");
							return new Response('ok');
						}

						const content = "data:image/jpeg;base64," + Buffer.from(file).toString("base64");
						try {
							await env.DB.prepare(`
							INSERT OR REPLACE INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)`)
								.bind(
									getMessageLink({ groupId, messageId }),
									groupId,
									timeStamp,
									userName,
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
					default:
						return new Response('ok');
				}
			})
			.on(":edited_message", async (ctx) => {
				const msg = ctx.update?.edited_message || ctx.update?.message;
				if (!msg || !msg.chat) {
					return new Response('ok');
				}
				const groupId = msg.chat.id.toString();
				if (!(await isGroupWhitelisted(env, groupId))) {
					return new Response('ok');
				}
				const content = msg.text || "";
				const messageId = msg.message_id;
				const groupName = msg.chat.title || "anonymous";
				const timeStamp = Date.now();
				const userName = getUserName(msg);
				try {
					await env.DB.prepare(`
					INSERT OR REPLACE INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)`)
						.bind(
							getMessageLink({ groupId, messageId }),
							groupId,
							timeStamp,
							userName,
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
			.handle(botRequest);
		return res || new Response('ok');
	},
};
