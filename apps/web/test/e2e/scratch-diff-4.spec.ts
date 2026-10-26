import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect, collectPageErrors } from "./fixtures.js";
import { decodePng } from "./png-diff.mjs";

// TEMPORARY diagnostic spec for Agent-A screens (dashboard/project/epic/task).
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
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "narrow", width: 390, height: 844 },
];

const EXCLUDED_REGIONS: Record<string, Array<{ selectors: string[] }>> = {
  dashboard: [
    { selectors: [".metric:nth-child(1)"] },
    { selectors: [".metric:nth-child(4)"] },
    { selectors: [".grid > div:first-child > .card:nth-child(1)"] },
    { selectors: [".grid > div:last-child > .card:nth-child(1)"] },
    { selectors: [".grid > div:last-child > .card:nth-child(3)"] },
    { selectors: [".grid > div:first-child > .card:nth-child(2)"] },
    { selectors: [".qitem .meta"] },
  ],
  task: [
    { selectors: [".card:nth-of-type(4)"] },
    { selectors: [".grid > div:last-child > .card:nth-child(1)"] },
    { selectors: [".grid > div:last-child > .card:nth-child(3)"] },
    { selectors: [".grid > div:last-child > .card:nth-child(4)"] },
    { selectors: [".grid > div:last-child > .card:nth-child(5)"] },
    { selectors: [".timeline .event div"] },
  ],
  epic: [
    { selectors: [".card:nth-of-type(2)"] },
    { selectors: [".grid > div:last-child > .card:nth-child(4)"] },
    { selectors: [".timeline .event div"] },
  ],
  project: [
    { selectors: [".grid > div:first-child > .card:nth-child(2)"] },
    { selectors: [".grid > div:last-child > .card:nth-child(3)"] },
    { selectors: [".grid > div:last-child > .card:nth-child(4)"] },
    { selectors: [".grid > div:last-child > .card:nth-child(2)"] },
  ],
};

