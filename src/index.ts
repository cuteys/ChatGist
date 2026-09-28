import TelegramBot from '@codebam/cf-workers-telegram-bot';
import OpenAI from "openai";
import { Buffer } from 'node:buffer';
import { detectImageMimeType } from './image';
import { extractAllOGInfo } from "./og";
import { logModelError } from './logModelError';
import {
	deleteTelegramMessage,
	getMessageLink,
	sendTelegramRichMessage,
	editTelegramRichMessage,
	parseRichMessageResponse,
	buildWhitelistRichBlocks,
	buildAdminsRichBlocks,
	buildQueryRichBlocks,
	generateQueryPaginationKeyboard,
	richBlocksToHtml,
	splitTelegramMessage,
} from './richFormat';
import {
	initWhitelistTables,
	getSuperAdminIds,
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
import {
	getDatabaseStorageStats,
	cleanupOldMessagesAndImages,
	checkAndEnforceStorageLimit,
	formatBytes,
	getGroupTextLimit,
	getGroupImageLimit,
} from './storage';

function isGroupChat(chat?: { type?: string }): boolean {
	return Boolean(chat && (chat.type === 'group' || chat.type === 'supergroup' || chat.type?.includes('group')));
}

function escapeGlobPattern(pattern: string): string {
	return pattern.replace(/([*?\[\]])/g, '[$1]');
}

export function formatBeijingTime(timestamp: number): string {
	const d = new Date(timestamp + 8 * 3600 * 1000);
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

async function sendChatAction(token: string, chatId: string | number, action = 'typing') {
	try {
		await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ chat_id: chatId.toString(), action }),
		});
	} catch (e) {
		console.error('Failed to send chat action:', e);
	}
}

const processingUpdates = new Map<number, number>();

export function clearProcessingUpdatesForTest() {
	processingUpdates.clear();
}

function isDuplicateUpdate(updateId?: number): boolean {
	if (!updateId) return false;
	const now = Date.now();
	for (const [id, ts] of processingUpdates.entries()) {
		if (now - ts > 5 * 60 * 1000) {
			processingUpdates.delete(id);
		}
	}
	if (processingUpdates.has(updateId)) {
		return true;
	}
	processingUpdates.set(updateId, now);
	return false;
}

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

export const GROUP_COMMANDS = [
	{ command: "summary", description: "概括群聊消息" },
	{ command: "ask", description: "基于群聊记录提问并回答" },
	{ command: "query", description: "在群聊历史中检索关键词" },
];

export const PRIVATE_COMMANDS = [
	{ command: "status", description: "检查运行状态与配额" },
	{ command: "help", description: "查看功能与指令使用帮助" },
];

export const SUPER_ADMIN_COMMANDS = [
	...PRIVATE_COMMANDS,
	{ command: "addgroup", description: "【超管】将当前群或指定群加入白名单" },
	{ command: "delgroup", description: "【超管】将群组移出白名单" },
	{ command: "whitelist", description: "【超管】查看已授权白名单群组" },
	{ command: "addadmin", description: "【超管】添加管理员" },
	{ command: "deladmin", description: "【超管】移除管理员" },
	{ command: "admins", description: "【超管】查看所有管理员列表" },
	{ command: "clearmessages", description: "【超管】清空指定群组的历史消息记录" },
	{ command: "setcommands", description: "【超管】同步更新指令菜单" },
];

export const BOT_COMMANDS = [
	...GROUP_COMMANDS,
	...PRIVATE_COMMANDS,
	...SUPER_ADMIN_COMMANDS.slice(PRIVATE_COMMANDS.length),
];

export async function registerBotCommands(token: string, adminUserIds: string[] = []) {
	try {
		// 1. 群聊菜单：仅群功能指令
		await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				commands: GROUP_COMMANDS,
				scope: { type: "all_group_chats" },
			}),
		});

		// 2. 私聊菜单：/help 与 /status
		await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				commands: PRIVATE_COMMANDS,
				scope: { type: "all_private_chats" },
			}),
		});

		// 3. 默认兜底菜单
		await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				commands: PRIVATE_COMMANDS,
				scope: { type: "default" },
			}),
		});

		// 4. 超级管理员私聊专属菜单
		for (const adminId of adminUserIds) {
			const trimmed = adminId.trim();
			if (!trimmed) continue;
			await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					commands: SUPER_ADMIN_COMMANDS,
					scope: { type: "chat", chat_id: trimmed },
				}),
			});
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

