/**
 * 校验二进制数据是否为合法的 JPEG 图像格式（检查 SOI 和 EOI 标记）
 * 高性能直接读取，无多余内存分配
 */
export function isJPEG(buffer: ArrayBuffer | Uint8Array): boolean {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	if (bytes.length < 4) {
		return false;
	}
	// JPEG SOI (0xFF, 0xD8) 与 EOI (0xFF, 0xD9)
	return (
		bytes[0] === 0xFF &&
		bytes[1] === 0xD8 &&
		bytes[bytes.length - 2] === 0xFF &&
		bytes[bytes.length - 1] === 0xD9
	);
}

/**
 * 校验二进制数据是否为合法的 PNG 格式
 */
export function isPNG(buffer: ArrayBuffer | Uint8Array): boolean {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	if (bytes.length < 8) return false;
	return (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4E &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0D &&
		bytes[5] === 0x0A &&
		bytes[6] === 0x1A &&
		bytes[7] === 0x0A
	);
}

/**
 * 校验二进制数据是否为合法的 WebP 格式
 */
export function isWEBP(buffer: ArrayBuffer | Uint8Array): boolean {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	if (bytes.length < 12) return false;
	// "RIFF" .... "WEBP"
	return (
		bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
		bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
	);
}

/**
 * 检测图片二进制数据的 MIME 类型，支持 JPEG / PNG / WebP
 */
export function detectImageMimeType(buffer: ArrayBuffer | Uint8Array): string | null {
	if (isJPEG(buffer)) return 'image/jpeg';
	if (isPNG(buffer)) return 'image/png';
	if (isWEBP(buffer)) return 'image/webp';
	return null;
}

/**
 * 兼容旧版的 Base64 字符串校验函数
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
