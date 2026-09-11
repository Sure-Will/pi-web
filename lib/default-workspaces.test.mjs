import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";
import nft from "next/dist/compiled/@vercel/nft/index.js";

const { nodeFileTrace } = nft;

const { listDefaultWorkspaces } = await createJiti(import.meta.url).import("./default-workspaces.ts");

test("default workspace discovery preserves the existing name filter and full paths", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-default-workspaces-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ["pi-cwd-20260910", "pi-cwd-20250101", "pi-cwd-2026091", "other", "pi-cwd-20260910-extra"]) {
    fs.mkdirSync(path.join(directory, name));
  }
  assert.deepEqual(listDefaultWorkspaces(directory).sort(), [
    path.join(directory, "pi-cwd-20250101"), path.join(directory, "pi-cwd-20260910"),
  ].sort());
});

test("Next's actual asset tracer no longer attempts to deploy the runtime home", async () => {
  const entry = fileURLToPath(new URL("./file-access.ts", import.meta.url));
  const helper = fileURLToPath(new URL("./default-workspaces.ts", import.meta.url));
  const root = path.dirname(path.dirname(entry));
  const home = path.resolve(os.homedir());
  const compile = (source) => ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const helperSource = compile(fs.readFileSync(helper, "utf8"));

  async function trace(source) {
    let homeAssetAttempts = 0;
    const result = await nodeFileTrace([entry], {
      base: root, processCwd: root,
      // Only the production caller and helper matter for this regression;
      // isolate unrelated session/SDK imports from the tracing experiment.
      resolve: async () => helper,
      readFile: async (file) => file === entry ? source : file === helper ? helperSource : "",
      stat: async (file) => {
        if (path.resolve(file) === home) {
          homeAssetAttempts += 1;
          return null; // Prove the attempted asset without scanning personal files.
        }
        return fs.promises.stat(file).catch(() => null);
      },
      ignore: (relative) => path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`),
    });
    assert.deepEqual([...result.warnings].map(String), []);
    return homeAssetAttempts;
  }

  assert.ok(await trace('import { readdirSync } from "fs"; import { homedir } from "os"; readdirSync(homedir());') > 0);
  assert.ok(await trace('import { resolve } from "path"; import { homedir } from "os"; function normalize(directory) { return resolve(homedir(), directory.slice(2)); }') > 0);
  for (const source of [
    new URL("./file-access.ts", import.meta.url),
    new URL("./directory-browser.ts", import.meta.url),
    new URL("../app/api/cwd/validate/route.ts", import.meta.url),
  ]) {
    assert.equal(await trace(compile(fs.readFileSync(source, "utf8"))), 0, `${fileURLToPath(source)} must not trace runtime home assets`);
  }
});
