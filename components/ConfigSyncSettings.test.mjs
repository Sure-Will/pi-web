import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./ConfigSyncSettings.tsx", import.meta.url), "utf8");
const panelSource = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const locales = await Promise.all([
  readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/i18n/messages/zh-TW.ts", import.meta.url), "utf8"),
]);
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { getConfigSyncConflictLabel, isConfigSyncFormDirty } = await jiti.import("./ConfigSyncSettings.tsx");

test("embeds config sync in General and uses the config sync API contract", () => {
  assert.match(panelSource, /import \{ ConfigSyncSettings \} from "\.\/ConfigSyncSettings"/);
  assert.match(panelSource, /<ConfigSyncSettings \/>/);
  assert.match(source, /fetch\("\/api\/config-sync"\)/);
  assert.match(source, /method: "PUT"/);
  assert.match(source, /JSON\.stringify\(\{ enabled, repository: nextRepository \}\)/);
  assert.match(source, /body: JSON\.stringify\(resolve \? \{ action: "sync", resolve \} : \{ action: "sync" \}\)/);
});

test("refreshes the bridge without reloading the page and supports conflict choices", () => {
  assert.match(source, /CONFIG_SYNC_STATUS_EVENT/);
  assert.match(source, /CONFIG_SYNC_REFRESH_EVENT/);
  assert.match(source, /sync\("local"\)/);
  assert.match(source, /sync\("remote"\)/);
  assert.match(source, /settings\.configSyncFirstConnection/);
  assert.match(source, /settings\.configSyncSchedule/);
  assert.match(source, /settings\.configSyncReloadNote/);
  assert.match(panelSource, /CONFIG_SYNC_APPLIED_EVENT/);
  assert.match(panelSource, /window\.addEventListener\(CONFIG_SYNC_APPLIED_EVENT, readThinkingExpanded\)/);
  assert.match(panelSource, /setThinkingExpanded\(isThinkingExpandedByDefault\(\)\)/);
  assert.doesNotMatch(source, /window\.location\.(reload|replace)/);
});

test("keeps an unsaved repository or switch change dirty while status polling only updates status", () => {
  const saved = { repository: "owner/pi-config", enabled: true };
  assert.equal(isConfigSyncFormDirty("owner/pi-config", true, saved), false);
  assert.equal(isConfigSyncFormDirty("owner/other", true, saved), true);
  assert.equal(isConfigSyncFormDirty("owner/pi-config", false, saved), true);
  assert.match(source, /setStatus\(next\);\s*setLocalError\(null\);/);
  assert.match(source, /applyStatus\(next, nextOperation === "save"\)/);
  assert.match(source, /const formDirty = isConfigSyncFormDirty\(repository, enabled, status\)/);
  assert.match(source, /disabled=\{syncDisabled\}/);
});

test("maps internal browser conflict keys to readable labels", () => {
  const translated = new Map([
    ["settings.appearance", "Appearance"],
    ["settings.configSyncConflictSound", "Completion sound"],
  ]);
  const t = (key) => translated.get(key) ?? key;
  assert.equal(getConfigSyncConflictLabel("browser.pi-theme", t), "Appearance");
  assert.equal(getConfigSyncConflictLabel("browser.pi-sound-enabled", t), "Completion sound");
  assert.equal(getConfigSyncConflictLabel("browser.pi-chat-content-width", t), "settings.chatContentWidth");
});

test("keeps the sync controls readable on narrow screens", () => {
  assert.match(cssSource, /\.settings-config-sync \{[\s\S]*?max-width: 520px/);
  assert.match(cssSource, /\.settings-config-sync-input \{[\s\S]*?min-width: 0/);
  assert.match(cssSource, /@media \(max-width: 640px\)[\s\S]*?\.settings-config-sync-row \{[\s\S]*?align-items: flex-start/);
  assert.match(cssSource, /\.settings-config-sync-conflicts ul \{[\s\S]*?overflow-wrap: anywhere/);
});

test("provides every config sync translation in all built-in locales", () => {
  const keys = [
    "settings.configSync",
    "settings.configSyncDescription",
    "settings.configSyncScope",
    "settings.configSyncRepository",
    "settings.configSyncRepositoryPlaceholder",
    "settings.configSyncRepositoryHelp",
    "settings.configSyncRepositoryInvalid",
    "settings.configSyncEnabled",
    "settings.configSyncSchedule",
    "settings.configSyncFirstConnection",
    "settings.configSyncReloadNote",
    "settings.configSyncSave",
    "settings.configSyncSaving",
    "settings.configSyncSyncNow",
    "settings.configSyncSyncing",
    "settings.configSyncLastSynced",
    "settings.configSyncNever",
    "settings.configSyncConflicts",
    "settings.configSyncConflictDescription",
    "settings.configSyncConflictSound",
    "settings.configSyncConflictToolPreset",
    "settings.configSyncConflictModelThinking",
    "settings.configSyncConflictEnabledModels",
    "settings.configSyncKeepLocal",
    "settings.configSyncUseRemote",
    "settings.configSyncResolving",
  ];
  for (const locale of locales) {
    for (const key of keys) assert.match(locale, new RegExp(`"${key.replaceAll(".", "\\.")}":`));
  }
});
