/**
 * 白名单与管理员数据库存储与鉴权模块
 */

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

/**
 * 检查指定用户是否为系统超级管理员（仅通过环境变量 ADMIN_USER_IDS / ADMIN_USER_ID 配置）
 */
export function isSuperAdmin(env: Env, userId?: string | number): boolean {
	if (!userId) return false;
	const uid = userId.toString().trim();
	if (!uid) return false;

	const envAdminStr = env.ADMIN_USER_IDS || env.ADMIN_USER_ID || "";
	const envAdmins = envAdminStr.split(",").map((s) => s.trim()).filter(Boolean);
	return envAdmins.includes(uid);
}

/**
 * 检查指定用户是否为管理员（支持环境变量超级管理员与数据库动态管理员）
 */
export async function isAdmin(env: Env, userId?: string | number): Promise<boolean> {
	if (!userId) return false;
	const uid = userId.toString().trim();
	if (!uid) return false;

	// 1. 优先检查超级管理员
	if (isSuperAdmin(env, uid)) {
		return true;
	}

	// 2. 检查数据库中配置的普通管理员（自愈式查询：表存在则直接查，表不存在才建表）
	try {
		const row = await env.DB.prepare("SELECT userId FROM Admins WHERE userId = ?")
			.bind(uid)
			.first();
		return !!row;
	} catch (e: any) {
		if (e?.message?.includes("no such table")) {
			await initWhitelistTables(env);
			const row = await env.DB.prepare("SELECT userId FROM Admins WHERE userId = ?")
				.bind(uid)
				.first();
			return !!row;
		}
		console.error("Error checking admin status:", e);
		return false;
	}
}

/**
 * 检查指定群组是否在白名单中
 */
export async function isGroupWhitelisted(env: Env, groupId?: string | number): Promise<boolean> {
	if (!groupId) return false;
	const gid = groupId.toString().trim();
	if (!gid) return false;

	try {
		const row = await env.DB.prepare("SELECT groupId FROM WhitelistGroups WHERE groupId = ?")
			.bind(gid)
			.first();
		return !!row;
	} catch (e: any) {
		if (e?.message?.includes("no such table")) {
			await initWhitelistTables(env);
			const row = await env.DB.prepare("SELECT groupId FROM WhitelistGroups WHERE groupId = ?")
				.bind(gid)
				.first();
			return !!row;
		}
		console.error("Error checking group whitelist status:", e);
		return false;
	}
}

/**
 * 添加群组至白名单
 */
export async function addGroupToWhitelist(
	env: Env,
	groupId: string,
	groupName: string,
	addedBy: string
): Promise<boolean> {
	try {
		await env.DB.prepare(
			"INSERT OR REPLACE INTO WhitelistGroups (groupId, groupName, addedBy, createdAt) VALUES (?, ?, ?, ?)"
		)
			.bind(groupId, groupName || "未命名群组", addedBy, Date.now())
			.run();
		return true;
	} catch (e: any) {
		if (e?.message?.includes("no such table")) {
			await initWhitelistTables(env);
			await env.DB.prepare(
				"INSERT OR REPLACE INTO WhitelistGroups (groupId, groupName, addedBy, createdAt) VALUES (?, ?, ?, ?)"
			)
				.bind(groupId, groupName || "未命名群组", addedBy, Date.now())
				.run();
			return true;
		}
		console.error("Failed to add group to whitelist:", e);
		return false;
	}
}

/**
 * 从白名单移除群组
 */
export async function removeGroupFromWhitelist(env: Env, groupId: string): Promise<boolean> {
	try {
		await env.DB.prepare("DELETE FROM WhitelistGroups WHERE groupId = ?")
			.bind(groupId)
			.run();
		return true;
	} catch (e: any) {
		if (e?.message?.includes("no such table")) {
			await initWhitelistTables(env);
			await env.DB.prepare("DELETE FROM WhitelistGroups WHERE groupId = ?")
				.bind(groupId)
				.run();
			return true;
		}
		console.error("Failed to remove group from whitelist:", e);
		return false;
	}
}

