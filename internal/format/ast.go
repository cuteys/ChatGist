package format

import (
	"fmt"
	"strings"
	"time"

	"github.com/cuteys/ChatGist/internal/storage"
)

type RichBlockType string

const (
	BlockParagraph RichBlockType = "paragraph"
	BlockHeading   RichBlockType = "heading"
	BlockQuote     RichBlockType = "blockquote"
	BlockDivider   RichBlockType = "divider"
	BlockDetails   RichBlockType = "details"
	BlockTable     RichBlockType = "table"
	BlockList      RichBlockType = "list"
)

type RichTableCell struct {
	Text     interface{} `json:"text"`
	IsHeader bool        `json:"is_header,omitempty"`
	Align    string      `json:"align,omitempty"`
	Valign   string      `json:"valign,omitempty"`
}

type RichListItem struct {
	Label       string      `json:"label,omitempty"`
	HasCheckbox bool        `json:"has_checkbox,omitempty"`
	IsChecked   bool        `json:"is_checked,omitempty"`
	Blocks      []RichBlock `json:"blocks"`
}

type RichBlock struct {
	Type       RichBlockType     `json:"type"`
	Text       interface{}       `json:"text,omitempty"` // 单行文本或内联样式
	Size       int               `json:"size,omitempty"`
	Summary    string            `json:"summary,omitempty"`
	Blocks     []RichBlock       `json:"blocks,omitempty"`
	Cells      [][]RichTableCell `json:"cells,omitempty"`
	Items      []RichListItem    `json:"items,omitempty"`
	IsBordered bool              `json:"is_bordered,omitempty"`
	IsStriped  bool              `json:"is_striped,omitempty"`
}

func formatTimeBeijing(msec int64) string {
	if msec <= 0 {
		return "未知"
	}
	loc := time.FixedZone("CST", 8*3600)
	t := time.UnixMilli(msec).In(loc)
	return t.Format("01-02 15:04")
}

// BuildWhitelistRichBlocks 构建白名单群组富文本表格
func BuildWhitelistRichBlocks(groups []*storage.WhitelistGroup) []RichBlock {
	if len(groups) == 0 {
		return []RichBlock{
			{
				Type: BlockHeading,
				Size: 2,
				Text: "📋 白名单群组列表",
			},
			{
				Type: BlockParagraph,
				Text: "当前暂无已授权群组。超级管理员可在目标群内直接发送 /addgroup 将其加入白名单。",
			},
		}
	}

	headerRow := []RichTableCell{
		{Text: "#", IsHeader: true, Align: "center"},
		{Text: "群组名称", IsHeader: true, Align: "left"},
		{Text: "群组 ID", IsHeader: true, Align: "center"},
		{Text: "授权人", IsHeader: true, Align: "center"},
		{Text: "添加时间", IsHeader: true, Align: "center"},
	}

	rows := [][]RichTableCell{headerRow}
	for idx, g := range groups {
		groupName := g.GroupName
		if strings.TrimSpace(groupName) == "" {
			groupName = "未命名群组"
		}
		addedBy := g.AddedBy
		if strings.TrimSpace(addedBy) == "" {
			addedBy = "未知"
		}
		rows = append(rows, []RichTableCell{
			{Text: fmt.Sprintf("%d", idx+1), Align: "center"},
			{Text: map[string]interface{}{"type": "bold", "text": groupName}, Align: "left"},
			{Text: map[string]interface{}{"type": "code", "text": g.GroupID}, Align: "center"},
			{Text: addedBy, Align: "center"},
			{Text: formatTimeBeijing(g.CreatedAt), Align: "center"},
		})
	}

	return []RichBlock{
		{
			Type: BlockHeading,
			Size: 2,
			Text: fmt.Sprintf("📋 已授权白名单群组（共 %d 个）", len(groups)),
		},
		{
			Type:       BlockTable,
			IsBordered: true,
			IsStriped:  true,
			Cells:      rows,
		},
		{
			Type: BlockDivider,
		},
		{
			Type: BlockParagraph,
			Text: "💡 提示：在群内发送 /delgroup 可移出白名单；发送 /addgroup 授权当前群。",
		},
	}
}

