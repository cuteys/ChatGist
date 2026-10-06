package storage

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type Storage struct {
	db  *sql.DB
	mux sync.RWMutex
}

type Message struct {
	ID          string `json:"id"`
	GroupID     string `json:"groupId"`
	TimeStamp   int64  `json:"timeStamp"`
	UserName    string `json:"userName"`
	Content     string `json:"content"`
	MessageID   int64  `json:"messageId"`
	GroupName   string `json:"groupName"`
	MessageTime string `json:"messageTime"`
}

type GroupStorageStat struct {
	GroupID        string `json:"groupId"`
	GroupName      string `json:"groupName"`
	TotalCount     int64  `json:"totalCount"`
	ImageCount     int64  `json:"imageCount"`
	EstimatedBytes int64  `json:"estimatedBytes"`
}

type WhitelistGroup struct {
	GroupID   string `json:"groupId"`
	GroupName string `json:"groupName"`
	AddedBy   string `json:"addedBy"`
	CreatedAt int64  `json:"createdAt"`
}

type Admin struct {
	UserID    string `json:"userId"`
	UserName  string `json:"userName"`
	AddedBy   string `json:"addedBy"`
	CreatedAt int64  `json:"createdAt"`
}

type StorageStats struct {
	TotalBytes      int64              `json:"totalBytes"`
	PayloadBytes    int64              `json:"payloadBytes"`
	LimitBytes      int64              `json:"limitBytes"`
	TotalTextCount  int64              `json:"totalTextCount"`
	TotalImageCount int64              `json:"totalImageCount"`
	GroupStats      []GroupStorageStat `json:"groupStats"`
}

const SchemaSQL = `
CREATE TABLE IF NOT EXISTS Messages (
	id TEXT PRIMARY KEY,
	groupId TEXT,
	timeStamp INTEGER NOT NULL,
	userName TEXT,
	content TEXT,
	messageId INTEGER,
	groupName TEXT,
	messageTime TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_groupid_timestamp
	ON Messages(groupId, timeStamp DESC);

CREATE TABLE IF NOT EXISTS WhitelistGroups (
	groupId TEXT PRIMARY KEY,
	groupName TEXT,
	addedBy TEXT,
	createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS Admins (
	userId TEXT PRIMARY KEY,
	userName TEXT,
	addedBy TEXT,
	createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS UserUsage (
	userId TEXT NOT NULL,
	date TEXT NOT NULL,
	command TEXT NOT NULL,
	count INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (userId, date, command)
);
CREATE INDEX IF NOT EXISTS idx_userusage_date
	ON UserUsage(date);

CREATE TABLE IF NOT EXISTS ProcessedUpdates (
	updateId INTEGER PRIMARY KEY,
	createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_processed_updates_created_at
	ON ProcessedUpdates(createdAt);
`

func New(dbPath string) (*Storage, error) {
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create db directory %s: %w", dir, err)
	}

	dsn := fmt.Sprintf("%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)", dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open sqlite db: %w", err)
	}

	db.SetMaxOpenConns(1) // 串行写避免 SQLite 数据库锁定竞争
	db.SetMaxIdleConns(1)

	if _, err := db.Exec(SchemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("failed to init schema: %w", err)
	}

	return &Storage{db: db}, nil
}

func (s *Storage) Close() error {
	return s.db.Close()
}

func (s *Storage) DB() *sql.DB {
	return s.db
}

func (s *Storage) IsDuplicateUpdate(updateID int64) bool {
	now := time.Now().UnixMilli()
	res, err := s.db.Exec("INSERT OR IGNORE INTO ProcessedUpdates (updateId, createdAt) VALUES (?, ?)", updateID, now)
	if err != nil {
		return false
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return false
	}
	if rows == 0 {
		return true
	}

	// 抽样清理 10 分钟前的去重记录，避免表体积无限膨胀
	if updateID%20 == 0 {
		_ = s.PruneProcessedUpdates(now - 10*60*1000)
	}
	return false
}

