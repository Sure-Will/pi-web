import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const before = process.env.PI_CODING_AGENT_DIR;
const root = await mkdtemp(join(tmpdir(), "pi-web-config-sync-route-"));
process.env.PI_CODING_AGENT_DIR = root;
const { GET, PUT, POST } = await createJiti(import.meta.url, { alias: { "@": process.cwd() } }).import("./route.ts");
after(async () => {
  if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before;
  await rm(root, { recursive: true, force: true });
});
const request = (method, body, headers = {}) => new Request("http://localhost/api/config-sync", {
  method, headers: { Host: "localhost", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
});

test("sync is opt-in and GET exposes neither merge base nor credentials", async () => {
  const response = await GET();
  assert.deepEqual(await response.json(), { enabled: false, repository: "", browser: {} });
  assert.match(response.headers.get("Cache-Control"), /no-store/);
});

test("configuration mutation rejects cross-origin, non-JSON, invalid repository and arbitrary preference keys", async () => {
  assert.equal((await PUT(request("PUT", { enabled: true, repository: "owner/repo" }, { Origin: "https://evil.test" }))).status, 403);
  assert.equal((await PUT(request("PUT", {}, { "Content-Type": "text/plain" }))).status, 415);
  assert.equal((await PUT(request("PUT", { enabled: true, repository: "https://github.com/owner/repo" }))).status, 400);
  assert.equal((await POST(request("POST", { action: "browser", browser: { "session-token": "secret" } }))).status, 400);
  assert.equal((await POST(request("POST", { action: "sync", resolve: "force" }))).status, 400);
});

test("browser preferences persist locally while remote sync is disabled", async () => {
  const response = await POST(request("POST", { action: "browser", browser: { "pi-theme": "pine" }, browserBase: {} }));
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.enabled, false);
  assert.deepEqual(status.browser, { "pi-theme": "pine" });
  assert.equal(status.base, undefined);
  const disabled = await PUT(request("PUT", { enabled: false, repository: "" }));
  assert.equal(disabled.status, 200);
});
