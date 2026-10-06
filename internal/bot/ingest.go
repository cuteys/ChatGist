package bot

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/cuteys/ChatGist/internal/og"
	"github.com/cuteys/ChatGist/internal/storage"
	"github.com/cuteys/ChatGist/internal/telegram"
)

func (b *Bot) handleIngest(msg *telegram.Message) {
	if !isGroupChat(msg.Chat) {
		return
	}

	groupID := strconv.FormatInt(msg.Chat.ID, 10)
	if !b.whitelist.IsGroupWhitelisted(groupID) {
		return
	}

	content := strings.TrimSpace(msg.Text)
	if content == "" && msg.Caption != "" {
		content = strings.TrimSpace(msg.Caption)
	}

	// 提取并追加网页 OpenGraph 标题与摘要
	urls := og.FindURLs(content)
	if len(urls) > 0 {
		var ogInfos []string
		for _, u := range urls {
			info := og.ExtractOGInfo(u)
			if info != "" && info != u {
				ogInfos = append(ogInfos, info)
			}
		}
		if len(ogInfos) > 0 {
			content += "\n\n" + strings.Join(ogInfos, "\n\n")
		}
	}

	// 提取图片 Base64 供多模态模型解析
	if len(msg.Photo) > 0 {
		imgB64 := b.extractImageBase64(msg.Photo)
		if imgB64 != "" {
			if content != "" {
				content = fmt.Sprintf("%s\n\n%s", content, imgB64)
			} else {
				content = imgB64
			}
		}
	}

	if content == "" {
		return
	}

	// 关联转发来源与引用回复上下文
	if msg.ForwardOrigin != nil {
		sender := ""
		switch msg.ForwardOrigin.Type {
		case "user":
			if msg.ForwardOrigin.SenderUser != nil {
				sender = getUserDisplayName(msg.ForwardOrigin.SenderUser)
			}
		case "channel", "chat":
			if msg.ForwardOrigin.SenderChat != nil {
				sender = msg.ForwardOrigin.SenderChat.Title
			}
		case "hidden_user":
			sender = msg.ForwardOrigin.SenderUserName
		}
		if sender != "" {
			content = fmt.Sprintf("转发自 %s: %s", sender, content)
		}
	} else if msg.ForwardFrom != nil {
		content = fmt.Sprintf("转发自 %s: %s", getUserDisplayName(msg.ForwardFrom), content)
	} else if msg.ForwardSenderName != "" {
		content = fmt.Sprintf("转发自 %s: %s", msg.ForwardSenderName, content)
	}

	if msg.ReplyToMessage != nil {
		replyLink := telegram.GetMessageLink(groupID, msg.ReplyToMessage.MessageID)
		content = fmt.Sprintf("回复 %s: %s", replyLink, content)
	}

	msgTime := time.Now()
	if msg.Date > 0 {
		msgTime = time.Unix(msg.Date, 0)
	}

	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		loc = time.FixedZone("CST", 8*3600)
	}
	timeStr := msgTime.In(loc).Format("2006-01-02 15:04:05")

	dbMsg := &storage.Message{
		ID:          fmt.Sprintf("%s_%d", groupID, msg.MessageID),
		GroupID:     groupID,
		TimeStamp:   msgTime.UnixMilli(),
		UserName:    getUserDisplayName(msg.From),
		Content:     content,
		MessageID:   msg.MessageID,
		GroupName:   msg.Chat.Title,
		MessageTime: timeStr,
	}

	_ = b.storage.SaveMessage(dbMsg)

	// 抽样触发过期消息与旧图片清理
	if msg.MessageID%100 == 0 {
		_, _, _ = b.storage.CleanupOldMessagesAndImages(b.cfg.LimitGroupMessages, b.cfg.LimitGroupImages)
	}
}
