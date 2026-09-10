import assert from "node:assert/strict";
import { test } from "node:test";
import { channelInGroup, channelSupportsModel, ipAllowed, orderChannels, pickAbilityChannelId, pickWeighted } from "../src/select.js";
import type { ChannelRow } from "../src/types.js";

function ch(p: Partial<ChannelRow> & { id: number }): ChannelRow {
  return {
    type: 1,
    key: "k",
    status: 1,
    name: "n",
    weight: 1,
    created_time: 0,
    test_time: 0,
    response_time: 0,
    base_url: "",
    other: "",
    models: "gpt-4o,gpt-4o-mini",
    group: "default",
    used_quota: 0,
    model_mapping: "",
    status_code_mapping: "",
    priority: 0,
    auto_ban: 1,
    tag: "",
    header_override: "",
    param_override: "",
    remark: "",
    settings: "",
    openai_organization: "",
    test_model: "",
    ...p,
  };
}

test("channelSupportsModel", () => {
  assert.equal(channelSupportsModel({ models: "gpt-4o, gpt-4o-mini" }, "gpt-4o"), true);
  assert.equal(channelSupportsModel({ models: "gpt-4o" }, "claude"), false);
  assert.equal(channelSupportsModel({ models: "" }, "anything"), true);
});

test("channelInGroup", () => {
  assert.equal(channelInGroup({ group: "default,vip" }, "vip"), true);
  assert.equal(channelInGroup({ group: "vip" }, "default"), false);
});

test("pickWeighted respects weights", () => {
  const items = [
    { id: 1, weight: 9 },
    { id: 2, weight: 1 },
  ];
  assert.equal(pickWeighted(items, new Set(), () => 0), items[0]);
  assert.equal(pickWeighted(items, new Set(), () => 0.95), items[1]);
});

test("orderChannels sorts by priority then weight", () => {
  const ordered = orderChannels(
    [
      ch({ id: 1, priority: 1, weight: 1, name: "low" }),
      ch({ id: 2, priority: 10, weight: 1, name: "high" }),
    ],
    "gpt-4o",
    "default",
    () => 0,
  );
  assert.equal(ordered[0].id, 2);
  assert.equal(ordered[1].id, 1);
});

test("pickAbilityChannelId uses original GetChannel priority+weight+10", () => {
  const abilities = [
    { channel_id: 1, priority: 10, weight: 0 },
    { channel_id: 2, priority: 1, weight: 100 },
  ];
  assert.equal(pickAbilityChannelId(abilities, 0, () => 0), 1);
  assert.equal(pickAbilityChannelId(abilities, 1, () => 0), 2);
  assert.equal(pickAbilityChannelId(abilities, 9, () => 0), 2);
  assert.equal(pickAbilityChannelId([], 0), null);
});

test("ipAllowed", () => {
  assert.equal(ipAllowed("", "1.1.1.1"), true);
  assert.equal(ipAllowed("1.1.1.1", "1.1.1.1"), true);
  assert.equal(ipAllowed("10.0.0.0/8", "10.2.3.4"), true);
  assert.equal(ipAllowed("10.0.0.0/8", "11.0.0.1"), false);
});
