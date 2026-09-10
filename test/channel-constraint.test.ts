import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANNEL_TYPE_ADVANCED_CUSTOM,
  CHANNEL_TYPE_JIMENG,
  CHANNEL_TYPE_KLING,
  CHANNEL_TYPE_OPENAI,
  CHANNEL_TYPE_TASK_PLUGIN,
} from "../src/constants.js";
import {
  FILTER_REQUEST_PATH,
  FILTER_TASK_PLUGIN_IDENTITY,
  PIN_RETRY_SINGLE_ATTEMPT,
  PIN_SOURCE_ORIGIN_TASK,
  PIN_SOURCE_TOKEN,
  channelSatisfiesFilters,
  distributorChannelFilters,
  filterCandidateIDs,
  originTaskChannelPin,
  resolvedPin,
  suppressesRetry,
  tokenChannelPin,
  type ChannelFilter,
  type ChannelFilterSubject,
} from "../src/channel-constraint.js";

function identityFilters(key: string, channelTypes?: number[]): ChannelFilter[] {
  return [{ kind: FILTER_TASK_PLUGIN_IDENTITY, taskPluginKey: key, taskPluginChannelTypes: channelTypes || [] }];
}

function ch(partial: ChannelFilterSubject & { id: number }): ChannelFilterSubject & { id: number } {
  return partial;
}

test("original ChannelSatisfiesFilters request_path then task_plugin_identity", () => {
  const alpha = ch({
    id: 1,
    type: CHANNEL_TYPE_TASK_PLUGIN,
    setting: JSON.stringify({ task_plugin_key: "alpha" }),
  });
  const ordinary = ch({ id: 2, type: CHANNEL_TYPE_OPENAI });
  const custom = ch({
    id: 3,
    type: CHANNEL_TYPE_ADVANCED_CUSTOM,
    settings: JSON.stringify({
      advanced_custom: {
        advanced_routes: [{ incoming_path: "/v1/chat/completions", models: ["gpt-4"] }],
      },
    }),
  });

  const nil = channelSatisfiesFilters(null, "gpt-4", []);
  assert.equal(nil.ok, false);
  assert.equal(nil.kind, "");

  const alphaOk = channelSatisfiesFilters(alpha, "shared", identityFilters("alpha"));
  assert.equal(alphaOk.ok, true);
  assert.equal(alphaOk.kind, "");

  const alphaMiss = channelSatisfiesFilters(alpha, "shared", identityFilters("beta"));
  assert.equal(alphaMiss.ok, false);
  assert.equal(alphaMiss.kind, FILTER_TASK_PLUGIN_IDENTITY);

  const ordinaryPath = channelSatisfiesFilters(ordinary, "gpt-4", [
    { kind: FILTER_REQUEST_PATH, requestPath: "/v1/chat/completions" },
  ]);
  assert.equal(ordinaryPath.ok, true);

  const customMiss = channelSatisfiesFilters(custom, "gpt-4", [
    { kind: FILTER_REQUEST_PATH, requestPath: "/v1/responses" },
  ]);
  assert.equal(customMiss.ok, false);
  assert.equal(customMiss.kind, FILTER_REQUEST_PATH);
});

