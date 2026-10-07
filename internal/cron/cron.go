package cron

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/cuteys/ChatGist/internal/ai"
	"github.com/cuteys/ChatGist/internal/config"
	"github.com/cuteys/ChatGist/internal/format"
	"github.com/cuteys/ChatGist/internal/quota"
	"github.com/cuteys/ChatGist/internal/storage"
	"github.com/cuteys/ChatGist/internal/telegram"
	"github.com/cuteys/ChatGist/internal/whitelist"
)

type Runner struct {
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
) *Runner {
	return &Runner{
		cfg:       cfg,
		storage:   store,
		whitelist: wl,
		quota:     q,
		ai:        aiClient,
		tg:        tgClient,
	}
}

func (r *Runner) Start(ctx context.Context) {
	if !r.cfg.CronEnabled {
		log.Println("[Cron] Cron scheduler is disabled by config.")
		return
	}

	log.Printf("[Cron] Daily cron scheduler started (target: %02d:00 Beijing Time)...", r.cfg.CronHourBeijing)

	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		loc = time.FixedZone("CST", 8*3600)
	}

	go func() {
		for {
			now := time.Now().In(loc)
			nextRun := time.Date(now.Year(), now.Month(), now.Day(), r.cfg.CronHourBeijing, 0, 0, 0, loc)
			if !now.Before(nextRun) {
				nextRun = nextRun.AddDate(0, 0, 1)
			}

			waitDuration := nextRun.Sub(now)
			log.Printf("[Cron] Next daily summary run at: %s (in %v)", nextRun.Format("2006-01-02 15:04:05"), waitDuration)

			select {
			case <-ctx.Done():
				return
			case <-time.After(waitDuration):
				r.executeDailyTasks(ctx)
			}
		}
	}()
}

func (r *Runner) sanitizeSecrets(text string) string {
	res := text
	if r.cfg.AIAPIKey != "" {
		res = strings.ReplaceAll(res, r.cfg.AIAPIKey, "[REDACTED]")
	}
	if r.cfg.AIBaseURL != "" {
		res = strings.ReplaceAll(res, r.cfg.AIBaseURL, "[REDACTED]")
	}
	if r.cfg.TelegramBotToken != "" {
		res = strings.ReplaceAll(res, r.cfg.TelegramBotToken, "[REDACTED]")
	}
	return res
}

func (r *Runner) notifySuperAdminsError(scene, groupID, groupName string, err error) {
	if len(r.cfg.AdminUserIDs) == 0 || err == nil {
		return
	}

	sanitizedErr := r.sanitizeSecrets(err.Error())
	runes := []rune(sanitizedErr)
	if len(runes) > 1500 {
		sanitizedErr = string(runes[:1500]) + "...[TRUNCATED]"
	}

	loc := time.FixedZone("CST", 8*3600)
	timeStr := time.Now().In(loc).Format("2006-01-02 15:04:05")

	text := fmt.Sprintf("🚨 【ChatGist 系统异常告警】\n• 触发场景: %s\n• 发生群组: %s (ID: %s)\n• 发生时间: %s (北京时间)\n\n📋 错误信息与堆栈:\n```\n%s\n```",
		scene, groupName, groupID, timeStr, sanitizedErr)

	for _, adminIDStr := range r.cfg.AdminUserIDs {
		adminIDStr = strings.TrimSpace(adminIDStr)
		if adminIDStr == "" {
			continue
		}
		adminID, parseErr := strconv.ParseInt(adminIDStr, 10, 64)
		if parseErr != nil {
			continue
		}
		_, sendErr := r.tg.SendMessage(adminID, text, "Markdown", 0, nil)
		if sendErr != nil {
			_, _ = r.tg.SendMessage(adminID, text, "", 0, nil)
		}
	}
}

func (r *Runner) sendRichMessage(chatID int64, blocks []format.RichBlock, rawMarkdown string) error {
	chatIDStr := strconv.FormatInt(chatID, 10)

	// 1. 尝试原生 AST blocks 模式
	astReq := telegram.SendRichMessagePayload{
		ChatID: chatIDStr,
		RichMessage: &telegram.RichMessageContent{
			Blocks: blocks,
		},
	}
	if err := r.tg.SendRichMessageRaw(astReq); err == nil {
		return nil
	}

	// 2. 尝试原生 Markdown 模式
	if rawMarkdown != "" {
		mdReq := telegram.SendRichMessagePayload{
			ChatID: chatIDStr,
			RichMessage: &telegram.RichMessageContent{
				Markdown: rawMarkdown,
			},
		}
		if err := r.tg.SendRichMessageRaw(mdReq); err == nil {
			return nil
		}
	}

	// 3. HTML 模式降级
	htmlText := format.RichBlocksToHTML(blocks)
	chunks := telegram.SplitMessage(htmlText, 4000)
	htmlOk := true

	for _, chunk := range chunks {
		_, err := r.tg.SendMessage(chatID, chunk, "HTML", 0, nil)
		if err != nil {
			htmlOk = false
			break
		}
	}
	if htmlOk {
		return nil
	}

	// 4. 纯文本兜底
	plainText := format.RichBlocksToPlainText(blocks)
	plainChunks := telegram.SplitMessage(plainText, 4000)
	for _, chunk := range plainChunks {
		_, _ = r.tg.SendMessage(chatID, chunk, "", 0, nil)
	}
	return nil
}

func (r *Runner) executeDailyTasks(ctx context.Context) {
	log.Println("[Cron] Executing daily scheduled tasks...")

	// 1. 遍历白名单群组生成昨日总结
	groups, err := r.whitelist.GetWhitelistedGroups()
	if err == nil {
		nowMilli := time.Now().UnixMilli()
		yesterdayMilli := nowMilli - 24*3600*1000

		for _, g := range groups {
			select {
			case <-ctx.Done():
				return
			default:
			}

			chatID, err := strconv.ParseInt(g.GroupID, 10, 64)
			if err != nil {
				continue
			}

			messages, err := r.storage.GetMessagesBetween(g.GroupID, yesterdayMilli, nowMilli)
			if err != nil || len(messages) < 5 {
				continue // 24小时内发言不足5条的低活跃群组跳过
			}

			quoteNotice := fmt.Sprintf("⏰ 【每日定时总结】昨日群聊重点精炼（共 %d 条）", len(messages))
			summaryCtx, cancel := context.WithTimeout(ctx, 300*time.Second)

			raw, err := r.ai.SummarizeChat(summaryCtx, messages, quoteNotice)
			cancel()
			if err != nil {
				log.Printf("[Cron] Failed to summarize for group %s (%s): %v", g.GroupName, g.GroupID, err)
				r.notifySuperAdminsError("每日定时总结 (00:00 Cron)", g.GroupID, g.GroupName, err)
				continue
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
						"text": r.cfg.AIModel,
					},
				},
			)

			_ = r.sendRichMessage(chatID, blocks, raw)
			time.Sleep(2 * time.Second) // 群组间发送间隔避让 Telegram API 限速
		}
	}

	// 2. 存储容量与过期配额记录清理
	_, _, _ = r.storage.CleanupOldMessagesAndImages(r.cfg.LimitGroupMessages, r.cfg.LimitGroupImages)
	_ = r.quota.CleanOldQuotaRecords()

	log.Println("[Cron] Daily scheduled tasks completed.")
}
