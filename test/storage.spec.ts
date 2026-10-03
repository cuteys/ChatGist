import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	formatBytes,
	getDatabaseStorageStats,
	cleanupOldMessagesAndImages,
	checkAndEnforceStorageLimit,
} from '../src/storage';

describe('Storage management tests', () => {
	beforeEach(async () => {
		await env.DB.prepare(`
			CREATE TABLE IF NOT EXISTS Messages (
				id TEXT PRIMARY KEY,
				groupId TEXT,
				timeStamp INTEGER NOT NULL,
				userName TEXT,
				content TEXT,
				messageId INTEGER,
				groupName TEXT,
				messageTime TEXT,
				imageDescription TEXT
			)
		`).run();
		await env.DB.prepare('DELETE FROM Messages').run();
	});

	it('formats bytes into human readable units correctly', () => {
		expect(formatBytes(500)).toBe('500 B');
		expect(formatBytes(1024)).toBe('1.0 KB');
		expect(formatBytes(2048)).toBe('2.0 KB');
		expect(formatBytes(1024 * 1024 * 2.5)).toBe('2.50 MB');
		expect(formatBytes(500 * 1024 * 1024)).toBe('500.00 MB');
	});

	it('calculates database storage stats for groups correctly', async () => {
		const groupId = '-100999999';

		// Insert 5 text messages and 3 images
		for (let i = 1; i <= 5; i++) {
			await env.DB.prepare(
				'INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)'
			)
				.bind(`link_${i}`, groupId, Date.now() + i, 'Alice', `Message content ${i}`, i, 'Test Group')
				.run();
		}

		for (let i = 6; i <= 8; i++) {
			await env.DB.prepare(
				'INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)'
			)
				.bind(`link_${i}`, groupId, Date.now() + i, 'Bob', `data:image/jpeg;base64,mockdata${i}`, i, 'Test Group')
				.run();
		}

		const stats = await getDatabaseStorageStats(env);
		expect(stats.groupStats.length).toBe(1);
		expect(stats.groupStats[0].groupId).toBe(groupId);
		expect(stats.groupStats[0].groupName).toBe('Test Group');
		expect(stats.groupStats[0].totalCount).toBe(8);
		expect(stats.groupStats[0].imageCount).toBe(3);
		expect(stats.groupStats[0].estimatedBytes).toBeGreaterThan(0);
		expect(stats.totalBytes).toBeGreaterThan(0);
		expect(stats.totalTextCount).toBe(5);
		expect(stats.totalImageCount).toBe(3);
	});

	it('cleans up images keeping latest 100 images per group', async () => {
		const groupId = '-100888888';

		// Insert 105 images
		const stmts = [];
		for (let i = 1; i <= 105; i++) {
			stmts.push(
				env.DB.prepare(
					'INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)'
				).bind(`img_${i}`, groupId, 1000000 + i, 'User', `data:image/jpeg;base64,data_${i}`, i, 'Image Group')
			);
		}
		await env.DB.batch(stmts);

		const beforeCountRes = await env.DB.prepare(
			"SELECT COUNT(*) as c FROM Messages WHERE groupId = ? AND content LIKE 'data:image/%'"
		)
			.bind(groupId)
			.first<{ c: number }>();
		expect(beforeCountRes?.c).toBe(105);

		// Run cleanup
		const { imagesCleaned } = await cleanupOldMessagesAndImages(env);
		expect(imagesCleaned).toBe(5);

		const afterCountRes = await env.DB.prepare(
			"SELECT COUNT(*) as c FROM Messages WHERE groupId = ? AND content LIKE 'data:image/%'"
		)
			.bind(groupId)
			.first<{ c: number }>();
		expect(afterCountRes?.c).toBe(100);

		// Verify newest images (id img_6 to img_105) are kept, oldest img_1 to img_5 are removed
		const oldest = await env.DB.prepare("SELECT id FROM Messages WHERE id = 'img_1'").first();
		expect(oldest).toBeNull();
		const newest = await env.DB.prepare("SELECT id FROM Messages WHERE id = 'img_105'").first();
		expect(newest).not.toBeNull();
	});

	it('triggers emergency cleanup and alerts superadmin when storage threshold is exceeded', async () => {
		const testEnv: Env = {
			...env,
			ADMIN_USER_IDS: '10001',
		};
		const groupId = '-100777777';

		// Insert 30 images
		const stmts = [];
		for (let i = 1; i <= 30; i++) {
			stmts.push(
				env.DB.prepare(
					'INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)'
				).bind(`msg_${i}`, groupId, 2000000 + i, 'User', `data:image/jpeg;base64,data_${i}`, i, 'Alert Group')
			);
		}
		await env.DB.batch(stmts);

		let alertSent = false;
		let sentText = '';
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init?: any) => {
			const url = typeof input === 'string' ? input : input.url;
			if (url.includes('/sendMessage')) {
				alertSent = true;
				const body = JSON.parse(init.body);
				sentText = body.text;
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}) as any;

		try {
			// Trigger with 0 MB threshold to force exceed
			const result = await checkAndEnforceStorageLimit(testEnv, 'mock_token', 0);
			expect(result.exceeded).toBe(true);
			expect(alertSent).toBe(true);
			expect(sentText).toContain('数据库存储容量预警与自动清理通知');
			expect(result.notifiedCount).toBe(1);

			// Verify images reduced to latest 20
			const countRes = await env.DB.prepare(
				"SELECT COUNT(*) as c FROM Messages WHERE groupId = ? AND content LIKE 'data:image/%'"
			)
				.bind(groupId)
				.first<{ c: number }>();
			expect(countRes?.c).toBe(20);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('respects LIMIT_GROUP_MESSAGES and LIMIT_GROUP_IMAGES from environment', async () => {
		const customEnv: Env = {
			...env,
			LIMIT_GROUP_MESSAGES: '5',
			LIMIT_GROUP_IMAGES: '2',
		};
		const groupId = '-100666666';

		// Insert 8 text messages and 4 images
		for (let i = 1; i <= 8; i++) {
			await env.DB.prepare(
				'INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)'
			)
				.bind(`text_${i}`, groupId, 3000000 + i, 'User', `Text message ${i}`, i, 'Custom Group')
				.run();
		}
		for (let i = 1; i <= 4; i++) {
			await env.DB.prepare(
				'INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)'
			)
				.bind(`img_${i}`, groupId, 4000000 + i, 'User', `data:image/jpeg;base64,data_${i}`, 10 + i, 'Custom Group')
				.run();
		}

		const { textCleaned, imagesCleaned } = await cleanupOldMessagesAndImages(customEnv);
		expect(textCleaned).toBe(7); // Total messages were 12 (8 text + 4 img), row_num > 5 deleted 7
		expect(imagesCleaned).toBe(2); // 4 images, row_num > 2 deleted 2

		const remainingImages = await env.DB.prepare(
			"SELECT COUNT(*) as c FROM Messages WHERE groupId = ? AND content LIKE 'data:image/%'"
		)
			.bind(groupId)
			.first<{ c: number }>();
		expect(remainingImages?.c).toBe(2);
	});
});
