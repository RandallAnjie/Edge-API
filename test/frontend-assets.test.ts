import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("public ASSETS are the original QuantumNous new-api TanStack build", () => {
  const index = readFileSync(join(root, "public/index.html"), "utf8");
  assert.match(index, /id="root"/);
  assert.match(index, /New API/);
  assert.match(index, /\/static\/js\/index\./);
  assert.match(index, /<!--umami-->/);
  assert.match(index, /<!--Google Analytics-->/);
  assert.doesNotMatch(index, /Umami QuantumNous/);
  assert.doesNotMatch(index, /Google Analytics QuantumNous/);
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
  const legacy = readFileSync(join(root, "web/src/lib/legacy-route.ts"), "utf8");
  assert.match(legacy, /legacyConsoleRoutes/);
  assert.match(legacy, /\/console\/channel/);
  assert.match(legacy, /\/console\/token/);
  assert.match(legacy, /function buildTargetHref\(targetPath: string, source: URL\)/);
  assert.doesNotMatch(legacy, /liftHashRouter/);
  assert.doesNotMatch(legacy, /#\//);
  const index = readFileSync(join(root, "public/index.html"), "utf8");
  const bundledName = index.match(/\/static\/js\/(index\.[^"]+\.js)/)?.[1];
  assert.ok(bundledName);
  const bundled = readFileSync(join(root, "public/static/js", bundledName), "utf8");
  assert.match(bundled, /legacy-route\.invalid/);
  assert.doesNotMatch(bundled, /startsWith\("#\/"\)/);
});

test("original remaining console pages are vendored 1:1", () => {
  const pages = [
    "web/src/features/system-update/system-update-action.tsx",
    "web/src/features/system-update/system-update-dialog.tsx",
    "web/src/features/system-update/use-system-update.ts",
    "web/src/features/system-update/api.ts",
    "web/src/features/system-update/releases.ts",
    "web/src/features/system-update/store.ts",
    "web/src/features/channels/components/channel-plugin-extensions.tsx",
    "web/src/features/channels/components/dialogs/configure-models-dialog.tsx",
    "web/src/features/channels/components/drawers/channel-configuration.tsx",
    "web/src/features/channels/components/drawers/channel-provider-picker.tsx",
    "web/src/features/channels/components/upstream-model-selection.tsx",
    "web/src/features/system-settings/models/task-plugin-pricing-editor.tsx",
    "web/src/features/task-plugins/components/plugin-changelog-panel.tsx",
    "web/src/assets/custom/icon-wan.tsx",
    "web/src/assets/custom/wan.png",
    "web/src/env.d.ts",
  ];
  for (const page of pages) {
    assert.ok(existsSync(join(root, page)), page);
  }
  const header = readFileSync(join(root, "web/src/components/layout/components/app-header.tsx"), "utf8");
  assert.match(header, /SystemUpdateAction/);
  const pkg = JSON.parse(readFileSync(join(root, "web/package.json"), "utf8")) as { dependencies: Record<string, string> };
  assert.equal(pkg.dependencies.yaml, "^2.9.0");
  const more = readFileSync(join(root, "src/more-routes.ts"), "utf8");
  assert.doesNotMatch(more, /\/api\/user-agreement/);
  assert.doesNotMatch(more, /\/api\/privacy-policy/);
  const routes = readFileSync(join(root, "src/routes.ts"), "utf8");
  assert.match(routes, /r\.get\("\/api\/user-agreement"/);
  assert.match(routes, /r\.get\("\/api\/privacy-policy"/);
  const jsDir = join(root, "public/static/js");
  const js = readdirSync(jsDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(join(jsDir, name), "utf8"))
    .join("\n");
  assert.match(js, /system-update:v1/);
  assert.match(js, /https:\/\/github\.com\/QuantumNous\/new-api/);
});
