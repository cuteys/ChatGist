package bot

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/cuteys/ChatGist/internal/ai"
	"github.com/cuteys/ChatGist/internal/config"
	"github.com/cuteys/ChatGist/internal/quota"
	"github.com/cuteys/ChatGist/internal/storage"
	"github.com/cuteys/ChatGist/internal/telegram"
	"github.com/cuteys/ChatGist/internal/whitelist"
)

type Bot struct {
	cfg       *config.Config
	storage   *storage.Storage
	whitelist *whitelist.Manager
	quota     *quota.Manager
	ai        *ai.Client
	tg        *telegram.Client
}

func New(
	cfg *config.Config,
	store *storage.Storage,
	wl *whitelist.Manager,
	q *quota.Manager,
	aiClient *ai.Client,
	tgClient *telegram.Client,
) *Bot {
	return &Bot{
		cfg:       cfg,
		storage:   store,
		whitelist: wl,
		quota:     q,
		ai:        aiClient,
		tg:        tgClient,
	}
}

func (b *Bot) RegisterBotCommands() error {
	groupCommands := []telegram.BotCommand{
		{Command: "summary", Description: "概括群聊消息"},
		{Command: "ask", Description: "基于群聊记录提问并回答"},
		{Command: "query", Description: "在群聊历史中检索关键词"},
	}
	privateCommands := []telegram.BotCommand{
		{Command: "status", Description: "检查运行状态与配额"},
		{Command: "help", Description: "查看功能与指令使用帮助"},
	}
	superAdminCommands := []telegram.BotCommand{
		{Command: "status", Description: "检查运行状态与配额"},
		{Command: "help", Description: "查看功能与指令使用帮助"},
		{Command: "addgroup", Description: "【超管】将群组加入白名单"},
		{Command: "delgroup", Description: "【超管】将群组移出白名单"},
		{Command: "whitelist", Description: "【超管】查看白名单群组"},
		{Command: "addadmin", Description: "【超管】添加管理员"},
		{Command: "deladmin", Description: "【超管】移除管理员"},
		{Command: "admins", Description: "【超管】查看管理员列表"},
		{Command: "clearmessages", Description: "【超管】清空群组历史消息"},
		{Command: "setcommands", Description: "【超管】同步更新指令菜单"},
	}

	// 1. 群聊指令菜单
	_ = b.tg.SetMyCommands(groupCommands, &telegram.BotCommandScope{Type: "all_group_chats"})

	// 2. 私聊常规指令菜单
	_ = b.tg.SetMyCommands(privateCommands, &telegram.BotCommandScope{Type: "all_private_chats"})

	// 3. 超级管理员专属私聊指令菜单
	for _, adminID := range b.cfg.AdminUserIDs {
		trimmed := strings.TrimSpace(adminID)
		if trimmed == "" {
			continue
		}
		_ = b.tg.SetMyCommands(superAdminCommands, &telegram.BotCommandScope{
			Type:   "chat",
			ChatID: trimmed,
		})
	}
	return nil
}

func (b *Bot) Start(ctx context.Context) error {
	log.Printf("[Bot] Starting ChatGist Bot in %s mode...", b.cfg.Mode)
	_ = b.RegisterBotCommands()

	if b.cfg.Mode == "webhook" {
		return b.startWebhook(ctx)
	}
	return b.startPolling(ctx)
}

func (b *Bot) startPolling(ctx context.Context) error {
	log.Println("[Bot] Long Polling started successfully.")
	var offset int64 = 0

	for {
		select {
		case <-ctx.Done():
			log.Println("[Bot] Polling loop exiting...")
			return nil
		default:
		}

		updates, err := b.tg.GetUpdates(offset, 100, 30)
		if err != nil {
			log.Printf("[Bot] GetUpdates error: %v (retrying in 3s)", err)
			time.Sleep(3 * time.Second)
			continue
		}

		for _, u := range updates {
			if u.UpdateID >= offset {
				offset = u.UpdateID + 1
			}
			go b.ProcessUpdate(&u)
		}
	}
}

func (b *Bot) startWebhook(ctx context.Context) error {
	mux := http.NewServeMux()

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ChatGist Bot (Docker Go Edition) is running."))
			return
		}

		if r.Method != "POST" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		if b.cfg.SecretTelegramAPIToken != "" {
			token := r.Header.Get("X-Telegram-Bot-Api-Secret-Token")
			if token != b.cfg.SecretTelegramAPIToken {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
		}

		var update telegram.Update
		if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		go b.ProcessUpdate(&update)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	server := &http.Server{
		Addr:    ":" + b.cfg.Port,
		Handler: mux,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	log.Printf("[Bot] Webhook listening on :%s", b.cfg.Port)
	return server.ListenAndServe()
}

func (b *Bot) ProcessUpdate(u *telegram.Update) {
	if u == nil {
		return
	}

	if b.storage.IsDuplicateUpdate(u.UpdateID) {
		return
	}

	if u.CallbackQuery != nil {
		b.handleCallbackQuery(u.CallbackQuery)
		return
	}

	msg := u.Message
	if msg == nil {
		return
	}

	text := strings.TrimSpace(msg.Text)
	if text == "" && msg.Caption != "" {
		text = strings.TrimSpace(msg.Caption)
	}

	if strings.HasPrefix(text, "/") {
		// 去除指令中的机器人员名后缀（如 /summary@botname -> /summary）
		parts := strings.Fields(text)
		cmdPart := parts[0]
		if atIdx := strings.Index(cmdPart, "@"); atIdx != -1 {
			cmdPart = cmdPart[:atIdx]
		}
		cmd := strings.ToLower(strings.TrimPrefix(cmdPart, "/"))

		// 群聊常规指令仅限白名单群组可用
		if isGroupChat(msg.Chat) {
			groupID := strconv.FormatInt(msg.Chat.ID, 10)
			isWhitelisted := b.whitelist.IsGroupWhitelisted(groupID)
			if !isWhitelisted {
				// 非白名单群组仅允许系统超管执行授权类管理指令
				userID := ""
				if msg.From != nil {
					userID = strconv.FormatInt(msg.From.ID, 10)
				}
				if !b.whitelist.IsSuperAdmin(userID) {
					return
				}
			}
		}

		switch cmd {
		case "start":
			if !isGroupChat(msg.Chat) {
				_, _ = b.tg.SendMessage(msg.Chat.ID, "👋 你好！欢迎使用 ChatGist 群聊智能助手！\n将我添加到群组并设为管理员即可开始使用，发送 /help 可查看完整指南。", "", msg.MessageID, nil)
			}
		case "summary":
			b.handleSummary(msg)
		case "ask":
			b.handleAsk(msg)
		case "query":
			b.handleQuery(msg)
		case "status":
			b.handleStatus(msg)
		case "help":
			b.handleHelp(msg)
		case "addgroup", "delgroup", "whitelist", "groups", "addadmin", "deladmin", "admins", "clearmessages", "setcommands":
			b.handleAdminCommands(msg, cmd)
		default:
			// 未知指令静默忽略
		}
		return
	}

	// 普通群聊消息归档入库
	b.handleIngest(msg)
}
