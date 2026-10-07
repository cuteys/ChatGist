package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type Client struct {
	token      string
	apiBase    string
	httpClient *http.Client
}

func New(token string) *Client {
	return &Client{
		token:   token,
		apiBase: fmt.Sprintf("https://api.telegram.org/bot%s", token),
		httpClient: &http.Client{
			Timeout: 65 * time.Second, // 略长于 getUpdates 的 30 秒轮询周期，避免连接被提前切断
		},
	}
}

func (c *Client) post(method string, payload interface{}, out interface{}) error {
	url := fmt.Sprintf("%s/%s", c.apiBase, method)
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequest("POST", url, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	var res struct {
		Ok          bool            `json:"ok"`
		ErrorCode   int             `json:"error_code"`
		Description string          `json:"description"`
		Result      json.RawMessage `json:"result"`
	}

	if err := json.Unmarshal(body, &res); err != nil {
		return fmt.Errorf("telegram response unmarshal failed: %w (raw: %s)", err, string(body))
	}

	if !res.Ok {
		return fmt.Errorf("telegram api error (%d): %s", res.ErrorCode, res.Description)
	}

	if out != nil && len(res.Result) > 0 {
		return json.Unmarshal(res.Result, out)
	}
	return nil
}

func (c *Client) GetUpdates(offset int64, limit int, timeoutSec int) ([]Update, error) {
	req := map[string]interface{}{
		"offset":  offset,
		"limit":   limit,
		"timeout": timeoutSec,
	}
	var updates []Update
	err := c.post("getUpdates", req, &updates)
	return updates, err
}

func (c *Client) DeleteWebhook(dropPendingUpdates bool) error {
	req := map[string]interface{}{
		"drop_pending_updates": dropPendingUpdates,
	}
	var res bool
	return c.post("deleteWebhook", req, &res)
}

func (c *Client) SendMessage(chatID int64, text string, parseMode string, replyToMessageID int64, markup *InlineKeyboardMarkup) (*Message, error) {
	req := map[string]interface{}{
		"chat_id": chatID,
		"text":    text,
	}
	if parseMode != "" {
		req["parse_mode"] = parseMode
	}
	if replyToMessageID > 0 {
		req["reply_parameters"] = ReplyParameters{MessageID: replyToMessageID}
	}
	if markup != nil {
		req["reply_markup"] = markup
	}

	var msg Message
	err := c.post("sendMessage", req, &msg)
	return &msg, err
}

func (c *Client) EditMessageText(chatID int64, messageID int64, text string, parseMode string, markup *InlineKeyboardMarkup) (*Message, error) {
	req := map[string]interface{}{
		"chat_id":    chatID,
		"message_id": messageID,
		"text":       text,
	}
	if parseMode != "" {
		req["parse_mode"] = parseMode
	}
	if markup != nil {
		req["reply_markup"] = markup
	}

	var msg Message
	err := c.post("editMessageText", req, &msg)
	return &msg, err
}

func (c *Client) SendRichMessageRaw(payload SendRichMessagePayload) error {
	return c.post("sendRichMessage", payload, nil)
}

func (c *Client) EditRichMessageRaw(payload EditRichMessagePayload) error {
	return c.post("editRichMessage", payload, nil)
}

func (c *Client) DeleteMessage(chatID int64, messageID int64) error {
	req := map[string]interface{}{
		"chat_id":    chatID,
		"message_id": messageID,
	}
	return c.post("deleteMessage", req, nil)
}

func (c *Client) SendChatAction(chatID int64, action string) error {
	req := map[string]interface{}{
		"chat_id": chatID,
		"action":  action,
	}
	return c.post("sendChatAction", req, nil)
}

func (c *Client) AnswerCallbackQuery(callbackQueryID string, text string) error {
	req := map[string]interface{}{
		"callback_query_id": callbackQueryID,
	}
	if text != "" {
		req["text"] = text
	}
	return c.post("answerCallbackQuery", req, nil)
}

func (c *Client) SetMyCommands(commands []BotCommand, scope *BotCommandScope) error {
	req := map[string]interface{}{
		"commands": commands,
	}
	if scope != nil {
		req["scope"] = scope
	}
	return c.post("setMyCommands", req, nil)
}

func (c *Client) GetFile(fileID string) (*FileResponse, error) {
	req := map[string]interface{}{
		"file_id": fileID,
	}
	var res FileResponse
	url := fmt.Sprintf("%s/getFile", c.apiBase)
	data, _ := json.Marshal(req)
	resp, err := c.httpClient.Post(url, "application/json", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, err
	}
	return &res, nil
}

func (c *Client) DownloadFile(filePath string) ([]byte, error) {
	url := fmt.Sprintf("https://api.telegram.org/file/bot%s/%s", c.token, filePath)
	resp, err := c.httpClient.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	return io.ReadAll(resp.Body)
}

// StartTypingKeeper 维持打字中状态心跳（Telegram 的 typing 状态单次仅维持约 5 秒）
func (c *Client) StartTypingKeeper(ctx context.Context, chatID int64) {
	go func() {
		_ = c.SendChatAction(chatID, "typing")
		ticker := time.NewTicker(4 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = c.SendChatAction(chatID, "typing")
			}
		}
	}()
}

