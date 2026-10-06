package config

import (
	"os"
	"strconv"
	"strings"
)

type Config struct {
	TelegramBotToken        string
	SecretTelegramAPIToken  string
	AIAPIKey                string
	AIModel                 string
	AIBaseURL               string
	AdminUserIDs            []string
	SystemPromptSummary     string
	SystemPromptAsk         string
	LimitSummary            int
	LimitAsk                int
	LimitQuery              int
	UserDailyLimit          int
	LimitGroupMessages      int
	LimitGroupImages        int
	ReasoningEffort         string
	DBPath                  string
	Mode                    string // 运行模式：polling 或 webhook
	Port                    string
	WebhookURL              string
	CronEnabled             bool
	CronHourBeijing         int
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

func getEnvInt(key string, defaultVal int) int {
	if val := os.Getenv(key); val != "" {
		if i, err := strconv.Atoi(strings.TrimSpace(val)); err == nil {
			return i
		}
	}
	return defaultVal
}

func getEnvBool(key string, defaultVal bool) bool {
	if val := os.Getenv(key); val != "" {
		lower := strings.ToLower(strings.TrimSpace(val))
		return lower == "true" || lower == "1" || lower == "yes"
	}
	return defaultVal
}

func Load() *Config {
	adminRaw := getEnv("ADMIN_USER_IDS", getEnv("ADMIN_USER_ID", ""))
	var adminIDs []string
	for _, id := range strings.Split(adminRaw, ",") {
		trimmed := strings.TrimSpace(id)
		if trimmed != "" {
			adminIDs = append(adminIDs, trimmed)
		}
	}

	apiKey := getEnv("AI_API_KEY", getEnv("OPENAI_API_KEY", getEnv("GEMINI_API_KEY", "")))
	model := getEnv("AI_MODEL", getEnv("MODEL", "gpt-4o-mini"))
	baseURL := getEnv("AI_BASE_URL", getEnv("BASE_URL", ""))

	groupMsgLimit := getEnvInt("LIMIT_GROUP_MESSAGES", getEnvInt("GROUP_MESSAGE_LIMIT", 3000))
	groupImgLimit := getEnvInt("LIMIT_GROUP_IMAGES", getEnvInt("GROUP_IMAGE_LIMIT", 100))

	return &Config{
		TelegramBotToken:       getEnv("TELEGRAM_BOT_TOKEN", ""),
		SecretTelegramAPIToken: getEnv("SECRET_TELEGRAM_API_TOKEN", ""),
		AIAPIKey:               apiKey,
		AIModel:                model,
		AIBaseURL:              baseURL,
		AdminUserIDs:           adminIDs,
		SystemPromptSummary:    getEnv("SYSTEM_PROMPT_SUMMARY", ""),
		SystemPromptAsk:        getEnv("SYSTEM_PROMPT_ASK", ""),
		LimitSummary:           getEnvInt("LIMIT_SUMMARY", 5),
		LimitAsk:               getEnvInt("LIMIT_ASK", 5),
		LimitQuery:             getEnvInt("LIMIT_QUERY", 20),
		UserDailyLimit:         getEnvInt("USER_DAILY_LIMIT", 0),
		LimitGroupMessages:     groupMsgLimit,
		LimitGroupImages:       groupImgLimit,
		ReasoningEffort:        getEnv("REASONING_EFFORT", "medium"),
		DBPath:                 getEnv("DB_PATH", "/app/data/sqlite.db"),
		Mode:                   strings.ToLower(getEnv("MODE", "polling")),
		Port:                   getEnv("PORT", "8080"),
		WebhookURL:             getEnv("WEBHOOK_URL", ""),
		CronEnabled:            getEnvBool("CRON_ENABLED", true),
		CronHourBeijing:        getEnvInt("CRON_HOUR_BEIJING", 0),
	}
}
