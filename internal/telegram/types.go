package telegram

type Update struct {
	UpdateID      int64          `json:"update_id"`
	Message       *Message       `json:"message,omitempty"`
	CallbackQuery *CallbackQuery `json:"callback_query,omitempty"`
}

type User struct {
	ID        int64  `json:"id"`
	IsBot     bool   `json:"is_bot"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name,omitempty"`
	Username  string `json:"username,omitempty"`
}

type Chat struct {
	ID       int64  `json:"id"`
	Type     string `json:"type"` // 对话类型：private、group、supergroup、channel
	Title    string `json:"title,omitempty"`
	Username string `json:"username,omitempty"`
}

type PhotoSize struct {
	FileID   string `json:"file_id"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	FileSize int64  `json:"file_size,omitempty"`
}

type Voice struct {
	FileID   string `json:"file_id"`
	Duration int    `json:"duration"`
	FileSize int64  `json:"file_size,omitempty"`
}

type ForwardOrigin struct {
	Type           string `json:"type"` // 消息转发来源类型
	SenderUser     *User  `json:"sender_user,omitempty"`
	SenderUserName string `json:"sender_user_name,omitempty"`
	SenderChat     *Chat  `json:"sender_chat,omitempty"`
	Chat           *Chat  `json:"chat,omitempty"`
}

type Message struct {
	MessageID         int64          `json:"message_id"`
	From              *User          `json:"from,omitempty"`
	SenderChat        *Chat          `json:"sender_chat,omitempty"`
	Chat              *Chat          `json:"chat"`
	Date              int64          `json:"date"`
	Text              string         `json:"text,omitempty"`
	Caption           string         `json:"caption,omitempty"`
	Photo             []PhotoSize    `json:"photo,omitempty"`
	Voice             *Voice         `json:"voice,omitempty"`
	ReplyToMessage    *Message       `json:"reply_to_message,omitempty"`
	ForwardOrigin     *ForwardOrigin `json:"forward_origin,omitempty"`
	ForwardFrom       *User          `json:"forward_from,omitempty"`
	ForwardSenderName string         `json:"forward_sender_name,omitempty"`
	ForwardFromChat   *Chat          `json:"forward_from_chat,omitempty"`
}

type CallbackQuery struct {
	ID      string   `json:"id"`
	From    *User    `json:"from"`
	Message *Message `json:"message,omitempty"`
	Data    string   `json:"data"`
}

type InlineKeyboardButton struct {
	Text         string `json:"text"`
	CallbackData string `json:"callback_data,omitempty"`
	URL          string `json:"url,omitempty"`
}

type InlineKeyboardMarkup struct {
	InlineKeyboard [][]InlineKeyboardButton `json:"inline_keyboard"`
}

type ReplyParameters struct {
	MessageID int64 `json:"message_id"`
}

type BotCommand struct {
	Command     string `json:"command"`
	Description string `json:"description"`
}

type BotCommandScope struct {
	Type   string      `json:"type"`
	ChatID interface{} `json:"chat_id,omitempty"`
}

type FileResponse struct {
	Ok     bool `json:"ok"`
	Result struct {
		FileID   string `json:"file_id"`
		FilePath string `json:"file_path"`
	} `json:"result"`
}
