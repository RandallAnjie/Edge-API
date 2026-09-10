import assert from "node:assert/strict";
import { test } from "node:test";
import { applyParamOverride, asParamOverrideReturnError } from "../src/param-override.js";

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
});
