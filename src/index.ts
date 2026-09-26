import TelegramBot from '@codebam/cf-workers-telegram-bot';
import OpenAI from "openai";
import { Buffer } from 'node:buffer';
import { isJPEG, detectImageMimeType } from './isJpeg';
import { extractAllOGInfo } from "./og";
import { logModelError } from './logModelError';
import {
	foldText,
	formatSummaryWithHighlights,
	formatAnswerMessage,
	deleteTelegramMessage,
	normalizeSpacing,
	toSuperscript,
	processMarkdownLinks,
	fixLink,
	stripMarkdownV2Escapes,
	splitTelegramMessage,
	removeThematicBreaks,
	sendTelegramRichMessage,
	markdownToRichBlocks,
	buildWhitelistRichBlocks,
	buildAdminsRichBlocks,
	buildQueryRichBlocks,
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
	clearGroupMessages,
} from './whitelist';
import {
	initQuotaTables,
	checkAndIncrementQuota,
	getUserQuotaStatus,
	cleanOldQuotaRecords,
} from './quota';

export {
	toSuperscript,
	processMarkdownLinks,
	fixLink,
	foldText,
	formatSummaryWithHighlights,
	stripMarkdownV2Escapes,
	splitTelegramMessage,
	removeThematicBreaks,
	sendTelegramRichMessage,
	markdownToRichBlocks,
	buildWhitelistRichBlocks,
	buildAdminsRichBlocks,
	buildQueryRichBlocks,
};

function dispatchContent(content: string): { type: "text", text: string } | { type: "image_url", image_url: { url: string } } {
	if (content.startsWith("data:image/")) {
		return {
			type: "image_url",
			image_url: {
				url: content,
			},
		};
	}
	return {
		type: "text",
		text: content,
	};
}

function getMessageLink(r: { groupId: string; messageId: number }) {
	const cleanGroupId = r.groupId.replace(/^-100/, '').replace(/^-/, '');
	return `https://t.me/c/${cleanGroupId}/${r.messageId}`;
}

function escapeMarkdownV2(text: string) {
	const reservedChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
	const escapedChars = reservedChars.map(char => '\\' + char).join('');
	const regex = new RegExp(`([${escapedChars}])`, 'g');
	return text.replace(regex, '\\$1');
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
	{ command: "clearmessages", description: "【超管】清空指定群组的历史消息记录" },
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
	return env.TELEGRAM_BOT_TOKEN || "";
}

function getApiKey(env: Env): string {
	return env.AI_API_KEY || env.OPENAI_API_KEY || env.GEMINI_API_KEY || "";
}

function getBaseUrl(env: Env): string | undefined {
	return env.AI_BASE_URL || env.BASE_URL || undefined;
}

function getCompletionOptions(model: string) {
	const isReasoning = model.startsWith("o1") || model.startsWith("o3");
	if (isReasoning) {
		return {
			max_completion_tokens: 4096,
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
		timeout: 60000,
	});
}

