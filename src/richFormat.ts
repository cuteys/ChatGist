import telegramifyMarkdown from 'telegramify-markdown';

/**
 * 计算字符串的视觉宽度（中文/全角字符占 2 宽，ASCII 字符占 1 宽）
 */
export function getVisualWidth(str: string): number {
	let width = 0;
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		// 常见全角及中文字符区间
		if (
			(code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意文字
			(code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
			(code >= 0xff01 && code <= 0xff60) || // 全角 ASCII / 标点
			(code >= 0x3000 && code <= 0x303f) || // CJK 符号和标点
			(code >= 0x20000 && code <= 0x2a6df)
		) {
			width += 2;
		} else {
			width += 1;
		}
	}
	return width;
}

/**
 * 视觉对齐填充
 */
export function padEndVisual(str: string, targetWidth: number): string {
	const currentWidth = getVisualWidth(str);
	if (currentWidth >= targetWidth) return str;
	return str + ' '.repeat(targetWidth - currentWidth);
}

/**
 * 将 Markdown 格式的表格转换为等宽对齐的 Unicode 边框表格代码块
 */
export function convertMarkdownTablesToAscii(text: string): string {
	// 匹配由以 | 开头的连续行组成的 markdown 表格
	const tableRegex = /((?:^[ \t]*\|.+?\|[ \t]*(?:\r?\n|$)){2,})/gm;

	return text.replace(tableRegex, (match) => {
		const rawLines = match
			.trim()
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l.startsWith('|') && l.endsWith('|'));

		if (rawLines.length < 2) return match;

		// 解析每一行的单元格
		const rows: string[][] = [];
		let separatorIndex = -1;

		for (let i = 0; i < rawLines.length; i++) {
			const line = rawLines[i];
			// 检查是否为分隔行 (如 |---|:---|)
			if (/^\|(?:[ \t]*:?-+:?[ \t]*\|)+$/.test(line)) {
				separatorIndex = i;
				continue;
			}
			// 提取单元格
			const cells = line
				.slice(1, -1)
				.split('|')
				.map((c) => c.trim());
			rows.push(cells);
		}

		if (rows.length === 0) return match;

		// 计算列数与每列的最大宽度
		const colCount = Math.max(...rows.map((r) => r.length));
		const colWidths: number[] = Array(colCount).fill(0);

		for (const row of rows) {
			for (let c = 0; c < colCount; c++) {
				const cellText = row[c] || '';
				const w = getVisualWidth(cellText);
				if (w > colWidths[c]) {
					colWidths[c] = w;
				}
			}
		}

		// 为保证美观，每列最小宽度为 2
		for (let c = 0; c < colCount; c++) {
			if (colWidths[c] < 2) colWidths[c] = 2;
		}

		// 构建边框
		const topBorder = '┌' + colWidths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐';
		const midBorder = '├' + colWidths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤';
		const botBorder = '└' + colWidths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘';

		const renderRow = (row: string[]) => {
			const cells = [];
			for (let c = 0; c < colCount; c++) {
				const val = row[c] || '';
				cells.push(' ' + padEndVisual(val, colWidths[c]) + ' ');
			}
			return '│' + cells.join('│') + '│';
		};

		const formattedLines: string[] = [topBorder];

		if (separatorIndex !== -1 && rows.length > 1) {
			// 表头
			formattedLines.push(renderRow(rows[0]));
			formattedLines.push(midBorder);
			// 数据行
			for (let i = 1; i < rows.length; i++) {
				formattedLines.push(renderRow(rows[i]));
			}
		} else {
			// 无分隔符行，直接全部渲染
			for (let i = 0; i < rows.length; i++) {
				formattedLines.push(renderRow(rows[i]));
				if (i < rows.length - 1) formattedLines.push(midBorder);
			}
		}

		formattedLines.push(botBorder);

		// 包裹在 Telegram 等宽代码块中
		return '```\n' + formattedLines.join('\n') + '\n```';
	});
}

/**
 * 处理 Telegram Bot API 7.0+ 可折叠引用块（Expandable Blockquote）
 * 语法规范：首行以 **> 开头，后续行以 > 开头，结尾加 ||
 */
export function wrapInExpandableQuote(content: string): string {
	const trimmed = content.trim();
	if (!trimmed) return '';
	const lines = trimmed.split('\n');
	if (lines.length === 1) {
		return `**>${lines[0]}||`;
	}
	const firstLine = `**>${lines[0]}`;
	const restLines = lines.slice(1).map((line) => `>${line}`);
	return `${firstLine}\n${restLines.join('\n')}||`;
}

/**
 * 转换包含 <details> 标签的结构化文本为 Telegram 原生富文本布局
 */
export function parseDetailsAndFold(text: string): string {
	const detailsRegex = /<details>([\s\S]*?)<\/details>/gi;

	if (!detailsRegex.test(text)) {
		return text;
	}

	return text.replace(detailsRegex, (_match, innerContent) => {
		// 移除可能存在的 <summary>...</summary> 标签内容，提炼为折叠头部
		let summaryTitle = '点击展开查看详细讨论与溯源 🔽';
		let cleanedInner = innerContent;
		const summaryMatch = innerContent.match(/<summary>([\s\S]*?)<\/summary>/i);
		if (summaryMatch) {
			summaryTitle = summaryMatch[1].trim() + ' 🔽';
			cleanedInner = innerContent.replace(/<summary>[\s\S]*?<\/summary>/i, '');
		}

		const formattedContent = `${summaryTitle}\n\n${cleanedInner.trim()}`;
		return '\n' + wrapInExpandableQuote(formattedContent) + '\n';
	});
}