// Region selector sets per screen (reference DOM), used for per-region diff stats.
const REGIONS: Record<string, Array<{ label: string; selectors: string[] }>> = {
  dashboard: [
    { label: "sidebar", selectors: [".sidebar"] },
    { label: "topbar-title", selectors: [".topbar .title"] },
    { label: "topbar-actions", selectors: [".topbar .actions"] },
    { label: "metric1", selectors: [".metric:nth-child(1)"] },
    { label: "metric2", selectors: [".metric:nth-child(2)"] },
    { label: "metric3", selectors: [".metric:nth-child(3)"] },
    { label: "metric4", selectors: [".metric:nth-child(4)"] },
    { label: "card-projects", selectors: [".grid > div:first-child > .card:nth-child(1)"] },
    { label: "card-chat", selectors: [".grid > div:first-child > .card:nth-child(2)"] },
    { label: "card-approvals", selectors: [".grid > div:last-child > .card:nth-child(1)"] },
    { label: "card-queue", selectors: [".grid > div:last-child > .card:nth-child(2)"] },
    { label: "card-pool", selectors: [".grid > div:last-child > .card:nth-child(3)"] },
    { label: "qitem1", selectors: [".qitem:nth-child(1)"] },
    { label: "qitem2", selectors: [".qitem:nth-child(2)"] },
    { label: "qitem3", selectors: [".qitem:nth-child(3)"] },
    { label: "qitem4", selectors: [".qitem:nth-child(4)"] },
    { label: "footer", selectors: [".footer-note"] },
  ],
  project: [
    { label: "topbar-title", selectors: [".topbar .title"] },
    { label: "topbar-actions", selectors: [".topbar .actions"] },
    { label: "tabs", selectors: [".tabs"] },
    { label: "metric1", selectors: [".metric:nth-child(1)"] },
    { label: "metric2", selectors: [".metric:nth-child(2)"] },
    { label: "metric3", selectors: [".metric:nth-child(3)"] },
    { label: "metric4", selectors: [".metric:nth-child(4)"] },
    { label: "metric5", selectors: [".metric:nth-child(5)"] },
    { label: "card-epic", selectors: [".grid > div:first-child > .card:nth-child(1)"] },
    { label: "card-graph", selectors: [".grid > div:first-child > .card:nth-child(2)"] },
    { label: "card-state", selectors: [".grid > div:last-child > .card:nth-child(1)"] },
    { label: "card-activity", selectors: [".grid > div:last-child > .card:nth-child(2)"] },
    { label: "card-budget", selectors: [".grid > div:last-child > .card:nth-child(3)"] },
    { label: "card-coordinator", selectors: [".grid > div:last-child > .card:nth-child(4)"] },
    { label: "task-row1", selectors: [".task:nth-child(1)"] },
    { label: "task-row2", selectors: [".task:nth-child(2)"] },
    { label: "task-row3", selectors: [".task:nth-child(3)"] },
    { label: "task-row4", selectors: [".task:nth-child(4)"] },
    { label: "task-row5", selectors: [".task:nth-child(5)"] },
    { label: "footer", selectors: [".footer-note"] },
  ],
  epic: [
    { label: "topbar-title", selectors: [".topbar .title"] },
    { label: "topbar-actions", selectors: [".topbar .actions"] },
    { label: "tabs", selectors: [".tabs"] },
    { label: "metric1", selectors: [".metric:nth-child(1)"] },
    { label: "metric2", selectors: [".metric:nth-child(2)"] },
    { label: "metric3", selectors: [".metric:nth-child(3)"] },
    { label: "metric4", selectors: [".metric:nth-child(4)"] },
    { label: "metric5", selectors: [".metric:nth-child(5)"] },
    { label: "card-lifecycle", selectors: [".grid > div:first-child > .card:nth-child(1)"] },
    { label: "card-graph", selectors: [".grid > div:first-child > .card:nth-child(2)"] },
    { label: "card-contract", selectors: [".grid > div:first-child > .card:nth-child(3)"] },
    { label: "card-branch", selectors: [".grid > div:last-child > .card:nth-child(1)"] },
    { label: "card-agents", selectors: [".grid > div:last-child > .card:nth-child(2)"] },
    { label: "card-approvals", selectors: [".grid > div:last-child > .card:nth-child(3)"] },
    { label: "card-budget", selectors: [".grid > div:last-child > .card:nth-child(4)"] },
    { label: "card-events", selectors: [".grid > div:last-child > .card:nth-child(5)"] },
    { label: "stage1", selectors: [".stage:nth-child(1)"] },
    { label: "stage2", selectors: [".stage:nth-child(2)"] },
    { label: "stage3", selectors: [".stage:nth-child(3)"] },
    { label: "stage4", selectors: [".stage:nth-child(4)"] },
    { label: "stage5", selectors: [".stage:nth-child(5)"] },
    { label: "stage6", selectors: [".stage:nth-child(6)"] },
    { label: "footer", selectors: [".footer-note"] },
  ],
  task: [
    { label: "topbar-title", selectors: [".topbar .title"] },
    { label: "topbar-actions", selectors: [".topbar .actions"] },
    { label: "tabs", selectors: [".tabs"] },
    { label: "metric1", selectors: [".metric:nth-child(1)"] },
    { label: "metric2", selectors: [".metric:nth-child(2)"] },
    { label: "metric3", selectors: [".metric:nth-child(3)"] },
    { label: "metric4", selectors: [".metric:nth-child(4)"] },
    { label: "metric5", selectors: [".metric:nth-child(5)"] },
    { label: "card-process", selectors: [".grid > div:first-child > .card:nth-child(1)"] },
    { label: "card-contract", selectors: [".grid > div:first-child > .card:nth-child(2)"] },
    { label: "card-runs", selectors: [".grid > div:first-child > .card:nth-child(3)"] },
    { label: "card-findings", selectors: [".grid > div:first-child > .card:nth-child(4)"] },
    { label: "card-git", selectors: [".grid > div:last-child > .card:nth-child(1)"] },
    { label: "card-agent", selectors: [".grid > div:last-child > .card:nth-child(2)"] },
    { label: "card-recovery", selectors: [".grid > div:last-child > .card:nth-child(3)"] },
    { label: "card-usage", selectors: [".grid > div:last-child > .card:nth-child(4)"] },
    { label: "card-deps", selectors: [".grid > div:last-child > .card:nth-child(5)"] },
    { label: "card-events", selectors: [".grid > div:last-child > .card:nth-child(6)"] },
    { label: "run1", selectors: [".run:nth-child(1)"] },
    { label: "run2", selectors: [".run:nth-child(2)"] },
    { label: "run3", selectors: [".run:nth-child(3)"] },
    { label: "run4", selectors: [".run:nth-child(4)"] },
    { label: "footer", selectors: [".footer-note"] },
  ],
};

