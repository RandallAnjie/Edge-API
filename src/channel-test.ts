import { CHANNEL_AUTO_DISABLED, CHANNEL_ENABLED, CHANNEL_MANUAL_DISABLED } from "./constants.js";
import { testChannel } from "./relay.js";
import type { Store } from "./store.js";
import type { ChannelRow } from "./types.js";

/** Original `controller.channelTestSummary`. */
export type ChannelTestSummary = {
  tested: number;
  succeeded: number;
  failed: number;
  disabled: number;
  enabled: number;
};

/** Original `controller.selectChannelsForAutomaticTest`. */
export function selectChannelsForAutomaticTest(channels: ChannelRow[], mode: string): ChannelRow[] {
  return channels.filter((ch) => {
    if (ch.status === CHANNEL_MANUAL_DISABLED) return false;
    if (mode === "auto_ban_only" && Number(ch.auto_ban ?? 1) !== 1) return false;
    if (mode === "passive_recovery" && ch.status !== CHANNEL_AUTO_DISABLED) return false;
    return true;
  });
}

/** Original `controller.runChannelTestTask` (manual TestAllChannels uses scheduled_all). */
export async function runChannelTestTask(store: Store, mode: string): Promise<ChannelTestSummary> {
  const selected = selectChannelsForAutomaticTest(await store.allChannels(), mode || "scheduled_all");
  const allowDisable = mode !== "passive_recovery";
  const summary: ChannelTestSummary = { tested: 0, succeeded: 0, failed: 0, disabled: 0, enabled: 0 };
  for (const ch of selected) {
    const wasEnabled = ch.status === CHANNEL_ENABLED;
    const result = await testChannel(store, ch);
    summary.tested++;
    if (result.success) {
      summary.succeeded++;
      if (!wasEnabled && ch.status === CHANNEL_AUTO_DISABLED) {
        await store.updateChannel(ch.id, { status: CHANNEL_ENABLED });
        summary.enabled++;
      }
    } else {
      summary.failed++;
      if (allowDisable && wasEnabled && Number(ch.auto_ban ?? 1) === 1) {
        await store.autoDisableChannel(ch.id);
        summary.disabled++;
      }
    }
  }
  return summary;
}
