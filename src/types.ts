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

export interface Env {
  DB: D1Database;
  KV?: KVNamespace;
  ASSETS?: AssetsBinding;
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
