import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { browserPreferencePatch, applySyncedBrowserPreferences, readBrowserPreferences, readBrowserSyncBase, readBrowserInitialSnapshot } = await jiti.import("./config-sync-browser.ts");
const { mergeBrowserPatch } = await jiti.import("./config-sync.ts");

function storage(values = {}) {
  const data = new Map(Object.entries(values));
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}

test("new browser adopts shared values; offline edits use the previous common base", () => {
  assert.deepEqual(browserPreferencePatch({ "pi-theme": "light" }, null, { "pi-theme": "dark" }), {});
  assert.deepEqual(browserPreferencePatch({ "pi-theme": "pine" }, { "pi-theme": "dark" }, { "pi-theme": "dark" }), { "pi-theme": "pine" });
  assert.deepEqual(browserPreferencePatch({ "pi-theme": "dark", "pi-sound-enabled": "false" }, null, {}), { "pi-theme": "dark", "pi-sound-enabled": "false" });
});

test("late network reply preserves newer in-browser edits and excluded local storage", () => {
  const local = storage({ "pi-theme": "dark", "pi-sound-enabled": "true", "auth-token": "secret" });
  const sent = readBrowserPreferences(local);
  local.setItem("pi-theme", "pine");
  const server = { "pi-theme": "rose", "pi-sound-enabled": "false" };
  assert.equal(applySyncedBrowserPreferences(local, server, sent), true);
  assert.equal(local.getItem("pi-theme"), "pine");
  assert.equal(local.getItem("pi-sound-enabled"), "false");
  assert.equal(local.getItem("auth-token"), "secret");
  assert.deepEqual(browserPreferencePatch(readBrowserPreferences(local), readBrowserSyncBase(local), server), { "pi-theme": "pine" });
});

test("stale tabs cannot overwrite newer server preferences; independent changes merge", () => {
  assert.deepEqual(mergeBrowserPatch({ "pi-theme": "rose" }, { "pi-theme": "pine", "pi-sound-enabled": "false" }, { "pi-theme": "dark" }),
    { "pi-theme": "rose", "pi-sound-enabled": "false" });
});

test("first-visit offline edits survive reconnect and a page reload before any server response", () => {
  const local = storage({ "pi-theme": "light" });
  readBrowserInitialSnapshot(local, readBrowserPreferences(local));
  // Initial GET fails; the user changes theme and reloads while still offline.
  local.setItem("pi-theme", "pine");
  const current = readBrowserPreferences(local);
  const initial = readBrowserInitialSnapshot(local, current);
  const server = { "pi-theme": "dark" };
  const patch = browserPreferencePatch(current, readBrowserSyncBase(local), server, initial);
  assert.deepEqual(patch, { "pi-theme": "pine" });
  const accepted = mergeBrowserPatch(server, patch, server);
  applySyncedBrowserPreferences(local, accepted, current);
  assert.equal(local.getItem("pi-theme"), "pine");
});
