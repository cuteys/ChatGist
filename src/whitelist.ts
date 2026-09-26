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

export function isSuperAdmin(env: Env, userId?: string | number): boolean {
	if (!userId) return false;
	const uid = userId.toString().trim();
	if (!uid) return false;

	const envAdminStr = env.ADMIN_USER_IDS || env.ADMIN_USER_ID || "";
	const envAdmins = envAdminStr.split(",").map((s) => s.trim()).filter(Boolean);
	return envAdmins.includes(uid);
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

export async function isGroupWhitelisted(env: Env, groupId?: string | number): Promise<boolean> {
	if (!groupId) return false;
	const gid = groupId.toString().trim();
	if (!gid) return false;

	try {
		const row = await withAutoInit(env, () =>
			env.DB.prepare("SELECT groupId FROM WhitelistGroups WHERE groupId = ?").bind(gid).first()
		);
		return !!row;
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
		const { results } = await withAutoInit(env, () =>
			env.DB.prepare(
				"SELECT groupId, groupName, addedBy, createdAt FROM WhitelistGroups ORDER BY createdAt DESC"
			).all()
		);
		return (results || []) as Array<{ groupId: string; groupName: string; addedBy: string; createdAt: number }>;
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
	const envAdminStr = env.ADMIN_USER_IDS || env.ADMIN_USER_ID || "";
	const envAdmins = envAdminStr.split(",").map((s) => s.trim()).filter(Boolean);
	try {
		const { results } = await withAutoInit(env, () =>
			env.DB.prepare(
				"SELECT userId, userName, addedBy, createdAt FROM Admins ORDER BY createdAt DESC"
			).all()
		);
		return {
			envAdmins,
			dbAdmins: (results || []) as Array<{ userId: string; userName: string; addedBy: string; createdAt: number }>,
		};
	} catch (e) {
		console.error("Failed to list admins:", e);
		return { envAdmins, dbAdmins: [] };
	}
}