// BuildAdminsRichBlocks 构建管理员列表富文本表格
func BuildAdminsRichBlocks(envAdmins []string, dbAdmins []*storage.Admin) []RichBlock {
	blocks := []RichBlock{
		{
			Type: BlockHeading,
			Size: 2,
			Text: "👑 系统管理员与权限列表",
		},
		{
			Type: BlockQuote,
			Blocks: []RichBlock{
				{
					Type: BlockParagraph,
					Text: "超级管理员享有最高管理权限；所有管理员均享有指令无限次使用特权。",
				},
			},
		},
		{
			Type: BlockHeading,
			Size: 3,
			Text: "1. 环境变量超级管理员",
		},
	}

	if len(envAdmins) == 0 {
		blocks = append(blocks, RichBlock{
			Type: BlockParagraph,
			Text: "• 未配置（可通过环境变量 ADMIN_USER_IDS 设置）",
		})
	} else {
		envCells := [][]RichTableCell{
			{
				{Text: "#", IsHeader: true, Align: "center"},
				{Text: "用户 ID", IsHeader: true, Align: "center"},
				{Text: "权限级别", IsHeader: true, Align: "center"},
			},
		}
		for idx, id := range envAdmins {
			envCells = append(envCells, []RichTableCell{
				{Text: fmt.Sprintf("%d", idx+1), Align: "center"},
				{Text: map[string]interface{}{"type": "code", "text": id}, Align: "center"},
				{Text: map[string]interface{}{"type": "marked", "text": "超级管理员 (SuperAdmin)"}, Align: "center"},
			})
		}
		blocks = append(blocks, RichBlock{
			Type:       BlockTable,
			IsBordered: true,
			IsStriped:  true,
			Cells:      envCells,
		})
	}

	blocks = append(blocks, RichBlock{
		Type: BlockHeading,
		Size: 3,
		Text: fmt.Sprintf("2. 数据库授权管理员（共 %d 位）", len(dbAdmins)),
	})

	if len(dbAdmins) == 0 {
		blocks = append(blocks, RichBlock{
			Type: BlockParagraph,
			Text: "• 暂无动态授权的数据库管理员（超级管理员可通过 /addadmin 添加）",
		})
	} else {
		dbCells := [][]RichTableCell{
			{
				{Text: "#", IsHeader: true, Align: "center"},
				{Text: "管理员名称", IsHeader: true, Align: "left"},
				{Text: "用户 ID", IsHeader: true, Align: "center"},
				{Text: "授权人", IsHeader: true, Align: "center"},
				{Text: "授权时间", IsHeader: true, Align: "center"},
			},
		}
		for idx, adm := range dbAdmins {
			name := adm.UserName
			if strings.TrimSpace(name) == "" {
				name = "管理员"
			}
			addedBy := adm.AddedBy
			if strings.TrimSpace(addedBy) == "" {
				addedBy = "系统"
			}
			dbCells = append(dbCells, []RichTableCell{
				{Text: fmt.Sprintf("%d", idx+1), Align: "center"},
				{Text: map[string]interface{}{"type": "bold", "text": name}, Align: "left"},
				{Text: map[string]interface{}{"type": "code", "text": adm.UserID}, Align: "center"},
				{Text: addedBy, Align: "center"},
				{Text: formatTimeBeijing(adm.CreatedAt), Align: "center"},
			})
		}
		blocks = append(blocks, RichBlock{
			Type:       BlockTable,
			IsBordered: true,
			IsStriped:  true,
			Cells:      dbCells,
		})
	}

	blocks = append(blocks,
		RichBlock{Type: BlockDivider},
		RichBlock{
			Type: BlockParagraph,
			Text: "💡 提示：添加管理员命令为 /addadmin <用户ID> [备注]；移除命令为 /deladmin <用户ID>。",
		},
	)

	return blocks
}

// BuildQueryRichBlocks 构建关键词检索结果富文本表格
func BuildQueryRichBlocks(keyword string, totalCount int, pageResults []*storage.Message, page int, pageSize int) []RichBlock {
	tableRows := [][]RichTableCell{
		{
			{Text: "#", IsHeader: true, Align: "center"},
			{Text: "👤 发言人", IsHeader: true, Align: "left"},
			{Text: "💬 消息内容", IsHeader: true, Align: "left"},
		},
	}

	cleanGroupID := func(gid string) string {
		gid = strings.TrimPrefix(gid, "-100")
		return strings.TrimPrefix(gid, "-")
	}

	for idx, r := range pageResults {
		globalIdx := (page-1)*pageSize + idx + 1
		rawContent := strings.TrimSpace(strings.ReplaceAll(r.Content, "\n", " "))
		if strings.HasPrefix(rawContent, "回复 ") {
			parts := strings.SplitN(rawContent, ": ", 2)
			if len(parts) > 1 {
				rawContent = strings.TrimSpace(parts[1])
			}
		}
		if rawContent == "" {
			rawContent = "[消息]"
		}

		runes := []rune(rawContent)
		preview := rawContent
		if len(runes) > 24 {
			preview = string(runes[:24]) + "..."
		}

		var contentCell interface{} = preview
		if r.MessageID > 0 && r.GroupID != "" {
			link := fmt.Sprintf("https://t.me/c/%s/%d", cleanGroupID(r.GroupID), r.MessageID)
			contentCell = []interface{}{
				map[string]interface{}{
					"type": "url",
					"text": preview,
					"url":  link,
				},
			}
		}

		userName := r.UserName
		if strings.TrimSpace(userName) == "" {
			userName = "匿名"
		}

		tableRows = append(tableRows, []RichTableCell{
			{Text: fmt.Sprintf("%d", globalIdx), Align: "center"},
			{Text: map[string]interface{}{"type": "bold", "text": userName}, Align: "left"},
			{Text: contentCell, Align: "left"},
		})
	}

	return []RichBlock{
		{
			Type: BlockQuote,
			Blocks: []RichBlock{
				{
					Type: BlockParagraph,
					Text: fmt.Sprintf("🔍 检索关键词：【%s】 · 匹配消息数：%d 条", keyword, totalCount),
				},
			},
		},
		{
			Type:       BlockTable,
			IsBordered: true,
			IsStriped:  true,
			Cells:      tableRows,
		},
	}
}
