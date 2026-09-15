import { LOG_SYSTEM, ROLE_ADMIN, ROLE_ROOT } from "./constants.js";
import { paymentComplianceConfirmed } from "./payments.js";
import { storeLogQuota } from "./quota.js";
import type { Store } from "./store.js";

/** Original `common.Marshal` of a Go map: compact JSON with sorted keys. */
function goMapJSON(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const item = value[key];
    const encoded =
      item && typeof item === "object" && !Array.isArray(item)
        ? goMapJSON(item as Record<string, unknown>)
        : JSON.stringify(item);
    parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(",")}}`;
}

/** Original `model.generateDefaultSidebarConfigForRole`. */
export function generateDefaultSidebarConfigForRole(role: number): string {
  const defaultConfig: Record<string, unknown> = {
    chat: { enabled: true, playground: true, chat: true },
    console: { enabled: true, detail: true, token: true, log: true, midjourney: true, task: true },
    personal: { enabled: true, topup: true, personal: true },
  };
  if (role === ROLE_ADMIN) {
    defaultConfig.admin = {
      enabled: true,
      channel: true,
      models: true,
      redemption: true,
      user: true,
      setting: false,
    };
  } else if (role === ROLE_ROOT) {
    defaultConfig.admin = {
      enabled: true,
      channel: true,
      models: true,
      redemption: true,
      user: true,
      setting: true,
    };
  }
  return goMapJSON(defaultConfig);
}

async function recordSystemLog(store: Store, userId: number, username: string, content: string): Promise<void> {
  await store.insertLog({ user_id: userId, username, type: LOG_SYSTEM, content });
}

/**
 * Original `model.User.finishInsert` / `FinishInsert`.
 * Admin CreateUser and OAuth FinalizeOAuthUserCreation call this with inviterId 0 unless an affiliate is present.
 */
export async function finishInsertUser(store: Store, userId: number, inviterId = 0): Promise<void> {
  const user = await store.getUserById(userId);
  if (!user) return;
  const sidebar = generateDefaultSidebarConfigForRole(user.role);
  if (sidebar) {
    await store.updateUser(userId, {
      settings: JSON.stringify({ gotify_priority: 0, sidebar_modules: sidebar }),
    });
  }
  const newUserQuota = await store.optionNum("QuotaForNewUser", 0);
  if (newUserQuota > 0) {
    await recordSystemLog(store, userId, user.username, `新用户注册赠送 ${await storeLogQuota(store, newUserQuota)}`);
  }
  if (!inviterId || !(await paymentComplianceConfirmed(store))) return;
  const inviteeQuota = await store.optionNum("QuotaForInvitee", 0);
  if (inviteeQuota > 0) {
    await store.addQuota(userId, inviteeQuota);
    await recordSystemLog(store, userId, user.username, `使用邀请码赠送 ${await storeLogQuota(store, inviteeQuota)}`);
  }
  const inviterQuota = await store.optionNum("QuotaForInviter", 0);
  if (inviterQuota > 0) {
    const inviter = await store.getUserById(inviterId);
    await recordSystemLog(
      store,
      inviterId,
      inviter?.username || "",
      `邀请用户赠送 ${await storeLogQuota(store, inviterQuota)}`,
    );
    await store.inviteUser(inviterId);
  }
}
