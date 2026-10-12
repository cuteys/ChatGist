package latex

import (
	"regexp"
	"strings"
	"unicode"
)

var (
	codeSpanRegex       = regexp.MustCompile("`[^`\\n]+`")
	latexMathBlockRegex = regexp.MustCompile(`\\\[([\s\S]*?)\\\]`)
	latexInlineRegex    = regexp.MustCompile(`\\\((.*?)\\\)`)
	dollarBlockRegex    = regexp.MustCompile(`\$\$([\s\S]+?)\$\$`)
	pureMathExprRegex   = regexp.MustCompile(`^[0-9a-zA-Z\s\+\-\*/=<>:.,%()^_±×÷≤≥≠≈→←]+$`)
	mathOperatorChars   = "+-*/=<>:^_±×÷≤≥≠≈→←"
)

// ContainsLatexSymbols 检查内容是否包含 LaTeX 命令或上下标符号
func ContainsLatexSymbols(content string) bool {
	if len(content) == 0 {
		return false
	}
	if strings.ContainsAny(content, `\^_`) {
		patterns := []string{`\frac`, `\dfrac`, `\tfrac`, `\sqrt`, `\begin`, `\left`, `\right`, `\text`}
		for _, pattern := range patterns {
			if strings.Contains(content, pattern) {
				return true
			}
		}
		for cmd := range LatexSymbols {
			if len(cmd) > 1 && strings.Contains(content, cmd) {
				return true
			}
		}
		for cmd := range NotMap {
			if strings.Contains(content, cmd) {
				return true
			}
		}
		for cmd := range LatexStyles {
			if strings.Contains(content, cmd) {
				return true
			}
		}
		if strings.ContainsAny(content, "^_") {
			return true
		}
	}
	return false
}

// isLikelyInlineMath 判断 $...$ 内部是否为数学公式或比例（排除含中文的价格区间）
func isLikelyInlineMath(content string) bool {
	trimmed := strings.TrimSpace(content)
	if trimmed == "" {
		return false
	}
	if ContainsLatexSymbols(trimmed) {
		return true
	}
	if pureMathExprRegex.MatchString(trimmed) && strings.ContainsAny(trimmed, mathOperatorChars) {
		return true
	}
	return false
}

// EscapeLaTeX 将文本中的 LaTeX 公式（\[...\], \(...\), $$...$$, $...$）转换为 Unicode，跳过行内代码并遵循 Pandoc 价格防误伤规则
func EscapeLaTeX(text string) string {
	if !strings.Contains(text, "$") && !strings.Contains(text, `\`) {
		return text
	}

	parts := codeSpanRegex.Split(text, -1)
	matches := codeSpanRegex.FindAllString(text, -1)

	parser := NewParser()
	var out strings.Builder

	for i, part := range parts {
		out.WriteString(escapeSegmentLaTeX(part, parser))
		if i < len(matches) {
			out.WriteString(matches[i])
		}
	}
	return out.String()
}

func escapeSegmentLaTeX(text string, parser *Parser) string {
	// 1. 处理 \[...\] 块级公式
	if strings.Contains(text, `\[`) {
		text = latexMathBlockRegex.ReplaceAllStringFunc(text, func(match string) string {
			sub := latexMathBlockRegex.FindStringSubmatch(match)
			if len(sub) < 2 || !isLikelyInlineMath(sub[1]) {
				return match
			}
			return strings.TrimSpace(parser.Convert(sub[1]))
		})
	}

	// 2. 处理 \(...\) 行内公式
	if strings.Contains(text, `\(`) {
		text = latexInlineRegex.ReplaceAllStringFunc(text, func(match string) string {
			sub := latexInlineRegex.FindStringSubmatch(match)
			if len(sub) < 2 || !isLikelyInlineMath(sub[1]) {
				return match
			}
			return strings.TrimSpace(strings.TrimRight(parser.Convert(sub[1]), "\n"))
		})
	}

	// 3. 处理 $$...$$ 块级公式
	if strings.Contains(text, "$$") {
		text = dollarBlockRegex.ReplaceAllStringFunc(text, func(match string) string {
			sub := dollarBlockRegex.FindStringSubmatch(match)
			if len(sub) < 2 || !isLikelyInlineMath(sub[1]) {
				return match
			}
			return strings.TrimSpace(parser.Convert(sub[1]))
		})
	}

	// 4. 处理 $...$ 行内公式（遵循 Pandoc Dollar Rule：闭合 $ 后紧跟数字视为两个独立价格，如 "$10.99 (~$36.9)"）
	if strings.Contains(text, "$") {
		text = convertInlineDollarMath(text, parser)
	}

	return text
}

func convertInlineDollarMath(text string, parser *Parser) string {
	var sb strings.Builder
	n := len(text)
	i := 0

	for i < n {
		if text[i] != '$' || (i > 0 && text[i-1] == '\\') {
			sb.WriteByte(text[i])
			i++
			continue
		}

		// 找到开启的 $，检查开启 $ 后不能紧跟空白或另一个 $
		if i+1 >= n || text[i+1] == '$' || unicode.IsSpace(rune(text[i+1])) {
			sb.WriteByte(text[i])
			i++
			continue
		}

		// 在同一行内寻找闭合的 $
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

		if closeIdx == -1 {
			sb.WriteByte(text[i])
			i++
			continue
		}

		// Pandoc 规则 1：闭合 $ 前不能是空白
		if unicode.IsSpace(rune(text[closeIdx-1])) {
			sb.WriteByte(text[i])
			i++
			continue
		}

		// Pandoc 规则 2：闭合 $ 后如果紧跟阿拉伯数字（如 "原价 $15，现价 $30"），则当前 $ 是价格符号而非公式！
		if closeIdx+1 < n && text[closeIdx+1] >= '0' && text[closeIdx+1] <= '9' {
			sb.WriteByte(text[i])
			i++
			continue
		}

		inner := text[i+1 : closeIdx]
		if isLikelyInlineMath(inner) {
			converted := strings.TrimSpace(strings.TrimRight(parser.Convert(inner), "\n"))
			sb.WriteString(converted)
			i = closeIdx + 1
			continue
		}

		sb.WriteByte(text[i])
		i++
	}

	return sb.String()
}
