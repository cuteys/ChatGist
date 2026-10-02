import OpenAI from 'openai';
import { getMessageLink } from './richFormat';

// Providers sometimes include credentials or echoed request bodies in errors.
function sanitize(value: unknown, secrets: string[], depth = 0, budget = { left: 6000 }): unknown {
	if (budget.left <= 0) return '[TRUNCATED]';
	if (typeof value === 'string') {
		for (const secret of secrets.filter(Boolean)) value = (value as string).split(secret).join('[REDACTED]');
		const text = (value as string).replace(/data:image\/[^\s"']+/gi, '[IMAGE REDACTED]');
		const limit = Math.min(2000, budget.left);
		budget.left -= Math.min(text.length, limit);
		return text.length > limit ? text.slice(0, limit) + '[TRUNCATED]' : text;
	}
	if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
	if (typeof value !== 'object') return undefined;
	if (depth >= 5) return '[TRUNCATED]';
	if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitize(item, secrets, depth + 1, budget));
	return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [
		key,
		/^(messages|content|text|prompt|input|request|request_body|body|headers|authorization|api[_-]?key|token|secret|image_url)$/i.test(key)
			? '[REDACTED]'
			: sanitize(item, secrets, depth + 1, budget),
	]));
}

export function logModelError(
	error: unknown,
	context: { command: string; model: string },
	secrets: string[],
) {
	// Serialize explicitly: Workers may render an Error as only its stack.
	// Include provider diagnostics and selected headers, but never the request payload.
	const details = {
		message: 'AI request failed',
		...context,
		error_name: error instanceof Error ? error.name : 'UnknownError',
		error_stack: error instanceof Error ? sanitize(error.stack, secrets) : undefined,
		error_message: error instanceof Error ? error.message : String(error),
		...(error instanceof Error && 'cause' in error ? {
			cause: sanitize(error.cause instanceof Error ? {
				name: error.cause.name,
				message: error.cause.message,
				code: 'code' in error.cause ? error.cause.code : undefined,
			} : error.cause, secrets),
		} : {}),
		...(error instanceof OpenAI.APIError ? {
			status: error.status,
			code: error.code,
			type: error.type,
			param: error.param,
			request_id: error.requestID,
			upstream_error: sanitize(error.error, secrets),
			response_headers: Object.fromEntries([
				'x-request-id', 'cf-ray', 'retry-after', 'openai-processing-ms',
				'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests',
				'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens',
				'x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens',
			].flatMap(name => {
				const value = error.headers?.get(name);
				return value ? [[name, value]] : [];
			})),
		} : {}),
	};
	details.error_message = sanitize(details.error_message, secrets) as string;
	let serialized = JSON.stringify(details);
	// Providers can echo credentials in their error messages.
	for (const secret of secrets.filter(Boolean)) {
		const escapedSecret = JSON.stringify(secret).slice(1, -1);
		serialized = serialized.split(escapedSecret).join('[REDACTED]');
	}
	console.error(serialized);
}

export interface AdminAlertDetails {
	scene: string;
	groupId?: string;
	groupTitle?: string;
	userId?: string;
	userName?: string;
	messageId?: number;
	error: unknown;
}

function formatBeijingTime(timestamp: number): string {
	const d = new Date(timestamp + 8 * 3600 * 1000);
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export async function notifySuperAdminsError(
	botToken: string,
	adminUserIds: string[],
	details: AdminAlertDetails,
	secrets: string[] = []
): Promise<void> {
	if (!botToken || !adminUserIds || adminUserIds.length === 0) return;

	const errName = details.error instanceof Error ? details.error.name : 'UnknownError';
	const errMessage = details.error instanceof Error ? details.error.message : String(details.error);
	let errStack = details.error instanceof Error && details.error.stack ? details.error.stack : errMessage;

	for (const secret of secrets.filter(Boolean)) {
		errStack = errStack.split(secret).join('[REDACTED]');
	}
	errStack = errStack.replace(/data:image\/[^\s"']+/gi, '[IMAGE REDACTED]');
	if (errStack.length > 1500) {
		errStack = errStack.slice(0, 1500) + '...[TRUNCATED]';
	}

	const directLink = details.groupId && details.messageId
		? getMessageLink({ groupId: details.groupId, messageId: details.messageId })
		: '';

	const timeStr = formatBeijingTime(Date.now());
	const text = `🚨 【ChatGist 系统异常告警】\n` +
		`• 触发场景: ${details.scene}\n` +
		(details.groupTitle ? `• 发生群组: ${details.groupTitle} (ID: ${details.groupId || '未知'})\n` : (details.groupId ? `• 发生群组: ID ${details.groupId}\n` : '')) +
		(details.userName ? `• 触发用户: ${details.userName} (ID: ${details.userId || '未知'})\n` : (details.userId ? `• 触发用户: ID ${details.userId}\n` : '')) +
		(directLink ? `• 目标对话: ${directLink}\n` : '') +
		`• 发生时间: ${timeStr} (北京时间)\n` +
		`• 异常类型: ${errName}\n\n` +
		`📋 错误信息与堆栈:\n` +
		`\`\`\`\n${errStack}\n\`\`\``;

	for (const adminId of adminUserIds) {
		const targetId = adminId.trim();
		if (!targetId) continue;
		try {
			await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chat_id: targetId,
					text,
					disable_web_page_preview: true,
				}),
			});
		} catch (sendErr) {
			console.error(`Failed to send alert to admin ${targetId}:`, sendErr);
		}
	}
}
