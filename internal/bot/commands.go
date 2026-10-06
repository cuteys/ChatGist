package bot

import (
	"context"
	"encoding/base64"
	"fmt"
	"html"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/cuteys/ChatGist/internal/format"
	"github.com/cuteys/ChatGist/internal/storage"
	"github.com/cuteys/ChatGist/internal/telegram"
)

var summaryArgRegex = regexp.MustCompile(`(?i)^(\d+)(h|小时|d|天|m|分|分钟)?$`)

func (b *Bot) handleSummary(msg *telegram.Message) {
	if !isGroupChat(msg.Chat) {
		_, _ = b.tg.SendMessage(msg.Chat.ID, "⚠️ 该指令仅限在已授权的白名单群组中使用。", "", msg.MessageID, nil)
		return
	}

	groupID := strconv.FormatInt(msg.Chat.ID, 10)
	userID := ""
	if msg.From != nil {
		userID = strconv.FormatInt(msg.From.ID, 10)
	}

	allowed, current, limit, isPrivileged := b.quota.CheckAndIncrementQuota(userID, "summary")
	if !allowed {
		text := fmt.Sprintf("⚠️ 您今日的 /summary 总结次数已达上限（%d/%d 次）。配额将在次日 00:00 自动刷新。", current, limit)
		_, _ = b.tg.SendMessage(msg.Chat.ID, text, "", msg.MessageID, nil)
		return
	}

	parts := strings.Fields(msg.Text)
	var summaryArg string
	if len(parts) > 1 {
		summaryArg = parts[1]
	}

	limitCount := 50
	var hours float64
	hasHours := false

	if summaryArg != "" {
		match := summaryArgRegex.FindStringSubmatch(summaryArg)
		if len(match) == 0 {
			_, _ = b.tg.SendMessage(msg.Chat.ID, "⚠️ 请输入有效的时间范围或消息数量，例如：/summary 20 或 /summary 12h", "", msg.MessageID, nil)
			return
		}
		num, _ := strconv.Atoi(match[1])
		if num <= 0 {
			_, _ = b.tg.SendMessage(msg.Chat.ID, "⚠️ 请输入大于 0 的有效数值。", "", msg.MessageID, nil)
			return
		}
		unit := strings.ToLower(match[2])
		switch unit {
		case "h", "小时":
			hours = float64(num)
			hasHours = true
		case "d", "天":
			hours = float64(num * 24)
			hasHours = true
		case "m", "分", "分钟":
			hours = math.Max(0.01, float64(num)/60.0)
			hasHours = true
		default:
			limitCount = num
		}
	}

	noticeNote := ""
	if !isPrivileged {
		if hasHours && hours > 48 {
			hours = 48
			noticeNote = "，普通用户单次上限 48 小时"
		} else if !hasHours && limitCount > 3000 {
			limitCount = 3000
			noticeNote = "，普通用户单次上限 3000 条"
		}
	}

	statusText := "⏳ 正在读取群聊记录并生成总结，请稍候..."
	if noticeNote != "" {
		statusText = fmt.Sprintf("⏳ 已按普通用户上限调整%s，正在生成总结，请稍候...", noticeNote)
	}
	statusMsg, _ := b.tg.SendMessage(msg.Chat.ID, statusText, "", msg.MessageID, nil)

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Second)
	defer cancel()

	b.tg.StartTypingKeeper(ctx, msg.Chat.ID)

	go func() {
		defer cancel()
		var messages []*storage.Message
		var err error

		if hasHours {
			since := time.Now().UnixMilli() - int64(hours*3600*1000)
			messages, err = b.storage.GetRecentMessages(groupID, 4000, since)
		} else {
			messages, err = b.storage.GetRecentMessages(groupID, limitCount, 0)
		}

		if err != nil || len(messages) == 0 {
			if statusMsg != nil {
				_ = b.tg.DeleteMessage(msg.Chat.ID, statusMsg.MessageID)
			}
			_, _ = b.tg.SendMessage(msg.Chat.ID, "📋 在指定范围内暂无群聊消息记录，无需总结。", "", msg.MessageID, nil)
			return
		}

		var quoteNotice string
		if hasHours {
			quoteNotice = fmt.Sprintf("📊 正在总结最近 %.1f 小时内的群聊记录（共 %d 条）", hours, len(messages))
		} else {
			quoteNotice = fmt.Sprintf("📊 正在总结最近 %d 条群聊记录", len(messages))
		}

		raw, err := b.ai.SummarizeChat(ctx, messages, quoteNotice)
		if statusMsg != nil {
			_ = b.tg.DeleteMessage(msg.Chat.ID, statusMsg.MessageID)
		}

		if err != nil {
			errText := fmt.Sprintf("❌ 总结生成失败: %v", err)
			_, _ = b.tg.SendMessage(msg.Chat.ID, errText, "", msg.MessageID, nil)
			return
		}

		blocks := format.ParseRichMessageResponse(raw)
		blocks = append([]format.RichBlock{
			{
				Type: format.BlockQuote,
				Blocks: []format.RichBlock{
					{Type: format.BlockParagraph, Text: quoteNotice},
				},
			},
		}, blocks...)

		blocks = append(blocks,
			format.RichBlock{Type: format.BlockDivider},
			format.RichBlock{
				Type: format.BlockHeading,
				Size: 6,
				Text: map[string]interface{}{
					"type": "code",
					"text": b.cfg.AIModel,
				},
			},
		)

		htmlContent := format.RichBlocksToHTML(blocks)
		chunks := telegram.SplitMessage(htmlContent, 4000)
		for _, chunk := range chunks {
			_, err = b.tg.SendMessage(msg.Chat.ID, chunk, "HTML", msg.MessageID, nil)
			if err != nil {
				// Telegram 拒收复杂富文本时降级为纯文本兜底
				plain := format.RichBlocksToPlainText(blocks)
				pChunks := telegram.SplitMessage(plain, 4000)
				for _, pChunk := range pChunks {
					_, _ = b.tg.SendMessage(msg.Chat.ID, pChunk, "", msg.MessageID, nil)
				}
				break
			}
		}
	}()
}

