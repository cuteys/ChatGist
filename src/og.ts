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
				const propertyValue = element.getAttribute("property");
				if (propertyValue?.startsWith("og:")) {
					const contentValue = element.getAttribute("content");
					if (contentValue) {
						ogData.set(propertyValue.replace("og:", ""), contentValue);
					}
					element.remove();
				}
				const name = element.getAttribute("name");
				const contentValue = element.getAttribute("content");

				if (name && contentValue) {
					ogData.set(name, contentValue);
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
		for (const [key, value] of ogData.entries()) {
			ret += `${key}: ${value}\n`;
		}
		return `${url} 的相关信息为:\n` + ret;
	} catch (error) {
		return url;
	}
}
