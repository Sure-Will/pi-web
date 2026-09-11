/** The complete cross-device allow-list. Never serialize a Pi settings object. */
export const SYNC_BROWSER_KEYS = [
  "pi-theme", "pi-sound-enabled", "pi-tool-preset", "pi-thinking-level",
  "pi-thinking-expanded", "pi-chat-content-width", "pi-chat-content-font-size",
  "pi-locale", "pi-quote-selection-enabled",
] as const;
export type SyncBrowserKey = typeof SYNC_BROWSER_KEYS[number];
export type BrowserPreferences = Partial<Record<SyncBrowserKey, string | null>>;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const NPM_NAME = "(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*";
const PINNED_NPM = new RegExp(`^npm:(${NPM_NAME})@(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?)$`);
const NPM_SOURCE = new RegExp(`^npm:(${NPM_NAME})(?:@[^\\s]+)?$`);

export interface SyncedPlugin {
  source: string;
  autoload?: boolean;
  /** null = all extensions; [] = disabled. Skills/prompts/themes stay local. */
  extensions: string[] | null;
}

export interface ConfigSyncProfile {
  version: 1;
  model: { provider: string; modelId: string } | null;
  thinkingLevel: string | null;
  modelThinkingLevels: Record<string, string>;
  enabledModels: string[] | null;
  builtInSubagents: boolean;
  plugins: SyncedPlugin[];
  browser: BrowserPreferences;
}

export function npmPackageName(source: string): string | null {
  return NPM_SOURCE.exec(source)?.[1] ?? null;
}

export function pinnedNpmPackage(source: string): { name: string; version: string } | null {
  const match = PINNED_NPM.exec(source);
  return match ? { name: match[1], version: match[2] } : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plainString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);
}

function stringList(value: unknown, max = 100): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(plainString);
}

export function parseBrowserPreferences(value: unknown): BrowserPreferences {
  if (!isRecord(value)) throw new Error("Invalid browser preferences");
  const result: BrowserPreferences = {};
  for (const [key, item] of Object.entries(value)) {
    if (!(SYNC_BROWSER_KEYS as readonly string[]).includes(key)) throw new Error(`Unsupported browser preference: ${key}`);
    const allowed = item === null || (
      key === "pi-theme" ? ["auto", "light", "dark", "mist", "rose", "pine"].includes(String(item)) :
      key === "pi-tool-preset" ? ["none", "read-only", "default", "full"].includes(String(item)) :
      key === "pi-thinking-level" ? ["auto", ...THINKING_LEVELS].includes(String(item)) :
      key === "pi-locale" ? ["en", "zh-CN", "zh-TW"].includes(String(item)) :
      key === "pi-chat-content-width" ? typeof item === "string" && /^\d+$/.test(item) && Number(item) >= 820 && Number(item) <= 2000 :
      key === "pi-chat-content-font-size" ? typeof item === "string" && /^\d+$/.test(item) && Number(item) >= 12 && Number(item) <= 24 :
      item === "true" || item === "false"
    );
    if (!allowed || (item !== null && typeof item !== "string")) throw new Error(`Invalid browser preference: ${key}`);
    result[key as SyncBrowserKey] = item as string | null;
  }
  return result;
}

export function parseSyncProfile(value: unknown): ConfigSyncProfile {
  if (!isRecord(value) || value.version !== 1) throw new Error("Unsupported config sync profile version");
  const keys = ["version", "model", "thinkingLevel", "modelThinkingLevels", "enabledModels", "builtInSubagents", "plugins", "browser"];
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Unexpected field in config sync profile");
  const model = value.model;
  if (model !== null && (!isRecord(model) || !plainString(model.provider) || !plainString(model.modelId)
    || Object.keys(model).some((key) => !["provider", "modelId"].includes(key)))) throw new Error("Invalid default model");
  if (value.thinkingLevel !== null && !THINKING_LEVELS.includes(String(value.thinkingLevel))) throw new Error("Invalid thinking level");
  if (!isRecord(value.modelThinkingLevels) || Object.keys(value.modelThinkingLevels).length > 200
    || Object.entries(value.modelThinkingLevels).some(([key, level]) => !plainString(key) || typeof level !== "string" || !THINKING_LEVELS.includes(level))) throw new Error("Invalid model thinking levels");
  if (value.enabledModels !== null && !stringList(value.enabledModels)) throw new Error("Invalid model scope");
  if (typeof value.builtInSubagents !== "boolean") throw new Error("Invalid subagent setting");
  if (!Array.isArray(value.plugins) || value.plugins.length > 100) throw new Error("Invalid plugins");
  const seen = new Set<string>();
  const plugins: SyncedPlugin[] = value.plugins.map((item) => {
    if (!isRecord(item) || typeof item.source !== "string" || Object.keys(item).some((key) => !["source", "extensions", "autoload"].includes(key))) throw new Error("Invalid plugin");
    if (item.autoload !== undefined && typeof item.autoload !== "boolean") throw new Error("Invalid plugin autoload setting");
    const pin = pinnedNpmPackage(item.source);
    if (!pin || seen.has(pin.name)) throw new Error("Plugins must have unique names and exact npm versions");
    seen.add(pin.name);
    if (item.extensions !== null && (!stringList(item.extensions) || item.extensions.some((filter) => {
      const path = filter.replace(/^[!+-]/, "");
      return path.includes("\\") || path.includes(":") || path.startsWith("/") || path.startsWith("~") || path.split("/").includes("..");
    }))) throw new Error("Plugin filters must use package-relative paths");
    return { source: item.source, extensions: item.extensions as string[] | null, ...(item.autoload === false ? { autoload: false } : {}) };
  });
  return {
    version: 1, model: model === null ? null : { provider: (model as Record<string, string>).provider, modelId: (model as Record<string, string>).modelId },
    thinkingLevel: value.thinkingLevel as string | null,
    modelThinkingLevels: Object.fromEntries(Object.entries(value.modelThinkingLevels).sort(([a], [b]) => a.localeCompare(b))) as Record<string, string>,
    enabledModels: value.enabledModels as string[] | null,
    builtInSubagents: value.builtInSubagents,
    plugins: plugins.sort((a, b) => a.source.localeCompare(b.source)),
    browser: parseBrowserPreferences(value.browser),
  };
}

export function sameValue(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Merge independent edits; never resolve overlapping edits with device clocks. */
export function mergeSyncProfiles(base: ConfigSyncProfile, local: ConfigSyncProfile, remote: ConfigSyncProfile): { profile: ConfigSyncProfile; conflicts: string[] } {
  const result = structuredClone(local);
  const conflicts: string[] = [];
  const merge = (key: string, before: unknown, ours: unknown, theirs: unknown) => {
    if (sameValue(ours, before) || sameValue(ours, theirs)) return theirs;
    if (!sameValue(theirs, before)) conflicts.push(key);
    return ours;
  };
  for (const key of ["model", "thinkingLevel", "modelThinkingLevels", "enabledModels", "builtInSubagents", "plugins"] as const) {
    // Each model/provider pair and plugin set is an atomic setting.
    Object.assign(result, { [key]: merge(key, base[key], local[key], remote[key]) });
  }
  result.browser = {};
  for (const key of SYNC_BROWSER_KEYS) {
    const value = merge(`browser.${key}`, base.browser[key], local.browser[key], remote.browser[key]);
    if (value !== undefined) result.browser[key] = value as string | null;
  }
  return { profile: parseSyncProfile(result), conflicts };
}

export function parseRepository(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value)
    || value.endsWith("/.") || value.endsWith("/..")) throw new Error("Use a GitHub repository in owner/repo format");
  return value;
}
