import assert from "node:assert/strict";
import { test } from "node:test";
import {
  billingSnapshotJSON,
  computeTieredQuotaWithRequest,
  evaluateTaskCompletionUsage,
  exprHashString,
  runExprWithRequest,
  type BillingSnapshot,
} from "../src/billing-expr.js";
import { BILLING_MODE_TIERED_EXPR, resolveTaskBillingExpr } from "../src/billing-setting.js";

test("original billingexpr task usage expression uses facts and task quota conversion JSON", () => {
  const expression = `tier("1080p", u("seconds") * (u("resolution") == "1080p" ? 0.4 : 0.2))`;
  const { cost, matchedTier } = runExprWithRequest(expression, { seconds: 10.0, resolution: "1080p" });
  assert.equal(cost, 4);
  assert.equal(matchedTier, "1080p");
  const result = computeTieredQuotaWithRequest(
    {
      billingMode: BILLING_MODE_TIERED_EXPR,
      modelName: "mock-v1",
      exprString: expression,
      exprHash: exprHashString(expression),
      groupRatio: 2,
      estimatedPromptTokens: 0,
      estimatedCompletionTokens: 0,
      estimatedQuotaBeforeGroup: 2_000_000,
      estimatedQuotaAfterGroup: 4_000_000,
      estimatedTier: "1080p",
      quotaPerUnit: 500000,
      exprVersion: 1,
      taskUsageBilling: true,
      usageFacts: { seconds: 10, resolution: "1080p" },
    },
    { seconds: 10.0, resolution: "1080p" },
  );
  assert.equal(result.actualQuotaAfterGroup, 4_000_000);
});

test("original EvaluateTaskCompletionUsage merges snapshot and completion facts JSON", () => {
  const expression = `tier("base", u("seconds") * 5)`;
  const snap: BillingSnapshot = {
    billingMode: BILLING_MODE_TIERED_EXPR,
    modelName: "mock-v1",
    exprString: expression,
    exprHash: exprHashString(expression),
    groupRatio: 1,
    estimatedPromptTokens: 0,
    estimatedCompletionTokens: 0,
    estimatedQuotaBeforeGroup: 2_500_000,
    estimatedQuotaAfterGroup: 2_500_000,
    estimatedTier: "base",
    quotaPerUnit: 500000,
    exprVersion: 1,
    taskUsageBilling: true,
    usageFacts: { seconds: 5, clips: 2 },
  };
  const settled = evaluateTaskCompletionUsage(snap, { seconds: 8 });
  assert.deepEqual(settled.usage, { seconds: 8, clips: 2 });
  assert.equal(settled.result.actualQuotaAfterGroup, 20_000_000);
  assert.equal(settled.result.matchedTier, "base");
  const json = billingSnapshotJSON(snap);
  assert.equal(json.billing_mode, "tiered_expr");
  assert.equal(json.task_usage_billing, true);
  assert.equal(json.estimated_tier, "base");
});

test("original ResolveTaskBillingExpr prefers plugin override JSON", () => {
  const plugin = resolveTaskBillingExpr("mock-http", "mock-v1", "mock-v1", {
    pluginExprs: { "mock-http::mock-v1": 'tier("plugin", u("seconds") * 1)' },
    modes: { "mock-v1": "ratio" },
    exprs: { "mock-v1": 'tier("model", u("seconds") * 9)' },
  });
  assert.equal(plugin.exists, true);
  assert.equal(plugin.expr, 'tier("plugin", u("seconds") * 1)');
  const mapped = resolveTaskBillingExpr("kling", "alias", "wan2.5", {
    pluginExprs: {},
    modes: { "wan2.5": "tiered_expr" },
    exprs: { "wan2.5": 'tier("720P", u("seconds") * 5)' },
  });
  assert.equal(mapped.exists, true);
  assert.equal(mapped.expr, 'tier("720P", u("seconds") * 5)');
});

test("original request probe integer ternary keeps % JSON", () => {
  const { cost, requestRules } = runExprWithRequest(
    `5 % (param("service_tier") == "fast" ? 2 : 1)`,
    {},
    {},
    { body: { service_tier: "fast" } },
  );
  assert.equal(cost, 1);
  assert.deepEqual(requestRules, [{ cond: `param("service_tier") == "fast"`, multiplier: 2, matched: true }]);
});
