import telegramifyMarkdown from 'telegramify-markdown';

// ==========================================
// 1. 类型定义：Telegram 原生 Rich Message AST
// ==========================================

export type RichTextInline =
	| { type: 'bold'; text: RichText }
	| { type: 'italic'; text: RichText }
	| { type: 'code'; text: string }
	| { type: 'marked'; text: string }
	| { type: 'link'; text: string; url: string }
	| { type: 'bot_command'; text: string; bot_command?: string };

export type RichTextPart = string | RichTextInline;
export type RichText = string | RichTextInline | RichTextPart[];

export interface RichTableCell {
	text: RichText;
	is_header?: boolean;
	align?: 'left' | 'center' | 'right';
	valign?: 'top' | 'middle' | 'bottom';
}

export interface RichListItem {
	label?: string;
	has_checkbox?: boolean;
	is_checked?: boolean;
	blocks: RichBlock[];
}

export interface RichBlockParagraph {
	type: 'paragraph';
	text: RichText;
}

export interface RichBlockHeading {
	type: 'heading';
	text: RichText;
	size?: 1 | 2 | 3 | 4 | 5 | 6;
}

export interface RichBlockQuote {
	type: 'blockquote';
	blocks: RichBlock[];
}

export interface RichBlockDivider {
	type: 'divider';
}

export interface RichBlockDetails {
	type: 'details';
	summary: string;
	blocks: RichBlock[];
}

export interface RichBlockTable {
	type: 'table';
	is_bordered?: boolean;
	is_striped?: boolean;
	cells: RichTableCell[][];
}

export interface RichBlockList {
	type: 'list';
	items: RichListItem[];
}

export type RichBlock =
	| RichBlockParagraph
	| RichBlockHeading
	| RichBlockQuote
	| RichBlockDivider
	| RichBlockDetails
	| RichBlockTable
	| RichBlockList;

export interface InputRichMessage {
	blocks: RichBlock[];
}

// ==========================================
// 2. 消息溯源与链接辅助函数
// ==========================================

export function getMessageLink(r: { groupId: string; messageId: number }): string {
	const cleanGroupId = r.groupId.replace(/^-100/, '').replace(/^-/, '');
	return `https://t.me/c/${cleanGroupId}/${r.messageId}`;
}

export function toSuperscript(num: number): string {
	const superscripts: Record<string, string> = {
		'0': '⁰',
		'1': '¹',
		'2': '²',
		'3': '³',
		'4': '⁴',
		'5': '⁵',
		'6': '⁶',
		'7': '⁷',
		'8': '⁸',
		'9': '⁹',
	};

	return num
		.toString()
		.split('')
		.map((digit) => superscripts[digit] || digit)
		.join('');
}

export function processMarkdownLinks(
	text: string,
	options: { prefix?: string; useEnglish?: boolean } = {}
): string {
	const { prefix = '引用', useEnglish = false } = options;

	const linkMap = new Map<string, number>();
	let linkCounter = 1;

	const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;

	return text.replace(linkPattern, (match, displayText, url) => {
		if (displayText !== url) {
			return match;
		}

		if (!linkMap.has(url)) {
			linkMap.set(url, linkCounter++);
		}
		const linkNumber = linkMap.get(url)!;
		const linkPrefix = useEnglish ? 'link' : prefix;

		return `[${linkPrefix}${toSuperscript(linkNumber)}](${url})`;
	});
}

export function fixLink(text: string): string {
	return text.replace(/tme\.cat/g, 't.me/c').replace(/\/c\/c/g, '/c');
}

export function removeThematicBreaks(text: string): string {
	return text.replace(/^[ \t]*([*\-_])(?:[ \t]*\1){2,}[ \t]*$/gm, '');
}

export function foldText(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return '';
	const lines = trimmed.split('\n');
	const quotedLines = lines.map((line) => {
		const trimmedLine = line.trim();
		if (!trimmedLine) {
			return '>';
		}
		return trimmedLine.startsWith('>') ? trimmedLine : `>${line}`;
	});
	return `${quotedLines.join('\n')}||`;
}

