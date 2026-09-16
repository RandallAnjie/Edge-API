import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultModelRatio } from "../src/ratio-defaults.js";
import {
  consumeLogModelName,
  hasPriceOrRatioEntry,
  modelPriceNotConfiguredMessage,
  resolveBillingModelName,
} from "../src/quota.js";
import { ROLE_ADMIN, ROLE_USER } from "../src/constants.js";
import { baseModelName, canonicalBillingModelNames } from "../src/reasoning.js";

const maps = { modelRatio: defaultModelRatio as Record<string, unknown>, modelPrice: {}, modes: {} };

test("original CanonicalBillingModelNames / resolveBillingModelName JSON", () => {
  const geminiOn = { geminiThinkingAdapterEnabled: true };

  assert.deepEqual(canonicalBillingModelNames("qwen3-max@thinking:on"), ["qwen3-max@thinking:on"]);
  assert.deepEqual(canonicalBillingModelNames("qwen3-max@temperature:0.2@thinking:on"), ["qwen3-max@thinking:on"]);
  assert.deepEqual(canonicalBillingModelNames("qwen3-max@thinking:on@temperature:0.2"), ["qwen3-max@thinking:on"]);
  assert.deepEqual(canonicalBillingModelNames("qwen3-max@thinking:8192"), ["qwen3-max@thinking:on"]);
  assert.deepEqual(canonicalBillingModelNames("qwen3-max@thinking:-1"), ["qwen3-max@thinking:on"]);
  assert.deepEqual(canonicalBillingModelNames("qwen3-max@thinking:adaptive"), ["qwen3-max@thinking:on"]);
  assert.deepEqual(canonicalBillingModelNames("qwen3-max@thinking:off"), ["qwen3-max@thinking:off"]);
  assert.deepEqual(canonicalBillingModelNames("qwen3-max@effort:none"), ["qwen3-max@thinking:off"]);
  assert.deepEqual(canonicalBillingModelNames("qwen3-max@effort:high"), [
    "qwen3-max@effort:high@thinking:on",
    "qwen3-max@thinking:on",
  ]);
  assert.deepEqual(canonicalBillingModelNames("qwen3-max@thinking:on@effort:high@temperature:0.2"), [
    "qwen3-max@effort:high@thinking:on",
    "qwen3-max@thinking:on",
  ]);
  assert.deepEqual(canonicalBillingModelNames("qwen3-max@thinking:off@thinking:on@effort:low@effort:high"), [
    "qwen3-max@effort:high@thinking:on",
    "qwen3-max@thinking:on",
  ]);
  assert.deepEqual(canonicalBillingModelNames("claude-3-7-sonnet-thinking"), ["claude-3-7-sonnet@thinking:on"]);
  assert.deepEqual(canonicalBillingModelNames("gemini-2.5-flash-thinking-8192", geminiOn), [
    "gemini-2.5-flash@thinking:on",
  ]);
  assert.deepEqual(canonicalBillingModelNames("claude-3-7-sonnet-nothinking"), ["claude-3-7-sonnet@thinking:off"]);
  assert.deepEqual(canonicalBillingModelNames("qwen3-max@temperature:0.7"), []);
  assert.deepEqual(
    canonicalBillingModelNames("gemini-2.5-flash@thinking:8192", geminiOn),
    canonicalBillingModelNames("gemini-2.5-flash-thinking-8192", geminiOn),
  );
  assert.equal(baseModelName("gpt-5.1-codex-max"), "gpt-5.1-codex-max");
  assert.deepEqual(canonicalBillingModelNames("gpt-5.1-codex-max"), []);
  assert.equal(baseModelName("qwen3-max@thinking:on@temperature:0.2"), "qwen3-max");

  const exempt = { thinkingModelBlacklist: ["re:.*@sha256:.*"] };
  assert.deepEqual(canonicalBillingModelNames("opaque@sha256:deadbeef", exempt), []);

  assert.equal(hasPriceOrRatioEntry("gpt-4o-mini", maps), true);
  assert.equal(hasPriceOrRatioEntry("fail-me", maps), false);
  assert.equal(hasPriceOrRatioEntry("gpt-6-astra", maps), true);
  assert.equal(hasPriceOrRatioEntry("openai/gpt-4o-mini", maps), false);

  assert.equal(resolveBillingModelName("gpt-4o-mini", maps), "gpt-4o-mini");
  assert.equal(resolveBillingModelName("fail-me", maps), "fail-me");
  assert.equal(resolveBillingModelName("openai/gpt-4o-mini", maps), "openai/gpt-4o-mini");
  assert.equal(resolveBillingModelName("gemini-2.5-flash@thinking:on", maps), "gemini-2.5-flash");
  assert.equal(resolveBillingModelName("gemini-2.5-flash-thinking-8192", maps), "gemini-2.5-flash-thinking-8192");
  assert.equal(resolveBillingModelName("claude-3-5-sonnet", maps), "claude-3-5-sonnet");
  assert.equal(resolveBillingModelName("claude-3-5-sonnet-20241022", maps), "claude-3-5-sonnet-20241022");

  assert.match(modelPriceNotConfiguredMessage("fail-me", ROLE_ADMIN), /Model fail-me price not configured/);
  assert.match(modelPriceNotConfiguredMessage("fail-me", ROLE_USER), /has not been priced by the administrator/);

  assert.equal(consumeLogModelName("gpt-4-gizmo-abc"), "gpt-4-gizmo-*");
  assert.equal(consumeLogModelName("gpt-4o-gizmo-xyz"), "gpt-4o-gizmo-*");
  assert.equal(consumeLogModelName("gemini-2.5-flash"), "gemini-2.5-flash");
});
