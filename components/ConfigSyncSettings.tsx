"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ConfigSyncStatus } from "@/lib/config-sync";
import { CONFIG_SYNC_REFRESH_EVENT, CONFIG_SYNC_STATUS_EVENT } from "@/lib/config-sync-browser";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";

export type SyncStatus = ConfigSyncStatus;

type SyncOperation = "save" | "sync" | "local" | "remote" | null;
type Translate = (key: string) => string;

const EMPTY_STATUS: SyncStatus = {
  enabled: false,
  repository: "",
  browser: {},
};

const CONFIG_SYNC_CONFLICT_LABEL_KEYS: Record<string, string> = {
  "browser.pi-theme": "settings.appearance",
  "browser.pi-sound-enabled": "settings.configSyncConflictSound",
  "browser.pi-tool-preset": "settings.configSyncConflictToolPreset",
  "browser.pi-thinking-level": "agents.thinking",
  "browser.pi-thinking-expanded": "settings.thinkingExpandedDefault",
  "browser.pi-chat-content-width": "settings.chatContentWidth",
  "browser.pi-chat-content-font-size": "settings.chatContentFontSize",
  "browser.pi-locale": "common.language",
  "browser.pi-quote-selection-enabled": "settings.quoteSelection",
  model: "common.models",
  thinkingLevel: "agents.thinking",
  modelThinkingLevels: "settings.configSyncConflictModelThinking",
  enabledModels: "settings.configSyncConflictEnabledModels",
  builtInSubagents: "common.agents",
  plugins: "common.plugins",
};

export function isConfigSyncFormDirty(repository: string, enabled: boolean, saved: Pick<SyncStatus, "repository" | "enabled">): boolean {
  return repository.trim() !== saved.repository || enabled !== saved.enabled;
}

