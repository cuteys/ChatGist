package format

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var mdLinkRegex = regexp.MustCompile(`\[([^\]]+)\]\(([^)]+)\)`)

func toSuperscript(num int) string {
	supers := map[rune]string{
		'0': "⁰", '1': "¹", '2': "²", '3': "³", '4': "⁴",
		'5': "⁵", '6': "⁶", '7': "⁷", '8': "⁸", '9': "⁹",
	}
	s := strconv.Itoa(num)
	var sb strings.Builder
	for _, r := range s {
		if sup, ok := supers[r]; ok {
			sb.WriteString(sup)
		} else {
			sb.WriteRune(r)
		}
	}
	return sb.String()
}

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

		sup := toSuperscript(idx)
		return fmt.Sprintf("[%s%s](%s)", prefix, sup, url)
	})
}
