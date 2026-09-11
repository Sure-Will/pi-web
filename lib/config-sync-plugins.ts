import { cp, mkdtemp, rm } from "node:fs/promises";
import { existsSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { installedPluginVersion } from "./config-sync-local";
import { pinnedNpmPackage, type SyncedPlugin } from "./config-sync-profile";

export interface PluginTransaction {
  activate(): void;
  rollback(): void;
  dispose(): Promise<void>;
}

/** npm installs can partially succeed. Keep every such write in a disposable
 * copy until the whole set is verified and the shared profile is accepted. */
export async function stageSyncedPlugins(
  agentDir: string,
  plugins: SyncedPlugin[],
  install: (stagedAgentDir: string, source: string) => Promise<void>,
  assertIdle: () => void,
): Promise<PluginTransaction> {
  const root = resolve(agentDir);
  const live = join(root, "npm");
  if (existsSync(live) && lstatSync(live).isSymbolicLink()) throw new Error("Cannot update a linked npm directory through config sync");
  mkdirSync(root, { recursive: true });
  const stage = await mkdtemp(join(root, ".pi-web-config-sync-"));
  const candidate = join(stage, "npm");
  const backup = join(stage, "previous-npm");
  let activated = false;
  let movedPrevious = false;
  let recoveryRequired = false;
  const dispose = async () => {
    if (dirname(stage) !== root || !basename(stage).startsWith(".pi-web-config-sync-")) throw new Error("Invalid plugin staging directory");
    if (recoveryRequired) throw new Error(`Plugin rollback needs attention. The backup is preserved in ${stage}`);
    await rm(stage, { recursive: true, force: true });
  };
  try {
    if (existsSync(live)) await cp(live, candidate, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    for (const plugin of plugins) {
      const pin = pinnedNpmPackage(plugin.source)!;
      if (installedPluginVersion(stage, pin.name) !== pin.version) await install(stage, plugin.source);
      if (installedPluginVersion(stage, pin.name) !== pin.version) throw new Error(`Plugin version verification failed: ${pin.name}`);
    }
    return {
      activate() {
        assertIdle();
        if (existsSync(live)) { renameSync(live, backup); movedPrevious = true; }
        try { renameSync(candidate, live); activated = true; }
        catch (error) {
          recoveryRequired = true;
          if (movedPrevious) { renameSync(backup, live); movedPrevious = false; }
          recoveryRequired = false;
          throw error;
        }
      },
      rollback() {
        recoveryRequired = true;
        if (activated) { renameSync(live, candidate); activated = false; }
        if (movedPrevious) { renameSync(backup, live); movedPrevious = false; }
        recoveryRequired = false;
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
