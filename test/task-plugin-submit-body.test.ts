import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_SORA } from "../src/constants.js";
import { compilePlugin } from "../src/jsplugin.js";
import { encodeMultipartForm, parseMultipartForm } from "../src/multipart-form.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import {
  encodeNativeSubmitBody,
  formatMediaType,
  inlineJSONFilePlaceholders,
  maxInlineFileBytes,
  type NativeSubmitFile,
} from "../src/task-plugin-submit-body.js";
import { BODY_MULTIPART, buildTaskPluginRouteRequestFromParts } from "../src/task-plugin-route.js";
import { buildNativeSubmitContext, buildNativeSubmitDescriptor } from "../src/task-plugin-submit.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

async function json(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { res, body, text };
}

async function boot() {
  resetSchemaFlag();
  const e: Env = { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test" };
  await json(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12", confirmPassword: "password12" }),
    }),
    e,
  );
  const login = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  const token = (login.body.data as { access_token: string }).access_token;
  const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
  const store = new Store(e.DB);
  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "multipart-submit", unlimited_quota: true, group: "default" }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;
  return { e, auth, store, sk };
}

function latin1(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bodyBytes(init?: RequestInit): Uint8Array {
  const body = init?.body;
  if (body == null) return new Uint8Array();
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return new Uint8Array();
}

const pngFile = (bytes = "image-bytes", mimeType = "image/png"): NativeSubmitFile => ({
  field: "input_reference",
  filename: "ref.png",
  mimeType,
  data: new TextEncoder().encode(bytes),
});

test("original mime.FormatMediaType form-data disposition JSON", () => {
  assert.equal(formatMediaType("form-data", { name: "model" }), "form-data; name=model");
  assert.equal(
    formatMediaType("form-data", { name: "prompt\r\nX-Injected: yes" }),
    "form-data; name*=utf-8''prompt%0D%0AX-Injected%3A%20yes",
  );
  assert.equal(
    formatMediaType("form-data", { name: "input_reference", filename: "safe.png\r\nX-Injected: yes" }),
    "form-data; filename*=utf-8''safe.png%0D%0AX-Injected%3A%20yes; name=input_reference",
  );
  assert.equal(formatMediaType("form-data", { name: "" }), 'form-data; name=""');
  assert.equal(formatMediaType("form-data", { name: "a b" }), 'form-data; name="a b"');
  assert.equal(formatMediaType("form-data", { name: "你好" }), "form-data; name*=utf-8''%E4%BD%A0%E5%A5%BD");
  assert.equal(formatMediaType("form-data", { name: "ok", filename: "ref.png" }), "form-data; filename=ref.png; name=ok");
  assert.equal(formatMediaType("form-data", { name: 'quote"name' }), 'form-data; name="quote\\"name"');
});

test("original TaskAdaptorBuildsMultipartFromOpaqueFileReference JSON", () => {
  const source = `
export const meta = {apiVersion:1,key:"multipart",name:"Multipart",version:"1.0.0",author:{name:"Test"},models:["m"],fetchMode:"per_task"};
export function buildSubmitRequest(ctx) { return {url:ctx.baseUrl+"/submit",bodyType:"multipart",parts:[{name:"model",value:"m"},{name:"input_reference",fileRef:ctx.files[0].ref}]}; }
export function parseSubmitResponse(ctx,r){return {taskId:"1"}} export function buildQueryRequest(){return {url:"https://example.com"}} export function parseTaskResult(){return {status:"SUCCESS"}}
`;
  const loaded = compilePlugin(source, { key: "multipart", version: "1.0.0" });
  const files = [{ ref: "request_file:input_reference", field: "input_reference", filename: "ref.png", mimeType: "image/png", size: 11 }];
  const submitContext = buildNativeSubmitContext({
    engine: loaded.engine,
    requestContext: {
      path: "/v1/videos",
      method: "POST",
      params: {},
      query: {},
      body: { kind: BODY_MULTIPART, fields: {}, files },
      files,
      requestBody: { prompt: "p" },
    },
    requestBody: { prompt: "p" },
    req: new Request("http://local/v1/videos", { method: "POST", headers: { "content-type": "multipart/form-data" } }),
    info: {
      originModelName: "m",
      upstreamModelName: "m",
      action: "image_to_video",
      publicTaskId: "task_public",
      apiKey: "sk-test",
      channelBaseUrl: "https://provider.example",
      channelId: 1,
      channelType: 1,
      usingGroup: "default",
      isModelMapped: false,
    },
  });
  const descriptor = buildNativeSubmitDescriptor(loaded.engine, submitContext, "https://provider.example");
  assert.equal("statusCode" in descriptor, false);
  if ("statusCode" in descriptor) return;
  assert.equal(descriptor.bodyType, "multipart");
  assert.deepEqual(descriptor.parts, [
    { name: "model", value: "m", fileRef: "", filename: "" },
    { name: "input_reference", value: undefined, fileRef: "request_file:input_reference", filename: "" },
  ]);
  const encoded = encodeNativeSubmitBody(descriptor, [pngFile()]);
  assert.match(String(encoded.contentType), /^multipart\/form-data; boundary=/);
  const parsed = parseMultipartForm(toArrayBuffer(encoded.body as Uint8Array), encoded.contentType || "");
  assert.deepEqual(parsed.values.model, ["m"]);
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].name, "input_reference");
  assert.equal(new TextDecoder().decode(parsed.files[0].data), "image-bytes");
});

