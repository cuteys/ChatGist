// test/index.spec.ts
import { describe, it, expect } from 'vitest';
import { processMarkdownLinks, toSuperscript } from "./../src/index"

describe("test fix link", () => {
	it("should fix link", () => {
		const markdown = `
		这是一个测试文本
		[链接11111](链接11111)     // 完全相同，会被处理
		[链接11111](链接11112221)  // 不完全相同，保持原样
		[另一个文本](链接11112221) // 不相同，保持原样
		[链接22222](链接22222)     // 完全相同，会被处理
		[链接11111](链接11111)     // 完全相同，会复用编号
		`;
		const result = processMarkdownLinks(markdown);
		expect(result).toBe(`
		这是一个测试文本
		[引用¹](链接11111)     // 完全相同，会被处理
		[链接11111](链接11112221)  // 不完全相同，保持原样
		[另一个文本](链接11112221) // 不相同，保持原样
		[引用²](链接22222)     // 完全相同，会被处理
		[引用¹](链接11111)     // 完全相同，会复用编号
		`);
	})
})
describe("upper number", () => {
	it("should upper number", () => {
		expect(toSuperscript(1234)).toBe("¹²³⁴");
	});
});

import { isJPEG, isJPEGBase64 } from "../src/isJpeg";

describe("JPEG validation", () => {
	it("should validate JPEG ArrayBuffer correctly", () => {
		// Valid JPEG: SOI (0xFF, 0xD8) ... EOI (0xFF, 0xD9)
		const validBytes = new Uint8Array([0xFF, 0xD8, 0x01, 0x02, 0xFF, 0xD9]);
		expect(isJPEG(validBytes.buffer)).toBe(true);
		expect(isJPEG(validBytes)).toBe(true);

		// Invalid header
		const invalidHeader = new Uint8Array([0x89, 0x50, 0x01, 0x02, 0xFF, 0xD9]); // PNG header
		expect(isJPEG(invalidHeader.buffer)).toBe(false);

		// Invalid footer
		const invalidFooter = new Uint8Array([0xFF, 0xD8, 0x01, 0x02, 0x00, 0x00]);
		expect(isJPEG(invalidFooter.buffer)).toBe(false);

		// Too short
		expect(isJPEG(new Uint8Array([0xFF, 0xD8]))).toBe(false);
	});

	it("should validate JPEG Base64 correctly", () => {
		// Valid JPEG in base64: /9j/.../9k=
		const base64Str = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD//gATQ2hhdEdpc3T/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9k=";
		expect(isJPEGBase64(base64Str).isValid).toBe(true);
		expect(isJPEGBase64("not-base64").isValid).toBe(false);
	});
});

