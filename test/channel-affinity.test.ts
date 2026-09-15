import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeChannelOverride, matchChannelAffinity, buildChannelAffinityKeyHint } from "../src/channel-affinity.js";
import { CHANNEL_AFFINITY_RULES } from "../src/option-defaults.js";
import { applyChannelParamOverride } from "../src/param-override.js";
import type { ChannelRow } from "../src/types.js";

test("original mergeChannelOverride keeps channel keys and prepends template operations", () => {
  const base = { temperature: 0.7, max_tokens: 2000 };
  const merged = mergeChannelOverride(base, { temperature: 0.2, top_p: 0.95 });
  assert.equal(merged.temperature, 0.7);
  assert.equal(merged.top_p, 0.95);
  assert.equal(merged.max_tokens, 2000);
  assert.equal(base.temperature, 0.7);

  const withOps = mergeChannelOverride(
    {
      temperature: 0.7,
      operations: [{ path: "model", mode: "trim_prefix", value: "openai/" }],
    },
    {
      operations: [{ mode: "pass_headers", value: ["Originator"] }],
    },
  );
  const ops = withOps.operations as { mode: string }[];
  assert.equal(ops.length, 2);
  assert.equal(ops[0].mode, "pass_headers");
  assert.equal(ops[1].mode, "trim_prefix");
});

test("original Codex CLI affinity rule matches prompt_cache_key on /v1/responses", () => {
  const match = matchChannelAffinity(CHANNEL_AFFINITY_RULES, {
    model: "gpt-5",
    path: "/v1/responses",
    usingGroup: "default",
    userAgent: "codex_cli_rs",
    headers: { originator: "codex_cli_rs" },
    body: { model: "gpt-5", prompt_cache_key: "sess-1" },
  });
  assert.ok(match);
  assert.equal(match.ruleName, "codex cli trace");
  assert.equal(match.skipRetryOnFailure, true);
  assert.match(match.cacheKeySuffix, /codex cli trace:default:sess-1/);
  const ops = (match.template.operations as { mode: string }[]) || [];
  assert.equal(ops[0]?.mode, "pass_headers");

  assert.equal(
    matchChannelAffinity(CHANNEL_AFFINITY_RULES, {
      model: "gpt-5",
      path: "/v1/responses",
      usingGroup: "default",
      userAgent: "",
      headers: {},
      body: { model: "gpt-5" },
    }),
    null,
  );
});

test("original affinity template pass_headers copies Originator onto outbound headers", () => {
  const match = matchChannelAffinity(CHANNEL_AFFINITY_RULES, {
    model: "gpt-5",
    path: "/v1/responses",
    usingGroup: "default",
    userAgent: "",
    headers: { originator: "codex_cli_rs", "session-id": "thread-1" },
    body: { prompt_cache_key: "sess-1" },
  });
  assert.ok(match);
  const headers: Record<string, string> = { authorization: "Bearer sk" };
  applyChannelParamOverride(
    { param_override: "", header_override: "" } as ChannelRow,
    { model: "gpt-5", prompt_cache_key: "sess-1" },
    headers,
    {
      requestHeaders: { originator: "codex_cli_rs", "session-id": "thread-1" },
      originalModel: "gpt-5",
      upstreamModel: "gpt-5",
      requestPath: "/v1/responses",
      affinityTemplate: match.template,
    },
  );
  assert.equal(headers.originator, "codex_cli_rs");
  assert.equal(headers["session-id"], "thread-1");
});

test("original affinity key hint and match metadata", () => {
  assert.equal(buildChannelAffinityKeyHint("sess-1"), "sess-1");
  assert.equal(buildChannelAffinityKeyHint("prompt-cache-key-value"), "prom...alue");
  const match = matchChannelAffinity(CHANNEL_AFFINITY_RULES, {
    model: "gpt-5",
    path: "/v1/responses",
    usingGroup: "default",
    userAgent: "",
    headers: {},
    body: { prompt_cache_key: "sess-1" },
  });
  assert.ok(match);
  assert.equal(match.keySourceType, "gjson");
  assert.equal(match.keySourcePath, "prompt_cache_key");
  assert.equal(match.affinityValue, "sess-1");
  assert.equal(match.skipRetryOnFailure, true);
});

