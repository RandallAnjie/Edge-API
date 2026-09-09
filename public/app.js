const $ = (sel, el = document) => el.querySelector(sel);
const app = $("#app");
const state = {
  user: null,
  status: null,
  setup: null,
  token: sessionStorage.getItem("edge_token") || "",
  page: location.hash.replace(/^#\/?/, "") || "home",
  notice: "",
  err: "",
};

function hashPage() {
  const raw = (location.hash.replace(/^#\/?/, "") || "home").split("?")[0];
  const aliases = {
    "sign-in": "login",
    "sign-up": "register",
    register: "register",
    keys: "tokens",
    "usage-logs": "logs",
    "system-settings": "settings",
    "task-plugins": "plugins",
    "system-info": "sysinfo",
    "redemption-codes": "redemption",
    "privacy-policy": "privacy",
    "user-agreement": "agreement",
    "forgot-password": "forgot",
    reset: "forgot",
    otp: "login",
    chat2link: "chat",
    oauth: "login",
    console: "dashboard",
  };
  if (aliases[raw]) return aliases[raw];
  const first = raw.split("/")[0];
  const prefix = {
    "system-settings": "settings",
    "usage-logs": "logs",
    keys: "tokens",
    "sign-in": "login",
    "sign-up": "register",
    "task-plugins": "plugins",
    "system-info": "sysinfo",
    "redemption-codes": "redemption",
    "privacy-policy": "privacy",
    "user-agreement": "agreement",
    "forgot-password": "forgot",
    chat2link: "chat",
    errors: "home",
    oauth: "login",
    pricing: "pricing",
    dashboard: "dashboard",
    models: "models",
    chat: "chat",
  };
  return prefix[first] || first;
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.token) headers.authorization = "Bearer " + state.token;
  if (opts.body && typeof opts.body !== "string" && !(opts.body instanceof FormData)) {
    headers["content-type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { credentials: "include", ...opts, headers });
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  return { ok: res.ok, status: res.status, data };
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function money(q) {
  const unit = Number(state.status?.quota_per_unit || 500000);
  if (state.status?.display_in_currency) return "$" + (Number(q || 0) / unit).toFixed(4);
  return String(q ?? 0);
}

function nav(id, label, show = true) {
  if (!show) return "";
  return `<a href="#/${id}" class="${hashPage() === id ? "active" : ""}">${label}</a>`;
}

function layout(content) {
  const u = state.user;
  const admin = u && u.role >= 10;
  const root = u && u.role >= 100;
  return `
  <div class="mobile-bar">
    <b>${esc(state.status?.system_name || "Edge API")}</b>
    <button class="btn" id="menuBtn">菜单</button>
  </div>
  <div class="layout">
    <aside class="sidebar" id="sidebar">
      <div class="brand">
        <div>
          <b>${esc(state.status?.system_name || "Edge API")}</b>
          <small>RandallFlare · new-api</small>
        </div>
      </div>
      <div class="nav">
        <div class="nav-sec">公开</div>
        ${nav("home", "首页")}
        ${nav("pricing", "模型定价")}
        ${nav("rankings", "排行榜", !!state.status?.rankings_enabled)}
        ${nav("about", "关于")}
        ${nav("agreement", "用户协议")}
        ${nav("privacy", "隐私政策")}
        ${u ? `
        <div class="nav-sec">对话</div>
        ${nav("chat", "对话")}
        ${nav("playground", "Playground")}
        <div class="nav-sec">控制台</div>
        ${nav("dashboard", "仪表盘")}
        ${nav("tokens", "令牌")}
        ${nav("logs", "日志")}
        ${nav("mj", "Midjourney")}
        ${nav("tasks", "异步任务")}
        <div class="nav-sec">个人</div>
        ${nav("wallet", "钱包 / 兑换")}
        ${nav("subscriptions", "订阅")}
        ${nav("profile", "个人设置")}
        ${nav("security", "安全")}
        ${admin ? `
        <div class="nav-sec">管理</div>
        ${nav("channels", "渠道")}
        ${nav("models", "模型")}
        ${nav("users", "用户")}
        ${nav("redemption", "兑换码")}
        ${nav("audit", "审计")}
        ${nav("data", "用量数据")}
        ${nav("vendors", "厂商")}
        ${nav("deployments", "部署")}
        ${nav("plugins", "任务插件")}
        ${nav("sysinfo", "系统信息")}
        ${root ? nav("settings", "系统设置") : ""}
        ${root ? nav("performance", "性能") : ""}
        ` : ""}
        <div class="nav-sec"></div>
        <button class="link" id="logoutBtn">退出登录</button>
        ` : `
        ${nav("login", "登录")}
        ${state.status?.register_enabled ? nav("register", "注册") : ""}
        `}
      </div>
    </aside>
    <main class="main">
      ${state.err ? `<div class="notice err">${esc(state.err)}</div>` : ""}
      ${state.notice ? `<div class="notice ok">${esc(state.notice)}</div>` : ""}
      ${content}
      <div class="footer">
        Frontend design and development by New API contributors.
        · <a href="https://github.com/QuantumNous/new-api" target="_blank" rel="noreferrer">QuantumNous/new-api</a>
        · AGPLv3 · 本站为 RandallFlare Worker 移植版（Edge API）
      </div>
    </main>
  </div>`;
}

function bindCommon() {
  $("#menuBtn")?.addEventListener("click", () => $("#sidebar")?.classList.toggle("open"));
  $("#logoutBtn")?.addEventListener("click", async () => {
    await api("/api/user/auth/logout", { method: "POST" });
    state.token = "";
    sessionStorage.removeItem("edge_token");
    state.user = null;
    location.hash = "/login";
    render();
  });
}

async function pageHome() {
  return layout(`
    <div class="hero">
      <h1>${esc(state.status?.system_name || "Edge API")}</h1>
      <p>将 QuantumNous new-api 的完整网关能力运行在 RandallFlare（Cloudflare Workers / workerd）上。兼容 OpenAI / Claude / Gemini 协议，渠道调度、额度、令牌、日志与后台均可在边缘节点完成。</p>
      <div class="row">
        ${state.user ? `<a class="btn primary" href="#/dashboard">进入控制台</a>` : `<a class="btn primary" href="#/login">登录</a>`}
        <a class="btn" href="#/pricing">查看定价</a>
      </div>
    </div>
    <div class="cards">
      <div class="card"><div class="k">版本</div><div class="v" style="font-size:16px">${esc(state.status?.version || "")}</div></div>
      <div class="card"><div class="k">运行时</div><div class="v" style="font-size:16px">${esc(state.status?.runtime || "workerd")}</div></div>
      <div class="card"><div class="k">注册</div><div class="v" style="font-size:16px">${state.status?.register_enabled ? "开放" : "关闭"}</div></div>
      <div class="card"><div class="k">签到</div><div class="v" style="font-size:16px">${state.status?.checkin_enabled ? "开启" : "关闭"}</div></div>
    </div>
    <div class="card">${state.status?.home_page_content || state.status?.notice || "尚未配置首页公告，可在系统设置中编辑 Notice / HomePageContent。"}</div>
  `);
}

async function pageAbout() {
  return layout(`
    <h1>关于</h1>
    <p class="sub">本项目是 <a href="https://github.com/QuantumNous/new-api">QuantumNous/new-api</a> 的 AGPLv3 修改版本，面向 RandallFlare 部署。</p>
    <div class="card">
      <p>Frontend design and development by New API contributors.</p>
      <p>${esc(state.status?.about || "未配置 About 文案。")}</p>
      <p>协议：GNU Affero General Public License v3.0。源码与 NOTICE 见仓库。</p>
    </div>
  `);
}

async function pagePricing() {
  const r = await api("/api/pricing");
  const items = r.data?.data || [];
  const vendors = r.data?.vendors || [];
  return layout(`
    <h1>模型定价</h1>
    <p class="sub">对应原项目 GetPricing：data / vendors / group_ratio / usable_group / supported_endpoint / auto_groups。倍率可在系统设置 ModelRatio 中调整。</p>
    ${vendors.length ? `<p class="sub">厂商 ${vendors.length} 个 · 分组 ${Object.keys(r.data?.usable_group || {}).join(", ") || "default"}</p>` : ""}
    <div class="table-wrap"><table>
      <thead><tr><th>模型</th><th>倍率</th><th>补全</th><th>分组</th></tr></thead>
      <tbody>${items.map((m) => `<tr><td class="mono">${esc(m.model_name)}</td><td>${esc(m.model_ratio)}</td><td>${esc(m.completion_ratio)}</td><td>${esc((m.enable_groups || []).join(", "))}</td></tr>`).join("") || `<tr><td colspan="4">暂无模型，请先添加渠道</td></tr>`}</tbody>
    </table></div>
  `);
}

async function pageSetup() {
  return `
  <div class="auth"><div class="card">
    <h1>初始化</h1>
    <p class="sub">创建超级管理员（用户名 ≤ 12 字符，密码 8–128）。</p>
    <form id="setupForm">
      <div class="field"><label>用户名</label><input name="username" required maxlength="12" /></div>
      <div class="field"><label>密码</label><input name="password" type="password" required minlength="8" /></div>
      <div class="field"><label>确认密码</label><input name="confirmPassword" type="password" required /></div>
      <label><input type="checkbox" name="SelfUseModeEnabled" checked /> 自用模式</label>
      <div style="margin-top:14px"><button class="btn primary" type="submit">完成初始化</button></div>
    </form>
  </div></div>`;
}

async function pageLogin() {
  const gh = state.status?.github_oauth && state.status?.github_client_id;
  const dc = state.status?.discord_oauth && state.status?.discord_client_id;
  const ld = state.status?.linuxdo_oauth && state.status?.linuxdo_client_id;
  const oidc = state.status?.oidc_enabled || state.status?.oidc_auth;
  const wechat = state.status?.wechat_login;
  const tg = state.status?.telegram_oauth;
  const customs = state.status?.custom_oauth_providers || [];
  return `
  <div class="auth"><div class="card">
    <h1>登录 ${esc(state.status?.system_name || "")}</h1>
    <form id="loginForm">
      <div class="field"><label>用户名</label><input name="username" required /></div>
      <div class="field"><label>密码</label><input name="password" type="password" required /></div>
      <div id="twofaField" class="field hidden"><label>2FA 验证码</label><input name="code" inputmode="numeric" /></div>
      <input type="hidden" name="flow_token" />
      <button class="btn primary" type="submit">登录</button>
      ${state.status?.register_enabled ? ` <a class="btn" href="#/register">注册</a>` : ""}
      <a class="btn" href="#/forgot">忘记密码</a>
    </form>
    <div class="row" style="margin-top:12px">
      ${gh ? ` <a class="btn" href="/api/oauth/github">GitHub</a>` : ""}
      ${dc ? ` <a class="btn" href="/api/oauth/discord">Discord</a>` : ""}
      ${ld ? ` <a class="btn" href="/api/oauth/linuxdo">LinuxDO</a>` : ""}
      ${oidc ? ` <a class="btn" href="/api/oauth/oidc">${esc(state.status?.oidc_display_name || "OIDC")}</a>` : ""}
      ${wechat ? ` <a class="btn" href="/api/oauth/wechat">微信</a>` : ""}
      ${tg ? ` <a class="btn" href="/api/oauth/telegram">Telegram</a>` : ""}
      ${customs.map((p) => `<a class="btn" href="/api/oauth/${esc(p.slug || p.name)}">${esc(p.name || p.slug)}</a>`).join(" ")}
    </div>
  </div></div>`;
}

async function pageRegister() {
  const needEmail = state.status?.email_verification;
  return `
  <div class="auth"><div class="card">
    <h1>注册</h1>
    <form id="regForm">
      <div class="field"><label>用户名</label><input name="username" required maxlength="20" /></div>
      <div class="field"><label>密码</label><input name="password" type="password" required minlength="8" /></div>
      ${needEmail ? `<div class="field"><label>邮箱</label><input name="email" type="email" required />
        <div class="row"><input name="verification_code" placeholder="验证码" /><button class="btn" type="button" id="sendCode">发送验证码</button></div></div>` : ""}
      <div class="field"><label>邀请码（可选）</label><input name="aff_code" /></div>
      <button class="btn primary" type="submit">注册</button>
    </form>
  </div></div>`;
}

async function pageForgot() {
  return `
  <div class="auth"><div class="card">
    <h1>重置密码</h1>
    <form id="forgotForm">
      <div class="field"><label>邮箱</label><input name="email" type="email" required /></div>
      <div class="row"><button class="btn" type="button" id="sendReset">发送验证码</button></div>
      <div class="field"><label>验证码</label><input name="code" /></div>
      <div class="field"><label>新密码</label><input name="password" type="password" required minlength="8" /></div>
      <button class="btn primary">重置</button>
    </form>
  </div></div>`;
}

async function pageDashboard() {
  const self = await api("/api/user/self");
  const user = self.data?.data || state.user;
  const stat = await api("/api/log/self/stat");
  const data = await api("/api/data/self");
  const ck = await api("/api/user/checkin");
  const rows = data.data?.data || [];
  return layout(`
    <div class="topbar">
      <div>
        <h1>仪表盘</h1>
        <p class="sub">你好，${esc(user.display_name || user.username)} · ${user.role >= 100 ? "超级管理员" : user.role >= 10 ? "管理员" : "用户"}</p>
      </div>
      ${ck.data?.data?.enabled && !ck.data?.data?.checked_in ? `<button class="btn primary" id="checkinBtn">签到 +${ck.data.data.checkin_quota}</button>` : `<span class="tag on">今日已签到 / 签到关闭</span>`}
    </div>
    <div class="cards">
      <div class="card"><div class="k">剩余额度</div><div class="v">${money(user.quota)}</div></div>
      <div class="card"><div class="k">已用额度</div><div class="v">${money(user.used_quota)}</div></div>
      <div class="card"><div class="k">请求次数</div><div class="v">${esc(user.request_count)}</div></div>
      <div class="card"><div class="k">RPM / TPM</div><div class="v">${esc(stat.data?.data?.rpm || 0)} / ${esc(stat.data?.data?.tpm || 0)}</div></div>
    </div>
    <div class="card">
      <div class="k">近 7 日消耗</div>
      <div class="table-wrap" style="margin-top:10px"><table>
        <thead><tr><th>日期</th><th>模型</th><th>额度</th><th>次数</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${new Date(r.created_at * 1000).toISOString().slice(0,10)}</td><td>${esc(r.model_name)}</td><td>${money(r.quota)}</td><td>${esc(r.count)}</td></tr>`).join("") || `<tr><td colspan="4">暂无数据</td></tr>`}</tbody>
      </table></div>
    </div>
  `);
}

async function pagePlayground() {
  const models = await api("/api/user/models");
  const list = models.data?.data || [];
  return layout(`
    <h1>Playground</h1>
    <p class="sub">使用当前账号额度调用 /pg/chat/completions，协议为 OpenAI Chat Completions。</p>
    <div class="row" style="margin-bottom:10px">
      <div class="field"><label>模型</label>
        <select id="pgModel">${list.map((m) => `<option>${esc(m)}</option>`).join("") || `<option>gpt-4o-mini</option>`}</select>
      </div>
      <label><input type="checkbox" id="pgStream" checked /> 流式</label>
    </div>
    <div class="chat">
      <div class="msgs" id="msgs"></div>
      <div class="composer">
        <textarea id="pgInput" placeholder="输入消息，Enter 发送，Shift+Enter 换行"></textarea>
        <button class="btn primary" id="pgSend">发送</button>
      </div>
    </div>
  `);
}

async function pageTokens() {
  const r = await api("/api/token/");
  const page = r.data?.data || { items: [] };
  const items = page.items || [];
  return layout(`
    <div class="topbar"><h1>令牌</h1><button class="btn primary" id="newToken">新建令牌</button></div>
    <div class="table-wrap"><table>
      <thead><tr><th>名称</th><th>Key</th><th>额度</th><th>状态</th><th></th></tr></thead>
      <tbody>${items.map((t) => `<tr>
        <td>${esc(t.name)}</td>
        <td class="mono">${esc(t.key)}</td>
        <td>${t.unlimited_quota ? "无限" : money(t.remain_quota)}</td>
        <td><span class="tag ${t.status === 1 ? "on" : "off"}">${t.status === 1 ? "启用" : "禁用"}</span></td>
        <td>
          <button class="btn" data-show="${t.id}">显示</button>
          <button class="btn" data-toggle="${t.id}" data-status="${t.status}">${t.status === 1 ? "禁用" : "启用"}</button>
          <button class="btn danger" data-del="${t.id}">删除</button>
        </td>
      </tr>`).join("") || `<tr><td colspan="5">暂无令牌</td></tr>`}</tbody>
    </table></div>
    <div class="modal-bg hidden" id="tokenModal">
      <div class="modal">
        <h1>新建令牌</h1>
        <form id="tokenForm">
          <div class="field"><label>名称</label><input name="name" value="default" /></div>
          <div class="field"><label>额度</label><input name="remain_quota" type="number" value="500000" /></div>
          <label><input type="checkbox" name="unlimited_quota" /> 无限额度</label>
          <div class="field"><label>过期时间 Unix（-1 永不）</label><input name="expired_time" value="-1" /></div>
          <div class="field"><label>IP 白名单（逗号分隔）</label><input name="allow_ips" /></div>
          <div class="field"><label>模型限制（逗号分隔，可空）</label><input name="model_limits" /></div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" type="submit">创建</button>
            <button class="btn" type="button" id="closeToken">取消</button>
          </div>
        </form>
      </div>
    </div>
  `);
}

async function pageLogs() {
  const path = state.user?.role >= 10 ? "/api/log/" : "/api/log/self";
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  const type = q.get("type") || "";
  const model = q.get("model_name") || "";
  const r = await api(path + `?page_size=50&type=${encodeURIComponent(type)}&model_name=${encodeURIComponent(model)}`);
  const page = r.data?.data || { items: [] };
  const items = page.items || [];
  return layout(`
    <h1>日志</h1>
    <form id="logFilter" class="row" style="margin-bottom:12px">
      <input name="model_name" placeholder="模型" value="${esc(model)}" />
      <select name="type"><option value="">全部类型</option><option value="2" ${type==="2"?"selected":""}>消费</option><option value="1" ${type==="1"?"selected":""}>充值</option><option value="5" ${type==="5"?"selected":""}>错误</option></select>
      <button class="btn">筛选</button>
    </form>
    <div class="table-wrap"><table>
      <thead><tr><th>时间</th><th>用户</th><th>令牌</th><th>模型</th><th>额度</th><th>tokens</th><th>耗时</th></tr></thead>
      <tbody>${items.map((l) => `<tr>
        <td>${new Date(l.created_at * 1000).toLocaleString()}</td>
        <td>${esc(l.username)}</td><td>${esc(l.token_name)}</td>
        <td>${esc(l.model_name)}</td><td>${money(l.quota)}</td>
        <td>${l.prompt_tokens}/${l.completion_tokens}</td><td>${l.use_time}s</td>
      </tr>`).join("") || `<tr><td colspan="7">暂无日志</td></tr>`}</tbody>
    </table></div>
  `);
}

async function pageWallet() {
  const aff = await api("/api/user/aff");
  const a = aff.data?.data || {};
  const hist = await api("/api/user/topup/self");
  const info = await api("/api/user/topup/info");
  const pay = info.data?.data || {};
  const items = hist.data?.data?.items || [];
  const methods = pay.pay_methods || [];
  return layout(`
    <h1>钱包</h1>
    <p class="sub">剩余额度 ${money(state.user?.quota)} · 已用 ${money(state.user?.used_quota)}</p>
    <div class="cards">
      <div class="card"><div class="k">邀请码</div><div class="v" style="font-size:18px">${esc(a.aff_code)}</div></div>
      <div class="card"><div class="k">邀请人数</div><div class="v">${esc(a.aff_count)}</div></div>
      <div class="card"><div class="k">待划转邀请额度</div><div class="v">${money(a.aff_quota)}</div></div>
    </div>
    <div class="card">
      <h3>在线充值</h3>
      <p class="sub">
        Epay ${pay.enable_online_topup ? "开" : "关"} · Stripe ${pay.enable_stripe_topup ? "开" : "关"} ·
        Creem ${pay.enable_creem_topup ? "开" : "关"} · Waffo ${pay.enable_waffo_topup ? "开" : "关"} ·
        最低 ${esc(pay.min_topup)} · 兑换码 ${pay.enable_redemption ? "开" : "关"}
      </p>
      <p class="sub">${methods.length ? "支付方式：" + methods.map((m) => m.name || m.type).join("、") : "未配置在线支付（需在系统设置填写密钥并确认合规条款）"}</p>
    </div>
    <div class="card">
      <h3>兑换码充值</h3>
      <form id="topupForm" class="row">
        <input name="key" placeholder="输入兑换码" style="flex:1" />
        <button class="btn primary">兑换</button>
      </form>
    </div>
    <div class="card">
      <h3>邀请额度划转到余额</h3>
      <form id="affForm" class="row">
        <input name="quota" type="number" placeholder="额度" style="flex:1" />
        <button class="btn">划转</button>
      </form>
    </div>
    <div class="card">
      <div class="k">充值记录</div>
      <div class="table-wrap" style="margin-top:10px"><table>
        <thead><tr><th>时间</th><th>方式</th><th>额度</th><th>状态</th></tr></thead>
        <tbody>${items.map((t) => `<tr><td>${new Date(t.created_at * 1000).toLocaleString()}</td><td>${esc(t.payment_method)}</td><td>${money(t.amount)}</td><td>${esc(t.status)}</td></tr>`).join("") || `<tr><td colspan="4">暂无</td></tr>`}</tbody>
      </table></div>
    </div>
  `);
}

async function pageProfile() {
  const u = state.user;
  return layout(`
    <h1>个人设置</h1>
    <div class="card">
      <form id="profForm">
        <div class="field"><label>用户名</label><input value="${esc(u.username)}" disabled /></div>
        <div class="field"><label>显示名</label><input name="display_name" value="${esc(u.display_name || "")}" /></div>
        <div class="field"><label>原密码</label><input name="original_password" type="password" /></div>
        <div class="field"><label>新密码</label><input name="password" type="password" /></div>
        <button class="btn primary">保存</button>
      </form>
    </div>
  `);
}

async function pageChannels() {
  const r = await api("/api/channel/?page_size=50");
  const page = r.data?.data || { items: [] };
  const items = page.items || [];
  const types = await api("/api/channel/types");
  const tlist = types.data?.data || [];
  return layout(`
    <div class="topbar">
      <h1>渠道</h1>
      <div class="row">
        <button class="btn" id="testAll">测试全部</button>
        <button class="btn primary" id="newCh">添加渠道</button>
      </div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>名称</th><th>类型</th><th>分组</th><th>优先级</th><th>权重</th><th>状态</th><th></th></tr></thead>
      <tbody>${items.map((ch) => `<tr>
        <td>${ch.id}</td><td>${esc(ch.name)}</td><td>${esc(tlist.find((t) => t.id === ch.type)?.name || ch.type)}</td>
        <td>${esc(ch.group)}</td><td>${ch.priority}</td><td>${ch.weight}</td>
        <td><span class="tag ${ch.status === 1 ? "on" : "off"}">${ch.status === 1 ? "启用" : "禁用"}</span></td>
        <td>
          <button class="btn" data-test="${ch.id}">测试</button>
          <button class="btn" data-edit="${ch.id}">编辑</button>
          <button class="btn" data-st="${ch.id}" data-status="${ch.status}">${ch.status === 1 ? "禁用" : "启用"}</button>
          <button class="btn danger" data-del="${ch.id}">删除</button>
        </td></tr>`).join("") || `<tr><td colspan="8">暂无渠道</td></tr>`}</tbody>
    </table></div>
    <div class="modal-bg hidden" id="chModal"><div class="modal">
      <h1 id="chTitle">渠道</h1>
      <form id="chForm">
        <input type="hidden" name="id" />
        <div class="row">
          <div class="field"><label>名称</label><input name="name" required /></div>
          <div class="field"><label>类型</label>
            <select name="type">${tlist.map((t) => `<option value="${t.id}">${t.id} ${esc(t.name)}</option>`).join("")}</select>
          </div>
        </div>
        <div class="field"><label>Key（多行即多 Key）</label><textarea name="key"></textarea></div>
        <div class="field"><label>Base URL</label><input name="base_url" placeholder="留空使用类型默认" /></div>
        <div class="field"><label>模型列表（逗号分隔）</label><textarea name="models" placeholder="gpt-4o,gpt-4o-mini"></textarea></div>
        <div class="row">
          <div class="field"><label>分组</label><input name="group" value="default" /></div>
          <div class="field"><label>优先级</label><input name="priority" type="number" value="0" /></div>
          <div class="field"><label>权重</label><input name="weight" type="number" value="1" /></div>
        </div>
        <div class="field"><label>Other（Azure API 版本 / CF Account ID 等）</label><input name="other" /></div>
        <div class="field"><label>模型映射 JSON</label><textarea name="model_mapping" placeholder='{"gpt-4":"gpt-4o"}'></textarea></div>
        <div class="field"><label>Header Override JSON</label><textarea name="header_override"></textarea></div>
        <div class="field"><label>备注</label><input name="remark" /></div>
        <div class="row"><button class="btn primary">保存</button><button class="btn" type="button" id="closeCh">取消</button>
          <button class="btn" type="button" id="fetchModels">拉取上游模型</button></div>
      </form>
    </div></div>
  `);
}

async function pageModels() {
  const r = await api("/api/channel/models");
  const list = r.data?.data || [];
  return layout(`
    <h1>已启用模型</h1>
    <p class="sub">汇总自所有已启用渠道。用户 Playground 与 /v1/models 均使用此列表。</p>
    <div class="card">${list.map((m) => `<span class="tag" style="margin:4px">${esc(m)}</span>`).join("") || "暂无"}</div>
  `);
}

async function pageUsers() {
  const r = await api("/api/user/?page_size=50");
  const page = r.data?.data || { items: [] };
  const items = page.items || [];
  return layout(`
    <div class="topbar"><h1>用户</h1><button class="btn primary" id="newUser">创建用户</button></div>
    <div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>用户名</th><th>角色</th><th>额度</th><th>状态</th><th></th></tr></thead>
      <tbody>${items.map((u) => `<tr>
        <td>${u.id}</td><td>${esc(u.username)}</td>
        <td>${u.role >= 100 ? "Root" : u.role >= 10 ? "Admin" : "User"}</td>
        <td>${money(u.quota)}</td>
        <td><span class="tag ${u.status === 1 ? "on" : "off"}">${u.status === 1 ? "启用" : "禁用"}</span></td>
        <td>
          <button class="btn" data-act="enable" data-id="${u.id}">启用</button>
          <button class="btn" data-act="disable" data-id="${u.id}">禁用</button>
          <button class="btn" data-quota="${u.id}">加额度</button>
        </td>
      </tr>`).join("")}</tbody>
    </table></div>
    <div class="modal-bg hidden" id="userModal"><div class="modal">
      <h1>创建用户</h1>
      <form id="userForm">
        <div class="field"><label>用户名</label><input name="username" required /></div>
        <div class="field"><label>密码</label><input name="password" type="password" required minlength="8" /></div>
        <div class="field"><label>额度</label><input name="quota" type="number" value="0" /></div>
        <div class="field"><label>角色</label><select name="role"><option value="1">User</option><option value="10">Admin</option></select></div>
        <button class="btn primary">创建</button>
        <button class="btn" type="button" id="closeUser">取消</button>
      </form>
    </div></div>
  `);
}

async function pageRedemption() {
  const r = await api("/api/redemption/?page_size=50");
  const page = r.data?.data || { items: [] };
  const items = page.items || [];
  return layout(`
    <div class="topbar"><h1>兑换码</h1><button class="btn primary" id="newRed">生成</button></div>
    <div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>名称</th><th>Key</th><th>额度</th><th>状态</th></tr></thead>
      <tbody>${items.map((x) => `<tr><td>${x.id}</td><td>${esc(x.name)}</td><td class="mono">${esc(x.key)}</td><td>${money(x.quota)}</td><td>${x.status === 1 ? "未用" : x.status === 3 ? "已用" : "禁用"}</td></tr>`).join("") || `<tr><td colspan="5">暂无</td></tr>`}</tbody>
    </table></div>
    <div class="modal-bg hidden" id="redModal"><div class="modal">
      <h1>生成兑换码</h1>
      <form id="redForm">
        <div class="field"><label>名称</label><input name="name" value="default" /></div>
        <div class="field"><label>额度</label><input name="quota" type="number" value="500000" /></div>
        <div class="field"><label>数量</label><input name="count" type="number" value="1" /></div>
        <button class="btn primary">生成</button>
        <button class="btn" type="button" id="closeRed">取消</button>
      </form>
      <pre id="redKeys" class="mono"></pre>
    </div></div>
  `);
}

async function pageSettings() {
  const r = await api("/api/option/");
  const items = r.data?.data || [];
  const groups = {
    站点: ["SystemName", "Logo", "Footer", "Notice", "About", "HomePageContent", "DocsLink", "UserAgreement", "PrivacyPolicy"],
    额度: ["QuotaPerUnit", "DisplayInCurrency", "QuotaForNewUser", "QuotaForInviter", "QuotaForInvitee", "CheckinEnabled", "CheckinQuota"],
    注册登录: ["RegisterEnabled", "PasswordLoginEnabled", "PasswordRegisterEnabled", "EmailVerificationEnabled", "GitHubOAuthEnabled", "GitHubClientId", "DiscordOAuthEnabled", "DiscordClientId", "LinuxDOOAuthEnabled", "LinuxDOClientId", "OIDCAuthEnabled", "OIDCClientId", "PasskeyEnabled"],
    渠道: ["RetryTimes", "AutomaticDisableChannelEnabled", "AutomaticEnableChannelEnabled", "ChannelDisableThreshold"],
    倍率: ["ModelRatio", "CompletionRatio", "GroupRatio", "ExposeRatioEnabled", "RankingsEnabled"],
    邮件: ["ResendFrom"],
  };
  const used = new Set(Object.values(groups).flat());
  const rest = items.filter((o) => !used.has(o.key));
  const block = (title, keys) => {
    const rows = items.filter((o) => keys.includes(o.key));
    if (!rows.length) return "";
    return `<div class="card"><h3>${title}</h3>${rows.map((o) => `<div class="field"><label>${esc(o.key)}</label><input name="${esc(o.key)}" value="${esc(o.value)}" /></div>`).join("")}</div>`;
  };
  return layout(`
    <h1>系统设置</h1>
    <p class="sub">对应 new-api 的 options。敏感 Key/Secret 不回显。ResendApiKey 请用 PUT 单独写入。</p>
    <form id="optForm">
      ${Object.entries(groups).map(([t, k]) => block(t, k)).join("")}
      ${rest.length ? `<div class="card"><h3>其他</h3>${rest.map((o) => `<div class="field"><label>${esc(o.key)}</label><input name="${esc(o.key)}" value="${esc(o.value)}" /></div>`).join("")}</div>` : ""}
      <button class="btn primary">保存全部</button>
    </form>
  `);
}

async function pageAudit() {
  const r = await api("/api/audit?page_size=50");
  const page = r.data?.data || { items: [] };
  const items = page.items || [];
  return layout(`
    <h1>审计日志</h1>
    <div class="table-wrap"><table>
      <thead><tr><th>时间</th><th>用户</th><th>类型</th><th>内容</th><th>IP</th></tr></thead>
      <tbody>${items.map((a) => `<tr><td>${new Date(a.created_at * 1000).toLocaleString()}</td><td>${esc(a.username)}</td><td>${esc(a.type)}</td><td>${esc(a.content)}</td><td>${esc(a.ip)}</td></tr>`).join("") || `<tr><td colspan="5">暂无</td></tr>`}</tbody>
    </table></div>
  `);
}

async function pageMj() {
  const path = state.user?.role >= 10 ? "/api/mj/" : "/api/mj/self";
  const r = await api(path);
  const page = r.data?.data || { items: [] };
  const items = page.items || [];
  return layout(`
    <h1>Midjourney 任务</h1>
    <p class="sub">提交走 /mj/* 中继。需添加 type=Midjourney 的渠道。</p>
    <div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>动作</th><th>状态</th><th>进度</th><th>MJ ID</th></tr></thead>
      <tbody>${items.map((t) => `<tr><td>${t.id}</td><td>${esc(t.action)}</td><td>${esc(t.status)}</td><td>${esc(t.progress)}</td><td class="mono">${esc(t.mj_id)}</td></tr>`).join("") || `<tr><td colspan="5">暂无任务</td></tr>`}</tbody>
    </table></div>
  `);
}

async function pageRankings() {
  const r = await api("/api/rankings");
  const items = r.data?.data || [];
  return layout(`
    <h1>排行榜</h1>
    <p class="sub">按近 7 日 quota_data 汇总。</p>
    <div class="table-wrap"><table>
      <thead><tr><th>用户</th><th>额度</th><th>次数</th></tr></thead>
      <tbody>${items.map((x) => `<tr><td>${esc(x.username)}</td><td>${money(x.quota)}</td><td>${esc(x.count)}</td></tr>`).join("") || `<tr><td colspan="3">暂无</td></tr>`}</tbody>
    </table></div>
  `);
}

async function pageLegal(kind) {
  const r = await api(kind === "agreement" ? "/api/user-agreement" : "/api/privacy-policy");
  const text = r.data?.data || "";
  return layout(`
    <h1>${kind === "agreement" ? "用户协议" : "隐私政策"}</h1>
    <div class="card" style="white-space:pre-wrap">${esc(text) || "尚未配置，请在系统设置中填写 UserAgreement / PrivacyPolicy。"}</div>
  `);
}

async function pageSecurity() {
  const st = await api("/api/user/2fa/status");
  const sess = await api("/api/user/sessions");
  const tok = await api("/api/user/token/status");
  const pk = await api("/api/user/passkey");
  const sessions = sess.data?.data || [];
  const enabled = st.data?.data?.enabled;
  return layout(`
    <h1>安全</h1>
    <div class="card">
      <h3>两步验证 TOTP</h3>
      <p class="sub">${enabled ? "已启用" : "未启用"}</p>
      ${enabled ? `<button class="btn danger" id="disable2fa">关闭 2FA</button>` : `<button class="btn primary" id="setup2fa">启用 2FA</button>`}
      <pre id="otpauth" class="mono"></pre>
    </div>
    <div class="card">
      <h3>管理访问令牌</h3>
      <p class="sub">${tok.data?.data?.enabled ? "已生成（不回显）" : "未生成"}。用于 Bearer 调用 /api，不是 sk- 中继令牌。</p>
      <button class="btn" id="genAccess">生成 / 轮换</button>
      <button class="btn danger" id="revAccess">撤销</button>
      <pre id="accessOut" class="mono"></pre>
    </div>
    <div class="card">
      <h3>Passkey</h3>
      <p class="sub">${(pk.data?.data?.credentials || []).length ? "已绑定 " + pk.data.data.credentials.length + " 个" : "未绑定"}</p>
      <button class="btn" id="regPasskey">绑定当前设备</button>
      <button class="btn danger" id="delPasskey">全部解绑</button>
    </div>
    <div class="card">
      <div class="topbar"><h3>登录会话</h3><button class="btn" id="revokeOthers">注销其他会话</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th>SID</th><th>IP</th><th>最近</th><th></th></tr></thead>
        <tbody>${sessions.map((x) => `<tr><td class="mono">${esc(x.sid).slice(0,12)}…</td><td>${esc(x.ip)}</td><td>${new Date((x.last_active_at || x.last_seen)*1000).toLocaleString()}</td>
          <td>${x.current ? "当前" : `<button class="btn danger" data-sid="${esc(x.sid)}">注销</button>`}</td></tr>`).join("")}</tbody>
      </table></div>
    </div>
  `);
}

async function pageChat() {
  const convs = await api("/api/conversations");
  const list = convs.data?.data || [];
  const models = await api("/api/user/models");
  const mlist = models.data?.data || [];
  return layout(`
    <h1>对话</h1>
    <p class="sub">会话保存在 D1。发送走 Playground 中继。</p>
    <div class="chat-layout">
      <div class="card">
        <button class="btn primary" id="newConv">新对话</button>
        <div id="convList">${list.map((c) => `<a class="nav a" href="#/chat?id=${c.id}" style="display:block;margin:6px 0">${esc(c.title || "未命名")}</a>`).join("") || "<p class='sub'>暂无会话</p>"}</div>
      </div>
      <div class="chat">
        <div class="row" style="padding:10px">
          <select id="pgModel">${mlist.map((m) => `<option>${esc(m)}</option>`).join("") || `<option>gpt-4o-mini</option>`}</select>
          <label><input type="checkbox" id="pgStream" checked /> 流式</label>
        </div>
        <div class="msgs" id="msgs"></div>
        <div class="composer">
          <textarea id="pgInput" placeholder="输入消息"></textarea>
          <button class="btn primary" id="pgSend">发送</button>
        </div>
      </div>
    </div>
  `);
}

async function pageSubscriptions() {
  const plans = await api("/api/subscription/plans");
  const self = await api("/api/subscription/self");
  const admin = state.user?.role >= 10;
  const adminPlans = admin ? await api("/api/subscription/admin/plans") : { data: { data: [] } };
  const plist = plans.data?.data || [];
  const mine = self.data?.data || [];
  return layout(`
    <h1>订阅</h1>
    <p class="sub">使用余额购买套餐（不走 Stripe）。到期由定时任务失效。</p>
    <div class="cards">${plist.map((p) => `<div class="card"><div class="k">${esc(p.title)}</div><div class="v">${money(p.price_quota)}</div>
      <p class="sub">${esc(p.description)} · ${p.duration_days} 天 · 赠送 ${money(p.grant_quota)}</p>
      <button class="btn primary" data-buy="${p.id}">购买</button></div>`).join("") || `<div class="card">暂无套餐</div>`}</div>
    <h3>我的订阅</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>套餐</th><th>到期</th><th>状态</th></tr></thead>
      <tbody>${mine.map((s) => `<tr><td>${esc(s.plan_title || s.plan_id)}</td><td>${s.expire_at ? new Date(s.expire_at*1000).toLocaleString() : ""}</td><td>${s.status===1?"有效":"失效"}</td></tr>`).join("") || `<tr><td colspan="3">无</td></tr>`}</tbody>
    </table></div>
    ${admin ? `<div class="card" style="margin-top:16px"><h3>管理：创建套餐</h3>
      <form id="planForm">
        <div class="field"><label>标题</label><input name="title" required /></div>
        <div class="field"><label>价格额度</label><input name="price_quota" type="number" value="500000" /></div>
        <div class="field"><label>赠送额度</label><input name="grant_quota" type="number" value="500000" /></div>
        <div class="field"><label>天数</label><input name="duration_days" type="number" value="30" /></div>
        <button class="btn primary">创建</button>
      </form>
      <p class="sub">已有 ${ (adminPlans.data?.data || []).length } 个套餐</p>
    </div>` : ""}
  `);
}

async function pageTasks() {
  const path = state.user?.role >= 10 ? "/api/task" : "/api/task/self";
  const r = await api(path);
  const items = r.data?.data?.items || [];
  return layout(`
    <h1>异步任务</h1>
    <p class="sub">视频生成 /v1/video/generations 与 /v1/tasks/:key 会写入此表。</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Task ID</th><th>平台</th><th>模型</th><th>状态</th><th>时间</th></tr></thead>
      <tbody>${items.map((t) => `<tr><td class="mono">${esc(t.task_id)}</td><td>${esc(t.platform)}</td><td>${esc(t.model_name)}</td><td>${esc(t.status)}</td><td>${t.submit_time ? new Date(t.submit_time*1000).toLocaleString() : ""}</td></tr>`).join("") || `<tr><td colspan="5">暂无</td></tr>`}</tbody>
    </table></div>
  `);
}

async function pagePlugins() {
  const r = await api("/api/plugin/task");
  const items = r.data?.data || [];
  return layout(`
    <h1>任务插件</h1>
    <p class="sub">对应原项目 /task-plugins。插件清单存于 D1，激活后可匹配公开路由并按 passthrough 转发。</p>
    <form id="pluginForm" class="card">
      <div class="row">
        <input name="key" placeholder="key" required />
        <input name="name" placeholder="名称" />
        <input name="version" placeholder="1.0.0" />
        <button class="btn primary" type="submit">登记</button>
      </div>
    </form>
    <div class="table-wrap"><table>
      <thead><tr><th>key</th><th>名称</th><th>版本</th><th>状态</th></tr></thead>
      <tbody>${(Array.isArray(items) ? items : []).map((p) => `<tr><td class="mono">${esc(p.key)}</td><td>${esc(p.name)}</td><td>${esc(p.version)}</td><td>${esc(p.status)}</td></tr>`).join("") || `<tr><td colspan="4">暂无插件</td></tr>`}</tbody>
    </table></div>
  `);
}

async function pageSysinfo() {
  const r = await api("/api/system-info/instances");
  const items = r.data?.data || [];
  return layout(`
    <h1>系统信息</h1>
    <p class="sub">workerd 单 isolate。原项目多实例列表在此以本节点表示。</p>
    <div class="table-wrap"><table>
      <thead><tr><th>节点</th><th>版本</th><th>其它</th></tr></thead>
      <tbody>${(Array.isArray(items) ? items : [items]).map((x) => `<tr><td>${esc(x.node_name || x.runtime || "")}</td><td>${esc(x.version || "")}</td><td class="mono">${esc(JSON.stringify(x).slice(0, 180))}</td></tr>`).join("")}</tbody>
    </table></div>
  `);
}

async function pagePerformance() {
  const r = await api("/api/performance/stats");
  return layout(`
    <h1>性能</h1>
    <pre class="card">${esc(JSON.stringify(r.data?.data || r.data, null, 2))}</pre>
  `);
}

async function pageDeployments() {
  const r = await api("/api/deployments/");
  const items = r.data?.data?.items || r.data?.data || [];
  return layout(`
    <h1>模型部署</h1>
    <p class="sub">对应原项目 /deployments。io.net 等外部集群在配置密钥后可探测连通。</p>
    <div class="table-wrap"><table>
      <thead><tr><th>名称</th><th>模型</th><th>状态</th><th>硬件</th></tr></thead>
      <tbody>${(Array.isArray(items) ? items : []).map((d) => `<tr><td>${esc(d.name)}</td><td>${esc(d.model_name)}</td><td>${esc(d.status)}</td><td>${esc(d.hardware)}</td></tr>`).join("") || `<tr><td colspan="4">暂无部署</td></tr>`}</tbody>
    </table></div>
  `);
}

async function pageData() {
  const r = await api("/api/data/");
  const items = r.data?.data || [];
  return layout(`
    <h1>用量数据</h1>
    <div class="table-wrap"><table>
      <thead><tr><th>日期</th><th>用户</th><th>额度</th></tr></thead>
      <tbody>${(Array.isArray(items) ? items : []).map((d) => `<tr><td>${esc(d.date || d.created_at || "")}</td><td>${esc(d.username || d.user_id || "")}</td><td>${esc(d.quota)}</td></tr>`).join("") || `<tr><td colspan="3">暂无</td></tr>`}</tbody>
    </table></div>
  `);
}

async function pageVendors() {
  const r = await api("/api/vendors/");
  const items = r.data?.data?.items || r.data?.data || [];
  return layout(`
    <h1>厂商</h1>
    <div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>名称</th></tr></thead>
      <tbody>${(Array.isArray(items) ? items : []).map((v) => `<tr><td>${esc(v.id)}</td><td>${esc(v.name || v.vendor_name)}</td></tr>`).join("") || `<tr><td colspan="2">暂无</td></tr>`}</tbody>
    </table></div>
  `);
}

const pages = {
  home: pageHome,
  about: pageAbout,
  pricing: pagePricing,
  rankings: pageRankings,
  agreement: () => pageLegal("agreement"),
  privacy: () => pageLegal("privacy"),
  setup: pageSetup,
  login: pageLogin,
  register: pageRegister,
  forgot: pageForgot,
  dashboard: pageDashboard,
  playground: pagePlayground,
  chat: pageChat,
  tokens: pageTokens,
  logs: pageLogs,
  wallet: pageWallet,
  subscriptions: pageSubscriptions,
  profile: pageProfile,
  security: pageSecurity,
  channels: pageChannels,
  models: pageModels,
  users: pageUsers,
  redemption: pageRedemption,
  settings: pageSettings,
  audit: pageAudit,
  mj: pageMj,
  tasks: pageTasks,
  plugins: pagePlugins,
  sysinfo: pageSysinfo,
  performance: pagePerformance,
  deployments: pageDeployments,
  data: pageData,
  vendors: pageVendors,
};

async function afterRender(page) {
  bindCommon();
  if (page === "setup") {
    $("#setupForm").onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = Object.fromEntries(fd.entries());
      body.SelfUseModeEnabled = fd.get("SelfUseModeEnabled") === "on";
      const r = await api("/api/setup", { method: "POST", body });
      if (!r.data.success) return flash(r.data.message, true);
      location.hash = "/login";
      await boot();
    };
  }
  if (page === "login") {
    $("#loginForm").onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const flow = fd.get("flow_token");
      if (flow) {
        const r = await api("/api/user/login/2fa", { method: "POST", body: { flow_token: flow, code: fd.get("code") } });
        if (!r.data.success) return flash(r.data.message, true);
        state.token = r.data.data.access_token;
        sessionStorage.setItem("edge_token", state.token);
        state.user = r.data.data.user;
        location.hash = "/dashboard";
        render();
        return;
      }
      const r = await api("/api/user/login", { method: "POST", body: { username: fd.get("username"), password: fd.get("password") } });
      if (!r.data.success) return flash(r.data.message, true);
      if (r.data.data?.require_2fa || r.data.data?.require_verification) {
        e.target.flow_token.value = r.data.data.flow_token;
        $("#twofaField").classList.remove("hidden");
        flash("请输入 2FA 验证码");
        return;
      }
      state.token = r.data.data.access_token;
      sessionStorage.setItem("edge_token", state.token);
      state.user = r.data.data.user;
      location.hash = "/dashboard";
      render();
    };
  }
  if (page === "register") {
    $("#sendCode")?.addEventListener("click", async () => {
      const email = document.querySelector("[name=email]")?.value;
      const r = await api("/api/verification?email=" + encodeURIComponent(email));
      flash(r.data.message || "ok", !r.data.success);
    });
    $("#regForm").onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target).entries());
      const r = await api("/api/user/register", { method: "POST", body });
      if (!r.data.success) return flash(r.data.message, true);
      state.token = r.data.data.access_token;
      sessionStorage.setItem("edge_token", state.token);
      state.user = r.data.data.user;
      location.hash = "/dashboard";
      render();
    };
  }
  if (page === "forgot") {
    $("#sendReset")?.addEventListener("click", async () => {
      const email = document.querySelector("[name=email]")?.value;
      const r = await api("/api/reset_password?email=" + encodeURIComponent(email));
      flash(r.data.message || "ok", !r.data.success);
    });
    $("#forgotForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target).entries());
      const r = await api("/api/user/reset", { method: "POST", body });
      flash(r.data.message || "ok", !r.data.success);
      if (r.data.success) location.hash = "/login";
    });
  }
  if (page === "dashboard") {
    $("#checkinBtn")?.addEventListener("click", async () => {
      const r = await api("/api/user/checkin", { method: "POST" });
      flash(r.data.message || "ok", !r.data.success);
      render();
    });
  }
  if (page === "playground") bindPlayground();
  if (page === "chat") bindChat();
  if (page === "tokens") bindTokens();
  if (page === "logs") {
    $("#logFilter")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      location.hash = "/logs?type=" + encodeURIComponent(fd.get("type") || "") + "&model_name=" + encodeURIComponent(fd.get("model_name") || "");
    });
  }
  if (page === "wallet") {
    $("#topupForm").onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target).entries());
      const r = await api("/api/user/topup", { method: "POST", body });
      flash(r.data.message, !r.data.success);
      await refreshUser();
      render();
    };
    $("#affForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const quota = Number(new FormData(e.target).get("quota"));
      const r = await api("/api/user/aff_transfer", { method: "POST", body: { quota } });
      flash(r.data.message, !r.data.success);
      await refreshUser();
      render();
    });
  }
  if (page === "security") bindSecurity();
  if (page === "subscriptions") {
    document.querySelectorAll("[data-buy]").forEach((b) => {
      b.onclick = async () => {
        const r = await api("/api/subscription/balance/pay", { method: "POST", body: { plan_id: Number(b.dataset.buy) } });
        flash(r.data.message || "ok", !r.data.success);
        if (r.data.success) render();
      };
    });
    $("#planForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target).entries());
      body.price_quota = Number(body.price_quota);
      body.grant_quota = Number(body.grant_quota);
      body.duration_days = Number(body.duration_days);
      const r = await api("/api/subscription/admin/plans", { method: "POST", body });
      flash(r.data.message || "ok", !r.data.success);
      if (r.data.success) render();
    });
  }
  if (page === "profile") {
    $("#profForm").onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target).entries());
      const r = await api("/api/user/self", { method: "PUT", body });
      flash(r.data.message || "已保存", !r.data.success);
    };
  }
  if (page === "channels") bindChannels();
  if (page === "users") bindUsers();
  if (page === "redemption") bindRedemption();
  if (page === "settings") {
    $("#optForm").onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      for (const [key, value] of fd.entries()) {
        await api("/api/option/", { method: "PUT", body: { key, value } });
      }
      flash("已保存");
    };
  }
  if (page === "plugins") {
    $("#pluginForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target).entries());
      body.status = "active";
      const r = await api("/api/plugin/task", { method: "POST", body });
      flash(r.data.message || (r.data.success ? "已登记" : "失败"), !r.data.success);
      if (r.data.success) render();
    });
  }
}

function flash(msg, err = false) {
  state.err = err ? msg : "";
  state.notice = err ? "" : msg;
  const n = $(".notice");
  if (n) n.textContent = msg;
}

function bindChat() {
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  let convId = Number(q.get("id") || 0);
  const history = [];
  const msgs = $("#msgs");
  async function load() {
    if (!convId) return;
    const r = await api("/api/conversations/" + convId);
    const list = r.data?.data?.messages || [];
    msgs.innerHTML = "";
    history.length = 0;
    for (const m of list) {
      history.push({ role: m.role, content: m.content });
      const d = document.createElement("div");
      d.className = "bubble " + m.role;
      d.textContent = m.content;
      msgs.appendChild(d);
    }
    if (r.data?.data?.model) $("#pgModel").value = r.data.data.model;
  }
  load();
  $("#newConv").onclick = async () => {
    const r = await api("/api/conversations", { method: "POST", body: { title: "新对话", model: $("#pgModel").value } });
    location.hash = "/chat?id=" + r.data.data.id;
    render();
  };
  $("#pgSend").onclick = send;
  $("#pgInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  async function send() {
    const input = $("#pgInput");
    const text = input.value.trim();
    if (!text) return;
    if (!convId) {
      const r = await api("/api/conversations", { method: "POST", body: { title: text.slice(0, 40), model: $("#pgModel").value } });
      convId = r.data.data.id;
      history.replaceState(null, "", "#/chat?id=" + convId);
    }
    input.value = "";
    history.push({ role: "user", content: text });
    await api(`/api/conversations/${convId}/messages`, { method: "POST", body: { role: "user", content: text } });
    const d = document.createElement("div");
    d.className = "bubble user";
    d.textContent = text;
    msgs.appendChild(d);
    const bubble = document.createElement("div");
    bubble.className = "bubble assistant";
    msgs.appendChild(bubble);
    const stream = $("#pgStream").checked;
    const model = $("#pgModel").value;
    const res = await fetch("/pg/chat/completions", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", ...(state.token ? { authorization: "Bearer " + state.token } : {}) },
      body: JSON.stringify({ model, stream, messages: history }),
    });
    let acc = "";
    if (stream && res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            acc += JSON.parse(data).choices?.[0]?.delta?.content || "";
            bubble.textContent = acc;
          } catch {}
        }
      }
    } else {
      const json = await res.json();
      acc = json.choices?.[0]?.message?.content || json.message || JSON.stringify(json);
      bubble.textContent = acc;
    }
    history.push({ role: "assistant", content: acc });
    await api(`/api/conversations/${convId}/messages`, { method: "POST", body: { role: "assistant", content: acc } });
  }
}

function bindSecurity() {
  $("#setup2fa")?.addEventListener("click", async () => {
    const setup = await api("/api/user/2fa/setup", { method: "POST" });
    if (!setup.data.success) return flash(setup.data.message, true);
    $("#otpauth").textContent = setup.data.data.otpauth_url + "\nsecret: " + setup.data.data.secret;
    const code = prompt("请输入认证器中的 6 位验证码");
    if (!code) return;
    const en = await api("/api/user/2fa/enable", { method: "POST", body: { code } });
    flash(en.data.message || "ok", !en.data.success);
    if (en.data.success && en.data.data?.backup_codes) alert("备用码：\n" + en.data.data.backup_codes.join("\n"));
    if (en.data.success) render();
  });
  $("#disable2fa")?.addEventListener("click", async () => {
    const code = prompt("输入 2FA 验证码");
    const r = await api("/api/user/2fa/disable", { method: "POST", body: { code } });
    flash(r.data.message, !r.data.success);
    if (r.data.success) render();
  });
  $("#genAccess").onclick = async () => {
    const r = await api("/api/user/token", { method: "POST" });
    $("#accessOut").textContent = r.data.data?.access_token || r.data.message;
  };
  $("#revAccess").onclick = async () => {
    await api("/api/user/token", { method: "DELETE" });
    flash("已撤销");
    render();
  };
  $("#revokeOthers").onclick = async () => {
    await api("/api/user/sessions/revoke-others", { method: "POST" });
    render();
  };
  document.querySelectorAll("[data-sid]").forEach((b) => {
    b.onclick = async () => {
      await api("/api/user/sessions/" + b.dataset.sid, { method: "DELETE" });
      render();
    };
  });
  $("#regPasskey")?.addEventListener("click", async () => {
    if (!window.PublicKeyCredential) return flash("浏览器不支持 Passkey", true);
    const begin = await api("/api/user/passkey/register/begin", { method: "POST" });
    if (!begin.data.success) return flash(begin.data.message, true);
    const opt = begin.data.data.publicKey;
    const challenge = Uint8Array.from(atob(opt.challenge.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    opt.challenge = challenge;
    opt.user.id = new TextEncoder().encode(opt.user.id);
    try {
      const cred = await navigator.credentials.create({ publicKey: opt });
      const att = cred.response;
      const publicKey = btoa(String.fromCharCode(...new Uint8Array(att.getPublicKey())));
      const credential_id = btoa(String.fromCharCode(...new Uint8Array(cred.rawId)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const r = await api("/api/user/passkey/register/finish", {
        method: "POST",
        body: {
          flow_id: begin.data.data.flow_id,
          credential_id,
          public_key: publicKey.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
          name: cred.id,
        },
      });
      flash(r.data.message || "ok", !r.data.success);
      if (r.data.success) render();
    } catch (err) {
      flash(err.message || String(err), true);
    }
  });
  $("#delPasskey")?.addEventListener("click", async () => {
    await api("/api/user/passkey", { method: "DELETE" });
    render();
  });
}

function bindPlayground() {
  const msgs = $("#msgs");
  const history = [];
  const add = (role, text) => {
    const d = document.createElement("div");
    d.className = "bubble " + role;
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
  };
  $("#pgSend").onclick = send;
  $("#pgInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  async function send() {
    const input = $("#pgInput");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    history.push({ role: "user", content: text });
    add("user", text);
    const stream = $("#pgStream").checked;
    const model = $("#pgModel").value;
    const bubble = document.createElement("div");
    bubble.className = "bubble assistant";
    bubble.textContent = "";
    msgs.appendChild(bubble);
    const res = await fetch("/pg/chat/completions", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", ...(state.token ? { authorization: "Bearer " + state.token } : {}) },
      body: JSON.stringify({ model, stream, messages: history }),
    });
    if (stream && res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let acc = "";
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const obj = JSON.parse(data);
            const t = obj.choices?.[0]?.delta?.content || "";
            acc += t;
            bubble.textContent = acc;
          } catch {}
        }
      }
      history.push({ role: "assistant", content: acc });
    } else {
      const json = await res.json();
      const t = json.choices?.[0]?.message?.content || json.message || JSON.stringify(json);
      bubble.textContent = t;
      history.push({ role: "assistant", content: t });
    }
  }
}

function bindTokens() {
  $("#newToken").onclick = () => $("#tokenModal").classList.remove("hidden");
  $("#closeToken").onclick = () => $("#tokenModal").classList.add("hidden");
  $("#tokenForm").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.unlimited_quota = fd.get("unlimited_quota") === "on";
    body.remain_quota = Number(body.remain_quota);
    body.expired_time = Number(body.expired_time);
    body.model_limits_enabled = !!body.model_limits;
    const r = await api("/api/token/", { method: "POST", body });
    if (!r.data.success) return flash(r.data.message, true);
    alert("令牌： " + r.data.data.key);
    render();
  };
  document.querySelectorAll("[data-show]").forEach((b) => {
    b.onclick = async () => {
      const r = await api(`/api/token/${b.dataset.show}/key`, { method: "POST" });
      alert(r.data?.data?.key || r.data.message);
    };
  });
  document.querySelectorAll("[data-toggle]").forEach((b) => {
    b.onclick = async () => {
      await api("/api/token/", { method: "PUT", body: { id: Number(b.dataset.toggle), status: Number(b.dataset.status) === 1 ? 2 : 1 } });
      render();
    };
  });
  document.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      await api("/api/token/" + b.dataset.del, { method: "DELETE" });
      render();
    };
  });
}

function bindChannels() {
  const modal = $("#chModal");
  const form = $("#chForm");
  $("#newCh").onclick = () => {
    $("#chTitle").textContent = "添加渠道";
    form.reset();
    modal.classList.remove("hidden");
  };
  $("#testAll")?.addEventListener("click", async () => {
    const r = await api("/api/channel/test");
    flash(r.data.success ? "测试完成" : r.data.message, !r.data.success);
    if (r.data.success) alert(JSON.stringify(r.data.data, null, 2).slice(0, 2000));
  });
  $("#closeCh").onclick = () => modal.classList.add("hidden");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form).entries());
    body.type = Number(body.type);
    body.priority = Number(body.priority);
    body.weight = Number(body.weight);
    const method = body.id ? "PUT" : "POST";
    if (body.id) body.id = Number(body.id);
    else delete body.id;
    const r = await api("/api/channel/", { method, body });
    flash(r.data.message || "ok", !r.data.success);
    if (r.data.success) render();
  };
  $("#fetchModels").onclick = async () => {
    const body = Object.fromEntries(new FormData(form).entries());
    const r = await api("/api/channel/fetch_models", { method: "POST", body: { type: Number(body.type), key: body.key, base_url: body.base_url } });
    if (!r.data.success) return flash(r.data.message, true);
    form.models.value = (r.data.data || []).join(",");
  };
  document.querySelectorAll("[data-edit]").forEach((b) => {
    b.onclick = async () => {
      const r = await api("/api/channel/" + b.dataset.edit);
      const ch = r.data.data;
      $("#chTitle").textContent = "编辑渠道";
      for (const [k, v] of Object.entries(ch)) {
        if (form.elements[k] != null) form.elements[k].value = v ?? "";
      }
      modal.classList.remove("hidden");
    };
  });
  document.querySelectorAll("[data-test]").forEach((b) => {
    b.onclick = async () => {
      const r = await api("/api/channel/test/" + b.dataset.test);
      flash(r.data.message || JSON.stringify(r.data.data), !r.data.success);
    };
  });
  document.querySelectorAll("[data-st]").forEach((b) => {
    b.onclick = async () => {
      await api("/api/channel/" + b.dataset.st + "/status", { method: "POST", body: { status: Number(b.dataset.status) === 1 ? 2 : 1 } });
      render();
    };
  });
  document.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("删除该渠道？")) return;
      await api("/api/channel/" + b.dataset.del, { method: "DELETE" });
      render();
    };
  });
}

function bindUsers() {
  $("#newUser").onclick = () => $("#userModal").classList.remove("hidden");
  $("#closeUser").onclick = () => $("#userModal").classList.add("hidden");
  $("#userForm").onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    body.quota = Number(body.quota);
    body.role = Number(body.role);
    const r = await api("/api/user/", { method: "POST", body });
    flash(r.data.message, !r.data.success);
    if (r.data.success) render();
  };
  document.querySelectorAll("[data-act]").forEach((b) => {
    b.onclick = async () => {
      await api("/api/user/manage", { method: "POST", body: { id: Number(b.dataset.id), action: b.dataset.act } });
      render();
    };
  });
  document.querySelectorAll("[data-quota]").forEach((b) => {
    b.onclick = async () => {
      const q = Number(prompt("增加额度", "500000"));
      if (!q) return;
      await api("/api/user/manage", { method: "POST", body: { id: Number(b.dataset.quota), action: "add_quota", quota: q } });
      render();
    };
  });
}

function bindRedemption() {
  $("#newRed").onclick = () => $("#redModal").classList.remove("hidden");
  $("#closeRed").onclick = () => $("#redModal").classList.add("hidden");
  $("#redForm").onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    body.quota = Number(body.quota);
    body.count = Number(body.count);
    const r = await api("/api/redemption/", { method: "POST", body });
    $("#redKeys").textContent = (r.data.data || []).join("\n");
  };
}

async function refreshUser() {
  const r = await api("/api/user/self");
  if (r.data?.success) state.user = r.data.data;
  else state.user = null;
}

async function boot() {
  const setup = await api("/api/setup");
  state.setup = setup.data?.data;
  const st = await api("/api/status");
  state.status = st.data?.data || {};
  if (state.token || document.cookie.includes("session=")) await refreshUser();
}

async function render() {
  state.page = hashPage();
  state.err = "";
  if (state.setup && !state.setup.status && state.page !== "setup") {
    if (location.hash !== "#/setup") location.hash = "/setup";
    state.page = "setup";
  }
  const fn = pages[state.page] || pageHome;
  try {
    app.innerHTML = await fn();
  } catch (e) {
    app.innerHTML = layout(`<div class="notice err">${esc(e.message || e)}</div>`);
  }
  await afterRender(state.page);
}

window.addEventListener("hashchange", render);
boot().then(render);
