// Run against an isolated Pi Web server. The sync endpoint is mocked so this
// test never publishes settings, installs plugins, or accesses GitHub.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const base = process.env.E2E_BASE_URL ?? "http://127.0.0.1:30141";
const artifacts = resolve("test-results/config-sync");
mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}) });
const calls = [];
const errors = [];
let state = {
  enabled: true, repository: "fixture/private-config", revision: "first", lastSyncedAt: new Date().toISOString(),
  browser: { "pi-theme": "pine", "pi-locale": "zh-CN", "pi-sound-enabled": "false", "pi-chat-content-width": "1000" },
};

try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: "zh-CN" });
  await context.addInitScript(() => {
    if (!localStorage.getItem("test-seeded")) {
      localStorage.setItem("pi-theme", "light");
      localStorage.setItem("pi-locale", "zh-CN");
      localStorage.setItem("private-test-secret", "do-not-upload");
      localStorage.setItem("test-seeded", "true");
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/api/config-sync", async (route) => {
    const request = route.request();
    const body = request.method() === "GET" ? null : request.postDataJSON();
    calls.push(body);
    if (body?.action === "browser") state.browser = { ...state.browser, ...body.browser };
    if (request.method() === "PUT") state = { ...state, repository: body.repository, enabled: body.enabled };
    if (body?.resolve) { delete state.error; delete state.conflicts; }
    await route.fulfill({ json: state });
  });
  await page.goto(base);
  await page.waitForFunction(() => document.documentElement.dataset.theme === "pine");
  assert.equal(await page.evaluate(() => localStorage.getItem("pi-sound-enabled")), "false");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const section = page.locator(".settings-config-sync-section");
  await section.waitFor();
  await section.scrollIntoViewIfNeeded();
  const input = section.getByRole("textbox");
  assert.equal(await input.inputValue(), "fixture/private-config");

  // A polling event must not reset a user editing the repository field.
  await input.fill("fixture/unsaved-edit");
  await page.evaluate((status) => window.dispatchEvent(new CustomEvent("pi-config-sync-status", { detail: status })), state);
  assert.equal(await input.inputValue(), "fixture/unsaved-edit");
  assert.equal(await section.getByRole("button", { name: "立即同步", exact: true }).isDisabled(), true);
  await input.fill("fixture/private-config");

  // User changes an existing preference; the bridge persists it automatically.
  await page.locator('.settings-theme-option').filter({ has: page.locator('input[value="rose"]') }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "rose");
  await new Promise((resolve) => {
    const deadline = Date.now() + 8000;
    const check = () => state.browser["pi-theme"] === "rose" ? resolve() : Date.now() >= deadline ? resolve() : setTimeout(check, 100);
    check();
  });
  assert.equal(state.browser["pi-theme"], "rose");

  state = { ...state, conflicts: ["browser.pi-theme"], error: "Settings changed on both computers" };
  await page.evaluate((status) => window.dispatchEvent(new CustomEvent("pi-config-sync-status", { detail: status })), state);
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: resolve(artifacts, "desktop-conflict.png") });
  await section.getByRole("button", { name: "保留本机", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".settings-config-sync-conflicts"));
  assert.ok(calls.some((body) => body?.resolve === "local"));
  await page.setViewportSize({ width: 375, height: 900 });
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: resolve(artifacts, "mobile.png") });
  const bounds = await section.boundingBox();
  assert.ok(bounds.width <= 375, `Sync section overflows mobile: ${bounds.width}`);
  const overflow = await section.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
  assert.equal(overflow, false);
  assert.doesNotMatch(JSON.stringify(calls), /do-not-upload|private-test-secret/);
  assert.deepEqual(errors, []);
  console.log("Config sync browser checks passed: remote hydration, automatic save, draft preservation, conflict action, mobile layout, allow-list.");
} finally { await browser.close(); }
