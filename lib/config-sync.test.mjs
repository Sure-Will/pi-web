import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseSyncProfile, mergeSyncProfiles, parseBrowserPreferences, parseRepository, sameValue } = await jiti.import("./config-sync-profile.ts");
const { captureLocalProfile, applyProfileToSettings } = await jiti.import("./config-sync-local.ts");
const { updateConfigSync, getConfigSyncStatus } = await jiti.import("./config-sync.ts");
const { stageSyncedPlugins } = await jiti.import("./config-sync-plugins.ts");
const { loadModelsWithCache } = await jiti.import("./models-cache.ts");

const profile = () => ({ version: 1, model: { provider: "example", modelId: "model" }, thinkingLevel: "high",
  modelThinkingLevels: {}, enabledModels: null, builtInSubagents: true, plugins: [], browser: { "pi-theme": "dark" } });

test("profile allow-list rejects credentials, skill paths, arbitrary npm sources and invalid browser keys", () => {
  for (const extra of [{ auth: "secret" }, { skills: ["C:/private"] }, { sessionDir: "/private" }]) {
    assert.throws(() => parseSyncProfile({ ...profile(), ...extra }));
  }
  for (const source of ["npm:plugin", "npm:plugin@latest", "npm:plugin@^1.0.0", "git:github.com/a/b", "C:/plugins/test", "npm:plugin@1.0.0;whoami"]) {
    assert.throws(() => parseSyncProfile({ ...profile(), plugins: [{ source, extensions: null }] }));
  }
  for (const extensions of [["../file.ts"], ["C:/private.ts"], ["/private.ts"]]) {
    assert.throws(() => parseSyncProfile({ ...profile(), plugins: [{ source: "npm:plugin@1.2.3", extensions }] }));
  }
  assert.throws(() => parseBrowserPreferences({ "auth-token": "secret" }));
  assert.throws(() => parseBrowserPreferences({ "pi-chat-content-width": "999999" }));
  assert.throws(() => parseBrowserPreferences({ "pi-sound-enabled": true }));
  assert.throws(() => parseRepository("https://user:secret@github.com/o/r"));
  assert.throws(() => parseRepository("a/b/../secrets"));
  assert.equal(parseRepository("Sure-Will/pi-web-config"), "Sure-Will/pi-web-config");
});

test("three-way merge combines independent edits and reports only overlapping fields", () => {
  const base = profile(), local = structuredClone(base), remote = structuredClone(base);
  local.builtInSubagents = false;
  local.browser["pi-theme"] = "pine";
  remote.thinkingLevel = "max";
  remote.browser["pi-sound-enabled"] = "false";
  const merged = mergeSyncProfiles(base, local, remote);
  assert.deepEqual(merged.conflicts, []);
  assert.equal(merged.profile.builtInSubagents, false);
  assert.equal(merged.profile.thinkingLevel, "max");
  assert.deepEqual(merged.profile.browser, { "pi-theme": "pine", "pi-sound-enabled": "false" });
  remote.browser["pi-theme"] = "rose";
  assert.deepEqual(mergeSyncProfiles(base, local, remote).conflicts, ["browser.pi-theme"]);
  assert.ok(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 }));
});

test("applying settings keeps local paths, credentials, shell choice and existing package skill filters", () => {
  const settings = { skills: ["C:/skills"], extensions: ["C:/local.ts"], apiKey: "secret", shellPath: "C:/bash.exe",
    defaultTools: ["powershell"], extra: 42, packages: ["C:/local-package", "relative-package", { source: "npm:plugin@1.0.0", skills: ["my-skill"], prompts: [] }] };
  const next = applyProfileToSettings(settings, { ...profile(), plugins: [{ source: "npm:plugin@1.2.3", extensions: [] }, { source: "npm:other@1.0.0", extensions: null }] });
  for (const key of ["skills", "extensions", "apiKey", "shellPath", "defaultTools", "extra"]) assert.deepEqual(next[key], settings[key]);
  assert.deepEqual(next.packages, ["C:/local-package", "relative-package", { source: "npm:plugin@1.2.3", skills: ["my-skill"], prompts: [], extensions: [] },
    { source: "npm:other@1.0.0", skills: [], prompts: [], themes: [] }]);
});

