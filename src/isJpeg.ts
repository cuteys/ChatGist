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