/**
 * 完整格式化管线：
 * 1. Markdown 表格转等宽 Unicode 框线表格代码块
 * 2. 识别 <details> 结构，将外部要点与内部详情分别格式化并用 Telegram 7.0+ 可折叠引用块包裹
 * 3. 如无 <details> 结构，智能保证内容结构清晰
 */
export function formatRichTelegramMessage(
	rawContent: string,
	options: { isSummary?: boolean } = { isSummary: true }
): string {
	const tableConverted = convertMarkdownTablesToAscii(rawContent);

	const detailsRegex = /<details>([\s\S]*?)<\/details>/i;
	if (detailsRegex.test(tableConverted)) {
		const match = tableConverted.match(detailsRegex)!;
		const summaryPart = tableConverted.replace(detailsRegex, '').trim();
		const innerContent = match[1];

		let summaryTitle = '💬 详细讨论脉络与消息溯源 🔽';
		let cleanedInner = innerContent;
		const summaryMatch = innerContent.match(/<summary>([\s\S]*?)<\/summary>/i);
		if (summaryMatch) {
			summaryTitle = summaryMatch[1].trim() + ' 🔽';
			cleanedInner = innerContent.replace(/<summary>[\s\S]*?<\/summary>/i, '');
		}

		const formattedSummary = summaryPart ? telegramifyMarkdown(summaryPart, 'keep') : '';
		const formattedInner = telegramifyMarkdown(`${summaryTitle}\n\n${cleanedInner.trim()}`, 'keep');
		const foldedDetails = wrapInExpandableQuote(formattedInner);

		const combined = formattedSummary ? `${formattedSummary}\n\n${foldedDetails}` : foldedDetails;
		return normalizeSpacing(combined);
	}

	const formatted = telegramifyMarkdown(tableConverted, 'keep');
	if (options.isSummary) {
		return normalizeSpacing(wrapInExpandableQuote(formatted));
	}
	return normalizeSpacing(formatted);
}

/**
 * 消除过量连续空行与多余首尾空白，将连续 3 个及以上换行规整为单行空行（\n\n）
 */
export function normalizeSpacing(text: string): string {
	return text
		.replace(/\r\n/g, '\n')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * 转换常用 AI LaTeX 符号，适配 Telegram Rich Markdown
 */
export function normalizeLatexForRichMarkdown(text: string): string {
	const parts = text.split(/(```[\s\S]*?```)/);
	return parts
		.map((part, index) => {
			if (index % 2 === 1) return part;
			return part
				.replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_m, p1) => `$$\n${p1.trim()}\n$$`)
				.replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_m, p1) => `$${p1.trim()}$`);
		})
		.join('');
}

/**
 * 为 Telegram Bot API 10.1+ 的 sendRichMessage 准备原生富文本标准 Markdown：
 * - 保持标准 Markdown 表格结构（| ... |），让 Telegram 原生渲染 Native Tables（富文本原生表格）
 * - 将 <details> 转换为 Telegram 原生可折叠引用块 **>...||
 * - 规范化 LaTeX 公式
 * - 压缩大标题间多余的空行，保证视觉紧凑美观
 */
export function formatForTelegramRichMessage(rawContent: string): string {
	let text = normalizeLatexForRichMarkdown(rawContent);

	const detailsRegex = /<details>([\s\S]*?)<\/details>/gi;
	text = text.replace(detailsRegex, (_match, innerContent) => {
		let summaryTitle = '💬 点击展开详细讨论与消息溯源 🔽';
		let cleanedInner = innerContent;
		const summaryMatch = innerContent.match(/<summary>([\s\S]*?)<\/summary>/i);
		if (summaryMatch) {
			summaryTitle = summaryMatch[1].trim() + ' 🔽';
			cleanedInner = innerContent.replace(/<summary>[\s\S]*?<\/summary>/i, '');
		}
		const trimmedContent = cleanedInner.trim();
		const lines = `${summaryTitle}\n\n${trimmedContent}`.split('\n');
		const firstLine = `**>${lines[0]}`;
		const restLines = lines.slice(1).map((line) => `>${line}`);
		return `\n\n${firstLine}\n${restLines.join('\n')}||`;
	});

	return normalizeSpacing(text);
}

/**
 * 调用 Telegram Bot API 10.1+ 的 sendRichMessage 端点发送原生富文本
 */
export async function sendTelegramRichMessage(
	token: string,
	chatId: string | number,
	markdown: string,
	replyToMessageId?: number
): Promise<{ ok: boolean; result?: any; description?: string }> {
	const url = `https://api.telegram.org/bot${token}/sendRichMessage`;
	const body: any = {
		chat_id: chatId.toString(),
		rich_message: {
			markdown,
		},
	};
	if (replyToMessageId) {
		body.reply_parameters = { message_id: replyToMessageId };
	}
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		return (await res.json()) as any;
	} catch (e: any) {
		return { ok: false, description: e?.message || String(e) };
	}
}

/**
 * 删除 Telegram 聊天中的指定消息（用于清理思考中等临时提示消息）
 */
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