test("package autoload remains disabled on a new computer and can be enabled again", async (t) => {
  const root = await computer(t);
  await writeFile(join(root, "settings.json"), JSON.stringify({ packages: [{ source: "npm:plugin@1.0.0", autoload: false, extensions: ["index.ts"] }] }));
  const captured = captureLocalProfile(root, {});
  assert.equal(captured.plugins[0].autoload, false);
  const received = applyProfileToSettings({}, captured);
  assert.equal(received.packages[0].autoload, false);
  captured.plugins[0].autoload = true;
  assert.equal(applyProfileToSettings(received, captured).packages[0].autoload, undefined);
});

async function computer(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-config-sync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "agents"));
  await writeFile(join(root, "settings.json"), JSON.stringify({ defaultProvider: "example", defaultModel: "model", defaultThinkingLevel: "high", skills: ["/private/skills"], defaultTools: ["powershell"], packages: [] }));
  await writeFile(join(root, "agents", "settings.json"), JSON.stringify({ builtInEnabled: true, untouched: 3 }));
  return root;
}

function remoteStore(initial = null) {
  let value = initial, revision = 0, writes = 0;
  return {
    get profile() { return value; }, get writes() { return writes; },
    edit(fn) { value = fn(structuredClone(value)); revision++; },
    remote: {
      async read() { return { profile: structuredClone(value), sha: String(revision) }; },
      async write(_repo, next, sha) { assert.equal(sha, String(revision)); value = structuredClone(next); revision++; writes++; },
    },
    async isBusy() { return false; },
    async preparePlugins() { throw new Error("unexpected install"); },
  };
}

const connect = (root, deps) => updateConfigSync({ action: "configure", enabled: true, repository: "owner/private-config" }, root, deps);

test("two computers round-trip preferences without copying skills or local tools, and no-op sync creates no commit", async (t) => {
  const win = await computer(t), mac = await computer(t), shared = remoteStore();
  await updateConfigSync({ action: "browser", browser: { "pi-theme": "pine" }, browserBase: {} }, win, shared);
  assert.equal((await connect(win, shared)).error, undefined);
  await writeFile(join(mac, "settings.json"), JSON.stringify({ skills: ["/mac/skills"], shellPath: "/bin/zsh", packages: [] }));
  assert.equal((await connect(mac, shared)).error, undefined);
  assert.equal(getConfigSyncStatus(mac).browser["pi-theme"], "pine");
  const settings = JSON.parse(await readFile(join(mac, "settings.json"), "utf8"));
  assert.deepEqual(settings.skills, ["/mac/skills"]);
  assert.equal(settings.shellPath, "/bin/zsh");
  assert.equal(settings.defaultThinkingLevel, "high");
  const writes = shared.writes;
  await updateConfigSync({ action: "sync" }, win, shared);
  await updateConfigSync({ action: "sync" }, mac, shared);
  assert.equal(shared.writes, writes);
  assert.doesNotMatch(JSON.stringify(shared.profile), /private\/skills|powershell|shellPath/);
});

test("conflicts don't write either side, and explicit choice retains unrelated remote changes", async (t) => {
  const root = await computer(t), shared = remoteStore(profile());
  await connect(root, shared);
  await updateConfigSync({ action: "browser", browser: { "pi-theme": "pine" }, browserBase: { "pi-theme": "dark" } }, root, shared);
  shared.edit(p => ({ ...p, thinkingLevel: "max", browser: { "pi-theme": "rose" } }));
  const before = await readFile(join(root, "settings.json"), "utf8");
  const conflict = await updateConfigSync({ action: "sync" }, root, shared);
  assert.deepEqual(conflict.conflicts, ["browser.pi-theme"]);
  assert.equal(await readFile(join(root, "settings.json"), "utf8"), before);
  assert.equal(shared.profile.browser["pi-theme"], "rose");
  const resolved = await updateConfigSync({ action: "sync", resolve: "local" }, root, shared);
  assert.equal(resolved.error, undefined);
  assert.equal(shared.profile.browser["pi-theme"], "pine");
  assert.equal(shared.profile.thinkingLevel, "max");
});

