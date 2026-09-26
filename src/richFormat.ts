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
// 3. 富文本内联解析与 AST 转换核心
// ==========================================

/**
 * 将内联 Markdown 文本转换为 Telegram 原生 RichText 结构
 */
export function parseInlineRichText(text: string): RichText {
	if (!text) return '';

	// 预先规范化 HTML 常见行内标签
	const preprocessed = text
		.replace(/<b>(.*?)<\/b>/gi, '**$1**')
		.replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
		.replace(/<code>(.*?)<\/code>/gi, '`$1`')
		.replace(/<mark>(.*?)<\/mark>/gi, '==$1==');

	const tokenPattern =
		/(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|==([^=]+)==|(\B\/[a-zA-Z0-9_]+)|\*([^*]+)\*|_([^_]+)_)/g;

	const parts: RichTextPart[] = [];
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = tokenPattern.exec(preprocessed)) !== null) {
		const matchStart = match.index;
		const matchEnd = tokenPattern.lastIndex;

		if (matchStart > lastIndex) {
			parts.push(preprocessed.slice(lastIndex, matchStart));
		}

		if (match[2] && match[3]) {
			// 超链接（关键：群聊原消息跳转链接）
			parts.push({
				type: 'link',
				text: match[2],
				url: match[3],
			});
		} else if (match[4] || match[5]) {
			// 加粗
			const boldContent = match[4] || match[5];
			parts.push({
				type: 'bold',
				text: boldContent,
			});
		} else if (match[6]) {
			// 行内代码
			parts.push({
				type: 'code',
				text: match[6],
			});
		} else if (match[7]) {
			// 高亮标记
			parts.push({
				type: 'marked',
				text: match[7],
			});
		} else if (match[8]) {
			// Bot 指令
			parts.push({
				type: 'bot_command',
				text: match[8],
				bot_command: match[8].slice(1),
			});
		} else if (match[9] || match[10]) {
			// 斜体
			parts.push({
				type: 'italic',
				text: match[9] || match[10],
			});
		}

		lastIndex = matchEnd;
	}

	if (lastIndex < preprocessed.length) {
		parts.push(preprocessed.slice(lastIndex));
	}

	if (parts.length === 0) return preprocessed;
	if (parts.length === 1) return parts[0];
	return parts;
}

/**
 * 递归解析 Markdown 与 HTML Details 为 Telegram RichBlock 数组
 */
export function markdownToRichBlocks(content: string): RichBlock[] {
	const trimmed = content.trim();
	if (!trimmed) return [];

	// 1. 若大模型直接输出了 JSON AST 结构，尝试直接解析
	if (trimmed.startsWith('{') && trimmed.includes('"blocks"')) {
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed.rich_message?.blocks && Array.isArray(parsed.rich_message.blocks)) {
				return parsed.rich_message.blocks;
			}
			if (Array.isArray(parsed.blocks)) {
				return parsed.blocks;
			}
		} catch {
			// 忽略并按普通 Markdown 解析
		}
	}

	const blocks: RichBlock[] = [];

	// 2. 检查并提取 <details><summary>...</summary>...</details>
	const detailsRegex = /<details(?:\s+[^>]*)?>([\s\S]*?)<\/details>/gi;
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = detailsRegex.exec(content)) !== null) {
		const matchStart = match.index;
		const matchEnd = detailsRegex.lastIndex;

		if (matchStart > lastIndex) {
			const textBefore = content.slice(lastIndex, matchStart).trim();
			if (textBefore) {
				blocks.push(...parseStandardMarkdownBlocks(textBefore));
			}
		}

		const insideDetails = match[1];
		let summaryTitle = '详细内容';
		let bodyContent = insideDetails;

		const summaryMatch = insideDetails.match(/<summary>([\s\S]*?)<\/summary>/i);
		if (summaryMatch && summaryMatch.index !== undefined) {
			summaryTitle = summaryMatch[1].replace(/<[^>]+>/g, '').trim();
			bodyContent = insideDetails.slice(summaryMatch.index + summaryMatch[0].length).trim();
		}

		// 递归解析抽屉内部的 blocks（支持嵌套表格、列表等）
		const innerBlocks = markdownToRichBlocks(bodyContent);

		blocks.push({
			type: 'details',
			summary: summaryTitle,
			blocks: innerBlocks.length > 0 ? innerBlocks : [{ type: 'paragraph', text: '无详细内容' }],
		});

		lastIndex = matchEnd;
	}

	if (lastIndex < content.length) {
		const remaining = content.slice(lastIndex).trim();
		if (remaining) {
			blocks.push(...parseStandardMarkdownBlocks(remaining));
		}
	}

	return blocks;
}

