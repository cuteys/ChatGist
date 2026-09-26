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

	it('parses direct Rich Message JSON AST output from AI correctly', async () => {
		const { parseRichMessageResponse } = await import('../src/richFormat');
		const jsonFromAi = JSON.stringify({
			rich_message: {
				blocks: [
					{
						type: 'blockquote',
						blocks: [{ type: 'paragraph', text: '总结群聊近期记录' }],
					},
					{
						type: 'heading',
						size: 1,
						text: '群聊动态深度总结',
					},
					{
						type: 'details',
						summary: '议题一：架构方案与溯源',
						blocks: [
							{
								type: 'table',
								is_bordered: true,
								is_striped: true,
								cells: [
									[
										{ text: '方案', is_header: true, align: 'center' },
										{ text: '发言溯源', is_header: true, align: 'center' },
									],
									[
										{ text: '方案A', align: 'left' },
										{
											text: [{ type: 'link', text: '💬 原文', url: 'https://t.me/c/123456/789' }],
											align: 'center',
										},
									],
								],
							},
						],
					},
				],
			},
		});

		const result = parseRichMessageResponse(jsonFromAi);
		expect(result.blocks.length).toBe(3);
		expect(result.blocks[0].type).toBe('blockquote');
		expect(result.blocks[1].type).toBe('heading');
		expect(result.blocks[2].type).toBe('details');

		const details = result.blocks[2] as any;
		expect(details.summary).toBe('议题一：架构方案与溯源');
		const table = details.blocks[0];
		expect(table.type).toBe('table');
		expect(table.is_striped).toBe(true);
		expect(table.cells[1][1].text[0].type).toBe('link');
		expect(table.cells[1][1].text[0].url).toBe('https://t.me/c/123456/789');
	});

	it('strips markdown code blocks and handles plain text fallback in parseRichMessageResponse', async () => {
		const { parseRichMessageResponse } = await import('../src/richFormat');
		const wrappedJson = '```json\n{"blocks": [{"type": "paragraph", "text": "测试内容"}]}\n```';
		const resWrapped = parseRichMessageResponse(wrappedJson);
		expect(resWrapped.blocks.length).toBe(1);
		expect(resWrapped.blocks[0].type).toBe('paragraph');

		const nonJson = '这是一段普通的非 JSON 文本';
		const resFallback = parseRichMessageResponse(nonJson);
		expect(resFallback.blocks.length).toBe(1);
		expect(resFallback.blocks[0].type).toBe('paragraph');
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
