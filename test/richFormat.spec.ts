import { describe, it, expect } from 'vitest';
import {
	getVisualWidth,
	padEndVisual,
	convertMarkdownTablesToAscii,
	wrapInExpandableQuote,
	parseDetailsAndFold,
	formatRichTelegramMessage,
	normalizeSpacing,
	normalizeLatexForRichMarkdown,
	formatForTelegramRichMessage,
} from '../src/richFormat';

describe('richFormat tests', () => {
	it('calculates visual width correctly', () => {
		expect(getVisualWidth('hello')).toBe(5);
		expect(getVisualWidth('你好')).toBe(4);
		expect(getVisualWidth('AI模型')).toBe(6);
	});

	it('pads string visually', () => {
		expect(padEndVisual('你好', 6)).toBe('你好  ');
		expect(padEndVisual('test', 6)).toBe('test  ');
	});

	it('converts markdown table to beautiful ASCII box table', () => {
		const md = `
一些文字
| 议题 | 结论 |
| :--- | :--- |
| 部署 | 完成 |
| 模型 | GPT  |
结尾文字
`;
		const result = convertMarkdownTablesToAscii(md);
		expect(result).toContain('```');
		expect(result).toContain('┌');
		expect(result).toContain('│ 议题 │ 结论 │');
		expect(result).toContain('├');
		expect(result).toContain('│ 部署 │ 完成 │');
		expect(result).toContain('│ 模型 │ GPT  │');
		expect(result).toContain('└');
	});

	it('wraps content in Telegram expandable quote', () => {
		const content = '第一行\n第二行';
		const quoted = wrapInExpandableQuote(content);
		expect(quoted).toBe('**>第一行\n>第二行||');
	});

	it('parses details tag to expandable quote', () => {
		const text = `
今日概要速览：
1. 项目更新完成

<details>
<summary>详细讨论记录</summary>
Alice: 已经部署好啦
Bob: 收到测试中
</details>
`;
		const parsed = parseDetailsAndFold(text);
		expect(parsed).toContain('今日概要速览：');
		expect(parsed).toContain('**>详细讨论记录 🔽');
		expect(parsed).toContain('>Alice: 已经部署好啦');
		expect(parsed).toContain('||');
	});

	it('formats full message with table and details section', () => {
		const raw = `
### 💡 核心要点
- 系统运行平稳

| 议题 | 结论 |
| :--- | :--- |
| 性能 | 提升 |

<details>
<summary>详细讨论</summary>
详细内容第1行
详细内容第2行
</details>
`;
		const result = formatRichTelegramMessage(raw);
		expect(result).toContain('┌');
		expect(result).toContain('│ 议题 │ 结论 │');
		expect(result).toContain('**>详细讨论 🔽');
		expect(result).toContain('>详细内容第1行');
		expect(result).toContain('||');
	});

	it('normalizes spacing and collapses redundant newlines', () => {
		const messy = `第一行\n\n\n\n第二行   \n\n\n第三行`;
		expect(normalizeSpacing(messy)).toBe(`第一行\n\n第二行\n\n第三行`);
	});

	it('normalizes LaTeX equations for Telegram Rich Markdown', () => {
		const latex = `公式行：\\[ \\sum_{i=1}^n x_i \\] 与行内 \\( E=mc^2 \\)`;
		const normalized = normalizeLatexForRichMarkdown(latex);
		expect(normalized).toContain('$$\n\\sum_{i=1}^n x_i\n$$');
		expect(normalized).toContain('$E=mc^2$');
	});

	it('formats text for Telegram Native Tables via formatForTelegramRichMessage', () => {
		const raw = `
【💡 核心要点速览】
- 进展顺利



【📊 议题简表】
| 议题分类 | 核心结论 |
|:---|:---|
| 图像压缩 | 支持 |


<details>
<summary>💬 点击展开详细讨论与消息溯源</summary>
1. 讨论过程消息
</details>
`;
		const result = formatForTelegramRichMessage(raw);
		// Native Table 保持标准 Markdown 管道符语法，未被转化为 ASCII 代码块
		expect(result).toContain('| 议题分类 | 核心结论 |');
		expect(result).toContain('|:---|:---|');
		expect(result).not.toContain('┌');
		// Details 标签被转化为可折叠引用块
		expect(result).toContain('**>💬 点击展开详细讨论与消息溯源 🔽');
		expect(result).toContain('>1. 讨论过程消息||');
		// 连续空行被压缩
		expect(result).not.toContain('\n\n\n');
	});
});
