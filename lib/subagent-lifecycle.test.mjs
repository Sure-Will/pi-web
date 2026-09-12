import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-lifecycle-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const jiti = createJiti(import.meta.url);
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { SubagentQueue } = await jiti.import("./subagent-queue.ts");
const { writeSubagentMaxConcurrent } = await jiti.import("./subagent-settings.ts");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
writeSubagentMaxConcurrent(1);
after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  delete globalThis.__piSubagentRuns;
  delete globalThis.__piSubagentQueue;
  delete globalThis.__piSubagentResumeLocks;
  await rm(root, { recursive: true, force: true });
});
const flush = () => new Promise(setImmediate);

async function fixture(status, live = false) {
  globalThis.__piSubagentRuns = new Map();
  globalThis.__piSubagentQueue = new SubagentQueue();
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });
  const manager = SessionManager.create(cwd, join(root, "sessions"));
  manager.appendCustomEntry("pi-web:subagent", { version: 1, parentSessionId: "parent", parentSessionPath: join(root, "parent.jsonl"),
    profile: "explore", parentToolCallId: "old", task: "initial", description: "Initial", createdAt: new Date().toISOString() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Checkpoint" }], timestamp: Date.now() });
  manager.appendCustomEntry(status === "completed" ? "pi-web:subagent-result" : "pi-web:subagent-status", { version: 1, status });
  const id = manager.getSessionId();
  const calls = [];
  let reopenCount = 0;
  const child = { inner: { sessionManager: manager, prompt: async (task) => { calls.push(task); },
    getLastAssistantText: () => "Done", abort: async () => {} }, cwd,
    sessionFile: manager.getSessionFile(), isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
  const parent = { cwd, sessionFile: join(root, "parent.jsonl"), inner: { sessionManager: { getSessionId: () => "parent" } }, isAlive: () => true };
  const controller = createSubagentController({ getSession: (sid) => sid === "parent" ? parent : live && sid === id ? child : undefined,
    registerSession() {}, reopenSession: async () => { live = true; reopenCount++; return child; },
    resolveSessionPath: async (sid) => sid === id ? child.sessionFile : null, invalidateSessionList() {}, isBuiltInSubagentsEnabled: () => true });
  const request = { parentContext: parent.inner, parentToolCallId: "new", sessionId: id, task: "Continue", description: "Continue" };
  return { id, child, controller, request, calls, reopened: () => reopenCount };
}

for (const status of ["queued", "running"]) {
  for (const live of [false, true]) {
    test(`orphaned ${status} state resumes after restart with ${live ? "idle" : "no"} wrapper`, async () => {
      const f = await fixture(status, live);
      assert.equal((await f.controller.get(f.id)).status, "interrupted");
      const execution = await f.controller.extensionRuntime.resume(f.request);
      assert.equal((await execution.completion).status, "completed");
      assert.deepEqual(f.calls, ["Continue"]);
      assert.equal(f.reopened(), live ? 0 : 1);
    });
  }
}

test("concurrent resumes admit one queued task and abort prevents later execution", async (t) => {
  const f = await fixture("completed", true);
  const release = Promise.withResolvers();
  const blocker = globalThis.__piSubagentQueue.enqueue("parent", 1, () => release.promise, () => {});
  const results = await Promise.allSettled([f.controller.extensionRuntime.resume(f.request), f.controller.extensionRuntime.resume(f.request)]);
  const accepted = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  t.after(async () => { release.resolve(); await blocker.promise; await Promise.all(accepted.map((x) => x.completion)); });
  assert.equal(accepted.length, 1);
  assert.match(results.find((r) => r.status === "rejected").reason.message, /already running|already resuming/);
  assert.equal((await f.controller.get(f.id)).status, "queued");
  await f.controller.abort(f.id);
  release.resolve();
  await blocker.promise;
  await accepted[0].completion;
  await flush();
  assert.deepEqual(f.calls, []);
});

for (const phase of ["queued", "running", "cleanup"]) {
  test(`abort waits for ${phase} persistence and cleanup before deletion may proceed`, async () => {
    const f = await fixture("completed", true);
    const finished = Promise.withResolvers();
    f.child.isRunning = () => phase === "running";
    globalThis.__piSubagentRuns.set(f.id, { run: { status: phase === "queued" ? "queued" : "running" },
      completion: finished.promise, cancelQueued: () => true, abortRequested: false });
    let returned = false;
    const aborting = f.controller.abort(f.id).then(() => { returned = true; }, (error) => error);
    await flush();
    assert.equal(returned, false);
    finished.resolve({ status: "aborted" });
    const result = await aborting;
    assert.equal(result, undefined);
    assert.equal(returned, true);
  });
}
