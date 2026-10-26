import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect } from "./fixtures.js";
import { decodePng } from "./png-diff.mjs";

// TEMPORARY diagnostic spec — not part of the gate suite. Not committed.
const repoRoot = resolve(process.cwd(), "../..");
const referenceDir = join(repoRoot, "docs/architecture/reference-ui");
const outDir = join(repoRoot, "temp/scratch-diffs");
mkdirSync(outDir, { recursive: true });

const SCREENS: Array<[string, string, string]> = [
  ["approvals", "04-approval-inbox-concept.html", "/approvals"],
  ["execution", "05-execution-queue-concept.html", "/execution"],
  ["onboarding", "07-project-onboarding-concept.html", "/projects/new"],
  ["settings", "08-settings-concept.html", "/settings"],
  ["usage", "09-usage-budget-concept.html", "/usage"],
  ["run", "10-agent-run-detail-concept.html", "/runs/run-841"],
];
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "narrow", width: 390, height: 844 },
];

for (const [key, file, route] of SCREENS) {
  for (const vp of VIEWPORTS) {
    test(`diff ${key}@${vp.name}`, async ({ page, e2ePassword }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const referenceUrl = pathToFileURL(join(referenceDir, file)).href;
      await page.goto(referenceUrl);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(400);
      const refShot = await page.screenshot({ fullPage: false });

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
      const CELL = 32;
      const hot: Array<{ x: number; y: number; frac: number }> = [];
      let mapText = `== ${key}@${vp.name} ${W}x${H}\n`;
      console.log(`== ${key}@${vp.name} ${W}x${H}`);
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
              if (dR > 51 || dG > 51 || dB > 51) diff++;
              n++;
            }
          }
          const frac = n > 0 ? diff / n : 0;
          if (frac > 0.15) hot.push({ x: cx, y: cy, frac });
          line += frac > 0.5 ? "#" : frac > 0.15 ? "+" : frac > 0.02 ? "." : " ";
        }
        mapText += String(cy).padStart(4) + " " + line + "\n";
        console.log(String(cy).padStart(4) + " " + line);
      }
      writeFileSync(join(outDir, `${key}-${vp.name}-map.txt`), mapText);
      writeFileSync(join(outDir, `${key}-${vp.name}-hot.json`), JSON.stringify(hot));
    });
  }
}
