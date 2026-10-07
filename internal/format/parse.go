package format

import (
	"encoding/json"
	"regexp"
	"strings"
)

var codeFenceRegex = regexp.MustCompile("(?s)^```(?:json)?\\s*(.*?)\\s*```$")
var detailsRegex = regexp.MustCompile("(?is)<details>\\s*<summary>(.*?)</summary>(.*?)</details>")
var headingRegex = regexp.MustCompile(`^(#{1,6})\s+(.+)$`)
var tableDividerRegex = regexp.MustCompile(`^\|?\s*:?-+:?\s*(\|.*)?$`)
var checkboxRegex = regexp.MustCompile(`^[-*•]\s+\[([ xX])\]\s+(.+)$`)
var bulletRegex = regexp.MustCompile(`^(?:[-*•]|\d+\.)\s+(.+)$`)
var inlineTokenRegex = regexp.MustCompile(`(\[([^\]]+)\]\((https?://[^\s)]+)\)|https?://(?:t\.me/c|tme\.cat)/[^\s,，。！!？?)]+|\*\*([^*]+)\*\*|__([^_]+)__|` + "`([^`]+)`" + `|==([^=]+)==|\*([^*]+)\*|_([^_]+)_|(?:/([a-zA-Z0-9_]{1,64})))`)

// ParseRichInline 解析单行内的 Markdown/Telegram 样式元素
func ParseRichInline(text string) interface{} {
	if text == "" {
		return ""
	}

	matches := inlineTokenRegex.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		return text
	}

	var parts []interface{}
	lastIndex := 0

	for _, m := range matches {
		matchStart := m[0]
		matchEnd := m[1]

		if matchStart > lastIndex {
			parts = append(parts, text[lastIndex:matchStart])
		}

		fullMatch := text[matchStart:matchEnd]

		// 检查匹配到的分组
		if m[4] != -1 && m[6] != -1 {
			// [linkText](url)
			linkText := text[m[4]:m[5]]
			url := text[m[6]:m[7]]
			parts = append(parts, map[string]interface{}{
				"type": "url",
				"text": ParseRichInline(linkText),
				"url":  url,
			})
		} else if strings.HasPrefix(fullMatch, "http://") || strings.HasPrefix(fullMatch, "https://") {
			parts = append(parts, map[string]interface{}{
				"type": "url",
				"text": "💬 原文",
				"url":  fullMatch,
			})
		} else if m[8] != -1 || m[10] != -1 {
			// **bold** or __bold__
			boldText := ""
			if m[8] != -1 {
				boldText = text[m[8]:m[9]]
			} else {
				boldText = text[m[10]:m[11]]
			}
			parts = append(parts, map[string]interface{}{
				"type": "bold",
				"text": ParseRichInline(boldText),
			})
		} else if m[12] != -1 {
			// `code`
			parts = append(parts, map[string]interface{}{
				"type": "code",
				"text": text[m[12]:m[13]],
			})
		} else if m[14] != -1 {
			// ==marked==
			parts = append(parts, map[string]interface{}{
				"type": "marked",
				"text": text[m[14]:m[15]],
			})
		} else if m[16] != -1 || m[18] != -1 {
			// *italic* or _italic_
			italicText := ""
			if m[16] != -1 {
				italicText = text[m[16]:m[17]]
			} else {
				italicText = text[m[18]:m[19]]
			}
			parts = append(parts, map[string]interface{}{
				"type": "italic",
				"text": italicText,
			})
		} else if m[20] != -1 {
			// /bot_command
			cmd := text[m[20]:m[21]]
			parts = append(parts, map[string]interface{}{
				"type":        "bot_command",
				"text":        "/" + cmd,
				"bot_command": cmd,
			})
		} else {
			parts = append(parts, fullMatch)
		}

		lastIndex = matchEnd
	}

	if lastIndex < len(text) {
		parts = append(parts, text[lastIndex:])
	}

	if len(parts) == 1 {
		return parts[0]
	}
	return parts
}

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

