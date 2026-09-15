import assert from "node:assert/strict";
import { test } from "node:test";
import { applyChannelParamOverride, applyParamOverride, asParamOverrideReturnError, parseParamOverrideMap, setParamOverrideAuditDebugEnabled } from "../src/param-override.js";
import type { ChannelRow } from "../src/types.js";

function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

test("original ApplyParamOverride trim/set/delete/wildcard/return_error", () => {
  const trimmed = applyParamOverride(
    { model: "openai/gpt-4", temperature: 0.7 },
    { operations: [{ path: "model", mode: "trim_prefix", value: "openai/" }] },
  );
  assert.deepEqual(roundTrip(trimmed), { model: "gpt-4", temperature: 0.7 });

  const mixed = applyParamOverride(
    { model: "openai/gpt-4", temperature: 0.7 },
    {
      temperature: 0.2,
      top_p: 0.95,
      operations: [{ path: "model", mode: "trim_prefix", value: "openai/" }],
    },
  );
  assert.deepEqual(roundTrip(mixed), { model: "gpt-4", temperature: 0.2, top_p: 0.95 });

  const prefersOps = applyParamOverride(
    { model: "openai/gpt-4", temperature: 0.7 },
    {
      model: "legacy-model",
      temperature: 0.2,
      operations: [{ path: "model", mode: "set", value: "op-model" }],
    },
  );
  assert.deepEqual(roundTrip(prefersOps), { model: "op-model", temperature: 0.2 });

  assert.throws(() =>
    applyParamOverride({ model: "gpt-4" }, { operations: [{ path: "model", mode: "trim_prefix" }] }),
  );

  const replaced = applyParamOverride(
    { model: "openai/gpt-4o-mini", temperature: 0.7 },
    { operations: [{ path: "model", mode: "replace", from: "openai/", to: "" }] },
  );
  assert.deepEqual(roundTrip(replaced), { model: "gpt-4o-mini", temperature: 0.7 });

  const deleted = applyParamOverride({ model: "gpt-4", temperature: 0.7 }, { operations: [{ path: "temperature", mode: "delete" }] }) as Record<string, unknown>;
  assert.equal("temperature" in (deleted as object), false);

  const wildcard = applyParamOverride(
    {
      tools: [
        { type: "bash", custom: { input_examples: ["a"], other: 1 } },
        { type: "code", custom: { input_examples: ["b"] } },
        { type: "noop", custom: { other: 2 } },
      ],
    },
    { operations: [{ path: "tools.*.custom.input_examples", mode: "delete" }] },
  );
  assert.deepEqual(roundTrip(wildcard), {
    tools: [{ type: "bash", custom: { other: 1 } }, { type: "code", custom: {} }, { type: "noop", custom: { other: 2 } }],
  });

  const ctx = { retry: { index: 1, is_retry: true } };
  assert.throws(() => {
    applyParamOverride(
      { model: "gemini-2.5-pro" },
      {
        operations: [
          {
            mode: "return_error",
            value: {
              message: "forced bad request by param override",
              status_code: 422,
              code: "forced_bad_request",
              type: "invalid_request_error",
              skip_retry: true,
            },
            conditions: [{ path: "retry.is_retry", mode: "full", value: true }],
          },
        ],
      },
      ctx,
    );
  });
  try {
    applyParamOverride(
      { model: "gemini-2.5-pro" },
      {
        operations: [
          {
            mode: "return_error",
            value: {
              message: "forced bad request by param override",
              status_code: 422,
              code: "forced_bad_request",
              type: "invalid_request_error",
              skip_retry: true,
            },
            conditions: [{ path: "retry.is_retry", mode: "full", value: true }],
          },
        ],
      },
      ctx,
    );
  } catch (err) {
    const ret = asParamOverrideReturnError(err);
    assert.ok(ret);
    assert.equal(ret.statusCode, 422);
    assert.equal(ret.code, "forced_bad_request");
    assert.equal(ret.skipRetry, true);
    assert.equal(ret.message, "forced bad request by param override");
  }

  assert.deepEqual(
    parseParamOverrideMap(JSON.stringify({ operations: [{ path: "model", mode: "trim_prefix", value: "openai/" }] })),
    { operations: [{ path: "model", mode: "trim_prefix", value: "openai/" }] },
  );

  const headers: Record<string, string> = {};
  const channel = {
    name: "test-override",
    param_override: JSON.stringify({ operations: [{ path: "model", mode: "trim_prefix", value: "openai/" }] }),
    header_override: "",
  } as ChannelRow;
  const overridden = applyChannelParamOverride(channel, { model: "openai/gpt-4o-mini", max_tokens: 16 }, headers, {
    originalModel: "openai/gpt-4o-mini",
    upstreamModel: "openai/gpt-4o-mini",
    isChannelTest: true,
  });
  assert.equal((overridden as { model?: string }).model, "gpt-4o-mini");

  const skipped = applyParamOverride(
    { model: "gemini-2.5-pro" },
    {
      operations: [
        {
          mode: "return_error",
          value: { message: "forced bad request by param override" },
          conditions: [{ path: "retry.is_retry", mode: "full", value: true }],
        },
      ],
    },
    { retry: { index: 0, is_retry: false } },
  );
  assert.deepEqual(roundTrip(skipped), { model: "gemini-2.5-pro" });

  const skipHeaders: Record<string, string> = {};
  const skipChannel = {
    name: "skip-override",
    param_override: JSON.stringify({ operations: [{ path: "model", mode: "set", value: "should-not-apply" }] }),
    header_override: JSON.stringify({ "X-Skip": "nope" }),
  } as ChannelRow;
  const skipBody = { model: "gpt-4o", input: "hello" };
  const skippedApply = applyChannelParamOverride(skipChannel, skipBody, skipHeaders, { skipParamOverride: true });
  assert.equal(skippedApply, skipBody);
  assert.equal((skippedApply as { model?: string }).model, "gpt-4o");
  assert.equal(Object.keys(skipHeaders).length, 0);
});

