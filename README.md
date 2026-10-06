# ChatGist 💬⚡

<p align="center">
  <img src="assets/logo.png" width="180" alt="ChatGist Logo" />
</p>

<p align="center">
  <strong>基于 Go + Docker + SQLite 的高性能 Telegram 群聊智能总结与检索机器人</strong>
</p>

<p align="center">
  <a href="https://github.com/cuteys/ChatGist/stargazers"><img src="https://img.shields.io/github/stars/cuteys/ChatGist?style=flat-square" alt="stars" /></a>
  <a href="https://github.com/cuteys/ChatGist/blob/docker/LICENSE"><img src="https://img.shields.io/github/license/cuteys/ChatGist?style=flat-square" alt="license" /></a>
  <a href="https://hub.docker.com/r/cuteys/chatgist"><img src="https://img.shields.io/badge/Docker%20Hub-cuteys%2Fchatgist-blue?style=flat-square&logo=docker" alt="Docker Hub" /></a>
</p>

---

看到群组里 **999+** 甚至 **2000+** 的未读消息感到焦虑？让 **ChatGist** 帮你在几秒钟内提炼群聊要点！

本分支为 **Docker 独立容器版本**，采用纯 Go 语言编写（单二进制文件、无 CGO 依赖），内存占用极低（约 15MB），彻底突破了 Serverless 边缘运行时的 60s 硬超时限制（支持最长 300s 长思考与流式打字心跳），专为服务器与私有化部署打造。

---

## ✨ 核心特性

- 📝 **群聊智能总结**：支持按指定消息条数（如 `/summary 100`）或时间范围（如 `/summary 12h`）提炼群聊要点，支持原消息点击直达。
- ⚡ **突破 60s 超时**：针对长群聊总结设计，支持长达 300 秒的思考等待，并在等待期间每 4 秒向 Telegram 保持发送 `typing` 打字心跳，杜绝客户端断联焦虑。
- ⏰ **定时每日总结**：内置 Cron 定时器（默认北京时间每日 00:00），自动为白名单群组推送昨日群聊精炼总结。
- 💡 **群聊智能问答**：基于群近期记录回答群友提问，支持直接引用群友发言追问。
- 🔍 **关键词全文搜索**：支持在群历史记录中极速检索关键词（支持中文与多字词检索，附带分页直达按钮）。
- 🛡️ **白名单安全机制**：严格采用白名单授权机制，非白名单群组**不记录消息、不响应任何常规指令**，保护群隐私。
- 👑 **多级权限管理**：系统超级管理员可通过私聊指令动态添加/移除群组白名单与数据库管理员。
- 🖼️ **图文多模态分析**：自动解析群内图片（Base64 编码，支持 Vision 模型），在总结和问答中综合理解图片内容。
- 🔗 **OpenGraph 链接解析**：内置 SSRF 私网安全防护，自动抓取群内分享链接的网页标题与摘要。
- 💾 **嵌入式 SQLite 持久化**：数据落盘于本地 `./data/sqlite.db`，开箱即用，无需额外搭建外部数据库服务。

---

## 📋 指令列表 (Commands)

### 👥 常规群聊指令
| 指令 | 格式示例 | 说明 |
| :--- | :--- | :--- |
| `/summary` | `/summary 50` 或 `/summary 12h` | 总结群聊消息（普通用户单日限 5 次） |
| `/ask` | `/ask 今天大家主要聊了什么？` | 基于近期记录智能问答（普通用户单日限 5 次） |
| `/query` | `/query 教程` | 检索群聊历史关键词，支持翻页 |

### 💬 私聊指令
| 指令 | 说明 |
| :--- | :--- |
| `/status` | 检查机器人运行状态、今日指令配额及存储使用情况 |
| `/help` | 查看详细的功能指南与指令帮助 |

### 👑 超级管理员专属指令（私聊）
> ⚠️ **权限说明**：仅通过 `ADMIN_USER_IDS` 配置的系统超级管理员有权使用以下指令。

| 指令 | 说明 |
| :--- | :--- |
| `/addgroup [群ID] [备注]` | 授权群组加入白名单 |
| `/delgroup [群ID]` | 将群组移出白名单 |
| `/whitelist` 或 `/groups` | 查看所有已授权的白名单群组 |
| `/addadmin [用户ID] [备注]` | 添加数据库管理员（享有无限制配额特权） |
| `/deladmin [用户ID]` | 移除数据库管理员 |
| `/admins` | 查看管理员列表 |
| `/clearmessages [群ID]` | 清空指定群组的历史消息记录 |
| `/setcommands` | 向 Telegram 官方同步注册分域指令菜单 |

