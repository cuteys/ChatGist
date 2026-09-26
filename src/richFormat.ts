import telegramifyMarkdown from 'telegramify-markdown';

// ==========================================
// 1. 类型定义：Telegram 原生 Rich Message AST
// ==========================================

export type RichTextInline =
	| { type: 'bold'; text: RichText }
	| { type: 'italic'; text: RichText }
	| { type: 'code'; text: string }
	| { type: 'marked'; text: string }
	| { type: 'url'; text: string | RichText; url: string }
	| { type: 'link'; text: string | RichText; url: string }
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
// 3. 本地富文本聚合引擎与 Markdown 解析器
// ==========================================

export function parseRichInline(text: string): RichText {
	if (!text) return '';

	// 匹配链接、Telegram 消息直达链接、粗体、斜体、行内代码、高亮、指令
	const tokenRegex = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/(?:t\.me\/c|tme\.cat)\/[^\s,，。！!？?)]+|\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|==([^=]+)==|\*([^*]+)\*|_([^_]+)_|(?:\/([a-zA-Z0-9_]{1,64})))/g;

	const parts: RichTextPart[] = [];
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = tokenRegex.exec(text)) !== null) {
		const matchStart = match.index;
		const matchEnd = tokenRegex.lastIndex;

		if (matchStart > lastIndex) {
			parts.push(text.slice(lastIndex, matchStart));
		}

		const fullMatch = match[0];

		if (match[2] && match[3]) {
			const linkText = match[2];
			parts.push({
				type: 'url',
				text: linkText.includes('*') || linkText.includes('_') || linkText.includes('`')
					? parseRichInline(linkText)
					: linkText,
				url: fixLink(match[3]),
			});
		} else if (fullMatch.startsWith('http://') || fullMatch.startsWith('https://')) {
			// 纯链接文本转换为超链接
			parts.push({
				type: 'url',
				text: '💬 原文',
				url: fixLink(fullMatch),
			});
		} else if (match[4] || match[5]) {
			// 粗体
			const boldText = match[4] || match[5];
			parts.push({
				type: 'bold',
				text: boldText.includes('[') || boldText.includes('`')
					? parseRichInline(boldText)
					: boldText,
			});
		} else if (match[6]) {
			// 行内代码
			parts.push({
				type: 'code',
				text: match[6],
			});
		} else if (match[7]) {
			// 重点标记
			parts.push({
				type: 'marked',
				text: match[7],
			});
		} else if (match[8] || match[9]) {
			// 斜体
			parts.push({
				type: 'italic',
				text: match[8] || match[9],
			});
		} else if (match[10]) {
			// Bot Command
			parts.push({
				type: 'bot_command',
				text: `/${match[10]}`,
				bot_command: match[10],
			});
		} else {
			parts.push(fullMatch);
		}

		lastIndex = matchEnd;
	}

	if (lastIndex < text.length) {
		parts.push(text.slice(lastIndex));
	}

	if (parts.length === 0) return '';
	if (parts.length === 1) return parts[0];
	return parts;
}

