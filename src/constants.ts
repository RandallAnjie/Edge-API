export const VERSION = "edge-api/1.2.0 (new-api RandallFlare port)";
export const START_TIME = Date.now();

export const ROLE_GUEST = 0;
export const ROLE_USER = 1;
export const ROLE_ADMIN = 10;
export const ROLE_ROOT = 100;

export const USER_ENABLED = 1;
export const USER_DISABLED = 2;

export const TOKEN_ENABLED = 1;
export const TOKEN_DISABLED = 2;
export const TOKEN_EXPIRED = 3;
export const TOKEN_EXHAUSTED = 4;

export const CHANNEL_ENABLED = 1;
export const CHANNEL_MANUAL_DISABLED = 2;
export const CHANNEL_AUTO_DISABLED = 3;

export const REDEMPTION_ENABLED = 1;
export const REDEMPTION_DISABLED = 2;
export const REDEMPTION_USED = 3;

export const LOG_UNKNOWN = 0;
export const LOG_TOPUP = 1;
export const LOG_CONSUME = 2;
export const LOG_MANAGE = 3;
export const LOG_SYSTEM = 4;
export const LOG_ERROR = 5;
export const LOG_REFUND = 6;
export const LOG_LOGIN = 7;

export const DEFAULT_GROUP = "default";
export const ROOT_QUOTA = 100_000_000;
export const DEFAULT_TOKEN_QUOTA = 500_000;
export const AZURE_API_VERSION = "2025-04-01-preview";
export const CLAUDE_VERSION = "2023-06-01";
export const SESSION_TTL_SEC = 7 * 24 * 3600;
export const RATE_LIMIT_PER_MIN = 120;

export const DEFAULT_OPTIONS: Record<string, string> = {
  SystemName: "Edge API",
  Logo: "",
  Footer: "",
  Notice: "",
  About: "",
  HomePageContent: "",
  QuotaPerUnit: "500000",
  DisplayInCurrency: "true",
  RegisterEnabled: "true",
  PasswordLoginEnabled: "true",
  PasswordRegisterEnabled: "true",
  EmailVerificationEnabled: "false",
  GitHubOAuthEnabled: "false",
  GitHubClientId: "",
  GitHubClientSecret: "",
  QuotaForNewUser: "0",
  QuotaForInviter: "0",
  QuotaForInvitee: "0",
  CheckinEnabled: "true",
  CheckinQuota: "5000",
  RetryTimes: "3",
  ChannelDisableThreshold: "5",
  AutomaticDisableChannelEnabled: "false",
  AutomaticEnableChannelEnabled: "false",
  SelfUseModeEnabled: "true",
  DemoSiteEnabled: "false",
  GroupRatio: JSON.stringify({ default: 1 }),
  ModelRatio: JSON.stringify({}),
  CompletionRatio: JSON.stringify({}),
  DocsLink: "https://github.com/QuantumNous/new-api",
  ServerAddress: "",
  SessionSecret: "",
  DiscordOAuthEnabled: "false",
  DiscordClientId: "",
  DiscordClientSecret: "",
  LinuxDOOAuthEnabled: "false",
  LinuxDOClientId: "",
  LinuxDOClientSecret: "",
  OIDCAuthEnabled: "false",
  OIDCClientId: "",
  OIDCClientSecret: "",
  OIDCAuthorizationEndpoint: "",
  OIDCTokenEndpoint: "",
  OIDCUserinfoEndpoint: "",
  WeChatAuthEnabled: "false",
  TelegramOAuthEnabled: "false",
  PasskeyEnabled: "true",
  RankingsEnabled: "true",
  ExposeRatioEnabled: "false",
  UserAgreement: "",
  PrivacyPolicy: "",
  ResendApiKey: "",
  ResendFrom: "",
  StripeEnabled: "false",
  EpayEnabled: "false",
  CreemEnabled: "false",
  WaffoEnabled: "false",
  StripeApiSecret: "",
  StripeWebhookSecret: "",
  StripeUnitPrice: "8",
  EpayPid: "",
  EpayKey: "",
  EpayUrl: "",
  CreemApiKey: "",
  WaffoApiKey: "",
  WeChatServerAddress: "",
  WeChatServerToken: "",
  WeChatAccountQRCodeImageURL: "",
  TelegramBotName: "",
  TelegramBotToken: "",
  TurnstileCheckEnabled: "false",
  TurnstileSiteKey: "",
  LinuxDOMinimumTrustLevel: "0",
  BatchUpdateEnabled: "false",
  DrawingEnabled: "true",
  TaskEnabled: "true",
  DataExportEnabled: "true",
  DataExportDefaultTime: "hour",
  DefaultCollapseSidebar: "false",
  MjNotifyEnabled: "false",
  DefaultUseAutoGroup: "false",
  PasswordLoginEncryptionEnabled: "false",
  USDExchangeRate: "1",
  Price: "7.3",
  CustomCurrencySymbol: "$",
  CustomCurrencyExchangeRate: "1",
  Theme: "default",
  Chats: "[]",
  ApiInfoEnabled: "false",
  UptimeKumaEnabled: "false",
  AnnouncementsEnabled: "false",
  FAQEnabled: "false",
  MinTopup: "1",
  PaymentComplianceConfirmed: "false",
  IoNetApiKey: "",
};

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function dayStartSec(ts = nowSec()): number {
  const d = new Date(ts * 1000);
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export function parseBool(v: string | undefined | null, fallback = false): boolean {
  if (v == null || v === "") return fallback;
  return v === "true" || v === "1" || v === "TRUE";
}

export function parseJson<T>(raw: string, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function csv(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function csvHas(raw: string, item: string): boolean {
  const items = csv(raw);
  return items.length === 0 ? false : items.includes(item);
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function requestId(): string {
  return crypto.randomUUID();
}