test("original filterCandidateIDs identity and request_path order", () => {
  const alpha = ch({
    id: 900001,
    type: CHANNEL_TYPE_TASK_PLUGIN,
    setting: JSON.stringify({ task_plugin_key: "alpha" }),
  });
  const beta = ch({
    id: 900002,
    type: CHANNEL_TYPE_TASK_PLUGIN,
    setting: JSON.stringify({ task_plugin_key: "beta" }),
  });
  const ordinary = ch({ id: 900003, type: CHANNEL_TYPE_OPENAI });
  const kling = ch({ id: 900004, type: CHANNEL_TYPE_KLING });
  const jimeng = ch({ id: 900005, type: CHANNEL_TYPE_JIMENG });
  const matchingCustom = ch({
    id: 900010,
    type: CHANNEL_TYPE_ADVANCED_CUSTOM,
    settings: JSON.stringify({
      advanced_custom: {
        advanced_routes: [{ incoming_path: "/v1/chat/completions", models: ["gpt-4"] }],
      },
    }),
  });
  const otherCustom = ch({
    id: 900011,
    type: CHANNEL_TYPE_ADVANCED_CUSTOM,
    settings: JSON.stringify({
      advanced_custom: {
        advanced_routes: [{ incoming_path: "/v1/responses", models: ["gpt-4"] }],
      },
    }),
  });
  const channels = new Map<number, ChannelFilterSubject>([
    [900001, alpha],
    [900002, beta],
    [900003, ordinary],
    [900004, kling],
    [900005, jimeng],
    [900010, matchingCustom],
    [900011, otherCustom],
  ]);
  const pathFilter: ChannelFilter = { kind: FILTER_REQUEST_PATH, requestPath: "/v1/chat/completions" };
  const emptyPath: ChannelFilter = { kind: FILTER_REQUEST_PATH, requestPath: "" };

  const keepAlpha = filterCandidateIDs([900001, 900002], "shared", identityFilters("alpha"), channels);
  assert.deepEqual(keepAlpha.kept, [900001]);
  assert.equal(keepAlpha.emptiedBy, "");

  const emptyKeyDropsType61 = filterCandidateIDs([900001, 900002], "shared", identityFilters(""), channels);
  assert.deepEqual(emptyKeyDropsType61.kept, []);
  assert.equal(emptyKeyDropsType61.emptiedBy, FILTER_TASK_PLUGIN_IDENTITY);

  const emptyKeyKeepsOrdinary = filterCandidateIDs([900003], "ordinary", identityFilters(""), channels);
  assert.deepEqual(emptyKeyKeepsOrdinary.kept, [900003]);

  const legacy = filterCandidateIDs([900004, 900005], "legacy", identityFilters("legacy-alpha", [CHANNEL_TYPE_KLING]), channels);
  assert.deepEqual(legacy.kept, [900004]);

  const bothLegacy = filterCandidateIDs(
    [900004, 900005],
    "legacy",
    identityFilters("legacy-alpha", [CHANNEL_TYPE_KLING, CHANNEL_TYPE_JIMENG]),
    channels,
  );
  assert.deepEqual(bothLegacy.kept, [900004, 900005]);

  const keyedNoTypes = filterCandidateIDs([900004, 900005], "legacy", identityFilters("legacy-alpha"), channels);
  assert.deepEqual(keyedNoTypes.kept, []);
  assert.equal(keyedNoTypes.emptiedBy, FILTER_TASK_PLUGIN_IDENTITY);

  const missingIdentity = filterCandidateIDs(
    [900004, 999999],
    "legacy",
    identityFilters("legacy-alpha", [CHANNEL_TYPE_KLING]),
    channels,
  );
  assert.deepEqual(missingIdentity.kept, [900004]);

  const emptyPathPass = filterCandidateIDs([900003, 900010, 999999], "gpt-4", [emptyPath], channels);
  assert.deepEqual(emptyPathPass.kept, [900003, 900010, 999999]);

  const pathKeepsMissing = filterCandidateIDs([900003, 999999], "gpt-4", [pathFilter], channels);
  assert.deepEqual(pathKeepsMissing.kept, [900003, 999999]);

  const pathKeepsMatching = filterCandidateIDs([900003, 900010, 900011], "gpt-4", [pathFilter], channels);
  assert.deepEqual(pathKeepsMatching.kept, [900003, 900010]);

  const pathEmpty = filterCandidateIDs([900011], "gpt-4", [pathFilter], channels);
  assert.deepEqual(pathEmpty.kept, []);
  assert.equal(pathEmpty.emptiedBy, FILTER_REQUEST_PATH);

  const identityAfterPath = filterCandidateIDs(
    [900001, 900010],
    "gpt-4",
    [pathFilter, identityFilters("missing")[0]],
    channels,
  );
  assert.deepEqual(identityAfterPath.kept, []);
  assert.equal(identityAfterPath.emptiedBy, FILTER_TASK_PLUGIN_IDENTITY);

  const pathFirstEmpty = filterCandidateIDs(
    [900011],
    "gpt-4",
    [identityFilters("")[0], pathFilter],
    channels,
  );
  assert.deepEqual(pathFirstEmpty.kept, []);
  assert.equal(pathFirstEmpty.emptiedBy, FILTER_REQUEST_PATH);
});

test("original Distribute always adds request_path and task_plugin_identity filters", () => {
  const filters = distributorChannelFilters("/v1/chat/completions");
  assert.equal(filters[0].kind, FILTER_REQUEST_PATH);
  assert.equal(filters[0].requestPath, "/v1/chat/completions");
  assert.equal(filters[1].kind, FILTER_TASK_PLUGIN_IDENTITY);
  assert.equal(filters[1].taskPluginKey, "");
});

test("original ResolvedPin priority, merge, and SuppressesRetry", () => {
  const empty = resolvedPin(null);
  assert.equal(empty.found, false);
  assert.equal(empty.pin, null);
  assert.deepEqual(empty.overridden, []);
  assert.equal(suppressesRetry(null), false);

  const different = resolvedPin([
    originTaskChannelPin(10),
    tokenChannelPin(1),
  ]);
  assert.equal(different.found, true);
  assert.equal(different.pin?.channelId, 1);
  assert.equal(different.pin?.source, PIN_SOURCE_TOKEN);
  assert.equal(different.pin?.retryMode, PIN_RETRY_SINGLE_ATTEMPT);
  assert.equal(different.overridden.length, 1);
  assert.equal(different.overridden[0].source, PIN_SOURCE_ORIGIN_TASK);
  assert.equal(different.overridden[0].channelId, 10);
  assert.equal(suppressesRetry([originTaskChannelPin(10), tokenChannelPin(1)]), true);

  const same = resolvedPin([originTaskChannelPin(7), tokenChannelPin(7)]);
  assert.equal(same.found, true);
  assert.equal(same.pin?.channelId, 7);
  assert.equal(same.pin?.source, PIN_SOURCE_TOKEN);
  assert.equal(same.pin?.retryMode, PIN_RETRY_SINGLE_ATTEMPT);
  assert.deepEqual(same.overridden, []);
  assert.equal(suppressesRetry([originTaskChannelPin(7), tokenChannelPin(7)]), true);

  assert.equal(suppressesRetry([originTaskChannelPin(2)]), false);
});