func AggregateMarkdownToRichBlocks(content string) []RichBlock {
	raw := strings.TrimSpace(content)
	if strings.HasPrefix(raw, "```") {
		raw = CleanCodeFences(raw)
	}

	// 1. 若包含 <details><summary> 标签，切分处理
	if strings.Contains(strings.ToLower(raw), "<details>") && strings.Contains(strings.ToLower(raw), "</details>") {
		var blocks []RichBlock
		matches := detailsRegex.FindAllStringSubmatchIndex(raw, -1)
		lastIdx := 0

		for _, m := range matches {
			if m[0] > lastIdx {
				before := strings.TrimSpace(raw[lastIdx:m[0]])
				if before != "" {
					blocks = append(blocks, parseMarkdownSectionBlocks(before)...)
				}
			}

			summary := strings.TrimSpace(raw[m[2]:m[3]])
			inner := strings.TrimSpace(raw[m[4]:m[5]])
			innerBlocks := parseMarkdownSectionBlocks(inner)
			if len(innerBlocks) == 0 {
				innerBlocks = []RichBlock{{Type: BlockParagraph, Text: "（无详细内容）"}}
			}

			blocks = append(blocks, RichBlock{
				Type:    BlockDetails,
				Summary: summary,
				Blocks:  innerBlocks,
			})
			lastIdx = m[1]
		}

		if lastIdx < len(raw) {
			after := strings.TrimSpace(raw[lastIdx:])
			if after != "" {
				blocks = append(blocks, parseMarkdownSectionBlocks(after)...)
			}
		}

		if len(blocks) > 0 {
			return blocks
		}
	}

	// 2. 普通 Markdown 块解析
	blocks := parseMarkdownSectionBlocks(raw)
	if len(blocks) == 0 {
		blocks = []RichBlock{
			{Type: BlockParagraph, Text: "（无概括内容）"},
		}
	}
	return blocks
}

