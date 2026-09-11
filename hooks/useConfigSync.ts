"use client";

import { useEffect } from "react";
import type { ConfigSyncStatus } from "@/lib/config-sync";
import { sameValue, type BrowserPreferences } from "@/lib/config-sync-profile";
import { THINKING_EXPANDED_EVENT } from "@/lib/thinking-expansion-preference";
import {
  applySyncedBrowserPreferences, browserPreferencePatch, CONFIG_SYNC_APPLIED_EVENT,
  CONFIG_SYNC_REFRESH_EVENT, CONFIG_SYNC_STATUS_EVENT, readBrowserPreferences, readBrowserSyncBase,
  readBrowserInitialSnapshot,
} from "@/lib/config-sync-browser";

/** One bridge per app shell. No credentials or non-allowlisted storage leave it. */
export function useConfigSync() {
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let nextRemoteSync = 0;
    let status: ConfigSyncStatus | null = null;
    let observed: BrowserPreferences | null = null;
    let appliedRevision: string | undefined;

    const request = async (body?: unknown): Promise<ConfigSyncStatus> => {
      const response = await fetch("/api/config-sync", body ? {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      } : { cache: "no-store" });
      const data = await response.json() as ConfigSyncStatus;
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      return data;
    };

    const tick = async (force = false) => {
      if (disposed || inFlight || document.visibilityState === "hidden") return;
      let storage: Storage;
      let current: BrowserPreferences;
      let initial: BrowserPreferences;
      try {
        storage = window.localStorage;
        current = readBrowserPreferences(storage);
        initial = readBrowserInitialSnapshot(storage, current);
      } catch { return; }
      if (!force && observed && sameValue(observed, current) && Date.now() < nextRemoteSync) return;
      inFlight = true;
      try {
        if (!status || force) status = await request();
        const base = readBrowserSyncBase(storage);
        const patch = browserPreferencePatch(current, base, status.browser, initial);
        if (Object.keys(patch).length) status = await request({ action: "browser", browser: patch, browserBase: base ?? status.browser });
        if (status.enabled && (force || Date.now() >= nextRemoteSync || Object.keys(patch).length)) {
          status = await request({ action: "sync" });
        } else if (Date.now() >= nextRemoteSync) {
          status = await request();
        }
        nextRemoteSync = Date.now() + 30_000;
        if (disposed) return;
        const changed = applySyncedBrowserPreferences(storage, status.browser, current);
        // Remember the sent snapshot if a user edited during the request, so
        // the next tick uploads that edit rather than treating it as observed.
        observed = { ...current };
        for (const key of Object.keys(status.browser) as Array<keyof BrowserPreferences>) {
          if (storage.getItem(key) === (status.browser[key] ?? null)) observed[key] = status.browser[key];
        }
        if (changed || status.revision !== appliedRevision) {
          window.dispatchEvent(new Event(CONFIG_SYNC_APPLIED_EVENT));
          window.dispatchEvent(new Event(THINKING_EXPANDED_EVENT));
        }
        appliedRevision = status.revision;
        window.dispatchEvent(new CustomEvent(CONFIG_SYNC_STATUS_EVENT, { detail: status }));
      } catch (error) {
        nextRemoteSync = Date.now() + 30_000;
        observed = current;
        window.dispatchEvent(new CustomEvent(CONFIG_SYNC_STATUS_EVENT, { detail: {
          ...(status ?? { enabled: false, repository: "", browser: {} }),
          error: error instanceof Error ? error.message : "Configuration sync failed",
        } }));
      } finally { inFlight = false; }
    };
    const refresh = () => { nextRemoteSync = 0; void tick(true); };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, 1000);
    window.addEventListener(CONFIG_SYNC_REFRESH_EVENT, refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener(CONFIG_SYNC_REFRESH_EVENT, refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
}
