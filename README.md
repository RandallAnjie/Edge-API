# Edge API

QuantumNous [new-api](https://github.com/QuantumNous/new-api) 的 **RandallFlare** 完整移植：在 Cloudflare Workers 兼容运行时（workerd）上提供同一套 OpenAI / Claude / Gemini 网关、后台控制台、额度与渠道调度。

本仓库按 AGPLv3 发布，并保留上游 NOTICE 中的署名要求：

> Frontend design and development by New API contributors.
>
> https://github.com/QuantumNous/new-api

## 完整能力

相对「只做 chat 转发」的最小网关，这里按 new-api 控制台与中继面做了完整落地：

**控制台 / 管理 API（`/api/*`）**

- 首次安装 `/api/setup`、站点状态 `/api/status`
- 登录 / 注册 / 刷新 / 退出（HMAC session + Cookie + Bearer）
- 用户：自身资料、改密、签到、兑换码充值、GitHub OAuth（可配置）
- 管理员：用户 CRUD、启用/禁用/升降级/加额度
- 渠道：创建、编辑、删除、批量状态、复制、测试、拉取上游模型、多 Key、模型映射、Header Override
- 令牌：额度、无限额度、过期、IP 白名单、模型限制
- 日志、统计、按日消耗、审计日志
- 兑换码、分组、系统 options、定价、公告
- Playground：`POST /pg/chat/completions`
- Midjourney 任务列表；`/mj/*` 转发到 MJ 渠道
- OpenAI 账单兼容：`/v1/dashboard/billing/subscription|usage`

**中继（TokenAuth，`Authorization: Bearer sk-...`）**

- `POST /v1/chat/completions`（含 SSE）
- `POST /v1/completions` `/v1/embeddings` `/v1/messages`
- `POST /v1/images/generations` `/v1/moderations` `/v1/audio/*` `/v1/rerank` `/v1/responses`
- Gemini 原生 `POST /v1beta/models/{model}:generateContent`
- `GET /v1/models`、`GET /v1/models/:model`
- 渠道优先级 + 权重随机 + 失败重试
- OpenAI ↔ Anthropic / Gemini 协议转换
- Azure / OpenAI 兼容 / Anthropic / Gemini / Ollama / Cloudflare / 阿里兼容模式 / 智谱 / 火山 / 自定义 URL
- 额度：ModelRatio × CompletionRatio × GroupRatio；用户额度 + 令牌额度双扣

**后台 UI**

单页控制台覆盖：首页、定价、关于、初始化、登录注册、仪表盘、Playground、令牌、日志、钱包、个人设置、渠道、模型、用户、兑换码、审计、MJ、系统设置。页脚保留上游署名与仓库链接。

## 部署到 RandallFlare

使用 `@bigrandall/rrangler`（当前 0.4.8），不要用 Cloudflare `wrangler`。

```bash
npm install
npm run build
npx rrangler login --token rft_xxx          # 或 export RRANGLER_TOKEN=...
npx rrangler deploy --name edge-api
```

`rrangler.json` 会在首次 deploy 创建 worker slug `edge-api`，并创建/绑定：

- D1 `edge-api` → `env.DB`
- KV `edge-api-kv` → `env.KV`
- `public/` 静态资源 → `env.ASSETS`

公开域名形如 `https://edge-api-<username>.edge.bigrandall.io/`（以 `rrangler worker get edge-api` 为准）。

可选：

```bash
npx rrangler secret put SESSION_SECRET --worker edge-api
npx rrangler d1 migrations apply edge-api
```

Worker 会在首次请求 `ensureSchema`，即使未手动 apply migrations 也能建表。

## 本地

```bash
npm install
npm test
npm run typecheck
npm run dev          # rrangler dev --port 8787，需本机 workerd
```

`npm test` 用 Node 内置 SQLite 模拟 D1，覆盖初始化、登录、渠道、令牌、中继、兑换码。

`rrangler` 0.4.8 的 `dev` **不会**注入 D1/KV 绑定（生产 `deploy` 会创建并绑定）。没有 D1 时 Worker 仍提供静态控制台与 `/health`；`/api/*` 与 `/v1/*` 需要部署后的 `env.DB`。

公开部署后打开 Worker URL，走一次「初始化」创建 root 账号。

## 架构

| 上游 new-api | Edge API |
| --- | --- |
| Go + Gin + GORM | TypeScript Worker（esbuild 单文件） |
| MySQL / PG / SQLite | D1 |
| Redis / 内存限流 | KV 令牌 RPM |
| 嵌入 React 前端 | `public/` SPA（ASSETS，base64 打进 Worker） |
| Argon2id / bcrypt | Web Crypto PBKDF2-SHA256（旧库密码不可直接迁移） |

## 渠道类型说明

控制台类型目录与 new-api `constant/channel.go` 对齐（含 OpenAI、Azure、Anthropic、Gemini、OpenRouter、DeepSeek、硅基流动、xAI 等）。  
需要厂商 SDK 签名的渠道（部分 AWS/Vertex 服务账号）在未提供 HTTP 兼容 Key 时会返回结构化错误；配置了兼容 Base URL 的仍按 HTTP 中继。

任务插件、邮件 SMTP、Stripe/Epay 等支付收银台不在 workerd 内运行；对应路由不会静默吞掉，而是返回明确失败/未启用。

## 配置项（系统设置）

常用 options：`SystemName`、`QuotaPerUnit`（默认 500000 ≈ $1）、`RegisterEnabled`、`CheckinEnabled`、`CheckinQuota`、`RetryTimes`、`ModelRatio`、`GroupRatio`、`GitHubOAuthEnabled` / `GitHubClientId` / `GitHubClientSecret`（Secret 不在 GET /api/option 回显）。

## License

GNU Affero General Public License v3.0。见 `LICENSE` 与 `NOTICE`。
