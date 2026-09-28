import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	initWhitelistTables,
	isSuperAdmin,
	isAdmin,
	isGroupWhitelisted,
	addGroupToWhitelist,
	removeGroupFromWhitelist,
	getWhitelistedGroups,
	addAdmin,
	removeAdmin,
	getAdmins,
	invalidateWhitelistCache,
} from '../src/whitelist';

describe('Whitelist and Admin DB operations', () => {
	beforeEach(async () => {
		invalidateWhitelistCache();
		await initWhitelistTables(env);
		await env.DB.prepare('DELETE FROM WhitelistGroups').run();
		await env.DB.prepare('DELETE FROM Admins').run();
	});

	it('should verify env admin and database admin', async () => {
		// Mock env admin
		const testEnv: Env = {
			...env,
			ADMIN_USER_IDS: '10001, 10002',
		};

		// 1. Env super admin check
		expect(isSuperAdmin(testEnv, '10001')).toBe(true);
		expect(isSuperAdmin(testEnv, 10002)).toBe(true);
		expect(isSuperAdmin(testEnv, '99999')).toBe(false);
		expect(await isAdmin(testEnv, '10001')).toBe(true);
		expect(await isAdmin(testEnv, 10002)).toBe(true);
		expect(await isAdmin(testEnv, '99999')).toBe(false);

		// 2. Add dynamic admin to DB (Super admin privilege)
		const addRes = await addAdmin(testEnv, '20001', 'Bob', '10001');
		expect(addRes).toBe(true);
		expect(await isAdmin(testEnv, '20001')).toBe(true);
		expect(isSuperAdmin(testEnv, '20001')).toBe(false); // DB admin is NOT super admin!

		// 3. Get admins list
		const admins = await getAdmins(testEnv);
		expect(admins.envAdmins).toEqual(['10001', '10002']);
		expect(admins.dbAdmins.length).toBe(1);
		expect(admins.dbAdmins[0].userId).toBe('20001');
		expect(admins.dbAdmins[0].userName).toBe('Bob');

		// 4. Remove dynamic admin
		const delRes = await removeAdmin(testEnv, '20001');
		expect(delRes).toBe(true);
		expect(await isAdmin(testEnv, '20001')).toBe(false);
	});

	it('should manage group whitelist correctly', async () => {
		const testEnv = env;
		const groupId = '-100123456789';

		// 1. Initially not whitelisted
		expect(await isGroupWhitelisted(testEnv, groupId)).toBe(false);

		// 2. Add group to whitelist
		const addRes = await addGroupToWhitelist(testEnv, groupId, '测试群组', '10001');
		expect(addRes).toBe(true);
		expect(await isGroupWhitelisted(testEnv, groupId)).toBe(true);

		// 3. List whitelisted groups
		const groups = await getWhitelistedGroups(testEnv);
		expect(groups.length).toBe(1);
		expect(groups[0].groupId).toBe(groupId);
		expect(groups[0].groupName).toBe('测试群组');
		expect(groups[0].addedBy).toBe('10001');

		// 4. Remove group from whitelist
		const removeRes = await removeGroupFromWhitelist(testEnv, groupId);
		expect(removeRes).toBe(true);
		expect(await isGroupWhitelisted(testEnv, groupId)).toBe(false);
		expect((await getWhitelistedGroups(testEnv)).length).toBe(0);
	});
});

import worker, { clearProcessingUpdatesForTest } from '../src/index';

