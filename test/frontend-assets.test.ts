import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("public ASSETS are the original QuantumNous new-api TanStack build", () => {
  const index = readFileSync(join(root, "public/index.html"), "utf8");
  assert.match(index, /id="root"/);
  assert.match(index, /New API/);
  assert.match(index, /\/static\/js\/index\./);
  assert.doesNotMatch(index, /id="app"/);
  assert.doesNotMatch(index, /\/app\.js/);
  assert.ok(existsSync(join(root, "public/logo.png")));
  assert.ok(existsSync(join(root, "public/favicon.ico")));
});

test("vendored web source is the original TanStack router tree", () => {
  const about = readFileSync(join(root, "web/src/features/about/index.tsx"), "utf8");
  assert.match(about, /https:\/\/github.com\/QuantumNous\/new-api/);
  const footer = readFileSync(join(root, "web/src/components/layout/components/footer.tsx"), "utf8");
  assert.match(footer, /https:\/\/github.com\/QuantumNous\/new-api/);
  const tree = readFileSync(join(root, "web/src/routeTree.gen.ts"), "utf8");
  for (const route of [
    "/sign-in",
    "/keys/",
    "/usage-logs/",
    "/system-settings",
    "/task-plugins/",
    "/playground/",
    "/channels/",
    "/wallet/",
  ]) {
    assert.match(tree, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const pkg = JSON.parse(readFileSync(join(root, "web/package.json"), "utf8")) as { name: string };
  assert.equal(pkg.name, "newapi-web");
});
