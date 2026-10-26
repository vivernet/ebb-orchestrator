import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "./fixtures.js";

// TEMPORARY diagnostic: text/computed-style comparison ref vs app.
// Not part of the gate suite. Not committed.
const repoRoot = resolve(process.cwd(), "../..");
const referenceDir = join(repoRoot, "docs/architecture/reference-ui");
const outDir = process.env.EBB_E2E_REPORT_DIR ?? process.env.EBB_E2E_HOME ?? join(repoRoot, "temp");
mkdirSync(outDir, { recursive: true });

const SCREENS: Array<[string, string, string]> = [
  ["dashboard", "01-dashboard-concept.html", "/"],
  ["project", "06-project-view-concept.html", "/projects/proj-1"],
  ["epic", "03-epic-view-concept.html", "/epics/epic-42"],
  ["task", "02-task-view-concept.html", "/tasks/task-425"],
];

const PAIRS: Record<string, Array<{ label: string; ref: string; app: string }>> = {
  dashboard: [
    { label: "title-h1", ref: ".title h1", app: ".pf-title h1" },
    { label: "title-p", ref: ".title p", app: ".pf-title p" },
    { label: "actions", ref: ".actions .btn", app: ".pf-actions .pf-btn, .pf-actions a.pf-btn" },
    { label: "metric-span", ref: ".metric > span", app: ".pf-metric > span" },
    { label: "metric-b", ref: ".metric > b", app: ".pf-metric > b" },
    { label: "queue-count", ref: ".qitem", app: ".pf-qitem" },
    { label: "sidebar-nav", ref: ".nav a", app: ".left-nav nav a" },
    { label: "sidebar-brand", ref: ".brand", app: ".left-nav .brand" },
    { label: "sidebar-bottom", ref: ".bottom", app: ".nav-footnote" },
    { label: "footer", ref: ".footer-note", app: ".pf-footer-note" },
    { label: "h3s", ref: ".card h3", app: ".pf-card h3" },
    { label: "btn-full", ref: ".actions .btn, .card .btn", app: ".pf-btn" },
  ],
  project: [
    { label: "title-h1", ref: ".title h1", app: ".pf-title h1" },
    { label: "title-p", ref: ".title p", app: ".pf-title p" },
    { label: "actions", ref: ".actions .btn", app: ".pf-actions .pf-btn, .pf-actions a.pf-btn" },
    { label: "tabs", ref: ".tab", app: ".pf-tab" },
    { label: "metric-span", ref: ".metric > span", app: ".pf-metric > span" },
    { label: "metric-b", ref: ".metric > b", app: ".pf-metric > b" },
    { label: "epic-h3", ref: ".card h3", app: ".pf-card h3" },
    { label: "task-row", ref: ".task", app: ".pf-task" },
    { label: "task-status", ref: ".task .status", app: ".pf-task .pf-status, .pf-task > span:first-child" },
    { label: "kv", ref: ".kv", app: ".pf-kv" },
    { label: "footer", ref: ".footer-note", app: ".pf-footer-note" },
  ],
  epic: [
    { label: "title-h1", ref: ".title h1", app: ".pf-title h1" },
    { label: "title-p", ref: ".title p", app: ".pf-title p" },
    { label: "actions", ref: ".actions .btn", app: ".pf-actions .pf-btn, .pf-actions a.pf-btn" },
    { label: "tabs", ref: ".tab", app: ".pf-tab" },
    { label: "metric-span", ref: ".metric > span", app: ".pf-metric > span" },
    { label: "metric-b", ref: ".metric > b", app: ".pf-metric > b" },
    { label: "pipeline-stage", ref: ".stage", app: ".pf-stage" },
    { label: "agent", ref: ".agent", app: ".pf-agent" },
    { label: "approval", ref: ".approval", app: ".pf-approval" },
    { label: "event", ref: ".event", app: ".pf-event" },
    { label: "branch", ref: ".branch", app: ".pf-branch" },
    { label: "footer", ref: ".footer-note", app: ".pf-footer-note" },
  ],
  task: [
    { label: "title-h1", ref: ".title h1", app: ".pf-title h1" },
    { label: "title-p", ref: ".title p", app: ".pf-title p" },
    { label: "actions", ref: ".actions .btn", app: ".pf-actions .pf-btn, .pf-actions a.pf-btn" },
    { label: "tabs", ref: ".tab", app: ".pf-tab" },
    { label: "metric-span", ref: ".metric > span", app: ".pf-metric > span" },
    { label: "metric-b", ref: ".metric > b", app: ".pf-metric > b" },
    { label: "pipeline-stage", ref: ".stage", app: ".pf-stage" },
    { label: "contract-block", ref: ".block", app: ".pf-block" },
    { label: "run", ref: ".run", app: ".pf-run" },
    { label: "finding", ref: ".finding", app: ".pf-card" },
    { label: "git-branch", ref: ".branch", app: ".pf-branch" },
    { label: "event", ref: ".event", app: ".pf-event" },
    { label: "footer", ref: ".footer-note", app: ".pf-footer-note" },
  ],
};

