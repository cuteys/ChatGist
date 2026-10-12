package format

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseRichInlineMathAndPrices(t *testing.T) {
	// 1. 行内公式与加粗嵌套
	inline := ParseRichInline(`💡 **25T 双向流量（$25 \div 2 = 12.5$）**，比例 $1:1$。`)
	rawJSON, _ := json.Marshal(inline)
	jsonStr := string(rawJSON)
	if !strings.Contains(jsonStr, `"type":"mathematical_expression"`) || !strings.Contains(jsonStr, `25 \\div 2 = 12.5`) || !strings.Contains(jsonStr, `"1:1"`) {
		t.Fatalf("expected inline mathematical_expression nodes, got: %s", jsonStr)
	}

	// 2. 反引号包裹公式剥离为原生公式节点
	backtickMath := ParseRichInline("LaTeX 源码：`$$\\frac{25\\text{ T}}{2} = 12.5\\text{ T}$$`")
	btJSON, _ := json.Marshal(backtickMath)
	if !strings.Contains(string(btJSON), `"type":"mathematical_expression"`) || strings.Contains(string(btJSON), `"type":"code"`) {
		t.Fatalf("expected backtick-wrapped formula to become mathematical_expression, got: %s", string(btJSON))
	}

	// 3. 美元价格防误伤（Pandoc Dollar Rule）
	prices := ParseRichInline(`RN 年付 $10.99，DMIT 年付 $36.9（溢价后约 $45.50），续费只要 $15！`)
	priceJSON, _ := json.Marshal(prices)
	if strings.Contains(string(priceJSON), `"mathematical_expression"`) {
		t.Fatalf("expected prices to remain plain text, got: %s", string(priceJSON))
	}

	// 4. 真实行内代码保护
	code := ParseRichInline("在终端执行 `echo $PATH && awk '{print $1 / $2}'` 即可")
	codeJSON, _ := json.Marshal(code)
	if !strings.Contains(string(codeJSON), `"type":"code"`) || strings.Contains(string(codeJSON), `"mathematical_expression"`) {
		t.Fatalf("expected bash code to remain code entity, got: %s", string(codeJSON))
	}

	// 5. 块级公式与 <details> 抽屉结构保持一致
	md := "结论段落\n\n$$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$\n\n<details>\n<summary>🔍 详细分析与讨论明细</summary>\n\n- 巴塞尔问题：$$\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}$$\n\n</details>"
	blocks := ParseRichMessageResponse(md)
	blocksJSON, _ := json.Marshal(blocks)
	bStr := string(blocksJSON)
	if !strings.Contains(bStr, `"type":"mathematical_expression"`) || !strings.Contains(bStr, `"type":"details"`) {
		t.Fatalf("expected both mathematical_expression and details blocks, got: %s", bStr)
	}
}
