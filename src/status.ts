import { START_TIME, VERSION, DEFAULT_HEADER_NAV_MODULES, DEFAULT_SIDEBAR_MODULES_ADMIN, parseJson } from "./constants.js";
import type { Store } from "./store.js";
import type { Env } from "./types.js";

export async function buildStatus(store: Store, env: Env): Promise<Record<string, unknown>> {
  const setup = await store.setupDone();
  const quotaPerUnit = await store.optionNum("QuotaPerUnit", 500000);
  const quotaDisplayType = (await store.option("general_setting.quota_display_type")) || "USD";
  const displayCurrency = quotaDisplayType !== "TOKENS";
  const agreement = await store.option("legal.user_agreement");
  const privacy = await store.option("legal.privacy_policy");
  const telegramBot = await store.option("TelegramBotName");
  const telegramToken = await store.option("TelegramBotToken");
  const telegramClient = await store.option("telegram.client_id");
  const telegramSecret = await store.option("telegram.client_secret");
  const wechatQr = await store.option("WeChatAccountQRCodeImageURL");
  const customProviders = ((await store.listOAuthProviders()) as Record<string, unknown>[]).filter(
    (p) => Number(p.enabled) === 1,
  );
  const apiInfoEnabled = await store.optionBool("console_setting.api_info_enabled", true);
  const announcementsEnabled = await store.optionBool("console_setting.announcements_enabled", true);
  const faqEnabled = await store.optionBool("console_setting.faq_enabled", true);
  const chats = parseJson(await store.option("Chats"), [] as unknown[]);
  const data: Record<string, unknown> = {
    version: VERSION,
    start_time: Math.floor(START_TIME / 1000),
    email_verification: await store.optionBool("EmailVerificationEnabled", false),
    github_oauth: await store.optionBool("GitHubOAuthEnabled", false),
    github_client_id: await store.option("GitHubClientId"),
    discord_oauth: await store.optionBool("discord.enabled", false),
    discord_client_id: await store.option("discord.client_id"),
    linuxdo_oauth: await store.optionBool("LinuxDOOAuthEnabled", false),
    linuxdo_client_id: await store.option("LinuxDOClientId"),
    linuxdo_minimum_trust_level: await store.optionNum("LinuxDOMinimumTrustLevel", 0),
    telegram_oauth: await store.optionBool("TelegramOAuthEnabled", false),
    telegram_oauth_configured: Boolean(telegramToken) || (Boolean(telegramClient) && Boolean(telegramSecret)),
    telegram_bot_name: telegramBot,
    theme: (await store.option("Theme")) || "default",
    system_name: env.SYSTEM_NAME || (await store.option("SystemName")) || "New API",
    logo: await store.option("Logo"),
    footer_html: await store.option("Footer"),
    wechat_qrcode: wechatQr,
    wechat_qr_code: wechatQr,
    wechat_qrcode_image_url: wechatQr,
    WeChatAccountQRCodeImageURL: wechatQr,
    wechat_login: await store.optionBool("WeChatAuthEnabled", false),
    server_address: await store.option("ServerAddress"),
    turnstile_check: await store.optionBool("TurnstileCheckEnabled", false),
    turnstile_site_key: await store.option("TurnstileSiteKey"),
    docs_link: (await store.option("general_setting.docs_link")) || "https://docs.newapi.pro",
    quota_per_unit: quotaPerUnit,
    display_in_currency: displayCurrency,
    quota_display_type: quotaDisplayType,
    custom_currency_symbol: (await store.option("general_setting.custom_currency_symbol")) || "¤",
    custom_currency_exchange_rate: await store.optionNum("general_setting.custom_currency_exchange_rate", 1),
    enable_batch_update: await store.optionBool("BatchUpdateEnabled", false),
    enable_drawing: await store.optionBool("DrawingEnabled", true),
    enable_task: await store.optionBool("TaskEnabled", true),
    enable_data_export: await store.optionBool("DataExportEnabled", true),
    data_export_default_time: (await store.option("DataExportDefaultTime")) || "hour",
    default_collapse_sidebar: await store.optionBool("DefaultCollapseSidebar", false),
    mj_notify_enabled: await store.optionBool("MjNotifyEnabled", false),
    chats,
    demo_site_enabled: await store.optionBool("DemoSiteEnabled", false),
    self_use_mode_enabled: await store.optionBool("SelfUseModeEnabled", false),
    register_enabled: await store.optionBool("RegisterEnabled", true),
    password_login_enabled: await store.optionBool("PasswordLoginEnabled", true),
    password_register_enabled: await store.optionBool("PasswordRegisterEnabled", true),
    default_use_auto_group: await store.optionBool("DefaultUseAutoGroup", false),
    password_login_encryption_enabled: await store.optionBool("PasswordLoginEncryptionEnabled", false),
    usd_exchange_rate: await store.optionNum("USDExchangeRate", 1),
    price: await store.optionNum("Price", 7.3),
    stripe_unit_price: await store.optionNum("StripeUnitPrice", 8),
    api_info_enabled: apiInfoEnabled,
    uptime_kuma_enabled: await store.optionBool("console_setting.uptime_kuma_enabled", true),
    announcements_enabled: announcementsEnabled,
    faq_enabled: faqEnabled,
    HeaderNavModules: (await store.option("HeaderNavModules")) || DEFAULT_HEADER_NAV_MODULES,
    SidebarModulesAdmin: (await store.option("SidebarModulesAdmin")) || DEFAULT_SIDEBAR_MODULES_ADMIN,
    oidc_enabled: await store.optionBool("oidc.enabled", false),
    oidc_auth: await store.optionBool("oidc.enabled", false),
    oidc_client_id: await store.option("oidc.client_id"),
    oidc_authorization_endpoint: await store.option("oidc.authorization_endpoint"),
    oidc_display_name: (await store.option("oidc.display_name")) || "OIDC",
    passkey_login: await store.optionBool("passkey.enabled", false),
    passkey: await store.optionBool("passkey.enabled", false),
    passkey_display_name:
      (await store.option("passkey.rp_display_name")) || env.SYSTEM_NAME || (await store.option("SystemName")) || "New API",
    passkey_rp_id: await store.option("passkey.rp_id"),
    passkey_origins: await store.option("passkey.origins"),
    passkey_allow_insecure: await store.optionBool("passkey.allow_insecure_origin", false),
    passkey_user_verification: (await store.option("passkey.user_verification")) || "preferred",
    passkey_attachment: await store.option("passkey.attachment_preference"),
    setup,
    display_token_stat_enabled: await store.optionBool("DisplayTokenStatEnabled", true),
    oauth_register_enabled: await store.optionBool("RegisterEnabled", true),
    user_agreement_enabled: Boolean(agreement),
    privacy_policy_enabled: Boolean(privacy),
    checkin_enabled: await store.optionBool("checkin_setting.enabled", false),
    rankings_enabled: await store.optionBool("RankingsEnabled", true),
    notice: await store.option("Notice"),
    about: await store.option("About"),
    home_page_content: await store.option("HomePageContent"),
    runtime: "randallflare-workerd",
    original_project: "https://github.com/QuantumNous/new-api",
  };
  if (apiInfoEnabled) data.api_info = parseJson(await store.option("ApiInfo"), []);
  if (announcementsEnabled) data.announcements = parseJson(await store.option("Announcements"), []);
  if (faqEnabled) data.faq = parseJson(await store.option("FAQ"), []);
  if (customProviders.length) {
    data.custom_oauth_providers = customProviders.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      icon: p.icon || "",
      client_id: p.client_id,
      authorization_endpoint: p.auth_url,
      scopes: p.scopes,
    }));
  }
  return data;
}
