package bot

import (
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/cuteys/ChatGist/internal/format"
	"github.com/cuteys/ChatGist/internal/telegram"
)

type AdminAlertDetails struct {
	Scene      string
	GroupID    string
	GroupTitle string
	UserID     string
	UserName   string
	MessageID  int64
	Error      error
	Payload    string
}

func (b *Bot) sanitizeSecrets(text string) string {
	res := text
	if b.cfg.AIAPIKey != "" {
		res = strings.ReplaceAll(res, b.cfg.AIAPIKey, "[REDACTED]")
	}
	if b.cfg.AIBaseURL != "" {
		res = strings.ReplaceAll(res, b.cfg.AIBaseURL, "[REDACTED]")
	}
	if b.cfg.TelegramBotToken != "" {
		res = strings.ReplaceAll(res, b.cfg.TelegramBotToken, "[REDACTED]")
	}
	return res
}

// notifySuperAdminsError 将脱敏后的系统异常仅推送到超级管理员的私信窗口
func (b *Bot) notifySuperAdminsError(details AdminAlertDetails) {
	if len(b.cfg.AdminUserIDs) == 0 || details.Error == nil {
		return
	}

	errStr := details.Error.Error()
	sanitizedErr := b.sanitizeSecrets(errStr)
	runes := []rune(sanitizedErr)
	if len(runes) > 1500 {
		sanitizedErr = string(runes[:1500]) + "...[TRUNCATED]"
	}

	loc := time.FixedZone("CST", 8*3600)
	timeStr := time.Now().In(loc).Format("2006-01-02 15:04:05")

	var directLink string
	if details.GroupID != "" && details.MessageID > 0 {
		directLink = telegram.GetMessageLink(details.GroupID, details.MessageID)
	}

	var sb strings.Builder
	sb.WriteString("🚨 【ChatGist 系统异常告警】\n")
	sb.WriteString(fmt.Sprintf("• 触发场景: %s\n", details.Scene))
	if details.GroupTitle != "" {
		sb.WriteString(fmt.Sprintf("• 发生群组: %s (ID: %s)\n", details.GroupTitle, details.GroupID))
	} else if details.GroupID != "" {
		sb.WriteString(fmt.Sprintf("• 发生群组: ID %s\n", details.GroupID))
	}
	if details.UserName != "" {
		sb.WriteString(fmt.Sprintf("• 触发用户: %s (ID: %s)\n", details.UserName, details.UserID))
	} else if details.UserID != "" {
		sb.WriteString(fmt.Sprintf("• 触发用户: ID %s\n", details.UserID))
	}
	if directLink != "" {
		sb.WriteString(fmt.Sprintf("• 目标对话: %s\n", directLink))
	}
	sb.WriteString(fmt.Sprintf("• 发生时间: %s (北京时间)\n\n", timeStr))
	sb.WriteString("📋 错误信息与堆栈:\n```\n")
	sb.WriteString(sanitizedErr)
	sb.WriteString("\n```")

	alertText := sb.String()

	for _, adminIDStr := range b.cfg.AdminUserIDs {
		adminIDStr = strings.TrimSpace(adminIDStr)
		if adminIDStr == "" {
			continue
		}
		adminID, err := strconv.ParseInt(adminIDStr, 10, 64)
		if err != nil {
			continue
		}
		_, sendErr := b.tg.SendMessage(adminID, alertText, "Markdown", 0, nil)
		if sendErr != nil {
			// 若 Markdown 解析失败则降级为纯文本发送
			_, _ = b.tg.SendMessage(adminID, alertText, "", 0, nil)
		}
	}
}

// sendRichMessage 实现与原版 Worker 完全一致的四级降级富文本发送
func (b *Bot) sendRichMessage(chatID int64, blocks []format.RichBlock, rawMarkdown string, replyToMessageID int64, markup *telegram.InlineKeyboardMarkup) error {
	chatIDStr := strconv.FormatInt(chatID, 10)

	// 1. 尝试原生 AST blocks 模式
	astReq := telegram.SendRichMessagePayload{
		ChatID: chatIDStr,
		RichMessage: &telegram.RichMessageContent{
			Blocks: blocks,
		},
		ReplyMarkup: markup,
	}
	if replyToMessageID > 0 {
		astReq.ReplyParameters = &telegram.ReplyParameters{MessageID: replyToMessageID}
	}
	if err := b.tg.SendRichMessageRaw(astReq); err == nil {
		return nil
	}

	// 2. 尝试原生 Markdown 模式
	if rawMarkdown != "" {
		mdReq := telegram.SendRichMessagePayload{
			ChatID: chatIDStr,
			RichMessage: &telegram.RichMessageContent{
				Markdown: rawMarkdown,
			},
			ReplyMarkup: markup,
		}
		if replyToMessageID > 0 {
			mdReq.ReplyParameters = &telegram.ReplyParameters{MessageID: replyToMessageID}
		}
		if err := b.tg.SendRichMessageRaw(mdReq); err == nil {
			return nil
		}
	}

	// 3. HTML 降级模式（展开抽屉为 blockquote expandable，对齐表格，安全切片）
	htmlText := format.RichBlocksToHTML(blocks)
	chunks := telegram.SplitMessage(htmlText, 4000)
	htmlOk := true

	for idx, chunk := range chunks {
		var chunkMarkup *telegram.InlineKeyboardMarkup
		if idx == len(chunks)-1 {
			chunkMarkup = markup
		}
		_, err := b.tg.SendMessage(chatID, chunk, "HTML", replyToMessageID, chunkMarkup)
		if err != nil {
			htmlOk = false
			log.Printf("[Bot] HTML sendMessage failed, falling back to plain text: %v", err)
			break
		}
	}
	if htmlOk {
		return nil
	}

	// 4. 纯文本兜底
	plainText := format.RichBlocksToPlainText(blocks)
	plainChunks := telegram.SplitMessage(plainText, 4000)
	for idx, chunk := range chunks {
		var chunkMarkup *telegram.InlineKeyboardMarkup
		if idx == len(plainChunks)-1 {
			chunkMarkup = markup
		}
		_, _ = b.tg.SendMessage(chatID, chunk, "", replyToMessageID, chunkMarkup)
	}

	return nil
}

// editRichMessage 实现与原版一致的多级降级富文本编辑
func (b *Bot) editRichMessage(chatID int64, messageID int64, blocks []format.RichBlock, markup *telegram.InlineKeyboardMarkup) error {
	chatIDStr := strconv.FormatInt(chatID, 10)

	// 1. 尝试原生 AST blocks 模式
	astReq := telegram.EditRichMessagePayload{
		ChatID:    chatIDStr,
		MessageID: messageID,
		RichMessage: &telegram.RichMessageContent{
			Blocks: blocks,
		},
		ReplyMarkup: markup,
	}
	if err := b.tg.EditRichMessageRaw(astReq); err == nil {
		return nil
	}

	// 2. HTML 降级模式
	htmlText := format.RichBlocksToHTML(blocks)
	if len(htmlText) <= 4000 {
		if _, err := b.tg.EditMessageText(chatID, messageID, htmlText, "HTML", markup); err == nil {
			return nil
		}
	}

	// 3. 纯文本降级模式
	plainText := format.RichBlocksToPlainText(blocks)
	if len(plainText) > 4000 {
		plainText = plainText[:4000]
	}
	_, err := b.tg.EditMessageText(chatID, messageID, plainText, "", markup)
	return err
}
