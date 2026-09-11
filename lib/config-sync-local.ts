import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import type { PluginTransaction } from "./config-sync-plugins";
import {
  isRecord, npmPackageName, parseSyncProfile, pinnedNpmPackage, sameValue,
  type BrowserPreferences, type ConfigSyncProfile,
} from "./config-sync-profile";

export function readJsonObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  if (!isRecord(parsed)) throw new Error(`Invalid configuration: ${file.split(/[\\/]/).pop()}`);
  return parsed;
}

export function installedPluginVersion(agentDir: string, name: string): string | null {
  const pkg = readJsonObject(join(agentDir, "npm", "node_modules", ...name.split("/"), "package.json"));
  return typeof pkg.version === "string" ? pkg.version : null;
}

export function localSettingsVersion(agentDir: string): string {
  return createHash("sha256").update(JSON.stringify([
    readJsonObject(join(agentDir, "settings.json")), readJsonObject(join(agentDir, "agents", "settings.json")),
  ])).digest("hex");
}

export function captureLocalProfile(agentDir: string, browser: BrowserPreferences, resolveVersion?: (source: string) => string | null): ConfigSyncProfile {
  const settings = readJsonObject(join(agentDir, "settings.json"));
  const subagents = readJsonObject(join(agentDir, "agents", "settings.json"));
  if (settings.packages !== undefined && !Array.isArray(settings.packages)) throw new Error("Invalid Pi packages setting");
  const plugins = (settings.packages as unknown[] ?? []).flatMap((entry) => {
    const source = typeof entry === "string" ? entry : isRecord(entry) ? entry.source : null;
    if (typeof source !== "string") throw new Error("Invalid Pi package entry");
    const name = npmPackageName(source);
    if (!name) return []; // Local paths and git resources are machine-owned.
    const version = pinnedNpmPackage(source)?.version ?? installedPluginVersion(agentDir, name) ?? resolveVersion?.(source);
    if (!version) throw new Error(`Install ${name} before syncing its version`);
    return [{ source: `npm:${name}@${version}`, extensions: isRecord(entry) ? entry.extensions ?? null : null,
      ...(isRecord(entry) && entry.autoload === false ? { autoload: false } : {}) }];
  });
  return parseSyncProfile({
    version: 1,
    model: typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string"
      ? { provider: settings.defaultProvider, modelId: settings.defaultModel } : null,
    thinkingLevel: settings.defaultThinkingLevel ?? null,
    modelThinkingLevels: settings.modelThinkingLevels ?? {},
    enabledModels: settings.enabledModels ?? null,
    builtInSubagents: subagents.builtInEnabled === true,
    plugins, browser,
  });
}

/** Keep local paths, credentials, shell choice and resource filters out of sync. */
export function applyProfileToSettings(settings: Record<string, unknown>, profile: ConfigSyncProfile): Record<string, unknown> {
  const next = { ...settings };
  if (profile.model) {
    next.defaultProvider = profile.model.provider;
    next.defaultModel = profile.model.modelId;
  } else {
    delete next.defaultProvider;
    delete next.defaultModel;
  }
  for (const [key, value] of [["defaultThinkingLevel", profile.thinkingLevel], ["enabledModels", profile.enabledModels]] as const) {
    if (value === null) delete next[key]; else next[key] = value;
  }
  next.modelThinkingLevels = profile.modelThinkingLevels;
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const sourceOf = (entry: unknown) => typeof entry === "string" ? entry : isRecord(entry) && typeof entry.source === "string" ? entry.source : "";
  const localByName = new Map(packages.map((entry) => [npmPackageName(sourceOf(entry)), entry]));
  const localResources = packages.filter((entry) => !npmPackageName(sourceOf(entry)));
  next.packages = [...localResources, ...profile.plugins.map((plugin) => {
    const existing = localByName.get(pinnedNpmPackage(plugin.source)!.name);
    // New synced packages load extensions only. Existing skills/prompts/themes
    // selections remain exactly as the user configured them on this machine.
    const result: Record<string, unknown> = isRecord(existing) ? { ...existing } : existing
      ? {} : { skills: [], prompts: [], themes: [] };
    result.source = plugin.source;
    if (plugin.autoload === false) result.autoload = false;
    else delete result.autoload;
    if (plugin.extensions === null) delete result.extensions;
    else result.extensions = plugin.extensions;
    return Object.keys(result).length === 1 ? plugin.source : result;
  })];
  return next;
}

/** Lock the same files as Pi's settings writer and compare before applying. */
export async function applyLocalProfile(
  agentDir: string, expectedVersion: string, next: ConfigSyncProfile, plugins?: PluginTransaction,
): Promise<void> {
  const settingsPath = join(agentDir, "settings.json");
  const subagentPath = join(agentDir, "agents", "settings.json");
  mkdirSync(dirname(subagentPath), { recursive: true });
  const releaseSettings = await lockfile.lock(settingsPath, { realpath: false, retries: 3 });
  try {
    const releaseSubagents = await lockfile.lock(subagentPath, { realpath: false, retries: 3 });
    try {
      if (localSettingsVersion(agentDir) !== expectedVersion) throw new Error("Local settings changed during sync; retry to merge the latest changes");
      const settings = readJsonObject(settingsPath);
      const subagents = readJsonObject(subagentPath);
      const updatedSettings = applyProfileToSettings(settings, next);
      const updatedSubagents = { ...subagents, version: 1, builtInEnabled: next.builtInSubagents };
      // A local backup contains only these two configuration files. It is never uploaded.
      const backup = join(agentDir, "pi-web-config-sync-backup.json");
      if (!sameValue(settings, updatedSettings) || !sameValue(subagents, updatedSubagents)) {
        writePrivateFileAtomicSync(backup, JSON.stringify({ settings, subagents }, null, 2));
      }
      try {
        plugins?.activate();
        if (!sameValue(settings, updatedSettings) || !sameValue(subagents, updatedSubagents)) {
          writePrivateFileAtomicSync(settingsPath, JSON.stringify(updatedSettings, null, 2));
          writePrivateFileAtomicSync(subagentPath, JSON.stringify(updatedSubagents, null, 2));
        }
      } catch (error) {
        plugins?.rollback();
        // These writes are still under the same configuration locks.
        writePrivateFileAtomicSync(settingsPath, JSON.stringify(settings, null, 2));
        writePrivateFileAtomicSync(subagentPath, JSON.stringify(subagents, null, 2));
        throw error;
      }
    } finally { await releaseSubagents(); }
  } finally { await releaseSettings(); }
}
