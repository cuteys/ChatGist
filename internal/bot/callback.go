package bot

import (
	"math"
	"strconv"
	"strings"

	"github.com/cuteys/ChatGist/internal/telegram"
)

func (b *Bot) handleCallbackQuery(cq *telegram.CallbackQuery) {
	if cq == nil {
		return
	}
	_ = b.tg.AnswerCallbackQuery(cq.ID, "")

	if cq.Data == "" || cq.Data == "noop" || cq.Message == nil {
		return
	}

	if strings.HasPrefix(cq.Data, "qp:") {
		parts := strings.Split(cq.Data, ":")
		if len(parts) < 3 {
			return
		}
		page, _ := strconv.Atoi(parts[1])
		keyword := strings.Join(parts[2:], ":")

		groupID := strconv.FormatInt(cq.Message.Chat.ID, 10)
		if isGroupChat(cq.Message.Chat) && !b.whitelist.IsGroupWhitelisted(groupID) {
			return
		}

		const pageSize = 6
		if page < 1 {
			page = 1
		}
		offset := (page - 1) * pageSize

		results, totalCount, err := b.storage.QueryMessages(groupID, keyword, pageSize, offset)
		if err != nil || totalCount == 0 {
			return
		}

		totalPages := int(math.Ceil(float64(totalCount) / float64(pageSize)))
		htmlText, markup := buildQueryPageHTML(groupID, keyword, results, totalCount, page, totalPages)

		_, _ = b.tg.EditMessageText(cq.Message.Chat.ID, cq.Message.MessageID, htmlText, "HTML", markup)
	}
}