func parseMarkdownSectionBlocks(content string) []RichBlock {
	trimmed := strings.TrimSpace(content)
	if trimmed == "" {
		return nil
	}

	lines := strings.Split(trimmed, "\n")
	var blocks []RichBlock
	i := 0

	for i < len(lines) {
		line := lines[i]
		tLine := strings.TrimSpace(line)

		if tLine == "" {
			i++
			continue
		}

		// 1. 标题 (Heading)
		if hMatch := headingRegex.FindStringSubmatch(tLine); len(hMatch) > 2 {
			size := len(hMatch[1])
			blocks = append(blocks, RichBlock{
				Type: BlockHeading,
				Size: size,
				Text: ParseRichInline(strings.TrimSpace(hMatch[2])),
			})
			i++
			continue
		}

		// 2. 分割线 (Divider)
		if strings.HasPrefix(tLine, "---") || strings.HasPrefix(tLine, "===") || strings.HasPrefix(tLine, "━━━━━━━━") {
			blocks = append(blocks, RichBlock{Type: BlockDivider})
			i++
			continue
		}

		// 3. 引用块 (Blockquote)
		if strings.HasPrefix(tLine, ">") {
			var quoteLines []string
			for i < len(lines) {
				ql := strings.TrimSpace(lines[i])
				if strings.HasPrefix(ql, ">") {
					quoteLines = append(quoteLines, strings.TrimPrefix(ql, ">"))
					i++
				} else if ql == "" && len(quoteLines) > 0 {
					i++
				} else {
					break
				}
			}
			qText := strings.TrimSpace(strings.Join(quoteLines, "\n"))
			if qText != "" {
				blocks = append(blocks, RichBlock{
					Type: BlockQuote,
					Blocks: []RichBlock{
						{Type: BlockParagraph, Text: ParseRichInline(qText)},
					},
				})
			}
			continue
		}

		// 4. 表格 (Markdown Pipe Table)
		if strings.HasPrefix(tLine, "|") && strings.Contains(tLine[1:], "|") {
			var tableLines []string
			for i < len(lines) && strings.HasPrefix(strings.TrimSpace(lines[i]), "|") {
				tableLines = append(tableLines, strings.TrimSpace(lines[i]))
				i++
			}

			if len(tableLines) >= 2 {
				parseRow := func(rowStr string) []string {
					rowStr = strings.TrimPrefix(rowStr, "|")
					rowStr = strings.TrimSuffix(rowStr, "|")
					cols := strings.Split(rowStr, "|")
					var res []string
					for _, c := range cols {
						res = append(res, strings.TrimSpace(c))
					}
					return res
				}

				headerCols := parseRow(tableLines[0])
				alignRowIdx := 1
				if len(tableLines) > 1 && tableDividerRegex.MatchString(tableLines[1]) {
					alignRowIdx = 2
				}

				var rows [][]RichTableCell
				var headerRow []RichTableCell
				for _, h := range headerCols {
					headerRow = append(headerRow, RichTableCell{
						Text:     ParseRichInline(h),
						IsHeader: true,
						Align:    "center",
					})
				}
				rows = append(rows, headerRow)

				for r := alignRowIdx; r < len(tableLines); r++ {
					rowCols := parseRow(tableLines[r])
					var dataRow []RichTableCell
					for _, c := range rowCols {
						dataRow = append(dataRow, RichTableCell{
							Text:  ParseRichInline(c),
							Align: "left",
						})
					}
					if len(dataRow) > 0 {
						rows = append(rows, dataRow)
					}
				}

				blocks = append(blocks, RichBlock{
					Type:       BlockTable,
					IsBordered: true,
					IsStriped:  true,
					Cells:      rows,
				})
				continue
			}
		}

		// 5. 待办列表与项目列表 (Checklist / List)
		if checkboxRegex.MatchString(tLine) || bulletRegex.MatchString(tLine) {
			var items []RichListItem
			for i < len(lines) {
				cur := strings.TrimSpace(lines[i])
				if cb := checkboxRegex.FindStringSubmatch(cur); len(cb) > 2 {
					isChecked := strings.ToLower(cb[1]) == "x"
					items = append(items, RichListItem{
						Label:       "•",
						HasCheckbox: true,
						IsChecked:   isChecked,
						Blocks:      []RichBlock{{Type: BlockParagraph, Text: ParseRichInline(strings.TrimSpace(cb[2]))}},
					})
					i++
				} else if bl := bulletRegex.FindStringSubmatch(cur); len(bl) > 1 {
					items = append(items, RichListItem{
						Label:  "•",
						Blocks: []RichBlock{{Type: BlockParagraph, Text: ParseRichInline(strings.TrimSpace(bl[1]))}},
					})
					i++
				} else {
					break
				}
			}

			blocks = append(blocks, RichBlock{
				Type:  BlockList,
				Items: items,
			})
			continue
		}

		// 6. 普通段落 (Paragraph)
		var paraLines []string
		for i < len(lines) {
			cur := strings.TrimSpace(lines[i])
			if cur == "" || headingRegex.MatchString(cur) ||
				strings.HasPrefix(cur, "---") || strings.HasPrefix(cur, "===") ||
				strings.HasPrefix(cur, ">") ||
				(strings.HasPrefix(cur, "|") && strings.Contains(cur[1:], "|")) ||
				checkboxRegex.MatchString(cur) || bulletRegex.MatchString(cur) {
				break
			}
			paraLines = append(paraLines, cur)
			i++
		}

		if len(paraLines) > 0 {
			blocks = append(blocks, RichBlock{
				Type: BlockParagraph,
				Text: ParseRichInline(strings.Join(paraLines, "\n")),
			})
		}
	}

	return blocks
}