describe('Worker fetch whitelist gatekeeping', () => {
	const mockCtx = {
		waitUntil: () => {},
		passThroughOnException: () => {},
	} as any;

	const testEnv: Env = {
		...env,
		TELEGRAM_BOT_TOKEN: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
		ADMIN_USER_IDS: '10001',
	};

	beforeEach(async () => {
		clearProcessingUpdatesForTest();
		invalidateWhitelistCache();
		await testEnv.DB.prepare(`
			CREATE TABLE IF NOT EXISTS Messages (
				id TEXT PRIMARY KEY,
				groupId TEXT,
				timeStamp INTEGER NOT NULL,
				userName TEXT,
				content TEXT,
				messageId INTEGER,
				groupName TEXT,
				messageTime TEXT
			)
		`).run();
		await initWhitelistTables(testEnv);
		await testEnv.DB.prepare('DELETE FROM WhitelistGroups').run();
		await testEnv.DB.prepare('DELETE FROM Admins').run();
		await testEnv.DB.prepare('DELETE FROM Messages').run();
	});

	it('should silently ignore messages from non-whitelisted groups', async () => {
		const nonWhitelistedPayload = {
			update_id: 1,
			message: {
				message_id: 101,
				from: { id: 99999, first_name: 'Eve' },
				chat: { id: -100999999, title: 'Unauthorized Group', type: 'supergroup' },
				date: Math.floor(Date.now() / 1000),
				text: 'Hello secret info',
			},
		};

		const req = new Request('https://chatgist.example.com/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(nonWhitelistedPayload),
		});

		const res = await worker.fetch(req, testEnv, mockCtx);
		expect(res.status).toBe(200);

		// Verify Messages table is completely empty
		const count = await testEnv.DB.prepare('SELECT COUNT(*) as cnt FROM Messages').first<number>('cnt');
		expect(count).toBe(0);
	});

	it('should record messages for whitelisted groups', async () => {
		const groupId = '-100888888';
		await addGroupToWhitelist(testEnv, groupId, 'Authorized Group', '10001');

		const whitelistedPayload = {
			update_id: 2,
			message: {
				message_id: 102,
				from: { id: 88888, first_name: 'Alice' },
				chat: { id: parseInt(groupId), title: 'Authorized Group', type: 'supergroup' },
				date: Math.floor(Date.now() / 1000),
				text: 'Hello world in authorized group',
			},
		};

		const req = new Request('https://chatgist.example.com/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(whitelistedPayload),
		});

		const res = await worker.fetch(req, testEnv, mockCtx);
		expect(res.status).toBe(200);

		// Verify message was recorded in Messages table
		const row = await testEnv.DB.prepare('SELECT * FROM Messages WHERE groupId = ?').bind(groupId).first();
		expect(row).toBeDefined();
		expect((row as any).content).toBe('Hello world in authorized group');
	});

	it('should correctly record messages with forward_origin and legacy forward fields', async () => {
		const groupId = '-100888888';
		await addGroupToWhitelist(testEnv, groupId, 'Authorized Group', '10001');

		// 1. New Telegram 7.0+ forward_origin format
		const reqOrigin = new Request('https://chatgist.example.com/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				update_id: 205,
				message: {
					message_id: 105,
					from: { id: 88888, first_name: 'Alice' },
					chat: { id: parseInt(groupId), title: 'Authorized Group', type: 'supergroup' },
					date: Math.floor(Date.now() / 1000),
					text: 'Origin message',
					forward_origin: {
						type: 'channel',
						chat: { title: 'News Channel' },
					},
				},
			}),
		});
		const resOrigin = await worker.fetch(reqOrigin, testEnv, mockCtx);
		expect(resOrigin.status).toBe(200);
		const rowOrigin = await testEnv.DB.prepare('SELECT * FROM Messages WHERE messageId = 105').first();
		expect((rowOrigin as any).content).toBe('转发自 News Channel: Origin message');

		// 2. Legacy forward_from format
		const reqLegacy = new Request('https://chatgist.example.com/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				update_id: 206,
				message: {
					message_id: 106,
					from: { id: 88888, first_name: 'Alice' },
					chat: { id: parseInt(groupId), title: 'Authorized Group', type: 'supergroup' },
					date: Math.floor(Date.now() / 1000),
					text: 'Legacy message',
					forward_from: {
						id: 99999,
						first_name: 'Bob',
					},
				},
			}),
		});
		const resLegacy = await worker.fetch(reqLegacy, testEnv, mockCtx);
		expect(resLegacy.status).toBe(200);
		const rowLegacy = await testEnv.DB.prepare('SELECT * FROM Messages WHERE messageId = 106').first();
		expect((rowLegacy as any).content).toBe('转发自 Bob: Legacy message');
	});

	it('should allow admin to add group from inside non-whitelisted group', async () => {
		const groupId = '-100777777';
		const addGroupPayload = {
			update_id: 3,
			message: {
				message_id: 103,
				from: { id: 10001, first_name: 'SuperAdmin' },
				chat: { id: parseInt(groupId), title: 'Dev Team Group', type: 'supergroup' },
				date: Math.floor(Date.now() / 1000),
				text: '/addgroup',
			},
		};

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}) as any;

		try {
			const req = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(addGroupPayload),
			});

			const res = await worker.fetch(req, testEnv, mockCtx);
			expect(res.status).toBe(200);

			// Verify group was added to WhitelistGroups table
			expect(await isGroupWhitelisted(testEnv, groupId)).toBe(true);
			const groups = await getWhitelistedGroups(testEnv);
			expect(groups.find((g) => g.groupId === groupId)?.groupName).toBe('Dev Team Group');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should silently ignore /help when triggered in group chat', async () => {
		const groupId = '-100888888';
		await addGroupToWhitelist(testEnv, groupId, 'Authorized Group', '10001');

		const sentMessages: any[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			const url = typeof input === 'string' ? input : input.url;
			sentMessages.push(url);
			return new Response(JSON.stringify({ ok: true, result: {} }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}) as any;

		try {
			const req = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					update_id: 10,
					message: {
						message_id: 200,
						from: { id: 55555, first_name: 'Bob' },
						chat: { id: parseInt(groupId), title: 'Authorized Group', type: 'supergroup' },
						date: Math.floor(Date.now() / 1000),
						text: '/help',
					},
				}),
			});

			const res = await worker.fetch(req, testEnv, mockCtx);
			expect(res.status).toBe(200);
			expect(sentMessages.length).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should silently ignore /status when triggered in group chat', async () => {
		const groupId = '-100888888';
		await addGroupToWhitelist(testEnv, groupId, 'Authorized Group', '10001');

		const sentMessages: any[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			const url = typeof input === 'string' ? input : input.url;
			sentMessages.push(url);
			return new Response(JSON.stringify({ ok: true, result: {} }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}) as any;

		try {
			const req = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					update_id: 11,
					message: {
						message_id: 201,
						from: { id: 55555, first_name: 'Bob' },
						chat: { id: parseInt(groupId), title: 'Authorized Group', type: 'supergroup' },
						date: Math.floor(Date.now() / 1000),
						text: '/status',
					},
				}),
			});

			const res = await worker.fetch(req, testEnv, mockCtx);
			expect(res.status).toBe(200);
			expect(sentMessages.length).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should send full help directly when /help triggered in private chat', async () => {
		const sentMessages: any[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			const url = typeof input === 'string' ? input : input.url;
			sentMessages.push(url);
			return new Response(JSON.stringify({ ok: true, result: {} }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}) as any;

		try {
			const req = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					update_id: 12,
					message: {
						message_id: 202,
						from: { id: 55555, first_name: 'Bob' },
						chat: { id: 55555, type: 'private' },
						date: Math.floor(Date.now() / 1000),
						text: '/help',
					},
				}),
			});

			const res = await worker.fetch(req, testEnv, mockCtx);
			expect(res.status).toBe(200);

			expect(sentMessages.length).toBe(1);
			expect(sentMessages[0]).toContain('chat_id=55555');
			expect(decodeURIComponent(sentMessages[0]).replace(/\+/g, ' ')).toContain('ChatGist 群聊助手使用指南');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should silently ignore /start when triggered in group chat', async () => {
		const groupId = '-100888888';
		await addGroupToWhitelist(testEnv, groupId, 'Authorized Group', '10001');

		const sentMessages: any[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			const url = typeof input === 'string' ? input : input.url;
			sentMessages.push(url);
			return new Response(JSON.stringify({ ok: true, result: {} }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}) as any;

		try {
			const req = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					update_id: 13,
					message: {
						message_id: 203,
						from: { id: 55555, first_name: 'Bob' },
						chat: { id: parseInt(groupId), title: 'Authorized Group', type: 'supergroup' },
						date: Math.floor(Date.now() / 1000),
						text: '/start',
					},
				}),
			});

			const res = await worker.fetch(req, testEnv, mockCtx);
			expect(res.status).toBe(200);
			expect(sentMessages.length).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should send welcome and onboarding message when /start is used in private chat', async () => {
		const sentMessages: any[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			const url = typeof input === 'string' ? input : input.url;
			sentMessages.push(url);
			return new Response(JSON.stringify({ ok: true, result: {} }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}) as any;

		try {
			const req = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					update_id: 14,
					message: {
						message_id: 204,
						from: { id: 55555, first_name: 'Bob' },
						chat: { id: 55555, type: 'private' },
						date: Math.floor(Date.now() / 1000),
						text: '/start',
					},
				}),
			});

			const res = await worker.fetch(req, testEnv, mockCtx);
			expect(res.status).toBe(200);

			expect(sentMessages.length).toBe(1);
			const decoded = decodeURIComponent(sentMessages[0]).replace(/\+/g, ' ');
			expect(decoded).toContain('欢迎使用 ChatGist 群聊智能助手');
			expect(decoded).toContain('/help 可查看完整指南');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should respond to /status in private chat with quota and status information', async () => {
		const sentMessages: any[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			const url = typeof input === 'string' ? input : input.url;
			sentMessages.push(url);
			return new Response(JSON.stringify({ ok: true, result: {} }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}) as any;

		try {
			const req = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					update_id: 13,
					message: {
						message_id: 203,
						from: { id: 66666, first_name: 'Charlie' },
						chat: { id: 66666, type: 'private' },
						date: Math.floor(Date.now() / 1000),
						text: '/status',
					},
				}),
			});

			const res = await worker.fetch(req, testEnv, mockCtx);
			expect(res.status).toBe(200);

			expect(sentMessages.length).toBe(1);
			expect(decodeURIComponent(sentMessages[0]).replace(/\+/g, ' ')).toContain('今日使用配额');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should reject group-only commands (/summary, /ask, /query) in private chat', async () => {
		const sentMessages: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			const url = typeof input === 'string' ? input : input.url;
			sentMessages.push(url);
			return new Response(JSON.stringify({ ok: true, result: {} }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}) as any;

		try {
			const cmds = ['summary', 'ask', 'query'];
			for (let i = 0; i < cmds.length; i++) {
				const cmd = cmds[i];
				const req = new Request('https://chatgist.example.com/', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						update_id: 150 + i,
						message: {
							message_id: 301 + i,
							from: { id: 77777, first_name: 'David' },
							chat: { id: 77777, type: 'private' },
							date: Math.floor(Date.now() / 1000),
							text: `/${cmd} test`,
						},
					}),
				});

				const res = await worker.fetch(req, testEnv, mockCtx);
				expect(res.status).toBe(200);
			}

			expect(sentMessages.length).toBe(3);
			for (let i = 0; i < 3; i++) {
				const decoded = decodeURIComponent(sentMessages[i]).replace(/\+/g, ' ');
				expect(decoded).toContain('仅支持在群聊中使用');
			}
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should not include rich text status probe in /status output', async () => {
		const sentMessages: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			const url = typeof input === 'string' ? input : input.url;
			sentMessages.push(url);
			return new Response(JSON.stringify({ ok: true, result: {} }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}) as any;

		try {
			const req = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					update_id: 16,
					message: {
						message_id: 302,
						from: { id: 10001, first_name: 'Admin' },
						chat: { id: 10001, type: 'private' },
						date: Math.floor(Date.now() / 1000),
						text: '/status',
					},
				}),
			});

			const res = await worker.fetch(req, testEnv, mockCtx);
			expect(res.status).toBe(200);

			expect(sentMessages.length).toBe(1);
			const decoded = decodeURIComponent(sentMessages[0]).replace(/\+/g, ' ');
			expect(decoded).not.toContain('原生富文本');
			expect(decoded).not.toContain('sendRichMessage');
			expect(decoded).toContain('单群保留上限');
			expect(decoded).toContain('数据库总消息');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should reply directly in group for /ask without sending to private message', async () => {
		const groupId = '-100888888';
		await addGroupToWhitelist(testEnv, groupId, 'Authorized Group', '10001');

		// Insert a message within the last 48 hours
		await testEnv.DB.prepare(
			'INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)'
		)
			.bind('msg-ask-1', groupId, Date.now() - 3600 * 1000, 'Bob', '讨论新版本的部署测试', 10, 'Authorized Group')
			.run();

		const telegramCalls: Array<{ url: string; body?: any }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			const url = typeof input === 'string' ? input : input.url;
			const bodyText = init?.body ? (typeof init.body === 'string' ? init.body : await (init.body as any).text?.()) : undefined;
			let parsedBody: any = undefined;
			try {
				if (bodyText) parsedBody = JSON.parse(bodyText);
			} catch (_) {}

			if (url.includes('/chat/completions')) {
				return new Response(
					JSON.stringify({
						id: 'chatcmpl-test',
						object: 'chat.completion',
						created: Math.floor(Date.now() / 1000),
						model: 'gpt-4o-mini',
						choices: [
							{
								index: 0,
								message: {
									role: 'assistant',
									content: '大家刚才在讨论系统新特性的部署和测试。',
								},
								finish_reason: 'stop',
							},
						],
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}

			telegramCalls.push({ url, body: parsedBody });
			return new Response(JSON.stringify({ ok: true, result: { message_id: 888 } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}) as any;

		try {
			const testEnvWithModel: Env = {
				...testEnv,
				AI_MODEL: 'gpt-4o-mini',
				AI_API_KEY: 'test-key',
			};

			const req = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					update_id: 17,
					message: {
						message_id: 401,
						from: { id: 88888, first_name: 'Alice' },
						chat: { id: parseInt(groupId), title: 'Authorized Group', type: 'supergroup' },
						date: Math.floor(Date.now() / 1000),
						text: '/ask 大家刚才在讨论什么？',
					},
				}),
			});

			const res = await worker.fetch(req, testEnvWithModel, mockCtx);
			expect(res.status).toBe(200);

			// Check that no call was made to private chat 88888
			const pmCalls = telegramCalls.filter((c) => {
				const bodyStr = JSON.stringify(c.body || {});
				return c.url.includes('chat_id=88888') || bodyStr.includes('"chat_id":"88888"') || bodyStr.includes('"chat_id":88888');
			});
			expect(pmCalls.length).toBe(0);

			// Check that answer was sent to group
			const groupSendCalls = telegramCalls.filter((c) => {
				const bodyStr = JSON.stringify(c.body || {});
				return c.url.includes(groupId) || bodyStr.includes(groupId);
			});
			expect(groupSendCalls.length).toBeGreaterThan(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should clamp /summary to 48 hours for normal users when exceeding limit', async () => {
		const groupId = '-100888888';
		await addGroupToWhitelist(testEnv, groupId, 'Authorized Group', '10001');

		// Insert messages: one recent (10h ago) and one old (60h ago)
		await testEnv.DB.prepare(
			'INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)'
		)
			.bind('msg-recent', groupId, Date.now() - 10 * 3600 * 1000, 'Alice', 'Recent discussion', 1, 'Authorized Group')
			.run();

		await testEnv.DB.prepare(
			'INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)'
		)
			.bind('msg-old', groupId, Date.now() - 60 * 3600 * 1000, 'OldUser', 'Old discussion', 2, 'Authorized Group')
			.run();

		let requestedMessages: any[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			const url = typeof input === 'string' ? input : input.url;
			if (url.includes('/chat/completions')) {
				const body = JSON.parse(init.body);
				requestedMessages = body.messages;
				return new Response(
					JSON.stringify({
						id: 'chatcmpl-test',
						object: 'chat.completion',
						created: Math.floor(Date.now() / 1000),
						model: 'gpt-4o-mini',
						choices: [{ index: 0, message: { role: 'assistant', content: '总结内容' }, finish_reason: 'stop' }],
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}
			return new Response(JSON.stringify({ ok: true, result: { message_id: 777 } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}) as any;

		try {
			const testEnvWithModel: Env = {
				...testEnv,
				AI_MODEL: 'gpt-4o-mini',
				AI_API_KEY: 'test-key',
			};

			// Normal user requests 72h summary
			const req = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					update_id: 18,
					message: {
						message_id: 402,
						from: { id: 88888, first_name: 'Alice' },
						chat: { id: parseInt(groupId), title: 'Authorized Group', type: 'supergroup' },
						date: Math.floor(Date.now() / 1000),
						text: '/summary 72h',
					},
				}),
			});

			const res = await worker.fetch(req, testEnvWithModel, mockCtx);
			expect(res.status).toBe(200);

			// AI input should contain recent message, but NOT old message (> 48h)
			const userPromptText = JSON.stringify(requestedMessages);
			expect(userPromptText).toContain('Recent discussion');
			expect(userPromptText).not.toContain('Old discussion');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should query messages without 48h restriction for /ask and notify when empty', async () => {
		const groupId = '-100888888';
		await addGroupToWhitelist(testEnv, groupId, 'Authorized Group', '10001');

		let repliedText = '';
		let aiCalled = false;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			const url = typeof input === 'string' ? input : input.url;
			if (url.includes('/chat/completions')) {
				aiCalled = true;
			}
			if (url.includes('/sendMessage')) {
				const parsed = new URL(url);
				repliedText = parsed.searchParams.get('text') || '';
				if (!repliedText && init?.body) {
					try {
						repliedText = JSON.parse(init.body).text || '';
					} catch (_) {}
				}
			}
			return new Response(JSON.stringify({ ok: true, result: { message_id: 666 } }), { status: 200 });
		}) as any;

		try {
			const testEnvWithModel: Env = {
				...testEnv,
				AI_MODEL: 'gpt-4o-mini',
				AI_API_KEY: 'test-key',
			};

			// 1. When group is empty
			const reqEmpty = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					update_id: 191,
					message: {
						message_id: 403,
						from: { id: 88888, first_name: 'Alice' },
						chat: { id: parseInt(groupId), title: 'Authorized Group', type: 'supergroup' },
						date: Math.floor(Date.now() / 1000),
						text: '/ask 有讨论新功能吗？',
					},
				}),
			});

			const resEmpty = await worker.fetch(reqEmpty, testEnvWithModel, mockCtx);
			expect(resEmpty.status).toBe(200);
			expect(aiCalled).toBe(false);
			expect(repliedText).toContain('暂无消息记录');

			// 2. When message is older than 48h, /ask still works because time is not restricted
			await testEnv.DB.prepare(
				'INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)'
			)
				.bind('msg-old-ask', groupId, Date.now() - 60 * 3600 * 1000, 'OldUser', 'Old topic', 3, 'Authorized Group')
				.run();

			const reqWithOldMsg = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					update_id: 192,
					message: {
						message_id: 404,
						from: { id: 88888, first_name: 'Alice' },
						chat: { id: parseInt(groupId), title: 'Authorized Group', type: 'supergroup' },
						date: Math.floor(Date.now() / 1000),
						text: '/ask 有讨论旧功能吗？',
					},
				}),
			});

			globalThis.fetch = (async (input: any) => {
				const url = typeof input === 'string' ? input : input.url;
				if (url.includes('/chat/completions')) {
					aiCalled = true;
					return new Response(JSON.stringify({
						choices: [{ message: { content: '关于旧功能的回答' } }]
					}), { status: 200, headers: { 'Content-Type': 'application/json' } });
				}
				return new Response(JSON.stringify({ ok: true, result: { message_id: 667 } }), { status: 200 });
			}) as any;

			const resWithOldMsg = await worker.fetch(reqWithOldMsg, testEnvWithModel, mockCtx);
			expect(resWithOldMsg.status).toBe(200);
			expect(aiCalled).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should immediately return ok and ignore duplicate update_id', async () => {
		let callCount = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			callCount++;
			return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
		}) as any;

		try {
			const payload = {
				update_id: 9999,
				message: {
					message_id: 1001,
					from: { id: 55555, first_name: 'Bob' },
					chat: { id: 55555, type: 'private' },
					date: Math.floor(Date.now() / 1000),
					text: '/status',
				},
			};

			const req1 = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			const res1 = await worker.fetch(req1, testEnv, mockCtx);
			expect(res1.status).toBe(200);
			const firstCallCount = callCount;
			expect(firstCallCount).toBeGreaterThan(0);

			// Second request with same update_id (simulating Telegram retry)
			const req2 = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			const res2 = await worker.fetch(req2, testEnv, mockCtx);
			expect(res2.status).toBe(200);
			expect(callCount).toBe(firstCallCount);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should gracefully handle non-message updates like my_chat_member and message_reaction without throwing errors', async () => {
		const testEnv: Env = {
			...env,
			TELEGRAM_BOT_TOKEN: 'test_token',
		};

		// 1. my_chat_member update (e.g. Bot membership/privacy changes)
		const reqMyChatMember = new Request('https://chatgist.example.com/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				update_id: 999,
				my_chat_member: {
					chat: { id: -100888888, type: 'supergroup' },
					from: { id: 10001, first_name: 'Admin' },
					date: Math.floor(Date.now() / 1000),
				},
			}),
		});

		const resMember = await worker.fetch(reqMyChatMember, testEnv, mockCtx);
		expect(resMember.status).toBe(200);

		// 2. message_reaction update
		const reqReaction = new Request('https://chatgist.example.com/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				update_id: 1000,
				message_reaction: {
					chat: { id: -100888888, type: 'supergroup' },
					message_id: 1234,
				},
			}),
		});

		const resReaction = await worker.fetch(reqReaction, testEnv, mockCtx);
		expect(resReaction.status).toBe(200);
	});

	it('should correctly record edited_message into Messages table for authorized group', async () => {
		const testEnv: Env = {
			...env,
			TELEGRAM_BOT_TOKEN: 'test_token',
		};

		// Whitelist group first
		await addGroupToWhitelist(testEnv, '-100888888', 'Authorized Group', '10001');

		const reqEdited = new Request('https://chatgist.example.com/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				update_id: 1001,
				edited_message: {
					message_id: 505,
					from: { id: 88888, first_name: 'Alice' },
					chat: { id: -100888888, title: 'Authorized Group', type: 'supergroup' },
					date: Math.floor(Date.now() / 1000),
					text: 'Updated edited message text',
				},
			}),
		});

		const resEdited = await worker.fetch(reqEdited, testEnv, mockCtx);
		expect(resEdited.status).toBe(200);

		const row = await env.DB.prepare('SELECT * FROM Messages WHERE messageId = ?')
			.bind(505)
			.first();
		expect(row).toBeDefined();
		expect((row as any).content).toBe('Updated edited message text');
	});

	it('should verify secret token authentication when configured', async () => {
		const testEnvWithSecret: Env = {
			...env,
			TELEGRAM_BOT_TOKEN: 'test_token',
			SECRET_TELEGRAM_API_TOKEN: 'super_secret_123',
		};

		// 1. Without matching header -> 403
		const reqUnauthorized = new Request('https://chatgist.example.com/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ update_id: 1002 }),
		});
		const resUnauthorized = await worker.fetch(reqUnauthorized, testEnvWithSecret, mockCtx);
		expect(resUnauthorized.status).toBe(403);

		// 2. With matching header -> 200
		const reqAuthorized = new Request('https://chatgist.example.com/', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Telegram-Bot-Api-Secret-Token': 'super_secret_123',
			},
			body: JSON.stringify({ update_id: 1003 }),
		});
		const resAuthorized = await worker.fetch(reqAuthorized, testEnvWithSecret, mockCtx);
		expect(resAuthorized.status).toBe(200);
	});

	it('should clear group messages using clearGroupMessages', async () => {
		const groupId = '-100999888';
		await addGroupToWhitelist(testEnv, groupId, 'Temp Group', '10001');

		// Insert dummy messages
		await testEnv.DB.prepare(
			'INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)'
		)
			.bind('msg-1', groupId, Date.now(), 'User1', 'Test message 1', 1, 'Temp Group')
			.run();

		await testEnv.DB.prepare(
			'INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)'
		)
			.bind('msg-2', groupId, Date.now(), 'User2', 'Test message 2', 2, 'Temp Group')
			.run();

		const countBefore = await testEnv.DB.prepare('SELECT COUNT(*) as cnt FROM Messages WHERE groupId = ?')
			.bind(groupId)
			.first<number>('cnt');
		expect(countBefore).toBe(2);

		const { clearGroupMessages } = await import('../src/whitelist');
		const cleared = await clearGroupMessages(testEnv, groupId);
		expect(cleared).toBe(2);

		const countAfter = await testEnv.DB.prepare('SELECT COUNT(*) as cnt FROM Messages WHERE groupId = ?')
			.bind(groupId)
			.first<number>('cnt');
		expect(countAfter).toBe(0);
	});

	it('should support pagination and replyMarkup in /query for > 6 messages', async () => {
		const groupId = '-100888888';
		await addGroupToWhitelist(testEnv, groupId, 'Authorized Group', '10001');

		// Insert 8 matching messages
		for (let i = 1; i <= 8; i++) {
			await testEnv.DB.prepare(
				'INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)'
			)
				.bind(`query-msg-${i}`, groupId, Date.now() - i * 1000, `User${i}`, `发布版本更新测试记录 ${i}`, i, 'Authorized Group')
				.run();
		}

		let sentPayload: any = null;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			const url = typeof input === 'string' ? input : input.url;
			if (url.includes('/sendRichMessage') || url.includes('/sendMessage')) {
				if (init?.body) {
					try { sentPayload = JSON.parse(init.body); } catch (_) {}
				}
			}
			return new Response(JSON.stringify({ ok: true, result: { message_id: 1111 } }), { status: 200 });
		}) as any;

		try {
			const req = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					update_id: 201,
					message: {
						message_id: 501,
						from: { id: 88888, first_name: 'Alice' },
						chat: { id: parseInt(groupId), title: 'Authorized Group', type: 'supergroup' },
						date: Math.floor(Date.now() / 1000),
						text: '/query 版本更新',
					},
				}),
			});

			const res = await worker.fetch(req, testEnv, mockCtx);
			expect(res.status).toBe(200);
			expect(sentPayload).toBeDefined();
			expect(sentPayload.reply_markup?.inline_keyboard).toBeDefined();
			expect(sentPayload.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(['【1】', '2']);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should handle callback_query pagination and edit message in-place', async () => {
		const groupId = '-100888888';
		await addGroupToWhitelist(testEnv, groupId, 'Authorized Group', '10001');

		// Insert matching messages
		for (let i = 1; i <= 8; i++) {
			await testEnv.DB.prepare(
				'INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)'
			)
				.bind(`cq-msg-${i}`, groupId, Date.now() - i * 1000, `User${i}`, `发布版本更新测试记录 ${i}`, i, 'Authorized Group')
				.run();
		}

		let answeredCqId = '';
		let editPayload: any = null;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			const url = typeof input === 'string' ? input : input.url;
			if (url.includes('/answerCallbackQuery')) {
				const body = JSON.parse(init?.body || '{}');
				answeredCqId = body.callback_query_id;
			}
			if (url.includes('/editMessageText')) {
				editPayload = JSON.parse(init?.body || '{}');
			}
			return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
		}) as any;

		try {
			const req = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					update_id: 202,
					callback_query: {
						id: 'cq-12345',
						from: { id: 88888, first_name: 'Alice' },
						message: {
							message_id: 1111,
							chat: { id: parseInt(groupId), title: 'Authorized Group', type: 'supergroup' },
						},
						data: 'qp:2:版本更新',
					},
				}),
			});

			const res = await worker.fetch(req, testEnv, mockCtx);
			expect(res.status).toBe(200);
			expect(answeredCqId).toBe('cq-12345');
			expect(editPayload).toBeDefined();
			expect(editPayload.message_id).toBe(1111);
			expect(editPayload.rich_message?.blocks).toBeDefined();
			expect(editPayload.reply_markup?.inline_keyboard[0].map((b: any) => b.text)).toEqual(['1', '【2】']);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should register commands with separate scopes on /setcommands', async () => {
		const commandsCalls: any[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			const url = typeof input === 'string' ? input : input.url;
			if (url.includes('/setMyCommands')) {
				commandsCalls.push(JSON.parse(init?.body || '{}'));
			}
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}) as any;

		try {
			const testEnvAdmin: Env = {
				...testEnv,
				ADMIN_USER_IDS: '10001,10002',
			};

			const req = new Request('https://chatgist.example.com/setcommands', { method: 'GET' });
			const res = await worker.fetch(req, testEnvAdmin, mockCtx);
			expect(res.status).toBe(200);

			expect(commandsCalls.length).toBe(5);

			const groupCall = commandsCalls.find((c) => c.scope?.type === 'all_group_chats');
			expect(groupCall).toBeDefined();
			expect(groupCall.commands.map((c: any) => c.command)).toEqual(['summary', 'ask', 'query']);

			const privateCall = commandsCalls.find((c) => c.scope?.type === 'all_private_chats');
			expect(privateCall).toBeDefined();
			expect(privateCall.commands.map((c: any) => c.command)).toEqual(['status', 'help']);

			const adminCall = commandsCalls.find((c) => c.scope?.type === 'chat' && c.scope?.chat_id === '10001');
			expect(adminCall).toBeDefined();
			expect(adminCall.commands.some((c: any) => c.command === 'addgroup')).toBe(true);
			expect(adminCall.commands.some((c: any) => c.command === 'clearmessages')).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should safely escape glob characters like brackets in /query', async () => {
		const groupId = '-100888888';
		await addGroupToWhitelist(testEnv, groupId, 'Authorized Group', '10001');

		await testEnv.DB.prepare(
			'INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)'
		)
			.bind('msg-bracket', groupId, Date.now(), 'Dev', '遇到 [401] 认证错误排查', 601, 'Authorized Group')
			.run();

		let replied = false;
		let replyBody: any = null;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			replied = true;
			if (init?.body) {
				try { replyBody = JSON.parse(init.body); } catch (_) {}
			}
			return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
		}) as any;

		try {
			const req = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					update_id: 301,
					message: {
						message_id: 602,
						from: { id: 88888, first_name: 'Alice' },
						chat: { id: parseInt(groupId), title: 'Authorized Group', type: 'supergroup' },
						date: Math.floor(Date.now() / 1000),
						text: '/query [401]',
					},
				}),
			});

			const res = await worker.fetch(req, testEnv, mockCtx);
			expect(res.status).toBe(200);
			expect(replied).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should prioritize replied message context in /ask when reply_to_message is present', async () => {
		const groupId = '-100888888';
		await addGroupToWhitelist(testEnv, groupId, 'Authorized Group', '10001');

		await testEnv.DB.prepare(
			'INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)'
		)
			.bind('msg-ask-ref', groupId, Date.now() - 1000, 'Charlie', '配置文件中的 port 设置成了 8080', 701, 'Authorized Group')
			.run();

		let aiMessages: any[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			const url = typeof input === 'string' ? input : input.url;
			if (url.includes('/chat/completions')) {
				const body = JSON.parse(init.body);
				aiMessages = body.messages;
				return new Response(
					JSON.stringify({
						id: 'chatcmpl-ask-test',
						choices: [{ index: 0, message: { role: 'assistant', content: '解答内容' }, finish_reason: 'stop' }],
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}
			return new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }), { status: 200 });
		}) as any;

		try {
			const testEnvWithModel: Env = {
				...testEnv,
				AI_MODEL: 'gpt-4o-mini',
				AI_API_KEY: 'test-key',
			};

			const req = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					update_id: 302,
					message: {
						message_id: 702,
						from: { id: 88888, first_name: 'Alice' },
						chat: { id: parseInt(groupId), title: 'Authorized Group', type: 'supergroup' },
						date: Math.floor(Date.now() / 1000),
						text: '/ask 怎么修改？',
						reply_to_message: {
							message_id: 701,
							from: { id: 66666, first_name: 'Charlie' },
							text: '配置文件中的 port 设置成了 8080',
						},
					},
				}),
			});

			const res = await worker.fetch(req, testEnvWithModel, mockCtx);
			expect(res.status).toBe(200);

			const userPrompt = aiMessages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('怎么修改？'));
			expect(userPrompt).toBeDefined();
			expect(userPrompt.content).toContain('用户重点追问的引用消息');
			expect(userPrompt.content).toContain('Charlie');
			expect(userPrompt.content).toContain('配置文件中的 port 设置成了 8080');
			expect(userPrompt.content).toContain('https://t.me/c/888888/701');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should include latency and connectivity diagnostics for superadmin in /status', async () => {
		const sentMessages: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			const url = typeof input === 'string' ? input : input.url;
			sentMessages.push(url);
			if (url.includes('/models')) {
				return new Response(JSON.stringify({ data: [] }), { status: 200 });
			}
			return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
		}) as any;

		try {
			const testEnvSuper: Env = {
				...testEnv,
				AI_MODEL: 'gpt-4o-mini',
				AI_API_KEY: 'test-key',
			};

			const req = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					update_id: 303,
					message: {
						message_id: 801,
						from: { id: 10001, first_name: 'SuperAdmin' },
						chat: { id: 10001, type: 'private' },
						date: Math.floor(Date.now() / 1000),
						text: '/status',
					},
				}),
			});

			const res = await worker.fetch(req, testEnvSuper, mockCtx);
			expect(res.status).toBe(200);

			expect(sentMessages.length).toBeGreaterThan(0);
			const text = decodeURIComponent(sentMessages.find((u) => u.includes('text=')) || '').replace(/\+/g, ' ');
			expect(text).toContain('系统连通性诊断');
			expect(text).toContain('D1 数据库延迟');
			expect(text).toContain('AI 接口状态');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should isolate quoted photo in user prompt and mask historical photos', async () => {
		const groupId = '-100888888';
		await addGroupToWhitelist(testEnv, groupId, 'Authorized Group', '10001');

		// 1. Insert an older photo message (650)
		await testEnv.DB.prepare(
			'INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName, messageTime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
		)
			.bind('msg-old-photo', groupId, Date.now() - 5000, 'UserOld', 'data:image/jpeg;base64,OLDIMAGE', 650, 'Authorized Group', '2026-09-28 12:00:00')
			.run();

		// 2. Insert the target quoted photo message (701)
		await testEnv.DB.prepare(
			'INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName, messageTime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
		)
			.bind('msg-target-photo', groupId, Date.now() - 1000, 'Alice', 'data:image/jpeg;base64,TARGETIMAGE', 701, 'Authorized Group', '2026-09-28 12:05:00')
			.run();

		let aiMessages: any[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			const url = typeof input === 'string' ? input : input.url;
			if (url.includes('/chat/completions')) {
				const body = JSON.parse(init.body);
				aiMessages = body.messages;
				return new Response(
					JSON.stringify({
						choices: [{ index: 0, message: { role: 'assistant', content: '这是目标图片的内容' } }],
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}
			return new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }), { status: 200 });
		}) as any;

		try {
			const testEnvWithModel: Env = {
				...testEnv,
				AI_MODEL: 'gpt-4o-mini',
				AI_API_KEY: 'test-key',
			};

			const req = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					update_id: 304,
					message: {
						message_id: 702,
						from: { id: 88888, first_name: 'Bob' },
						chat: { id: parseInt(groupId), title: 'Authorized Group', type: 'supergroup' },
						date: Math.floor(Date.now() / 1000),
						text: '/ask 这张图讲了什么？',
						reply_to_message: {
							message_id: 701,
							from: { id: 77777, first_name: 'Alice' },
							photo: [{ file_id: 'photo_701', file_size: 100 }],
						},
					},
				}),
			});

			const res = await worker.fetch(req, testEnvWithModel, mockCtx);
			expect(res.status).toBe(200);

			// History turn (messages[1]): older photo (650) must be masked as [历史图片], not image_url
			const historyTurn = aiMessages[1];
			expect(historyTurn.role).toBe('user');
			const oldImageTurn = historyTurn.content.find((item: any) => item.text && item.text.includes('OLDIMAGE'));
			expect(oldImageTurn).toBeUndefined();
			const maskedTurn = historyTurn.content.find((item: any) => item.text === '[历史图片]');
			expect(maskedTurn).toBeDefined();

			// Question turn (messages[2]): must be an array containing the target image
			const questionTurn = aiMessages[2];
			expect(questionTurn.role).toBe('user');
			expect(Array.isArray(questionTurn.content)).toBe(true);
			const targetImageItem = questionTurn.content.find((item: any) => item.type === 'image_url' && item.image_url?.url === 'data:image/jpeg;base64,TARGETIMAGE');
			expect(targetImageItem).toBeDefined();

			const textItem = questionTurn.content.find((item: any) => item.type === 'text');
			expect(textItem.text).toContain('https://t.me/c/888888/701');
			expect(textItem.text).toContain('这张图讲了什么？');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should automatically migrate table and add messageTime when column does not exist', async () => {
		const groupId = '-100888888';
		await addGroupToWhitelist(testEnv, groupId, 'Authorized Group', '10001');

		// Recreate Messages table WITHOUT messageTime column to simulate legacy table
		await testEnv.DB.prepare('DROP TABLE IF EXISTS Messages').run();
		await testEnv.DB.prepare(`
			CREATE TABLE Messages (
				id TEXT PRIMARY KEY,
				groupId TEXT,
				timeStamp INTEGER NOT NULL,
				userName TEXT,
				content TEXT,
				messageId INTEGER,
				groupName TEXT
			)
		`).run();

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })) as any;

		try {
			const req = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					update_id: 305,
					message: {
						message_id: 901,
						from: { id: 88888, first_name: 'Alice' },
						chat: { id: parseInt(groupId), title: 'Authorized Group', type: 'supergroup' },
						date: Math.floor(Date.now() / 1000),
						text: '这是一条旧表升级测试消息',
					},
				}),
			});

			const res = await worker.fetch(req, testEnv, mockCtx);
			expect(res.status).toBe(200);

			// Verify that the column was added and message was saved
			const record = await testEnv.DB.prepare('SELECT * FROM Messages WHERE messageId = 901').first<any>();
			expect(record).toBeDefined();
			expect(record.content).toBe('这是一条旧表升级测试消息');
			expect(record.messageTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should format legacy records without messageTime using timeStamp fallback', async () => {
		const groupId = '-100888888';
		await addGroupToWhitelist(testEnv, groupId, 'Authorized Group', '10001');

		// Insert legacy message where messageTime is NULL
		const fixedTime = Date.UTC(2024, 2, 28, 16, 0, 0); // 2024-03-28 16:00:00 UTC -> 2024-03-29 00:00:00 Beijing
		await testEnv.DB.prepare(
			'INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName, messageTime) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)'
		)
			.bind('msg-legacy', groupId, fixedTime, 'OldAlice', '旧消息内容', 902, 'Authorized Group')
			.run();

		let aiMessages: any[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			const url = typeof input === 'string' ? input : input.url;
			if (url.includes('/chat/completions')) {
				const body = JSON.parse(init.body);
				aiMessages = body.messages;
				return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }), { status: 200 });
		}) as any;

		try {
			const testEnvWithModel: Env = {
				...testEnv,
				AI_MODEL: 'gpt-4o-mini',
				AI_API_KEY: 'test-key',
			};

			const req = new Request('https://chatgist.example.com/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					update_id: 306,
					message: {
						message_id: 903,
						from: { id: 88888, first_name: 'Bob' },
						chat: { id: parseInt(groupId), title: 'Authorized Group', type: 'supergroup' },
						date: Math.floor(Date.now() / 1000),
						text: '/ask 测试旧消息？',
					},
				}),
			});

			const res = await worker.fetch(req, testEnvWithModel, mockCtx);
			expect(res.status).toBe(200);

			const historyTurn = aiMessages[1];
			const senderItem = historyTurn.content.find((item: any) => item.text && item.text.includes('OldAlice'));
			expect(senderItem).toBeDefined();
			expect(senderItem.text).toContain('2024-03-29 00:00:00');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});




