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
- 用户：自身资料、改密、签到、兑换码充值、邀请划转、删除账号、会话列表/注销
- 安全：TOTP 2FA、备份码、登录会话、管理访问令牌、Passkey（WebAuthn）
- OAuth：GitHub / Discord / LinuxDO / OIDC / 自定义提供商表
- 邮件：Resend HTTP（验证码、重置密码）；未配置时明确返回「邮件未配置」
- 管理员：用户 CRUD、启用/禁用/升降级/加额度、渠道测试全部/按标签/批量删除
- 渠道：创建、编辑、删除、批量状态、复制、测试、拉取上游模型、多 Key、模型映射、Header Override、余额探测
- 令牌：额度、无限额度、过期、IP 白名单、模型限制、搜索、批量删除、批量显示 Key
- 日志、统计、按日消耗、审计日志、排行榜、倍率公开（可选）
- 兑换码（搜索/批量/清理失效）、分组、系统 options、定价、公告、用户协议/隐私政策
- 订阅：套餐 CRUD、余额购买、管理员绑定、定时过期
- 对话会话（D1）、厂商/预填分组/模型元数据
- Playground：`POST /pg/chat/completions`
- Midjourney 任务列表；`/mj/*` 转发到 MJ 渠道
- 异步任务表：视频生成与 `/v1/tasks/:key`
- OpenAI 账单兼容：`/v1/dashboard/billing/subscription|usage`
- Token 只读：`/api/usage/token`、`/api/log/token`

**中继（TokenAuth，`Authorization: Bearer sk-...`）**

- `POST /v1/chat/completions`（含 SSE）
- `POST /v1/completions` `/v1/embeddings` `/v1/messages`
- `POST /v1/images/generations` `/v1/moderations` `/v1/audio/*` `/v1/rerank` `/v1/responses`
- `POST /v1/alpha/search`、`POST /v1/engines/:model/embeddings`
- `POST /v1/video/generations`、`GET /v1/video/generations/:id`、`POST /v1/videos/:id/remix`
- `POST /v1/videos`、`GET /v1/videos/:id`、`GET /v1/videos/:id/content`、`GET /v1/responses/:id`
- `POST/GET /v1/tasks/:key`（产物可写入可选 R2）
- `GET /v1/realtime` WebSocket 升级代理
- Gemini 原生 `POST /v1beta/models/{model}:generateContent`
- `GET /v1/models`、`GET /v1/models/:model`
- Files / fine-tunes / images/variations 与上游一致返回 501
- 渠道优先级 + 权重随机 + 失败重试
- OpenAI ↔ Anthropic / Gemini 协议转换
- Azure / OpenAI 兼容 / Anthropic / Gemini / Ollama / Cloudflare / 阿里兼容模式 / 智谱 / 火山 / 自定义 URL
- multipart（音频等）原样转发 Content-Type 与 body
- 额度：ModelRatio × CompletionRatio × GroupRatio；用户额度 + 令牌额度双扣

**后台 UI**

原项目 `web/` TanStack Router + Rsbuild 控制台原样嵌入：`web/` 为上游源码，`public/` 为其生产构建，经 `ASSETS` 提供。路径与原站一致（`/sign-in`、`/keys`、`/usage-logs`、`/system-settings`、`/task-plugins` 等），`legacy-route` 继续把 `/console/*` 映射到新路径。关于页与页脚保留「Frontend design and development by New API contributors.」及 https://github.com/QuantumNous/new-api 。

构建前端需要 [Bun](https://bun.sh)（与上游 `web/bun.lock` 一致）：

```bash
npm run build:web    # web/ → public/
npm run build        # Worker
```

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
- R2 `edge-api-artifacts` → `env.R2`（任务产物，可选）
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

`npm test` 用 Node 内置 SQLite 模拟 D1，覆盖初始化、登录、2FA、渠道、令牌批量、中继、multipart 音频、兑换码、订阅、排行榜。

`rrangler` 0.4.8 的 `dev` **不会**注入 D1/KV 绑定（生产 `deploy` 会创建并绑定）。没有 D1 时 Worker 仍提供静态控制台与 `/health`；`/api/*` 与 `/v1/*` 需要部署后的 `env.DB`。

公开部署后打开 Worker URL，走一次「初始化」创建 root 账号。

## 架构

| 上游 new-api | Edge API |
| --- | --- |
| Go + Gin + GORM | TypeScript Worker（esbuild 单文件） |
| MySQL / PG / SQLite | D1 |
| Redis / 内存限流 | KV 令牌 RPM |
| 嵌入 React 前端 | 上游 `web/` TanStack 应用构建到 `public/`（ASSETS） |
| Argon2id / bcrypt | Web Crypto PBKDF2-SHA256（旧库密码不可直接迁移） |

## 渠道类型说明

控制台类型目录与 new-api `constant/channel.go` 对齐（含 OpenAI、Azure、Anthropic、Gemini、OpenRouter、DeepSeek、硅基流动、xAI 等）。  
需要厂商 SDK 签名的渠道（部分 AWS/Vertex 服务账号）在未提供 HTTP 兼容 Key 时会返回结构化错误；配置了兼容 Base URL 的仍按 HTTP 中继。

任务插件的 Goja 运行时、SMTP、io.net 集群编排不在 workerd 内执行；对应能力以 D1 登记 + HTTP 探测/passthrough 或明确错误返回。Stripe/Epay/Creem/Waffo 使用 HTTP Checkout（配置密钥后启用）。邮件请配置 `ResendApiKey`。订阅可用余额或在线支付。

## 配置项（系统设置）

常用 options：`SystemName`、`QuotaPerUnit`（默认 500000 ≈ $1）、`RegisterEnabled`、`CheckinEnabled`、`CheckinQuota`、`RetryTimes`、`ModelRatio`、`GroupRatio`、OAuth ClientId、`ResendApiKey` / `ResendFrom`（HTTP 发信）、`RankingsEnabled`、`ExposeRatioEnabled`、`UserAgreement` / `PrivacyPolicy`。Secret 类不在 GET /api/option 回显。

## License

GNU Affero General Public License v3.0。见 `LICENSE` 与 `NOTICE`。
