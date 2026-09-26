import { describe, it, expect } from 'vitest';
import {
	getVisualWidth,
	padEndVisual,
	convertMarkdownTablesToAscii,
	wrapInExpandableQuote,
	parseDetailsAndFold,
	formatRichTelegramMessage,
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
});
