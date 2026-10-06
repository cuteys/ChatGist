package bot

import (
	"fmt"
	"html"
	"strconv"
	"strings"

	"github.com/cuteys/ChatGist/internal/telegram"
)

func (b *Bot) handleAdminCommands(msg *telegram.Message, cmd string) {
	userID := ""
	if msg.From != nil {
		userID = strconv.FormatInt(msg.From.ID, 10)
	}

	if !b.whitelist.IsSuperAdmin(userID) {
		return
	}

	parts := strings.Fields(msg.Text)
	targetChatID := msg.Chat.ID

	switch cmd {
	case "addgroup":
		targetGroupID := ""
		groupName := ""
		if len(parts) > 1 {
			targetGroupID = parts[1]
			if len(parts) > 2 {
				groupName = strings.Join(parts[2:], " ")
			}
		} else if isGroupChat(msg.Chat) {
			targetGroupID = strconv.FormatInt(msg.Chat.ID, 10)
			groupName = msg.Chat.Title
		}

		if targetGroupID == "" {
			_, _ = b.tg.SendMessage(targetChatID, "⚠️ 请指定群组 ID，例如：<code>/addgroup -100123456789 测试群</code>", "HTML", msg.MessageID, nil)
			return
		}

		err := b.whitelist.AddGroup(targetGroupID, groupName, userID)
		if err != nil {
			_, _ = b.tg.SendMessage(targetChatID, fmt.Sprintf("❌ 授权失败: %v", err), "", msg.MessageID, nil)
			return
		}
		_, _ = b.tg.SendMessage(targetChatID, fmt.Sprintf("✅ 已成功将群组 <code>%s</code> 加入白名单！", html.EscapeString(targetGroupID)), "HTML", msg.MessageID, nil)

	case "delgroup":
		if len(parts) < 2 {
			_, _ = b.tg.SendMessage(targetChatID, "⚠️ 请指定要移除的群组 ID，例如：<code>/delgroup -100123456789</code>", "HTML", msg.MessageID, nil)
			return
		}
		targetGroupID := parts[1]
		err := b.whitelist.RemoveGroup(targetGroupID)
		if err != nil {
			_, _ = b.tg.SendMessage(targetChatID, fmt.Sprintf("❌ 移除失败: %v", err), "", msg.MessageID, nil)
			return
		}
		_, _ = b.tg.SendMessage(targetChatID, fmt.Sprintf("✅ 已成功将群组 <code>%s</code> 移出白名单！", html.EscapeString(targetGroupID)), "HTML", msg.MessageID, nil)

	case "whitelist", "groups":
		groups, err := b.whitelist.GetWhitelistedGroups()
		if err != nil || len(groups) == 0 {
			_, _ = b.tg.SendMessage(targetChatID, "📋 当前暂无已授权的白名单群组。", "", msg.MessageID, nil)
			return
		}
		var sb strings.Builder
		sb.WriteString("🛡️ <b>已授权白名单群组列表：</b>\n\n")
		for i, g := range groups {
			sb.WriteString(fmt.Sprintf("%d. 「<b>%s</b>」 (ID: <code>%s</code>)\n", i+1, html.EscapeString(g.GroupName), g.GroupID))
		}
		_, _ = b.tg.SendMessage(targetChatID, sb.String(), "HTML", msg.MessageID, nil)

	case "addadmin":
		if len(parts) < 2 {
			_, _ = b.tg.SendMessage(targetChatID, "⚠️ 请提供用户 ID，例如：<code>/addadmin 123456789 某用户</code>", "HTML", msg.MessageID, nil)
			return
		}
		targetUserID := parts[1]
		note := "管理员"
		if len(parts) > 2 {
			note = strings.Join(parts[2:], " ")
		}
		err := b.whitelist.AddAdmin(targetUserID, note, userID)
		if err != nil {
			_, _ = b.tg.SendMessage(targetChatID, fmt.Sprintf("❌ 添加管理员失败: %v", err), "", msg.MessageID, nil)
			return
		}
		_, _ = b.tg.SendMessage(targetChatID, fmt.Sprintf("✅ 已添加数据库管理员 <code>%s</code>（%s）！", targetUserID, html.EscapeString(note)), "HTML", msg.MessageID, nil)

	case "deladmin":
		if len(parts) < 2 {
			_, _ = b.tg.SendMessage(targetChatID, "⚠️ 请提供用户 ID，例如：<code>/deladmin 123456789</code>", "HTML", msg.MessageID, nil)
			return
		}
		targetUserID := parts[1]
		err := b.whitelist.RemoveAdmin(targetUserID)
		if err != nil {
			_, _ = b.tg.SendMessage(targetChatID, fmt.Sprintf("❌ 移除管理员失败: %v", err), "", msg.MessageID, nil)
			return
		}
		_, _ = b.tg.SendMessage(targetChatID, fmt.Sprintf("✅ 已成功移除管理员 <code>%s</code>！", targetUserID), "HTML", msg.MessageID, nil)

	case "admins":
		superAdmins := b.whitelist.GetSuperAdminIDs()
		dbAdmins, _ := b.whitelist.GetAdmins()

		var sb strings.Builder
		sb.WriteString("👑 <b>管理员列表：</b>\n\n")
		sb.WriteString("<b>系统超级管理员 (环境变量)：</b>\n")
		for _, sa := range superAdmins {
			sb.WriteString(fmt.Sprintf("• <code>%s</code>\n", sa))
		}

		sb.WriteString("\n<b>数据库管理员：</b>\n")
		if len(dbAdmins) == 0 {
			sb.WriteString("• 暂无动态数据库管理员\n")
		} else {
			for _, da := range dbAdmins {
				sb.WriteString(fmt.Sprintf("• <code>%s</code> (%s)\n", da.UserID, html.EscapeString(da.UserName)))
			}
		}
		_, _ = b.tg.SendMessage(targetChatID, sb.String(), "HTML", msg.MessageID, nil)

	case "clearmessages":
		targetGroupID := ""
		if len(parts) > 1 {
			targetGroupID = parts[1]
		} else if isGroupChat(msg.Chat) {
			targetGroupID = strconv.FormatInt(msg.Chat.ID, 10)
		}
		if targetGroupID == "" {
			_, _ = b.tg.SendMessage(targetChatID, "⚠️ 请指定要清空的群组 ID，例如：<code>/clearmessages -100123456789</code>", "HTML", msg.MessageID, nil)
			return
		}
		cleaned, err := b.storage.ClearGroupMessages(targetGroupID)
		if err != nil {
			_, _ = b.tg.SendMessage(targetChatID, fmt.Sprintf("❌ 清理失败: %v", err), "", msg.MessageID, nil)
			return
		}
		_, _ = b.tg.SendMessage(targetChatID, fmt.Sprintf("🧹 已成功清空群组 <code>%s</code> 的 %d 条历史消息！", targetGroupID, cleaned), "HTML", msg.MessageID, nil)

	case "setcommands":
		err := b.RegisterBotCommands()
		if err != nil {
			_, _ = b.tg.SendMessage(targetChatID, fmt.Sprintf("❌ 同步指令菜单失败: %v", err), "", msg.MessageID, nil)
			return
		}
		_, _ = b.tg.SendMessage(targetChatID, "✅ 已向 Telegram 成功同步分域指令菜单！", "", msg.MessageID, nil)
	}
}
