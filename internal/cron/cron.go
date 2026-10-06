package cron

import (
	"context"
	"fmt"
	"log"
	"strconv"
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

			htmlContent := format.RichBlocksToHTML(blocks)
			chunks := telegram.SplitMessage(htmlContent, 4000)
			for _, chunk := range chunks {
				_, _ = r.tg.SendMessage(chatID, chunk, "HTML", 0, nil)
			}
			time.Sleep(2 * time.Second) // 群组间发送间隔避让 Telegram API 限速
		}
	}

	// 2. 存储容量与过期配额记录清理
	_, _, _ = r.storage.CleanupOldMessagesAndImages(r.cfg.LimitGroupMessages, r.cfg.LimitGroupImages)
	_ = r.quota.CleanOldQuotaRecords()

	log.Println("[Cron] Daily scheduled tasks completed.")
}
