import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import lockfile from "proper-lockfile";
import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import {
  mergeSyncProfiles, npmPackageName, parseBrowserPreferences, parseRepository, parseSyncProfile, pinnedNpmPackage, sameValue,
  type BrowserPreferences, type ConfigSyncProfile,
} from "./config-sync-profile";
import { applyLocalProfile, captureLocalProfile, installedPluginVersion, localSettingsVersion, readJsonObject } from "./config-sync-local";
import { githubConfigRemote, type ConfigSyncRemote } from "./config-sync-remote";
import { stageSyncedPlugins, type PluginTransaction } from "./config-sync-plugins";
import { lockPluginOperations } from "./plugin-operation-lock";
import { invalidateModelsCache } from "./models-cache";

export interface ConfigSyncStatus {
  enabled: boolean;
  repository: string;
  browser: BrowserPreferences;
  lastSyncedAt?: string;
  error?: string;
  conflicts?: string[];
  busy?: boolean;
  revision?: string;
}
interface SyncState extends ConfigSyncStatus { base?: ConfigSyncProfile }
interface SyncDependencies {
  remote: ConfigSyncRemote;
  isBusy(): Promise<boolean>;
  preparePlugins(plugins: ConfigSyncProfile["plugins"]): Promise<PluginTransaction>;
  installedVersion?(source: string): string | null;
}
export type SyncAction = "sync" | "configure" | "browser";
export interface SyncRequest {
  action: SyncAction;
  enabled?: boolean;
  repository?: string;
  browser?: BrowserPreferences;
  browserBase?: BrowserPreferences;
  resolve?: "local" | "remote";
}

function statePath(agentDir: string): string { return join(agentDir, "pi-web-config-sync.json"); }

function readState(agentDir: string): SyncState {
  const stored = readJsonObject(statePath(agentDir));
  return {
    enabled: stored.enabled === true,
    repository: typeof stored.repository === "string" && stored.repository ? parseRepository(stored.repository) : "",
    browser: parseBrowserPreferences(stored.browser ?? {}),
    ...(stored.base ? { base: parseSyncProfile(stored.base) } : {}),
    ...(typeof stored.lastSyncedAt === "string" ? { lastSyncedAt: stored.lastSyncedAt } : {}),
    ...(typeof stored.error === "string" ? { error: stored.error } : {}),
    ...(Array.isArray(stored.conflicts) ? { conflicts: stored.conflicts.filter((value): value is string => typeof value === "string") } : {}),
    ...(stored.busy === true ? { busy: true } : {}),
    ...(typeof stored.revision === "string" ? { revision: stored.revision } : {}),
  };
}

function publicStatus(state: SyncState): ConfigSyncStatus {
  return {
    enabled: state.enabled, repository: state.repository, browser: state.browser,
    lastSyncedAt: state.lastSyncedAt, revision: state.revision,
    error: state.error, conflicts: state.conflicts, busy: state.busy,
  };
}

export function getConfigSyncStatus(agentDir = getAgentDir()): ConfigSyncStatus {
  return publicStatus(readState(agentDir));
}

function runtimePluginVersionReader(agentDir: string): (source: string) => string | null {
  let manager: DefaultPackageManager | undefined;
  return (source) => {
    const name = npmPackageName(source);
    if (!name) return null;
    const managed = installedPluginVersion(agentDir, name);
    if (managed) return managed;
    // Pi still supports user packages installed in the legacy global npm root.
    // Defer that (potentially slow) lookup until the managed path is missing.
    manager ??= new DefaultPackageManager({ cwd: agentDir, agentDir,
      settingsManager: SettingsManager.create(agentDir, agentDir, { projectTrusted: false }) });
    const installed = manager.getInstalledPath(source, "user");
    const metadata = installed ? readJsonObject(join(installed, "package.json")) : {};
    return typeof metadata.version === "string" ? metadata.version : null;
  };
}

function defaultDependencies(agentDir: string): SyncDependencies {
  return {
    remote: githubConfigRemote,
    async isBusy() {
      const { getRunningRpcSessionIds } = await import("./rpc-manager");
      return getRunningRpcSessionIds().length > 0;
    },
    async preparePlugins(plugins) {
      const { getRunningRpcSessionIds } = await import("./rpc-manager");
      return stageSyncedPlugins(agentDir, plugins, async (stagedAgentDir, source) => {
        // Only the local npm wrapper setting is needed to stage packages.
        const local = readJsonObject(join(agentDir, "settings.json"));
        writePrivateFileAtomicSync(join(stagedAgentDir, "settings.json"), JSON.stringify(local.npmCommand ? { npmCommand: local.npmCommand } : {}));
        const cwd = join(stagedAgentDir, "workspace");
        mkdirSync(cwd, { recursive: true });
        const settingsManager = SettingsManager.create(cwd, stagedAgentDir, { projectTrusted: false });
        const manager = new DefaultPackageManager({ cwd, agentDir: stagedAgentDir, settingsManager });
        await manager.install(source, { local: false });
      }, () => {
        if (getRunningRpcSessionIds().length) throw new Error("A task started during sync; plugin activation is deferred until idle");
      });
    },
  };
}

