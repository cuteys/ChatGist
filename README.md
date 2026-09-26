# ChatGist 💬⚡

<p align="center">
  <img src="assets/logo.png" width="180" alt="ChatGist Logo" />
</p>

<p align="center">
  <strong>基于 Cloudflare Workers + D1 的 Telegram 群聊智能总结与检索机器人</strong>
</p>

<p align="center">
  <a href="https://github.com/cuteys/ChatGist/stargazers"><img src="https://img.shields.io/github/stars/cuteys/ChatGist?style=flat-square" alt="stars" /></a>
  <a href="https://github.com/cuteys/ChatGist/blob/main/LICENSE"><img src="https://img.shields.io/github/license/cuteys/ChatGist?style=flat-square" alt="license" /></a>
  <a href="https://workers.cloudflare.com/"><img src="https://img.shields.io/badge/Platform-Cloudflare%20Workers-orange?style=flat-square" alt="Cloudflare Workers" /></a>
</p>

---

看到群组里 **999+** 甚至 **2000+** 的未读消息感到焦虑？让 **ChatGist** 帮你在几秒钟内提炼群聊要点！

采用 Serverless 架构，完全运行在 Cloudflare 边缘网络上，拥有极低的运行成本（通常在 Cloudflare 免费套餐额度内即可运行）。

---

## ✨ 核心特性

- 📝 **群聊智能总结**：支持按指定消息条数或时间跨度快速生成群聊重点摘要，并附带原消息溯源链接。
- ⏰ **定时每日总结**：内置 Cron 定时器（默认北京时间每日凌晨），分批次自动向群组推送昨日总结。
- 💡 **群聊智能问答**：基于群聊近期聊天记录回答你的问题，答案私聊推送，不打扰群组其他成员。
- 🔍 **关键词全文搜索**：支持在群聊历史记录中检索关键词（完美支持中文与 CJK 字符）。
- 🖼️ **支持图文多模态**：支持存储群内 JPEG 图片，并在总结和问答中结合图片内容综合分析。
- ⚙️ **灵活的 AI 接口配置**：支持自定义 `AI_BASE_URL` 和 `AI_MODEL`，无缝对接 OpenAI、Gemini、DeepSeek、Claude 等兼容接口。

---

## 📋 指令列表 (Commands)

| 指令 | 格式 | 说明 |
| :--- | :--- | :--- |
| **`/summary`** | `/summary 10` 或 `/summary 10h` | 概括最新 10 条消息，或最近 10 小时内的消息 |
| **`/ask`** | `/ask <你的问题>` | 基于群聊近期记录提问，答案将**私聊**发送给你 |
| **`/query`** | `/query <关键词>` | 在群聊历史记录中检索包含该关键词的消息 |
| **`/status`** | `/status` | 检查机器人当前的存活与运行状态 |
| **`/help`** | `/help` | 查看详细的中文功能指南与示例 |
| **`/setcommands`** | `/setcommands` | 向 Telegram 官方自动同步中文指令弹出菜单 |

> **提示**：直接在浏览器访问 `https://<你的Worker域名>/setcommands` 亦可自动向 Telegram 注册上述中文菜单。

---

## 🛠️ 环境变量与密钥配置

| 变量名 | 类型 | 必需 | 说明 |
| :--- | :--- | :---: | :--- |
| **`TELEGRAM_BOT_TOKEN`** | Secret | 是 | Telegram Bot Token（由 [@BotFather](https://t.me/BotFather) 获取） |
| **`AI_API_KEY`** | Secret | 是 | AI 接口的 API Key（兼容 OpenAI 规范） |
| **`AI_MODEL`** | 变量 (var) | 是 | 模型名称（如 `gpt-4o-mini`、`deepseek-chat` 等） |
| **`AI_BASE_URL`** | 变量 (var) | 否 | AI 接口地址（如使用中转或第三方提供商需填，留空默认 OpenAI 官方地址） |
| **`DB`** | D1 绑定 | 是 | Cloudflare D1 数据库资源绑定（变量名固定为 `DB`） |

---

## 🚀 部署指南

### 前置准备

1. **创建 Telegram Bot**：
   - 与 [@BotFather](https://t.me/BotFather) 对话，使用 `/newbot` 创建机器人。
   - **关键设置**：发送 `/setprivacy` -> 选择你的 Bot -> 设为 **Disable**（必须关闭隐私模式，Bot 才能在群内接收普通聊天消息进行记录）。
2. **准备 Cloudflare 账号**：拥有一个 Cloudflare 账号（免费版即可）。

### 方式一：通过本地命令行部署（推荐）

1. **克隆项目并安装依赖**：
   ```bash
   git clone https://github.com/cuteys/ChatGist.git
   cd ChatGist
   npm install
   ```

2. **登录 Cloudflare**：
   ```bash
   npx wrangler login
   ```

3. **创建 D1 数据库并初始化**：
   ```bash
   # 创建数据库
   npx wrangler d1 create chat-msg-d1
   
   # 执行建表语句
   npx wrangler d1 execute chat-msg-d1 --remote --file=./schema.sql
   ```
   *将终端输出的 `database_id` 填入 `wrangler.toml` 的 `database_id` 中（如在控制台绑定则可注释）。*

4. **配置机密密钥 (Secrets)**：
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put AI_API_KEY
   ```

5. **部署到 Cloudflare**：
   ```bash
   npm run deploy
   ```

6. **绑定 Telegram Webhook**：
   在浏览器或终端打开以下链接：
   ```text
   https://api.telegram.org/bot<你的TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<你的Worker域名>.workers.dev
   ```

---

### 方式二：通过 Cloudflare 网页控制台部署

1. **创建 D1 数据库**：
   - 进入 **存储与数据库 (Storage & Databases)** -> **D1 SQL 数据库** -> **创建数据库**（名称：`chat-msg-d1`）。
   - 进入该数据库的 **控制台 (Console)**，粘贴 [schema.sql](./schema.sql) 内容并点击 **执行 (Execute)** 建表。
2. **连接 GitHub 构建**：
   - 进入 **Workers 和 Pages** -> **创建** -> **连接到 Git**，选择本仓库。
   - **构建命令**：留空。
   - **部署命令**：`npx wrangler deploy`。
3. **添加配置**：
   - **绑定 (Bindings)**：添加 D1 数据库绑定，变量名称填 **`DB`**，选择刚才创建的数据库。
   - **变量与机密 (Variables and Secrets)**：添加机密 `TELEGRAM_BOT_TOKEN` 和 `AI_API_KEY`，以及变量 `AI_MODEL`（和可选的 `AI_BASE_URL`）。
4. **绑定 Webhook**：与上述相同。

---

## ⚠️ 使用限制与注意事项

1. **仅能总结加入后的消息**：Telegram 官方机制限制，Bot 无法获取其加入群组之前的历史消息。
2. **无法读取其他 Bot 的发言**：为防止机器人在群内互刷死循环，Telegram 官方限制 Bot 之间无法互相看到发言。
3. **保留策略**：为控制数据库容量，定时任务会自动保留各群最新的 3000~4000 条文本消息，过期的图片数据将在 1~2 天后自动清理。

---

## 📄 开源协议

本项目基于 [GPL-3.0](./LICENSE) 协议开源。
