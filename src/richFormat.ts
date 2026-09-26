import telegramifyMarkdown from 'telegramify-markdown';

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

/**
 * 将转义过的 MarkdownV2 文本恢复为无转义的纯文本，作为发送失败时的降级方案
 */
export function stripMarkdownV2Escapes(text: string): string {
	return text
		.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1')
		.replace(/\|\|$/g, '');
}

/**
 * 针对 Telegram 4096 字符单条消息限制，在段落或换行符处安全切分长消息
 */
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

		// 优先在段落边界 \n\n 处切分
		let splitIndex = remaining.lastIndexOf('\n\n', maxLength);
		if (splitIndex === -1 || splitIndex < maxLength * 0.4) {
			// 次选在单换行符 \n 处切分
			splitIndex = remaining.lastIndexOf('\n', maxLength);
		}
		if (splitIndex === -1 || splitIndex < maxLength * 0.4) {
			// 再次选在空格处切分
			splitIndex = remaining.lastIndexOf(' ', maxLength);
		}
		if (splitIndex === -1 || splitIndex < maxLength * 0.2) {
			// 若实在无合适边界，硬截断
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