export function parseMarkdownSectionBlocks(content: string): RichBlock[] {
	const trimmed = (content || '').trim();
	if (!trimmed) return [];

	const lines = trimmed.split(/\r?\n/);
	const blocks: RichBlock[] = [];

	let i = 0;
	while (i < lines.length) {
		const rawLine = lines[i];
		const line = rawLine.trim();

		if (!line) {
			i++;
			continue;
		}

		// 1. 标题 (Heading)
		const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
		if (headingMatch) {
			const size = Math.min(Math.max(headingMatch[1].length, 1), 6) as 1 | 2 | 3 | 4 | 5 | 6;
			blocks.push({
				type: 'heading',
				size,
				text: parseRichInline(headingMatch[2].trim()),
			});
			i++;
			continue;
		}

		// 2. 分割线 (Divider)
		if (/^[-*_]{3,}$/.test(line)) {
			blocks.push({ type: 'divider' });
			i++;
			continue;
		}

		// 3. 引用块 (Blockquote)
		if (line.startsWith('>')) {
			const quoteLines: string[] = [];
			while (
				i < lines.length &&
				(lines[i].trim().startsWith('>') ||
					(lines[i].trim() &&
						quoteLines.length > 0 &&
						!lines[i].trim().startsWith('#') &&
						!lines[i].trim().startsWith('|')))
			) {
				const ql = lines[i].trim();
				if (ql.startsWith('>')) {
					quoteLines.push(ql.replace(/^>\s?/, ''));
				} else {
					quoteLines.push(ql);
				}
				i++;
			}
			const quoteText = quoteLines.join('\n').trim();
			if (quoteText) {
				blocks.push({
					type: 'blockquote',
					blocks: [
						{
							type: 'paragraph',
							text: parseRichInline(quoteText),
						},
					],
				});
			}
			continue;
		}

		// 4. 表格 (Markdown Pipe Table)
		if (line.startsWith('|') && line.includes('|', 1)) {
			const tableLines: string[] = [];
			while (i < lines.length && lines[i].trim().startsWith('|')) {
				tableLines.push(lines[i].trim());
				i++;
			}

			if (tableLines.length >= 2) {
				const parseRow = (rowStr: string): string[] => {
					return rowStr
						.replace(/^\|/, '')
						.replace(/\|$/, '')
						.split('|')
						.map((c) => c.trim());
				};

				const headerCells = parseRow(tableLines[0]);
				let alignRowIdx = 1;
				let aligns: Array<'left' | 'center' | 'right'> = [];

				if (/^\|?\s*:?-+:?\s*(\||\s*$)/.test(tableLines[1])) {
					aligns = parseRow(tableLines[1]).map((c) => {
						const hasLeft = c.startsWith(':');
						const hasRight = c.endsWith(':');
						if (hasLeft && hasRight) return 'center';
						if (hasRight) return 'right';
						return 'left';
					});
					alignRowIdx = 2;
				}

				const cells: RichTableCell[][] = [];
				cells.push(
					headerCells.map((h, colIdx) => ({
						text: parseRichInline(h),
						is_header: true,
						align: aligns[colIdx] || 'center',
						valign: 'middle',
					}))
				);

				for (let r = alignRowIdx; r < tableLines.length; r++) {
					const rowCols = parseRow(tableLines[r]);
					if (rowCols.length === 0 || (rowCols.length === 1 && !rowCols[0])) continue;
					cells.push(
						rowCols.map((col, colIdx) => ({
							text: parseRichInline(col),
							align: aligns[colIdx] || 'left',
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

		// 5. 待办事项与列表 (Checklist & List)
		const isListLine = (l: string) => /^[-*•]\s+(\[[ xX]\]\s+)?/.test(l) || /^\d+\.\s+/.test(l);
		if (isListLine(line)) {
			const items: RichListItem[] = [];
			while (i < lines.length && isListLine(lines[i].trim())) {
				const l = lines[i].trim();
				const checkMatch = l.match(/^[-*•]\s+\[([ xX])\]\s+(.+)$/);
				if (checkMatch) {
					const isChecked = checkMatch[1].toLowerCase() === 'x';
					items.push({
						label: '•',
						has_checkbox: true,
						is_checked: isChecked,
						blocks: [
							{
								type: 'paragraph',
								text: parseRichInline(checkMatch[2].trim()),
							},
						],
					});
				} else {
					const itemText = l.replace(/^[-*•]\s+/, '').replace(/^\d+\.\s+/, '').trim();
					items.push({
						label: '•',
						blocks: [
							{
								type: 'paragraph',
								text: parseRichInline(itemText),
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

		// 6. 普通段落 (Paragraph)
		const paraLines: string[] = [];
		while (
			i < lines.length &&
			lines[i].trim() &&
			!lines[i].trim().match(/^#{1,6}\s+/) &&
			!/^[-*_]{3,}$/.test(lines[i].trim()) &&
			!lines[i].trim().startsWith('>') &&
			!lines[i].trim().startsWith('|') &&
			!isListLine(lines[i].trim())
		) {
			paraLines.push(lines[i].trim());
			i++;
		}

		if (paraLines.length > 0) {
			const joined = paraLines.join('\n');
			blocks.push({
				type: 'paragraph',
				text: parseRichInline(joined),
			});
		}
	}

	return blocks;
}

/**
 * 本地聚合器：将大模型生成的结构化 Markdown 转换为 Telegram 原生 AST
 * 兼容 <details><summary> 与标准 ## / ### 章节折叠
 */
export function aggregateMarkdownToRichBlocks(content: string): RichBlock[] {
	let raw = (content || '').trim();

	if (raw.startsWith('```')) {
		raw = raw.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/i, '').trim();
	}

	raw = fixLink(processMarkdownLinks(removeThematicBreaks(raw)));
	raw = raw.replace(/^#\s+(?:📊\s*)?群聊动态深度总结[^\r\n]*\r?\n+/i, '').trim();

	// 1. 若包含显式 <details><summary> 标签
	const detailsRegex = /<details>[\s\S]*?<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi;
	if (/<details[\s>]/i.test(raw) && /<\/details>/i.test(raw)) {
		const blocks: RichBlock[] = [];
		let lastIndex = 0;
		let match: RegExpExecArray | null;

		while ((match = detailsRegex.exec(raw)) !== null) {
			const before = raw.slice(lastIndex, match.index).trim();
			if (before) {
				blocks.push(...parseMarkdownSectionBlocks(before));
			}

			const summary = match[1].replace(/<[^>]+>/g, '').trim();
			const innerContent = match[2].trim();
			const innerBlocks = parseMarkdownSectionBlocks(innerContent);

			blocks.push({
				type: 'details',
				summary: summary || '详细内容',
				blocks: innerBlocks.length > 0 ? innerBlocks : [{ type: 'paragraph', text: '（无详细内容）' }],
			});

			lastIndex = detailsRegex.lastIndex;
		}

		const after = raw.slice(lastIndex).trim();
		if (after) {
			blocks.push(...parseMarkdownSectionBlocks(after));
		}

		return blocks;
	}

	// 2. 若未包含 <details> 标签，但包含 ## 或 ### 分段
	const sectionHeadingRegex = /^(#{2,3})\s+(.+)$/gm;
	const headingMatches: Array<{ index: number; title: string; length: number }> = [];
	let hMatch: RegExpExecArray | null;

	while ((hMatch = sectionHeadingRegex.exec(raw)) !== null) {
		headingMatches.push({
			index: hMatch.index,
			title: hMatch[2].trim(),
			length: hMatch[0].length,
		});
	}

	if (headingMatches.length > 0) {
		const blocks: RichBlock[] = [];
		const preamble = raw.slice(0, headingMatches[0].index).trim();
		if (preamble) {
			blocks.push(...parseMarkdownSectionBlocks(preamble));
		}

		for (let s = 0; s < headingMatches.length; s++) {
			const current = headingMatches[s];
			const startPos = current.index + current.length;
			const endPos = s + 1 < headingMatches.length ? headingMatches[s + 1].index : raw.length;
			const sectionBody = raw.slice(startPos, endPos).trim();

			const innerBlocks = parseMarkdownSectionBlocks(sectionBody);
			blocks.push({
				type: 'details',
				summary: current.title,
				blocks: innerBlocks.length > 0 ? innerBlocks : [{ type: 'paragraph', text: '（暂无更多详情）' }],
			});
		}

		return blocks;
	}

	// 3. 普通纯文本回退
	return parseMarkdownSectionBlocks(raw);
}

/**
 * 解析模型输出：优先解析 JSON AST，否则使用 Markdown 聚合转换为 RichBlock 列表
 */
export function parseRichMessageResponse(raw: string): { blocks: RichBlock[] } {
	let clean = (raw || '').trim();

	if (clean.startsWith('```')) {
		clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
	}

	if (clean.startsWith('{') || clean.startsWith('[')) {
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
		} catch {
			// 不是合法 JSON，继续交由本地 Markdown 聚合器处理
		}
	}

	const blocks = aggregateMarkdownToRichBlocks(clean);
	return {
		blocks: blocks.length > 0 ? blocks : [{ type: 'paragraph', text: clean || '（无概括内容）' }],
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

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export function richTextToHtml(text: RichText): string {
	if (typeof text === 'string') return escapeHtml(text);
	if (Array.isArray(text)) {
		return text.map(richTextToHtml).join('');
	}
	if (typeof text === 'object' && text !== null) {
		switch (text.type) {
			case 'bold':
				return `<b>${richTextToHtml(text.text)}</b>`;
			case 'italic':
				return `<i>${richTextToHtml(text.text)}</i>`;
			case 'code':
				return `<code>${escapeHtml(text.text)}</code>`;
			case 'marked':
				return `<b>[${escapeHtml(text.text)}]</b>`;
			case 'url':
			case 'link':
				return `<a href="${escapeHtml(text.url)}">${typeof text.text === 'string' ? escapeHtml(text.text) : richTextToHtml(text.text)}</a>`;
			case 'bot_command':
				return `<code>${escapeHtml(text.text)}</code>`;
		}
	}
	return '';
}

/**
 * 将 RichBlock 降级为符合 Telegram 标准规范的 HTML（原生支持 <blockquote expandable> 折叠抽屉）
 */
export function richBlocksToHtml(blocks: RichBlock[]): string {
	const parts: string[] = [];

	for (const block of blocks) {
		switch (block.type) {
			case 'blockquote':
				parts.push(`<blockquote>${richBlocksToHtml(block.blocks)}</blockquote>`);
				break;
			case 'heading':
				parts.push(`\n<b>📌 ${richTextToHtml(block.text)}</b>\n`);
				break;
			case 'paragraph':
				parts.push(richTextToHtml(block.text));
				break;
			case 'divider':
				parts.push('\n━━━━━━━━━━━━━━━━━━━━\n');
				break;
			case 'details':
				parts.push(
					`\n<blockquote expandable><b>🔽 【${escapeHtml(block.summary)}】</b>\n${richBlocksToHtml(block.blocks)}</blockquote>\n`
				);
				break;
			case 'table':
				if (block.cells.length > 0) {
					const tableLines = block.cells.map((row) =>
						row
							.map((cell) =>
								cell.is_header ? `<b>${richTextToHtml(cell.text)}</b>` : richTextToHtml(cell.text)
							)
							.join(' | ')
					);
					parts.push(tableLines.join('\n'));
				}
				break;
			case 'list':
				for (const item of block.items) {
					const mark = item.has_checkbox ? (item.is_checked ? '☑️ ' : '🔲 ') : '• ';
					parts.push(`${mark}${richBlocksToHtml(item.blocks)}`);
				}
				break;
		}
	}

	return parts.join('\n\n').trim();
}

/**
 * 将 RichBlock 降级为干净易读的纯文本
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
		rawMarkdown?: string;
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

	// 1. sendRichMessage (blocks AST 模式)
	try {
		const res = await fetch(`https://api.telegram.org/bot${token}/sendRichMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});

		if (res.ok) {
			return { ok: true, status: res.status };
		}

		const errBody = await res.text();
		console.warn(`sendRichMessage (blocks) failed (${res.status}): ${errBody}`);
	} catch (e) {
		console.warn('sendRichMessage (blocks) network exception:', e);
	}

	// 2. sendRichMessage (markdown 模式)
	if (options.rawMarkdown) {
		try {
			const mdRes = await fetch(`https://api.telegram.org/bot${token}/sendRichMessage`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chat_id: chatId.toString(),
					rich_message: {
						markdown: options.rawMarkdown,
					},
					reply_parameters: options.replyToMessageId ? { message_id: options.replyToMessageId } : undefined,
				}),
			});

			if (mdRes.ok) {
				return { ok: true, status: mdRes.status };
			}

			const mdErr = await mdRes.text();
			console.warn(`sendRichMessage (markdown) failed (${mdRes.status}): ${mdErr}`);
		} catch (e) {
			console.warn('sendRichMessage (markdown) network exception:', e);
		}
	}

	// 3. HTML 模式降级 (<blockquote expandable>)
	try {
		const htmlText = richBlocksToHtml(blocks);
		const chunks = splitTelegramMessage(htmlText);
		let htmlOk = true;

		for (const chunk of chunks) {
			const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chat_id: chatId.toString(),
					text: chunk,
					parse_mode: 'HTML',
					reply_parameters: options.replyToMessageId ? { message_id: options.replyToMessageId } : undefined,
				}),
			});
			if (!res.ok) {
				htmlOk = false;
				console.warn(`sendMessage HTML failed (${res.status}): ${await res.text()}`);
				break;
			}
		}

		if (htmlOk) {
			return { ok: true };
		}
	} catch (err) {
		console.warn('sendMessage HTML exception, falling back to plain text:', err);
	}

	// 4. 纯文本兜底
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
 * 构建关键词检索结果原生富文本表格（将原消息链接直接内嵌于消息内容中）
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
			{ text: '👤 发言人', is_header: true, align: 'left', valign: 'middle' },
			{ text: '💬 消息内容（点击直达原文）', is_header: true, align: 'left', valign: 'middle' },
		],
	];

	displayList.forEach((r, idx) => {
		const rawContent = r.content || '';
		const preview = rawContent.length > 50 ? rawContent.slice(0, 50) + '...' : rawContent;
		const link = r.messageId ? getMessageLink(r) : '';

		tableRows.push([
			{ text: `${idx + 1}`, align: 'center', valign: 'middle' },
			{ text: { type: 'bold', text: r.userName || '匿名' }, align: 'left', valign: 'middle' },
			{
				text: link
					? [{ type: 'url', text: preview || '查看原文', url: link }]
					: preview || '-',
				align: 'left',
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
						'🔍 检索关键词：【',
						{ type: 'bold', text: keyword },
						`】 · 匹配消息数：${totalCount} 条`,
					],
				},
			],
		},
		{
			type: 'heading',
			size: 2,
			text: `📋 历史消息检索结果`,
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
			text: `ℹ️ 结果较多，当前展示最近 ${maxDisplay} 条记录。点击表格中的消息内容可直接定位原消息。`,
		});
	} else {
		blocks.push({
			type: 'paragraph',
			text: '💡 点击表格中的消息内容可直接在群聊中跳转至具体消息位置。',
		});
	}

	return blocks;
}
