export async function extractAllOGInfo(url: string): Promise<string> {
	const ogData = new Map<string, string>();
	try {
		// 增加 3 秒超时限制，防止 slow-loris 或超时外链阻塞 Telegram Webhook
		const response = await fetch(url, {
			signal: AbortSignal.timeout(3000),
			headers: {
				'User-Agent': 'Mozilla/5.0 (compatible; ChatGistBot/1.0; +https://github.com/cuteys/ChatGist)',
			},
		});
		if (!response.ok) {
			return url;
		}

		// 检查 Content-Type，仅处理 HTML 网页，防止下载超大二进制文件或音视频
		const contentType = response.headers.get('content-type') || '';
		if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
			return url;
		}

		class MetaHandler {
			element(element: Element) {
				const propertyValue = element.getAttribute("property");
				// og
				if (propertyValue?.startsWith("og:")) {
					const contentValue = element.getAttribute("content");
					if (contentValue) {
						ogData.set(propertyValue.replace("og:", ""), contentValue);
					}
					element.remove();
				}
				// youtube
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