function getCompletionOptions(model: string, jsonMode = false) {
	const isReasoning = model.startsWith("o1") || model.startsWith("o3");
	return {
		...(isReasoning ? { max_completion_tokens: 4096 } : { max_tokens: 4096 }),
		...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
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
	summarizeChat: `你是一个专业的群聊总结助手。你的任务是分析提供的群聊记录，提取关键信息并输出排版精美、生动有趣、结构清晰的总结。

输入记录格式如下：
====================
用户名 [北京时间]:
发言内容
相应链接
====================

【排版与视觉规范】
1. 丰富生动的 Emoji：在各级标题、概述、要点、表格和清单中，恰当点缀符合语境的高表现力 Emoji（如 📊 🎯 💡 ⚡ 🛠️ 🔍 📝 📌 💬 🎬 🚀 等），使总结直观、有趣且美观；
2. 链接自然内嵌：在开头的概述及后续各议题中，都必须将原消息的“相应链接”直接嵌入到核心关键词、事件或方案名中（例如：群聊聚焦于 [401 认证报错修复](相应链接) 与 [片单计费体系](相应链接)；期间探讨了 [视频 AI 超分修复测试](相应链接)...），点击关键词即可直达原消息，严禁在句末或单独列中追加独立的“[💬 原文]”；
3. 原生富文本组件结构：不要输出任何顶部标题（严禁输出“# 群聊动态深度总结”、“✨ 【本期看点速览】”等），直接以 1-2 段生动的核心概述开头，合理使用 <details><summary> 抽屉、原生 Markdown 表格、待办复选框。

请直接输出符合以下结构的 Markdown：

用 1-2 段生动精炼的语言概括本次群聊的核心热点、主要争议与讨论走向，并将讨论核心词直接嵌入对应原消息链接（如：本期群友重点探讨了 [401 报错排查](对应相应链接) 与 [片单计费逻辑](对应相应链接)，此外分享了 [AI 视频超分实测数据](对应相应链接)...）。

<details>
<summary>🎯 议题一标题（简明生动）</summary>

### 📌 1. 核心讨论要点
- **[关键观点/核心议题](对应相应链接)**：具体讨论内容与群友看法...
- **[补充方案/技术细节](对应相应链接)**：具体实现或经验总结...

### 📊 2. 方案/规则对比（涉及机制、规则、参数时使用表格）
| 🏷️ 机制/方案 | 📝 核心规则与说明 | 💡 特性与建议 |
| :---: | :---: | :---: |
| **[方案A](对应相应链接)** | 规则说明与逻辑 | 核心优势与注意事项 |
| **[方案B](对应相应链接)** | 规则说明与逻辑 | 核心优势与注意事项 |

</details>

<details>
<summary>💬 议题二标题</summary>

### 📌 1. 核心讨论要点
群友围绕 [核心话题](对应相应链接) 展开了讨论，指出...

</details>

<details>
<summary>📋 待办事项与行动清单</summary>

- [ ] **[任务名称](对应相应链接)**：说明具体操作与负责人...
- [x] **[已确认事项](对应相应链接)**：说明已完成的处置...

</details>

【核心约束】
1. 严禁输出顶部一级大标题及“✨ 【本期看点速览】”等标题字样，直接输出精炼概述与各议题抽屉；
2. 概述与正文要点中的链接必须直接嵌入词句中，不要产生多余的“💬 原文”；
3. 链接必须 100% 来源于输入中的真实“相应链接”，严禁杜撰或捏造；
4. 输出纯 Markdown 文本，无需其他废话。`,

	answerQuestion: `你是一个群聊智能问答助手。你的任务是基于提供的群聊记录精准回答用户的问题。

群聊记录格式如下：
====================
用户名 [北京时间]:
发言内容
相应链接
====================

【回答规范】
1. 结合群聊实际发言，给出清晰、准确、条理分明的回答，并适当使用友好的 Emoji（如 💡 📌 🔍 🛠️ ✅ 等）；
2. 凡是引用群友发言或作为回答依据的内容，将对应原消息的“相应链接”直接自然地嵌入到关键词或短语中（例如：群友 [Alice 提到](相应链接)...，或者参考 [该方案配置](相应链接)），无需单独在句末追加“[💬 原文]”；
3. 链接必须 100% 来源于输入中的真实“相应链接”，严禁杜撰；
4. 若群聊中未提及相关信息，请明确说明未找到相关记录；
5. 输入中包含【当前提问上下文】（所在群组、提问者身份与提问时间）。若用户在提问中提及“我”、“我们群”、“本群”等主语，请结合提问者与群组信息在群聊记录中进行精准匹配与解答。`
};

function getSystemPrompt(env: Env, type: 'summary' | 'ask'): string {
	if (type === 'summary') {
		return env.SYSTEM_PROMPT_SUMMARY?.trim() || SYSTEM_PROMPTS.summarizeChat;
	}
	return env.SYSTEM_PROMPT_ASK?.trim() || SYSTEM_PROMPTS.answerQuestion;
}

async function withTemporaryStatus<T>(
	replyFn: (text: string) => Promise<any>,
	botToken: string,
	chatId: string,
	promptText: string,
	task: () => Promise<T>
): Promise<T> {
	let statusMessageId: number | undefined;
	try {
		const res = await replyFn(promptText);
		if (res?.ok) {
			const data: any = await res.json().catch(() => null);
			statusMessageId = data?.result?.message_id;
		}
	} catch (e) {
		console.error("Failed to send temporary status message:", e);
	}

	if (botToken && chatId) {
		await sendChatAction(botToken, chatId, 'typing');
	}

	try {
		return await task();
	} finally {
		if (statusMessageId && botToken && chatId) {
			await deleteTelegramMessage(botToken, chatId, statusMessageId);
		}
	}
}

async function generateSummaryRichMessage(
	env: Env,
	results: any[],
	model: string,
	quoteNotice: string
): Promise<{ blocks: any[]; raw: string }> {
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
		...getCompletionOptions(model, false),
	});

	const raw = result.choices[0].message.content || "";
	const richData = parseRichMessageResponse(raw);
	richData.blocks.unshift({
		type: "blockquote",
		blocks: [{ type: "paragraph", text: quoteNotice }],
	});
	richData.blocks.push(
		{ type: "divider" },
		{
			type: "heading",
			size: 6,
			text: { type: "code", text: model },
		}
	);
	return { blocks: richData.blocks, raw };
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

function getQuestionerInfo(msg: any): string {
	const name = getUserName(msg);
	if (msg?.sender_chat?.title) {
		return `${name} (频道/匿名身份, ID: ${msg.sender_chat.id})`;
	}
	const tag = msg?.from?.username ? `@${msg.from.username}` : "";
	const id = msg?.from?.id ? `ID: ${msg.from.id}` : "";
	const details = [tag, id].filter(Boolean).join(", ");
	return details ? `${name} (${details})` : name;
}