test("original ApplyParamOverrideWithRelayInfo ParamOverrideAudit without debug", () => {
  setParamOverrideAuditDebugEnabled(false);
  try {
    const headers: Record<string, string> = {};
    const audit: string[] = [];
    const channel = {
      name: "audit-reasoning",
      param_override: JSON.stringify({
        operations: [{ mode: "set", path: "reasoning.effort", value: "max" }],
      }),
      header_override: "",
    } as ChannelRow;
    applyChannelParamOverride(
      channel,
      { reasoning: { effort: "high" } },
      headers,
      { paramOverrideAudit: audit },
    );
    assert.deepEqual(audit, ["set reasoning.effort = max"]);

    const tempAudit: string[] = [];
    applyChannelParamOverride(
      { name: "audit-temp", param_override: JSON.stringify({ temperature: 0.1 }), header_override: "" } as ChannelRow,
      { temperature: 0.7 },
      {},
      { paramOverrideAudit: tempAudit },
    );
    assert.deepEqual(tempAudit, []);

    const mixedAudit: string[] = [];
    applyChannelParamOverride(
      {
        name: "audit-mixed",
        param_override: JSON.stringify({
          operations: [
            { mode: "copy", from: "metadata.target_model", to: "model" },
            { mode: "set", path: "temperature", value: 0.1 },
          ],
        }),
        header_override: "",
      } as ChannelRow,
      { model: "gpt-4.1", temperature: 0.7, metadata: { target_model: "gpt-4.1-mini" } },
      {},
      { paramOverrideAudit: mixedAudit },
    );
    assert.deepEqual(mixedAudit, ["copy metadata.target_model -> model"]);
  } finally {
    setParamOverrideAuditDebugEnabled(false);
  }
});

test("original ApplyParamOverrideWithRelayInfo records temperature when debug enabled", () => {
  setParamOverrideAuditDebugEnabled(true);
  try {
    const audit: string[] = [];
    applyChannelParamOverride(
      {
        name: "audit-debug",
        param_override: JSON.stringify({
          operations: [
            { mode: "copy", from: "metadata.target_model", to: "model" },
            { mode: "set", path: "service_tier", value: "flex" },
            { mode: "set", path: "temperature", value: 0.1 },
          ],
        }),
        header_override: "",
      } as ChannelRow,
      { model: "gpt-4.1", temperature: 0.7, metadata: { target_model: "gpt-4.1-mini" } },
      {},
      { paramOverrideAudit: audit },
    );
    assert.deepEqual(audit, [
      "copy metadata.target_model -> model",
      "set service_tier = flex",
      "set temperature = 0.1",
    ]);
  } finally {
    setParamOverrideAuditDebugEnabled(false);
  }
});

