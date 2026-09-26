export interface GroupStorageStat {
	groupId: string;
	groupName: string;
	totalCount: number;
	imageCount: number;
	estimatedBytes: number;
}

export interface DatabaseStorageStats {
	totalBytes: number;
	limitBytes: number;
	groupStats: GroupStorageStat[];
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 统计各群组消息量、图片数与数据库空间占用
 */
export async function getDatabaseStorageStats(env: Env): Promise<DatabaseStorageStats> {
	const limitBytes = 500 * 1024 * 1024; // Cloudflare D1 免费上限 500 MB

	let groupStats: GroupStorageStat[] = [];
	try {
		const res = await env.DB.prepare(`
			SELECT
				groupId,
				groupName,
				COUNT(*) as total_count,
				SUM(CASE WHEN content LIKE 'data:image/%' THEN 1 ELSE 0 END) as image_count,
				COALESCE(SUM(LENGTH(content) + LENGTH(userName) + 64), 0) as estimated_bytes
			FROM Messages
			GROUP BY groupId
			ORDER BY estimated_bytes DESC
		`).all<any>();

		groupStats = (res.results || []).map((r) => ({
			groupId: r.groupId?.toString() || '',
			groupName: r.groupName || '未命名群组',
			totalCount: Number(r.total_count) || 0,
			imageCount: Number(r.image_count) || 0,
			estimatedBytes: Number(r.estimated_bytes) || 0,
		}));
	} catch (e) {
		console.error("Failed to query group stats:", e);
	}

	let totalBytes = 0;
	try {
		const pcRes: any = await env.DB.prepare("PRAGMA page_count").first();
		const psRes: any = await env.DB.prepare("PRAGMA page_size").first();
		const pc = pcRes ? Number(Object.values(pcRes)[0]) : 0;
		const ps = psRes ? Number(Object.values(psRes)[0]) : 0;
		if (pc > 0 && ps > 0) {
			totalBytes = pc * ps;
		}
	} catch {
		// PRAGMA 读失败时回退为各群占用估算和
	}

	if (totalBytes === 0) {
		totalBytes = groupStats.reduce((sum, g) => sum + g.estimatedBytes, 0);
	}

	return {
		totalBytes,
		limitBytes,
		groupStats,
	};
}

/**
 * 常规清理：各群保留最新 3000 条消息，且图片仅保留最新 100 张
 */
export async function cleanupOldMessagesAndImages(env: Env): Promise<{ textCleaned: number; imagesCleaned: number }> {
	let textCleaned = 0;
	let imagesCleaned = 0;

	try {
		// 1. 各群文本消息保留最新 3000 条
		const textRes = await env.DB.prepare(`
			DELETE FROM Messages
			WHERE id IN (
				SELECT id
				FROM (
					SELECT
						id,
						ROW_NUMBER() OVER (
							PARTITION BY groupId
							ORDER BY timeStamp DESC
						) as row_num
					FROM Messages
				) ranked
				WHERE row_num > 3000
			);
		`).run();
		textCleaned = textRes?.meta?.changes || 0;

		// 2. 各群图片保留最新 100 张
		const imgRes = await env.DB.prepare(`
			DELETE FROM Messages
			WHERE id IN (
				SELECT id
				FROM (
					SELECT
						id,
						ROW_NUMBER() OVER (
							PARTITION BY groupId
							ORDER BY timeStamp DESC
						) as row_num
					FROM Messages
					WHERE content LIKE 'data:image/%'
				) ranked_img
				WHERE row_num > 100
			);
		`).run();
		imagesCleaned = imgRes?.meta?.changes || 0;
	} catch (e) {
		console.error("Failed to cleanup old messages/images:", e);
	}

	return { textCleaned, imagesCleaned };
}

/**
 * 存储容量监控与超限紧急自动清理，并向超级管理员发送告警通知
 */
export async function checkAndEnforceStorageLimit(
	env: Env,
	botToken: string,
	thresholdMb = 400
): Promise<{ exceeded: boolean; beforeBytes: number; afterBytes: number; notifiedCount: number }> {
	const thresholdBytes = thresholdMb * 1024 * 1024;
	const stats = await getDatabaseStorageStats(env);

	if (stats.totalBytes <= thresholdBytes) {
		return { exceeded: false, beforeBytes: stats.totalBytes, afterBytes: stats.totalBytes, notifiedCount: 0 };
	}

	console.warn(`Database storage threshold exceeded: ${stats.totalBytes} > ${thresholdBytes}. Executing emergency cleanup.`);

	// 紧急清理：各群图片缩减至最新 20 张，消息缩减至最新 500 条
	try {
		await env.DB.batch([
			env.DB.prepare(`
				DELETE FROM Messages
				WHERE id IN (
					SELECT id
					FROM (
						SELECT
							id,
							ROW_NUMBER() OVER (
								PARTITION BY groupId
								ORDER BY timeStamp DESC
							) as row_num
						FROM Messages
						WHERE content LIKE 'data:image/%'
					) ranked_img
					WHERE row_num > 20
				);
			`),
			env.DB.prepare(`
				DELETE FROM Messages
				WHERE id IN (
					SELECT id
					FROM (
						SELECT
							id,
							ROW_NUMBER() OVER (
								PARTITION BY groupId
								ORDER BY timeStamp DESC
							) as row_num
						FROM Messages
					) ranked_msg
					WHERE row_num > 500
				);
			`),
		]);
	} catch (e) {
		console.error("Emergency cleanup failed:", e);
	}

	const afterStats = await getDatabaseStorageStats(env);

	// 发送告警通知给超级管理员
	let notifiedCount = 0;
	if (botToken) {
		const rawAdmins = env.ADMIN_USER_IDS || env.ADMIN_USER_ID || '';
		const superAdmins = rawAdmins.split(',').map((s) => s.trim()).filter(Boolean);

		const alertText =
			`⚠️ 【数据库存储容量预警与自动清理通知】\n\n` +
			`检测到 D1 数据库容量已达安全预警阈值：\n` +
			`• 清理前容量：${formatBytes(stats.totalBytes)} / 500 MB\n` +
			`• 预警阈值：${thresholdMb} MB\n` +
			`• 处置动作：已自动对历史图片和超额消息执行紧急精简\n` +
			`• 清理后容量：${formatBytes(afterStats.totalBytes)}\n\n` +
			`各群核心最新消息已保留，系统正常运行中。`;

		for (const adminId of superAdmins) {
			try {
				const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						chat_id: adminId,
						text: alertText,
					}),
				});
				if (res.ok) notifiedCount++;
			} catch (err) {
				console.error(`Failed to notify superadmin ${adminId}:`, err);
			}
		}
	}

	return {
		exceeded: true,
		beforeBytes: stats.totalBytes,
		afterBytes: afterStats.totalBytes,
		notifiedCount,
	};
}