func (s *Storage) PruneProcessedUpdates(olderThanMilli int64) error {
	_, err := s.db.Exec("DELETE FROM ProcessedUpdates WHERE createdAt < ?", olderThanMilli)
	return err
}

func (s *Storage) SaveMessage(msg *Message) error {
	s.mux.Lock()
	defer s.mux.Unlock()

	query := `
		INSERT OR REPLACE INTO Messages (id, groupId, timeStamp, userName, content, messageId, groupName, messageTime)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`
	_, err := s.db.Exec(query,
		msg.ID,
		msg.GroupID,
		msg.TimeStamp,
		msg.UserName,
		msg.Content,
		msg.MessageID,
		msg.GroupName,
		msg.MessageTime,
	)
	return err
}

func (s *Storage) GetRecentMessages(groupID string, limit int, sinceTimeStamp int64) ([]*Message, error) {
	s.mux.RLock()
	defer s.mux.RUnlock()

	var query string
	var rows *sql.Rows
	var err error

	if sinceTimeStamp > 0 {
		query = `
			SELECT id, groupId, timeStamp, userName, content, messageId, groupName, messageTime
			FROM Messages
			WHERE groupId = ? AND timeStamp >= ?
			ORDER BY timeStamp ASC
		`
		rows, err = s.db.Query(query, groupID, sinceTimeStamp)
	} else {
		// 按时间倒序拉取最新 N 条，再子查询正序排列供模型理解时序
		query = `
			SELECT id, groupId, timeStamp, userName, content, messageId, groupName, messageTime
			FROM (
				SELECT id, groupId, timeStamp, userName, content, messageId, groupName, messageTime
				FROM Messages
				WHERE groupId = ?
				ORDER BY timeStamp DESC
				LIMIT ?
			) sub
			ORDER BY timeStamp ASC
		`
		rows, err = s.db.Query(query, groupID, limit)
	}

	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []*Message
	for rows.Next() {
		m := &Message{}
		if err := rows.Scan(&m.ID, &m.GroupID, &m.TimeStamp, &m.UserName, &m.Content, &m.MessageID, &m.GroupName, &m.MessageTime); err != nil {
			return nil, err
		}
		list = append(list, m)
	}
	return list, nil
}

func (s *Storage) GetMessagesBetween(groupID string, startTime, endTime int64) ([]*Message, error) {
	s.mux.RLock()
	defer s.mux.RUnlock()

	query := `
		SELECT id, groupId, timeStamp, userName, content, messageId, groupName, messageTime
		FROM Messages
		WHERE groupId = ? AND timeStamp >= ? AND timeStamp <= ?
		ORDER BY timeStamp ASC
	`
	rows, err := s.db.Query(query, groupID, startTime, endTime)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []*Message
	for rows.Next() {
		m := &Message{}
		if err := rows.Scan(&m.ID, &m.GroupID, &m.TimeStamp, &m.UserName, &m.Content, &m.MessageID, &m.GroupName, &m.MessageTime); err != nil {
			return nil, err
		}
		list = append(list, m)
	}
	return list, nil
}