const SYSTEM_PROMPTS = {
	summarizeChat: `你是一个专业的群聊概括与深度总结助手。你的任务是用符合群聊风格的生动语气，对对话内容进行结构化深度概括。
对话将按以下格式提供：
====================
用户名:
发言内容
相应链接
====================

请严格遵循以下现代原生富文本排版标准输出：
1. 整体结构规范：
   - 【顶部背景引用】：在开头使用引用块（>）说明本次总结的范围或主题（如：> 总结群聊近期共 X 条发言记录）。
   - 【总标题与全局概览】：使用 1 级标题（#）给出精炼有深度的总标题，并在其后附上一段 100~200 字的核心梗概，概括本期群聊最关键的讨论方向。
   - 【原生手风琴抽屉（<details>）】：遇到各分门别类的详细议题、事件、技术探讨或八卦杂谈时，必须使用 HTML 原生折叠标签：
     <details>
     <summary>分类议题标题（简明扼要）</summary>
     这里写具体的讨论经过与深入说明...
     </details>
   - 【原消息链接溯源（极其重要）】：在概括每个具体观点、事实、发言、故障或结论时，必须在对应位置附上原消息溯源链接，格式为 [引用¹](原对话链接) 或 [💬 原文](原对话链接)。点击该链接能够直接跳转定位到群聊发言。链接必须完全来源于输入中提供的真实“相应链接”，严禁杜撰。
   - 【原生斑马纹表格】：凡是遇到多方观点对比、服务计费规则、参数方案对比、优劣势分析时，必须输出规范的 GFM Markdown 管道表格（如 | 机制类型 | 扣费规则 | 注意事项与特性 | 原文 |）。
   - 【待办事项与操作清单】：凡是总结中提到故障排查建议、待办操作、优化事项时，必须在专门的 <details><summary>待办事项与操作清单</summary> 抽屉内使用任务列表语法输出（- [ ] 待办项 1）。
   - 【结尾统计】：最后用 --- 水平分割线收尾，并用 6 级标题输出精简的模型与统计说明（如 ###### gemini-3.8-flash）。

2. 紧凑排版，文字生动清晰，重点明确。`,

	answerQuestion: `你是一个群聊智能问答助手。你的任务是基于提供的群聊记录精准回答用户的问题。
群聊记录将按以下格式提供：
====================
用户名:
发言内容
相应链接
====================

请遵循以下现代排版规范：
1. 【顶部提问提示】：开头使用引用块（>）明确列出用户的问题；
2. 【结论先行】：直截了当回答核心结论与答案；
3. 【原消息溯源（极其重要）】：在回答中引用相关的原始发言作为依据，格式为 [引用¹](原对话链接) 或 [发言人](原对话链接)，方便用户点击直接在群聊中定位原始消息；
4. 【结构化展示】：遇到多方案/多选项对比时，使用表格（| 列1 | 列2 |）；遇到排查步骤或操作项时，使用任务列表（- [ ] 操作项）；遇到长篇细节时，可使用 <details><summary>详细排查步骤</summary>...</details> 折叠呈现；
5. 如果找不到相关信息，请诚实说明，切勿编造。`
};

function getSystemPrompt(env: Env, type: 'summary' | 'ask'): string {
	if (type === 'summary') {
		return env.SYSTEM_PROMPT_SUMMARY?.trim() || SYSTEM_PROMPTS.summarizeChat;
	}
	return env.SYSTEM_PROMPT_ASK?.trim() || SYSTEM_PROMPTS.answerQuestion;
}

function getCommandVar(str: string, delim: string) {
	return str.slice(str.indexOf(delim) + delim.length);
}

