package format

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

var (
	codeFenceRegex     = regexp.MustCompile("(?s)^```(?:[a-zA-Z0-9_-]+)?\\s*(.*?)\\s*```$")
	detailsRegex       = regexp.MustCompile("(?is)<details>\\s*<summary>(.*?)</summary>(.*?)</details>")
	headingRegex       = regexp.MustCompile(`^(#{1,6})\s+(.+)$`)
	tableDividerRegex  = regexp.MustCompile(`^\|?\s*:?-+:?\s*(\|.*)?$`)
	checkboxRegex      = regexp.MustCompile(`^[-*•]\s+\[([ xX])\]\s+(.+)$`)
	bulletRegex        = regexp.MustCompile(`^(?:[-*•]|\d+\.)\s+(.+)$`)
	inlineTokenRegex   = regexp.MustCompile(`(\[([^\]]+)\]\((https?://[^\s)]+)\)|https?://(?:t\.me/c|tme\.cat)/[^\s,，。！!？?)]+|\*\*([^*]+)\*\*|__([^_]+)__|` + "`([^`]+)`" + `|==([^=]+)==|\*([^*]+)\*|_([^_]+)_|(?:/([a-zA-Z0-9_]{1,64})))`)
	pureMathExprRegex  = regexp.MustCompile(`^[0-9a-zA-Z\s\+\-\*/=<>:.,%()^_±×÷≤≥≠≈→←]+$`)
	mathPlaceholderReg = regexp.MustCompile("\x00MATH(\\d+)\x00")
	mathOperatorChars  = "+-*/=<>:^_±×÷≤≥≠≈→←"
)

// isLikelyInlineMath 判断候选内容是否为数学公式或比例（排除含中文的价格区间）
func isLikelyInlineMath(content string) bool {
	trimmed := strings.TrimSpace(content)
	if trimmed == "" {
		return false
	}
	if strings.ContainsAny(trimmed, `\^_`) {
		return true
	}
	if pureMathExprRegex.MatchString(trimmed) && strings.ContainsAny(trimmed, mathOperatorChars) {
		return true
	}
	return false
}

// extractBacktickMath 若单反引号内部整体为 LaTeX 公式（如 `$$...$$` 或 `$\frac{a}{b}$`），提取其内部公式
func extractBacktickMath(codeContent string) (string, bool) {
	trimmed := strings.TrimSpace(codeContent)
	if strings.HasPrefix(trimmed, "$$") && strings.HasSuffix(trimmed, "$$") && len(trimmed) > 4 {
		inner := strings.TrimSpace(trimmed[2 : len(trimmed)-2])
		if isLikelyInlineMath(inner) {
			return inner, true
		}
	}
	if strings.HasPrefix(trimmed, `\[`) && strings.HasSuffix(trimmed, `\]`) && len(trimmed) > 4 {
		inner := strings.TrimSpace(trimmed[2 : len(trimmed)-2])
		if isLikelyInlineMath(inner) {
			return inner, true
		}
	}
	if strings.HasPrefix(trimmed, `\(`) && strings.HasSuffix(trimmed, `\)`) && len(trimmed) > 4 {
		inner := strings.TrimSpace(trimmed[2 : len(trimmed)-2])
		if isLikelyInlineMath(inner) {
			return inner, true
		}
	}
	if strings.HasPrefix(trimmed, "$") && strings.HasSuffix(trimmed, "$") && len(trimmed) > 2 && !strings.HasPrefix(trimmed, "$$") {
		inner := strings.TrimSpace(trimmed[1 : len(trimmed)-1])
		// 反引号内单美元符号仅在包含明确 LaTeX 命令/上下标时剥离，避免误伤 `$PATH` 等代码
		if strings.ContainsAny(inner, `\^_`) {
			return inner, true
		}
	}
	return "", false
}

