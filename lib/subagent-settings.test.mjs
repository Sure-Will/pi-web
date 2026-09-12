import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import lockfile from "proper-lockfile";

const {
  isBuiltInSubagentsEnabled,
  readSubagentSettings,
  writeBuiltInSubagentsEnabled,
  writeSubagentMaxConcurrent,
} = await createJiti(import.meta.url).import("./subagent-settings.ts");

test("subagent settings default the built-in extension to disabled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: false });
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
});

test("subagent settings persist both states and preserve unrelated fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  writeBuiltInSubagentsEnabled(true, settingsPath);
  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: true });
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), true);
  const first = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(first, { version: 1, builtInEnabled: true });

  await writeFile(settingsPath, JSON.stringify({ ...first, futureSetting: 3 }));
  writeBuiltInSubagentsEnabled(false, settingsPath);
  const second = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(second, { version: 1, builtInEnabled: false, futureSetting: 3 });
});

test("damaged settings fail closed and are not overwritten", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, "{");

  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
  assert.throws(() => readSubagentSettings(settingsPath));
  assert.throws(() => writeBuiltInSubagentsEnabled(true, settingsPath));
  assert.equal(await readFile(settingsPath, "utf8"), "{");
});

test("a regular subagent toggle respects the configuration sync file lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  writeBuiltInSubagentsEnabled(false, settingsPath);
  const release = await lockfile.lock(settingsPath, { realpath: false });
  try {
    assert.throws(() => writeBuiltInSubagentsEnabled(true, settingsPath), { code: "ELOCKED" });
    assert.equal(readSubagentSettings(settingsPath).builtInEnabled, false);
  } finally { await release(); }
  writeBuiltInSubagentsEnabled(true, settingsPath);
  assert.equal(readSubagentSettings(settingsPath).builtInEnabled, true);
});


test("concurrency changes respect config sync locks and preserve settings on both writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-concurrency-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ version: 1, builtInEnabled: true, maxConcurrent: 3, futureSetting: "keep" }));
  const release = await lockfile.lock(settingsPath, { realpath: false });
  try {
    assert.throws(() => writeSubagentMaxConcurrent(7, settingsPath), { code: "ELOCKED" });
    assert.equal(readSubagentSettings(settingsPath).maxConcurrent, 3);
  } finally { await release(); }
  const changed = writeSubagentMaxConcurrent(7, settingsPath);
  assert.equal(changed.maxConcurrent, 7);
  assert.equal(changed.builtInEnabled, true);
  assert.equal(writeBuiltInSubagentsEnabled(false, settingsPath).maxConcurrent, 7);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1, builtInEnabled: false, maxConcurrent: 7, futureSetting: "keep",
  });
});
