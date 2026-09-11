import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));

export function sourceManifest(root) {
  const names = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0");
  return [...new Set(names)].filter((name) => name && fs.existsSync(path.join(root, name)))
    .sort().map((name) => {
      const file = path.join(root, name);
      if (!fs.lstatSync(file).isFile()) throw new Error(`Build source must be a regular file: ${name}`);
      return { path: name, sha256: sha256(fs.readFileSync(file)) };
    });
}

function inside(root, relative) {
  const target = path.resolve(root, relative);
  const fromRoot = path.relative(root, target);
  if (!fromRoot || fromRoot.startsWith(`..${path.sep}`) || fromRoot === ".." || path.isAbsolute(fromRoot)
    || [".next", "node_modules", ".git"].includes(fromRoot.split(path.sep)[0])) throw new Error(`Unsafe source path: ${relative}`);
  let parent = path.dirname(target);
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const realParent = fs.realpathSync(parent);
  const realRoot = fs.realpathSync(root);
  const resolved = path.relative(realRoot, realParent);
  if (resolved === ".." || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) throw new Error(`Source destination escapes workspace: ${relative}`);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error(`Source destination is a link: ${relative}`);
  return target;
}

/** Preserve unchanged mtimes and build caches; remove only previously copied source files. */
export function syncSources(root, workspace, current, previous = []) {
  fs.mkdirSync(workspace, { recursive: true });
  const retained = new Set(current.map((file) => file.path));
  let copied = 0;
  let removed = 0;
  for (const file of previous) {
    if (retained.has(file.path)) continue;
    const target = inside(workspace, file.path);
    if (fs.existsSync(target)) { fs.unlinkSync(target); removed += 1; }
  }
  for (const file of current) {
    const target = inside(workspace, file.path);
    if (fs.existsSync(target) && sha256(fs.readFileSync(target)) === file.sha256) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file.path), target);
    copied += 1;
  }
  return { copied, removed };
}

function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function dependencyVersions(root) {
  const pkg = readJson(path.join(root, "package.json"));
  const lock = readJson(path.join(root, "package-lock.json"));
  const versions = {};
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort()) {
    const actual = readJson(path.join(root, "node_modules", name, "package.json")).version;
    if (lock.packages[`node_modules/${name}`]?.version !== actual) throw new Error(`Installed dependency differs from package-lock: ${name}. Reconcile source dependencies first.`);
    versions[name] = actual;
  }
  return versions;
}

function stopChild(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 }); }
    catch { child.kill(); }
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
  }
}

async function probeBuild(root, workspace, cacheRoot, onChild) {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const data = path.join(cacheRoot, "probe-data");
  fs.mkdirSync(data, { recursive: true });
  const log = fs.openSync(path.join(cacheRoot, "probe.log"), "w");
  const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: workspace, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", log, log],
    env: { ...process.env, PI_CODING_AGENT_DIR: data, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1" },
  });
  onChild(child);
  let failure;
  child.on("error", (error) => { failure = error; });
  const exited = new Promise((resolve) => child.once("close", resolve));
  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30000;
    while (true) {
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error("Candidate server exited; see probe.log");
      try {
        const sessions = await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(1000) });
        if (sessions.ok && Array.isArray((await sessions.json()).sessions)) break;
      } catch { /* Wait for the isolated candidate to become ready. */ }
      if (Date.now() >= deadline) throw new Error("Candidate did not become ready; see probe.log");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!(await fetch(base, { signal: AbortSignal.timeout(5000) })).ok) throw new Error("Candidate page failed to load");
    const running = await fetch(`${base}/api/agent/running`, { signal: AbortSignal.timeout(5000) }).then((response) => response.json());
    if (!Array.isArray(running.runningSessionIds)) throw new Error("Candidate running-state API failed");
    return { passed: true, checkedAt: new Date().toISOString() };
  } finally {
    stopChild(child);
    await exited;
    onChild(null);
    fs.closeSync(log);
  }
}

