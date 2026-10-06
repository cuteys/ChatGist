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
	var title string

	var traverse func(*html.Node)
	traverse = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if n.Data == "title" && n.FirstChild != nil && title == "" {
				title = strings.TrimSpace(n.FirstChild.Data)
			}
			if n.Data == "meta" {
				var prop, name, content string
				for _, attr := range n.Attr {
					switch strings.ToLower(attr.Key) {
					case "property":
						prop = attr.Val
					case "name":
						name = attr.Val
					case "content":
						content = attr.Val
					}
				}
				if strings.HasPrefix(prop, "og:") && content != "" {
					ogData[strings.TrimPrefix(prop, "og:")] = content
				} else if name != "" && content != "" {
					ogData[name] = content
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			traverse(c)
		}
	}
	traverse(doc)

	if len(ogData) == 0 && title == "" {
		return targetURL
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("%s 的相关信息为:\n", targetURL))
	if title != "" && ogData["title"] == "" {
		sb.WriteString(fmt.Sprintf("title: %s\n", title))
	}
	for k, v := range ogData {
		sb.WriteString(fmt.Sprintf("%s: %s\n", k, v))
	}
	return strings.TrimSpace(sb.String())
}
