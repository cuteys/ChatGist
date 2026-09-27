import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	initQuotaTables,
	checkAndIncrementQuota,
	getUserQuotaStatus,
	getCommandLimit,
} from '../src/quota';
import { initWhitelistTables, addAdmin } from '../src/whitelist';

describe('User Quota and Rate Limiting', () => {
	const testEnv: Env = {
		...env,
		ADMIN_USER_IDS: '10001', // Super admin
		LIMIT_SUMMARY: '2',      // Set limit to 2 for quick testing
		LIMIT_ASK: '3',
		LIMIT_QUERY: '4',
	};

	beforeEach(async () => {
		await initQuotaTables(testEnv);
		await initWhitelistTables(testEnv);
		await testEnv.DB.prepare('DELETE FROM UserUsage').run();
		await testEnv.DB.prepare('DELETE FROM WhitelistGroups').run();
		await testEnv.DB.prepare('DELETE FROM Admins').run();
	});

	it('should enforce quota limits for normal users', async () => {
		const normalUser = '99901';

		// 1st summary call -> allowed (1/2)
		const res1 = await checkAndIncrementQuota(testEnv, normalUser, 'summary');
		expect(res1.allowed).toBe(true);
		expect(res1.current).toBe(1);
		expect(res1.limit).toBe(2);

		// 2nd summary call -> allowed (2/2)
		const res2 = await checkAndIncrementQuota(testEnv, normalUser, 'summary');
		expect(res2.allowed).toBe(true);
		expect(res2.current).toBe(2);
		expect(res2.limit).toBe(2);

		// 3rd summary call -> REJECTED (exceeded limit 2)
		const res3 = await checkAndIncrementQuota(testEnv, normalUser, 'summary');
		expect(res3.allowed).toBe(false);
		expect(res3.current).toBe(2);
		expect(res3.limit).toBe(2);

		// Other commands (ask) should still have their independent quota
		const askRes1 = await checkAndIncrementQuota(testEnv, normalUser, 'ask');
		expect(askRes1.allowed).toBe(true);
		expect(askRes1.current).toBe(1);
	});

	it('should exempt super admin and db admin from quota limits', async () => {
		const superAdmin = '10001';
		const dbAdmin = '20001';
		await addAdmin(testEnv, dbAdmin, 'DB Admin Bob', superAdmin);

		// Super admin: always allowed with infinite limit
		for (let i = 0; i < 5; i++) {
			const res = await checkAndIncrementQuota(testEnv, superAdmin, 'summary');
			expect(res.allowed).toBe(true);
			expect(res.limit).toBe(Infinity);
		}

		// DB admin: always allowed with infinite limit
		for (let i = 0; i < 5; i++) {
			const res = await checkAndIncrementQuota(testEnv, dbAdmin, 'summary');
			expect(res.allowed).toBe(true);
			expect(res.limit).toBe(Infinity);
		}
	});

	it('should return accurate quota status', async () => {
		const normalUser = '99902';
		await checkAndIncrementQuota(testEnv, normalUser, 'summary');
		await checkAndIncrementQuota(testEnv, normalUser, 'ask');
		await checkAndIncrementQuota(testEnv, normalUser, 'ask');

		const status = await getUserQuotaStatus(testEnv, normalUser);
		expect(status.isPrivileged).toBe(false);
		expect(status.summary.current).toBe(1);
		expect(status.summary.limit).toBe(2);
		expect(status.ask.current).toBe(2);
		expect(status.ask.limit).toBe(3);
		expect(status.query.current).toBe(0);
		expect(status.query.limit).toBe(4);
	});

	it('should provide default limits when environment variables are not set', () => {
		const emptyEnv: Env = { ...env, LIMIT_SUMMARY: undefined, LIMIT_ASK: undefined, LIMIT_QUERY: undefined, USER_DAILY_LIMIT: undefined };
		expect(getCommandLimit(emptyEnv, 'summary')).toBe(5);
		expect(getCommandLimit(emptyEnv, 'ask')).toBe(5);
		expect(getCommandLimit(emptyEnv, 'query')).toBe(20);
	});
});
