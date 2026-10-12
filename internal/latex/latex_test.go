package latex

import "testing"

func TestEscapeLaTeX(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "user_real_case_div_and_ratio",
			input: `💡 **25T 双向流量折算成单向流量是 12.5T**（$25 \div 2 = 12.5$）。结果把 $25 \div 2$ 算成了 12.33。如果实际业务里上下行比例不是严格的 $1:1$，按 12.5T 标单向探针其实并不严谨。`,
			want:  `💡 **25T 双向流量折算成单向流量是 12.5T**（25 ÷ 2 = 12.5）。结果把 25 ÷ 2 算成了 12.33。如果实际业务里上下行比例不是严格的 1:1，按 12.5T 标单向探针其实并不严谨。`,
		},
		{
			name:  "fractions_and_scripts",
			input: `动能公式 $E_k = \frac{1}{2}mv^2$，均值不等式 $\frac{a+b}{2} \ge \sqrt{ab}$，立方根 $\sqrt[3]{8} = 2$。`,
			want:  `动能公式 Eₖ = ½mv²，均值不等式 (a+b)/2 ≥ √(ab)，立方根 ∛8 = 2。`,
		},
		{
			name:  "quadratic_formula",
			input: `求根公式：$x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$`,
			want:  `求根公式：x = (-b ± √(b² - 4ac))/2a`,
		},
		{
			name:  "chinese_inside_text",
			input: `带宽折算：$\frac{1000 \text{ Mbps}}{8} = 125 \text{ MB/s}$，即 $\text{单向流量} = 12.5\text{T}$`,
			want:  `带宽折算：(1000 Mbps)/8 = 125 MB/s，即 单向流量 = 12.5T`,
		},
		{
			name:  "price_protection_multiple_dollars",
			input: `RN 年付 $10.99，DMIT 年付 $36.9（溢价后约 $45.50），续费只要 $15！`,
			want:  `RN 年付 $10.99，DMIT 年付 $36.9（溢价后约 $45.50），续费只要 $15！`,
		},
		{
			name:  "inline_code_protection",
			input: "在终端执行 `echo $PATH && awk '{print $1 / $2}'` 即可，同时计算 $25 \\times 4 = 100$。",
			want:  "在终端执行 `echo $PATH && awk '{print $1 / $2}'` 即可，同时计算 25 × 4 = 100。",
		},
		{
			name:  "paren_and_bracket_delimiters",
			input: `行内 \(a^2 + b^2 = c^2\) 与块级 \[\sum_{i=1}^{n} i = \frac{n(n+1)}{2}\]`,
			want:  `行内 a² + b² = c² 与块级 ∑ᵢ₌₁ⁿ i = (n(n+1))/2`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := EscapeLaTeX(tc.input)
			if got != tc.want {
				t.Errorf("\ngot:  %s\nwant: %s", got, tc.want)
			}
		})
	}
}
