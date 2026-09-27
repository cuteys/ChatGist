export async function initWhitelistTables(env: Env): Promise<void> {
	try {
		await env.DB.batch([
			env.DB.prepare(`
				CREATE TABLE IF NOT EXISTS WhitelistGroups (
					groupId TEXT PRIMARY KEY,
					groupName TEXT,
					addedBy TEXT,
					createdAt INTEGER NOT NULL
				);
			`),
			env.DB.prepare(`
				CREATE TABLE IF NOT EXISTS Admins (
					userId TEXT PRIMARY KEY,
					userName TEXT,
					addedBy TEXT,
					createdAt INTEGER NOT NULL
				);
			`),
		]);
	} catch (e) {
		console.error("Failed to init whitelist/admin tables:", e);
	}
}

async function withAutoInit<T>(env: Env, queryFn: () => Promise<T>): Promise<T> {
	try {
		return await queryFn();
	} catch (e: any) {
		if (e?.message?.includes("no such table")) {
			await initWhitelistTables(env);
			return await queryFn();
		}
		throw e;
	}
}

export function getSuperAdminIds(env: Env): string[] {
	const envAdminStr = env.ADMIN_USER_IDS || env.ADMIN_USER_ID || "";
	return envAdminStr.split(",").map((s: string) => s.trim()).filter(Boolean);
}

export function isSuperAdmin(env: Env, userId?: string | number): boolean {
	if (!userId) return false;
	const uid = userId.toString().trim();
	if (!uid) return false;
	return getSuperAdminIds(env).includes(uid);
}

export async function isAdmin(env: Env, userId?: string | number): Promise<boolean> {
	if (!userId) return false;
	const uid = userId.toString().trim();
	if (!uid) return false;

	if (isSuperAdmin(env, uid)) {
		return true;
	}

	try {
		const row = await withAutoInit(env, () =>
			env.DB.prepare("SELECT userId FROM Admins WHERE userId = ?").bind(uid).first()
		);
		return !!row;
	} catch (e) {
		console.error("Error checking admin status:", e);
		return false;
	}
}

let whitelistCache: { set: Set<string>; expireAt: number } | null = null;
const WHITELIST_CACHE_TTL_MS = 60 * 1000;

export function invalidateWhitelistCache(): void {
	whitelistCache = null;
}

export async function isGroupWhitelisted(env: Env, groupId?: string | number): Promise<boolean> {
	if (!groupId) return false;
	const gid = groupId.toString().trim();
	if (!gid) return false;

	const now = Date.now();
	if (whitelistCache && whitelistCache.expireAt > now) {
		return whitelistCache.set.has(gid);
	}

	try {
		const groups = await getWhitelistedGroups(env);
		const set = new Set(groups.map((g) => g.groupId));
		whitelistCache = { set, expireAt: now + WHITELIST_CACHE_TTL_MS };
		return set.has(gid);
	} catch (e) {
		console.error("Error checking group whitelist status:", e);
		return false;
	}
}

export async function addGroupToWhitelist(
	env: Env,
	groupId: string,
	groupName: string,
	addedBy: string
): Promise<boolean> {
	try {
		await withAutoInit(env, () =>
			env.DB.prepare(
				"INSERT OR REPLACE INTO WhitelistGroups (groupId, groupName, addedBy, createdAt) VALUES (?, ?, ?, ?)"
			)
				.bind(groupId, groupName || "未命名群组", addedBy, Date.now())
				.run()
		);
		invalidateWhitelistCache();
		return true;
	} catch (e) {
		console.error("Failed to add group to whitelist:", e);
		return false;
	}
}

export async function removeGroupFromWhitelist(env: Env, groupId: string): Promise<boolean> {
	try {
		await withAutoInit(env, () =>
			env.DB.prepare("DELETE FROM WhitelistGroups WHERE groupId = ?").bind(groupId).run()
		);
		invalidateWhitelistCache();
		return true;
	} catch (e) {
		console.error("Failed to remove group from whitelist:", e);
		return false;
	}
}

export async function getWhitelistedGroups(env: Env): Promise<
	Array<{ groupId: string; groupName: string; addedBy: string; createdAt: number }>
> {
	try {
		const res = await withAutoInit(env, () =>
			env.DB.prepare(
				"SELECT groupId, groupName, addedBy, createdAt FROM WhitelistGroups ORDER BY createdAt DESC"
			).all<{ groupId: string; groupName: string; addedBy: string; createdAt: number }>()
		);
		return (res?.results || []) as Array<{ groupId: string; groupName: string; addedBy: string; createdAt: number }>;
	} catch (e) {
		console.error("Failed to list whitelisted groups:", e);
		return [];
	}
}

export async function addAdmin(env: Env, userId: string, userName: string, addedBy: string): Promise<boolean> {
	try {
		await withAutoInit(env, () =>
			env.DB.prepare(
				"INSERT OR REPLACE INTO Admins (userId, userName, addedBy, createdAt) VALUES (?, ?, ?, ?)"
			)
				.bind(userId, userName || "管理员", addedBy, Date.now())
				.run()
		);
		return true;
	} catch (e) {
		console.error("Failed to add admin:", e);
		return false;
	}
}

export async function removeAdmin(env: Env, userId: string): Promise<boolean> {
	try {
		await withAutoInit(env, () =>
			env.DB.prepare("DELETE FROM Admins WHERE userId = ?").bind(userId).run()
		);
		return true;
	} catch (e) {
		console.error("Failed to remove admin:", e);
		return false;
	}
}

export async function getAdmins(env: Env): Promise<{
	envAdmins: string[];
	dbAdmins: Array<{ userId: string; userName: string; addedBy: string; createdAt: number }>;
}> {
	const envAdmins = getSuperAdminIds(env);
	try {
		const res = await withAutoInit(env, () =>
			env.DB.prepare(
				"SELECT userId, userName, addedBy, createdAt FROM Admins ORDER BY createdAt DESC"
			).all<{ userId: string; userName: string; addedBy: string; createdAt: number }>()
		);
		return {
			envAdmins,
			dbAdmins: (res?.results || []) as Array<{ userId: string; userName: string; addedBy: string; createdAt: number }>,
		};
	} catch (e) {
		console.error("Failed to list admins:", e);
		return { envAdmins, dbAdmins: [] };
	}
}

/**
 * 清除指定群组的所有历史消息记录（超级管理员维护使用）
 */
export async function clearGroupMessages(env: Env, groupId: string): Promise<number> {
	try {
		const res = await env.DB.prepare("DELETE FROM Messages WHERE groupId = ?")
			.bind(groupId)
			.run();
		return res?.meta?.changes || 0;
	} catch (e) {
		console.error("Failed to clear group messages:", e);
		return 0;
	}
}