/** Purely field-wise browser merge, so a stale tab cannot overwrite another tab. */
export function mergeBrowserPatch(current: BrowserPreferences, patch: BrowserPreferences, base: BrowserPreferences): BrowserPreferences {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const name = key as keyof BrowserPreferences;
    if (current[name] !== undefined && !sameValue(current[name], base[name]) && !sameValue(current[name], value)) continue;
    next[name] = value;
  }
  return next;
}

export async function updateConfigSync(
  request: SyncRequest, agentDir = getAgentDir(), suppliedDependencies?: SyncDependencies,
): Promise<ConfigSyncStatus> {
  mkdirSync(agentDir, { recursive: true });
  const path = statePath(agentDir);
  const release = await lockfile.lock(path, { realpath: false, retries: { retries: 3, minTimeout: 100, maxTimeout: 500 } });
  try {
    const state = readState(agentDir);
    const save = () => writePrivateFileAtomicSync(path, JSON.stringify(state, null, 2));
    if (request.action === "configure") {
      if (typeof request.enabled !== "boolean") throw new Error("enabled must be a boolean");
      const repository = request.repository ? parseRepository(request.repository) : "";
      if (request.enabled && !repository) throw new Error("A private GitHub repository is required");
      if (state.repository !== repository) {
        delete state.base;
        delete state.lastSyncedAt;
      }
      state.repository = repository;
      state.enabled = request.enabled;
      delete state.error;
      delete state.conflicts;
      delete state.busy;
      save();
    }
    if (request.action === "browser") {
      state.browser = mergeBrowserPatch(state.browser, parseBrowserPreferences(request.browser ?? {}), parseBrowserPreferences(request.browserBase ?? {}));
      save();
      return publicStatus(state);
    }
    if (!state.enabled) return publicStatus(state);
    const dependencies = suppliedDependencies ?? defaultDependencies(agentDir);
    let releasePlugins: (() => Promise<void>) | undefined;
    try {
      releasePlugins = await lockPluginOperations(agentDir);
      const version = localSettingsVersion(agentDir);
      const installedVersion = dependencies.installedVersion ?? runtimePluginVersionReader(agentDir);
      const local = captureLocalProfile(agentDir, state.browser, installedVersion);
      const remote = await dependencies.remote.read(state.repository);
      const merged = state.base && remote.profile ? mergeSyncProfiles(state.base, local, remote.profile) : null;
      const conflicts = merged?.conflicts ?? [];
      let profile = merged?.profile ?? remote.profile ?? local;
      if (request.resolve && conflicts.length) {
        // A choice resolves only colliding fields. Independent edits still merge.
        const chosen = request.resolve === "local" ? local : remote.profile!;
        for (const key of conflicts) {
          if (key.startsWith("browser.")) {
            const browserKey = key.slice(8) as keyof BrowserPreferences;
            if (chosen.browser[browserKey] === undefined) delete profile.browser[browserKey];
            else profile.browser[browserKey] = chosen.browser[browserKey];
          } else Object.assign(profile, { [key]: chosen[key as keyof ConfigSyncProfile] });
        }
      } else if (conflicts.length) {
        state.conflicts = conflicts;
        state.error = "Settings changed on both computers. Choose which values to keep";
        save();
        return publicStatus(state);
      }
      profile = parseSyncProfile(profile);
      const missing = profile.plugins.filter((plugin) => {
        const pin = pinnedNpmPackage(plugin.source)!;
        return installedVersion(plugin.source) !== pin.version;
      });
      if (missing.length && await dependencies.isBusy()) {
        state.busy = true;
        state.error = "Waiting for active tasks to finish before updating plugins";
        save();
        return publicStatus(state);
      }
      const staged = missing.length ? await dependencies.preparePlugins(profile.plugins) : undefined;
      try {
        if (localSettingsVersion(agentDir) !== version || !sameValue(captureLocalProfile(agentDir, state.browser, installedVersion), local)) throw new Error("Local settings changed during sync; retry to merge the latest changes");
        // Optimistic SHA write rejects another device's intervening upload.
        // Staged npm writes are discarded if this request fails.
        if (!sameValue(profile, remote.profile)) await dependencies.remote.write(state.repository, profile, remote.sha);
        await applyLocalProfile(agentDir, version, profile, staged);
      } finally { await staged?.dispose(); }
      if (!sameValue(state.base, profile)) invalidateModelsCache();
      state.browser = profile.browser;
      state.base = profile;
      state.revision = createHash("sha256").update(JSON.stringify(profile)).digest("hex");
      state.lastSyncedAt = new Date().toISOString();
      delete state.error;
      delete state.conflicts;
      delete state.busy;
    } catch (error) {
      state.error = (error as NodeJS.ErrnoException).code === "ELOCKED" ? "Waiting for another plugin operation to finish"
        : error instanceof Error ? error.message : "Configuration sync failed";
    } finally { await releasePlugins?.(); }
    save();
    return publicStatus(state);
  } finally { await release(); }
}
