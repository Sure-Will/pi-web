import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { createGithubConfigRemote, ConfigSyncRemoteError } = await createJiti(import.meta.url).import("./config-sync-remote.ts");
const profile = { version: 1, model: null, thinkingLevel: null, modelThinkingLevels: {}, enabledModels: null, builtInSubagents: true, plugins: [], browser: {} };

test("remote requires a private writable repository before reading or writing the profile", async () => {
  for (const metadata of [{ private: false, permissions: { push: true } }, { private: true, permissions: { push: false } }]) {
    let calls = 0;
    const remote = createGithubConfigRemote(async () => { calls++; return metadata; });
    await assert.rejects(remote.read("owner/repo"));
    await assert.rejects(remote.write("owner/repo", profile));
    assert.equal(calls, 2);
  }
});

test("missing file is initialized only after repository permissions were checked", async () => {
  const calls = [];
  const remote = createGithubConfigRemote(async (path, body) => {
    calls.push([path, body]);
    if (path === "repos/owner/repo") return { private: true, permissions: { push: true } };
    if (!body) throw new ConfigSyncRemoteError("not found", 404);
    return {};
  });
  assert.deepEqual(await remote.read("owner/repo"), { profile: null });
  await remote.write("owner/repo", profile);
  assert.equal(calls.at(-1)[0], "repos/owner/repo/contents/pi-web-profile.json");
  assert.equal(calls.at(-1)[1].sha, undefined);
  assert.deepEqual(JSON.parse(Buffer.from(calls.at(-1)[1].content, "base64").toString()), profile);
});

test("existing file passes its SHA back for optimistic concurrency and rejects oversized content", async () => {
  let written;
  let size = 100;
  const remote = createGithubConfigRemote(async (path, body) => {
    if (path === "repos/owner/repo") return { private: true, permissions: { push: true } };
    if (body) { written = body; return {}; }
    return { type: "file", encoding: "base64", size, content: Buffer.from(JSON.stringify(profile)).toString("base64"), sha: "old-sha" };
  });
  const read = await remote.read("owner/repo");
  await remote.write("owner/repo", profile, read.sha);
  assert.equal(written.sha, "old-sha");
  size = 65537;
  await assert.rejects(remote.read("owner/repo"), /oversized/);
});
