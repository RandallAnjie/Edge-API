export interface D1Meta {
  last_row_id?: number;
  changes?: number;
}

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta?: D1Meta;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<{ success: boolean; meta: D1Meta }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<unknown>;
}

export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface R2Object {
  arrayBuffer(): Promise<ArrayBuffer>;
  httpMetadata?: { contentType?: string };
}

export interface R2Bucket {
  put(key: string, value: ArrayBuffer | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<R2Object | null>;
}

export interface Env {
  DB: D1Database;
  KV?: KVNamespace;
  ASSETS?: AssetsBinding;
  R2?: R2Bucket;
  SESSION_SECRET?: string;
  SYSTEM_NAME?: string;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export interface UserRow {
  id: number;
  username: string;
  password: string;
  display_name: string;
  role: number;
  status: number;
  email: string;
  github_id: string;
  quota: number;
  used_quota: number;
  request_count: number;
  group: string;
  aff_code: string;
  inviter_id: number;
  checkin_at: number;
  created_at: number;
  last_login_at: number;
  totp_secret?: string;
  totp_enabled?: number;
  totp_backup?: string;
  access_token?: string;
  discord_id?: string;
  oidc_id?: string;
  linuxdo_id?: string;
  wechat_id?: string;
  telegram_id?: string;
  settings?: string;
  aff_quota?: number;
  aff_count?: number;
  aff_history_quota?: number;
  billing_preference?: string;
  email_verified?: number;
  auth_version?: number;
  admin_permissions?: string;
}

export interface LoginSessionRow {
  sid: string;
  user_id: number;
  created_at: number;
  last_seen: number;
  expires_at: number;
  ip: string;
  ua: string;
  revoked: number;
  login_method?: string;
  refresh_hash?: string;
  version?: number;
  user_auth_version?: number;
  last_refresh_hash?: string;
  last_rotated_at?: number;
}

export interface TokenRow {
  id: number;
  user_id: number;
  key: string;
  status: number;
  name: string;
  created_time: number;
  accessed_time: number;
  expired_time: number;
  remain_quota: number;
  unlimited_quota: number;
  model_limits_enabled: number;
  model_limits: string;
  allow_ips: string;
  used_quota: number;
  group: string;
  auto_groups?: string;
  cross_group_retry?: number;
}

export interface ChannelRow {
  id: number;
  type: number;
  key: string;
  status: number;
  name: string;
  weight: number;
  created_time: number;
  test_time: number;
  response_time: number;
  base_url: string;
  other: string;
  models: string;
  group: string;
  used_quota: number;
  model_mapping: string;
  status_code_mapping: string;
  priority: number;
  auto_ban: number;
  tag: string;
  header_override: string;
  param_override: string;
  remark: string;
  settings: string;
  openai_organization: string;
  test_model: string;
  balance?: string;
  balance_updated_time?: number;
  other_info?: string;
  channel_info?: string;
  setting?: string;
}

export interface LogRow {
  id: number;
  user_id: number;
  created_at: number;
  type: number;
  content: string;
  username: string;
  token_name: string;
  model_name: string;
  quota: number;
  prompt_tokens: number;
  completion_tokens: number;
  use_time: number;
  is_stream: number;
  channel_id: number;
  token_id: number;
  group: string;
  ip: string;
  request_id: string;
  upstream_request_id?: string;
  other?: string;
  channel_name?: string;
}

export interface RedemptionRow {
  id: number;
  name: string;
  key: string;
  status: number;
  quota: number;
  created_time: number;
  redeemed_time: number;
  used_user_id: number;
}

export interface SessionUser {
  id: number;
  username: string;
  display_name: string;
  role: number;
  status: number;
  group: string;
  quota: number;
  used_quota: number;
  request_count: number;
  email: string;
  sid?: string;
  userAuthVersion?: number;
  sessionVersion?: number;
}

export interface AuthToken {
  token: TokenRow;
  user: UserRow;
  usingGroup: string;
}

export interface PageQuery {
  page: number;
  page_size: number;
  offset: number;
}

export type AdapterKind =
  | "openai"
  | "azure"
  | "anthropic"
  | "gemini"
  | "ollama"
  | "cloudflare"
  | "mj"
  | "custom"
  | "ali"
  | "zhipu"
  | "volc"
  | "cohere"
  | "dify"
  | "coze"
  | "baidu";

export interface ChannelTypeInfo {
  id: number;
  name: string;
  kind: AdapterKind;
  base: string;
}
