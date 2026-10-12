package test

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cuteys/ChatGist/internal/ai"
	"github.com/cuteys/ChatGist/internal/bot"
	"github.com/cuteys/ChatGist/internal/config"
	"github.com/cuteys/ChatGist/internal/format"
	"github.com/cuteys/ChatGist/internal/quota"
	"github.com/cuteys/ChatGist/internal/storage"
	"github.com/cuteys/ChatGist/internal/telegram"
	"github.com/cuteys/ChatGist/internal/whitelist"
)

func TestStorageAndWhitelistAndQuota(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "chatgist-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	dbPath := filepath.Join(tmpDir, "sqlite.db")
	store, err := storage.New(dbPath)
	if err != nil {
		t.Fatalf("Failed to init storage: %v", err)
	}
	defer store.Close()

	cfg := &config.Config{
		AdminUserIDs: []string{"10001"},
		LimitSummary: 5,
		LimitAsk:     5,
		LimitQuery:   20,
	}

	wl := whitelist.New(cfg, store)
	q := quota.New(cfg, store, wl)

	// 1. 群组白名单授权测试
	if wl.IsGroupWhitelisted("-100999") {
		t.Errorf("Group -100999 should not be whitelisted initially")
	}

	if err := wl.AddGroup("-100999", "TestGroup", "10001"); err != nil {
		t.Fatalf("AddGroup failed: %v", err)
	}

	if !wl.IsGroupWhitelisted("-100999") {
		t.Errorf("Group -100999 should now be whitelisted")
	}

	// 2. 超级管理员与数据库管理员权限测试
	if !wl.IsSuperAdmin("10001") {
		t.Errorf("User 10001 should be super admin")
	}
	if wl.IsAdmin("20002") {
		t.Errorf("User 20002 should not be admin initially")
	}

	if err := wl.AddAdmin("20002", "SubAdmin", "10001"); err != nil {
		t.Fatalf("AddAdmin failed: %v", err)
	}
	if !wl.IsAdmin("20002") {
		t.Errorf("User 20002 should now be admin")
	}

	// 3. 用户与特权配额测试
	allowed, curr, limit, priv := q.CheckAndIncrementQuota("10001", "summary")
	if !allowed || !priv {
		t.Errorf("Super admin should have unlimited quota")
	}

	for i := 1; i <= 5; i++ {
		allowed, curr, limit, _ = q.CheckAndIncrementQuota("30003", "summary")
		if !allowed || curr != i {
			t.Errorf("Attempt %d should be allowed, curr=%d", i, curr)
		}
	}
	// 超出5次限制应当被拒绝
	allowed, curr, limit, _ = q.CheckAndIncrementQuota("30003", "summary")
	if allowed {
		t.Errorf("6th attempt should be rejected, limit=%d, curr=%d", limit, curr)
	}

	// 4. 消息入库与关键词分页检索测试
	now := time.Now().UnixMilli()
	msg1 := &storage.Message{
		ID:          "-100999_1",
		GroupID:     "-100999",
		TimeStamp:   now,
		UserName:    "Alice",
		Content:     "Hello world this is a test message",
		MessageID:   1,
		GroupName:   "TestGroup",
		MessageTime: "2026-10-07 10:00:00",
	}
	if err := store.SaveMessage(msg1); err != nil {
		t.Fatalf("SaveMessage failed: %v", err)
	}

	res, count, err := store.QueryMessages("-100999", "test", 10, 0)
	if err != nil || count != 1 || len(res) != 1 {
		t.Errorf("QueryMessages failed: count=%d, len=%d, err=%v", count, len(res), err)
	}

	// 5. Telegram UpdateID 去重机制测试
	if store.IsDuplicateUpdate(12345) {
		t.Errorf("Update 12345 should not be duplicate initially")
	}
	if !store.IsDuplicateUpdate(12345) {
		t.Errorf("Update 12345 should be duplicate on second check")
	}

	// 6. 消息编辑覆盖入库与指令编辑拦截测试
	b := bot.New(cfg, store, wl, q, nil, nil)
	b.ProcessUpdate(&telegram.Update{
		UpdateID: 20001,
		EditedMessage: &telegram.Message{
			MessageID: 1,
			Date:      now / 1000,
			Chat:      &telegram.Chat{ID: -100999, Type: "supergroup", Title: "TestGroup"},
			From:      &telegram.User{ID: 30003, FirstName: "Alice"},
			Text:      "Edited message content without old keyword",
		},
	})

	_, oldCount, err := store.QueryMessages("-100999", "test", 10, 0)
	if err != nil || oldCount != 0 {
		t.Errorf("Expected old keyword count=0 after edit, got %d (err=%v)", oldCount, err)
	}
	editedRes, newCount, err := store.QueryMessages("-100999", "Edited", 10, 0)
	if err != nil || newCount != 1 || len(editedRes) != 1 {
		t.Errorf("Expected new keyword count=1 after edit, got %d (err=%v)", newCount, err)
	}

	// 编辑为 / 指令时应直接忽略，不覆盖原记录且不触发命令
	b.ProcessUpdate(&telegram.Update{
		UpdateID: 20002,
		EditedMessage: &telegram.Message{
			MessageID: 1,
			Date:      now / 1000,
			Chat:      &telegram.Chat{ID: -100999, Type: "supergroup", Title: "TestGroup"},
			From:      &telegram.User{ID: 30003, FirstName: "Alice"},
			Text:      "/summary 50",
		},
	})
	_, stillCount, err := store.QueryMessages("-100999", "Edited", 10, 0)
	if err != nil || stillCount != 1 {
		t.Errorf("Slash command edit should be ignored, expected count=1, got %d (err=%v)", stillCount, err)
	}

	// 7. 锚点前后窗口查询测试（GetMessagesAround）
	for i := 2; i <= 10; i++ {
		_ = store.SaveMessage(&storage.Message{
			ID:          fmt.Sprintf("-100999_%d", i),
			GroupID:     "-100999",
			TimeStamp:   now + int64(i*1000),
			UserName:    "Bob",
			Content:     "Msg",
			MessageID:   int64(i),
			GroupName:   "TestGroup",
			MessageTime: "2026-10-07 10:00:00",
		})
	}
	around, err := store.GetMessagesAround("-100999", 5, 0, 2, 3)
	if err != nil || len(around) != 6 {
		t.Fatalf("Expected 6 messages (2 before + target #5 + 3 after), got %d (err=%v)", len(around), err)
	}
	if around[0].MessageID != 3 || around[2].MessageID != 5 || around[5].MessageID != 8 {
		t.Errorf("Unexpected around window IDs: first=%d, target=%d, last=%d", around[0].MessageID, around[2].MessageID, around[5].MessageID)
	}
}

