import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { compilePlugin } from "../src/jsplugin.js";
import { CHANNEL_TYPE_VERTEX } from "../src/constants.js";
import { buildNativeSubmitContext, buildNativeSubmitDescriptor } from "../src/task-plugin-submit.js";
import { BODY_JSON } from "../src/task-plugin-route.js";
import {
  applyVertexAdcAuth,
  createSignedJWT,
  encodeVertexTokenForm,
  expirePluginAuthCache,
  parseVertexCredentials,
  resetVertexAuthForTests,
  resolvePluginAuth,
  VERTEX_JWT_BEARER_GRANT,
  VERTEX_OAUTH_SCOPE,
  VERTEX_OAUTH_TOKEN_URL,
  exchangeJwtForAccessToken,
} from "../src/vertex-auth.js";

afterEach(() => {
  resetVertexAuthForTests();
});

function decodeJwtJson(part: string): Record<string, unknown> {
  const pad = "=".repeat((4 - (part.length % 4)) % 4);
  return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8")) as Record<string, unknown>;
}

function pemFromPkcs8(der: ArrayBuffer): string {
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g) || [b64];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

async function generateRsaPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  return pemFromPkcs8(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
}

async function vertexCredentialsJson(overrides: Record<string, string> = {}): Promise<string> {
  const pem = overrides.private_key || (await generateRsaPem());
  return JSON.stringify({
    project_id: "proj-1",
    private_key_id: "key-1",
    private_key: pem,
    client_email: "sa@proj-1.iam.gserviceaccount.com",
    client_id: "123",
    ...overrides,
    ...(overrides.private_key ? {} : { private_key: pem }),
  });
}

test("original vertex Credentials JSON fields", async () => {
  const raw = await vertexCredentialsJson();
  const creds = parseVertexCredentials(raw);
  assert.equal(creds.project_id, "proj-1");
  assert.equal(creds.private_key_id, "key-1");
  assert.equal(creds.client_email, "sa@proj-1.iam.gserviceaccount.com");
  assert.equal(creds.client_id, "123");
  assert.match(creds.private_key, /BEGIN PRIVATE KEY/);
});

test("original vertex createSignedJWT RS256 claim JSON fields", async () => {
  const pem = await generateRsaPem();
  const now = Date.UTC(2026, 8, 15, 12, 0, 0);
  const jwt = await createSignedJWT("sa@proj-1.iam.gserviceaccount.com", pem, now);
  const [headerB64, payloadB64] = jwt.split(".");
  const header = decodeJwtJson(headerB64);
  const claims = decodeJwtJson(payloadB64);
  assert.equal(header.alg, "RS256");
  assert.equal(header.typ, "JWT");
  assert.equal(claims.iss, "sa@proj-1.iam.gserviceaccount.com");
  assert.equal(claims.scope, VERTEX_OAUTH_SCOPE);
  assert.equal(claims.aud, VERTEX_OAUTH_TOKEN_URL);
  assert.equal(claims.iat, Math.floor(now / 1000));
  assert.equal(claims.exp, Math.floor(now / 1000) + 35 * 60);
});

