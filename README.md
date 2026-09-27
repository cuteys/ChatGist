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
- ⏰ **定时每日总结**：内置 Cron 定时器（默认北京时间每日凌晨），分批次自动向白名单群组推送昨日总结。
- 💡 **群聊智能问答**：基于群聊近期聊天记录回答你的问题，直接在群内引用回复提问。
- 🔍 **关键词全文搜索**：支持在群聊历史记录中检索关键词（完美支持中文与 CJK 字符）。
- 🛡️ **群组白名单与鉴权**：严格采用白名单授权机制，非白名单群组完全**不记录消息、不响应任何常规指令**，保障隐私与防滥用。
- 👑 **多级管理员系统**：支持环境变量设置超级管理员，支持通过指令动态添加/查看/删除数据库管理员与白名单群组。
- 🖼️ **支持图文多模态**：支持接收群内 JPEG、PNG、WebP 图片，并在总结和问答中结合图片内容综合分析。
- ⚙️ **灵活的 AI 接口配置**：支持自定义 `AI_BASE_URL` 和 `AI_MODEL`，支持自定义 Prompt，无缝对接 OpenAI、Gemini、DeepSeek、Claude 等兼容接口。

---

## 📋 指令列表 (Commands)

### 常规群聊指令
| 指令 | 格式 | 说明 |
| :--- | :--- | :--- |
| **`/summary`** | `/summary 10` 或 `/summary 10h` | 概括群聊消息，每日限 5 次 |
| **`/ask`** | `/ask <你的问题>` | 基于群聊记录提问并回答，每日限 5 次 |
| **`/query`** | `/query <关键词>` | 在群聊历史记录中检索关键词，每日限 20 次 |
| **`/quota`** | `/quota` | 快速查看个人今日剩余指令配额与使用详情 |
| **`/status`** | `/status` | 检查机器人状态、当前群组授权状态及今日剩余指令配额 |
| **`/help`** | `/help` | 查看详细的功能指南与指令帮助 |

### 超级管理员专属指令（群内或私聊）
> ⚠️ **权限说明**：根据安全原则，**仅系统超级管理员**（通过 `ADMIN_USER_IDS` 配置）有权查看和管理群组白名单与管理员列表。普通管理员享有无限制调用特权，但无权调整系统权限。

| 指令 | 格式 | 说明 |
| :--- | :--- | :--- |
| **`/addgroup`** | `/addgroup` 或 `/addgroup <群ID> [名称]` | 授权群组 |
| **`/delgroup`** | `/delgroup` 或 `/delgroup <群ID>` | 移出白名单 |
| **`/whitelist`** | `/whitelist` 或 `/groups` | 查看所有已授权的白名单群组列表 |
| **`/addadmin`** | `/addadmin <用户ID> [备注]` | 添加新的数据库管理员 |
| **`/deladmin`** | `/deladmin <用户ID>` | 移除数据库管理员 |
| **`/admins`** | `/admins` | 查看所有超级管理员及数据库管理员列表 |
| **`/clearmessages`**| `/clearmessages` 或 `/clearmessages <群ID>` | 清空指定群组的历史消息记录 |
| **`/setcommands`** | `/setcommands` | 向 Telegram 官方同步注册中文快捷指令菜单 |

> **提示**：直接在浏览器访问 `https://<你的Worker域名>/setcommands` 亦可自动向 Telegram 注册上述指令菜单。

---

## 🛡️ 权限层级与用户配额系统

1. **三级权限架构**：
   - **👑 系统超级管理员**：通过环境变量 `ADMIN_USER_IDS` 配置。拥有最高权限，**仅超级管理员**可执行群组白名单增删查、管理员增删查及同步指令菜单；不受任何使用频次限制。
   - **🛡️ 数据库管理员**：由超级管理员通过 `/addadmin` 动态添加。享有**无限制使用** `/summary`、`/ask`、`/query` 的特权，但无权操作管理指令。
   - **👤 普通群组成员**：仅可在已授权的白名单群组内使用常规指令，且受每日调用频次配额保护。

