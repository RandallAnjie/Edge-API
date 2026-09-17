import type { Store } from "../src/store.js";

/** Merge extras into persisted ModelRatio without wiping original defaults. */
export async function mergeModelRatio(store: Store, extras: Record<string, number>): Promise<void> {
  const ratios = JSON.parse((await store.option("ModelRatio")) || "{}") as Record<string, number>;
  await store.setOption("ModelRatio", JSON.stringify({ ...ratios, ...extras }));
}
