export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  role INTEGER NOT NULL DEFAULT 1,
  status INTEGER NOT NULL DEFAULT 1,
  email TEXT NOT NULL DEFAULT '',
  github_id TEXT NOT NULL DEFAULT '',
  quota INTEGER NOT NULL DEFAULT 0,
  used_quota INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  "group" TEXT NOT NULL DEFAULT 'default',
  aff_code TEXT NOT NULL DEFAULT '',
  inviter_id INTEGER NOT NULL DEFAULT 0,
  checkin_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  last_login_at INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT NOT NULL DEFAULT '',
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_backup TEXT NOT NULL DEFAULT '',
  access_token TEXT NOT NULL DEFAULT '',
  discord_id TEXT NOT NULL DEFAULT '',
  oidc_id TEXT NOT NULL DEFAULT '',
  linuxdo_id TEXT NOT NULL DEFAULT '',
  wechat_id TEXT NOT NULL DEFAULT '',
  telegram_id TEXT NOT NULL DEFAULT '',
  settings TEXT NOT NULL DEFAULT '',
  aff_quota INTEGER NOT NULL DEFAULT 0,
  aff_count INTEGER NOT NULL DEFAULT 0,
  aff_history_quota INTEGER NOT NULL DEFAULT 0,
  billing_preference TEXT NOT NULL DEFAULT 'subscription_first',
  email_verified INTEGER NOT NULL DEFAULT 0,
  auth_version INTEGER NOT NULL DEFAULT 1,
  admin_permissions TEXT NOT NULL DEFAULT '',
  access_token_created_at INTEGER NOT NULL DEFAULT 0,
  remark TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL UNIQUE,
  status INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL DEFAULT '',
  created_time INTEGER NOT NULL DEFAULT 0,
  accessed_time INTEGER NOT NULL DEFAULT 0,
  expired_time INTEGER NOT NULL DEFAULT -1,
  remain_quota INTEGER NOT NULL DEFAULT 0,
  unlimited_quota INTEGER NOT NULL DEFAULT 0,
  model_limits_enabled INTEGER NOT NULL DEFAULT 0,
  model_limits TEXT NOT NULL DEFAULT '',
  allow_ips TEXT NOT NULL DEFAULT '',
  used_quota INTEGER NOT NULL DEFAULT 0,
  "group" TEXT NOT NULL DEFAULT '',
  auto_groups TEXT NOT NULL DEFAULT '',
  cross_group_retry INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type INTEGER NOT NULL DEFAULT 1,
  key TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  created_time INTEGER NOT NULL DEFAULT 0,
  test_time INTEGER NOT NULL DEFAULT 0,
  response_time INTEGER NOT NULL DEFAULT 0,
  base_url TEXT NOT NULL DEFAULT '',
  other TEXT NOT NULL DEFAULT '',
  models TEXT NOT NULL DEFAULT '',
  "group" TEXT NOT NULL DEFAULT 'default',
  used_quota INTEGER NOT NULL DEFAULT 0,
  model_mapping TEXT NOT NULL DEFAULT '',
  status_code_mapping TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0,
  auto_ban INTEGER NOT NULL DEFAULT 1,
  tag TEXT NOT NULL DEFAULT '',
  header_override TEXT NOT NULL DEFAULT '',
  param_override TEXT NOT NULL DEFAULT '',
  remark TEXT NOT NULL DEFAULT '',
  settings TEXT NOT NULL DEFAULT '',
  openai_organization TEXT NOT NULL DEFAULT '',
  test_model TEXT NOT NULL DEFAULT '',
  balance TEXT NOT NULL DEFAULT '',
  balance_updated_time INTEGER NOT NULL DEFAULT 0,
  other_info TEXT NOT NULL DEFAULT '',
  channel_info TEXT NOT NULL DEFAULT '',
  setting TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS abilities (
  "group" TEXT NOT NULL,
  model TEXT NOT NULL,
  channel_id INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 0,
  tag TEXT NOT NULL DEFAULT '',
  PRIMARY KEY ("group", model, channel_id)
);
CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  type INTEGER NOT NULL DEFAULT 2,
  content TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  token_name TEXT NOT NULL DEFAULT '',
  model_name TEXT NOT NULL DEFAULT '',
  quota INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  use_time INTEGER NOT NULL DEFAULT 0,
  is_stream INTEGER NOT NULL DEFAULT 0,
  channel_id INTEGER NOT NULL DEFAULT 0,
  token_id INTEGER NOT NULL DEFAULT 0,
  "group" TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  upstream_request_id TEXT NOT NULL DEFAULT '',
  other TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS options (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL UNIQUE,
  status INTEGER NOT NULL DEFAULT 1,
  quota INTEGER NOT NULL DEFAULT 0,
  created_time INTEGER NOT NULL DEFAULT 0,
  redeemed_time INTEGER NOT NULL DEFAULT 0,
  used_user_id INTEGER NOT NULL DEFAULT 0,
  expired_time INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL DEFAULT 0,
  username TEXT NOT NULL DEFAULT '',
  actor_role INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  token_ref TEXT NOT NULL DEFAULT '',
  auth_method TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 1,
  request_id TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  other TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS quota_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 0,
  username TEXT NOT NULL DEFAULT '',
  model_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  quota INTEGER NOT NULL DEFAULT 0,
  token_used INTEGER NOT NULL DEFAULT 0,
  count INTEGER NOT NULL DEFAULT 0,
  use_group TEXT NOT NULL DEFAULT '',
  token_id INTEGER NOT NULL DEFAULT 0,
  channel_id INTEGER NOT NULL DEFAULT 0,
  node_name TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  checkin_date TEXT NOT NULL,
  quota_awarded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, checkin_date)
);
CREATE TABLE IF NOT EXISTS mj_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL DEFAULT 0,
  mj_id TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  prompt_en TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL DEFAULT '',
  video_urls TEXT NOT NULL DEFAULT '',
  progress TEXT NOT NULL DEFAULT '',
  fail_reason TEXT NOT NULL DEFAULT '',
  channel_id INTEGER NOT NULL DEFAULT 0,
  quota INTEGER NOT NULL DEFAULT 0,
  buttons TEXT NOT NULL DEFAULT '',
  properties TEXT NOT NULL DEFAULT '',
  submit_time INTEGER NOT NULL DEFAULT 0,
  start_time INTEGER NOT NULL DEFAULT 0,
  finish_time INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS login_sessions (
  sid TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  ip TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  revoked INTEGER NOT NULL DEFAULT 0,
  login_method TEXT NOT NULL DEFAULT 'password',
  refresh_hash TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  user_auth_version INTEGER NOT NULL DEFAULT 1,
  last_refresh_hash TEXT NOT NULL DEFAULT '',
  last_rotated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS auth_flows (
  token TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  consumed_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS casbin_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ptype TEXT NOT NULL DEFAULT 'p',
  v0 TEXT NOT NULL DEFAULT '',
  v1 TEXT NOT NULL DEFAULT '',
  v2 TEXT NOT NULL DEFAULT '',
  v3 TEXT NOT NULL DEFAULT '',
  v4 TEXT NOT NULL DEFAULT '',
  v5 TEXT NOT NULL DEFAULT '',
  UNIQUE(ptype, v0, v1, v2, v3, v4, v5)
);
CREATE TABLE IF NOT EXISTS authz_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  built_in INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS email_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'verify',
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS topups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  money REAL NOT NULL DEFAULT 0,
  trade_no TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL DEFAULT 'redemption',
  payment_provider TEXT NOT NULL DEFAULT '',
  complete_time INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'success',
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS subscription_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  subtitle TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  price_amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  duration_unit TEXT NOT NULL DEFAULT 'month',
  duration_value INTEGER NOT NULL DEFAULT 1,
  custom_seconds INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  allow_balance_pay INTEGER NOT NULL DEFAULT 1,
  allow_wallet_overflow INTEGER NOT NULL DEFAULT 1,
  stripe_price_id TEXT NOT NULL DEFAULT '',
  creem_product_id TEXT NOT NULL DEFAULT '',
  waffo_pancake_product_id TEXT NOT NULL DEFAULT '',
  max_purchase_per_user INTEGER NOT NULL DEFAULT 0,
  upgrade_group TEXT NOT NULL DEFAULT '',
  downgrade_group TEXT NOT NULL DEFAULT '',
  total_amount INTEGER NOT NULL DEFAULT 0,
  quota_reset_period TEXT NOT NULL DEFAULT 'never',
  quota_reset_custom_seconds INTEGER NOT NULL DEFAULT 0,
  price_quota INTEGER NOT NULL DEFAULT 0,
  duration_days INTEGER NOT NULL DEFAULT 30,
  grant_quota INTEGER NOT NULL DEFAULT 0,
  "group" TEXT NOT NULL DEFAULT '',
  models TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  amount_total INTEGER NOT NULL DEFAULT 0,
  amount_used INTEGER NOT NULL DEFAULT 0,
  start_time INTEGER NOT NULL DEFAULT 0,
  end_time INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'order',
  last_reset_time INTEGER NOT NULL DEFAULT 0,
  next_reset_time INTEGER NOT NULL DEFAULT 0,
  upgrade_group TEXT NOT NULL DEFAULT '',
  prev_user_group TEXT NOT NULL DEFAULT '',
  downgrade_group TEXT NOT NULL DEFAULT '',
  allow_wallet_overflow INTEGER NOT NULL DEFAULT 1,
  start_at INTEGER NOT NULL DEFAULT 0,
  expire_at INTEGER NOT NULL DEFAULT 0,
  remaining_quota INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  task_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL DEFAULT 0,
  token_id INTEGER NOT NULL DEFAULT 0,
  channel_id INTEGER NOT NULL DEFAULT 0,
  "group" TEXT NOT NULL DEFAULT '',
  quota INTEGER NOT NULL DEFAULT 0,
  platform TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'SUBMITTED',
  progress TEXT NOT NULL DEFAULT '',
  model_name TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  fail_reason TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  properties TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '',
  private_data TEXT NOT NULL DEFAULT '',
  submit_time INTEGER NOT NULL DEFAULT 0,
  start_time INTEGER NOT NULL DEFAULT 0,
  finish_time INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  content TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT 0,
  created_time INTEGER NOT NULL DEFAULT 0,
  updated_time INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS prefill_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  created_time INTEGER NOT NULL DEFAULT 0,
  updated_time INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS oauth_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL UNIQUE,
  icon TEXT NOT NULL DEFAULT '',
  client_id TEXT NOT NULL DEFAULT '',
  client_secret TEXT NOT NULL DEFAULT '',
  auth_url TEXT NOT NULL DEFAULT '',
  token_url TEXT NOT NULL DEFAULT '',
  user_info_url TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS user_oauth_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  provider_id INTEGER NOT NULL,
  provider_user_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, provider_id),
  UNIQUE(provider_id, provider_user_id)
);
CREATE TABLE IF NOT EXISTS passkeys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS model_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  vendor_id INTEGER NOT NULL DEFAULT 0,
  icon TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  endpoints TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 1,
  sync_official INTEGER NOT NULL DEFAULT 1,
  name_rule INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  created_time INTEGER NOT NULL DEFAULT 0,
  updated_time INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS task_plugins (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '1.0.0',
  status TEXT NOT NULL DEFAULT 'inactive',
  active_version TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  manifest TEXT NOT NULL DEFAULT '',
  routes TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL DEFAULT '',
  remark TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 0,
  api_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS task_plugin_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  api_version INTEGER NOT NULL DEFAULT 1,
  version TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  remark TEXT NOT NULL DEFAULT '',
  UNIQUE(key, version)
);
CREATE TABLE IF NOT EXISTS system_tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  progress TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  locked_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  model_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  hardware TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  replicas INTEGER NOT NULL DEFAULT 1,
  extra TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS perf_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name TEXT NOT NULL,
  "group" TEXT NOT NULL DEFAULT '',
  bucket_ts INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  total_latency_ms INTEGER NOT NULL DEFAULT 0,
  ttft_sum_ms INTEGER NOT NULL DEFAULT 0,
  ttft_count INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  generation_ms INTEGER NOT NULL DEFAULT 0,
  UNIQUE(model_name, "group", bucket_ts)
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_tokens_key ON api_tokens(key);
CREATE INDEX IF NOT EXISTS idx_channels_status ON channels(status);
CREATE INDEX IF NOT EXISTS idx_abilities_channel ON abilities(channel_id);
CREATE INDEX IF NOT EXISTS idx_abilities_enabled ON abilities(enabled, "group");
CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_user ON request_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_type ON request_logs(type);
CREATE INDEX IF NOT EXISTS idx_quota_user_day ON quota_data(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mj_user ON mj_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON login_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_tid ON tasks(task_id);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_topups_user ON topups(user_id);
CREATE INDEX IF NOT EXISTS idx_email_codes ON email_codes(email, type);
CREATE INDEX IF NOT EXISTS idx_perf_bucket_ts ON perf_metrics(bucket_ts);
`;

const USER_ALTERS = [
  "ALTER TABLE users ADD COLUMN totp_secret TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN totp_backup TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN access_token TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN discord_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN oidc_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN linuxdo_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN wechat_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN telegram_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN settings TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN aff_quota INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN aff_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN aff_history_quota INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN billing_preference TEXT NOT NULL DEFAULT 'quota'",
  "ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE users ADD COLUMN admin_permissions TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN access_token_created_at INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE audit_logs ADD COLUMN event_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE audit_logs ADD COLUMN actor_role INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE audit_logs ADD COLUMN category TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE audit_logs ADD COLUMN action TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE audit_logs ADD COLUMN token_ref TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE audit_logs ADD COLUMN auth_method TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE audit_logs ADD COLUMN user_agent TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE audit_logs ADD COLUMN method TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE audit_logs ADD COLUMN route TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE audit_logs ADD COLUMN status INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE audit_logs ADD COLUMN success INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE audit_logs ADD COLUMN request_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE audit_logs ADD COLUMN other TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE oauth_providers ADD COLUMN icon TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE passkeys ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE auth_flows ADD COLUMN session_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE auth_flows ADD COLUMN consumed_at INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE channels ADD COLUMN balance TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE login_sessions ADD COLUMN login_method TEXT NOT NULL DEFAULT 'password'",
  "ALTER TABLE login_sessions ADD COLUMN refresh_hash TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE login_sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE login_sessions ADD COLUMN user_auth_version INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE login_sessions ADD COLUMN last_refresh_hash TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE login_sessions ADD COLUMN last_rotated_at INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE api_tokens ADD COLUMN auto_groups TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE api_tokens ADD COLUMN cross_group_retry INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE channels ADD COLUMN balance_updated_time INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE channels ADD COLUMN other_info TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE channels ADD COLUMN channel_info TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE channels ADD COLUMN setting TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE request_logs ADD COLUMN upstream_request_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE request_logs ADD COLUMN other TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE quota_data ADD COLUMN use_group TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE quota_data ADD COLUMN token_id INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE quota_data ADD COLUMN channel_id INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE quota_data ADD COLUMN node_name TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE model_meta ADD COLUMN endpoints TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE model_meta ADD COLUMN status INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE model_meta ADD COLUMN sync_official INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE model_meta ADD COLUMN name_rule INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE model_meta ADD COLUMN created_time INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE model_meta ADD COLUMN updated_time INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE subscription_plans ADD COLUMN subtitle TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE subscription_plans ADD COLUMN price_amount REAL NOT NULL DEFAULT 0",
  "ALTER TABLE subscription_plans ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'",
  "ALTER TABLE subscription_plans ADD COLUMN duration_unit TEXT NOT NULL DEFAULT 'month'",
  "ALTER TABLE subscription_plans ADD COLUMN duration_value INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE subscription_plans ADD COLUMN custom_seconds INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE subscription_plans ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE subscription_plans ADD COLUMN allow_balance_pay INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE subscription_plans ADD COLUMN allow_wallet_overflow INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE subscription_plans ADD COLUMN stripe_price_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE subscription_plans ADD COLUMN creem_product_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE subscription_plans ADD COLUMN waffo_pancake_product_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE subscription_plans ADD COLUMN max_purchase_per_user INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE subscription_plans ADD COLUMN upgrade_group TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE subscription_plans ADD COLUMN downgrade_group TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE subscription_plans ADD COLUMN total_amount INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE subscription_plans ADD COLUMN quota_reset_period TEXT NOT NULL DEFAULT 'never'",
  "ALTER TABLE subscription_plans ADD COLUMN quota_reset_custom_seconds INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE subscription_plans ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE user_subscriptions ADD COLUMN amount_total INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE user_subscriptions ADD COLUMN amount_used INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE user_subscriptions ADD COLUMN start_time INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE user_subscriptions ADD COLUMN end_time INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE user_subscriptions ADD COLUMN source TEXT NOT NULL DEFAULT 'order'",
  "ALTER TABLE user_subscriptions ADD COLUMN last_reset_time INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE user_subscriptions ADD COLUMN next_reset_time INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE user_subscriptions ADD COLUMN upgrade_group TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE user_subscriptions ADD COLUMN prev_user_group TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE user_subscriptions ADD COLUMN downgrade_group TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE user_subscriptions ADD COLUMN allow_wallet_overflow INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE user_subscriptions ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE task_plugins ADD COLUMN source TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE task_plugins ADD COLUMN source_hash TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE task_plugins ADD COLUMN remark TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN remark TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE redemptions ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE redemptions ADD COLUMN expired_time INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE topups ADD COLUMN payment_provider TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE topups ADD COLUMN complete_time INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE vendors ADD COLUMN status INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE vendors ADD COLUMN created_time INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE vendors ADD COLUMN updated_time INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE prefill_groups ADD COLUMN description TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE prefill_groups ADD COLUMN created_time INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE prefill_groups ADD COLUMN updated_time INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE task_plugins ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE task_plugins ADD COLUMN active INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE task_plugins ADD COLUMN api_version INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE system_tasks ADD COLUMN payload TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE system_tasks ADD COLUMN state TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE system_tasks ADD COLUMN error TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE system_tasks ADD COLUMN locked_by TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE mj_tasks ADD COLUMN code INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE mj_tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE mj_tasks ADD COLUMN state TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE mj_tasks ADD COLUMN video_url TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE mj_tasks ADD COLUMN video_urls TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE mj_tasks ADD COLUMN quota INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE mj_tasks ADD COLUMN buttons TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE mj_tasks ADD COLUMN properties TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE tasks ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN \"group\" TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE tasks ADD COLUMN quota INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN data TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE tasks ADD COLUMN private_data TEXT NOT NULL DEFAULT ''",
];

import type { D1Database } from "./types.js";

const schemaReady = new WeakSet<D1Database>();

export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady.has(db)) return;
  await db.exec(SCHEMA_SQL);
  for (const sql of USER_ALTERS) {
    try {
      await db.exec(sql);
    } catch {
      /* column already exists on fresh installs */
    }
  }
  const now = Math.floor(Date.now() / 1000);
  await db.exec(
    `INSERT OR IGNORE INTO casbin_rule (ptype, v0, v1, v2, v3, v4, v5) VALUES ('p', 'role:admin', 'channel', 'read', 'allow', '', '');
     INSERT OR IGNORE INTO casbin_rule (ptype, v0, v1, v2, v3, v4, v5) VALUES ('p', 'role:admin', 'channel', 'operate', 'allow', '', '');
     INSERT OR IGNORE INTO casbin_rule (ptype, v0, v1, v2, v3, v4, v5) VALUES ('p', 'role:admin', 'channel', 'write', 'allow', '', '');
     INSERT OR IGNORE INTO authz_roles (key, name, description, built_in, enabled, sort, created_at, updated_at)
       VALUES ('root', 'Root', 'Built-in root authorization role', 1, 1, 0, ${now}, ${now});
     INSERT OR IGNORE INTO authz_roles (key, name, description, built_in, enabled, sort, created_at, updated_at)
       VALUES ('admin', 'Admin', 'Built-in admin authorization role', 1, 1, 10, ${now}, ${now});`,
  );
  schemaReady.add(db);
}

export function resetSchemaFlag(): void {
  /* Per-database WeakSet: each in-memory D1 is a new object, so tests do not share schema state. */
}