export function formatSummaryWithHighlights(rawContent: string): string {
	const cleaned = removeThematicBreaks(rawContent);
	const processed = fixLink(processMarkdownLinks(cleaned));
	const normalized = normalizeSpacing(processed);

	const match = normalized.match(/\n+(?=【💬|##\s*详细|【详细|详细讨论与消息溯源|详细讨论)/i);
	if (match && match.index !== undefined) {
		const highlightsPart = normalized.slice(0, match.index).trim();
		const detailsPart = normalized.slice(match.index).trim();

		const highlightsV2 = normalizeSpacing(telegramifyMarkdown(highlightsPart, 'keep'));
		const detailsV2 = normalizeSpacing(telegramifyMarkdown(detailsPart, 'keep'));

		const foldedDetails = foldText(detailsV2);
		return `${highlightsV2}\n\n${foldedDetails}`;
	}

	const allV2 = normalizeSpacing(telegramifyMarkdown(normalized, 'keep'));
	return foldText(allV2);
}

export function formatAnswerMessage(rawContent: string): string {
	const cleaned = removeThematicBreaks(rawContent);
	const processed = fixLink(processMarkdownLinks(cleaned));
	const normalized = normalizeSpacing(processed);
	const convertedV2 = normalizeSpacing(telegramifyMarkdown(normalized, 'keep'));
	return foldText(convertedV2);
}

export function normalizeSpacing(text: string): string {
	return text
		.replace(/\r\n/g, '\n')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export function stripMarkdownV2Escapes(text: string): string {
	return text
		.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1')
		.replace(/\|\|$/g, '');
}

export function splitTelegramMessage(text: string, maxLength = 4000): string[] {
	if (text.length <= maxLength) {
		return [text];
	}

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}

		let splitIndex = remaining.lastIndexOf('\n\n', maxLength);
		if (splitIndex === -1 || splitIndex < maxLength * 0.4) {
			splitIndex = remaining.lastIndexOf('\n', maxLength);
		}
		if (splitIndex === -1 || splitIndex < maxLength * 0.4) {
			splitIndex = remaining.lastIndexOf(' ', maxLength);
		}
		if (splitIndex === -1 || splitIndex < maxLength * 0.2) {
			splitIndex = maxLength;
		}

		chunks.push(remaining.slice(0, splitIndex).trim());
		remaining = remaining.slice(splitIndex).trim();
	}

	return chunks.filter(Boolean);
}

export async function deleteTelegramMessage(
	token: string,
	chatId: string | number,
	messageId: number
): Promise<boolean> {
	try {
		const res = await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId.toString(),
				message_id: messageId,
			}),
		});
		return res.ok;
	} catch {
		return false;
	}
}

// ==========================================
// 3. AI 直接生成 JSON 的解析器
// ==========================================

/**
 * 直接解析大模型输出的 Rich Message JSON
 */
export function parseRichMessageResponse(raw: string): { blocks: RichBlock[] } {
	let clean = (raw || '').trim();

	// 剥离可能存在的 markdown json 代码块包裹 (```json ... ```)
	if (clean.startsWith('```')) {
		clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
	}

	try {
		const parsed = JSON.parse(clean);
		if (parsed.rich_message && Array.isArray(parsed.rich_message.blocks)) {
			return parsed.rich_message;
		}
		if (Array.isArray(parsed.blocks)) {
			return { blocks: parsed.blocks };
		}
		if (Array.isArray(parsed)) {
			return { blocks: parsed };
		}
	} catch (e) {
		console.warn('parseRichMessageResponse: AI output is not valid JSON, using fallback block', e);
	}

	// 容错降级：若模型未按 JSON 输出，则转为单个段落（绝不胡乱添加 > 引用破坏）
	return {
		blocks: [
			{
				type: 'paragraph',
				text: clean || '（无概括内容）',
			},
		],
	};
}

/**
 * 兼容旧版的 markdownToRichBlocks
 */
export function markdownToRichBlocks(content: string): RichBlock[] {
	return parseRichMessageResponse(content).blocks;
}

/**
 * 将 RichText 转换为纯文本字符串
 */
