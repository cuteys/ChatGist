package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/cuteys/ChatGist/internal/ai"
	"github.com/cuteys/ChatGist/internal/bot"
	"github.com/cuteys/ChatGist/internal/config"
	"github.com/cuteys/ChatGist/internal/cron"
	"github.com/cuteys/ChatGist/internal/quota"
	"github.com/cuteys/ChatGist/internal/storage"
	"github.com/cuteys/ChatGist/internal/telegram"
	"github.com/cuteys/ChatGist/internal/whitelist"
)

func main() {
	log.Println("[Main] Initializing ChatGist Bot (Docker Go Edition)...")

	cfg := config.Load()
	if cfg.TelegramBotToken == "" {
		log.Fatal("[Main] Fatal: TELEGRAM_BOT_TOKEN is not set.")
	}
	if cfg.AIAPIKey == "" {
		log.Fatal("[Main] Fatal: AI_API_KEY is not set.")
	}

	store, err := storage.New(cfg.DBPath)
	if err != nil {
		log.Fatalf("[Main] Fatal: Failed to initialize SQLite storage at %s: %v", cfg.DBPath, err)
	}
	defer store.Close()
	log.Printf("[Main] SQLite storage initialized successfully at %s", cfg.DBPath)

	wl := whitelist.New(cfg, store)
	q := quota.New(cfg, store, wl)
	aiClient := ai.New(cfg)
	tgClient := telegram.New(cfg.TelegramBotToken)

	b := bot.New(cfg, store, wl, q, aiClient, tgClient)
	c := cron.New(cfg, store, wl, q, aiClient, tgClient)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	c.Start(ctx)

	if err := b.Start(ctx); err != nil {
		log.Printf("[Main] Bot stopped with error: %v", err)
	}

	log.Println("[Main] ChatGist shutdown completed cleanly.")
}