export function getConfigSyncConflictLabel(conflict: string, t: Translate): string {
  const key = CONFIG_SYNC_CONFLICT_LABEL_KEYS[conflict];
  if (key) return t(key);
  const field = conflict.startsWith("browser.") ? conflict.slice("browser.".length) : conflict;
  return field.replace(/[._-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function isConfigSyncStatus(value: unknown): value is SyncStatus {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SyncStatus>;
  return typeof candidate.enabled === "boolean"
    && typeof candidate.repository === "string"
    && !!candidate.browser
    && typeof candidate.browser === "object"
    && (!candidate.conflicts || Array.isArray(candidate.conflicts));
}

async function readStatus(response: Response): Promise<SyncStatus> {
  const data = await response.json() as Partial<SyncStatus> & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  if (!isConfigSyncStatus(data)) throw new Error("Invalid config sync status");
  return data;
}

function formatTimestamp(value: string | undefined, locale: string, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function isRepository(value: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/.test(value.trim());
}

export function ConfigSyncSettings() {
  const { locale, t } = useI18n();
  const [status, setStatus] = useState<SyncStatus>(EMPTY_STATUS);
  const [repository, setRepository] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<SyncOperation>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const applyStatus = (next: SyncStatus, updateForm: boolean) => {
    setStatus(next);
    if (updateForm) {
      setRepository(next.repository);
      setEnabled(next.enabled);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/config-sync")
      .then(readStatus)
      .then((next) => {
        if (!cancelled) {
          applyStatus(next, true);
          setLocalError(null);
        }
      })
      .catch((cause) => {
        if (!cancelled) setLocalError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handleStatus = (event: Event) => {
      const next = (event as CustomEvent<unknown>).detail;
      if (!isConfigSyncStatus(next)) return;
      setStatus(next);
      setLocalError(null);
    };
    window.addEventListener(CONFIG_SYNC_STATUS_EVENT, handleStatus);
    return () => window.removeEventListener(CONFIG_SYNC_STATUS_EVENT, handleStatus);
  }, []);

  const formDirty = isConfigSyncFormDirty(repository, enabled, status);
  const formBusy = loading || operation !== null;
  const syncDisabled = formBusy
    || status.busy === true
    || formDirty
    || !status.enabled
    || !status.repository.trim();
  const conflicts = useMemo(() => status.conflicts?.filter(Boolean) ?? [], [status.conflicts]);

  const request = async (nextOperation: Exclude<SyncOperation, null>, init: RequestInit) => {
    setOperation(nextOperation);
    setLocalError(null);
    try {
      const next = await readStatus(await fetch("/api/config-sync", init));
      applyStatus(next, nextOperation === "save");
      window.dispatchEvent(new Event(CONFIG_SYNC_REFRESH_EVENT));
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOperation(null);
    }
  };

  const save = () => {
    const nextRepository = repository.trim();
    if (enabled && !isRepository(nextRepository)) {
      setLocalError(t("settings.configSyncRepositoryInvalid"));
      return;
    }
    void request("save", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, repository: nextRepository }),
    });
  };

  const sync = (resolve?: "local" | "remote") => {
    void request(resolve ?? "sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(resolve ? { action: "sync", resolve } : { action: "sync" }),
    });
  };

  return (
    <section className="settings-general-section settings-config-sync-section">
      <h3 className="settings-general-heading">{t("settings.configSync")}</h3>
      <p className="settings-general-description">{t("settings.configSyncDescription")}</p>
      <div className="settings-config-sync">
        <p className="settings-config-sync-scope">{t("settings.configSyncScope")}</p>

        <div className="settings-config-sync-field">
          <label className="settings-config-sync-label" htmlFor="settings-config-sync-repository">
            {t("settings.configSyncRepository")}
          </label>
          <input
            id="settings-config-sync-repository"
            className="settings-config-sync-input"
            type="text"
            value={repository}
            placeholder={t("settings.configSyncRepositoryPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setRepository(event.target.value)}
            disabled={formBusy}
          />
          <p className="settings-config-sync-help">{t("settings.configSyncRepositoryHelp")}</p>
        </div>

        <div className="settings-config-sync-row">
          <div className="settings-config-sync-row-copy">
            <span>{t("settings.configSyncEnabled")}</span>
            <span className="settings-config-sync-help">{t("settings.configSyncSchedule")}</span>
          </div>
          <ConfigSwitch
            checked={enabled}
            loading={formBusy}
            label={t("settings.configSyncEnabled")}
            onChange={setEnabled}
          />
        </div>

        <p className="settings-config-sync-note">{t("settings.configSyncFirstConnection")}</p>
        <p className="settings-config-sync-note">{t("settings.configSyncReloadNote")}</p>

        <div className="settings-config-sync-actions">
          <ConfigButton variant="primary" onClick={save} disabled={formBusy}>
            {operation === "save" ? t("settings.configSyncSaving") : t("settings.configSyncSave")}
          </ConfigButton>
          <ConfigButton variant="secondary" onClick={() => sync()} disabled={syncDisabled}>
            {operation === "sync" ? t("settings.configSyncSyncing") : t("settings.configSyncSyncNow")}
          </ConfigButton>
        </div>

        <div className="settings-config-sync-status" aria-live="polite">
          <div className="settings-config-sync-status-row">
            <span>{t("settings.configSyncLastSynced")}</span>
            {status.lastSyncedAt ? (
              <time dateTime={status.lastSyncedAt}>{formatTimestamp(status.lastSyncedAt, locale, t("settings.configSyncNever"))}</time>
            ) : (
              <span>{t("settings.configSyncNever")}</span>
            )}
          </div>
          {(localError ?? status.error) && <p role="alert" className="settings-general-error">{localError ?? status.error}</p>}
        </div>

        {conflicts.length > 0 && (
          <div className="settings-config-sync-conflicts" role="group" aria-label={t("settings.configSyncConflicts")}>
            <strong>{t("settings.configSyncConflicts")}</strong>
            <p className="settings-config-sync-help">{t("settings.configSyncConflictDescription")}</p>
            <ul>
              {conflicts.map((conflict) => <li key={conflict}>{getConfigSyncConflictLabel(conflict, t)}</li>)}
            </ul>
            <div className="settings-config-sync-actions">
              <ConfigButton variant="secondary" onClick={() => sync("local")} disabled={formBusy || status.busy === true || formDirty}>
                {operation === "local" ? t("settings.configSyncResolving") : t("settings.configSyncKeepLocal")}
              </ConfigButton>
              <ConfigButton variant="secondary" onClick={() => sync("remote")} disabled={formBusy || status.busy === true || formDirty}>
                {operation === "remote" ? t("settings.configSyncResolving") : t("settings.configSyncUseRemote")}
              </ConfigButton>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