export function richTextToString(text: RichText): string {
	if (typeof text === 'string') return text;
	if (Array.isArray(text)) {
		return text.map(richTextToString).join('');
	}
	if (typeof text === 'object' && text !== null) {
		if ('text' in text) {
			return richTextToString((text as any).text);
		}
	}
	return '';
}

/**
 * 将 RichBlock 降级为干净易读的文本（绝不添加 > 破坏 HTML）
 */
export function richBlocksToPlainText(blocks: RichBlock[]): string {
	const lines: string[] = [];

	for (const block of blocks) {
		switch (block.type) {
			case 'blockquote': {
				lines.push(`【概览】${richBlocksToPlainText(block.blocks)}`);
				break;
			}
			case 'heading': {
				lines.push(`\n📌 ${richTextToString(block.text)}\n`);
				break;
			}
			case 'paragraph': {
				lines.push(richTextToString(block.text));
				break;
			}
			case 'divider': {
				lines.push('------------------------');
				break;
			}
			case 'details': {
				lines.push(`\n🔽 【${block.summary}】`);
				lines.push(richBlocksToPlainText(block.blocks));
				break;
			}
			case 'table': {
				if (block.cells.length > 0) {
					for (const row of block.cells) {
						lines.push(row.map((c) => richTextToString(c.text)).join(' | '));
					}
				}
				break;
			}
			case 'list': {
				for (const item of block.items) {
					const mark = item.has_checkbox ? (item.is_checked ? '[✓] ' : '[ ] ') : '• ';
					lines.push(`${mark}${richBlocksToPlainText(item.blocks)}`);
				}
				break;
			}
		}
	}

	return lines.join('\n\n').trim();
}

export function richBlocksToMarkdown(blocks: RichBlock[]): string {
	return richBlocksToPlainText(blocks);
}

export function richBlocksToMarkdownV2(blocks: RichBlock[]): string {
	return richBlocksToPlainText(blocks);
}

// ==========================================
// 4. API 发送器：sendTelegramRichMessage
// ==========================================