---

## 🚀 部署指南 (Docker Compose)

### 1. 准备目录与 compose 文件
在服务器创建项目目录，并保存以下 `docker-compose.yml`：

```yaml
services:
    chatgist:
        image: cuteys/chatgist:latest
        container_name: chatgist
        hostname: chatgist
        environment:
            - TZ=Asia/Shanghai
            - TELEGRAM_BOT_TOKEN=你的BotToken
            - AI_API_KEY=你的AIKey
            - AI_MODEL=gpt-4o-mini
            - AI_BASE_URL=
            - ADMIN_USER_IDS=你的Telegram数字ID
            - DB_PATH=/app/data/sqlite.db
            - MODE=polling
            - LIMIT_SUMMARY=5
            - LIMIT_ASK=5
            - LIMIT_QUERY=20
            - LIMIT_GROUP_MESSAGES=3000
            - LIMIT_GROUP_IMAGES=100
            - REASONING_EFFORT=medium
            - CRON_ENABLED=true
            - CRON_HOUR_BEIJING=0
        network_mode: bridge
        restart: always
        user: "0:0"
        volumes:
            - ./data:/app/data
```

### 2. 启动服务
```bash
# 启动容器
docker compose up -d

# 查看运行日志
docker compose logs -f
```

---

## 🛠️ 环境变量说明

| 环境变量 | 必填 | 默认值 | 说明 |
| :--- | :---: | :---: | :--- |
| `TELEGRAM_BOT_TOKEN` | 是 | - | Telegram Bot Token（由 [@BotFather](https://t.me/BotFather) 获取） |
| `AI_API_KEY` | 是 | - | OpenAI 兼容接口的 API Key |
| `AI_MODEL` | 否 | `gpt-4o-mini` | AI 模型名称（如 `gpt-4o-mini`, `gemini-2.5-flash`, `deepseek-chat` 等） |
| `AI_BASE_URL` | 否 | 官方 OpenAI 地址 | 自定义 AI 接口代理地址（例如中转服务） |
| `ADMIN_USER_IDS` | 推荐 | - | 超级管理员 Telegram 数字 ID（逗号分隔，如 `12345678,87654321`） |
| `MODE` | 否 | `polling` | 运行模式：`polling`（长轮询，推荐，无需公网IP和域名）或 `webhook` |
| `DB_PATH` | 否 | `/app/data/sqlite.db`| SQLite 数据库容器内路径 |
| `REASONING_EFFORT` | 否 | `medium` | 深度思考模型推理强度（`high`, `medium`, `low`, `none`） |
| `LIMIT_SUMMARY` | 否 | `5` | 普通用户每日 `/summary` 次数上限 |
| `LIMIT_ASK` | 否 | `5` | 普通用户每日 `/ask` 次数上限 |
| `LIMIT_QUERY` | 否 | `20` | 普通用户每日 `/query` 次数上限 |
| `LIMIT_GROUP_MESSAGES`| 否 | `3000` | 单个群组保留历史消息条数上限 |
| `LIMIT_GROUP_IMAGES` | 否 | `100` | 单个群组保留历史图片张数上限 |
| `CRON_ENABLED` | 否 | `true` | 是否启用每日定时群聊总结 |
| `CRON_HOUR_BEIJING` | 否 | `0` | 每日定时总结发送时间（北京时间整点，0 代表每日 00:00） |

---

## ⚠️ Telegram 机器人前置配置注意事项

1. **关闭隐私模式（重要）**：
   - 与 [@BotFather](https://t.me/BotFather) 对话，发送 `/setprivacy` -> 选择你的 Bot -> 设为 **Disable**。
   - 只有关闭隐私模式（或将机器人设为群管理员），机器人才能在群内接收普通聊天消息进行记录和总结。
2. **消息时间跨度**：
   - Telegram 官方机制限制，机器人仅能总结其加入群组并运行之后产生的消息，无法获取加入之前的历史记录。

---

## 📄 开源协议

本项目基于 [GPL-3.0](./LICENSE) 协议开源。