func (b *Bot) handleAsk(msg *telegram.Message) {
	if !isGroupChat(msg.Chat) {
		_, _ = b.tg.SendMessage(msg.Chat.ID, "⚠️ 该指令仅限在已授权的白名单群组中使用。", "", msg.MessageID, nil)
		return
	}

	groupID := strconv.FormatInt(msg.Chat.ID, 10)
	userID := ""
	if msg.From != nil {
		userID = strconv.FormatInt(msg.From.ID, 10)
	}

	allowed, current, limit, _ := b.quota.CheckAndIncrementQuota(userID, "ask")
	if !allowed {
		text := fmt.Sprintf("⚠️ 您今日的 /ask 提问次数已达上限（%d/%d 次）。配额将在次日 00:00 自动刷新。", current, limit)
		_, _ = b.tg.SendMessage(msg.Chat.ID, text, "", msg.MessageID, nil)
		return
	}

	parts := strings.SplitN(msg.Text, " ", 2)
	question := ""
	if len(parts) > 1 {
		question = strings.TrimSpace(parts[1])
	}
	if question == "" && msg.ReplyToMessage != nil {
		question = "请分析并解答上面引用的内容"
	}
	if question == "" {
		_, _ = b.tg.SendMessage(msg.Chat.ID, "💡 请提供你的问题，例如：/ask 今天大家主要讨论了什么？", "", msg.MessageID, nil)
		return
	}

	statusMsg, _ := b.tg.SendMessage(msg.Chat.ID, "⏳ 收到提问，正在分析近期群聊并解答，请稍候...", "", msg.MessageID, nil)

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Second)
	defer cancel()

	b.tg.StartTypingKeeper(ctx, msg.Chat.ID)

	go func() {
		defer cancel()
		messages, err := b.storage.GetRecentMessages(groupID, 1000, 0)
		if err != nil || len(messages) == 0 {
			if statusMsg != nil {
				_ = b.tg.DeleteMessage(msg.Chat.ID, statusMsg.MessageID)
			}
			_, _ = b.tg.SendMessage(msg.Chat.ID, "📋 本群暂无消息记录，无法回答。", "", msg.MessageID, nil)
			return
		}

		contextInfo := fmt.Sprintf("所在群组: %s (ID: %s)\n提问者: %s", msg.Chat.Title, groupID, getUserDisplayName(msg.From))
		if msg.ReplyToMessage != nil {
			contextInfo += fmt.Sprintf("\n【重点引用的消息】发言人: %s，内容: %s", getUserDisplayName(msg.ReplyToMessage.From), msg.ReplyToMessage.Text)
		}

		raw, err := b.ai.AskChat(ctx, messages, question, contextInfo)
		if statusMsg != nil {
			_ = b.tg.DeleteMessage(msg.Chat.ID, statusMsg.MessageID)
		}

		if err != nil {
			errText := fmt.Sprintf("❌ 回答失败: %v", err)
			_, _ = b.tg.SendMessage(msg.Chat.ID, errText, "", msg.MessageID, nil)
			return
		}

		blocks := format.ParseRichMessageResponse(raw)
		blocks = append([]format.RichBlock{
			{
				Type: format.BlockQuote,
				Blocks: []format.RichBlock{
					{Type: format.BlockParagraph, Text: fmt.Sprintf("💬 提问：%s", question)},
				},
			},
		}, blocks...)

		blocks = append(blocks,
			format.RichBlock{Type: format.BlockDivider},
			format.RichBlock{
				Type: format.BlockHeading,
				Size: 6,
				Text: map[string]interface{}{
					"type": "code",
					"text": b.cfg.AIModel,
				},
			},
		)

		htmlContent := format.RichBlocksToHTML(blocks)
		chunks := telegram.SplitMessage(htmlContent, 4000)
		for _, chunk := range chunks {
			_, err = b.tg.SendMessage(msg.Chat.ID, chunk, "HTML", msg.MessageID, nil)
			if err != nil {
				plain := format.RichBlocksToPlainText(blocks)
				pChunks := telegram.SplitMessage(plain, 4000)
				for _, pChunk := range pChunks {
					_, _ = b.tg.SendMessage(msg.Chat.ID, pChunk, "", msg.MessageID, nil)
				}
				break
			}
		}
	}()
}

