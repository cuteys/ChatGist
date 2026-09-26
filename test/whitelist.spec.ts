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
} from '../src/whitelist';

describe('Whitelist and Admin DB operations', () => {
	beforeEach(async () => {
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

import worker from '../src/index';

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
		await testEnv.DB.prepare(`
			CREATE TABLE IF NOT EXISTS Messages (
				id TEXT PRIMARY KEY,
				groupId TEXT,
				timeStamp INTEGER NOT NULL,
				userName TEXT,
				content TEXT,
				messageId INTEGER,
				groupName TEXT
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

	it('should send help to PM and notify group when /help triggered in whitelisted group', async () => {
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

			// Should have sent 2 messages:
			// 1. PM to userId 55555 with full guide
			// 2. Reply in group with concise prompt avoiding spam
			expect(sentMessages.length).toBe(2);
			expect(sentMessages[0]).toContain('chat_id=55555');
			expect(sentMessages[1]).toContain(`chat_id=${groupId}`);
			expect(decodeURIComponent(sentMessages[1])).toContain('完整使用指南已私聊发送给您');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should guide user to PM when /help PM fails in whitelisted group', async () => {
		const groupId = '-100888888';
		await addGroupToWhitelist(testEnv, groupId, 'Authorized Group', '10001');

		const sentMessages: any[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			const url = typeof input === 'string' ? input : input.url;
			sentMessages.push(url);
			// Simulate PM failure (user hasn't started bot)
			if (url.includes('chat_id=55555')) {
				return new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden' }), {
					status: 403,
					headers: { 'Content-Type': 'application/json' },
				});
			}
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
						text: '/help',
					},
				}),
			});

			const res = await worker.fetch(req, testEnv, mockCtx);
			expect(res.status).toBe(200);

			// First tried PM, then replied in group guiding user to PM
			expect(sentMessages.length).toBe(2);
			expect(sentMessages[0]).toContain('chat_id=55555');
			expect(sentMessages[1]).toContain(`chat_id=${groupId}`);
			expect(decodeURIComponent(sentMessages[1])).toContain('为避免群内长消息刷屏');
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

			// Direct reply in private chat with full guide
			expect(sentMessages.length).toBe(1);
			expect(sentMessages[0]).toContain('chat_id=55555');
			expect(decodeURIComponent(sentMessages[0]).replace(/\+/g, ' ')).toContain('ChatGist 群聊助手使用指南');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should respond to /quota command with usage information', async () => {
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
						text: '/quota',
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
});



