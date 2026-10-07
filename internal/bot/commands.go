package bot

import (
	"context"
	"encoding/base64"
	"fmt"
	"html"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/cuteys/ChatGist/internal/format"
	"github.com/cuteys/ChatGist/internal/storage"
	"github.com/cuteys/ChatGist/internal/telegram"
)

var summaryArgRegex = regexp.MustCompile(`(?i)^(\d+)(h|小时|d|天|m|分|分钟)?$`)

func isSafetyBlockError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "safety") || strings.Contains(msg, "blocked") ||
		strings.Contains(msg, "content filter") || strings.Contains(msg, "violation")
}

func isTimeoutError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline exceeded") ||
		strings.Contains(msg, "context deadline exceeded") || strings.Contains(msg, "context canceled")
}

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

	// 开启异步后台协程处理大模型耗时请求，Context 严格在协程内部管理生命周期
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Second)
		defer cancel()

		b.tg.StartTypingKeeper(ctx, msg.Chat.ID)

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

		groupTitle := ""
		if msg.Chat != nil && msg.Chat.Title != "" {
			groupTitle = fmt.Sprintf("「%s」", msg.Chat.Title)
		}
		countDesc := fmt.Sprintf("近期 %d 条", len(messages))
		if hasHours {
			countDesc = fmt.Sprintf("最近 %.1f 小时", hours)
		}
		quoteNotice := fmt.Sprintf("总结群聊%s%s聊天记录%s", groupTitle, countDesc, noticeNote)

		raw, err := b.ai.SummarizeChat(ctx, messages, quoteNotice)
		if statusMsg != nil {
			_ = b.tg.DeleteMessage(msg.Chat.ID, statusMsg.MessageID)
		}

		if err != nil {
			// 脱敏并将详细堆栈仅推送到管理员私信
			b.notifySuperAdminsError(AdminAlertDetails{
				Scene:      "/summary 群聊概括",
				GroupID:    groupID,
				GroupTitle: msg.Chat.Title,
				UserID:     userID,
				UserName:   getUserDisplayName(msg.From),
				MessageID:  msg.MessageID,
				Error:      err,
				Payload:    quoteNotice,
			})

			// 群聊内彻底脱敏，仅反馈安全友好的提示
			if isSafetyBlockError(err) {
				_, _ = b.tg.SendMessage(msg.Chat.ID, "⚠️ 本期群聊内容涉及敏感或限制级话题，触发了大模型的内容安全审查策略，未能完成总结。", "", msg.MessageID, nil)
			} else if isTimeoutError(err) {
				_, _ = b.tg.SendMessage(msg.Chat.ID, "⚠️ 群聊记录较多或网络波动导致总结超时，请稍后重试或尝试指定较短时间（如 /summary 2h）。", "", msg.MessageID, nil)
			} else {
				_, _ = b.tg.SendMessage(msg.Chat.ID, "概括失败，暂时无法完成请求，请稍后重试。", "", msg.MessageID, nil)
			}
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

		_ = b.sendRichMessage(msg.Chat.ID, blocks, raw, msg.MessageID, nil)
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

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Second)
		defer cancel()

		b.tg.StartTypingKeeper(ctx, msg.Chat.ID)

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
			repliedLink := telegram.GetMessageLink(groupID, msg.ReplyToMessage.MessageID)
			contextInfo += fmt.Sprintf("\n【重点引用的消息】\n• 直达链接: %s\n• 发言人: %s\n• 内容: %s",
				repliedLink, getUserDisplayName(msg.ReplyToMessage.From), msg.ReplyToMessage.Text)
		}

		raw, err := b.ai.AskChat(ctx, messages, question, contextInfo)
		if statusMsg != nil {
			_ = b.tg.DeleteMessage(msg.Chat.ID, statusMsg.MessageID)
		}

		if err != nil {
			b.notifySuperAdminsError(AdminAlertDetails{
				Scene:      "/ask 提问解答",
				GroupID:    groupID,
				GroupTitle: msg.Chat.Title,
				UserID:     userID,
				UserName:   getUserDisplayName(msg.From),
				MessageID:  msg.MessageID,
				Error:      err,
				Payload:    question,
			})

			if isSafetyBlockError(err) {
				_, _ = b.tg.SendMessage(msg.Chat.ID, "⚠️ 该提问或相关聊天内容触发了大模型的内容安全审查策略，暂时无法回答。", "", msg.MessageID, nil)
			} else if isTimeoutError(err) {
				_, _ = b.tg.SendMessage(msg.Chat.ID, "⚠️ 本次提问分析超时，可能因涉及内容较多或网络波动，请稍后重试或缩小提问范围。", "", msg.MessageID, nil)
			} else {
				_, _ = b.tg.SendMessage(msg.Chat.ID, "回答失败，AI 服务暂时无法完成请求，请稍后重试。", "", msg.MessageID, nil)
			}
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

		_ = b.sendRichMessage(msg.Chat.ID, blocks, raw, msg.MessageID, nil)
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
	blocks := format.BuildQueryRichBlocks(keyword, totalCount, results, page, pageSize)
	markup := telegram.GenerateQueryPaginationKeyboard(keyword, page, totalPages)

	_ = b.sendRichMessage(msg.Chat.ID, blocks, "", msg.MessageID, markup)
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

	// 连通性测试
	d1Latency, d1Err := b.storage.Ping()
	d1LatencyText := fmt.Sprintf("%dms", d1Latency.Milliseconds())
	if d1Err != nil {
		d1LatencyText = "异常"
	}

	aiLatencyText := "未配置"
	if b.cfg.AIAPIKey != "" {
		aiStart := time.Now()
		req, _ := http.NewRequestWithContext(context.Background(), "GET", strings.TrimRight(b.cfg.AIBaseURL, "/")+"/models", nil)
		req.Header.Set("Authorization", "Bearer "+b.cfg.AIAPIKey)
		client := &http.Client{Timeout: 5 * time.Second}
		res, err := client.Do(req)
		aiLatency := time.Since(aiStart).Milliseconds()
		if err == nil {
			_ = res.Body.Close()
			if res.StatusCode == http.StatusOK || res.StatusCode == http.StatusUnauthorized {
				aiLatencyText = fmt.Sprintf("正常 (%dms)", aiLatency)
			} else {
				aiLatencyText = fmt.Sprintf("异常 (%d, %dms)", res.StatusCode, aiLatency)
			}
		} else {
			aiLatencyText = "连接超时/异常"
		}
	}

	sb.WriteString("\n⚡ <b>系统连通性诊断：</b>\n")
	sb.WriteString(fmt.Sprintf("• SQLite 数据库延迟：%s\n", d1LatencyText))
	sb.WriteString(fmt.Sprintf("• AI 接口状态：%s\n", aiLatencyText))

	quotaStatus, _ := b.quota.GetUserQuotaStatus(userID)
	if quotaStatus != nil {
		if quotaStatus.IsPrivileged {
			sb.WriteString("\n⚡ <b>指令配额</b>：无限制（特权用户）\n")
		} else {
			sb.WriteString(fmt.Sprintf("\n📊 <b>今日使用配额（次日 00:00 自动刷新）：</b>\n• 总结 (/summary): %d/%d 次\n• 问答 (/ask): %d/%d 次\n• 检索 (/query): %d/%d 次\n",
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
