package bot

import (
	"math"
	"strconv"
	"strings"

	"github.com/cuteys/ChatGist/internal/format"
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
		clampedPage := page
		if clampedPage > totalPages {
			clampedPage = totalPages
		}
		if clampedPage < 1 {
			clampedPage = 1
		}

		blocks := format.BuildQueryRichBlocks(keyword, totalCount, results, clampedPage, pageSize)
		markup := telegram.GenerateQueryPaginationKeyboard(keyword, clampedPage, totalPages)

		_ = b.editRichMessage(cq.Message.Chat.ID, cq.Message.MessageID, blocks, markup)
	}
}
