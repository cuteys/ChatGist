package whitelist

import (
	"strings"
	"sync"
	"time"

	"github.com/cuteys/ChatGist/internal/config"
	"github.com/cuteys/ChatGist/internal/storage"
)

type Manager struct {
	cfg          *config.Config
	storage      *storage.Storage
	cacheMux     sync.RWMutex
	cacheSet     map[string]struct{}
	cacheExpires time.Time
}

func New(cfg *config.Config, store *storage.Storage) *Manager {
	return &Manager{
		cfg:     cfg,
		storage: store,
	}
}

func (m *Manager) IsSuperAdmin(userID string) bool {
	uid := strings.TrimSpace(userID)
	if uid == "" {
		return false
	}
	for _, admin := range m.cfg.AdminUserIDs {
		if admin == uid {
			return true
		}
	}
	return false
}

func (m *Manager) IsAdmin(userID string) bool {
	uid := strings.TrimSpace(userID)
	if uid == "" {
		return false
	}
	if m.IsSuperAdmin(uid) {
		return true
	}

	var found string
	err := m.storage.DB().QueryRow("SELECT userId FROM Admins WHERE userId = ?", uid).Scan(&found)
	return err == nil && found != ""
}

func (m *Manager) InvalidateCache() {
	m.cacheMux.Lock()
	defer m.cacheMux.Unlock()
	m.cacheSet = nil
}

func (m *Manager) IsGroupWhitelisted(groupID string) bool {
	gid := strings.TrimSpace(groupID)
	if gid == "" {
		return false
	}

	m.cacheMux.RLock()
	if m.cacheSet != nil && time.Now().Before(m.cacheExpires) {
		_, ok := m.cacheSet[gid]
		m.cacheMux.RUnlock()
		return ok
	}
	m.cacheMux.RUnlock()

	groups, err := m.GetWhitelistedGroups()
	if err != nil {
		return false
	}

	set := make(map[string]struct{}, len(groups))
	for _, g := range groups {
		set[g.GroupID] = struct{}{}
	}

	m.cacheMux.Lock()
	m.cacheSet = set
	m.cacheExpires = time.Now().Add(60 * time.Second)
	m.cacheMux.Unlock()

	_, ok := set[gid]
	return ok
}

func (m *Manager) AddGroup(groupID, groupName, addedBy string) error {
	name := strings.TrimSpace(groupName)
	if name == "" {
		name = "未命名群组"
	}
	query := `
		INSERT OR REPLACE INTO WhitelistGroups (groupId, groupName, addedBy, createdAt)
		VALUES (?, ?, ?, ?)
	`
	_, err := m.storage.DB().Exec(query, groupID, name, addedBy, time.Now().UnixMilli())
	if err == nil {
		m.InvalidateCache()
	}
	return err
}

func (m *Manager) RemoveGroup(groupID string) error {
	_, err := m.storage.DB().Exec("DELETE FROM WhitelistGroups WHERE groupId = ?", groupID)
	if err == nil {
		m.InvalidateCache()
	}
	return err
}

func (m *Manager) GetWhitelistedGroups() ([]*storage.WhitelistGroup, error) {
	rows, err := m.storage.DB().Query("SELECT groupId, groupName, addedBy, createdAt FROM WhitelistGroups ORDER BY createdAt DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []*storage.WhitelistGroup
	for rows.Next() {
		g := &storage.WhitelistGroup{}
		if err := rows.Scan(&g.GroupID, &g.GroupName, &g.AddedBy, &g.CreatedAt); err != nil {
			return nil, err
		}
		list = append(list, g)
	}
	return list, nil
}

func (m *Manager) AddAdmin(userID, userName, addedBy string) error {
	name := strings.TrimSpace(userName)
	if name == "" {
		name = "未命名管理员"
	}
	query := `
		INSERT OR REPLACE INTO Admins (userId, userName, addedBy, createdAt)
		VALUES (?, ?, ?, ?)
	`
	_, err := m.storage.DB().Exec(query, userID, name, addedBy, time.Now().UnixMilli())
	return err
}

func (m *Manager) RemoveAdmin(userID string) error {
	_, err := m.storage.DB().Exec("DELETE FROM Admins WHERE userId = ?", userID)
	return err
}

func (m *Manager) GetAdmins() ([]*storage.Admin, error) {
	rows, err := m.storage.DB().Query("SELECT userId, userName, addedBy, createdAt FROM Admins ORDER BY createdAt DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []*storage.Admin
	for rows.Next() {
		a := &storage.Admin{}
		if err := rows.Scan(&a.UserID, &a.UserName, &a.AddedBy, &a.CreatedAt); err != nil {
			return nil, err
		}
		list = append(list, a)
	}
	return list, nil
}

func (m *Manager) GetSuperAdminIDs() []string {
	return m.cfg.AdminUserIDs
}
