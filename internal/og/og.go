package og

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"golang.org/x/net/html"
)

var urlRegex = regexp.MustCompile(`https?://[^\s/$.?#].[^\s]*`)

func FindURLs(text string) []string {
	return urlRegex.FindAllString(text, -1)
}

func isPrivateHost(hostname string) bool {
	h := strings.ToLower(strings.TrimSpace(hostname))
	if h == "localhost" || h == "127.0.0.1" || h == "::1" || h == "0.0.0.0" {
		return true
	}

	ip := net.ParseIP(h)
	if ip != nil {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
			return true
		}
	}
	return false
}

func ExtractOGInfo(targetURL string) string {
	parsed, err := url.Parse(targetURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return targetURL
	}
	if isPrivateHost(parsed.Hostname()) {
		return targetURL
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", targetURL, nil)
	if err != nil {
		return targetURL
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; ChatGistBot/1.0; +https://github.com/cuteys/ChatGist)")

	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return targetURL
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return targetURL
	}

	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "text/html") && !strings.Contains(ct, "application/xhtml+xml") {
		return targetURL
	}

	limitedReader := io.LimitReader(resp.Body, 1024*1024)
	doc, err := html.Parse(limitedReader)
	if err != nil {
		return targetURL
	}

	ogData := make(map[string]string)
	var pageTitle string

	var traverse func(*html.Node)
	traverse = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if n.Data == "title" && n.FirstChild != nil && pageTitle == "" {
				pageTitle = strings.TrimSpace(n.FirstChild.Data)
			}
			if n.Data == "meta" {
				var prop, name, content string
				for _, attr := range n.Attr {
					switch strings.ToLower(attr.Key) {
					case "property":
						prop = strings.ToLower(strings.TrimSpace(attr.Val))
					case "name":
						name = strings.ToLower(strings.TrimSpace(attr.Val))
					case "content":
						content = strings.TrimSpace(attr.Val)
					}
				}
				// 忽略空值与内联 data: URI，防止如 data:image/svg+xml 混入正文触发多模态解析失败
				if content != "" && !strings.HasPrefix(strings.ToLower(content), "data:") {
					switch prop {
					case "og:title", "og:description", "og:site_name", "og:type":
						ogData[strings.TrimPrefix(prop, "og:")] = content
					}
					switch name {
					case "description", "twitter:description":
						if ogData["description"] == "" {
							ogData["description"] = content
						}
					case "twitter:title":
						if ogData["title"] == "" {
							ogData["title"] = content
						}
					case "application-name":
						if ogData["site_name"] == "" {
							ogData["site_name"] = content
						}
					}
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			traverse(c)
		}
	}
	traverse(doc)

	if pageTitle != "" && ogData["title"] == "" {
		ogData["title"] = pageTitle
	}
	if len(ogData) == 0 {
		return targetURL
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("%s 的相关信息为:\n", targetURL))
	for _, k := range []string{"title", "site_name", "type", "description"} {
		if v := ogData[k]; v != "" {
			sb.WriteString(fmt.Sprintf("%s: %s\n", k, v))
		}
	}
	return strings.TrimSpace(sb.String())
}