test("original vertex oauth2/v4/token form JSON fields", async () => {
  const pem = await generateRsaPem();
  const jwt = await createSignedJWT("sa@proj-1.iam.gserviceaccount.com", pem);
  const form = encodeVertexTokenForm(jwt);
  const params = new URLSearchParams(form);
  assert.equal(params.get("grant_type"), VERTEX_JWT_BEARER_GRANT);
  assert.equal(params.get("assertion"), jwt);
  assert.ok(form.startsWith("assertion="), form);
  assert.match(form, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);

  let captured: { url: string; contentType: string; body: string } | undefined;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = {
      url: String(input),
      contentType: new Headers(init?.headers).get("content-type") || "",
      body: typeof init?.body === "string" ? init.body : "",
    };
    return new Response(JSON.stringify({ access_token: "ya29.from-http", token_type: "Bearer" }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const token = await exchangeJwtForAccessToken(jwt);
    assert.equal(token, "ya29.from-http");
    assert.equal(captured?.url, VERTEX_OAUTH_TOKEN_URL);
    assert.equal(captured?.contentType, "application/x-www-form-urlencoded");
    const posted = new URLSearchParams(captured?.body || "");
    assert.equal(posted.get("grant_type"), VERTEX_JWT_BEARER_GRANT);
    assert.equal(posted.get("assertion"), jwt);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original oauth2_jwt resolveAuth caches and refreshes JSON", async () => {
  let calls = 0;
  resetVertexAuthForTests({
    acquireAccessToken: async () => {
      calls += 1;
      return `token-${calls}`;
    },
  });
  const credentials = JSON.stringify({ project_id: "project", client_email: "a@example.com", private_key: "secret" });
  const meta = { auth: { type: "oauth2_jwt" } };
  const first = await resolvePluginAuth(meta, credentials, "");
  const second = await resolvePluginAuth(meta, credentials, "");
  assert.equal(first.authError, undefined);
  assert.deepEqual(first.auth, { authHeader: "Bearer token-1", projectId: "project" });
  assert.deepEqual(first.auth, second.auth);
  assert.equal(first.apiKey, undefined);
  assert.equal(calls, 1);
  expirePluginAuthCache(credentials, "");
  const refreshed = await resolvePluginAuth(meta, credentials, "");
  assert.deepEqual(refreshed.auth, { authHeader: "Bearer token-2", projectId: "project" });
  assert.equal(calls, 2);
});

test("original oauth2_jwt submitContext JSON does not expose service-account key", async () => {
  resetVertexAuthForTests({
    acquireAccessToken: async () => "access-token",
  });
  const credentials = await vertexCredentialsJson();
  const source = `
export const meta = {apiVersion:1,key:"oauth",name:"OAuth",version:"1.0.0",author:{name:"Test"},models:["m"],fetchMode:"per_task",auth:{type:"oauth2_jwt"}};
export function buildSubmitRequest(ctx) {
  if (ctx.apiKey !== undefined) throw new Error("raw key exposed");
  return {url:ctx.baseUrl+"/submit",headers:{Authorization:ctx.authHeader},body:{projectId:ctx.auth.projectId}};
}
export function parseSubmitResponse(){return {taskId:"1"}}
export function buildQueryRequest(){return {url:"https://example.com"}}
export function parseTaskResult(){return {status:"SUCCESS"}}
`;
  const loaded = compilePlugin(source, { key: "oauth", version: "1.0.0" });
  const submitContext = await buildNativeSubmitContext({
    engine: loaded.engine,
    requestContext: {
      path: "/v1/videos",
      method: "POST",
      params: {},
      query: {},
      body: { kind: BODY_JSON, value: { prompt: "p" } },
      files: [],
      requestBody: { prompt: "p" },
    },
    requestBody: { prompt: "p" },
    req: new Request("http://local/v1/videos", { method: "POST" }),
    info: {
      originModelName: "m",
      upstreamModelName: "m",
      action: "image_to_video",
      publicTaskId: "task_public",
      apiKey: credentials,
      channelBaseUrl: "https://provider.example",
      channelId: 1,
      channelType: CHANNEL_TYPE_VERTEX,
      usingGroup: "default",
      isModelMapped: false,
    },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(submitContext, "apiKey"), false);
  assert.equal(submitContext.authHeader, "Bearer access-token");
  assert.deepEqual(submitContext.auth, { authHeader: "Bearer access-token", projectId: "proj-1" });
  const descriptor = buildNativeSubmitDescriptor(loaded.engine, submitContext, "https://provider.example");
  assert.equal("statusCode" in descriptor, false);
  if ("statusCode" in descriptor) return;
  assert.equal(descriptor.headers.Authorization, "Bearer access-token");
  assert.deepEqual(descriptor.body, { projectId: "proj-1" });
});

test("original oauth2_jwt decode wrap JSON", async () => {
  const resolved = await resolvePluginAuth({ auth: { type: "oauth2_jwt" } }, "x");
  assert.match(String(resolved.authError), /^decode oauth2_jwt credentials: invalid character 'x'/);
  assert.equal(resolved.apiKey, undefined);
});

test("original vertex SetupRequestHeader ADC Authorization JSON", async () => {
  const credentials = await vertexCredentialsJson();
  let exchanges = 0;
  resetVertexAuthForTests({
    exchangeJwtForAccessToken: async (signedJWT: string) => {
      exchanges += 1;
      assert.equal(signedJWT.split(".").length, 3);
      return "ya29.chat-token";
    },
  });
  const headers: Record<string, string> = {};
  const channel = {
    id: 41,
    type: CHANNEL_TYPE_VERTEX,
    key: credentials,
    settings: "",
    setting: "",
    channel_info: "",
  };
  await applyVertexAdcAuth(channel, headers, credentials);
  assert.equal(headers.authorization, "Bearer ya29.chat-token");
  assert.equal(headers["x-goog-user-project"], "proj-1");
  await applyVertexAdcAuth(channel, headers, credentials);
  assert.equal(exchanges, 1);

  const apiKeyHeaders: Record<string, string> = {};
  await applyVertexAdcAuth(
    { ...channel, settings: JSON.stringify({ vertex_key_type: "api_key" }) },
    apiKeyHeaders,
    "vkey",
  );
  assert.equal("authorization" in apiKeyHeaders, false);
});

test("original vertex createSignedJWT PEM parse error JSON", async () => {
  await assert.rejects(() => createSignedJWT("sa@example.com", "not-a-key"), /failed to parse PEM block containing the private key/);
});
