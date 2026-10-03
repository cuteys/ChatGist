import { describe, it, expect } from 'vitest';
import { processMarkdownLinks, toSuperscript } from '../src/richFormat';
import { isJPEG, isJPEGBase64, isPNG, isWEBP, detectImageMimeType } from '../src/image';

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
	});
});

describe("upper number", () => {
	it("should upper number", () => {
		expect(toSuperscript(1234)).toBe("¹²³⁴");
	});
});


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

	it("should validate PNG and WEBP formats correctly", () => {
		const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00]);
		expect(isPNG(pngBytes)).toBe(true);
		expect(detectImageMimeType(pngBytes)).toBe("image/png");

		const webpBytes = new Uint8Array([
			0x52, 0x49, 0x46, 0x46, // RIFF
			0x00, 0x00, 0x00, 0x00,
			0x57, 0x45, 0x42, 0x50, // WEBP
		]);
		expect(isWEBP(webpBytes)).toBe(true);
		expect(detectImageMimeType(webpBytes)).toBe("image/webp");

		const jpegBytes = new Uint8Array([0xFF, 0xD8, 0x00, 0x01, 0xFF, 0xD9]);
		expect(detectImageMimeType(jpegBytes)).toBe("image/jpeg");

		const unknownBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
		expect(detectImageMimeType(unknownBytes)).toBeNull();
	});
});

import { extractAllOGInfo } from "../src/og";
import { formatBeijingTime, getCompletionOptions, getReasoningEffortLadder } from "../src/index";

describe("OG info security", () => {
	it("should reject private and local hosts without fetching", async () => {
		expect(await extractAllOGInfo("http://localhost/test")).toBe("http://localhost/test");
		expect(await extractAllOGInfo("http://127.0.0.1/admin")).toBe("http://127.0.0.1/admin");
		expect(await extractAllOGInfo("http://192.168.1.1/router")).toBe("http://192.168.1.1/router");
		expect(await extractAllOGInfo("ftp://example.com/file")).toBe("ftp://example.com/file");
	});
});

describe("formatBeijingTime", () => {
	it("should format timestamps into UTC+8 YYYY-MM-DD HH:mm:ss", () => {
		const ts = Date.UTC(2026, 8, 28, 0, 0, 0);
		expect(formatBeijingTime(ts)).toBe("2026-09-28 08:00:00");

		const tsCross = Date.UTC(2026, 8, 28, 16, 30, 15);
		expect(formatBeijingTime(tsCross)).toBe("2026-09-29 00:30:15");
	});
});

describe("getReasoningEffortLadder", () => {
	it("should return ladder for medium: medium -> low -> none", () => {
		expect(getReasoningEffortLadder("medium")).toEqual(["medium", "low", "none"]);
		expect(getReasoningEffortLadder()).toEqual(["medium", "low", "none"]);
	});

	it("should return ladder for low: low -> none", () => {
		expect(getReasoningEffortLadder("low")).toEqual(["low", "none"]);
	});

	it("should return ladder for high: high -> medium -> low -> none", () => {
		expect(getReasoningEffortLadder("high")).toEqual(["high", "medium", "low", "none"]);
	});

	it("should return ladder for none or unknown: none -> none", () => {
		expect(getReasoningEffortLadder("none")).toEqual(["none", "none"]);
		expect(getReasoningEffortLadder("off")).toEqual(["none", "none"]);
	});
});

describe("getCompletionOptions", () => {
	it("should default reasoning_effort to medium", () => {
		const options = getCompletionOptions("gemini-2.5-flash");
		expect(options.reasoning_effort).toBe("medium");
		expect(options.max_completion_tokens).toBe(4096);
	});

	it("should omit reasoning_effort and use max_tokens when effort is none", () => {
		const options = getCompletionOptions("gemini-2.5-flash", "none");
		expect(options.reasoning_effort).toBeUndefined();
		expect(options.max_tokens).toBe(4096);
		expect(options.max_completion_tokens).toBeUndefined();
	});

	it("should respect low, medium, and high effort levels", () => {
		const lowOptions = getCompletionOptions("gpt-4o", "low");
		expect(lowOptions.reasoning_effort).toBe("low");
		expect(lowOptions.max_completion_tokens).toBe(4096);

		const highOptions = getCompletionOptions("gpt-4o", "high");
		expect(highOptions.reasoning_effort).toBe("high");
		expect(highOptions.max_completion_tokens).toBe(4096);
	});

	it("should support jsonMode", () => {
		const options = getCompletionOptions("gpt-4o", "none", true);
		expect(options.response_format).toEqual({ type: "json_object" });
	});
});



