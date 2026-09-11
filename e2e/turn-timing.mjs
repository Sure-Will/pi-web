// Run against a dev server with PI_CODING_AGENT_DIR=test-results/turn-timing/agent.
// Seed isolated sessions first: node e2e/turn-timing.mjs --seed
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const artifacts = resolve("test-results/turn-timing");
const sessionDir = resolve(artifacts, "agent/sessions/timing");
const timestamp = "2026-09-10T06:35:00.000Z";
const ids = ["timing-process", "timing-plain", "timing-legacy", "timing-live"];
const liveTiming = { id: "live-run", startedAt: Date.now() - 83000 };
let completed = false;

function entriesFor(id) {
  const entries = [{ type: "session", version: 3, id, timestamp, cwd: artifacts }];
  const append = (type, fields) => {
    const entry = { type, id: `e${entries.length}`, parentId: entries.at(-1).id === id ? null : entries.at(-1).id, timestamp, ...fields };
    entries.push(entry);
    return entry;
  };
  append("message", { message: { role: "user", content: "生成一个可以离线打开的自行车动画。", timestamp: Date.parse(timestamp) } });
  if (id === "timing-live") return entries;
  if (id === "timing-process") {
    append("message", { message: { role: "assistant", provider: "test", model: "GPT-6 Astra", content: [{ type: "thinking", thinking: "先设计自行车的运动轨迹。" }], timestamp: Date.parse(timestamp) + 10000 } });
  }
  const answer = append("message", { message: { role: "assistant", provider: "test", model: "GPT-6 Astra", content: [{ type: "text", text: "已生成自行车动画，支持暂停和调速。" }], stopReason: "stop", timestamp: Date.parse(timestamp) + 222000 } });
  if (id !== "timing-legacy") append("custom", { customType: "pi-web:turn-timing", data: { version: 1, id: `${id}-run`, startedAt: Date.parse(timestamp), endedAt: Date.parse(timestamp) + 222000, anchorEntryId: answer.id } });
  return entries;
}

function writeFixture(id, entries = entriesFor(id)) {
  writeFileSync(resolve(sessionDir, `2026-09-10T06-35-00-000Z_${id}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

if (process.argv.includes("--seed")) {
  mkdirSync(sessionDir, { recursive: true });
  for (const id of ids) writeFixture(id);
  console.log(resolve(artifacts, "agent"));
} else {
  const browser = await chromium.launch({ headless: true, ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 850 }, locale: "zh-CN" });
    await context.addInitScript(() => { localStorage.setItem("pi-locale", "zh-CN"); localStorage.setItem("pi-theme", "dark"); });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    // Exercise a real mounted chat with a controlled run, without calling a model.
    await page.route("**/api/sessions/timing-live/state", (route) => route.fulfill({ json: {
      running: !completed, state: { isStreaming: !completed, isPromptRunning: !completed, turnTiming: completed ? { ...liveTiming, endedAt: liveTiming.startedAt + 222000, anchorEntryId: "e2" } : liveTiming },
    } }));
    await page.route("**/api/agent/timing-live", (route) => route.fulfill({ json: {
      running: !completed, state: { isStreaming: !completed, isPromptRunning: !completed, turnTiming: liveTiming },
    } }));
    await page.route("**/api/agent/timing-live/events", (route) => {
      const timing = completed ? { ...liveTiming, endedAt: liveTiming.startedAt + 222000, anchorEntryId: "e2" } : liveTiming;
      const events = [{ type: "connected", sessionId: "timing-live", isStreaming: !completed, turnTiming: timing }];
      if (completed) events.push({ type: "turn_timing", turnTiming: timing }, { type: "agent_settled" }, { type: "prompt_done" });
      return route.fulfill({ contentType: "text/event-stream", body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") });
    });
    const base = process.env.E2E_BASE_URL ?? "http://127.0.0.1:30141";
    const open = async (id) => { await page.goto(`${base}/?session=${id}`); await page.locator('[data-entry-id="e1"]').waitFor(); };

    await open("timing-process");
    const summary = page.getByRole("button", { name: /处理详情.*耗时 3分42秒/ });
    await summary.waitFor();
    assert.equal(await summary.getAttribute("aria-expanded"), "false");
    await page.screenshot({ path: resolve(artifacts, "completed-desktop.png") });
    await summary.click();
    assert.equal(await summary.getAttribute("aria-expanded"), "true");
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await summary.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: resolve(artifacts, "completed-mobile.png") });
    await summary.click();
    await page.screenshot({ path: resolve(artifacts, "expanded-mobile.png") });

    await open("timing-plain");
    await page.getByText("耗时 3分42秒", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: /处理详情/ }).count(), 0);
    await page.reload();
    await page.getByText("耗时 3分42秒", { exact: true }).waitFor();
    await open("timing-legacy");
    await page.getByText("已生成自行车动画，支持暂停和调速。", { exact: true }).waitFor();
    assert.equal(await page.getByText(/耗时 \d/).count(), 0);

    await open("timing-live");
    const live = page.getByText(/^正在处理 · /);
    await live.waitFor();
    const before = await live.innerText();
    await page.waitForFunction((text) => !document.body.innerText.includes(text), before);
    await page.reload();
    await live.waitFor();
    assert.match(await live.innerText(), /正在处理 · [1-9]\d*分/);
    await page.screenshot({ path: resolve(artifacts, "running-mobile.png") });

    completed = true;
    const finished = entriesFor("timing-plain");
    finished[0].id = "timing-live";
    finished.at(-1).data = { version: 1, ...liveTiming, endedAt: liveTiming.startedAt + 222000, anchorEntryId: "e2" };
    writeFixture("timing-live", finished);
    const frozen = page.getByText("耗时 3分42秒", { exact: true });
    await frozen.waitFor();
    await page.waitForTimeout(1100);
    assert.equal(await frozen.count(), 1);
    assert.equal(await live.count(), 0);
    await page.reload();
    await frozen.waitFor();
    assert.deepEqual(errors, []);
    console.log("Passed: collapsed/expanded, desktop/375px, plain text, legacy, ticking, refresh recovery, frozen completion; no page errors.");
  } finally {
    await browser.close();
  }
}
