import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { Script } from "node:vm";
import ts from "typescript";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-subagent-route-global-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT, PATCH, DELETE } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function profile(overrides = {}) {
  return {
    name: "api-test-agent",
    displayName: "API test agent",
    description: "Used by route tests",
    systemPrompt: "Return a concise result.",
    tools: [],
    loadSkills: true,
    loadExtensions: true,
    inheritContext: false,
    runInBackground: true,
    enabled: true,
    ...overrides,
  };
}

function jsonRequest(method, body) {
  return new Request("http://localhost/api/subagents/profiles", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("profiles route creates, lists, and deletes a project profile", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-route-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const putResponse = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile() }));
  const putBody = await putResponse.json();
  assert.equal(putResponse.status, 200);
  assert.equal(putBody.profile.scope, "project");
  assert.deepEqual(putBody.profile.tools, []);
  assert.equal(putBody.profile.loadSkills, true);
  assert.equal(putBody.profile.loadExtensions, true);
  const source = await readFile(join(cwd, ".pi", "agents", "api-test-agent.md"), "utf8");
  assert.match(source, /tools: none/);
  assert.match(source, /load_skills: true/);
  assert.match(source, /load_extensions: true/);

  const getResponse = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  const getBody = await getResponse.json();
  assert.equal(getResponse.status, 200);
  const listedProfile = getBody.profiles.find((item) => item.name === "api-test-agent");
  assert.deepEqual(listedProfile.tools, []);
  assert.equal(listedProfile.loadSkills, true);
  assert.equal(listedProfile.loadExtensions, true);

  const deleteResponse = await DELETE(jsonRequest("DELETE", { cwd, scope: "project", name: "api-test-agent" }));
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { ok: true });

  const afterDelete = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  const afterDeleteBody = await afterDelete.json();
  assert.equal(afterDeleteBody.profiles.some((item) => item.name === "api-test-agent"), false);
});

test("profiles route keeps same-name global and project profiles independently editable", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-route-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));

  let response = await PUT(jsonRequest("PUT", {
    cwd,
    scope: "global",
    profile: profile({ description: "Global profile" }),
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).profile.scope, "global");
  assert.match(await readFile(join(testAgentDir, "agents", "api-test-agent.md"), "utf8"), /Global profile/);

  response = await PUT(jsonRequest("PUT", {
    cwd,
    scope: "project",
    profile: profile({ description: "Project profile" }),
  }));
  assert.equal(response.status, 200);

  response = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  const sources = (await response.json()).profiles
    .filter((item) => item.name === "api-test-agent")
    .sort((a, b) => a.scope.localeCompare(b.scope));
  assert.deepEqual(sources.map((item) => item.scope), ["global", "project"]);
  assert.deepEqual(sources.map((item) => item.description), ["Global profile", "Project profile"]);

  response = await PATCH(jsonRequest("PATCH", {
    cwd,
    scope: "global",
    name: "api-test-agent",
    enabled: false,
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).profile.enabled, false);
  response = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  const toggledSources = (await response.json()).profiles.filter((item) => item.name === "api-test-agent");
  assert.equal(toggledSources.find((item) => item.scope === "global").enabled, false);
  assert.equal(toggledSources.find((item) => item.scope === "global").description, "Global profile");
  assert.equal(toggledSources.find((item) => item.scope === "global").loadSkills, true);
  assert.equal(toggledSources.find((item) => item.scope === "global").loadExtensions, true);
  assert.equal(toggledSources.find((item) => item.scope === "project").enabled, true);

  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "project", name: "api-test-agent" }));
  assert.equal(response.status, 200);
  response = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
  assert.deepEqual(
    (await response.json()).profiles.filter((item) => item.name === "api-test-agent").map((item) => item.scope),
    ["global"],
  );

  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "global", name: "api-test-agent" }));
  assert.equal(response.status, 200);
});

test("profiles route rejects missing paths, malformed profiles, and unsafe names", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-route-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));

  let response = await GET(new Request("http://localhost/api/subagents/profiles"));
  assert.equal(response.status, 400);

  response = await PUT(jsonRequest("PUT", { cwd, scope: "project" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "profile required" });

  response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile({ name: "../escape" }) }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Agent name may contain only/);

  response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile({ thinking: "extreme" }) }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Invalid thinking level/);

  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "project" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "name required" });

  response = await PUT(jsonRequest("PUT", { cwd, scope: "workspace", profile: profile() }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "scope must be global or project" });

  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "builtin", name: "Explore" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "scope must be global or project" });

  response = await PATCH(jsonRequest("PATCH", { cwd, scope: "project", name: "missing", enabled: false }));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Agent profile not found" });

  response = await PATCH(jsonRequest("PATCH", { cwd, scope: "project", name: "api-test-agent" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "enabled required" });
});