func (b *Bot) handleQuery(msg *telegram.Message) {
	if !isGroupChat(msg.Chat) {
		_, _ = b.tg.SendMessage(msg.Chat.ID, "⚠️ 该指令仅限在已授权的白名单群组中使用。", "", msg.MessageID, nil)
		return
	}

	groupID := strconv.FormatInt(msg.Chat.ID, 10)
	userID := ""
	if msg.From != nil {
		userID = strconv.FormatInt(msg.From.ID, 10)
	}

	allowed, current, limit, _ := b.quota.CheckAndIncrementQuota(userID, "query")
	if !allowed {
		text := fmt.Sprintf("⚠️ 您今日的 /query 检索次数已达上限（%d/%d 次）。配额将在次日 00:00 自动刷新。", current, limit)
		_, _ = b.tg.SendMessage(msg.Chat.ID, text, "", msg.MessageID, nil)
		return
	}

	parts := strings.SplitN(msg.Text, " ", 2)
	keyword := ""
	if len(parts) > 1 {
		keyword = strings.TrimSpace(parts[1])
	}
	if keyword == "" {
		_, _ = b.tg.SendMessage(msg.Chat.ID, "🔍 请输入要检索的关键词，例如：/query 教程", "", msg.MessageID, nil)
		return
	}

	const pageSize = 6
	page := 1
	results, totalCount, err := b.storage.QueryMessages(groupID, keyword, pageSize, 0)
	if err != nil || totalCount == 0 {
		_, _ = b.tg.SendMessage(msg.Chat.ID, fmt.Sprintf("🔍 未检索到包含关键词「%s」的群聊记录。", html.EscapeString(keyword)), "", msg.MessageID, nil)
		return
	}

	totalPages := int(math.Ceil(float64(totalCount) / float64(pageSize)))
	htmlText, markup := buildQueryPageHTML(groupID, keyword, results, totalCount, page, totalPages)
	_, _ = b.tg.SendMessage(msg.Chat.ID, htmlText, "HTML", msg.MessageID, markup)
}