export async function prepareBuild(root, cacheRoot, { checkOnly = false } = {}) {
  root = fs.realpathSync(root);
  cacheRoot = path.resolve(cacheRoot);
  const relative = path.relative(root, cacheRoot);
  if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error("Build cache must live outside the source checkout.");
  fs.mkdirSync(cacheRoot, { recursive: true });
  const realCache = fs.realpathSync(cacheRoot);
  const fromSource = path.relative(root, realCache);
  if (!fromSource.startsWith(`..${path.sep}`) && !path.isAbsolute(fromSource)) throw new Error("Build cache resolves inside the source checkout.");
  const lockPath = path.join(cacheRoot, "prepare.lock");
  const release = await lockfile.lock(cacheRoot, { lockfilePath: lockPath, retries: 0, stale: 60000 });
  let activeChild;
  let interrupted = false;
  const cancel = () => { interrupted = true; stopChild(activeChild); };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const manifestFile = path.join(cacheRoot, "sources.json");
    const readyFile = path.join(cacheRoot, "ready.json");
    const workspace = path.join(cacheRoot, "workspace");
    const previous = fs.existsSync(manifestFile) ? readJson(manifestFile) : null;
    if (previous && previous.sourceRoot !== root) throw new Error("Build cache belongs to another checkout.");
    if (fs.existsSync(workspace) && (fs.lstatSync(workspace).isSymbolicLink() || (!previous && fs.readdirSync(workspace).length))) throw new Error("Unmanaged or linked build workspace.");
    const files = sourceManifest(root);
    const dependencies = dependencyVersions(root);
    const fingerprint = sha256(JSON.stringify({ files, dependencies, node: process.version }));
    const ready = fs.existsSync(readyFile) ? readJson(readyFile) : null;
    const buildIdFile = path.join(workspace, ".next", "BUILD_ID");
    if (ready?.fingerprint === fingerprint && ready.probe?.passed && fs.existsSync(buildIdFile)
      && fs.readFileSync(buildIdFile, "utf8").trim() === ready.buildId) {
      console.log(`Reusing prepared build ${ready.buildId}; source is unchanged.`);
      return { ...ready, reused: true };
    }
    if (checkOnly) throw new Error("Prepared build is stale or missing. Run Prepare first.");
    const sync = syncSources(root, workspace, files, previous?.files);
    // Invalidate readiness before starting a build, including failed attempts.
    if (fs.existsSync(readyFile)) fs.unlinkSync(readyFile);
    writeJson(manifestFile, { sourceRoot: root, files });
    const nodeModules = path.join(workspace, "node_modules");
    if (!fs.existsSync(nodeModules)) fs.symlinkSync(path.join(root, "node_modules"), nodeModules, process.platform === "win32" ? "junction" : "dir");
    if (fs.realpathSync(nodeModules) !== fs.realpathSync(path.join(root, "node_modules"))) throw new Error("Unexpected build dependency directory.");
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const logFile = path.join(cacheRoot, `build-${stamp}.log`);
    const log = fs.openSync(logFile, "w");
    const start = performance.now();
    console.log(`Building ${sync.copied} changed / ${sync.removed} removed source files. Log: ${logFile}`);
    let exitCode;
    try {
      exitCode = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "build", "--webpack"], {
          cwd: workspace,
          env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS || "--max-old-space-size=4096", NEXT_TELEMETRY_DISABLED: "1" },
          stdio: ["ignore", log, log], windowsHide: true, detached: process.platform !== "win32",
        });
        activeChild = child;
        child.on("error", reject);
        child.on("exit", (code) => resolve(code ?? 1));
      });
    } finally { activeChild = null; fs.closeSync(log); }
    const elapsedSeconds = (performance.now() - start) / 1000;
    if (exitCode !== 0) throw new Error(`Production build failed (${exitCode}); see ${logFile}`);
    // An edit during a build must never become an apparently current candidate.
    if (sha256(JSON.stringify({ files: sourceManifest(root), dependencies: dependencyVersions(root), node: process.version })) !== fingerprint) {
      throw new Error("Source changed during the build. Run Prepare again; compilation cache is retained.");
    }
    if (interrupted) throw new Error("Build cancelled; cache was retained.");
    const probe = await probeBuild(root, workspace, cacheRoot, (child) => { activeChild = child; });
    if (interrupted) throw new Error("Build cancelled; cache was retained.");
    if (JSON.stringify(sourceManifest(root)) !== JSON.stringify(files)) throw new Error("Source changed during candidate verification; run Prepare again.");
    const result = { sourceRoot: root, workspace, fingerprint, buildId: fs.readFileSync(buildIdFile, "utf8").trim(), preparedAt: new Date().toISOString(), elapsedSeconds, logFile, dependencies, probe, lockSha256: sha256(fs.readFileSync(path.join(root, "package-lock.json"))) };
    writeJson(readyFile, result);
    console.log(`Prepared ${result.buildId} in ${elapsedSeconds.toFixed(1)}s. The installed service was not stopped.`);
    return result;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    await release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cacheRoot = process.argv[2] || (process.platform === "win32" ? "D:\\Pi\\cache\\pi-web-local-build" : path.join(os.homedir(), ".cache/pi-web-local-build"));
  try { await prepareBuild(root, cacheRoot, { checkOnly: process.argv.includes("--check") }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
