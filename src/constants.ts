import { DEFAULT_MARKETPLACE_SOURCES, NESTED_OPTION_DEFAULTS } from "./option-defaults.js";
import {
  DEFAULT_AUDIO_COMPLETION_RATIO_JSON,
  DEFAULT_AUDIO_RATIO_JSON,
  DEFAULT_CACHE_RATIO_JSON,
  DEFAULT_COMPLETION_RATIO_JSON,
  DEFAULT_CREATE_CACHE_RATIO_JSON,
  DEFAULT_IMAGE_RATIO_JSON,
  DEFAULT_MODEL_PRICE_JSON,
  DEFAULT_MODEL_RATIO_JSON,
} from "./ratio-defaults.js";

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
export const ACCESS_TOKEN_TTL_SEC = 15 * 60;
export const SECURITY_PROOF_TTL_SEC = 60;
export const SESSION_TTL_SEC = 30 * 24 * 3600;
export const REFRESH_REPLAY_WINDOW_SEC = 30;
export const USER_SESSION_ACTIVE_LIMIT = 50;
export const USER_SESSION_ISSUANCE_LIMIT = 100;
export const USER_SESSION_ISSUANCE_WINDOW_SEC = 24 * 60 * 60;
export const RATE_LIMIT_PER_MIN = 120;

/** Original `setting/ratio_setting.defaultGroupRatio`. */
export const DEFAULT_GROUP_RATIO: Record<string, number> = { default: 1, vip: 1, svip: 1 };

export const DEFAULT_HEADER_NAV_MODULES = JSON.stringify({
  home: true,
  console: true,
  pricing: { enabled: true, requireAuth: false },
  rankings: { enabled: true, requireAuth: false },
  docs: true,
  about: true,
});

export const DEFAULT_SIDEBAR_MODULES_ADMIN = JSON.stringify({
  chat: { enabled: true, playground: true, chat: true },
  console: { enabled: true, detail: true, token: true, log: true, audit: true, midjourney: true, task: true },
  personal: { enabled: true, topup: true, personal: true, security: true },
  admin: {
    enabled: true,
    channel: true,
    models: true,
    redemption: true,
    user: true,
    setting: true,
    subscription: true,
  },
});

