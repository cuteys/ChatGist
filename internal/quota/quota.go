package quota

import (
	"database/sql"
	"strings"
	"time"

	"github.com/cuteys/ChatGist/internal/config"
	"github.com/cuteys/ChatGist/internal/storage"
	"github.com/cuteys/ChatGist/internal/whitelist"
)

type Manager struct {
	cfg       *config.Config
	storage   *storage.Storage
	whitelist *whitelist.Manager
}

type CommandQuota struct {
	Current int `json:"current"`
	Limit   int `json:"limit"`
}

type UserQuotaStatus struct {
	IsPrivileged bool         `json:"isPrivileged"`
	Summary      CommandQuota `json:"summary"`
	Ask          CommandQuota `json:"ask"`
	Query        CommandQuota `json:"query"`
}

func New(cfg *config.Config, store *storage.Storage, wl *whitelist.Manager) *Manager {
	return &Manager{
		cfg:       cfg,
		storage:   store,
		whitelist: wl,
	}
}

func (m *Manager) GetTodayDateString() string {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		loc = time.FixedZone("CST", 8*3600)
	}
	return time.Now().In(loc).Format("2006-01-02")
}

func (m *Manager) GetCommandLimit(command string) int {
	switch command {
	case "summary":
		if m.cfg.LimitSummary > 0 {
			return m.cfg.LimitSummary
		}
		if m.cfg.UserDailyLimit > 0 {
			return m.cfg.UserDailyLimit
		}
		return 5
	case "ask":
		if m.cfg.LimitAsk > 0 {
			return m.cfg.LimitAsk
		}
		if m.cfg.UserDailyLimit > 0 {
			return m.cfg.UserDailyLimit
		}
		return 5
	case "query":
		if m.cfg.LimitQuery > 0 {
			return m.cfg.LimitQuery
		}
		if m.cfg.UserDailyLimit > 0 {
			return m.cfg.UserDailyLimit
		}
		return 20
	default:
		return 5
	}
}

func (m *Manager) CheckAndIncrementQuota(userID, command string) (bool, int, int, bool) {
	uid := strings.TrimSpace(userID)
	if m.whitelist.IsAdmin(uid) {
		return true, 0, 999999, true
	}

	limit := m.GetCommandLimit(command)
	today := m.GetTodayDateString()

	var current int
	err := m.storage.DB().QueryRow(
		"SELECT count FROM UserUsage WHERE userId = ? AND date = ? AND command = ?",
		uid, today, command,
	).Scan(&current)

	if err != nil && err != sql.ErrNoRows {
		// 数据库异常时降级放行，避免阻断正常使用
		return true, 0, limit, false
	}

	if current >= limit {
		return false, current, limit, false
	}

	query := `
		INSERT INTO UserUsage (userId, date, command, count)
		VALUES (?, ?, ?, 1)
		ON CONFLICT(userId, date, command)
		DO UPDATE SET count = count + 1
	`
	_, _ = m.storage.DB().Exec(query, uid, today, command)
	return true, current + 1, limit, false
}

func (m *Manager) GetUserQuotaStatus(userID string) (*UserQuotaStatus, error) {
	uid := strings.TrimSpace(userID)
	if m.whitelist.IsAdmin(uid) {
		return &UserQuotaStatus{
			IsPrivileged: true,
			Summary:      CommandQuota{Current: 0, Limit: 999999},
			Ask:          CommandQuota{Current: 0, Limit: 999999},
			Query:        CommandQuota{Current: 0, Limit: 999999},
		}, nil
	}

	today := m.GetTodayDateString()
	limits := map[string]int{
		"summary": m.GetCommandLimit("summary"),
		"ask":     m.GetCommandLimit("ask"),
		"query":   m.GetCommandLimit("query"),
	}

	usage := make(map[string]int)
	rows, err := m.storage.DB().Query(
		"SELECT command, count FROM UserUsage WHERE userId = ? AND date = ?",
		uid, today,
	)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var cmd string
			var count int
			if err := rows.Scan(&cmd, &count); err == nil {
				usage[cmd] = count
			}
		}
	}

	return &UserQuotaStatus{
		IsPrivileged: false,
		Summary:      CommandQuota{Current: usage["summary"], Limit: limits["summary"]},
		Ask:          CommandQuota{Current: usage["ask"], Limit: limits["ask"]},
		Query:        CommandQuota{Current: usage["query"], Limit: limits["query"]},
	}, nil
}

func (m *Manager) CleanOldQuotaRecords() error {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		loc = time.FixedZone("CST", 8*3600)
	}
	cutoff := time.Now().In(loc).AddDate(0, 0, -7).Format("2006-01-02")
	_, err = m.storage.DB().Exec("DELETE FROM UserUsage WHERE date < ?", cutoff)
	return err
}