func TestFormatAndParsing(t *testing.T) {
	md := `# 讨论摘要
> 核心观点：大家讨论了技术架构

- [x] 任务完成
- [ ] 待办跟进

详细请看 [引用](https://t.me/c/123/456)`

	blocks := format.AggregateMarkdownToRichBlocks(md)
	if len(blocks) < 3 {
		t.Errorf("Expected at least 3 blocks, got %d", len(blocks))
	}

	html := format.RichBlocksToHTML(blocks)
	if html == "" {
		t.Errorf("RichBlocksToHTML returned empty string")
	}

	superscript := telegram.ToSuperscript(12)
	if superscript != "¹²" {
		t.Errorf("Expected ¹², got %s", superscript)
	}

	// 抽屉与表格富文本解析测试
	detailsMd := `<details>
<summary>议题一：架构方案</summary>

| 模块 | 职责 |
| :--- | :--- |
| Bot | 调度与路由 |
| AI | 大模型推理 |

- [x] 协程生命周期已修复
</details>`
	detailBlocks := format.AggregateMarkdownToRichBlocks(detailsMd)
	if len(detailBlocks) == 0 || detailBlocks[0].Type != format.BlockDetails {
		t.Errorf("Expected BlockDetails, got %v", detailBlocks)
	}
	detailHtml := format.RichBlocksToHTML(detailBlocks)
	if detailHtml == "" {
		t.Errorf("Expected non-empty HTML for details")
	}

	// 分页键盘按键生成测试
	kb := telegram.GenerateQueryPaginationKeyboard("部署", 1, 3)
	if kb == nil || len(kb.InlineKeyboard) != 2 {
		t.Errorf("Expected 2 rows of pagination keyboard, got %v", kb)
	}

	// 相邻纯文本合并与负载诊断测试
	aiClient := ai.New(&config.Config{})
	sampleMsgs := []*storage.Message{
		{GroupID: "-100999", MessageID: 1, UserName: "Alice", Content: "First text", TimeStamp: 1700000000000},
		{GroupID: "-100999", MessageID: 2, UserName: "Bob", Content: "Second text", TimeStamp: 1700000005000},
		{GroupID: "-100999", MessageID: 3, UserName: "Carol", Content: "Photo caption\ndata:image/jpeg;base64,AAAA", TimeStamp: 1700000010000},
	}
	parts := aiClient.BuildChatHistoryParts(sampleMsgs)
	// 前两条纯文本 + 第三条图片前的文字说明应合并为 1 个 text 节点，随后 1 个 image_url 节点，最后 1 个链接 text 节点，共 3 个节点
	if len(parts) != 3 {
		t.Errorf("Expected 3 compacted parts (text, image_url, text), got %d", len(parts))
	}
	diag := ai.CalcDiagnostics(sampleMsgs)
	if diag.MessageCount != 3 || diag.ImageCount != 1 {
		t.Errorf("Unexpected diagnostics: %+v", diag)
	}
}
