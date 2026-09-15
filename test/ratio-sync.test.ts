import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BILLING_MODE_TIERED_EXPR,
  buildDifferences,
  convertModelsDevToRatioData,
  convertOpenRouterToRatioData,
} from "../src/ratio-sync.js";
import { USD } from "../src/ratio-defaults.js";

test("original ratio_setting USD constant", () => {
  assert.equal(USD, 500);
});

test("original FetchUpstreamRatios difference confidence and expression priority", () => {
  const expression = `tier("base", p * 2 + c * 8 + cr * 0)`;
  const cases: { name: string; local: Record<string, unknown>; source: Record<string, unknown>; want: string[] }[] = [
    {
      name: "equal expressions suppress stale ratios",
      local: { billing_mode: { m: "tiered_expr" }, billing_expr: { m: expression } },
      source: {
        billing_mode: { m: "tiered_expr" },
        billing_expr: { m: expression },
        model_ratio: { m: 3 },
        model_price: { m: 2 },
      },
      want: [],
    },
    {
      name: "local expression excludes legacy-only source",
      local: { billing_mode: { m: "tiered_expr" }, billing_expr: { m: expression } },
      source: { model_ratio: { m: 3 }, completion_ratio: { m: 2 } },
      want: [],
    },
    {
      name: "expression imports without legacy conflicts",
      local: { model_ratio: { m: 1 } },
      source: {
        billing_mode: { m: "tiered_expr" },
        billing_expr: { m: expression },
        model_ratio: { m: 3 },
        model_price: { m: 2 },
      },
      want: ["billing_mode", "billing_expr"],
    },
    {
      name: "inactive expression follows explicit ratio mode",
      local: { model_ratio: { m: 1 } },
      source: { billing_mode: { m: "ratio" }, billing_expr: { m: expression }, model_ratio: { m: 3 } },
      want: ["model_ratio"],
    },
    {
      name: "empty active expression never imports a false free price",
      local: {},
      source: { billing_mode: { m: "tiered_expr" }, billing_expr: { m: " " }, model_ratio: { m: 0 } },
      want: [],
    },
  ];
  for (const tt of cases) {
    const diff = buildDifferences(tt.local, [{ name: "source", data: tt.source }]);
    assert.deepEqual(Object.keys(diff.m || {}).sort(), [...tt.want].sort(), tt.name);
  }

  const untrusted = buildDifferences(
    { model_ratio: { "gpt-4.5-preview": 15 }, completion_ratio: { "gpt-4.5-preview": 2 } },
    [
      {
        name: "upstream",
        data: { model_ratio: { "gpt-4.5-preview": 37.5 }, completion_ratio: { "gpt-4.5-preview": 1 } },
      },
    ],
  );
  const item = untrusted["gpt-4.5-preview"].model_ratio;
  assert.equal(item.confidence.upstream, false);
  assert.equal(item.upstreams.upstream, 37.5);
  assert.equal(item.current, 15);
});

test("original OpenRouter and models.dev ratio conversion", () => {
  const open = convertOpenRouterToRatioData({
    data: [
      { id: "or/free", pricing: { prompt: "0", completion: "0" } },
      { id: "or/paid", pricing: { prompt: "0.000002", completion: "0.000004", input_cache_read: "0.000001" } },
    ],
  });
  assert.equal((open.model_ratio as Record<string, number>)["or/free"], 0);
  assert.equal((open.model_ratio as Record<string, number>)["or/paid"], round6(0.000002 * 1000 * USD));
  assert.equal((open.completion_ratio as Record<string, number>)["or/paid"], 2);
  assert.equal((open.cache_ratio as Record<string, number>)["or/paid"], 0.5);

  const models = convertModelsDevToRatioData({
    openai: { models: { "gpt-x": { cost: { input: 2, output: 4, cache_read: 0.2 } } } },
    cheaper: { models: { "gpt-x": { cost: { input: 1, output: 3, cache_read: 0.1 } } } },
  });
  assert.equal((models.model_ratio as Record<string, number>)["gpt-x"], round6((1 * USD) / 1000));
  assert.equal((models.completion_ratio as Record<string, number>)["gpt-x"], 3);
  assert.equal((models.cache_ratio as Record<string, number>)["gpt-x"], 0.1);
  assert.equal(BILLING_MODE_TIERED_EXPR, "tiered_expr");
});

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
