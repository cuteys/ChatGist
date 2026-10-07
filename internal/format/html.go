package format

import (
	"fmt"
	"html"
	"strings"
)

func EscapeHTML(s string) string {
	return html.EscapeString(s)
}

func getTextString(text interface{}) string {
	if text == nil {
		return ""
	}
	switch v := text.(type) {
	case string:
		return v
	case map[string]interface{}:
		if t, ok := v["text"]; ok {
			return getTextString(t)
		}
	case []interface{}:
		var sb strings.Builder
		for _, part := range v {
			sb.WriteString(getTextString(part))
		}
		return sb.String()
	}
	return fmt.Sprintf("%v", text)
}

func formatInlineTextToHTML(text interface{}) string {
	if text == nil {
		return ""
	}
	switch v := text.(type) {
	case string:
		return EscapeHTML(v)
	case map[string]interface{}:
		tp, _ := v["type"].(string)
		subText := formatInlineTextToHTML(v["text"])
		switch tp {
		case "bold":
			return fmt.Sprintf("<b>%s</b>", subText)
		case "italic":
			return fmt.Sprintf("<i>%s</i>", subText)
		case "code":
			return fmt.Sprintf("<code>%s</code>", EscapeHTML(getTextString(v["text"])))
		case "marked":
			return fmt.Sprintf("<b>[%s]</b>", subText)
		case "bot_command":
			return fmt.Sprintf("<code>%s</code>", EscapeHTML(getTextString(v["text"])))
		case "url", "link":
			u, _ := v["url"].(string)
			return fmt.Sprintf("<a href=\"%s\">%s</a>", EscapeHTML(u), subText)
		default:
			return subText
		}
	case []interface{}:
		var sb strings.Builder
		for _, part := range v {
			sb.WriteString(formatInlineTextToHTML(part))
		}
		return sb.String()
	default:
		return EscapeHTML(fmt.Sprintf("%v", text))
	}
}

// RichBlocksToHTML 将 AST 转换为 Telegram 兼容的 HTML 格式
func RichBlocksToHTML(blocks []RichBlock) string {
	var parts []string

	for _, block := range blocks {
		switch block.Type {
		case BlockParagraph:
			parts = append(parts, formatInlineTextToHTML(block.Text))
		case BlockHeading:
			parts = append(parts, fmt.Sprintf("<b>📌 %s</b>", formatInlineTextToHTML(block.Text)))
		case BlockQuote:
			parts = append(parts, fmt.Sprintf("<blockquote>%s</blockquote>", RichBlocksToHTML(block.Blocks)))
		case BlockDivider:
			parts = append(parts, "━━━━━━━━━━━━━━━━━━━━")
		case BlockDetails:
			summary := block.Summary
			if strings.TrimSpace(summary) == "" {
				summary = "详细内容"
			}
			parts = append(parts, fmt.Sprintf("<blockquote expandable><b>🔽 【%s】</b>\n%s</blockquote>", EscapeHTML(summary), RichBlocksToHTML(block.Blocks)))
		case BlockTable:
			if len(block.Cells) > 0 {
				var tableLines []string
				for _, row := range block.Cells {
					var rowParts []string
					for _, cell := range row {
						cellHtml := formatInlineTextToHTML(cell.Text)
						if cell.IsHeader {
							cellHtml = fmt.Sprintf("<b>%s</b>", cellHtml)
						}
						rowParts = append(rowParts, cellHtml)
					}
					tableLines = append(tableLines, strings.Join(rowParts, " | "))
				}
				parts = append(parts, strings.Join(tableLines, "\n"))
			}
		case BlockList:
			var listParts []string
			for _, item := range block.Items {
				mark := "• "
				if item.HasCheckbox {
					if item.IsChecked {
						mark = "☑️ "
					} else {
						mark = "🔲 "
					}
				}
				listParts = append(listParts, fmt.Sprintf("%s%s", mark, RichBlocksToHTML(item.Blocks)))
			}
			parts = append(parts, strings.Join(listParts, "\n"))
		}
	}

	return strings.TrimSpace(strings.Join(parts, "\n\n"))
}

// RichBlocksToPlainText 将 AST 降级为干净易读的纯文本
func RichBlocksToPlainText(blocks []RichBlock) string {
	var lines []string

	for _, block := range blocks {
		switch block.Type {
		case BlockParagraph:
			lines = append(lines, getTextString(block.Text))
		case BlockHeading:
			lines = append(lines, fmt.Sprintf("\n📌 %s\n", getTextString(block.Text)))
		case BlockQuote:
			lines = append(lines, fmt.Sprintf("【概览】%s", RichBlocksToPlainText(block.Blocks)))
		case BlockDivider:
			lines = append(lines, "------------------------")
		case BlockDetails:
			summary := block.Summary
			if strings.TrimSpace(summary) == "" {
				summary = "详细内容"
			}
			lines = append(lines, fmt.Sprintf("\n🔽 【%s】\n%s", summary, RichBlocksToPlainText(block.Blocks)))
		case BlockTable:
			for _, row := range block.Cells {
				var rowParts []string
				for _, cell := range row {
					rowParts = append(rowParts, getTextString(cell.Text))
				}
				lines = append(lines, strings.Join(rowParts, " | "))
			}
		case BlockList:
			for _, item := range block.Items {
				mark := "• "
				if item.HasCheckbox {
					if item.IsChecked {
						mark = "[✓] "
					} else {
						mark = "[ ] "
					}
				}
				lines = append(lines, fmt.Sprintf("%s%s", mark, RichBlocksToPlainText(item.Blocks)))
			}
		}
	}

	return strings.TrimSpace(strings.Join(lines, "\n\n"))
}