// maskInlineMath 扫描行内公式并替换为占位符，遵循 Pandoc Dollar Rule 防止误伤价格文本
func maskInlineMath(text string) (string, []string) {
	if !strings.Contains(text, "$") && !strings.Contains(text, `\`) {
		return text, nil
	}

	var sb strings.Builder
	var mathExprs []string
	n := len(text)
	i := 0

	addMath := func(expr string) string {
		idx := len(mathExprs)
		mathExprs = append(mathExprs, strings.TrimSpace(expr))
		return fmt.Sprintf("\x00MATH%d\x00", idx)
	}

	for i < n {
		// 1. 检查行内反引号 `...`
		if text[i] == '`' {
			endIdx := -1
			for j := i + 1; j < n; j++ {
				if text[j] == '\n' {
					break
				}
				if text[j] == '`' {
					endIdx = j
					break
				}
			}
			if endIdx != -1 {
				if expr, ok := extractBacktickMath(text[i+1 : endIdx]); ok {
					sb.WriteString(addMath(expr))
				} else {
					sb.WriteString(text[i : endIdx+1])
				}
				i = endIdx + 1
				continue
			}
		}

		// 2. 检查 $$...$$
		if strings.HasPrefix(text[i:], "$$") {
			closeRel := strings.Index(text[i+2:], "$$")
			if closeRel != -1 {
				inner := text[i+2 : i+2+closeRel]
				if isLikelyInlineMath(inner) {
					sb.WriteString(addMath(inner))
					i = i + 2 + closeRel + 2
					continue
				}
			}
		}

		// 3. 检查 \[...\] 与 \(...\)
		if strings.HasPrefix(text[i:], `\[`) {
			closeRel := strings.Index(text[i+2:], `\]`)
			if closeRel != -1 {
				inner := text[i+2 : i+2+closeRel]
				if isLikelyInlineMath(inner) {
					sb.WriteString(addMath(inner))
					i = i + 2 + closeRel + 2
					continue
				}
			}
		}
		if strings.HasPrefix(text[i:], `\(`) {
			closeRel := strings.Index(text[i+2:], `\)`)
			if closeRel != -1 {
				inner := text[i+2 : i+2+closeRel]
				if isLikelyInlineMath(inner) {
					sb.WriteString(addMath(inner))
					i = i + 2 + closeRel + 2
					continue
				}
			}
		}

		// 4. 检查 $...$（遵循 Pandoc 价格防误伤规则）
		if text[i] == '$' && (i == 0 || text[i-1] != '\\') {
			if i+1 < n && text[i+1] != '$' && !unicode.IsSpace(rune(text[i+1])) {
				closeIdx := -1
				for j := i + 1; j < n; j++ {
					if text[j] == '\n' {
						break
					}
					if text[j] == '$' && text[j-1] != '\\' {
						closeIdx = j
						break
					}
				}
				if closeIdx != -1 &&
					!unicode.IsSpace(rune(text[closeIdx-1])) &&
					!(closeIdx+1 < n && text[closeIdx+1] >= '0' && text[closeIdx+1] <= '9') {
					inner := text[i+1 : closeIdx]
					if isLikelyInlineMath(inner) {
						sb.WriteString(addMath(inner))
						i = closeIdx + 1
						continue
					}
				}
			}
		}

		sb.WriteByte(text[i])
		i++
	}

	return sb.String(), mathExprs
}

func expandMathPlaceholders(segment string, mathExprs []string) []interface{} {
	if len(mathExprs) == 0 || !strings.Contains(segment, "\x00MATH") {
		if segment == "" {
			return nil
		}
		return []interface{}{segment}
	}

	matches := mathPlaceholderReg.FindAllStringSubmatchIndex(segment, -1)
	if len(matches) == 0 {
		return []interface{}{segment}
	}

	var out []interface{}
	lastIdx := 0
	for _, m := range matches {
		if m[0] > lastIdx {
			out = append(out, segment[lastIdx:m[0]])
		}
		idx, err := strconv.Atoi(segment[m[2]:m[3]])
		if err == nil && idx >= 0 && idx < len(mathExprs) {
			out = append(out, map[string]interface{}{
				"type":       "mathematical_expression",
				"expression": mathExprs[idx],
			})
		}
		lastIdx = m[1]
	}
	if lastIdx < len(segment) {
		out = append(out, segment[lastIdx:])
	}
	return out
}

// ParseRichInline 解析单行内的 Markdown/Telegram 样式与数学公式元素
func ParseRichInline(text string) interface{} {
	if text == "" {
		return ""
	}
	masked, mathExprs := maskInlineMath(text)
	return parseInlineWithMath(masked, mathExprs)
}