function messageTemplate(s: string, modelName: string) {
	const header = modelName ? `下面由 ${escapeMarkdownV2(modelName)} 概括群聊信息\n\n` : `群聊信息概括如下：\n\n`;
	return normalizeSpacing(header + s + `\n\n本开源项目[地址](https://github\\.com/cuteys/ChatGist)`);
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

function formatChatHistoryForAi(results: any[]) {
	return results.flatMap((r: any) => [
		dispatchContent(`====================`),
		dispatchContent(`${r.userName}:`),
		dispatchContent(r.content),
		dispatchContent(getMessageLink(r)),
	]);
}

async function saveMessage(env: Env, params: {
	groupId: string;
	messageId: number;
	userName: string;
	content: string;
	groupName: string;
}) {
	try {
		await env.DB.prepare(
			`INSERT OR REPLACE INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
			.bind(
				getMessageLink({ groupId: params.groupId, messageId: params.messageId }),
				params.groupId,
				Date.now(),
				params.userName,
				params.content,
				params.messageId,
				params.groupName
			)
			.run();
	} catch (e) {
		console.error("Failed to save message:", e);
	}
}

async function withAdminAuth(
	ctx: any,
	env: Env,
	action: (userId: string, parts: string[]) => Promise<void>
): Promise<Response> {
	const userId = ctx.update.message?.from?.id?.toString() || "";
	if (!(await requireSuperAdmin(ctx, env, userId))) return new Response('ok');
	const parts = (ctx.update.message?.text || "").trim().split(/\s+/).slice(1);
	await action(userId, parts);
	return new Response('ok');
}

function getRoleHelpText(env: Env, userId: string, superAdmin: boolean, admin: boolean): string {
	if (superAdmin) {
		return `👑【超级管理员使用指南】
您拥有本机器人的最高控制权限，不受任何使用频次限制。

🛠️ 白名单与权限管理：
• /addgroup [群ID] [名称] - 授权群组（群内发送可一键授权当前群）
• /delgroup [群ID] - 移出白名单
• /whitelist - 查看白名单群组列表
• /addadmin <用户ID> [备注] - 添加免流管理员
• /deladmin <用户ID> - 移除管理员
• /admins - 查看管理员列表
• /clearmessages [群ID] - 清空指定群组的历史消息记录
• /setcommands - 向 Telegram 同步指令菜单

💬 群聊常用指令：
• /summary <数量/时间> - 概括群聊消息（如 /summary 20 或 /summary 12h）
• /ask <问题> - 基于群聊记录提问（私聊推送答案）
• /query <关键词> - 检索历史消息
• /quota - 查看今日剩余配额
• /status - 检查运行状态与群组授权`;
	}

	if (admin) {
		return `🛡️【管理员使用指南】
您已被系统授权为机器人管理员，享有【无限次免流特权】！

💬 群聊可用指令（无使用频次限制）：
• /summary <数量/时间> - 概括群聊消息（如 /summary 20 或 /summary 12h）
• /ask <问题> - 基于群聊记录提问（私聊推送答案）
• /query <关键词> - 检索群聊历史消息
• /quota - 查看指令免流特权状态
• /status - 检查运行状态与群组授权
• /help - 查看本使用帮助`;
	}

	return `📖【ChatGist 群聊助手使用指南】
欢迎使用群聊智能总结与检索助手！

💬 可用群聊指令：
• /summary <数量/时间> - 概括近期群聊重点（每日限 5 次）
• /ask <问题> - 基于近期群聊记录回答（每日限 10 次，私聊推送）
• /query <关键词> - 检索群聊历史消息（每日限 20 次）
• /quota - 快速查看今日剩余配额
• /status - 检查机器人运行状态及群组授权
• /help - 查看本指令使用指南

ℹ️ 使用须知：
1. 您的 Telegram 用户 ID 为：\`${userId}\`
2. 机器人仅在管理员授权的白名单群组中记录与响应；
3. /ask 首次使用请先私聊机器人发起对话；
4. 每日使用额度于北京时间 00:00 自动刷新。`;
}

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
	const token = getTelegramToken(env);
	const chatId = ctx.update?.message?.chat?.id?.toString() || "";
	if (token && chatId) {
		const blocks = buildWhitelistRichBlocks(groups);
		const sendRes = await sendTelegramRichMessage(token, chatId, blocks);
		if (sendRes.ok) return;
	}

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
	const token = getTelegramToken(env);
	const chatId = ctx.update?.message?.chat?.id?.toString() || "";
	if (token && chatId) {
		const blocks = buildAdminsRichBlocks(envAdmins, dbAdmins);
		const sendRes = await sendTelegramRichMessage(token, chatId, blocks);
		if (sendRes.ok) return;
	}

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

		// 1. 定期清理：清理 3 天前的配额记录，保留各群最新 3000 条消息，以及清理 24 小时前的旧图片
		try {
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
				);
			`).run();

			await env.DB.prepare(`
				DELETE FROM Messages
				WHERE timeStamp < ? AND content LIKE 'data:image/%'
			`).bind(Date.now() - 24 * 60 * 60 * 1000).run();
		} catch (e) {
			console.error("Scheduled cleanup failed:", e);
		}

		const model = getModelName(env);
		if (!model) {
			console.error("AI_MODEL is not configured, skipping scheduled summary.");
			return;
		}

		// 2. 查找过去 24 小时活跃的白名单群组（发言超过 10 条）
		let groups: Array<{ groupId: string; message_count: number }> = [];
		try {
			const res = await env.DB.prepare(`
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
			`).bind(Date.now()).all<{ groupId: string; message_count: number }>();
			groups = res?.results || [];
		} catch (e) {
			console.error("Failed to query active groups:", e);
			return;
		}

		console.debug(`Scheduled summary: found ${groups.length} active groups.`);

		// 3. 逐个群组生成并推送总结，单群异常不影响其它群
		for (const group of groups) {
			try {
				const { results } = await env.DB.prepare(
					'SELECT * FROM Messages WHERE groupId=? AND timeStamp >= ? ORDER BY timeStamp ASC'
				)
					.bind(group.groupId, Date.now() - 24 * 60 * 60 * 1000)
					.all();

				if (!results || results.length === 0) continue;

				const result = await getGenModel(env).chat.completions.create({
					model,
					messages: [
						{
							role: "system",
							content: getSystemPrompt(env, 'summary'),
						},
						{
							role: "user",
							content: formatChatHistoryForAi(results),
						},
					],
					...getCompletionOptions(model),
				});

				const raw = result.choices[0].message.content || "";
				const processed = fixLink(processMarkdownLinks(raw));
				const blocks = markdownToRichBlocks(processed);
				blocks.push(
					{ type: "divider" },
					{
						type: "heading",
						size: 6,
						text: [
							{ type: "code", text: model },
							" · ChatGist 定时群聊深度概括"
						]
					}
				);

				const formatted = formatSummaryWithHighlights(raw);
				const fullText = messageTemplate(formatted, model);

				await sendTelegramRichMessage(getTelegramToken(env), group.groupId, blocks, {
					fallbackMarkdownV2: fullText,
				});
			} catch (err) {
				console.error(`Error processing scheduled summary for group ${group.groupId}:`, err);
			}
		}
		console.debug("Scheduled cron completed.");
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

		// 安全校验：若配置了 SECRET_TELEGRAM_API_TOKEN，校验 Telegram Webhook 请求头
		const secretToken = env.SECRET_TELEGRAM_API_TOKEN;
		if (secretToken) {
			const headerToken = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
			if (headerToken !== secretToken) {
				return new Response("Unauthorized", { status: 403 });
			}
		}

		const reqUrl = new URL(request.url);
		let botRequest = request;

		if (request.method === "POST") {
			let body: any;
			try {
				body = (await request.json()) as any;
			} catch (e) {
				return new Response("bad request", { status: 400 });
			}

			if (!body?.message && body?.edited_message) {
				body.message = body.edited_message;
			}

			if (!body?.message) {
				return new Response("ok");
			}

			if (body.message?.text && body.message.text.startsWith("/")) {
				body.message.text = body.message.text.replace(/^(\/[a-zA-Z0-9_]+)@[a-zA-Z0-9_]+/, "$1");
			}

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
						"clearmessages",
						"setcommands",
					];

					const senderIsSuperAdmin = isSuperAdmin(env, userId);
					if (!senderIsSuperAdmin || !allowedAdminCommands.includes(cmd)) {
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
				const chat = ctx.update.message?.chat;
				const isGroup = Boolean(chat && (chat.type === 'group' || chat.type === 'supergroup' || chat.type?.includes('group')));
				if (isGroup) {
					const groupStartText = escapeMarkdownV2(
						`👋 你好！我是 ChatGist 群聊智能总结助手。\n\n` +
						`我会在后台静默记录本群对话并为您提供服务：\n` +
						`• /summary - 智能提取群聊重点与讨论脉络\n` +
						`• /ask - 针对近期群聊提问（私聊推送答案）\n` +
						`• /query - 检索群聊历史记录\n` +
						`• /help - 查看完整指令指南`
					);
					await ctx.reply(groupStartText, "MarkdownV2");
					return new Response('ok');
				}

				const privateStartText = escapeMarkdownV2(
					`👋 你好！欢迎使用 ChatGist 群聊智能助手！\n\n` +
					`我是专为 Telegram 群组设计的 AI 总结与智能问答助手：\n` +
					`• 💡 智能概括：提炼群聊核心要点，长篇脉络一键折叠展开\n` +
					`• 💬 智能问答：基于群聊记录精准回答，支持原消息直达溯源\n` +
					`• 🛡️ 白名单机制：仅在授权群组中记录与服务，保护群隐私\n\n` +
					`🚀 快速上手：\n` +
					`1. 将机器人添加到您的 Telegram 群组中\n` +
					`2. 授予机器人读取群消息权限（设为管理员）\n` +
					`3. 超级管理员在群内发送 /addgroup 授权当前群组\n` +
					`4. 在群内发送 /summary 或 /ask 即可开始体验！\n\n` +
					`📖 随时发送 /help 可查看完整指令指南与管理说明。`
				);
				await ctx.reply(privateStartText, "MarkdownV2");
				return new Response('ok');
			})
			.on('help', async (ctx) => {
				const chat = ctx.update.message?.chat;
				const isGroup = Boolean(chat && (chat.type === 'group' || chat.type === 'supergroup' || chat.type?.includes('group')));
				const userId = ctx.update.message?.from?.id?.toString() || "";
				const superAdmin = isSuperAdmin(env, userId);
				const admin = await isAdmin(env, userId);
				const helpText = getRoleHelpText(env, userId, superAdmin, admin);

				if (isGroup) {
					let sentToPm = false;
					try {
						const pmRes = await ctx.api.sendMessage(ctx.bot.api.toString(), {
							chat_id: userId,
							parse_mode: "MarkdownV2",
							text: escapeMarkdownV2(helpText),
						} as any);
						sentToPm = Boolean(pmRes?.ok);
					} catch (e) {
						sentToPm = false;
					}

					if (sentToPm) {
						await ctx.reply("📖 完整使用指南已私聊发送给您，请查看私聊消息（避免群内刷屏）。");
					} else {
						await ctx.reply("📖 为避免群内长消息刷屏，使用指南需在私聊中查看。\n👉 请先私聊机器人发送 /start，然后发送 /help 获取完整说明。");
					}
					return new Response('ok');
				}

				await ctx.reply(escapeMarkdownV2(helpText), "MarkdownV2");
				return new Response('ok');
			})
			.on('setcommands', (ctx) => withAdminAuth(ctx, env, async () => {
				await registerBotCommands(botToken);
				await ctx.reply('✅ 已向 Telegram 同步注册指令列表！');
			}))
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
			.on('addgroup', (ctx) => withAdminAuth(ctx, env, (uid, parts) => handleAddGroup(ctx, env, uid, parts[0], parts.slice(1).join(" "))))
			.on('delgroup', (ctx) => withAdminAuth(ctx, env, (_uid, parts) => handleDelGroup(ctx, env, parts[0])))
			.on('whitelist', (ctx) => withAdminAuth(ctx, env, async (uid, parts) => {
				const subCmd = parts[0]?.toLowerCase();
				if (subCmd === 'add') await handleAddGroup(ctx, env, uid, parts[1], parts.slice(2).join(" "));
				else if (subCmd === 'del' || subCmd === 'remove') await handleDelGroup(ctx, env, parts[1]);
				else await handleListGroups(ctx, env);
			}))
			.on('groups', (ctx) => withAdminAuth(ctx, env, () => handleListGroups(ctx, env)))
			.on('addadmin', (ctx) => withAdminAuth(ctx, env, (uid, parts) => handleAddAdmin(ctx, env, uid, parts[0], parts.slice(1).join(" "))))
			.on('deladmin', (ctx) => withAdminAuth(ctx, env, (_uid, parts) => handleDelAdmin(ctx, env, parts[0])))
			.on('admins', (ctx) => withAdminAuth(ctx, env, () => handleListAdmins(ctx, env)))
			.on('admin', (ctx) => withAdminAuth(ctx, env, async (uid, parts) => {
				const subCmd = parts[0]?.toLowerCase();
				if (subCmd === 'add') await handleAddAdmin(ctx, env, uid, parts[1], parts.slice(2).join(" "));
				else if (subCmd === 'del' || subCmd === 'remove') await handleDelAdmin(ctx, env, parts[1]);
				else await handleListAdmins(ctx, env);
			}))
			.on('clearmessages', (ctx) => withAdminAuth(ctx, env, async (uid, parts) => {
				const chat = ctx.update.message?.chat;
				const isGroup = chat && (chat.type === 'group' || chat.type === 'supergroup');
				let targetGid = parts[0] || (isGroup ? chat.id.toString() : "");
				if (!targetGid) {
					await ctx.reply("⚠️ 请在群内发送 /clearmessages，或指定群组 ID，例如：\n/clearmessages -1001234567890");
					return;
				}
				const count = await clearGroupMessages(env, targetGid);
				await ctx.reply(`🧹 已成功清除群组 (${targetGid}) 的历史消息记录（共清理 ${count} 条）。`);
			}))
			.on("query", async (ctx) => {
				const msg = ctx.update?.message;
				if (!msg || !msg.chat) return new Response('ok');
				const groupId = msg.chat.id.toString();
				const userId = msg.from?.id?.toString() || "";

				const messageText = msg.text || "";
				const keyword = messageText.split(/\s+/).slice(1).join(" ").trim();
				if (!keyword) {
					await ctx.reply('⚠️ 请输入要查询的关键词，例如：/query 部署');
					return new Response('ok');
				}

				const quota = await checkAndIncrementQuota(env, userId, 'query');
				if (!quota.allowed) {
					await ctx.reply(`⚠️ 您今日的 /query 检索次数已达上限（${quota.current}/${quota.limit} 次）。配额将在次日 00:00 自动刷新。`);
					return new Response('ok');
				}

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

				try {
					const { results } = await env.DB.prepare(`
						SELECT * FROM Messages
						WHERE groupId = ? AND content NOT LIKE 'data:image%' AND content GLOB ?
						ORDER BY timeStamp DESC
						LIMIT 50`)
						.bind(groupId, `*${keyword}*`)
						.all();

					if (!results || results.length === 0) {
						await ctx.reply(`🔍 未找到包含关键词【${keyword}】的相关历史消息。`);
						return new Response('ok');
					}

					const token = getTelegramToken(env);
					const blocks = buildQueryRichBlocks(keyword, results.length, results);
					const richRes = await sendTelegramRichMessage(token, groupId, blocks);

					if (!richRes.ok) {
						const MAX_DISPLAY = 15;
						const displayList = results.slice(0, MAX_DISPLAY);
						let outputLines = [`🔍 关键词【${keyword}】检索结果（共找到 ${results.length} 条）：\n`];
						for (const r of displayList as any[]) {
							const contentPreview = r.content.length > 80 ? r.content.slice(0, 80) + '...' : r.content;
							const link = r.messageId ? ` [链接](${getMessageLink(r)})` : '';
							outputLines.push(`• ${r.userName}：${contentPreview}${link}`);
						}
						if (results.length > MAX_DISPLAY) {
							outputLines.push(`\nℹ️ 结果较多，仅展示最近 ${MAX_DISPLAY} 条记录。`);
						}

						const responseText = normalizeSpacing(outputLines.join('\n'));
						const chunks = splitTelegramMessage(escapeMarkdownV2(responseText));
						for (const chunk of chunks) {
							const res = await ctx.reply(chunk, "MarkdownV2");
							if (!res?.ok) {
								await ctx.reply(stripMarkdownV2Escapes(chunk));
							}
						}
					}
				} finally {
					if (statusMessageId) {
						await deleteTelegramMessage(getTelegramToken(env), groupId, statusMessageId);
					}
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

				const messageText = ctx.update.message!.text || "";
				const question = getCommandVar(messageText, " ").trim();
				if (!question) {
					await ctx.reply('⚠️ 请输入要问的问题，例如：/ask 大家刚才在讨论什么？');
					return new Response('ok');
				}

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

				try {
					// 先测试私聊是否可达，防止扣减额度后无法送达
					const testPmRes = await ctx.api.sendMessage(ctx.bot.api.toString(), {
						chat_id: userId,
						parse_mode: "",
						text: "⏳ 正在分析群聊记录并为您解答，请稍候...",
					} as any);
					if (!testPmRes.ok) {
						console.error("Test PM reachability failed:", testPmRes.status, await testPmRes.text());
						await ctx.reply(`请先在私聊中向机器人发送 /start 发起对话，否则无法私信推送答案。`);
						return new Response('ok');
					}

					const quota = await checkAndIncrementQuota(env, userId, 'ask');
					if (!quota.allowed) {
						await ctx.reply(`⚠️ 您今日的 /ask 提问次数已达上限（${quota.current}/${quota.limit} 次）。配额将在次日 00:00 自动刷新。`);
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
										role: "system",
										content: getSystemPrompt(env, 'ask'),
									},
									{
										role: "user",
										content: formatChatHistoryForAi(results)
									},
									{
										role: "user",
										content: `问题：${question}`
									}
								],
								...getCompletionOptions(model),
							});
					} catch (e) {
						logModelError(e, { command: 'ask', model }, [getApiKey(env), getTelegramToken(env)]);
						await ctx.reply('回答失败，AI 服务暂时无法完成请求，请稍后重试。');
						return new Response('ok');
					}

					const raw = result.choices[0].message.content || "";
					const processed = fixLink(processMarkdownLinks(raw));
					const promptHeader = `> 💬 提问：${question}\n\n`;
					const fullContent = promptHeader + processed;

					const blocks = markdownToRichBlocks(fullContent);
					blocks.push(
						{ type: "divider" },
						{
							type: "heading",
							size: 6,
							text: [
								{ type: "code", text: model },
								" · ChatGist 智能问答"
							]
						}
					);

					const response_text = formatAnswerMessage(raw);
					const token = getTelegramToken(env);
					await sendTelegramRichMessage(token, userId, blocks, {
						fallbackMarkdownV2: response_text,
					});
				} finally {
					if (groupAckMessageId) {
						await deleteTelegramMessage(getTelegramToken(env), groupId, groupAckMessageId);
					}
				}

				return new Response('ok');
			})
			.on("summary", async (bot) => {
				const msg = bot.update?.message;
				if (!msg || !msg.chat) return new Response('ok');
				const groupId = msg.chat.id.toString();
				const userId = msg.from?.id?.toString() || "";

				const parts = (msg.text || "").trim().split(/\s+/);
				const summaryArg = parts[1];
				let isDefault = false;
				let limitCount = 50;
				let hours: number | undefined;

				if (!summaryArg) {
					isDefault = true;
					limitCount = 50;
				} else {
					const match = summaryArg.match(/^(\d+)(h)?$/i);
					if (!match) {
						await bot.reply('⚠️ 请输入有效的时间范围或消息数量，例如：\n• /summary 20（最近 20 条）\n• /summary 12h（最近 12 小时）');
						return new Response('ok');
					}
					const num = parseInt(match[1], 10);
					if (num <= 0) {
						await bot.reply('⚠️ 请输入大于 0 的有效数值。');
						return new Response('ok');
					}
					if (match[2]) {
						hours = num;
					} else {
						limitCount = Math.min(num, 4000);
					}
				}

				const quota = await checkAndIncrementQuota(env, userId, 'summary');
				if (!quota.allowed) {
					await bot.reply(`⚠️ 您今日的 /summary 总结次数已达上限（${quota.current}/${quota.limit} 次）。配额将在次日 00:00 自动刷新。`);
					return new Response('ok');
				}

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

				try {
					let results: Record<string, unknown>[];
					if (hours !== undefined) {
						results = (await env.DB.prepare(`
							SELECT *
							FROM Messages
							WHERE groupId=? AND timeStamp >= ?
							ORDER BY timeStamp ASC
							`)
							.bind(groupId, Date.now() - hours * 60 * 60 * 1000)
							.all()).results;
					} else {
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
							.bind(groupId, limitCount)
							.all()).results;
					}

					if (!results || results.length === 0) {
						await bot.reply('📋 在指定范围暂无群聊消息记录，无需总结。');
						return new Response('ok');
					}

					const model = getModelName(env);
					if (!model) {
						await bot.reply('未配置 AI_MODEL 环境变量，无法处理请求。');
						return new Response('ok');
					}

					let raw = "";
					try {
						const result = await getGenModel(env).chat.completions.create({
							model,
							messages: [
								{
									role: "system",
									content: getSystemPrompt(env, 'summary'),
								},
								{
									role: "user",
									content: formatChatHistoryForAi(results)
								}
							],
							...getCompletionOptions(model),
						});
						raw = result.choices[0].message.content || "";
					} catch (e) {
						logModelError(e, { command: 'summary', model }, [getApiKey(env), getTelegramToken(env)]);
						await bot.reply('概括失败，暂时无法完成请求，请稍后重试。');
						return new Response('ok');
					}

					const processed = fixLink(processMarkdownLinks(raw));
					let contentToParse = processed;
					if (isDefault) {
						contentToParse = `> 💡 【未指定参数，默认总结近期 50 条消息】\n\n` + contentToParse;
					}

					const blocks = markdownToRichBlocks(contentToParse);
					blocks.push(
						{ type: "divider" },
						{
							type: "heading",
							size: 6,
							text: [
								{ type: "code", text: model },
								" · ChatGist 群聊动态深度概括"
							]
						}
					);

					const formatted = formatSummaryWithHighlights(raw);
					let replyContent = messageTemplate(formatted, model);
					if (isDefault) {
						replyContent = `💡【未指定参数，默认总结近期 50 条消息】\n\n` + replyContent;
					}

					const token = getTelegramToken(env);
					await sendTelegramRichMessage(token, groupId, blocks, {
						fallbackMarkdownV2: replyContent,
					});
				} finally {
					if (statusMessageId) {
						await deleteTelegramMessage(getTelegramToken(env), groupId, statusMessageId);
					}
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
						const userName = getUserName(msg);
						await saveMessage(env, { groupId, messageId, userName, content, groupName });
						return new Response('ok');

					}
					case "photo": {
						const groupId = msg.chat.id.toString();
						if (!(await isGroupWhitelisted(env, groupId))) {
							return new Response('ok');
						}
						const messageId = msg.message_id;
						const groupName = msg.chat.title || "anonymous";
						const userName = getUserName(msg);

						const candidatePhotos = [...(msg.photo || [])].reverse();
						let file: ArrayBuffer | null = null;

						for (const p of candidatePhotos) {
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

						if (!file && msg.photo && msg.photo.length > 0) {
							try {
								file = await bot.getFile(msg.photo[0].file_id).then((response) => response.arrayBuffer());
							} catch (err) {
								console.error("Error downloading fallback thumbnail:", err);
							}
						}

						if (!file) {
							console.error("Failed to download photo");
							return new Response('ok');
						}

						const mimeType = detectImageMimeType(file);
						if (!mimeType) {
							console.warn("Unsupported image format");
							return new Response('ok');
						}

						const content = `data:${mimeType};base64,` + Buffer.from(file).toString("base64");
						await saveMessage(env, { groupId, messageId, userName, content, groupName });
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
				const userName = getUserName(msg);
				await saveMessage(env, { groupId, messageId, userName, content, groupName });
				return new Response('ok');
			})
			.handle(botRequest);
		return res || new Response('ok');
	},
};
