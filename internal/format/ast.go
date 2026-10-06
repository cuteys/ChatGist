package format

type RichBlockType string

const (
	BlockParagraph  RichBlockType = "paragraph"
	BlockHeading    RichBlockType = "heading"
	BlockQuote      RichBlockType = "blockquote"
	BlockDivider    RichBlockType = "divider"
	BlockDetails    RichBlockType = "details"
	BlockTable      RichBlockType = "table"
	BlockList       RichBlockType = "list"
)

type RichTableCell struct {
	Text     string `json:"text"`
	IsHeader bool   `json:"is_header,omitempty"`
}

type RichListItem struct {
	Label       string      `json:"label,omitempty"`
	HasCheckbox bool        `json:"has_checkbox,omitempty"`
	IsChecked   bool        `json:"is_checked,omitempty"`
	Blocks      []RichBlock `json:"blocks"`
}

type RichBlock struct {
	Type     RichBlockType     `json:"type"`
	Text     interface{}       `json:"text,omitempty"` // 文本字符串或行内样式对象
	Size     int               `json:"size,omitempty"`
	Summary  string            `json:"summary,omitempty"`
	Blocks   []RichBlock       `json:"blocks,omitempty"`
	Cells    [][]RichTableCell `json:"cells,omitempty"`
	Items    []RichListItem    `json:"items,omitempty"`
}