func (s *Storage) QueryMessages(groupID, keyword string, limit, offset int) ([]*Message, int, error) {
	s.mux.RLock()
	defer s.mux.RUnlock()

	pattern := "%" + strings.TrimSpace(keyword) + "%"

	var count int
	countQuery := `
		SELECT COUNT(*)
		FROM Messages
		WHERE groupId = ? AND content LIKE ? AND content NOT LIKE 'data:image/%'
	`
	if err := s.db.QueryRow(countQuery, groupID, pattern).Scan(&count); err != nil {
		return nil, 0, err
	}

	selectQuery := `
		SELECT id, groupId, timeStamp, userName, content, messageId, groupName, messageTime
		FROM Messages
		WHERE groupId = ? AND content LIKE ? AND content NOT LIKE 'data:image/%'
		ORDER BY timeStamp DESC
		LIMIT ? OFFSET ?
	`
	rows, err := s.db.Query(selectQuery, groupID, pattern, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var list []*Message
	for rows.Next() {
		m := &Message{}
		if err := rows.Scan(&m.ID, &m.GroupID, &m.TimeStamp, &m.UserName, &m.Content, &m.MessageID, &m.GroupName, &m.MessageTime); err != nil {
			return nil, 0, err
		}
		list = append(list, m)
	}
	return list, count, nil
}

func (s *Storage) ClearGroupMessages(groupID string) (int64, error) {
	s.mux.Lock()
	defer s.mux.Unlock()

	res, err := s.db.Exec("DELETE FROM Messages WHERE groupId = ?", groupID)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *Storage) CleanupOldMessagesAndImages(textLimit, imageLimit int) (int64, int64, error) {
	s.mux.Lock()
	defer s.mux.Unlock()

	cleanTextSQL := `
		DELETE FROM Messages
		WHERE id IN (
			SELECT id
			FROM (
				SELECT id, ROW_NUMBER() OVER (PARTITION BY groupId ORDER BY timeStamp DESC) as rn
				FROM Messages
			)
			WHERE rn > ?
		)
	`
	resText, err := s.db.Exec(cleanTextSQL, textLimit)
	var textCleaned int64
	if err == nil {
		textCleaned, _ = resText.RowsAffected()
	}

	cleanImgSQL := `
		DELETE FROM Messages
		WHERE id IN (
			SELECT id
			FROM (
				SELECT id, ROW_NUMBER() OVER (PARTITION BY groupId ORDER BY timeStamp DESC) as rn
				FROM Messages
				WHERE content LIKE 'data:image/%'
			)
			WHERE rn > ?
		)
	`
	resImg, err := s.db.Exec(cleanImgSQL, imageLimit)
	var imgCleaned int64
	if err == nil {
		imgCleaned, _ = resImg.RowsAffected()
	}

	return textCleaned, imgCleaned, nil
}

func (s *Storage) GetDatabaseStorageStats() (*StorageStats, error) {
	s.mux.RLock()
	defer s.mux.RUnlock()

	query := `
		SELECT
			COALESCE(groupId, '') as gid,
			COALESCE(groupName, '未命名群组') as gname,
			COUNT(*) as total_count,
			SUM(CASE WHEN content LIKE 'data:image/%' THEN 1 ELSE 0 END) as image_count,
			COALESCE(SUM(LENGTH(content) + LENGTH(userName) + 64), 0) as estimated_bytes
		FROM Messages
		GROUP BY groupId
		ORDER BY estimated_bytes DESC
	`
	rows, err := s.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var groupStats []GroupStorageStat
	var totalPayload int64
	var totalImages int64
	var totalTexts int64

	for rows.Next() {
		var g GroupStorageStat
		if err := rows.Scan(&g.GroupID, &g.GroupName, &g.TotalCount, &g.ImageCount, &g.EstimatedBytes); err != nil {
			continue
		}
		totalPayload += g.EstimatedBytes
		totalImages += g.ImageCount
		textCount := g.TotalCount - g.ImageCount
		if textCount > 0 {
			totalTexts += textCount
		}
		groupStats = append(groupStats, g)
	}

	// 读取数据库页大小与页数计算实际文件占用
	var pageCount, pageSize int64
	_ = s.db.QueryRow("PRAGMA page_count").Scan(&pageCount)
	_ = s.db.QueryRow("PRAGMA page_size").Scan(&pageSize)
	totalBytes := pageCount * pageSize
	if totalBytes == 0 {
		totalBytes = totalPayload
	}

	return &StorageStats{
		TotalBytes:      totalBytes,
		PayloadBytes:    totalPayload,
		LimitBytes:      500 * 1024 * 1024,
		TotalTextCount:  totalTexts,
		TotalImageCount: totalImages,
		GroupStats:      groupStats,
	}, nil
}
