import { isAdmin } from './whitelist';

export type TrackedCommand = 'summary' | 'ask' | 'query';

export async function initQuotaTables(env: Env): Promise<void> {
	try {
		await env.DB.batch([
			env.DB.prepare(`
				CREATE TABLE IF NOT EXISTS UserUsage (
					userId TEXT NOT NULL,
					date TEXT NOT NULL,
					command TEXT NOT NULL,
					count INTEGER NOT NULL DEFAULT 0,
					PRIMARY KEY (userId, date, command)
				);
			`),
			env.DB.prepare(`
				CREATE INDEX IF NOT EXISTS idx_userusage_date
				ON UserUsage(date);
			`),
		]);
	} catch (e) {
		console.error("Failed to init quota tables:", e);
	}
}

async function withQuotaAutoInit<T>(env: Env, queryFn: () => Promise<T>): Promise<T> {
	try {
		return await queryFn();
	} catch (e: any) {
		if (e?.message?.includes("no such table")) {
			await initQuotaTables(env);
			return await queryFn();
		}
		throw e;
	}
}

export function getTodayDateString(): string {
	return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

export function getCommandLimit(env: Env, command: TrackedCommand): number {
	const globalLimit = env.USER_DAILY_LIMIT ? parseInt(env.USER_DAILY_LIMIT, 10) : undefined;
	switch (command) {
		case 'summary':
			return env.LIMIT_SUMMARY ? parseInt(env.LIMIT_SUMMARY, 10) : (globalLimit ?? 5);
		case 'ask':
			return env.LIMIT_ASK ? parseInt(env.LIMIT_ASK, 10) : (globalLimit ?? 10);
		case 'query':
			return env.LIMIT_QUERY ? parseInt(env.LIMIT_QUERY, 10) : (globalLimit ?? 20);
		default:
			return 10;
	}
}

export async function checkAndIncrementQuota(
	env: Env,
	userId: string | number,
	command: TrackedCommand
): Promise<{ allowed: boolean; current: number; limit: number; isPrivileged: boolean }> {
	const uid = userId.toString().trim();
	if (await isAdmin(env, uid)) {
		return { allowed: true, current: 0, limit: Infinity, isPrivileged: true };
	}

	const limit = getCommandLimit(env, command);
	const today = getTodayDateString();

	const runQuotaQuery = async () => {
		const row = await env.DB.prepare(
			"SELECT count FROM UserUsage WHERE userId = ? AND date = ? AND command = ?"
		)
			.bind(uid, today, command)
			.first<{ count: number }>();

		const currentCount = row?.count || 0;
		if (currentCount >= limit) {
			return { allowed: false, current: currentCount, limit, isPrivileged: false };
		}

		await env.DB.prepare(`
			INSERT INTO UserUsage (userId, date, command, count)
			VALUES (?1, ?2, ?3, 1)
			ON CONFLICT(userId, date, command)
			DO UPDATE SET count = count + 1
		`)
			.bind(uid, today, command)
			.run();

		return { allowed: true, current: currentCount + 1, limit, isPrivileged: false };
	};

	try {
		return await withQuotaAutoInit(env, runQuotaQuery);
	} catch (e) {
		console.error("Error checking or incrementing quota:", e);
		return { allowed: true, current: 0, limit, isPrivileged: false };
	}
}

export async function getUserQuotaStatus(
	env: Env,
	userId: string | number
): Promise<{
	isPrivileged: boolean;
	summary: { current: number; limit: number };
	ask: { current: number; limit: number };
	query: { current: number; limit: number };
}> {
	const uid = userId.toString().trim();
	const isPrivileged = await isAdmin(env, uid);
	if (isPrivileged) {
		return {
			isPrivileged: true,
			summary: { current: 0, limit: Infinity },
			ask: { current: 0, limit: Infinity },
			query: { current: 0, limit: Infinity },
		};
	}

	const today = getTodayDateString();
	const limits = {
		summary: getCommandLimit(env, 'summary'),
		ask: getCommandLimit(env, 'ask'),
		query: getCommandLimit(env, 'query'),
	};

	const queryStatus = async () => {
		const { results } = await env.DB.prepare(
			"SELECT command, count FROM UserUsage WHERE userId = ? AND date = ?"
		)
			.bind(uid, today)
			.all<{ command: string; count: number }>();

		const usageMap: Record<string, number> = {};
		for (const r of results || []) {
			usageMap[r.command] = r.count;
		}

		return {
			isPrivileged: false,
			summary: { current: usageMap['summary'] || 0, limit: limits.summary },
			ask: { current: usageMap['ask'] || 0, limit: limits.ask },
			query: { current: usageMap['query'] || 0, limit: limits.query },
		};
	};

	try {
		return await withQuotaAutoInit(env, queryStatus);
	} catch (e) {
		console.error("Error getting user quota status:", e);
		return {
			isPrivileged: false,
			summary: { current: 0, limit: limits.summary },
			ask: { current: 0, limit: limits.ask },
			query: { current: 0, limit: limits.query },
		};
	}
}

export async function cleanOldQuotaRecords(env: Env): Promise<void> {
	try {
		const d = new Date();
		d.setDate(d.getDate() - 3);
		const threeDaysAgo = d.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
		await withQuotaAutoInit(env, () =>
			env.DB.prepare("DELETE FROM UserUsage WHERE date < ?").bind(threeDaysAgo).run()
		);
	} catch (e) {
		console.error("Failed to clean old quota records:", e);
	}
}
