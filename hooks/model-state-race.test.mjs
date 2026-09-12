import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = ts.createSourceFile("useAgentSession.ts",
  await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const declarations = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node)) declarations.set(node.name.getText(source), node);
  ts.forEachChild(node, visit);
}
visit(source);
function callback(name, context) {
  const expression = declarations.get(name).initializer.arguments[0].getText(source);
  return new Script(ts.transpileModule(`(${expression})`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText).runInNewContext(context);
}
const flush = () => new Promise(setImmediate);
const model = (id) => ({ provider: "test", id });

function setup() {
  const response = Promise.withResolvers();
  const requested = Promise.withResolvers();
  let serverModel = "A";
  let deferState = true;
  const context = {
    Error, URLSearchParams, encodeURIComponent,
    console: { error() {} }, isNew: false,
    currentModelOverride: null, liveModel: { provider: "test", modelId: "A" },
    data: null, pendingModel: null,
    normalizeQueuedMessages: (value) => value ?? { steering: [], followUp: [] },
    mergeTurnTiming: (previous, value) => value ?? previous,
    getPresetFromToolNames: () => "default", dispatch() {}, addNotice() {},
    loadTools: async () => [], setPreferredToolPreset() {}, getToolNamesForPreset: () => [],
    closeEvents() {}, cancelEventStreamGrace() {}, maintainEventsConnected() {},
    finishPromptWithoutStream: async () => {},
  };
  for (const [key, current] of Object.entries({ sessionIdRef: "session", sessionHookMountedRef: true,
    promptRunIdRef: 1, modelSelectionVersionRef: 0, modelSwitchPendingRef: false,
    agentRunningRef: true, sentThinkingLevelRef: undefined, sdkAgentActiveRef: true,
    rpcPromptPendingRef: true, sessionPropIdRef: "session", ensuringNewSessionRef: null })) {
    context[key] = { current };
  }
  for (const field of ["Loading", "Data", "ActiveLeafId", "Messages", "EntryIds", "HistoryCursor",
    "HasEarlierMessages", "Error", "ThinkingLevel", "TurnTiming", "ContextUsage", "SystemPrompt",
    "ExtensionStatuses", "ExtensionWidgets", "QueuedMessages", "AgentPhase", "RetryInfo",
    "CurrentModelOverride", "LiveModel", "ModelSwitching", "IsCompacting", "SlashCommands"]) {
    const key = field[0].toLowerCase() + field.slice(1);
    context[`set${field}`] = (value) => { context[key] = typeof value === "function" ? value(context[key]) : value; };
  }
  context.setToolPresetState = () => {};
  const getState = async () => {
    if (!deferState) return { model: model(serverModel), isStreaming: true };
    requested.resolve();
    return response.promise;
  };
  context.fetch = async (url) => {
    if (url.startsWith("/api/agent/") || url.endsWith("/state")) {
      return Response.json({ running: true, state: await getState() });
    }
    assert.match(url, /^\/api\/sessions\//);
    return Response.json({ sessionId: "session", leafId: "leaf", context: {
      model: { provider: "test", modelId: serverModel }, messages: [], entryIds: [], thinkingLevel: "high",
    } });
  };
  context.sendAgentCommand = async (_sid, command) => {
    if (command.type === "get_state") return getState();
    if (command.type === "set_tools") return {};
    assert.equal(command.type, "set_model");
    serverModel = command.modelId;
    if (context.switchGate) await context.switchGate.promise;
    if (context.switchError) throw new Error("lost acknowledgement");
    return model(serverModel);
  };
  for (const name of ["syncLiveModel", "loadSession", "handleModelChange", "handleAgentEvent",
    "reconcileAgentState", "loadSystemInfo", "handleToolPresetChange"]) {
    context[name] = callback(name, context);
  }
  const display = () => (context.currentModelOverride ?? context.liveModel ?? context.data?.context.model)?.modelId;
  return { context, requested, display, release() { deferState = false; response.resolve({ model: model("A"), isStreaming: true }); } };
}

const readers = {
  "agent_end": (c) => c.handleAgentEvent({ type: "agent_end" }),
  "session state": (c) => c.loadSession("session", false, true),
  "active reconciliation": (c) => c.reconcileAgentState("session"),
  "system panel": (c) => c.loadSystemInfo(),
  "tool preset": (c) => c.handleToolPresetChange("default"),
};
for (const [name, read] of Object.entries(readers)) {
  for (const duringSwitch of [false, true]) {
    test(`late ${name} response ${duringSwitch ? "during" : "before"} a model switch cannot revert the selection`, async () => {
      const h = setup();
      let switching;
      if (duringSwitch) {
        h.context.switchGate = Promise.withResolvers();
        switching = h.context.handleModelChange("test", "B");
      }
      const reading = read(h.context);
      if (name === "session state" && duringSwitch) await reading;
      else await h.requested.promise;
      if (duringSwitch) h.context.switchGate.resolve();
      else switching = h.context.handleModelChange("test", "B");
      await switching;
      assert.equal(h.display(), "B");
      h.release();
      await reading;
      await flush();
      assert.equal(h.display(), "B");
    });
  }
}

test("a late agent_end response cannot update a different session", async () => {
  const h = setup();
  h.context.handleAgentEvent({ type: "agent_end" });
  await h.requested.promise;
  h.context.sessionIdRef.current = "other";
  h.context.setLiveModel({ provider: "test", modelId: "C" });
  h.release();
  await flush();
  assert.equal(h.display(), "C");
});

test("a model switch with a lost acknowledgement recovers canonical server state", async () => {
  const h = setup();
  h.release();
  h.context.switchError = true;
  await h.context.handleModelChange("test", "B");
  assert.equal(h.display(), "B");
  assert.equal(h.context.modelSwitchPendingRef.current, false);
  assert.equal(h.context.modelSwitching, false);
});
