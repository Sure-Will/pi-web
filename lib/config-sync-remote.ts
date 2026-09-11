import { execFile } from "node:child_process";
import { parseRepository, parseSyncProfile, type ConfigSyncProfile } from "./config-sync-profile";

export class ConfigSyncRemoteError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

/** gh keeps its own credentials; neither the browser nor the shared file gets a token. */
export function githubApi(path: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const args = ["api", "--hostname", "github.com", path];
    if (body !== undefined) args.push("--method", "PUT", "--input", "-");
    const child = execFile("gh", args, {
      windowsHide: true, timeout: 25_000, maxBuffer: 512 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    }, (error, stdout, stderr) => {
      if (error) {
        const match = /HTTP (\d{3})/.exec(stderr);
        const status = match ? Number(match[1]) : undefined;
        reject(new ConfigSyncRemoteError(status === 409 || status === 422
          ? "Remote configuration changed; sync again to merge it"
          : "Cannot access GitHub. Check the network, private repository access and gh auth login on this computer", status));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new ConfigSyncRemoteError("Invalid GitHub response")); }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export interface RemoteProfile { profile: ConfigSyncProfile | null; sha?: string }
export interface ConfigSyncRemote {
  read(repository: string): Promise<RemoteProfile>;
  write(repository: string, profile: ConfigSyncProfile, sha?: string): Promise<void>;
}

async function requirePrivate(repository: string, api: typeof githubApi): Promise<void> {
  const repo = await api(`repos/${parseRepository(repository)}`) as { private?: boolean; permissions?: { push?: boolean } };
  if (repo.private !== true) throw new ConfigSyncRemoteError("Configuration sync requires a private GitHub repository");
  if (repo.permissions?.push !== true) throw new ConfigSyncRemoteError("Write access to the configuration repository is required");
}

const filePath = (repository: string) => `repos/${parseRepository(repository)}/contents/pi-web-profile.json`;

export function createGithubConfigRemote(api = githubApi): ConfigSyncRemote { return {
  async read(repository) {
    await requirePrivate(repository, api);
    try {
      const file = await api(filePath(repository)) as { type?: string; encoding?: string; size?: number; content?: string; sha?: string };
      if (file.type !== "file" || file.encoding !== "base64" || !file.content || !file.sha || (file.size ?? Infinity) > 64 * 1024) throw new ConfigSyncRemoteError("Invalid or oversized configuration file");
      return { profile: parseSyncProfile(JSON.parse(Buffer.from(file.content, "base64").toString("utf8"))), sha: file.sha };
    } catch (error) {
      if (error instanceof ConfigSyncRemoteError && error.status === 404) return { profile: null };
      throw error;
    }
  },
  async write(repository, profile, sha) {
    await requirePrivate(repository, api);
    const content = Buffer.from(`${JSON.stringify(parseSyncProfile(profile), null, 2)}\n`).toString("base64");
    await api(filePath(repository), { message: "Update Pi Web personal settings", content, ...(sha ? { sha } : {}) });
  },
}; }

export const githubConfigRemote = createGithubConfigRemote();
