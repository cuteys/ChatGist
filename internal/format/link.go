package format

import (
	"fmt"
	"regexp"

	"github.com/cuteys/ChatGist/internal/telegram"
)

var mdLinkRegex = regexp.MustCompile(`\[([^\]]+)\]\(([^)]+)\)`)

func ProcessMarkdownLinks(text string, prefix string) string {
	if prefix == "" {
		prefix = "引用"
	}

	linkMap := make(map[string]int)
	counter := 1

	return mdLinkRegex.ReplaceAllStringFunc(text, func(match string) string {
		sub := mdLinkRegex.FindStringSubmatch(match)
		if len(sub) < 3 {
			return match
		}
		displayText := sub[1]
		url := sub[2]

		if displayText != url {
			return match
		}

		idx, exists := linkMap[url]
		if !exists {
			idx = counter
			linkMap[url] = counter
			counter++
		}

		sup := telegram.ToSuperscript(idx)
		return fmt.Sprintf("[%s%s](%s)", prefix, sup, url)
	})
}