// Execute the editor's actual projection before calling the real persistence API.
const editorSource = ts.createSourceFile("AgentsConfig.tsx",
  await readFile(new URL("../../../../components/AgentsConfig.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const editorProjection = editorSource.statements.find((node) =>
  ts.isFunctionDeclaration(node) && node.name?.text === "editableProfile");
const editableProfile = new Script(ts.transpileModule(
  `(${editorProjection.getText(editorSource)})`,
  { compilerOptions: { target: ts.ScriptTarget.ESNext } },
).outputText).runInNewContext();

function assertExecutionSettings(actual, expected) {
  for (const key of ["color", "isolation", "persistSession", "loadExtensions"]) {
    assert.equal(actual[key], expected[key], key);
  }
  assert.deepEqual(Array.from(actual.extensionTools ?? []), expected.extensionTools);
}

for (const operation of ["edit and duplicate", "toggle"]) {
  test(`profile ${operation} preserves isolation, persistence, color and extension selectors`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-web-profile-preservation-"));
    allowFileRoot(cwd);
    t.after(() => rm(cwd, { recursive: true, force: true }));
    for (const persistSession of [false, true]) {
      const original = profile({ color: "blue", isolation: persistSession ? "off" : "worktree",
        persistSession, extensionTools: ["ext:lookup_docs"], tools: ["read"] });
      let response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: original }));
      assert.equal(response.status, 200);
      const loaded = (await response.json()).profile;
      assertExecutionSettings(loaded, original);
      if (operation === "toggle") {
        for (const enabled of [false, true]) {
          response = await PATCH(jsonRequest("PATCH", { cwd, scope: "project", name: original.name, enabled }));
          assert.equal(response.status, 200);
          const toggled = (await response.json()).profile;
          assert.equal(toggled.enabled, enabled);
          assertExecutionSettings(toggled, original);
        }
      } else {
        const draft = editableProfile(loaded);
        assertExecutionSettings(draft, original);
        assert.notEqual(draft.tools, loaded.tools);
        assert.notEqual(draft.extensionTools, loaded.extensionTools);
        assert.equal("scope" in draft, false);
        assert.equal("filePath" in draft, false);
        for (const name of [original.name, `${original.name}-copy`]) {
          response = await PUT(jsonRequest("PUT", { cwd, scope: "project",
            profile: { ...draft, name, description: "Edited in the UI" } }));
          assert.equal(response.status, 200);
          assertExecutionSettings((await response.json()).profile, original);
        }
      }
      response = await GET(new Request(`http://localhost/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`));
      assert.equal(response.status, 200);
      for (const saved of (await response.json()).profiles.filter((p) => p.scope === "project")) {
        assertExecutionSettings(saved, original);
      }
    }
  });
}


test("imported profile names edit, toggle and delete their original file", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-profile-alias-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const dir = join(cwd, ".pi", "agents");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "z-review.md");
  await writeFile(path, "---\nname: audit\ntools: read\nisolation: worktree\nenabled: true\n---\nAudit code.\n");
  let response = await PATCH(jsonRequest("PATCH", { cwd, scope: "project", name: "audit", enabled: false }));
  assert.equal(response.status, 200);
  const disabled = (await response.json()).profile;
  assert.equal(disabled.filePath, path);
  assert.deepEqual(await readdir(dir), ["z-review.md"]);
  assert.match(await readFile(path, "utf8"), /enabled: false/);
  response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: { ...editableProfile(disabled), description: "Reviewed" } }));
  assert.equal(response.status, 200);
  assert.match(await readFile(path, "utf8"), /description: Reviewed/);
  response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: { ...editableProfile(disabled), name: "audit-copy" } }));
  assert.equal(response.status, 200);
  assert.deepEqual((await readdir(dir)).sort(), ["audit-copy.md", "z-review.md"]);
  response = await DELETE(jsonRequest("DELETE", { cwd, scope: "project", name: "audit" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await readdir(dir), ["audit-copy.md"]);
});


test("profile filename collisions and ambiguous imported ids never overwrite another source", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-profile-collision-"));
  allowFileRoot(cwd);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const dir = join(cwd, ".pi", "agents");
  await mkdir(dir, { recursive: true });
  const original = "---\nname: reviewer\ntools: read\n---\nOriginal rules.\n";
  await writeFile(join(dir, "worker.md"), original);
  for (const name of ["worker", "Worker"]) {
    const collides = await readFile(join(dir, `${name}.md`), "utf8").then(() => true, () => false);
    const response = await PUT(jsonRequest("PUT", { cwd, scope: "project", profile: profile({ name }) }));
    assert.equal(response.status, collides ? 400 : 200);
    assert.equal(await readFile(join(dir, "worker.md"), "utf8"), original);
  }
  await writeFile(join(dir, "another.md"), original);
  for (const [method, handler] of [["PUT", PUT], ["PATCH", PATCH], ["DELETE", DELETE]]) {
    const response = await handler(jsonRequest(method, { cwd, scope: "project", name: "reviewer", enabled: false, profile: profile({ name: "reviewer" }) }));
    assert.equal(response.status, 400);
    assert.equal(await readFile(join(dir, "worker.md"), "utf8"), original);
    assert.equal(await readFile(join(dir, "another.md"), "utf8"), original);
  }
});
