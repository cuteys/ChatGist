import { describe, it, expect } from 'vitest';
import {
	toSuperscript,
	processMarkdownLinks,
	fixLink,
	foldText,
	normalizeSpacing,
	formatSummaryWithHighlights,
	formatAnswerMessage,
	stripMarkdownV2Escapes,
	splitTelegramMessage,
} from '../src/richFormat';

describe('richFormat tests', () => {
	it('converts numbers to superscript correctly', () => {
		expect(toSuperscript(1)).toBe('¹');
		expect(toSuperscript(123)).toBe('¹²³');
	});

	it('processes duplicate markdown links correctly', () => {
		const text = '[https://t.me/c/1/1](https://t.me/c/1/1) [https://t.me/c/1/1](https://t.me/c/1/1)';
		const result = processMarkdownLinks(text);
		expect(result).toBe('[引用¹](https://t.me/c/1/1) [引用¹](https://t.me/c/1/1)');
	});

	it('fixes erroneous links', () => {
		expect(fixLink('https://tme.cat/123/456')).toBe('https://t.me/c/123/456');
		expect(fixLink('https://t.me/c/c/123/456')).toBe('https://t.me/c/123/456');
	});

	it('wraps content in Telegram expandable quote', () => {
		const content = '第一行\n第二行';
		const quoted = foldText(content);
		expect(quoted).toBe('**>第一行\n>第二行||');
	});

	it('normalizes spacing and collapses redundant newlines', () => {
		const messy = `第一行\n\n\n\n第二行   \n\n\n第三行`;
		expect(normalizeSpacing(messy)).toBe(`第一行\n\n第二行\n\n第三行`);
	});

	it('formats summary with highlights at top and details folded in expandable quote', () => {
		const raw = `
【💡 核心要点速览】
• 📌 确认本周发布上线
• 💡 优化了折叠与速览体验

【💬 详细脉络与讨论溯源】
1. **发布时间**：讨论了上线计划，见 [引用1](https://tme.cat/123/456)。
2. **体验优化**：采用 MarkdownV2 格式发送 [引用2](https://tme.cat/123/789)。
`;
		const result = formatSummaryWithHighlights(raw);
		expect(result).toContain('【💡 核心要点速览】');
		expect(result).toContain('• 📌 确认本周发布上线');
		expect(result).toContain('**>【💬 详细脉络与讨论溯源】');
		expect(result).toContain('https://t.me/c/123/456');
		expect(result).toContain('https://t.me/c/123/789');
		expect(result.endsWith('||')).toBe(true);
	});

	it('formats summary without delimiter by folding the entire text', () => {
		const raw = `本日群聊总结如下：\n1. 讨论了系统部署\n2. 解决了相关配置问题`;
		const result = formatSummaryWithHighlights(raw);
		expect(result.startsWith('**>')).toBe(true);
		expect(result.endsWith('||')).toBe(true);
		expect(result).toContain('讨论了系统部署');
	});

	it('formats answer message using formatAnswerMessage', () => {
		const raw = `回答如下：大家在讨论部署方案 [https://tme.cat/123/1](https://tme.cat/123/1)`;
		const result = formatAnswerMessage(raw);
		expect(result.startsWith('**>')).toBe(true);
		expect(result.endsWith('||')).toBe(true);
		expect(result).toContain('https://t.me/c/123/1');
	});

	it('strips MarkdownV2 escapes correctly', () => {
		const escaped = 'Hello\\! This is a test\\_with\\*symbols\\[and\\]parens\\(ok\\)\\.';
		expect(stripMarkdownV2Escapes(escaped)).toBe('Hello! This is a test_with*symbols[and]parens(ok).');
	});

	it('splits long messages cleanly without exceeding maximum length', () => {
		const shortText = '短消息无需切分';
		expect(splitTelegramMessage(shortText)).toEqual([shortText]);

		// Create a long text with paragraphs
		const p1 = 'A'.repeat(2500);
		const p2 = 'B'.repeat(2500);
		const longText = `${p1}\n\n${p2}`;
		const chunks = splitTelegramMessage(longText, 4000);
		expect(chunks.length).toBe(2);
		expect(chunks[0]).toBe(p1);
		expect(chunks[1]).toBe(p2);
	});
});
