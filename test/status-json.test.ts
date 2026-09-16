import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1()): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test" };
}

async function json(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { res, body, text };
}

async function boot(e: Env) {
  await json(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12", confirmPassword: "password12" }),
    }),
    e,
  );
  const login = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  const token = (login.body.data as { access_token: string }).access_token;
  const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
  return { token, auth, login };
}

/** Original `controller.GetStatus` gin.H keys that are always present. */
const ORIGINAL_GET_STATUS_KEYS = [
  "version",
  "start_time",
  "email_verification",
  "github_oauth",
  "github_client_id",
  "discord_oauth",
  "discord_client_id",
  "linuxdo_oauth",
  "linuxdo_client_id",
  "linuxdo_minimum_trust_level",
  "telegram_oauth",
  "telegram_oauth_configured",
  "telegram_bot_name",
  "theme",
  "system_name",
  "logo",
  "footer_html",
  "wechat_qrcode",
  "wechat_login",
  "server_address",
  "turnstile_check",
  "turnstile_site_key",
  "docs_link",
  "quota_per_unit",
  "display_in_currency",
  "quota_display_type",
  "custom_currency_symbol",
  "custom_currency_exchange_rate",
  "enable_batch_update",
  "enable_drawing",
  "enable_task",
  "enable_data_export",
  "data_export_default_time",
  "default_collapse_sidebar",
  "mj_notify_enabled",
  "chats",
  "demo_site_enabled",
  "self_use_mode_enabled",
  "register_enabled",
  "password_login_enabled",
  "password_register_enabled",
  "default_use_auto_group",
  "password_login_encryption_enabled",
  "usd_exchange_rate",
  "price",
  "stripe_unit_price",
  "api_info_enabled",
  "uptime_kuma_enabled",
  "announcements_enabled",
  "faq_enabled",
  "HeaderNavModules",
  "SidebarModulesAdmin",
  "oidc_enabled",
  "oidc_client_id",
  "oidc_authorization_endpoint",
  "oidc_display_name",
  "passkey_login",
  "passkey_display_name",
  "passkey_rp_id",
  "passkey_rp_ids",
  "passkey_allow_insecure",
  "passkey_user_verification",
  "passkey_attachment",
  "setup",
  "user_agreement_enabled",
  "privacy_policy_enabled",
  "checkin_enabled",
];

const GET_STATUS_EXTRAS = [
  "wechat_qr_code",
  "wechat_qrcode_image_url",
  "WeChatAccountQRCodeImageURL",
  "oidc_auth",
  "passkey",
  "passkey_origins",
  "display_token_stat_enabled",
  "oauth_register_enabled",
  "rankings_enabled",
  "notice",
  "about",
  "home_page_content",
  "runtime",
  "original_project",
];

test("original GetStatus JSON keys match controller.GetStatus gin.H", async () => {
  resetSchemaFlag();
  const e = env();
  await boot(e);
  const status = await json(new Request("http://local/api/status"), e);
  assert.equal(status.body.success, true);
  assert.equal(status.body.message, "");
  const data = status.body.data as Record<string, unknown>;
  for (const k of ORIGINAL_GET_STATUS_KEYS) {
    assert.ok(k in data, "missing GetStatus field " + k);
  }
  for (const extra of GET_STATUS_EXTRAS) {
    assert.equal(extra in data, false, "extra GetStatus key " + extra);
  }
  assert.equal(data.theme, "default");
  assert.equal(data.oidc_display_name, "OIDC");
  assert.equal("custom_oauth_providers" in data, false);
  assert.ok("api_info" in data);
  assert.ok("announcements" in data);
  assert.ok("faq" in data);

  const keys = Object.keys(data).sort();
  const expected = [...ORIGINAL_GET_STATUS_KEYS, "api_info", "announcements", "faq"].sort();
  assert.deepEqual(keys, expected);
});

test("original GetStatus does not expose passkey_origins", async () => {
  resetSchemaFlag();
  const e = env();
  await boot(e);
  const store = new Store(e.DB);
  await store.setOption("passkey.enabled", "true");
  await store.setOption("passkey.origins", "https://www.example.com,https://private.example.com");
  await store.setOption("Theme", "dark");
  const status = await json(new Request("http://local/api/status"), e);
  const data = status.body.data as Record<string, unknown>;
  assert.equal(status.body.success, true);
  assert.equal("passkey_origins" in data, false);
  assert.equal(status.text.includes("private.example.com"), false);
  assert.equal(data.passkey_login, true);
  assert.equal(data.theme, "default");
});

test("original GetStatus api_info/announcements/faq match GetApiInfo/GetAnnouncements/GetFAQ", async () => {
  resetSchemaFlag();
  const e = env();
  await boot(e);
  const store = new Store(e.DB);

  await store.setOption("console_setting.api_info", "{}");
  await store.setOption(
    "console_setting.announcements",
    JSON.stringify([
      { content: "old", publishDate: "2026-01-01T00:00:00Z" },
      { content: "new", publishDate: "2026-09-16T00:00:00Z" },
      { content: "also-new", publishDate: "2026-09-16T00:00:00Z" },
    ]),
  );
  await store.setOption("console_setting.faq", "not-json");

  const status = await json(new Request("http://local/api/status"), e);
  const data = status.body.data as Record<string, unknown>;
  assert.equal(data.api_info, null);
  assert.equal(data.faq, null);
  assert.deepEqual(
    (data.announcements as { content: string }[]).map((row) => row.content),
    ["new", "also-new", "old"],
  );
});