/**
 * 获取所有白名单群组
 */
export async function getWhitelistedGroups(env: Env): Promise<
	Array<{ groupId: string; groupName: string; addedBy: string; createdAt: number }>
> {
	try {
		const { results } = await env.DB.prepare(
			"SELECT groupId, groupName, addedBy, createdAt FROM WhitelistGroups ORDER BY createdAt DESC"
		).all();
		return (results || []) as Array<{ groupId: string; groupName: string; addedBy: string; createdAt: number }>;
	} catch (e: any) {
		if (e?.message?.includes("no such table")) {
			await initWhitelistTables(env);
			const { results } = await env.DB.prepare(
				"SELECT groupId, groupName, addedBy, createdAt FROM WhitelistGroups ORDER BY createdAt DESC"
			).all();
			return (results || []) as Array<{ groupId: string; groupName: string; addedBy: string; createdAt: number }>;
		}
		console.error("Failed to list whitelisted groups:", e);
		return [];
	}
}

/**
 * 添加新管理员
 */
export async function addAdmin(env: Env, userId: string, userName: string, addedBy: string): Promise<boolean> {
	try {
		await env.DB.prepare(
			"INSERT OR REPLACE INTO Admins (userId, userName, addedBy, createdAt) VALUES (?, ?, ?, ?)"
		)
			.bind(userId, userName || "管理员", addedBy, Date.now())
			.run();
		return true;
	} catch (e: any) {
		if (e?.message?.includes("no such table")) {
			await initWhitelistTables(env);
			await env.DB.prepare(
				"INSERT OR REPLACE INTO Admins (userId, userName, addedBy, createdAt) VALUES (?, ?, ?, ?)"
			)
				.bind(userId, userName || "管理员", addedBy, Date.now())
				.run();
			return true;
		}
		console.error("Failed to add admin:", e);
		return false;
	}
}

/**
 * 移除管理员
 */
export async function removeAdmin(env: Env, userId: string): Promise<boolean> {
	try {
		await env.DB.prepare("DELETE FROM Admins WHERE userId = ?")
			.bind(userId)
			.run();
		return true;
	} catch (e: any) {
		if (e?.message?.includes("no such table")) {
			await initWhitelistTables(env);
			await env.DB.prepare("DELETE FROM Admins WHERE userId = ?")
				.bind(userId)
				.run();
			return true;
		}
		console.error("Failed to remove admin:", e);
		return false;
	}
}

/**
 * 获取所有管理员（包含环境变量超级管理员与数据库管理员）
 */
export async function getAdmins(env: Env): Promise<{
	envAdmins: string[];
	dbAdmins: Array<{ userId: string; userName: string; addedBy: string; createdAt: number }>;
}> {
	const envAdminStr = env.ADMIN_USER_IDS || env.ADMIN_USER_ID || "";
	const envAdmins = envAdminStr.split(",").map((s) => s.trim()).filter(Boolean);
	try {
		const { results } = await env.DB.prepare(
			"SELECT userId, userName, addedBy, createdAt FROM Admins ORDER BY createdAt DESC"
		).all();
		return {
			envAdmins,
			dbAdmins: (results || []) as Array<{ userId: string; userName: string; addedBy: string; createdAt: number }>,
		};
	} catch (e: any) {
		if (e?.message?.includes("no such table")) {
			await initWhitelistTables(env);
			const { results } = await env.DB.prepare(
				"SELECT userId, userName, addedBy, createdAt FROM Admins ORDER BY createdAt DESC"
			).all();
			return {
				envAdmins,
				dbAdmins: (results || []) as Array<{ userId: string; userName: string; addedBy: string; createdAt: number }>,
			};
		}
		console.error("Failed to list admins:", e);
		return { envAdmins, dbAdmins: [] };
	}
}
