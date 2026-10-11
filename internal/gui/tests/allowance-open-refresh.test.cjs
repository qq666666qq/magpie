// Opening allowances is a user-requested read, even with a recent cached
// reading. Timed reads keep their ordinary cache policy. No live accounts:
// the API fixture returns the old reading until the page asks explicitly.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");

function serve(lang, reads, allowance) {
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:true};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings: { lang, theme: "light", quotaReads: "asked" } });
    if (url.pathname === "/api/usage/quotas") {
      const asked = url.searchParams.get("asked") === "1";
      reads.push(asked);
      if (asked) allowance.kept = allowance.used;
      return json([{ provider: "codex", name: "Codex", user: "a@example.com", plan: "plus",
        windows: [{ name: "5 hours", used: allowance.kept, resetsAt: "2030-01-01T00:00:00Z" }] }]);
    }
    if (url.pathname === "/api/usage/quotas/history") return json([]);
    if (url.pathname === "/api/usage") return json({ calls: 1, input: 100, output: 10, cost: 0.01, series: [], agents: [], models: [] });
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true } });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    try { await route.fulfill({ body: await fs.readFile(file), contentType }); }
    catch { await route.fulfill({ status: 404, body: "" }); }
  };
}

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  test(`${engine}: opening allowances reads the current numbers`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    for (const lang of ["en", "zh", "zh-TW", "ja", "de"]) {
      for (const surface of ["window", "panel"]) {
        await t.test(`${lang} ${surface}: entering and reopening allowances`, async (t) => {
          const reads = [], errors = [];
          const allowance = { used: 75, kept: 10 };
          const context = await browser.newContext({ viewport: { width: surface === "panel" ? 440 : 1100, height: 760 }, reducedMotion: "reduce" });
          t.after(() => context.close());
          const page = await context.newPage();
          page.setDefaultTimeout(5000);
          page.on("pageerror", (e) => errors.push(e.message));
          await page.clock.install();
          await page.route("**/*", serve(lang, reads, allowance));
          await page.goto(`http://magpie.test/${surface === "panel" ? "?mode=panel" : ""}`);
          const card = surface === "panel" ? ".pq-card" : ".subscription-card";
          const enter = () => page.locator(surface === "panel" ? '#ptabs [data-ptab="usage"]' : '#nav [data-view="usage"]').click();
          if (surface === "panel") await page.waitForFunction(() => document.querySelector(".pq-card")?.textContent.includes("10%"));
          else await page.locator('#nav [data-view="usage"]').waitFor();
          const before = reads.filter(Boolean).length;
          await enter();
          await page.waitForFunction((s) => document.querySelector(s)?.textContent.includes("75%"), card);
          assert(reads.filter(Boolean).length > before, "entering allowances asks for a new reading");

          // Returning to an already drawn page must ask too, without waiting
          // for the one-minute allowance timer or pressing Refresh now.
          const opened = reads.filter(Boolean).length;
          allowance.used = 85;
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          await page.waitForFunction((s) => document.querySelector(s)?.textContent.includes("85%"), card);
          assert(reads.filter(Boolean).length > opened, "reopening allowances asks for a new reading");

          const visible = reads.filter(Boolean).length;
          allowance.used = 90;
          await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
          await page.waitForFunction((s) => document.querySelector(s)?.textContent.includes("90%"), card);
          assert(reads.filter(Boolean).length > visible, "showing allowances asks for a new reading");

          // Going away and entering again is another explicit request.
          await page.locator(surface === "panel" ? '#ptabs [data-ptab="agents"]' : '#nav [data-view="agents"]').click();
          const returned = reads.filter(Boolean).length;
          allowance.used = 95;
          await enter();
          await page.waitForFunction((s) => document.querySelector(s)?.textContent.includes("95%"), card);
          assert(reads.filter(Boolean).length > returned, "reentering allowances reads again");

          // A second click on the active tab is an explicit read as well.
          allowance.used = 100;
          await enter();
          await page.waitForFunction((s) => document.querySelector(s)?.textContent.includes("100%"), card);
          const explicit = reads.filter(Boolean).length;
          const timed = surface === "window" ? page.waitForResponse((r) => {
            const url = new URL(r.url());
            return url.pathname === "/api/usage/quotas" && !url.searchParams.has("asked");
          }) : null;
          await page.clock.fastForward(65000);
          if (timed) await timed;
          await page.waitForFunction(() => !quotasLoading && !usageFlight);
          assert.equal(reads.filter(Boolean).length, explicit, "the timer does not turn into an explicit read");
          assert.deepEqual(errors, []);
        });
      }
    }
    for (const surface of ["window", "panel"]) {
      await t.test(`${surface}: opening directly on allowances`, async (t) => {
        const reads = [], allowance = { used: 75, kept: 10 };
        const context = await browser.newContext();
        t.after(() => context.close());
        if (surface === "panel") await context.addInitScript(() => localStorage.setItem("magpie.panelTab", "usage"));
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        await page.route("**/*", serve("en", reads, allowance));
        await page.goto(`http://magpie.test/?${surface === "panel" ? "mode=panel" : "view=usage"}`);
        await page.waitForFunction((s) => document.querySelector(s)?.textContent.includes("75%"), surface === "panel" ? ".pq-card" : ".subscription-card");
        assert(reads.some(Boolean), "opening directly asks for current allowances");
      });
    }
    await t.test("panel: entering allowances during an ordinary read", async (t) => {
      const reads = [], allowance = { used: 75, kept: 10 };
      const context = await browser.newContext();
      let release, started;
      const held = new Promise((resolve) => { release = resolve; });
      const first = new Promise((resolve) => { started = resolve; });
      t.after(async () => { release(); await context.close(); });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const server = serve("en", reads, allowance);
      let active = 0, peak = 0, calls = 0;
      await page.route("**/*", async (route) => {
        if (new URL(route.request().url()).pathname !== "/api/usage/quotas") return server(route);
        active++;
        peak = Math.max(peak, active);
        try {
          if (++calls === 1) { started(); await held; }
          await server(route);
        } finally { active--; }
      });
      await page.goto("http://magpie.test/?mode=panel");
      await first;
      await page.locator('#ptabs [data-ptab="usage"]').click();
      release();
      await page.waitForFunction(() => document.querySelector(".pq-card")?.textContent.includes("75%"));
      assert(reads.some(Boolean), "the pending ordinary read does not swallow the user's request");
      assert.equal(peak, 1, "allowance reads remain serialized");
    });
  });
}