2. **用户每日配额（防刷与成本控制）**：
   - **`/summary`**：默认每人每日 **5 次**（AI 消耗最大）
   - **`/ask`**：默认每人每日 **5 次**
   - **`/query`**：默认每人每日 **20 次**
   - 每日配额于北京时间次日 `00:00` 自动刷新，发送 `/status` 可随时查看今日已用与剩余配额。

---

## 🛠️ 环境变量与密钥配置

| 变量名 | 类型 | 必需 | 说明 |
| :--- | :--- | :---: | :--- |
| **`TELEGRAM_BOT_TOKEN`** | Secret | 是 | Telegram Bot Token（由 [@BotFather](https://t.me/BotFather) 获取） |
| **`SECRET_TELEGRAM_API_TOKEN`** | Secret | 否 | Webhook Secret Token，用于严格防伪造安全校验 |
| **`AI_API_KEY`** | Secret | 是 | AI 接口的 API Key（兼容 OpenAI 规范） |
| **`AI_MODEL`** | 变量 (var) | 是 | 模型名称（如 `gpt-4o-mini`、`deepseek-chat` 等） |
| **`ADMIN_USER_IDS`** | 变量 (var) | 推荐 | 超级管理员 Telegram 用户 ID 列表，英文逗号分隔（如 `12345678`） |
| **`SYSTEM_PROMPT_SUMMARY`** | 变量 (var) | 否 | 自定义群聊总结 System Prompt，留空使用内置专业总结提示词 |
| **`SYSTEM_PROMPT_ASK`** | 变量 (var) | 否 | 自定义群聊智能问答 System Prompt，留空使用内置问答提示词 |
| **`LIMIT_SUMMARY`** | 变量 (var) | 否 | 普通用户单日 `/summary` 上限（默认 `5`） |
| **`LIMIT_ASK`** | 变量 (var) | 否 | 普通用户单日 `/ask` 上限（默认 `5`） |
| **`LIMIT_QUERY`** | 变量 (var) | 否 | 普通用户单日 `/query` 上限（默认 `20`） |
| **`LIMIT_GROUP_MESSAGES`** | 变量 (var) | 否 | 单个群组保留文本消息上限（默认 `3000`） |
| **`LIMIT_GROUP_IMAGES`** | 变量 (var) | 否 | 单个群组保留图片上限（默认 `100`） |
| **`USER_DAILY_LIMIT`** | 变量 (var) | 否 | 全局指令单日上限兜底（留空则遵循上述各自上限） |
| **`AI_BASE_URL`** | 变量 (var) | 否 | AI 接口地址（如使用中转或第三方提供商需填，留空默认 OpenAI 官方地址） |
| **`DB`** | D1 绑定 | 是 | Cloudflare D1 数据库资源绑定（变量名固定为 `DB`） |

---

## 🚀 部署指南

### 前置准备

1. **创建 Telegram Bot**：
   - 与 [@BotFather](https://t.me/BotFather) 对话，使用 `/newbot` 创建机器人。
   - **关键设置**：发送 `/setprivacy` -> 选择你的 Bot -> 设为 **Disable**（关闭隐私模式，Bot 才能在群内接收普通聊天消息进行记录；若需读取群内其他 Bot 发言，亦依赖此设置或将 Bot 设为群管理员）。
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
2. **读取其他 Bot 的发言**：受 Telegram 默认隐私策略限制，Bot 默认可能无法接收其他 Bot 的普通消息。若需让机器人记录并总结群内其他 Bot 的消息，只需在 [@BotFather](https://t.me/BotFather) 中将该 Bot 的隐私模式设为 **Disable**（发送 `/setprivacy`），或将机器人设为群组管理员即可。
3. **数据保留与容量保护策略**：
   - **日常维护**：每日定时任务为每个群组保留最新的 **3000 条** 历史消息；图片按数量保留各群最新的 **100 张**（支持 JPEG/PNG/WebP，单张 ≤ 950KB）。
   - **高水位熔断**：为保障 Cloudflare D1 免费额度（500 MB），系统内置实时存储监控。当数据库占用达到 **400 MB (80%)** 时，自动触发紧急清理（图片缩减至最新 20 张、消息缩减至最新 500 条），并自动向系统超级管理员推送告警通知。

---

## 📄 开源协议

本项目基于 [GPL-3.0](./LICENSE) 协议开源。
