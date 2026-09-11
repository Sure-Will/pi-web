import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareBuild, sourceManifest, syncSources } from "../scripts/local-build.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-local-build-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "source");
  const cache = path.join(directory, "cache");
  fs.mkdirSync(root);
  return { directory, root, cache };
}
const hash = (text) => createHash("sha256").update(text).digest("hex");

test("source sync preserves unchanged mtimes and cache, and deletes only retired source files", (t) => {
  const { root, cache } = fixture(t);
  fs.writeFileSync(path.join(root, "app.ts"), "old");
  const before = [{ path: "app.ts", sha256: hash("old") }];
  assert.deepEqual(syncSources(root, cache, before), { copied: 1, removed: 0 });
  fs.utimesSync(path.join(cache, "app.ts"), new Date(100000), new Date(100000));
  fs.mkdirSync(path.join(cache, ".next/cache"), { recursive: true });
  fs.writeFileSync(path.join(cache, ".next/cache/keep"), "cache");
  assert.deepEqual(syncSources(root, cache, before, before), { copied: 0, removed: 0 });
  assert.equal(fs.statSync(path.join(cache, "app.ts")).mtimeMs, 100000);
  assert.deepEqual(syncSources(root, cache, [], before), { copied: 0, removed: 1 });
  assert.equal(fs.readFileSync(path.join(cache, ".next/cache/keep"), "utf8"), "cache");
  assert.throws(() => syncSources(root, cache, [], [{ path: "../outside" }]), /Unsafe source path/);
  assert.throws(() => syncSources(root, cache, [], [{ path: ".next/cache/keep" }]), /Unsafe source path/);
});

test("source sync rejects destinations reached through a directory link", (t) => {
  const { root, cache, directory } = fixture(t);
  fs.mkdirSync(cache);
  const outside = path.join(directory, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(cache, "linked"), process.platform === "win32" ? "junction" : "dir");
  fs.writeFileSync(path.join(root, "test.txt"), "test");
  assert.throws(() => syncSources(root, cache, [{ path: "linked/file", sha256: hash("test") }]), /escapes workspace/);
});

test("prepare reuses successful builds, rejects stale candidates and never reuses a failed build", async (t) => {
  const { root, cache } = fixture(t);
  execFileSync("git", ["init", "-q", root]);
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: {}, devDependencies: {} }));
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ packages: {} }));
  fs.writeFileSync(path.join(root, "app.txt"), "one");
  fs.mkdirSync(path.join(root, "node_modules/next/dist/bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules/next/dist/bin/next"), `
    const fs = require('node:fs');
    if (process.argv[2] === 'start') {
      const port = Number(process.argv[process.argv.indexOf('-p') + 1]);
      require('node:http').createServer((req,res) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(req.url.includes('running') ? {runningSessionIds:[]} : {sessions:[]})); }).listen(port,'127.0.0.1');
    } else {
      fs.mkdirSync('.next/cache',{recursive:true});
      const calls=Number(fs.existsSync('.next/cache/calls') ? fs.readFileSync('.next/cache/calls','utf8') : 0)+1;
      fs.writeFileSync('.next/cache/calls',String(calls));
      if (fs.readFileSync('app.txt','utf8') === 'fail') process.exit(1);
      fs.writeFileSync('.next/BUILD_ID','build-'+calls);
    }
  `);
  assert.ok(sourceManifest(root).some((file) => file.path === "app.txt"), "untracked source is included");
  assert.ok(!sourceManifest(root).some((file) => file.path.includes("node_modules")), "ignored dependencies are not copied");
  const first = await prepareBuild(root, cache);
  assert.equal(first.buildId, "build-1");
  assert.equal(first.probe.passed, true);
  const reused = await prepareBuild(root, cache, { checkOnly: true });
  assert.equal(reused.reused, true);
  fs.writeFileSync(path.join(root, "app.txt"), "two");
  await assert.rejects(prepareBuild(root, cache, { checkOnly: true }), /stale/);
  const second = await prepareBuild(root, cache);
  assert.equal(second.buildId, "build-2");
  fs.writeFileSync(path.join(root, "app.txt"), "fail");
  await assert.rejects(prepareBuild(root, cache), /Production build failed/);
  assert.equal(fs.existsSync(path.join(cache, "ready.json")), false);
  await assert.rejects(prepareBuild(root, cache, { checkOnly: true }), /stale/);
  await assert.rejects(prepareBuild(root, path.join(root, "nested-cache")), /outside the source/);
});