func SplitMessage(text string, maxLength int) []string {
	if maxLength <= 0 {
		maxLength = 4000
	}
	if len(text) <= maxLength {
		return []string{text}
	}

	var chunks []string
	remaining := text

	for len(remaining) > 0 {
		if len(remaining) <= maxLength {
			chunks = append(chunks, remaining)
			break
		}

		splitIdx := strings.LastIndex(remaining[:maxLength], "\n\n")
		if splitIdx == -1 || splitIdx < int(float64(maxLength)*0.4) {
			splitIdx = strings.LastIndex(remaining[:maxLength], "\n")
		}
		if splitIdx == -1 || splitIdx < int(float64(maxLength)*0.4) {
			splitIdx = strings.LastIndex(remaining[:maxLength], " ")
		}
		if splitIdx == -1 || splitIdx < int(float64(maxLength)*0.2) {
			splitIdx = maxLength
		}

		chunks = append(chunks, strings.TrimSpace(remaining[:splitIdx]))
		remaining = strings.TrimSpace(remaining[splitIdx:])
	}
	return chunks
}

func CleanGroupID(groupID string) string {
	res := strings.TrimPrefix(groupID, "-100")
	return strings.TrimPrefix(res, "-")
}

func GetMessageLink(groupID string, messageID int64) string {
	cleanID := CleanGroupID(groupID)
	return fmt.Sprintf("https://t.me/c/%s/%d", cleanID, messageID)
}

func ToSuperscript(num int) string {
	supers := map[rune]string{
		'0': "⁰", '1': "¹", '2': "²", '3': "³", '4': "⁴",
		'5': "⁵", '6': "⁶", '7': "⁷", '8': "⁸", '9': "⁹",
	}
	s := strconv.Itoa(num)
	var sb strings.Builder
	for _, r := range s {
		if sup, ok := supers[r]; ok {
			sb.WriteString(sup)
		} else {
			sb.WriteRune(r)
		}
	}
	return sb.String()
}

// GenerateQueryPaginationKeyboard 构造关键词检索的分页内联键盘
func GenerateQueryPaginationKeyboard(keyword string, currentPage int, totalPages int) *InlineKeyboardMarkup {
	if totalPages <= 1 {
		return nil
	}

	safeKeyword := keyword
	runes := []rune(keyword)
	if len(runes) > 15 {
		safeKeyword = string(runes[:15])
	}

	var row1 []InlineKeyboardButton
	if totalPages <= 5 {
		for i := 1; i <= totalPages; i++ {
			text := fmt.Sprintf("%d", i)
			cb := fmt.Sprintf("qp:%d:%s", i, safeKeyword)
			if i == currentPage {
				text = fmt.Sprintf("【%d】", i)
				cb = "noop"
			}
			row1 = append(row1, InlineKeyboardButton{Text: text, CallbackData: cb})
		}
	} else {
		// 首页
		p1Text := "1"
		p1Cb := fmt.Sprintf("qp:1:%s", safeKeyword)
		if currentPage == 1 {
			p1Text = "【1】"
			p1Cb = "noop"
		}
		row1 = append(row1, InlineKeyboardButton{Text: p1Text, CallbackData: p1Cb})

		start := currentPage - 1
		if start < 2 {
			start = 2
		}
		end := currentPage + 1
		if end > totalPages-1 {
			end = totalPages - 1
		}

		if currentPage <= 3 {
			start = 2
			end = 4
		} else if currentPage >= totalPages-2 {
			start = totalPages - 3
			end = totalPages - 1
		}

		if start > 2 {
			row1 = append(row1, InlineKeyboardButton{Text: "...", CallbackData: "noop"})
		}

		for i := start; i <= end; i++ {
			text := fmt.Sprintf("%d", i)
			cb := fmt.Sprintf("qp:%d:%s", i, safeKeyword)
			if i == currentPage {
				text = fmt.Sprintf("【%d】", i)
				cb = "noop"
			}
			row1 = append(row1, InlineKeyboardButton{Text: text, CallbackData: cb})
		}

		if end < totalPages-1 {
			row1 = append(row1, InlineKeyboardButton{Text: "...", CallbackData: "noop"})
		}

		// 末页
		lastText := fmt.Sprintf("%d", totalPages)
		lastCb := fmt.Sprintf("qp:%d:%s", totalPages, safeKeyword)
		if currentPage == totalPages {
			lastText = fmt.Sprintf("【%d】", totalPages)
			lastCb = "noop"
		}
		row1 = append(row1, InlineKeyboardButton{Text: lastText, CallbackData: lastCb})
	}

	prevCb := fmt.Sprintf("qp:%d:%s", currentPage-1, safeKeyword)
	if currentPage <= 1 {
		prevCb = "noop"
	}
	nextCb := fmt.Sprintf("qp:%d:%s", currentPage+1, safeKeyword)
	if currentPage >= totalPages {
		nextCb = "noop"
	}

	row2 := []InlineKeyboardButton{
		{Text: "⬅️ 上一页", CallbackData: prevCb},
		{Text: "下一页 ➡️", CallbackData: nextCb},
	}

	return &InlineKeyboardMarkup{
		InlineKeyboard: [][]InlineKeyboardButton{row1, row2},
	}
}
