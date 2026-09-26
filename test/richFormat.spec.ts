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
	removeThematicBreaks,
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
		expect(quoted).toBe('>第一行\n>第二行||');
	});

	it('normalizes spacing and collapses redundant newlines', () => {
		const messy = `第一行\n\n\n\n第二行   \n\n\n第三行`;
		expect(normalizeSpacing(messy)).toBe(`第一行\n\n第二行\n\n第三行`);
	});

	it('removes thematic break dividers such as ***, ---, ___ without affecting other text', () => {
		const raw = `要点速览\n\n***\n\n【💬 详细脉络】\n---\n内容条目\n___`;
		expect(removeThematicBreaks(raw)).toBe(`要点速览\n\n\n\n【💬 详细脉络】\n\n内容条目\n`);
		const formatted = formatSummaryWithHighlights(raw);
		expect(formatted).not.toContain('***');
		expect(formatted).not.toContain('---');
		expect(formatted).not.toContain('___');
	});

	it('formats summary with highlights at top and details folded in expandable quote', () => {
		const raw = `
【💡 核心要点速览】
• 📌 确认本周发布上线
• 💡 优化了折叠与速览体验

***

【💬 详细脉络与讨论溯源】
1. **发布时间**：讨论了上线计划，见 [引用1](https://tme.cat/123/456)。
2. **体验优化**：采用 MarkdownV2 格式发送 [引用2](https://tme.cat/123/789)。
`;
		const result = formatSummaryWithHighlights(raw);
		expect(result).toContain('【💡 核心要点速览】');
		expect(result).toContain('• 📌 确认本周发布上线');
		expect(result).not.toContain('***');
		expect(result).not.toContain('**>');
		expect(result).toContain('>【💬 详细脉络与讨论溯源】');
		expect(result).toContain('https://t.me/c/123/456');
		expect(result).toContain('https://t.me/c/123/789');
		expect(result.endsWith('||')).toBe(true);
	});

	it('formats summary without delimiter by folding the entire text', () => {
		const raw = `本日群聊总结如下：\n1. 讨论了系统部署\n2. 解决了相关配置问题`;
		const result = formatSummaryWithHighlights(raw);
		expect(result.startsWith('>')).toBe(true);
		expect(result).not.toContain('**>');
		expect(result.endsWith('||')).toBe(true);
		expect(result).toContain('讨论了系统部署');
	});

	it('formats answer message using formatAnswerMessage', () => {
		const raw = `回答如下：大家在讨论部署方案 [https://tme.cat/123/1](https://tme.cat/123/1)`;
		const result = formatAnswerMessage(raw);
		expect(result.startsWith('>')).toBe(true);
		expect(result).not.toContain('**>');
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

	it('parses inline rich text with jump links, bold, code, marked, and bot commands', async () => {
		const { parseInlineRichText } = await import('../src/richFormat');
		const input = '出现错误 `401 Unauthorized`，请前往 **控制台** 修复，详见 [引用¹](https://t.me/c/123456/789) 或发送 /admin_check 检查 ==安全==。';
		const parsed = parseInlineRichText(input);

		expect(Array.isArray(parsed)).toBe(true);
		const parts = parsed as any[];

		// Check code
		const codePart = parts.find((p) => typeof p === 'object' && p.type === 'code');
		expect(codePart).toBeDefined();
		expect(codePart.text).toBe('401 Unauthorized');

		// Check bold
		const boldPart = parts.find((p) => typeof p === 'object' && p.type === 'bold');
		expect(boldPart).toBeDefined();
		expect(boldPart.text).toBe('控制台');

		// Check link (crucial for chat history jump anchor)
		const linkPart = parts.find((p) => typeof p === 'object' && p.type === 'link');
		expect(linkPart).toBeDefined();
		expect(linkPart.text).toBe('引用¹');
		expect(linkPart.url).toBe('https://t.me/c/123456/789');

		// Check bot command
		const cmdPart = parts.find((p) => typeof p === 'object' && p.type === 'bot_command');
		expect(cmdPart).toBeDefined();
		expect(cmdPart.text).toBe('/admin_check');
		expect(cmdPart.bot_command).toBe('admin_check');

		// Check marked
		const markPart = parts.find((p) => typeof p === 'object' && p.type === 'marked');
		expect(markPart).toBeDefined();
		expect(markPart.text).toBe('安全');
	});

	it('converts markdown with details, tables, checklists and dividers into RichBlock AST', async () => {
		const { markdownToRichBlocks } = await import('../src/richFormat');
		const markdown = `
> 总结群聊「技术交流群」近期 500 条消息

# 本期群聊动态深度总结
本期重点探讨了系统架构升级与部署规范。

---

<details>
<summary>服务架构升级与配置说明</summary>

### 1. 架构方案对比
| 方案类型 | 资源开销 | 注意事项 | 原文溯源 |
| :--- | :---: | ---: | :--- |
| **基础版架构** | 低开销 | 适合测试环境 | [引用¹](https://t.me/c/123/1) |
| **高可用集群** | 动态扩容 | 生产首选方案 | [引用²](https://t.me/c/123/2) |

### 2. 待办清单
- [ ] 线上配置参数校准与排查
- [x] 更新系统监控与报警规则
</details>

---

###### gemini-3.8-flash
`;

		const blocks = markdownToRichBlocks(markdown);
		expect(blocks.length).toBeGreaterThanOrEqual(4);

		// 1. Blockquote
		const quoteBlock = blocks.find((b) => b.type === 'blockquote') as any;
		expect(quoteBlock).toBeDefined();
		expect(quoteBlock.blocks[0].text).toContain('总结群聊');

		// 2. Heading 1
		const h1Block = blocks.find((b) => b.type === 'heading' && b.size === 1) as any;
		expect(h1Block).toBeDefined();
		expect(h1Block.text).toBe('本期群聊动态深度总结');

		// 3. Details drawer
		const detailsBlock = blocks.find((b) => b.type === 'details') as any;
		expect(detailsBlock).toBeDefined();
		expect(detailsBlock.summary).toBe('服务架构升级与配置说明');

		// Inner table inside details drawer
		const tableBlock = detailsBlock.blocks.find((b: any) => b.type === 'table');
		expect(tableBlock).toBeDefined();
		expect(tableBlock.is_bordered).toBe(true);
		expect(tableBlock.is_striped).toBe(true);
		expect(tableBlock.cells.length).toBe(3); // 1 header row + 2 data rows
		expect(tableBlock.cells[0][0].is_header).toBe(true);
		expect(tableBlock.cells[0][0].text).toBe('方案类型');

		// Inner list with checkbox inside details drawer
		const listBlock = detailsBlock.blocks.find((b: any) => b.type === 'list');
		expect(listBlock).toBeDefined();
		expect(listBlock.items.length).toBe(2);
		expect(listBlock.items[0].has_checkbox).toBe(true);
		expect(listBlock.items[0].is_checked).toBe(false);
		expect(listBlock.items[1].has_checkbox).toBe(true);
		expect(listBlock.items[1].is_checked).toBe(true);

		// 4. Heading 6 footer
		const h6Block = blocks.find((b) => b.type === 'heading' && b.size === 6) as any;
		expect(h6Block).toBeDefined();
		expect(h6Block.text).toBe('gemini-3.8-flash');
	});

	it('builds rich table for whitelist groups correctly', async () => {
		const { buildWhitelistRichBlocks } = await import('../src/richFormat');
		const groups = [
			{ groupId: '-100123456789', groupName: '开发测试群', addedBy: '10001', createdAt: 1789000000000 },
			{ groupId: '-100987654321', groupName: '运维交流群', addedBy: '10001', createdAt: 1789100000000 },
		];

		const blocks = buildWhitelistRichBlocks(groups);
		const tableBlock = blocks.find((b) => b.type === 'table') as any;
		expect(tableBlock).toBeDefined();
		expect(tableBlock.is_bordered).toBe(true);
		expect(tableBlock.is_striped).toBe(true);
		// 1 header + 2 group rows = 3 rows
		expect(tableBlock.cells.length).toBe(3);
		expect(tableBlock.cells[0][1].text).toBe('群组名称');
		expect(tableBlock.cells[1][1].text.text).toBe('开发测试群');
	});

	it('builds rich table for admins correctly', async () => {
		const { buildAdminsRichBlocks } = await import('../src/richFormat');
		const envAdmins = ['10001', '10002'];
		const dbAdmins = [
			{ userId: '20001', userName: '小助手', addedBy: '10001', createdAt: 1789000000000 },
		];

		const blocks = buildAdminsRichBlocks(envAdmins, dbAdmins);
		const tables = blocks.filter((b) => b.type === 'table');
		expect(tables.length).toBe(2); // One for env superadmins, one for DB admins
	});

	it('builds rich table for query keyword results with clickable jump links', async () => {
		const { buildQueryRichBlocks } = await import('../src/richFormat');
		const results = [
			{
				groupId: '-100123456789',
				messageId: 42,
				userName: 'Alice',
				content: '部署成功，已上线新版本',
			},
			{
				groupId: '-100123456789',
				messageId: 43,
				userName: 'Bob',
				content: '收到，验证通过',
			},
		];

		const blocks = buildQueryRichBlocks('部署', 2, results);
		const tableBlock = blocks.find((b) => b.type === 'table') as any;
		expect(tableBlock).toBeDefined();
		expect(tableBlock.is_bordered).toBe(true);
		expect(tableBlock.is_striped).toBe(true);
		expect(tableBlock.cells.length).toBe(3); // 1 header + 2 rows

		// Check the jump link in row 1, col 3
		const linkCell = tableBlock.cells[1][3];
		expect(linkCell.text[0].type).toBe('link');
		expect(linkCell.text[0].text).toBe('🔗 查看原文');
		expect(linkCell.text[0].url).toBe('https://t.me/c/123456789/42');
	});

	it('sends Telegram Rich Message and handles graceful fallback', async () => {
		const { sendTelegramRichMessage } = await import('../src/richFormat');

		const originalFetch = globalThis.fetch;
		const callUrls: string[] = [];
		const payloads: any[] = [];

		// 1. Successful sendRichMessage
		globalThis.fetch = (async (url: any, init?: any) => {
			callUrls.push(url.toString());
			payloads.push(JSON.parse(init?.body || '{}'));
			return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
		}) as any;

		try {
			const res = await sendTelegramRichMessage('test_token', '-100123', [
				{ type: 'paragraph', text: 'Hello rich world' },
			]);
			expect(res.ok).toBe(true);
			expect(callUrls[0]).toContain('/sendRichMessage');
			expect(payloads[0].rich_message.blocks[0].text).toBe('Hello rich world');
		} finally {
			globalThis.fetch = originalFetch;
		}

		// 2. sendRichMessage fails with 400 -> fallback to sendMessage
		const fallbackUrls: string[] = [];
		globalThis.fetch = (async (url: any, init?: any) => {
			fallbackUrls.push(url.toString());
			if (url.toString().includes('/sendRichMessage')) {
				return new Response(JSON.stringify({ ok: false, error_code: 400 }), { status: 400 });
			}
			return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
		}) as any;

		try {
			const res = await sendTelegramRichMessage('test_token', '-100123', [
				{ type: 'paragraph', text: 'Fallback test' },
			]);
			expect(res.ok).toBe(true);
			expect(fallbackUrls.some((u) => u.includes('/sendRichMessage'))).toBe(true);
			expect(fallbackUrls.some((u) => u.includes('/sendMessage'))).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
