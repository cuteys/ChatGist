function isPrivateHost(hostname: string): boolean {
	const h = hostname.toLowerCase().trim();
	if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') {
		return true;
	}
	const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (m) {
		const b1 = parseInt(m[1], 10);
		const b2 = parseInt(m[2], 10);
		if (b1 === 10 || b1 === 127 || b1 === 0) return true;
		if (b1 === 169 && b2 === 254) return true;
		if (b1 === 172 && b2 >= 16 && b2 <= 31) return true;
		if (b1 === 192 && b2 === 168) return true;
	}
	return false;
}

export async function extractAllOGInfo(url: string): Promise<string> {
	const ogData = new Map<string, string>();
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return url;
		}
		if (isPrivateHost(parsed.hostname)) {
			return url;
		}

		const response = await fetch(url, {
			signal: AbortSignal.timeout(3000),
			headers: {
				'User-Agent': 'Mozilla/5.0 (compatible; ChatGistBot/1.0; +https://github.com/cuteys/ChatGist)',
			},
		});
		if (!response.ok) {
			return url;
		}

		const contentType = response.headers.get('content-type') || '';
		if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
			return url;
		}

		const contentLength = Number(response.headers.get('content-length') || '0');
		if (contentLength > 2 * 1024 * 1024) {
			return url;
		}

		class MetaHandler {
			element(element: Element) {
				const prop = (element.getAttribute("property") || "").toLowerCase().trim();
				const name = (element.getAttribute("name") || "").toLowerCase().trim();
				const content = (element.getAttribute("content") || "").trim();

				// 忽略空值与内联 data: URI，防止如 data:image/svg+xml 混入正文触发多模态解析失败
				if (!content || content.toLowerCase().startsWith("data:")) {
					return;
				}

				if (prop === "og:title" || prop === "og:description" || prop === "og:site_name" || prop === "og:type") {
					ogData.set(prop.slice(3), content);
					element.remove();
					return;
				}

				if ((name === "description" || name === "twitter:description") && !ogData.has("description")) {
					ogData.set("description", content);
					element.remove();
				} else if (name === "twitter:title" && !ogData.has("title")) {
					ogData.set("title", content);
					element.remove();
				} else if (name === "application-name" && !ogData.has("site_name")) {
					ogData.set("site_name", content);
					element.remove();
				}
			}
		}
		const rewriter = new HTMLRewriter().on('meta', new MetaHandler());
		await rewriter.transform(response).text();
		if (ogData.size === 0) {
			return url;
		}
		let ret = "";
		for (const key of ["title", "site_name", "type", "description"]) {
			const value = ogData.get(key);
			if (value) {
				ret += `${key}: ${value}\n`;
			}
		}
		return `${url} 的相关信息为:\n` + ret.trimEnd();
	} catch (error) {
		return url;
	}
}