func buildQueryPageHTML(groupID, keyword string, results []*storage.Message, totalCount, page, totalPages int) (string, *telegram.InlineKeyboardMarkup) {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("🔍 关键词「<b>%s</b>」检索结果（共 %d 条，第 %d/%d 页）：\n\n",
		html.EscapeString(keyword), totalCount, page, totalPages))

	for i, m := range results {
		cleanContent := m.Content
		if len([]rune(cleanContent)) > 100 {
			cleanContent = string([]rune(cleanContent)[:100]) + "..."
		}
		link := telegram.GetMessageLink(m.GroupID, m.MessageID)
		sb.WriteString(fmt.Sprintf("%d. <b>%s</b>: %s <a href=\"%s\">[直达]</a>\n",
			i+1, html.EscapeString(m.UserName), html.EscapeString(cleanContent), link))
	}

	var markup *telegram.InlineKeyboardMarkup
	if totalPages > 1 {
		var buttons []telegram.InlineKeyboardButton
		if page > 1 {
			buttons = append(buttons, telegram.InlineKeyboardButton{
				Text:         "⬅️ 上一页",
				CallbackData: fmt.Sprintf("qp:%d:%s", page-1, keyword),
			})
		}
		buttons = append(buttons, telegram.InlineKeyboardButton{
			Text:         fmt.Sprintf("%d/%d", page, totalPages),
			CallbackData: "noop",
		})
		if page < totalPages {
			buttons = append(buttons, telegram.InlineKeyboardButton{
				Text:         "下一页 ➡️",
				CallbackData: fmt.Sprintf("qp:%d:%s", page+1, keyword),
			})
		}
		markup = &telegram.InlineKeyboardMarkup{
			InlineKeyboard: [][]telegram.InlineKeyboardButton{buttons},
		}
	}

	return sb.String(), markup
}

func (b *Bot) handleStatus(msg *telegram.Message) {
	if isGroupChat(msg.Chat) {
		return
	}

	userID := strconv.FormatInt(msg.Chat.ID, 10)
	isSuper := b.whitelist.IsSuperAdmin(userID)
	isAdmin := b.whitelist.IsAdmin(userID)

	var sb strings.Builder
	sb.WriteString("🤖 <b>ChatGist 运行状态</b>\n\n")

	if isSuper {
		sb.WriteString("👑 <b>身份</b>：系统超级管理员\n")
	} else if isAdmin {
		sb.WriteString("🛡️ <b>身份</b>：数据库管理员\n")
	} else {
		sb.WriteString("👤 <b>身份</b>：普通用户\n")
	}

	quotaStatus, _ := b.quota.GetUserQuotaStatus(userID)
	if quotaStatus != nil {
		if quotaStatus.IsPrivileged {
			sb.WriteString("⚡ <b>指令配额</b>：无限制（特权用户）\n")
		} else {
			sb.WriteString(fmt.Sprintf("📊 <b>今日配额</b>：\n• /summary: %d/%d\n• /ask: %d/%d\n• /query: %d/%d\n",
				quotaStatus.Summary.Current, quotaStatus.Summary.Limit,
				quotaStatus.Ask.Current, quotaStatus.Ask.Limit,
				quotaStatus.Query.Current, quotaStatus.Query.Limit,
			))
		}
	}

	if isAdmin {
		stats, err := b.storage.GetDatabaseStorageStats()
		if err == nil && stats != nil {
			percent := float64(stats.TotalBytes) / float64(stats.LimitBytes) * 100.0
			sb.WriteString(fmt.Sprintf("\n💾 <b>存储状态</b>：\n• 占用: %.2f MB / 500 MB (%.1f%%)\n• 总消息: 文本 %d | 图片 %d\n• 白名单群组: %d 个\n",
				float64(stats.TotalBytes)/(1024*1024), percent,
				stats.TotalTextCount, stats.TotalImageCount,
				len(stats.GroupStats),
			))
		}
	}

	_, _ = b.tg.SendMessage(msg.Chat.ID, sb.String(), "HTML", msg.MessageID, nil)
}

