import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { stageSyncedPlugins } = await jiti.import("./config-sync-plugins.ts");
const { installedPluginVersion, applyLocalProfile, localSettingsVersion, captureLocalProfile } = await jiti.import("./config-sync-local.ts");
const plugins = [{ source: "npm:foo@2.0.0", extensions: null }, { source: "npm:bar@1.0.0", extensions: null }];

async function install(root, name, version) {
  await mkdir(join(root, "npm", "node_modules", name), { recursive: true });
  await writeFile(join(root, "npm", "node_modules", name, "package.json"), JSON.stringify({ version }));
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-plugin-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await install(root, "foo", "1.0.0");
  await writeFile(join(root, "settings.json"), JSON.stringify({ packages: ["npm:foo@1.0.0"], skills: ["/my/skills"] }));
  return root;
}
const installFixture = async (root, source) => {
  if (source === "npm:foo@2.0.0") await install(root, "foo", "2.0.0");
  else await install(root, "bar", "1.0.0");
};

test("a later npm failure leaves every live plugin at its previous version", async (t) => {
  const root = await fixture(t);
  await assert.rejects(stageSyncedPlugins(root, plugins, async (stage, source) => {
    if (source.includes("bar")) throw new Error("installation failed");
    await installFixture(stage, source);
  }, () => {}), /installation failed/);
  assert.equal(installedPluginVersion(root, "foo"), "1.0.0");
  assert.equal(installedPluginVersion(root, "bar"), null);
  assert.equal((await readdir(root)).some(name => name.startsWith(".pi-web-config-sync-")), false);
});

test("an unaccepted remote write can discard the candidate without changing live packages", async (t) => {
  const root = await fixture(t);
  const transaction = await stageSyncedPlugins(root, plugins, installFixture, () => {});
  assert.equal(installedPluginVersion(root, "foo"), "1.0.0");
  await transaction.dispose();
  assert.equal(installedPluginVersion(root, "foo"), "1.0.0");
});

test("activation and rollback switch the complete npm directory together", async (t) => {
  const root = await fixture(t);
  const transaction = await stageSyncedPlugins(root, plugins, installFixture, () => {});
  transaction.activate();
  assert.equal(installedPluginVersion(root, "foo"), "2.0.0");
  assert.equal(installedPluginVersion(root, "bar"), "1.0.0");
  transaction.rollback();
  assert.equal(installedPluginVersion(root, "foo"), "1.0.0");
  assert.equal(installedPluginVersion(root, "bar"), null);
  await transaction.dispose();
});

test("a new task starting during staging prevents activation and preserves settings", async (t) => {
  const root = await fixture(t);
  const before = await readFile(join(root, "settings.json"), "utf8");
  const transaction = await stageSyncedPlugins(root, plugins, installFixture, () => { throw new Error("busy"); });
  const next = { ...captureLocalProfile(root, {}), plugins };
  await assert.rejects(applyLocalProfile(root, localSettingsVersion(root), next, transaction), /busy/);
  assert.equal(installedPluginVersion(root, "foo"), "1.0.0");
  assert.deepEqual(JSON.parse(await readFile(join(root, "settings.json"), "utf8")), JSON.parse(before));
  await transaction.dispose();
});