function getForwardSender(msg: any): string {
	const origin = msg?.forward_origin;
	if (origin) {
		switch (origin.type) {
			case 'user':
				return [origin.sender_user?.first_name, origin.sender_user?.last_name].filter(Boolean).join(" ");
			case 'hidden_user':
				return origin.sender_user_name || "";
			case 'chat':
				return origin.sender_chat?.title || "";
			case 'channel':
				return origin.chat?.title || "";
		}
	}
	if (msg?.forward_from) {
		return [msg.forward_from.first_name, msg.forward_from.last_name].filter(Boolean).join(" ");
	}
	if (msg?.forward_sender_name) {
		return msg.forward_sender_name;
	}
	if (msg?.forward_from_chat?.title) {
		return msg.forward_from_chat.title;
	}
	return "";
}

function attachMessageContext(content: string, msg: any, groupId: string): string {
	const replyTo = msg.reply_to_message?.message_id;
	const fwdSender = getForwardSender(msg);
	let result = content;
	if (fwdSender) {
		result = `转发自 ${fwdSender}: ${result}`;
	}
	if (replyTo) {
		result = `回复 ${getMessageLink({ groupId, messageId: replyTo })}: ${result}`;
	}
	return result;
}

async function transcribeVoice(
	env: Env,
	bot: any,
	voice: { file_id: string; duration?: number; file_size?: number }
): Promise<string | null> {
	const MAX_VOICE_BYTES = 5 * 1024 * 1024;
	const MAX_VOICE_DURATION = 120;

	if (voice.file_size && voice.file_size > MAX_VOICE_BYTES) return null;
	if (voice.duration && voice.duration > MAX_VOICE_DURATION) return null;

	const apiKey = getApiKey(env);
	if (!apiKey) return null;

	try {
		const buf = await bot.getFile(voice.file_id).then((res: any) => res.arrayBuffer());
		if (!buf || buf.byteLength > MAX_VOICE_BYTES) return null;

		const audioFile = new File([buf], 'voice.ogg', { type: 'audio/ogg' });
		const client = getGenModel(env);

		const response = await client.audio.transcriptions.create({
			file: audioFile,
			model: 'whisper-1',
		});

		const text = response?.text?.trim();
		return text || null;
	} catch (e) {
		console.warn('Voice transcription failed or unsupported:', e);
		return null;
	}
}

function formatChatHistoryForAi(results: any[], quotedMessageId?: number) {
	return results.flatMap((r: any) => {
		const timeStr = r.messageTime || (r.timeStamp ? formatBeijingTime(r.timeStamp) : "");
		const sender = timeStr ? `${r.userName} [${timeStr}]:` : `${r.userName}:`;
		let content = r.content;
		if (quotedMessageId && typeof content === "string" && content.startsWith("data:image/")) {
			content = r.messageId === quotedMessageId ? "[目标引用图片]" : "[历史图片]";
		}
		return [
			dispatchContent(`====================`),
			dispatchContent(sender),
			dispatchContent(content),
			dispatchContent(getMessageLink(r)),
		];
	});
}

