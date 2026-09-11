import { mkdirSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";

/** Serialize npm mutations and their settings writes across Pi Web workers. */
export async function lockPluginOperations(agentDir: string): Promise<() => Promise<void>> {
  mkdirSync(agentDir, { recursive: true });
  return lockfile.lock(join(agentDir, "pi-web-plugin-operations"), {
    realpath: false, retries: { retries: 4, minTimeout: 100, maxTimeout: 400 },
  });
}