test("network failures and malformed local settings retain pending changes", async (t) => {
  const root = await computer(t), shared = remoteStore();
  await connect(root, shared);
  const before = await readFile(join(root, "settings.json"), "utf8");
  const offline = { ...shared, remote: { async read() { throw new Error("offline"); } } };
  const status = await updateConfigSync({ action: "sync" }, root, offline);
  assert.equal(status.error, "offline");
  assert.equal(await readFile(join(root, "settings.json"), "utf8"), before);
  await writeFile(join(root, "settings.json"), "{");
  assert.ok((await updateConfigSync({ action: "sync" }, root, shared)).error);
  assert.equal(await readFile(join(root, "settings.json"), "utf8"), "{");
});

test("plugin installation waits for idle, verifies exact version, and doesn't load remote skills", async (t) => {
  const root = await computer(t), remote = profile();
  remote.plugins = [{ source: "npm:heartbeat@0.4.1", extensions: null }];
  const shared = remoteStore(remote);
  let installs = 0;
  const deps = { ...shared, async isBusy() { return true; }, async preparePlugins(plugins) {
    return stageSyncedPlugins(root, plugins, async (stage, source) => {
      installs++;
      assert.equal(source, "npm:heartbeat@0.4.1");
      await mkdir(join(stage, "npm", "node_modules", "heartbeat"), { recursive: true });
      await writeFile(join(stage, "npm", "node_modules", "heartbeat", "package.json"), '{"version":"0.4.1"}');
    }, () => {});
  } };
  assert.equal((await connect(root, deps)).busy, true);
  assert.equal(installs, 0);
  deps.isBusy = async () => false;
  assert.equal((await updateConfigSync({ action: "sync" }, root, deps)).error, undefined);
  assert.equal(installs, 1);
  const settings = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, [{ source: "npm:heartbeat@0.4.1", skills: [], prompts: [], themes: [] }]);
  assert.deepEqual(captureLocalProfile(root, {}).plugins, remote.plugins);
});

test("an edit during remote IO isn't overwritten by the downloaded snapshot", async (t) => {
  const root = await computer(t), shared = remoteStore(profile());
  shared.remote.read = async () => {
    const settings = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
    await writeFile(join(root, "settings.json"), JSON.stringify({ ...settings, defaultThinkingLevel: "low" }));
    return { profile: profile(), sha: "0" };
  };
  assert.match((await connect(root, shared)).error, /Local settings changed/);
  assert.equal(JSON.parse(await readFile(join(root, "settings.json"), "utf8")).defaultThinkingLevel, "low");
});

test("legacy installed packages can supply their version without uploading their path", async (t) => {
  const root = await computer(t);
  await writeFile(join(root, "settings.json"), JSON.stringify({ packages: ["npm:legacy-plugin"] }));
  const captured = captureLocalProfile(root, {}, (source) => { assert.equal(source, "npm:legacy-plugin"); return "1.2.3"; });
  assert.deepEqual(captured.plugins, [{ source: "npm:legacy-plugin@1.2.3", extensions: null }]);
});

test("bare package names are local resource paths, not npm sources", async (t) => {
  const root = await computer(t);
  await writeFile(join(root, "settings.json"), JSON.stringify({ packages: ["local-resource", { source: "another-resource", extensions: ["index.ts"] }] }));
  const captured = captureLocalProfile(root, {});
  assert.deepEqual(captured.plugins, []);
  assert.deepEqual(applyProfileToSettings({ packages: ["local-resource"] }, captured).packages, ["local-resource"]);
});

test("a matching legacy global plugin doesn't require a registry connection", async (t) => {
  const root = await computer(t);
  const remote = profile();
  remote.plugins = [{ source: "npm:legacy-plugin@1.2.3", extensions: null }];
  await writeFile(join(root, "settings.json"), JSON.stringify({ packages: ["npm:legacy-plugin@1.2.3"] }));
  const shared = remoteStore(remote);
  shared.installedVersion = () => "1.2.3";
  assert.equal((await connect(root, shared)).error, undefined);
  assert.equal(shared.writes, 0);
});

test("applying synced defaults invalidates the model selector cache immediately", async (t) => {
  const root = await computer(t), shared = remoteStore({ ...profile(), thinkingLevel: "max" });
  assert.deepEqual(await loadModelsWithCache(root, async () => ({ defaultModel: "old" })), { defaultModel: "old" });
  assert.equal((await connect(root, shared)).error, undefined);
  assert.deepEqual(await loadModelsWithCache(root, async () => ({ defaultModel: "new" })), { defaultModel: "new" });
});