/**
 * 解析不含 <details> 的标准 Markdown 块（标题、表格、任务列表、引用、分割线、段落）
 */
function parseStandardMarkdownBlocks(markdown: string): RichBlock[] {
	const blocks: RichBlock[] = [];
	const lines = markdown.split(/\r?\n/);
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();

		// 空行跳过
		if (!trimmed) {
			i++;
			continue;
		}

		// 1. 分割线
		if (/^(?:---|[*]{3,}|_{3,})$/.test(trimmed)) {
			blocks.push({ type: 'divider' });
			i++;
			continue;
		}

		// 2. 标题 (# 到 ######)
		const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
		if (headingMatch) {
			const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
			const text = headingMatch[2].trim();
			blocks.push({
				type: 'heading',
				size: level,
				text: parseInlineRichText(text),
			});
			i++;
			continue;
		}

		// 3. 引用块 (> 开头)
		if (trimmed.startsWith('>')) {
			const quoteLines: string[] = [];
			while (i < lines.length && lines[i].trim().startsWith('>')) {
				quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
				i++;
			}
			const quoteText = quoteLines.join('\n').trim();
			blocks.push({
				type: 'blockquote',
				blocks: [
					{
						type: 'paragraph',
						text: parseInlineRichText(quoteText),
					},
				],
			});
			continue;
		}

		// 4. Markdown 原生表格 (| ... |)
		if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
			const tableLines: string[] = [];
			while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
				tableLines.push(lines[i].trim());
				i++;
			}

			if (tableLines.length >= 2) {
				const headerLine = tableLines[0];
				const separatorLine = tableLines[1];
				const dataLines = tableLines.slice(2);

				const headers = headerLine
					.split('|')
					.slice(1, -1)
					.map((c) => c.trim());

				const alignments: Array<'left' | 'center' | 'right'> = separatorLine
					.split('|')
					.slice(1, -1)
					.map((sep) => {
						const s = sep.trim();
						if (s.startsWith(':') && s.endsWith(':')) return 'center';
						if (s.endsWith(':')) return 'right';
						return 'left';
					});

				const cells: RichTableCell[][] = [];

				// 表头行
				cells.push(
					headers.map((h, colIdx) => ({
						text: parseInlineRichText(h),
						is_header: true,
						align: alignments[colIdx] || 'center',
						valign: 'middle',
					}))
				);

				// 数据行
				for (const dLine of dataLines) {
					const rowCols = dLine
						.split('|')
						.slice(1, -1)
						.map((c) => c.trim());
					cells.push(
						rowCols.map((col, colIdx) => ({
							text: parseInlineRichText(col),
							align: alignments[colIdx] || 'left',
							valign: 'middle',
						}))
					);
				}

				blocks.push({
					type: 'table',
					is_bordered: true,
					is_striped: true,
					cells,
				});
				continue;
			}
		}

		// 5. 任务列表与无序列表 (- [ ] / • / - / 1.)
		const listMatch = trimmed.match(/^([-*•]|\d+\.)\s+(.*)$/);
		if (listMatch) {
			const items: RichListItem[] = [];
			while (i < lines.length) {
				const currTrimmed = lines[i].trim();
				const itemMatch = currTrimmed.match(/^([-*•]|\d+\.)\s+(.*)$/);
				if (!itemMatch) break;

				const rest = itemMatch[2].trim();
				const checkboxMatch = rest.match(/^\[([ xX])\]\s*(.*)$/);

				if (checkboxMatch) {
					const isChecked = checkboxMatch[1].toLowerCase() === 'x';
					const itemText = checkboxMatch[2].trim();
					items.push({
						label: '•',
						has_checkbox: true,
						is_checked: isChecked,
						blocks: [
							{
								type: 'paragraph',
								text: parseInlineRichText(itemText),
							},
						],
					});
				} else {
					items.push({
						label: '•',
						blocks: [
							{
								type: 'paragraph',
								text: parseInlineRichText(rest),
							},
						],
					});
				}
				i++;
			}

			blocks.push({
				type: 'list',
				items,
			});
			continue;
		}

		// 6. 普通段落文本
		const paraLines: string[] = [];
		while (
			i < lines.length &&
			lines[i].trim() &&
			!lines[i].trim().startsWith('#') &&
			!lines[i].trim().startsWith('>') &&
			!lines[i].trim().startsWith('|') &&
			!lines[i].trim().match(/^([-*•]|\d+\.)\s+/) &&
			!/^(?:---|[*]{3,}|_{3,})$/.test(lines[i].trim())
		) {
			paraLines.push(lines[i]);
			i++;
		}

		if (paraLines.length > 0) {
			const paraText = paraLines.join('\n').trim();
			blocks.push({
				type: 'paragraph',
				text: parseInlineRichText(paraText),
			});
		}
	}

	return blocks;
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
 * 将 RichBlock 降级转换回 Markdown 字符串（用于不支持 Rich Message 或 API 报错时的回退）
 */
