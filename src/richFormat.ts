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

export function foldText(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return '';
	const lines = trimmed.split('\n');
	if (lines.length === 1) {
		return `**>${lines[0]}||`;
	}
	const firstLine = `**>${lines[0]}`;
	const restLines = lines.slice(1).map((line) => `>${line}`);
	return `${firstLine}\n${restLines.join('\n')}||`;
}

export function formatSummaryWithHighlights(rawContent: string): string {
	const processed = fixLink(processMarkdownLinks(rawContent));
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
	const processed = fixLink(processMarkdownLinks(rawContent));
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