test("original TaskAdaptorInlinesJSONFilePlaceholders JSON", () => {
  const fileBytes = "image-bytes";
  const encoded = Buffer.from(fileBytes).toString("base64");
  const body = {
    prompt: "p",
    image: { __fileRef: "request_file:input_reference", encoding: "base64" },
    nested: { items: [{ __fileRef: "request_file:input_reference", encoding: "dataUrl", mimeType: "image/png" }] },
    dataUrl: { __fileRef: "request_file:input_reference", encoding: "dataUrl" },
  };
  const file: NativeSubmitFile = { field: "input_reference", filename: "ref.png", mimeType: "image/jpeg", data: new TextEncoder().encode(fileBytes) };
  const inlined = inlineJSONFilePlaceholders(body, [file]) as Record<string, unknown>;
  assert.equal(inlined.prompt, "p");
  assert.equal(inlined.image, encoded);
  const nested = inlined.nested as { items: unknown[] };
  assert.equal(nested.items[0], "data:image/png;base64," + encoded);
  assert.equal(inlined.dataUrl, "data:image/jpeg;base64," + encoded);
});

test("original TaskAdaptorJSONFilePlaceholderErrors JSON", () => {
  const cases: { name: string; part: unknown; fileSize: number; globalMB?: number; wantContain: string }[] = [
    { name: "unknown ref", part: { __fileRef: "request_file:missing", encoding: "base64" }, fileSize: 4, wantContain: 'unknown file reference "request_file:missing"' },
    { name: "extra key", part: { __fileRef: "request_file:input_reference", encoding: "base64", extra: true }, fileSize: 4, wantContain: "invalid file placeholder" },
    { name: "missing encoding", part: { __fileRef: "request_file:input_reference" }, fileSize: 4, wantContain: "encoding" },
    { name: "oversize maxBytes", part: { __fileRef: "request_file:input_reference", encoding: "base64", maxBytes: 3 }, fileSize: 4, wantContain: "3 byte limit" },
    { name: "oversize global", part: { __fileRef: "request_file:input_reference", encoding: "base64" }, fileSize: 2 << 20, globalMB: 1, wantContain: "1048576 byte limit" },
    {
      name: "multiple references cap",
      part: {
        a: { __fileRef: "request_file:input_reference", encoding: "base64" },
        b: { __fileRef: "request_file:input_reference", encoding: "base64" },
      },
      fileSize: 700 << 10,
      globalMB: 1,
      wantContain: "1048576 byte limit",
    },
  ];
  for (const testCase of cases) {
    const file: NativeSubmitFile = {
      field: "input_reference",
      filename: "ref.bin",
      mimeType: "application/octet-stream",
      data: new Uint8Array(testCase.fileSize).fill(0x78),
    };
    const limit = testCase.globalMB ? maxInlineFileBytes(testCase.globalMB) : maxInlineFileBytes();
    assert.throws(
      () => inlineJSONFilePlaceholders(testCase.part, [file], limit),
      (err: Error) => {
        assert.match(err.message, new RegExp(testCase.wantContain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      },
      testCase.name,
    );
  }
});

test("original TaskAdaptorDoesNotEmitInjectedMultipartDispositionHeaders JSON", () => {
  const cases = [
    { name: "part name", parts: [{ name: "prompt\r\nX-Injected: yes", value: "hello", fileRef: "", filename: "" }] },
    {
      name: "filename",
      parts: [{ name: "input_reference", value: undefined, fileRef: "request_file:input_reference", filename: "safe.png\r\nX-Injected: yes" }],
    },
  ];
  const file: NativeSubmitFile = { field: "input_reference", filename: "input.png", mimeType: "image/png", data: new TextEncoder().encode("image") };
  for (const testCase of cases) {
    try {
      const encoded = encodeNativeSubmitBody({ bodyType: "multipart", parts: testCase.parts }, [file]);
      assert.equal(latin1(encoded.body as Uint8Array).includes("\r\nX-Injected: yes"), false, testCase.name);
    } catch (err) {
      assert.match(err instanceof Error ? err.message : String(err), /multipart/);
    }
  }
});

test("original buildTaskPluginRouteRequest keeps host-owned multipart file bytes", () => {
  const boundary = "----native-file-bytes";
  const raw = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="caption"`,
    "",
    "hello",
    `--${boundary}`,
    `Content-Disposition: form-data; name="input_reference"; filename="clip.bin"`,
    "Content-Type: application/octet-stream",
    "",
    "opaque-file",
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const requestContext = buildTaskPluginRouteRequestFromParts({
    method: "POST",
    path: "/v1/videos",
    contentTypes: [`multipart/form-data; boundary=${boundary}`],
    contentLength: raw.length,
    body: new TextEncoder().encode(raw),
  });
  assert.equal(requestContext.body.kind, BODY_MULTIPART);
  assert.deepEqual(requestContext.files, [
    {
      ref: "request_file:input_reference",
      field: "input_reference",
      filename: "clip.bin",
      mimeType: "application/octet-stream",
      size: "opaque-file".length,
    },
  ]);
  assert.equal(requestContext.fileContents?.length, 1);
  assert.equal(new TextDecoder().decode(requestContext.fileContents?.[0].data), "opaque-file");
  assert.equal(Object.prototype.hasOwnProperty.call(requestContext.files[0], "data"), false);
});

test("original sora multipart native RelayTask submit JSON fields", async () => {
  const { e, auth, store, sk } = await boot();
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "sora-native",
        type: CHANNEL_TYPE_SORA,
        key: "sk-test",
        models: "sora-2",
        group: "default",
        base_url: "https://sora.example.test",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));

  const inbound = encodeMultipartForm(
    [
      { name: "model", value: "sora-2" },
      { name: "prompt", value: "a cat" },
    ],
    [{ name: "input_reference", filename: "ref.png", mime: "image/png", data: new TextEncoder().encode("image-bytes") }],
  );
  const seen: { url: string; contentType: string; values: Record<string, string[]>; files: { name: string; data: string }[] }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const contentType = new Headers(init?.headers).get("content-type") || "";
    const parsed = contentType.includes("multipart/form-data")
      ? parseMultipartForm(toArrayBuffer(bodyBytes(init)), contentType)
      : { values: {}, files: [] as { name: string; data: Uint8Array }[] };
    seen.push({
      url,
      contentType,
      values: parsed.values,
      files: parsed.files.map((file) => ({ name: file.name, data: new TextDecoder().decode(file.data) })),
    });
    return new Response(JSON.stringify({ id: "video_upstream_1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/v1/videos", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": inbound.contentType },
        body: inbound.body as unknown as BodyInit,
      }),
      e,
    );
    assert.equal(hit.res.status, 200, hit.text);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://sora.example.test/v1/videos");
    assert.match(seen[0].contentType, /^multipart\/form-data; boundary=/);
    assert.deepEqual(seen[0].values.model, ["sora-2"]);
    assert.deepEqual(seen[0].values.prompt, ["a cat"]);
    assert.equal(seen[0].files.length, 1);
    assert.equal(seen[0].files[0].name, "input_reference");
    assert.equal(seen[0].files[0].data, "image-bytes");
    const data = hit.body as { id?: string; object?: string; status?: string; model?: string };
    assert.ok(String(data.id || "").startsWith("task_"), hit.text);
    assert.notEqual(data.id, "video_upstream_1");
    assert.equal(data.object, "video");
    assert.equal(data.status, "queued");
    assert.equal(data.model, "sora-2");
    const persisted = await store.getTaskByTid(String(data.id));
    assert.ok(persisted, "persisted task");
    assert.equal(String(persisted?.platform), "sora");
    const priv = JSON.parse(String(persisted?.private_data || "{}")) as { upstream_task_id?: string };
    assert.equal(priv.upstream_task_id, "video_upstream_1");
  } finally {
    globalThis.fetch = origFetch;
  }
});