async function collectRects(page, selectors: string[]): Promise<Array<{ x: number; y: number; w: number; h: number }>> {
  const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const selector of selectors) {
    const found = await page.evaluate((sel) => {
      return Array.from(document.querySelectorAll(sel)).map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }).filter((r) => r.w > 0 && r.h > 0 && r.y < window.innerHeight && r.y + r.h > 0);
    }, selector);
    rects.push(...found);
  }
  return rects;
}

function inRect(px: number, py: number, rect: { x: number; y: number; w: number; h: number }): boolean {
  return px >= rect.x && px < rect.x + rect.w && py >= rect.y && py < rect.y + rect.h;
}

for (const [key, file, route] of SCREENS) {
  for (const vp of VIEWPORTS) {
    test(`diff ${key}@${vp.name}`, async ({ page, e2ePassword }) => {
      const errors = collectPageErrors(page);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const referenceUrl = pathToFileURL(join(referenceDir, file)).href;
      await page.goto(referenceUrl);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(400);
      const refShot = await page.screenshot({ fullPage: false });

      // Collect reference exclusion rects while still on the reference document.
      const defs = EXCLUDED_REGIONS[key] ?? [];
      const masks = defs.length > 0 ? await collectRects(page, defs.flatMap((d) => d.selectors)) : [];
      const regionDefs = REGIONS[key] ?? [];
      const regions = [];
      for (const rd of regionDefs) {
        regions.push({ label: rd.label, rects: await collectRects(page, rd.selectors) });
      }

      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Вход в Ebb Orchestrator" })).toBeVisible();
      await page.getByLabel("Пароль").fill(e2ePassword.toString("utf8"));
      await page.getByRole("button", { name: "Войти" }).click();
      await expect(page.getByRole("navigation", { name: "Основная навигация" })).toBeVisible({ timeout: 15_000 });

      await page.goto(route);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(1400);
      const appShot = await page.screenshot({ fullPage: false });

      writeFileSync(join(outDir, `${key}-${vp.name}-ref.png`), refShot);
      writeFileSync(join(outDir, `${key}-${vp.name}-app.png`), appShot);

      const A = decodePng(refShot);
      const B = decodePng(appShot);
      const W = Math.min(A.width, B.width);
      const H = Math.min(A.height, B.height);
      const TH = 51;

      // masked ratio using same exclusions as the gate
      // (masks collected above while on the reference document)

      // diff overlay via browser canvas
      const maskData = masks.map((m) => [m.x, m.y, m.w, m.h]);
      const diffDataUrl: string = await page.evaluate(async ([w, h, aB64, bB64, masksJson]) => {
        const masks: Array<[number, number, number, number]> = masksJson as Array<[number, number, number, number]>;
        function inRect(px: number, py: number, r: [number, number, number, number]): boolean {
          return px >= r[0] && px < r[0] + r[2] && py >= r[1] && py < r[1] + r[3];
        }
        async function load(src: string): Promise<ImageData> {
          const img = new Image();
          img.src = src;
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
          const c = document.createElement("canvas");
          c.width = w; c.height = h;
          const ctx = c.getContext("2d")!;
          ctx.drawImage(img, 0, 0, w, h);
          return ctx.getImageData(0, 0, w, h);
        }
        const a = await load(aB64);
        const b = await load(bB64);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d")!;
        const out = ctx.createImageData(w, h);
        for (let i = 0; i < w * h; i++) {
          const p = i * 4;
          const px = i % w;
          const py = Math.floor(i / w);
          const dR = Math.abs(a.data[p] - b.data[p]);
          const dG = Math.abs(a.data[p + 1] - b.data[p + 1]);
          const dB = Math.abs(a.data[p + 2] - b.data[p + 2]);
          let excluded = false;
          for (const r of masks) { if (inRect(px, py, r)) { excluded = true; break; } }
          if (excluded) {
            out.data[p] = 60; out.data[p + 1] = 60; out.data[p + 2] = 66; out.data[p + 3] = 255;
          } else if (dR > 51 || dG > 51 || dB > 51) {
            out.data[p] = 255; out.data[p + 1] = 0; out.data[p + 2] = 0; out.data[p + 3] = 255;
          } else {
            out.data[p] = 250; out.data[p + 1] = 250; out.data[p + 2] = 250; out.data[p + 3] = 255;
          }
        }
        ctx.putImageData(out, 0, 0);
        return canvas.toDataURL("image/png");
      }, [W, H, `data:image/png;base64,${refShot.toString("base64")}`, `data:image/png;base64,${appShot.toString("base64")}`, maskData] as const);

      const diffBuf = Buffer.from(diffDataUrl.split(",")[1]!, "base64");
      writeFileSync(join(outDir, `${key}-${vp.name}-diff.png`), diffBuf);

      let diffPixels = 0, comparedPixels = 0, excisedPixels = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const dR = Math.abs(A.data[i] - B.data[i]);
          const dG = Math.abs(A.data[i + 1] - B.data[i + 1]);
          const dB = Math.abs(A.data[i + 2] - B.data[i + 2]);
          let excluded = false;
          for (const r of masks) { if (inRect(x, y, r)) { excluded = true; break; } }
          if (excluded) { excisedPixels++; continue; }
          comparedPixels++;
          if (dR > TH || dG > TH || dB > TH) diffPixels++;
        }
      }
      const ratio = comparedPixels > 0 ? diffPixels / comparedPixels : 1;

      const regionStats: Array<{ label: string; total: number; diff: number; frac: number }> = [];
      for (const region of regions) {
        let total = 0, diff = 0;
        for (const r of region.rects) {
          for (let yy = Math.max(0, r.y); yy < Math.min(H, r.y + r.h); yy++) {
            for (let xx = Math.max(0, r.x); xx < Math.min(W, r.x + r.w); xx++) {
              const i = (yy * W + xx) * 4;
              const dR = Math.abs(A.data[i] - B.data[i]);
              const dG = Math.abs(A.data[i + 1] - B.data[i + 1]);
              const dB = Math.abs(A.data[i + 2] - B.data[i + 2]);
              total++;
              if (dR > TH || dG > TH || dB > TH) diff++;
            }
          }
        }
        regionStats.push({ label: region.label, total, diff, frac: total > 0 ? diff / total : 0 });
      }
      regionStats.sort((a, b) => b.diff - a.diff);

      console.log(`== ${key}@${vp.name} ${W}x${H} maskedRatio=${ratio.toFixed(4)} compared=${comparedPixels} excised=${excisedPixels}`);
      for (const rs of regionStats) {
        if (rs.diff > 0) console.log(`REGION ${rs.label} diff=${rs.diff} total=${rs.total} frac=${rs.frac.toFixed(3)}`);
      }

      const CELL = 32;
      const hot: Array<{ x: number; y: number; frac: number }> = [];
      for (let cy = 0; cy < H; cy += CELL) {
        let line = "";
        for (let cx = 0; cx < W; cx += CELL) {
          let diff = 0, n = 0;
          for (let y = cy; y < Math.min(cy + CELL, H); y++) {
            for (let x = cx; x < Math.min(cx + CELL, W); x++) {
              const i = (y * W + x) * 4;
              const dR = Math.abs(A.data[i] - B.data[i]);
              const dG = Math.abs(A.data[i + 1] - B.data[i + 1]);
              const dB = Math.abs(A.data[i + 2] - B.data[i + 2]);
              if (dR > TH || dG > TH || dB > TH) diff++;
              n++;
            }
          }
          const frac = n > 0 ? diff / n : 0;
          if (frac > 0.15) hot.push({ x: cx, y: cy, frac });
          line += frac > 0.5 ? "#" : frac > 0.15 ? "+" : frac > 0.02 ? "." : " ";
        }
        console.log(String(cy).padStart(4) + " " + line);
      }
      writeFileSync(join(outDir, `${key}-${vp.name}-hot.json`), JSON.stringify(hot));
      writeFileSync(join(outDir, `${key}-${vp.name}-meta.json`), JSON.stringify({ ratio, comparedPixels, excisedPixels, W, H, errors, regions: regionStats }));
      expect(errors, `${key}@${vp.name}: console/network errors`).toEqual([]);
    });
  }
}