async function saveMessage(env: Env, params: {
	groupId: string;
	messageId: number;
	userName: string;
	content: string;
	groupName: string;
	timeStamp?: number;
}) {
	const timeStamp = params.timeStamp || Date.now();
	const messageTime = formatBeijingTime(timeStamp);

	const doInsert = () =>
		env.DB.prepare(
			`INSERT OR REPLACE INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName, messageTime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
			.bind(
				getMessageLink({ groupId: params.groupId, messageId: params.messageId }),
				params.groupId,
				timeStamp,
				params.userName,
				params.content,
				params.messageId,
				params.groupName,
				messageTime
			)
			.run();

	try {
		await doInsert();
	} catch (e: any) {
		const isMissingColumn = e?.message && (
			e.message.includes("no such column: messageTime") ||
			e.message.includes("has no column named messageTime") ||
			(e?.cause?.message && (e.cause.message.includes("no such column: messageTime") || e.cause.message.includes("has no column named messageTime")))
		);

		if (isMissingColumn) {
			try {
				await env.DB.prepare("ALTER TABLE Messages ADD COLUMN messageTime TEXT").run();
				await doInsert();
				return;
			} catch (alterErr) {
				console.error("Auto-migrate messageTime column failed:", alterErr);
			}
		}

		console.error("Failed to save message:", e);
		if (e?.message && /storage|full|limit/i.test(e.message)) {
			try {
				await checkAndEnforceStorageLimit(env, getTelegramToken(env), 300);
				await doInsert();
			} catch (retryErr) {
				console.error("Retry save message after emergency cleanup failed:", retryErr);
			}
		}
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
		return `👑 <b>【超级管理员使用指南】</b>\n` +
			`您拥有本机器人的最高控制权限，不受任何使用频次限制。\n\n` +
			`🛠️ <b>白名单与权限管理：</b>\n` +
			`• /addgroup [群ID] [名称] - 授权群组\n` +
			`• /delgroup [群ID] - 移出白名单\n` +
			`• /whitelist - 查看白名单群组列表\n` +
			`• /addadmin &lt;用户ID&gt; [备注] - 添加管理员\n` +
			`• /deladmin &lt;用户ID&gt; - 移除管理员\n` +
			`• /admins - 查看管理员列表\n` +
			`• /clearmessages [群ID] - 清空指定群组的历史消息记录\n` +
			`• /setcommands - 向 Telegram 同步指令菜单\n\n` +
			`💬 <b>群聊常用指令：</b>\n` +
			`• /summary &lt;数量/时间&gt; - 概括群聊消息\n` +
			`• /ask &lt;问题&gt; - 基于群聊记录提问并回答\n` +
			`• /query &lt;关键词&gt; - 检索历史消息\n\n` +
			`💬 <b>私聊指令：</b>\n` +
			`• /status - 检查运行状态与群组存储统计\n` +
			`• /help - 查看本使用帮助\n\n` +
			`ℹ️ 您的 Telegram 用户 ID 为：<code>${userId}</code>`;
	}

	if (admin) {
		return `🛡️ <b>【管理员使用指南】</b>\n` +
			`您已被系统授权为机器人管理员，享有<b>无限次使用特权</b>！\n\n` +
			`💬 <b>群聊可用指令：</b>\n` +
			`• /summary &lt;数量/时间&gt; - 概括群聊消息\n` +
			`• /ask &lt;问题&gt; - 基于群聊记录提问并回答\n` +
			`• /query &lt;关键词&gt; - 检索群聊历史消息\n\n` +
			`💬 <b>私聊指令：</b>\n` +
			`• /status - 检查运行状态与群组存储统计\n` +
			`• /help - 查看本使用帮助\n\n` +
			`ℹ️ 您的 Telegram 用户 ID 为：<code>${userId}</code>`;
	}

	return `📖 <b>【ChatGist 群聊助手使用指南】</b>\n` +
		`欢迎使用群聊智能总结与检索助手！\n\n` +
		`💬 <b>群聊功能指令：</b>\n` +
		`• /summary &lt;数量/时间&gt; - 概括近期群聊重点，每日限 5 次\n` +
		`• /ask &lt;问题&gt; - 基于近期群聊记录回答，每日限 5 次\n` +
		`• /query &lt;关键词&gt; - 检索群聊历史消息，每日限 20 次\n\n` +
		`💬 <b>私聊指令：</b>\n` +
		`• /status - 检查机器人运行状态与个人今日配额\n` +
		`• /help - 查看本指令使用指南\n\n` +
		`ℹ️ <b>使用须知：</b>\n` +
		`1. 您的 Telegram 用户 ID 为：<code>${userId}</code>\n` +
		`2. 机器人仅在管理员授权的白名单群组中记录与响应；\n` +
		`3. /summary、/ask、/query 仅限在授权群聊中使用；\n` +
		`4. /status、/help 仅限在私信中使用；\n` +
		`5. 每日使用额度于北京时间 00:00 自动刷新。`;
}

async function requireGroupChat(ctx: any, commandName: string): Promise<boolean> {
	const chat = ctx.update?.message?.chat;
	if (!isGroupChat(chat)) {
		await ctx.reply(`⚠️ /${commandName} 指令仅支持在群聊中使用。\n请将机器人添加到群组并由管理员授权后在群内使用。`);
		return false;
	}
	return true;
}

async function requireSuperAdmin(ctx: any, env: Env, userId: string): Promise<boolean> {
	if (isSuperAdmin(env, userId)) {
		return true;
	}
	const isGroup = isGroupChat(ctx.update.message?.chat);
	if (!isGroup) {
		await ctx.reply(`❌ 权限不足：仅系统超级管理员可执行该管理指令。\n您的 Telegram 用户 ID 为：${userId}`);
	}
	return false;
}

async function handleAddGroup(ctx: any, env: Env, userId: string, targetGroupId?: string, targetGroupName?: string) {
	const chat = ctx.update.message?.chat;
	const isGroup = isGroupChat(chat);

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
	const isGroup = isGroupChat(chat);

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

	const replyMarkup = groups.length > 0 ? {
		inline_keyboard: groups.slice(0, 5).map((g) => [
			{
				text: `🗑️ 移出「${g.groupName.slice(0, 12)}」`,
				switch_inline_query_current_chat: `/delgroup ${g.groupId}`,
			},
		]),
	} : undefined;

	if (token && chatId) {
		const blocks = buildWhitelistRichBlocks(groups);
		const sendRes = await sendTelegramRichMessage(token, chatId, blocks, { replyMarkup });
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
	const envAdmins = getSuperAdminIds(env);
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

		// 1. 定期清理：清理 3 天前配额、各群保留最新 3000 条消息与 100 张图片，并监控存储容量
		try {
			await cleanOldQuotaRecords(env);
			const { textCleaned, imagesCleaned } = await cleanupOldMessagesAndImages(env);
			console.debug(`Scheduled cleanup completed: ${textCleaned} messages, ${imagesCleaned} images removed.`);
			await checkAndEnforceStorageLimit(env, getTelegramToken(env));
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

		// 3. 逐个群组生成并推送总结，受控并发处理
		const BATCH_SIZE = 3;
		for (let i = 0; i < groups.length; i += BATCH_SIZE) {
			const batch = groups.slice(i, i + BATCH_SIZE);
			await Promise.all(
				batch.map(async (group) => {
					try {
						const { results } = await env.DB.prepare(
							'SELECT * FROM Messages WHERE groupId=? AND timeStamp >= ? ORDER BY timeStamp ASC'
						)
							.bind(group.groupId, Date.now() - 24 * 60 * 60 * 1000)
							.all();

						if (!results || results.length === 0) return;

						const { blocks, raw } = await generateSummaryRichMessage(
							env,
							results,
							model,
							'每日定时总结：过去 24 小时活跃群聊概览'
						);

						await sendTelegramRichMessage(getTelegramToken(env), group.groupId, blocks, { rawMarkdown: raw });
					} catch (err) {
						console.error(`Error processing scheduled summary for group ${group.groupId}:`, err);
					}
				})
			);
		}
		console.debug("Scheduled cron completed.");
	},
	fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
		const botToken = getTelegramToken(env);
		if (request.method === "GET") {
			const url = new URL(request.url);
			if (url.pathname === "/setcommands") {
				const adminIds = getSuperAdminIds(env);
				await registerBotCommands(botToken, adminIds);
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

			if (isDuplicateUpdate(body?.update_id)) {
				return new Response("ok");
			}

			if (!body?.message && body?.edited_message) {
				body.message = body.edited_message;
			}

			if (body?.callback_query) {
				const cq = body.callback_query;
				const data = cq.data || "";
				const cqId = cq.id;

				try {
					await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ callback_query_id: cqId }),
					});
				} catch (err) {
					console.error("Failed to answer callback query:", err);
				}

				if (data === "noop") {
					return new Response("ok");
				}

				if (data.startsWith("qp:")) {
					const [, pageStr, ...kwParts] = data.split(":");
					const page = parseInt(pageStr, 10) || 1;
					const keyword = kwParts.join(":");
					const cqChat = cq.message?.chat;
					const cqChatId = cqChat?.id?.toString() || "";
					const messageId = cq.message?.message_id;

					if (cqChatId && messageId && keyword) {
						const isGroup = isGroupChat(cqChat);
						if (isGroup && !(await isGroupWhitelisted(env, cqChatId))) {
							return new Response("ok");
						}

						const { results } = await env.DB.prepare(`
							SELECT * FROM Messages
							WHERE groupId = ? AND content NOT LIKE 'data:image%' AND content GLOB ?
							ORDER BY timeStamp DESC`)
							.bind(cqChatId, `*${escapeGlobPattern(keyword)}*`)
							.all();

						if (results && results.length > 0) {
							const PAGE_SIZE = 6;
							const totalPages = Math.ceil(results.length / PAGE_SIZE);
							const clampedPage = Math.max(1, Math.min(page, totalPages));
							const pageResults = results.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

							const blocks = buildQueryRichBlocks(keyword, results.length, pageResults, clampedPage, PAGE_SIZE);
							const replyMarkup = generateQueryPaginationKeyboard(keyword, clampedPage, totalPages);
							await editTelegramRichMessage(botToken, cqChatId, messageId, blocks, { replyMarkup });
						}
					}
				}

				return new Response("ok");
			}

			if (!body?.message) {
				return new Response("ok");
			}

			if (body.message?.text && body.message.text.startsWith("/")) {
				body.message.text = body.message.text.replace(/^(\/[a-zA-Z0-9_]+)@[a-zA-Z0-9_]+/, "$1");
			}

			const msg = body.message;
			const chat = msg?.chat;
			const isGroup = isGroupChat(chat);

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
				if (isGroupChat(chat)) {
					return new Response('ok');
				}

				await ctx.reply('👋 你好！欢迎使用 ChatGist 群聊智能助手！\n将我添加到群组并设为管理员即可开始使用，发送 /help 可查看完整指南。');
				return new Response('ok');
			})
			.on('help', async (ctx) => {
				const chat = ctx.update.message?.chat;
				if (isGroupChat(chat)) {
					return new Response('ok');
				}

				const userId = ctx.update.message?.from?.id?.toString() || "";
				const superAdmin = isSuperAdmin(env, userId);
				const admin = await isAdmin(env, userId);
				const helpText = getRoleHelpText(env, userId, superAdmin, admin);

				await ctx.reply(helpText, "HTML");
				return new Response('ok');
			})
			.on('setcommands', (ctx) => withAdminAuth(ctx, env, async () => {
				const adminIds = getSuperAdminIds(env);
				await registerBotCommands(botToken, adminIds);
				await ctx.reply('✅ 已向 Telegram 同步注册指令列表！');
			}))
			.on('status', async (ctx) => {
				const chat = ctx.update.message?.chat;
				if (isGroupChat(chat)) {
					return new Response('ok');
				}

				const userId = ctx.update.message?.from?.id?.toString() || "";
				const superAdmin = isSuperAdmin(env, userId);
				const admin = await isAdmin(env, userId);

				let statusText = '🤖 机器人运行状态正常\n';
				if (superAdmin) {
					statusText += '👑 身份：系统超级管理员\n';
				} else if (admin) {
					statusText += '🛡️ 身份：数据库管理员\n';
				} else {
					statusText += '👤 身份：普通用户\n';
				}

				if (admin) {
					try {
						const storageStats = await getDatabaseStorageStats(env);
						const percent = ((storageStats.totalBytes / storageStats.limitBytes) * 100).toFixed(1);
						const textLimit = getGroupTextLimit(env);
						const imageLimit = getGroupImageLimit(env);

						statusText += `\n💾 数据库存储统计：\n` +
							`• 数据库总大小：${formatBytes(storageStats.totalBytes)} / 500 MB (${percent}%)\n` +
							`• 单群保留上限：文本 ${textLimit} 条 | 图片 ${imageLimit} 张\n` +
							`• 数据库总消息：文本 ${storageStats.totalTextCount} 条 | 图片 ${storageStats.totalImageCount} 张\n` +
							`• 统计群组总数：${storageStats.groupStats.length} 个\n`;

						if (storageStats.groupStats.length > 0) {
							statusText += `\n👥 各群组消息与空间明细：\n`;
							storageStats.groupStats.forEach((g, idx) => {
								const textCount = Math.max(0, g.totalCount - g.imageCount);
								statusText += `${idx + 1}. 「${g.groupName}」\n` +
									`   • 文本消息：${textCount} 条 | 图片：${g.imageCount} 张\n` +
									`   • 占用空间：${formatBytes(g.estimatedBytes)}\n`;
							});
						} else {
							statusText += `\n👥 各群组明细：暂无群组消息记录\n`;
						}
					} catch (e: any) {
						console.error("Failed to get storage stats in /status:", e);
					}
				}

				if (superAdmin) {
					try {
						const d1Start = Date.now();
						await env.DB.prepare("SELECT 1").first();
						const d1Latency = Date.now() - d1Start;

						let aiLatencyText = "未配置";
						const apiKey = getApiKey(env);
						const model = getModelName(env);
						if (apiKey && model) {
							const aiStart = Date.now();
							try {
								const baseUrl = getBaseUrl(env) || "https://api.openai.com/v1";
								const aiRes = await fetch(`${baseUrl}/models`, {
									headers: { Authorization: `Bearer ${apiKey}` },
									signal: AbortSignal.timeout(3000),
								});
								const aiLatency = Date.now() - aiStart;
								aiLatencyText = aiRes.ok ? `正常 (${aiLatency}ms)` : `响应异常 (${aiRes.status}, ${aiLatency}ms)`;
							} catch (err: any) {
								aiLatencyText = `连接失败 (${err?.name === "TimeoutError" ? "超时" : "异常"})`;
							}
						}

						statusText += `\n⚡ 系统连通性诊断：\n` +
							`• D1 数据库延迟：${d1Latency}ms\n` +
							`• AI 接口状态：${aiLatencyText}\n`;
					} catch (e) {
						console.error("Failed to run diagnostics in /status:", e);
					}
				}

				if (!admin) {
					const quota = await getUserQuotaStatus(env, userId);
					statusText += `\n📊 今日使用配额（次日 00:00 自动刷新）：\n` +
						`• 总结 (/summary): ${quota.summary.current}/${quota.summary.limit} 次\n` +
						`• 问答 (/ask): ${quota.ask.current}/${quota.ask.limit} 次\n` +
						`• 检索 (/query): ${quota.query.current}/${quota.query.limit} 次`;
				}

				await ctx.reply(statusText);
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
				if (!(await requireGroupChat(ctx, 'query'))) return new Response('ok');
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

				const botToken = getTelegramToken(env);
				await withTemporaryStatus(
					(text) => ctx.reply(text),
					botToken,
					groupId,
					`🔍 正在检索关键词【${keyword}】，请稍候...`,
					async () => {
						const { results } = await env.DB.prepare(`
							SELECT * FROM Messages
							WHERE groupId = ? AND content NOT LIKE 'data:image%' AND content GLOB ?
							ORDER BY timeStamp DESC`)
							.bind(groupId, `*${escapeGlobPattern(keyword)}*`)
							.all();

						if (!results || results.length === 0) {
							await ctx.reply(`🔍 未找到包含关键词【${keyword}】的相关历史消息。`);
							return;
						}

						const PAGE_SIZE = 6;
						const totalPages = Math.ceil(results.length / PAGE_SIZE);
						const pageResults = results.slice(0, PAGE_SIZE);

						const blocks = buildQueryRichBlocks(keyword, results.length, pageResults, 1, PAGE_SIZE);
						const replyMarkup = generateQueryPaginationKeyboard(keyword, 1, totalPages);
						const richRes = await sendTelegramRichMessage(botToken, groupId, blocks, { replyMarkup });

						if (!richRes.ok) {
							const htmlText = richBlocksToHtml(blocks);
							await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({
									chat_id: groupId,
									text: htmlText,
									parse_mode: "HTML",
									disable_web_page_preview: true,
									reply_markup: replyMarkup,
								}),
							});
						}
					}
				);

				return new Response('ok');
			})
			.on("ask", async (ctx) => {
				if (!(await requireGroupChat(ctx, 'ask'))) return new Response('ok');
				const model = getModelName(env);
				if (!model) {
					await ctx.reply('未配置 AI_MODEL 环境变量，无法处理请求。');
					return new Response('ok');
				}
				const msg = ctx.update?.message;
				if (!msg || !msg.chat) return new Response('ok');
				const groupId = msg.chat.id.toString();
				const userId = msg.from?.id?.toString() || "";

				const messageText = ctx.update.message?.text || "";
				const question = messageText.split(/\s+/).slice(1).join(" ").trim();
				if (!question) {
					await ctx.reply('⚠️ 请输入要问的问题，例如：/ask 大家刚才在讨论什么？');
					return new Response('ok');
				}

				const { results } = await env.DB.prepare(`
					WITH latest_pool AS (
						SELECT * FROM Messages
						WHERE groupId=?
						ORDER BY timeStamp DESC
						LIMIT 1000
					)
					SELECT * FROM latest_pool
					ORDER BY timeStamp ASC
					`)
					.bind(groupId)
					.all();

				if (!results || results.length === 0) {
					await ctx.reply('📋 本群暂无消息记录，无法回答。');
					return new Response('ok');
				}

				const quota = await checkAndIncrementQuota(env, userId, 'ask');
				if (!quota.allowed) {
					await ctx.reply(`⚠️ 您今日的 /ask 提问次数已达上限（${quota.current}/${quota.limit} 次）。配额将在次日 00:00 自动刷新。`);
					return new Response('ok');
				}

				let replyPromptContext = "";
				let quotedImageContent: string | null = null;
				const replyMsg = msg.reply_to_message;
				if (replyMsg) {
					const repliedUser = getUserName(replyMsg);
					const repliedMsgId = replyMsg.message_id;
					const repliedLink = getMessageLink({ groupId, messageId: repliedMsgId });

					let repliedContent = replyMsg.text || "";
					let repliedTime = replyMsg.date ? formatBeijingTime(replyMsg.date * 1000) : "";

					try {
						const dbMsg = await env.DB.prepare(
							"SELECT * FROM Messages WHERE groupId = ? AND messageId = ?"
						).bind(groupId, repliedMsgId).first<any>();

						if (dbMsg) {
							if (dbMsg.messageTime) repliedTime = dbMsg.messageTime;
							else if (dbMsg.timeStamp) repliedTime = formatBeijingTime(dbMsg.timeStamp);

							if (typeof dbMsg.content === "string" && dbMsg.content.startsWith("data:image/")) {
								quotedImageContent = dbMsg.content;
							} else if (!repliedContent && dbMsg.content) {
								repliedContent = dbMsg.content;
							}
						}
					} catch (dbErr) {
						console.error("Failed to query quoted message from DB:", dbErr);
					}

					if (!quotedImageContent && replyMsg.photo && replyMsg.photo.length > 0) {
						try {
							const MAX_PHOTO_BYTES = 512 * 1024;
							const candidatePhotos = [...replyMsg.photo].reverse();
							let file: ArrayBuffer | null = null;
							for (const p of candidatePhotos) {
								if (p.file_size && p.file_size > MAX_PHOTO_BYTES) continue;
								const buf = await ctx.getFile(p.file_id).then((res: any) => res.arrayBuffer());
								if (buf.byteLength <= MAX_PHOTO_BYTES) {
									file = buf;
									break;
								}
							}
							if (!file && replyMsg.photo[0]) {
								file = await ctx.getFile(replyMsg.photo[0].file_id).then((res: any) => res.arrayBuffer());
							}
							if (file) {
								const mime = detectImageMimeType(file);
								if (mime) {
									quotedImageContent = `data:${mime};base64,` + Buffer.from(file).toString("base64");
								}
							}
						} catch (downloadErr) {
							console.error("Failed to download quoted photo on demand:", downloadErr);
						}
					}

					if (!repliedContent) {
						repliedContent = quotedImageContent || replyMsg.photo ? "[图片]" : "";
					}
					if (replyMsg.caption) {
						repliedContent = repliedContent ? `${repliedContent} ${replyMsg.caption}` : replyMsg.caption;
					}

					const timeLabel = repliedTime ? ` [${repliedTime}]` : "";
					if (repliedContent) {
						replyPromptContext = `【用户重点追问的引用消息】\n• 来源消息直达链接: ${repliedLink}\n• 发言人: ${repliedUser}${timeLabel}\n• 引用内容: ${repliedContent}\n`;
					}
				}

				const botToken = getTelegramToken(env);
				await withTemporaryStatus(
					(text) => ctx.reply(text),
					botToken,
					groupId,
					"⏳ 收到提问，正在分析近期群聊并解答，请稍候...",
					async () => {
						let result;
						const groupName = msg.chat.title || "未知群组";
						const currentTime = formatBeijingTime(msg.date ? msg.date * 1000 : Date.now());
						const questionerInfo = getQuestionerInfo(msg);

						const contextPrompt =
							`【当前提问上下文】\n` +
							`• 所在群组: ${groupName} (ID: ${groupId})\n` +
							`• 提问者: ${questionerInfo}\n` +
							`• 提问时间: ${currentTime}\n`;

						const promptHeader = replyPromptContext
							? `${contextPrompt}\n${replyPromptContext}\n`
							: `${contextPrompt}\n`;

						const userQuestionContent = quotedImageContent
							? [
									{ type: "image_url" as const, image_url: { url: quotedImageContent } },
									{ type: "text" as const, text: `${promptHeader}问题：${question}\n（请重点结合上面引用的目标图片与来源链接进行解答）` }
							  ]
							: `${promptHeader}问题：${question}`;

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
											content: formatChatHistoryForAi(results, quotedImageContent && replyMsg ? replyMsg.message_id : undefined)
										},
										{
											role: "user",
											content: userQuestionContent as any
										}
									],
									...getCompletionOptions(model, false),
								});
						} catch (e) {
							logModelError(e, { command: 'ask', model }, [getApiKey(env), botToken]);
							await ctx.reply('回答失败，AI 服务暂时无法完成请求，请稍后重试。');
							return;
						}

						const raw = result.choices[0].message.content || "";
						const richData = parseRichMessageResponse(raw);
						richData.blocks.unshift({
							type: "blockquote",
							blocks: [
								{ type: "paragraph", text: `💬 提问：${question}` }
							]
						});
						richData.blocks.push(
							{ type: "divider" },
							{
								type: "heading",
								size: 6,
								text: { type: "code", text: model }
							}
						);
						await sendTelegramRichMessage(botToken, groupId, richData.blocks, {
							rawMarkdown: raw,
							replyToMessageId: msg.message_id,
						});
					}
				);

				return new Response('ok');
			})
			.on("summary", async (bot) => {
				if (!(await requireGroupChat(bot, 'summary'))) return new Response('ok');
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
					const match = summaryArg.match(/^(\d+)(h|小时|d|天|m|分|分钟)?$/i);
					if (!match) {
						await bot.reply('⚠️ 请输入有效的时间范围或消息数量，例如：/summary 20 或 /summary 12h');
						return new Response('ok');
					}
					const num = parseInt(match[1], 10);
					if (num <= 0) {
						await bot.reply('⚠️ 请输入大于 0 的有效数值。');
						return new Response('ok');
					}
					const unit = (match[2] || '').toLowerCase();
					if (unit === 'h' || unit === '小时') {
						hours = num;
					} else if (unit === 'd' || unit === '天') {
						hours = num * 24;
					} else if (unit === 'm' || unit === '分' || unit === '分钟') {
						hours = Math.max(0.01, num / 60);
					} else {
						limitCount = Math.min(num, 4000);
					}
				}

				const isNormalUser = !(await isAdmin(env, userId));
				let noticeNote = "";

				if (isNormalUser) {
					if (hours !== undefined && hours > 48) {
						hours = 48;
						noticeNote = "，普通用户单次上限 48 小时";
					} else if (hours === undefined && limitCount > 3000) {
						limitCount = 3000;
						noticeNote = "，普通用户单次上限 3000 条";
					}
				}

				const quota = await checkAndIncrementQuota(env, userId, 'summary');
				if (!quota.allowed) {
					await bot.reply(`⚠️ 您今日的 /summary 总结次数已达上限（${quota.current}/${quota.limit} 次）。配额将在次日 00:00 自动刷新。`);
					return new Response('ok');
				}

				const botToken = getTelegramToken(env);
				const statusPrompt = noticeNote
					? `⏳ 已按普通用户上限调整${noticeNote}，正在生成总结，请稍候...`
					: "⏳ 正在读取群聊记录并生成总结，请稍候...";

				await withTemporaryStatus(
					(text) => bot.reply(text),
					botToken,
					groupId,
					statusPrompt,
					async () => {
						let results: Record<string, unknown>[];
						if (hours !== undefined) {
							results = (await env.DB.prepare(`
								SELECT *
								FROM Messages
								WHERE groupId=? AND timeStamp >= ?
								ORDER BY timeStamp ASC
								LIMIT ?
								`)
								.bind(groupId, Date.now() - hours * 60 * 60 * 1000, isNormalUser ? 3000 : 4000)
								.all()).results;
						} else {
							if (isNormalUser) {
								results = (await env.DB.prepare(`
									WITH latest_n AS (
										SELECT * FROM Messages
										WHERE groupId=? AND timeStamp >= ?
										ORDER BY timeStamp DESC
										LIMIT ?
									)
									SELECT * FROM latest_n
									ORDER BY timeStamp ASC
									`)
									.bind(groupId, Date.now() - 48 * 60 * 60 * 1000, limitCount)
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
						}

						if (!results || results.length === 0) {
							await bot.reply('📋 在指定范围暂无群聊消息记录，无需总结。');
							return;
						}

						const model = getModelName(env);
						if (!model) {
							await bot.reply('未配置 AI_MODEL 环境变量，无法处理请求。');
							return;
						}

						const countDesc = hours !== undefined ? `最近 ${hours} 小时` : `近期 ${limitCount} 条`;
						const groupTitle = msg.chat?.title ? `「${msg.chat.title}」` : "";
						const quoteNotice = isDefault
							? `💡 未指定参数，默认总结群聊${groupTitle}近期 50 条消息`
							: `总结群聊${groupTitle}${countDesc}聊天记录${noticeNote}`;

						try {
							const { blocks, raw } = await generateSummaryRichMessage(env, results, model, quoteNotice);
							await sendTelegramRichMessage(botToken, groupId, blocks, { rawMarkdown: raw });
						} catch (e) {
							logModelError(e, { command: 'summary', model }, [getApiKey(env), botToken]);
							await bot.reply('概括失败，暂时无法完成请求，请稍后重试。');
						}
					}
				);

				return new Response('ok');
			})
			.on(':message', async (bot) => {
				const msg = bot.update?.message;
				if (!msg || !msg.chat) {
					return new Response('ok');
				}
				if (!isGroupChat(msg.chat)) {
					await bot.reply('我是群聊总结机器人，请将我添加到群组中使用。\n发送 /help 可查看指令说明。');
					return new Response('ok');
				}

				switch (bot.update_type) {
					case "photo": {
						const groupId = msg.chat.id.toString();
						if (!(await isGroupWhitelisted(env, groupId))) {
							return new Response('ok');
						}
						const messageId = msg.message_id;
						const groupName = msg.chat.title || "anonymous";
						const userName = getUserName(msg);

						const MAX_PHOTO_BYTES = 512 * 1024;
						const candidatePhotos = [...(msg.photo || [])].reverse();
						let file: ArrayBuffer | null = null;

						for (const p of candidatePhotos) {
							if (p.file_size && p.file_size > MAX_PHOTO_BYTES) {
								continue;
							}
							try {
								const buf = await bot.getFile(p.file_id).then((response) => response.arrayBuffer());
								if (buf.byteLength <= MAX_PHOTO_BYTES) {
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
						const timeStamp = msg.date ? msg.date * 1000 : Date.now();
						await saveMessage(env, { groupId, messageId, userName, content, groupName, timeStamp });
						return new Response('ok');
					}
					default: {
						const groupId = msg.chat.id.toString();
						if (!(await isGroupWhitelisted(env, groupId))) {
							return new Response('ok');
						}

						const message = msg as any;
						let rawContent = '';

						if (message.document) {
							const doc = message.document;
							const fileName = doc.file_name || '未命名文件';
							const sizeStr = doc.file_size ? ` (${formatBytes(doc.file_size)})` : '';
							const caption = (message.caption || '').trim();
							rawContent = `[文件: ${fileName}${sizeStr}]`;
							if (caption) rawContent = `${rawContent} ${caption}`;
						} else if (message.audio) {
							const audio = message.audio;
							const title = [audio.title, audio.performer].filter(Boolean).join(' - ') || audio.file_name || '未命名音频';
							const sizeStr = audio.file_size ? ` (${formatBytes(audio.file_size)})` : '';
							const caption = (message.caption || '').trim();
							rawContent = `[音频: ${title}${sizeStr}]`;
							if (caption) rawContent = `${rawContent} ${caption}`;
						} else if (message.voice) {
							const voice = message.voice;
							const duration = voice.duration || 0;
							const caption = (message.caption || '').trim();
							const transcribed = await transcribeVoice(env, bot, voice);
							rawContent = transcribed
								? `[语音 ${duration}s]: "${transcribed}"`
								: `[语音: 时长 ${duration} 秒]`;
							if (caption) rawContent = `${rawContent} ${caption}`;
						} else if (message.text) {
							let text = message.text;
							if (text.startsWith('/')) {
								return new Response('ok');
							}
							if (text.startsWith('http') && !text.includes(' ')) {
								text = await extractAllOGInfo(text);
							}
							rawContent = text;
						} else {
							return new Response('ok');
						}

						if (!rawContent) {
							return new Response('ok');
						}

						const content = attachMessageContext(rawContent, msg, groupId);
						const messageId = msg.message_id;
						const groupName = msg.chat.title || 'anonymous';
						const userName = getUserName(msg);
						const timeStamp = msg.date ? msg.date * 1000 : Date.now();
						await saveMessage(env, { groupId, messageId, userName, content, groupName, timeStamp });
						return new Response('ok');
					}
				}
			})
			.handle(botRequest);
		return res || new Response('ok');
	},
};
