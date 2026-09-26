/**
 * 图像工具向后兼容别名模块
 */
export * from './image';

import { isJPEG } from './image';

/**
 * @deprecated 仅用于兼容旧单元测试，业务层请使用 detectImageMimeType
 */
export function isJPEGBase64(base64String: string): { isValid: boolean; reason: string } {
	try {
		const cleanBase64 = base64String.replace(/^data:image\/jpeg;base64,/, '');
		const binary = atob(cleanBase64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		const valid = isJPEG(bytes);
		return {
			isValid: valid,
			reason: valid ? 'Valid JPEG format' : 'Invalid JPEG header or footer',
		};
	} catch (e) {
		return {
			isValid: false,
			reason: 'Base64 decode failed',
		};
	}
}