async function dump(page, selector: string) {
  return page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(sel)).map((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
        font: `${cs.fontSize}/${cs.fontWeight}/${cs.fontFamily.split(",")[0]}`,
        color: cs.color,
        bg: cs.backgroundColor,
        border: cs.borderColor,
        radius: cs.borderRadius,
        pad: cs.padding,
        w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y),
        display: cs.display, align: cs.textAlign,
      };
    });
  }, selector);
}

for (const [key, file, route] of SCREENS) {
  test(`cmp ${key}`, async ({ page, e2ePassword }) => {
    const lines: string[] = [];
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(pathToFileURL(join(referenceDir, file)).href);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(300);
    const refData: Record<string, unknown[]> = {};
    for (const pair of PAIRS[key] ?? []) {
      refData[pair.label] = await dump(page, pair.ref);
    }
    await page.goto("/");
    await page.getByLabel("Пароль").fill(e2ePassword.toString("utf8"));
    await page.getByRole("button", { name: "Войти" }).click();
    await page.getByRole("navigation", { name: "Основная навигация" }).waitFor({ timeout: 15_000 });
    await page.goto(route);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1400);
    const containers = await page.evaluate(() => {
      const sels = [".app-shell", ".main-content", ".route-outlet", ".reference-screen", ".pf-topbar", ".left-nav", ".route-breadcrumbs", ".dashboard-page", ".reference-screen--dashboard", "#root > button"];
      const sheets = Array.from(document.styleSheets).map((s, i) => {
        let matched = "";
        try {
          const rules = s.cssRules;
          outer: for (const r of Array.from(rules)) {
            const css = r as CSSStyleRule;
            if (css.selectorText && (css.selectorText.includes(".pf-title") || css.selectorText.includes(".route-breadcrumbs") || css.selectorText.includes(".left-nav a"))) {
              matched = `${css.selectorText} {${css.style.fontWeight ?? ""}}`;
              if (css.selectorText === ".pf-title h1" || css.selectorText === ".route-breadcrumbs") break outer;
            }
          }
        } catch { matched = "err"; }
        return { i, href: s.href, matched };
      });
      const c = sels.map((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { sel, missing: true };
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { sel, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), pad: cs.padding, margin: cs.margin, display: cs.display };
      });
      return { c, sheets };
    });
    lines.push("## containers");
    const containerList = (containers as { c?: Array<Record<string, unknown>>; sheets?: Array<unknown> }).c ?? [];
    for (const c of containerList) lines.push(`  ${JSON.stringify(c)}`);
    lines.push("## sheets");
    for (const s of (containers as { sheets?: Array<unknown> }).sheets ?? []) lines.push(`  ${JSON.stringify(s)}`);
    for (const pair of PAIRS[key] ?? []) {
      const appData = await dump(page, pair.app);
      lines.push(`## ${pair.label} (ref=${refData[pair.label].length} app=${appData.length})`);
      for (let i = 0; i < Math.max(refData[pair.label].length, appData.length); i++) {
        const a = refData[pair.label][i] as Record<string, unknown> | undefined;
        const b = appData[i] as Record<string, unknown> | undefined;
        const detail: string[] = [];
        for (const f of ["text", "font", "color", "bg", "border", "radius", "pad", "w", "h", "x", "y", "display", "align"]) {
          const av = a?.[f];
          const bv = b?.[f];
          const same = typeof av === "number" && typeof bv === "number" ? Math.abs((av as number) - (bv as number)) <= 1 : av === bv;
          if (!same) detail.push(`${f}: ref=${String(av)} app=${String(bv)}`);
        }
        if (detail.length > 0) lines.push(`  [${i}] ${detail.join(" | ")}`);
      }
    }
    writeFileSync(join(outDir, `${key}-textcmp.txt`), lines.join("\n"));
    console.log(`TEXTCMP ${key} lines=${lines.length}`);
  });
}