func (b *Bot) handleHelp(msg *telegram.Message) {
	if isGroupChat(msg.Chat) {
		return
	}

	userID := strconv.FormatInt(msg.Chat.ID, 10)
	isSuper := b.whitelist.IsSuperAdmin(userID)

	var sb strings.Builder
	sb.WriteString("📖 <b>ChatGist 智能助手使用指南</b>\n\n")
	sb.WriteString("<b>👥 群聊常规指令：</b>\n")
	sb.WriteString("• <code>/summary [数量/时间]</code>: 总结群聊消息（如 /summary 50 或 /summary 12h）\n")
	sb.WriteString("• <code>/ask [问题]</code>: 基于近期群聊记录进行智能问答\n")
	sb.WriteString("• <code>/query [关键词]</code>: 在群历史消息中检索关键词\n\n")

	sb.WriteString("<b>💬 私聊指令：</b>\n")
	sb.WriteString("• <code>/status</code>: 查看当前状态与每日配额\n")
	sb.WriteString("• <code>/help</code>: 查看指令帮助\n")

	if isSuper {
		sb.WriteString("\n<b>👑 超级管理员专属指令：</b>\n")
		sb.WriteString("• <code>/addgroup [群ID] [群名称]</code>: 授权群组\n")
		sb.WriteString("• <code>/delgroup [群ID]</code>: 移出白名单\n")
		sb.WriteString("• <code>/whitelist</code>: 查看白名单群组\n")
		sb.WriteString("• <code>/addadmin [用户ID] [备注]</code>: 添加管理员\n")
		sb.WriteString("• <code>/deladmin [用户ID]</code>: 移除管理员\n")
		sb.WriteString("• <code>/admins</code>: 查看管理员列表\n")
		sb.WriteString("• <code>/clearmessages [群ID]</code>: 清空群历史消息\n")
		sb.WriteString("• <code>/setcommands</code>: 同步 Telegram 指令菜单\n")
	}

	_, _ = b.tg.SendMessage(msg.Chat.ID, sb.String(), "HTML", msg.MessageID, nil)
}

func isGroupChat(chat *telegram.Chat) bool {
	if chat == nil {
		return false
	}
	return chat.Type == "group" || chat.Type == "supergroup"
}

func getUserDisplayName(u *telegram.User) string {
	if u == nil {
		return "匿名群友"
	}
	parts := []string{u.FirstName, u.LastName}
	var nameParts []string
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			nameParts = append(nameParts, strings.TrimSpace(p))
		}
	}
	name := strings.Join(nameParts, " ")
	if name == "" {
		if u.Username != "" {
			name = u.Username
		} else {
			name = "匿名群友"
		}
	}
	return name
}

func (b *Bot) extractImageBase64(photo []telegram.PhotoSize) string {
	if len(photo) == 0 {
		return ""
	}
	const maxBytes = 512 * 1024
	var candidate *telegram.PhotoSize

	for i := len(photo) - 1; i >= 0; i-- {
		p := photo[i]
		if p.FileSize > 0 && p.FileSize <= maxBytes {
			candidate = &p
			break
		}
	}
	if candidate == nil && photo[0].FileSize <= maxBytes {
		candidate = &photo[0]
	}
	if candidate == nil {
		return ""
	}

	fileResp, err := b.tg.GetFile(candidate.FileID)
	if err != nil || fileResp.Result.FilePath == "" {
		return ""
	}

	data, err := b.tg.DownloadFile(fileResp.Result.FilePath)
	if err != nil || len(data) == 0 || len(data) > maxBytes {
		return ""
	}

	mime := "image/jpeg"
	if strings.HasSuffix(strings.ToLower(fileResp.Result.FilePath), ".png") {
		mime = "image/png"
	} else if strings.HasSuffix(strings.ToLower(fileResp.Result.FilePath), ".webp") {
		mime = "image/webp"
	}

	b64 := base64.StdEncoding.EncodeToString(data)
	return fmt.Sprintf("data:%s;base64,%s", mime, b64)
}
