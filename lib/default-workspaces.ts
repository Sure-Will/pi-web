import { readdirSync } from "fs";
import { join } from "path";

/** Keep runtime home discovery separate from filesystem operations so Next's
 * static asset tracer cannot mistake the user's home for deployable assets. */
export function listDefaultWorkspaces(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => /^pi-cwd-\d{8}$/.test(name))
    .map((name) => join(directory, name));
}