export const DEFAULT_OPTIONS: Record<string, string> = {
  ...NESTED_OPTION_DEFAULTS,
  SystemName: "New API",
  Logo: "",
  Footer: "",
  Notice: "",
  About: "",
  HomePageContent: "",
  QuotaPerUnit: "500000",
  DisplayInCurrency: "true",
  DisplayInCurrencyEnabled: "true",
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
  QuotaRemindThreshold: "1000",
  PreConsumedQuota: "500",
  CheckinEnabled: "false",
  CheckinQuota: "5000",
  CheckinMinQuota: "1000",
  CheckinMaxQuota: "10000",
  DisplayTokenStatEnabled: "true",
  RetryTimes: "0",
  ChannelDisableThreshold: "5",
  AutomaticDisableChannelEnabled: "false",
  AutomaticEnableChannelEnabled: "false",
  SelfUseModeEnabled: "false",
  DemoSiteEnabled: "false",
  FileUploadPermission: "0",
  FileDownloadPermission: "0",
  ImageUploadPermission: "0",
  ImageDownloadPermission: "0",
  LogConsumeEnabled: "true",
  EmailDomainRestrictionEnabled: "false",
  EmailAliasRestrictionEnabled: "false",
  EmailDomainWhitelist: "gmail.com,163.com,126.com,qq.com,outlook.com,hotmail.com,icloud.com,yahoo.com,foxmail.com",
  SMTPServer: "",
  SMTPFrom: "",
  SMTPPort: "587",
  SMTPAccount: "",
  SMTPSSLEnabled: "false",
  SMTPStartTLSEnabled: "false",
  SMTPInsecureSkipVerify: "false",
  SMTPForceAuthLogin: "false",
  TaskPublicAddress: "",
  WorkerUrl: "",
  WorkerAllowHttpImageRequestEnabled: "false",
  CustomCallbackAddress: "",
  EpayId: "",
  TaskPluginEnabled: "true",
  HeaderNavModules: DEFAULT_HEADER_NAV_MODULES,
  SidebarModulesAdmin: DEFAULT_SIDEBAR_MODULES_ADMIN,
  DataExportInterval: "5",
  ModelPrice: DEFAULT_MODEL_PRICE_JSON,
  CacheRatio: DEFAULT_CACHE_RATIO_JSON,
  CreateCacheRatio: DEFAULT_CREATE_CACHE_RATIO_JSON,
  ImageRatio: DEFAULT_IMAGE_RATIO_JSON,
  AudioRatio: DEFAULT_AUDIO_RATIO_JSON,
  AudioCompletionRatio: DEFAULT_AUDIO_COMPLETION_RATIO_JSON,
  TopupGroupRatio: "{}",
  MjAccountFilterEnabled: "false",
  MjModeClearEnabled: "false",
  MjForwardUrlEnabled: "false",
  MjActionCheckSuccessEnabled: "false",
  CheckSensitiveEnabled: "false",
  CheckSensitiveOnPromptEnabled: "false",
  StopOnSensitiveEnabled: "false",
  SensitiveWords: "",
  StreamCacheQueueLength: "0",
  AutomaticDisableKeywords: "",
  AutomaticDisableStatusCodes: "",
  AutomaticRetryStatusCodes: "",
  ModelRequestRateLimitEnabled: "false",
  ModelRequestRateLimitCount: "0",
  ModelRequestRateLimitDurationMinutes: "1",
  ModelRequestRateLimitSuccessCount: "0",
  ModelRequestRateLimitGroup: "{}",
  CreemProducts: "",
  CreemTestMode: "false",
  WaffoMerchantId: "",
  WaffoNotifyUrl: "",
  WaffoReturnUrl: "",
  WaffoSubscriptionReturnUrl: "",
  WaffoCurrency: "CNY",
  WaffoUnitPrice: "8",
  WaffoPayMethods: "[]",
  WaffoPancakeReturnURL: "",
  WaffoPancakeUnitPrice: "8",
  WaffoPancakeStoreID: "",
  GroupRatio: JSON.stringify(DEFAULT_GROUP_RATIO),
  ModelRatio: DEFAULT_MODEL_RATIO_JSON,
  CompletionRatio: DEFAULT_COMPLETION_RATIO_JSON,
  DocsLink: "https://docs.newapi.pro",
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
  PasskeyEnabled: "false",
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
  StripePriceId: "",
  StripeUnitPrice: "8",
  StripePromotionCodesEnabled: "false",
  EpayPid: "",
  EpayKey: "",
  EpayUrl: "",
  PayAddress: "",
  CreemApiKey: "",
  WaffoApiKey: "",
  WaffoPrivateKey: "",
  WaffoPublicCert: "",
  WaffoSandbox: "false",
  WaffoSandboxApiKey: "",
  WaffoSandboxPrivateKey: "",
  WaffoSandboxPublicCert: "",
  WaffoPancakeMerchantID: "",
  WaffoPancakePrivateKey: "",
  WaffoPancakeProductID: "",
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
  CustomCurrencySymbol: "¤",
  CustomCurrencyExchangeRate: "1",
  Theme: "default",
  Chats: "[]",
  ApiInfoEnabled: "true",
  UptimeKumaEnabled: "true",
  AnnouncementsEnabled: "true",
  FAQEnabled: "true",
  TaskPluginMarketplaceSources: JSON.stringify(DEFAULT_MARKETPLACE_SOURCES),
  TaskPluginDisabledFactoryKeys: "[]",
  MinTopup: "1",
  MinTopUp: "1",
  PaymentComplianceConfirmed: "false",
  PaymentComplianceTermsVersion: "v1",
  TopUpLink: "",
  AmountOptions: JSON.stringify([10, 20, 50, 100, 200, 500]),
  AmountDiscount: "{}",
  PayMethods: JSON.stringify([
    { name: "支付宝", icon: "SiAlipay", type: "alipay" },
    { name: "微信", icon: "SiWechat", type: "wxpay" },
    { name: "自定义1", icon: "LuCreditCard", type: "custom1", min_topup: "50" },
  ]),
  UserUsableGroups: JSON.stringify({ default: "默认分组", vip: "vip分组" }),
  AutoGroups: JSON.stringify(["default"]),
  MaxTokenAutoGroups: "5",
  GroupSpecialUsableGroup: "{}",
  GroupGroupRatio: JSON.stringify({ vip: { edit_this: 0.9 } }),
  StripeMinTopUp: "1",
  WaffoMinTopUp: "1",
  WaffoPancakeMinTopUp: "1",
  WaffoPancakeEnabled: "false",
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

/** Original `pkg/perfmetrics.seriesSchema`. Do not change; the console caches on this marker. */
export const PERF_SERIES_SCHEMA = "dbcd0a3c01b55203";

/** Go `time.Time{}` JSON (`encoding/json`). */
export const GO_ZERO_TIME = "0001-01-01T00:00:00Z";

/** Original quota_data buckets are hour-aligned (`createdAt - createdAt % 3600`). */
export function hourStartSec(ts = nowSec()): number {
  return ts - (ts % 3600);
}

export function parseBool(v: string | undefined | null, fallback = false): boolean {
  if (v == null || v === "") return fallback;
  return v === "true" || v === "1" || v === "TRUE";
}

/** Original `strconv.ParseBool`; invalid values keep `fallback`. */
export function parseGoBool(v: string | undefined | null, fallback = false): boolean {
  if (v == null || v === "") return fallback;
  const s = v.trim();
  if (/^(1|t|true)$/i.test(s)) return true;
  if (/^(0|f|false)$/i.test(s)) return false;
  return fallback;
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