export function richBlocksToMarkdown(blocks: RichBlock[]): string {
	const out: string[] = [];

	for (const block of blocks) {
		switch (block.type) {
			case 'heading': {
				const prefix = '#'.repeat(block.size || 2);
				out.push(`${prefix} ${richTextToString(block.text)}`);
				break;
			}
			case 'paragraph': {
				out.push(richTextToString(block.text));
				break;
			}
			case 'blockquote': {
				const inner = richBlocksToMarkdown(block.blocks);
				const quoted = inner
					.split('\n')
					.map((l) => `> ${l}`)
					.join('\n');
				out.push(quoted);
				break;
			}
			case 'divider': {
				out.push('---');
				break;
			}
			case 'details': {
				out.push(`**【${block.summary}】**`);
				out.push(richBlocksToMarkdown(block.blocks));
				break;
			}
			case 'table': {
				if (block.cells.length > 0) {
					const headerRow = block.cells[0];
					out.push(`| ${headerRow.map((c) => richTextToString(c.text)).join(' | ')} |`);
					out.push(`| ${headerRow.map(() => '---').join(' | ')} |`);
					for (const row of block.cells.slice(1)) {
						out.push(`| ${row.map((c) => richTextToString(c.text)).join(' | ')} |`);
					}
				}
				break;
			}
			case 'list': {
				for (const item of block.items) {
					const check = item.has_checkbox ? (item.is_checked ? '[x] ' : '[ ] ') : '';
					const inner = richBlocksToMarkdown(item.blocks);
					out.push(`• ${check}${inner}`);
				}
				break;
			}
		}
	}

	return out.join('\n\n');
}

export function richBlocksToMarkdownV2(blocks: RichBlock[]): string {
	const md = richBlocksToMarkdown(blocks);
	return telegramifyMarkdown(md, 'keep');
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
		fallbackMarkdownV2?: string;
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

	// 1. 优先尝试调用 Telegram 原生 sendRichMessage
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

	// 2. 降级方案：转换为 MarkdownV2 / 纯文本使用 sendMessage 发送
	const markdownText = options.fallbackMarkdownV2 || richBlocksToMarkdownV2(blocks);
	const chunks = splitTelegramMessage(markdownText);

	let allOk = true;
	for (const chunk of chunks) {
		try {
			const mdRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chat_id: chatId.toString(),
					text: chunk,
					parse_mode: 'MarkdownV2',
					reply_parameters: options.replyToMessageId ? { message_id: options.replyToMessageId } : undefined,
				}),
			});

			if (!mdRes.ok) {
				const plainText = stripMarkdownV2Escapes(chunk);
				await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						chat_id: chatId.toString(),
						text: plainText,
						reply_parameters: options.replyToMessageId ? { message_id: options.replyToMessageId } : undefined,
					}),
				});
			}
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