export async function sendTelegramRichMessage(
	token: string,
	chatId: string | number,
	blocks: RichBlock[],
	options: {
		replyToMessageId?: number;
		fallbackText?: string;
	} = {}
): Promise<{ ok: boolean; status?: number; error?: string }> {
	if (!token) {
		console.warn('sendTelegramRichMessage: TELEGRAM_BOT_TOKEN is not set.');
		return { ok: false, error: 'No token' };
	}

	const payload: any = {
		chat_id: chatId.toString(),
		rich_message: {
			blocks,
		},
	};

	if (options.replyToMessageId) {
		payload.reply_parameters = {
			message_id: options.replyToMessageId,
		};
	}

	// 1. 优先调用 Telegram 原生 sendRichMessage
	try {
		const res = await fetch(`https://api.telegram.org/bot${token}/sendRichMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});

		if (res.ok) {
			return { ok: true, status: res.status };
		}

		console.warn(`sendRichMessage failed (${res.status}): ${await res.text()}, attempting fallback to sendMessage`);
	} catch (e) {
		console.warn('sendRichMessage network exception, falling back to sendMessage:', e);
	}

	// 2. 降级方案：转换为普通干净文本通过 sendMessage 发送（严禁加 > 破坏格式）
	const text = options.fallbackText || richBlocksToPlainText(blocks);
	const chunks = splitTelegramMessage(text);

	let allOk = true;
	for (const chunk of chunks) {
		try {
			const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chat_id: chatId.toString(),
					text: chunk,
					reply_parameters: options.replyToMessageId ? { message_id: options.replyToMessageId } : undefined,
				}),
			});
			if (!res.ok) allOk = false;
		} catch (err) {
			allOk = false;
			console.error('Fallback sendMessage failed:', err);
		}
	}

	return { ok: allOk };
}

// ==========================================
// 5. 业务表格生成器（白名单、管理员、检索）
// ==========================================

/**
 * 构建白名单群组原生富文本表格
 */
export function buildWhitelistRichBlocks(
	groups: Array<{ groupId: string; groupName: string; addedBy?: string; createdAt: number }>
): RichBlock[] {
	if (groups.length === 0) {
		return [
			{
				type: 'heading',
				size: 2,
				text: '📋 白名单群组列表',
			},
			{
				type: 'paragraph',
				text: '当前暂无已授权群组。超级管理员可在目标群内直接发送 /addgroup 将其加入白名单。',
			},
		];
	}

	const headerRow: RichTableCell[] = [
		{ text: '#', is_header: true, align: 'center', valign: 'middle' },
		{ text: '群组名称', is_header: true, align: 'left', valign: 'middle' },
		{ text: '群组 ID', is_header: true, align: 'center', valign: 'middle' },
		{ text: '授权人', is_header: true, align: 'center', valign: 'middle' },
		{ text: '添加时间', is_header: true, align: 'center', valign: 'middle' },
	];

	const rows: RichTableCell[][] = [headerRow];

	groups.forEach((g, idx) => {
		const timeStr = new Date(g.createdAt).toLocaleString('zh-CN', {
			timeZone: 'Asia/Shanghai',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
		});
		rows.push([
			{ text: `${idx + 1}`, align: 'center', valign: 'middle' },
			{ text: { type: 'bold', text: g.groupName || '未命名群组' }, align: 'left', valign: 'middle' },
			{ text: { type: 'code', text: g.groupId }, align: 'center', valign: 'middle' },
			{ text: g.addedBy || '未知', align: 'center', valign: 'middle' },
			{ text: timeStr, align: 'center', valign: 'middle' },
		]);
	});

	return [
		{
			type: 'heading',
			size: 2,
			text: `📋 已授权白名单群组（共 ${groups.length} 个）`,
		},
		{
			type: 'table',
			is_bordered: true,
			is_striped: true,
			cells: rows,
		},
		{
			type: 'divider',
		},
		{
			type: 'paragraph',
			text: [
				'💡 提示：在群内发送 ',
				{ type: 'bot_command', text: '/delgroup', bot_command: 'delgroup' },
				' 可移出白名单；发送 ',
				{ type: 'bot_command', text: '/addgroup', bot_command: 'addgroup' },
				' 授权当前群。',
			],
		},
	];
}

/**
 * 构建系统管理员原生富文本表格
 */
export function buildAdminsRichBlocks(
	envAdmins: string[],
	dbAdmins: Array<{ userId: string; userName: string; addedBy?: string; createdAt: number }>
): RichBlock[] {
	const blocks: RichBlock[] = [
		{
			type: 'heading',
			size: 2,
			text: '👑 系统管理员与权限列表',
		},
		{
			type: 'blockquote',
			blocks: [
				{
					type: 'paragraph',
					text: '超级管理员享有最高管理权限；所有管理员均享有指令无限次【免流特权】。',
				},
			],
		},
		{
			type: 'heading',
			size: 3,
			text: '1. 环境变量超级管理员',
		},
	];

	if (envAdmins.length === 0) {
		blocks.push({
			type: 'paragraph',
			text: '• 未配置（可通过环境变量 ADMIN_USER_IDS 设置）',
		});
	} else {
		const envCells: RichTableCell[][] = [
			[
				{ text: '#', is_header: true, align: 'center', valign: 'middle' },
				{ text: '用户 ID', is_header: true, align: 'center', valign: 'middle' },
				{ text: '权限级别', is_header: true, align: 'center', valign: 'middle' },
			],
		];
		envAdmins.forEach((id, idx) => {
			envCells.push([
				{ text: `${idx + 1}`, align: 'center', valign: 'middle' },
				{ text: { type: 'code', text: id }, align: 'center', valign: 'middle' },
				{ text: { type: 'marked', text: '超级管理员 (SuperAdmin)' }, align: 'center', valign: 'middle' },
			]);
		});
		blocks.push({
			type: 'table',
			is_bordered: true,
			is_striped: true,
			cells: envCells,
		});
	}

	blocks.push({
		type: 'heading',
		size: 3,
		text: `2. 数据库授权管理员（共 ${dbAdmins.length} 位）`,
	});

	if (dbAdmins.length === 0) {
		blocks.push({
			type: 'paragraph',
			text: '• 暂无动态授权的数据库管理员（超级管理员可通过 /addadmin 添加）',
		});
	} else {
		const dbCells: RichTableCell[][] = [
			[
				{ text: '#', is_header: true, align: 'center', valign: 'middle' },
				{ text: '管理员名称', is_header: true, align: 'left', valign: 'middle' },
				{ text: '用户 ID', is_header: true, align: 'center', valign: 'middle' },
				{ text: '授权人', is_header: true, align: 'center', valign: 'middle' },
				{ text: '授权时间', is_header: true, align: 'center', valign: 'middle' },
			],
		];
		dbAdmins.forEach((adm, idx) => {
			const timeStr = new Date(adm.createdAt).toLocaleString('zh-CN', {
				timeZone: 'Asia/Shanghai',
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
			});
			dbCells.push([
				{ text: `${idx + 1}`, align: 'center', valign: 'middle' },
				{ text: { type: 'bold', text: adm.userName || '管理员' }, align: 'left', valign: 'middle' },
				{ text: { type: 'code', text: adm.userId }, align: 'center', valign: 'middle' },
				{ text: adm.addedBy || '系统', align: 'center', valign: 'middle' },
				{ text: timeStr, align: 'center', valign: 'middle' },
			]);
		});
		blocks.push({
			type: 'table',
			is_bordered: true,
			is_striped: true,
			cells: dbCells,
		});
	}

	blocks.push(
		{ type: 'divider' },
		{
			type: 'paragraph',
			text: [
				'💡 提示：添加管理员命令为 ',
				{ type: 'bot_command', text: '/addadmin', bot_command: 'addadmin' },
				' <用户ID> [备注]；移除命令为 ',
				{ type: 'bot_command', text: '/deladmin', bot_command: 'deladmin' },
				' <用户ID>。',
			],
		}
	);

	return blocks;
}

/**
 * 构建关键词检索结果原生富文本表格（包含原消息精准跳转定位）
 */
export function buildQueryRichBlocks(
	keyword: string,
	totalCount: number,
	results: any[],
	maxDisplay = 15
): RichBlock[] {
	const displayList = results.slice(0, maxDisplay);

	const tableRows: RichTableCell[][] = [
		[
			{ text: '#', is_header: true, align: 'center', valign: 'middle' },
			{ text: '发言人', is_header: true, align: 'left', valign: 'middle' },
			{ text: '消息内容摘要', is_header: true, align: 'left', valign: 'middle' },
			{ text: '原文定位', is_header: true, align: 'center', valign: 'middle' },
		],
	];

	displayList.forEach((r, idx) => {
		const rawContent = r.content || '';
		const preview = rawContent.length > 50 ? rawContent.slice(0, 50) + '...' : rawContent;
		const link = r.messageId ? getMessageLink(r) : '';

		tableRows.push([
			{ text: `${idx + 1}`, align: 'center', valign: 'middle' },
			{ text: { type: 'bold', text: r.userName || '匿名' }, align: 'left', valign: 'middle' },
			{ text: preview, align: 'left', valign: 'middle' },
			{
				text: link
					? [{ type: 'link', text: '🔗 查看原文', url: link }]
					: '-',
				align: 'center',
				valign: 'middle',
			},
		]);
	});

	const blocks: RichBlock[] = [
		{
			type: 'blockquote',
			blocks: [
				{
					type: 'paragraph',
					text: [
						'检索关键词：【',
						{ type: 'bold', text: keyword },
						`】 · 匹配消息数：${totalCount} 条`,
					],
				},
			],
		},
		{
			type: 'heading',
			size: 2,
			text: `🔍 历史消息检索结果`,
		},
		{
			type: 'table',
			is_bordered: true,
			is_striped: true,
			cells: tableRows,
		},
	];

	if (totalCount > maxDisplay) {
		blocks.push({
			type: 'paragraph',
			text: `ℹ️ 结果较多，当前展示最近 ${maxDisplay} 条记录。点击表格中的「🔗 查看原文」可直接定位并高亮该条群聊发言。`,
		});
	} else {
		blocks.push({
			type: 'paragraph',
			text: '💡 点击表格右侧的「🔗 查看原文」可直接在群聊中跳转至具体消息位置。',
		});
	}

	return blocks;
}
