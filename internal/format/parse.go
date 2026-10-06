package format

import (
	"encoding/json"
	"regexp"
	"strings"
)

var codeFenceRegex = regexp.MustCompile("(?s)^```(?:json)?\\s*(.*?)\\s*```$")

func CleanCodeFences(text string) string {
	trimmed := strings.TrimSpace(text)
	if match := codeFenceRegex.FindStringSubmatch(trimmed); len(match) > 1 {
		return strings.TrimSpace(match[1])
	}
	return trimmed
}

func ParseRichMessageResponse(raw string) []RichBlock {
	clean := CleanCodeFences(raw)

	if strings.HasPrefix(clean, "{") || strings.HasPrefix(clean, "[") {
		var obj struct {
			RichMessage struct {
				Blocks []RichBlock `json:"blocks"`
			} `json:"rich_message"`
			Blocks []RichBlock `json:"blocks"`
		}
		if err := json.Unmarshal([]byte(clean), &obj); err == nil {
			if len(obj.RichMessage.Blocks) > 0 {
				return obj.RichMessage.Blocks
			}
			if len(obj.Blocks) > 0 {
				return obj.Blocks
			}
		}

		var directBlocks []RichBlock
		if err := json.Unmarshal([]byte(clean), &directBlocks); err == nil && len(directBlocks) > 0 {
			return directBlocks
		}
	}

	return AggregateMarkdownToRichBlocks(clean)
}

func AggregateMarkdownToRichBlocks(markdown string) []RichBlock {
	lines := strings.Split(markdown, "\n")
	var blocks []RichBlock
	var currentParagraph []string

	flushParagraph := func() {
		if len(currentParagraph) > 0 {
			text := strings.TrimSpace(strings.Join(currentParagraph, "\n"))
			if text != "" {
				blocks = append(blocks, RichBlock{
					Type: BlockParagraph,
					Text: text,
				})
			}
			currentParagraph = nil
		}
	}

	for i := 0; i < len(lines); i++ {
		line := lines[i]
		trimmed := strings.TrimSpace(line)

		if trimmed == "" {
			flushParagraph()
			continue
		}

		if strings.HasPrefix(trimmed, "---") || strings.HasPrefix(trimmed, "===") || strings.HasPrefix(trimmed, "━━━━━━━━") {
			flushParagraph()
			blocks = append(blocks, RichBlock{Type: BlockDivider})
			continue
		}

		if strings.HasPrefix(trimmed, "#") {
			flushParagraph()
			headingText := strings.TrimLeft(trimmed, "# ")
			blocks = append(blocks, RichBlock{
				Type: BlockHeading,
				Text: headingText,
			})
			continue
		}

		if strings.HasPrefix(trimmed, ">") {
			flushParagraph()
			var quoteLines []string
			for i < len(lines) && (strings.HasPrefix(strings.TrimSpace(lines[i]), ">") || strings.TrimSpace(lines[i]) == "") {
				qText := strings.TrimPrefix(strings.TrimSpace(lines[i]), ">")
				quoteLines = append(quoteLines, strings.TrimSpace(qText))
				i++
			}
			i--
			blocks = append(blocks, RichBlock{
				Type: BlockQuote,
				Blocks: []RichBlock{
					{
						Type: BlockParagraph,
						Text: strings.TrimSpace(strings.Join(quoteLines, "\n")),
					},
				},
			})
			continue
		}

		if strings.HasPrefix(trimmed, "- [ ]") || strings.HasPrefix(trimmed, "- [x]") || strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") {
			flushParagraph()
			var items []RichListItem
			for i < len(lines) {
				cur := strings.TrimSpace(lines[i])
				if strings.HasPrefix(cur, "- [ ]") {
					items = append(items, RichListItem{
						HasCheckbox: true,
						IsChecked:   false,
						Blocks:      []RichBlock{{Type: BlockParagraph, Text: strings.TrimSpace(cur[5:])}},
					})
				} else if strings.HasPrefix(cur, "- [x]") || strings.HasPrefix(cur, "- [X]") {
					items = append(items, RichListItem{
						HasCheckbox: true,
						IsChecked:   true,
						Blocks:      []RichBlock{{Type: BlockParagraph, Text: strings.TrimSpace(cur[5:])}},
					})
				} else if strings.HasPrefix(cur, "- ") || strings.HasPrefix(cur, "* ") {
					items = append(items, RichListItem{
						Blocks: []RichBlock{{Type: BlockParagraph, Text: strings.TrimSpace(cur[2:])}},
					})
				} else {
					break
				}
				i++
			}
			i--
			blocks = append(blocks, RichBlock{
				Type:  BlockList,
				Items: items,
			})
			continue
		}

		currentParagraph = append(currentParagraph, line)
	}

	flushParagraph()
	if len(blocks) == 0 {
		blocks = append(blocks, RichBlock{
			Type: BlockParagraph,
			Text: "（无概括内容）",
		})
	}
	return blocks
}
