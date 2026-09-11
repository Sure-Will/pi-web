import { parseBrowserPreferences, sameValue, SYNC_BROWSER_KEYS, type BrowserPreferences } from "./config-sync-profile";

export const CONFIG_SYNC_APPLIED_EVENT = "pi-config-sync-applied";
export const CONFIG_SYNC_STATUS_EVENT = "pi-config-sync-status";
export const CONFIG_SYNC_REFRESH_EVENT = "pi-config-sync-refresh";
const BASE_KEY = "pi-config-sync-browser-base";
const INITIAL_KEY = "pi-config-sync-browser-initial";

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readBrowserPreferences(storage: PreferenceStorage): BrowserPreferences {
  const result: BrowserPreferences = {};
  for (const key of SYNC_BROWSER_KEYS) {
    const value = storage.getItem(key);
    try { Object.assign(result, parseBrowserPreferences({ [key]: value })); }
    catch { result[key] = null; }
  }
  return result;
}

export function readBrowserSyncBase(storage: PreferenceStorage): BrowserPreferences | null {
  try {
    const value = storage.getItem(BASE_KEY);
    return value ? parseBrowserPreferences(JSON.parse(value)) : null;
  } catch { return null; }
}

/** Retain the pre-connection snapshot so edits made during the first offline
 * visit are distinguishable from a new browser's existing defaults. */
export function readBrowserInitialSnapshot(storage: PreferenceStorage, current: BrowserPreferences): BrowserPreferences {
  const saved = storage.getItem(INITIAL_KEY);
  if (saved) {
    try { return parseBrowserPreferences(JSON.parse(saved)); } catch { /* Replace corrupt metadata. */ }
  }
  storage.setItem(INITIAL_KEY, JSON.stringify(current));
  return current;
}

/** The first browser adopts the server. Later offline edits retain their base. */
export function browserPreferencePatch(current: BrowserPreferences, base: BrowserPreferences | null, server: BrowserPreferences, initial?: BrowserPreferences): BrowserPreferences {
  const patch: BrowserPreferences = {};
  for (const key of SYNC_BROWSER_KEYS) {
    if (base && !sameValue(current[key] ?? null, base[key] ?? null)) patch[key] = current[key] ?? null;
    else if (!base && initial && !sameValue(current[key] ?? null, initial[key] ?? null)) patch[key] = current[key] ?? null;
    else if (server[key] === undefined && current[key] != null) patch[key] = current[key];
  }
  return patch;
}

/** Don't overwrite an edit made while the network request was in flight. */
export function applySyncedBrowserPreferences(storage: PreferenceStorage, server: BrowserPreferences, sent: BrowserPreferences): boolean {
  let changed = false;
  for (const key of SYNC_BROWSER_KEYS) {
    if (server[key] === undefined || storage.getItem(key) !== (sent[key] ?? null)) continue;
    const value = server[key] ?? null;
    if (storage.getItem(key) === value) continue;
    if (value === null) storage.removeItem(key); else storage.setItem(key, value);
    changed = true;
  }
  storage.setItem(BASE_KEY, JSON.stringify(server));
  storage.removeItem(INITIAL_KEY);
  return changed;
}
