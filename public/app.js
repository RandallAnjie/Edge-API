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
  const raw = location.hash.replace(/^#\/?/, "") || "home";
  return raw.split("?")[0];
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
        ${nav("about", "关于")}
        ${u ? `
        <div class="nav-sec">对话</div>
        ${nav("playground", "Playground")}
        <div class="nav-sec">控制台</div>
        ${nav("dashboard", "仪表盘")}
        ${nav("tokens", "令牌")}
        ${nav("logs", "日志")}
        ${nav("mj", "Midjourney")}
        <div class="nav-sec">个人</div>
        ${nav("wallet", "钱包 / 兑换")}
        ${nav("profile", "个人设置")}
        ${admin ? `
        <div class="nav-sec">管理</div>
        ${nav("channels", "渠道")}
        ${nav("models", "模型")}
        ${nav("users", "用户")}
        ${nav("redemption", "兑换码")}
        ${nav("audit", "审计")}
        ${root ? nav("settings", "系统设置") : ""}
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
  return layout(`
    <h1>模型定价</h1>
    <p class="sub">来自已启用渠道的模型列表。倍率可在系统设置 ModelRatio 中调整。</p>
    <div class="table-wrap"><table>
      <thead><tr><th>模型</th><th>倍率</th><th>参考</th></tr></thead>
      <tbody>${items.map((m) => `<tr><td class="mono">${esc(m.model_name)}</td><td>${esc(m.model_ratio)}</td><td>${esc(m.owner_by)}</td></tr>`).join("") || `<tr><td colspan="3">暂无模型，请先添加渠道</td></tr>`}</tbody>
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
  return `
  <div class="auth"><div class="card">
    <h1>登录 ${esc(state.status?.system_name || "")}</h1>
    <form id="loginForm">
      <div class="field"><label>用户名</label><input name="username" required /></div>
      <div class="field"><label>密码</label><input name="password" type="password" required /></div>
      <button class="btn primary" type="submit">登录</button>
      ${state.status?.register_enabled ? ` <a class="btn" href="#/register">注册</a>` : ""}
      ${gh ? ` <a class="btn" href="/api/oauth/github">GitHub 登录</a>` : ""}
    </form>
  </div></div>`;
}

async function pageRegister() {
  return `
  <div class="auth"><div class="card">
    <h1>注册</h1>
    <form id="regForm">
      <div class="field"><label>用户名</label><input name="username" required maxlength="20" /></div>
      <div class="field"><label>密码</label><input name="password" type="password" required minlength="8" /></div>
      <div class="field"><label>邀请码（可选）</label><input name="aff_code" /></div>
      <button class="btn primary" type="submit">注册</button>
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
  const r = await api(path + "?page_size=50");
  const page = r.data?.data || { items: [] };
  const items = page.items || [];
  return layout(`
    <h1>日志</h1>
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
  return layout(`
    <h1>钱包</h1>
    <p class="sub">剩余额度 ${money(state.user?.quota)} · 已用 ${money(state.user?.used_quota)}</p>
    <div class="card">
      <h3>兑换码充值</h3>
      <form id="topupForm" class="row">
        <input name="key" placeholder="输入兑换码" style="flex:1" />
        <button class="btn primary">兑换</button>
      </form>
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
    <div class="topbar"><h1>渠道</h1><button class="btn primary" id="newCh">添加渠道</button></div>
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
  return layout(`
    <h1>系统设置</h1>
    <p class="sub">对应 new-api 的 options 表。敏感 Key/Secret 不在列表中显示。</p>
    <form id="optForm">
      ${items.map((o) => `<div class="field"><label>${esc(o.key)}</label><input name="${esc(o.key)}" value="${esc(o.value)}" /></div>`).join("")}
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

const pages = {
  home: pageHome,
  about: pageAbout,
  pricing: pagePricing,
  setup: pageSetup,
  login: pageLogin,
  register: pageRegister,
  dashboard: pageDashboard,
  playground: pagePlayground,
  tokens: pageTokens,
  logs: pageLogs,
  wallet: pageWallet,
  profile: pageProfile,
  channels: pageChannels,
  models: pageModels,
  users: pageUsers,
  redemption: pageRedemption,
  settings: pageSettings,
  audit: pageAudit,
  mj: pageMj,
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
      const body = Object.fromEntries(new FormData(e.target).entries());
      const r = await api("/api/user/login", { method: "POST", body });
      if (!r.data.success) return flash(r.data.message, true);
      state.token = r.data.data.access_token;
      sessionStorage.setItem("edge_token", state.token);
      state.user = r.data.data.user;
      location.hash = "/dashboard";
      render();
    };
  }
  if (page === "register") {
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
  if (page === "dashboard") {
    $("#checkinBtn")?.addEventListener("click", async () => {
      const r = await api("/api/user/checkin", { method: "POST" });
      flash(r.data.message || "ok", !r.data.success);
      render();
    });
  }
  if (page === "playground") bindPlayground();
  if (page === "tokens") bindTokens();
  if (page === "wallet") {
    $("#topupForm").onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target).entries());
      const r = await api("/api/user/topup", { method: "POST", body });
      flash(r.data.message, !r.data.success);
      await refreshUser();
      render();
    };
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
}

function flash(msg, err = false) {
  state.err = err ? msg : "";
  state.notice = err ? "" : msg;
  const n = $(".notice");
  if (n) n.textContent = msg;
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