func parseInlineWithMath(text string, mathExprs []string) interface{} {
	if text == "" {
		return ""
	}

	matches := inlineTokenRegex.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		expanded := expandMathPlaceholders(text, mathExprs)
		if len(expanded) == 0 {
			return ""
		}
		if len(expanded) == 1 {
			return expanded[0]
		}
		return expanded
	}

	var parts []interface{}
	lastIndex := 0

	for _, m := range matches {
		matchStart := m[0]
		matchEnd := m[1]

		if matchStart > lastIndex {
			parts = append(parts, expandMathPlaceholders(text[lastIndex:matchStart], mathExprs)...)
		}

		fullMatch := text[matchStart:matchEnd]

		if m[4] != -1 && m[6] != -1 {
			linkText := text[m[4]:m[5]]
			url := text[m[6]:m[7]]
			parts = append(parts, map[string]interface{}{
				"type": "url",
				"text": parseInlineWithMath(linkText, mathExprs),
				"url":  url,
			})
		} else if strings.HasPrefix(fullMatch, "http://") || strings.HasPrefix(fullMatch, "https://") {
			parts = append(parts, map[string]interface{}{
				"type": "url",
				"text": "💬 原文",
				"url":  fullMatch,
			})
		} else if m[8] != -1 || m[10] != -1 {
			boldText := ""
			if m[8] != -1 {
				boldText = text[m[8]:m[9]]
			} else {
				boldText = text[m[10]:m[11]]
			}
			parts = append(parts, map[string]interface{}{
				"type": "bold",
				"text": parseInlineWithMath(boldText, mathExprs),
			})
		} else if m[12] != -1 {
			parts = append(parts, map[string]interface{}{
				"type": "code",
				"text": text[m[12]:m[13]],
			})
		} else if m[14] != -1 {
			parts = append(parts, map[string]interface{}{
				"type": "marked",
				"text": parseInlineWithMath(text[m[14]:m[15]], mathExprs),
			})
		} else if m[16] != -1 || m[18] != -1 {
			italicText := ""
			if m[16] != -1 {
				italicText = text[m[16]:m[17]]
			} else {
				italicText = text[m[18]:m[19]]
			}
			parts = append(parts, map[string]interface{}{
				"type": "italic",
				"text": parseInlineWithMath(italicText, mathExprs),
			})
		} else if m[20] != -1 {
			cmd := text[m[20]:m[21]]
			parts = append(parts, map[string]interface{}{
				"type":        "bot_command",
				"text":        "/" + cmd,
				"bot_command": cmd,
			})
		} else {
			parts = append(parts, expandMathPlaceholders(fullMatch, mathExprs)...)
		}

		lastIndex = matchEnd
	}

	if lastIndex < len(text) {
		parts = append(parts, expandMathPlaceholders(text[lastIndex:], mathExprs)...)
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

// tryParseBlockMath 解析独立成行或跨行的 $$...$$ / \[...\] 块级公式
func tryParseBlockMath(lines []string, startIdx int) (RichBlock, int, bool) {
	tLine := strings.TrimSpace(lines[startIdx])
	if strings.HasPrefix(tLine, "`") && strings.HasSuffix(tLine, "`") && len(tLine) > 2 {
		if expr, ok := extractBacktickMath(tLine[1 : len(tLine)-1]); ok && (strings.HasPrefix(strings.TrimSpace(tLine[1:len(tLine)-1]), "$$") || strings.HasPrefix(strings.TrimSpace(tLine[1:len(tLine)-1]), `\[`)) {
			return RichBlock{Type: BlockMath, Expression: expr}, startIdx + 1, true
		}
	}

	for _, delim := range []struct{ open, close string }{{"$$", "$$"}, {`\[`, `\]`}} {
		if !strings.HasPrefix(tLine, delim.open) {
			continue
		}
		// 单行闭合块级公式
		if strings.HasSuffix(tLine, delim.close) && len(tLine) > len(delim.open)+len(delim.close) {
			inner := strings.TrimSpace(tLine[len(delim.open) : len(tLine)-len(delim.close)])
			if !strings.Contains(inner, delim.close) && isLikelyInlineMath(inner) {
				return RichBlock{Type: BlockMath, Expression: inner}, startIdx + 1, true
			}
		}
		// 多行块级公式
		if tLine == delim.open || !strings.Contains(tLine[len(delim.open):], delim.close) {
			var mathLines []string
			if firstRem := strings.TrimSpace(tLine[len(delim.open):]); firstRem != "" {
				mathLines = append(mathLines, firstRem)
			}
			for j := startIdx + 1; j < len(lines); j++ {
				cur := strings.TrimSpace(lines[j])
				if strings.HasSuffix(cur, delim.close) {
					lastRem := strings.TrimSpace(cur[:len(cur)-len(delim.close)])
					if lastRem != "" {
						mathLines = append(mathLines, lastRem)
					}
					expr := strings.TrimSpace(strings.Join(mathLines, "\n"))
					if isLikelyInlineMath(expr) {
						return RichBlock{Type: BlockMath, Expression: expr}, j + 1, true
					}
					break
				}
				mathLines = append(mathLines, lines[j])
			}
		}
	}

	return RichBlock{}, startIdx, false
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

		// 0. 块级数学公式 ($$...$$ 或 \[...\])
		if mathBlock, nextIdx, ok := tryParseBlockMath(lines, i); ok {
			blocks = append(blocks, mathBlock)
			i = nextIdx
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
			if _, _, isMath := tryParseBlockMath(lines, i); isMath {
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
