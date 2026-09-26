/**
 * 用户指令使用配额与频次限制模块
 */
import { isAdmin } from './whitelist';

export type TrackedCommand = 'summary' | 'ask' | 'query';

/**
 * 自动初始化用户配额表
 */
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

/**
 * 获取当前北京时间日期字符串（格式：YYYY-MM-DD）
 */
export function getTodayDateString(): string {
	return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

/**
 * 获取指定指令的单日限制次数（优先取环境变量，否则使用默认值）
 */
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

/**
 * 检查并增加用户指定指令的使用次数
 * - 超级管理员与管理员：不受次数限制
 * - 普通用户：超过限制则拒绝执行
 * - 自愈式数据库执行：表存在时直接查询/更新，零多余 DDL 开销
 */
export async function checkAndIncrementQuota(
	env: Env,
	userId: string | number,
	command: TrackedCommand
): Promise<{ allowed: boolean; current: number; limit: number; isPrivileged: boolean }> {
	const uid = userId.toString().trim();
	// 超级管理员与数据库管理员均豁免限制
	if (await isAdmin(env, uid)) {
		return { allowed: true, current: 0, limit: Infinity, isPrivileged: true };
	}

	const limit = getCommandLimit(env, command);
	const today = getTodayDateString();

	const runQuotaQuery = async () => {
		// 1. 查询今日已用次数
		const row = await env.DB.prepare(
			"SELECT count FROM UserUsage WHERE userId = ? AND date = ? AND command = ?"
		)
			.bind(uid, today, command)
			.first<{ count: number }>();

		const currentCount = row?.count || 0;
		if (currentCount >= limit) {
			return { allowed: false, current: currentCount, limit, isPrivileged: false };
		}

		// 2. 增加使用计数 (Atomic UPSERT)
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
		return await runQuotaQuery();
	} catch (e: any) {
		if (e?.message?.includes("no such table")) {
			await initQuotaTables(env);
			try {
				return await runQuotaQuery();
			} catch (retryErr) {
				console.error("Retry quota check failed:", retryErr);
			}
		}
		console.error("Error checking or incrementing quota:", e);
		// 数据库异常兜底：允许正常使用，避免阻断
		return { allowed: true, current: 0, limit, isPrivileged: false };
	}
}

/**
 * 获取用户当前的各项指令配额状态
 */
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
		return await queryStatus();
	} catch (e: any) {
		if (e?.message?.includes("no such table")) {
			await initQuotaTables(env);
			try {
				return await queryStatus();
			} catch (retryErr) {
				console.error("Retry query status failed:", retryErr);
			}
		}
		console.error("Error getting user quota status:", e);
		return {
			isPrivileged: false,
			summary: { current: 0, limit: limits.summary },
			ask: { current: 0, limit: limits.ask },
			query: { current: 0, limit: limits.query },
		};
	}
}

/**
 * 清理 3 天前的历史配额记录，保持表数据精简
 */
export async function cleanOldQuotaRecords(env: Env): Promise<void> {
	try {
		const d = new Date();
		d.setDate(d.getDate() - 3);
		const threeDaysAgo = d.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
		await env.DB.prepare("DELETE FROM UserUsage WHERE date < ?")
			.bind(threeDaysAgo)
			.run();
	} catch (e: any) {
		if (e?.message?.includes("no such table")) {
			await initQuotaTables(env);
			return;
		}
		console.error("Failed to clean old quota records:", e);
	}
}
