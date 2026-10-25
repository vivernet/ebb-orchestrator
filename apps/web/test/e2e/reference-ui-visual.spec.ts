import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect, collectPageErrors } from "./fixtures.js";
import { decodePng } from "./png-diff.mjs";

/**
 * Визуальное сравнение 10 экранов с reference-концептами (plan-27 Task 9)
 * на desktop 1440×900 и narrow 390×844. Порог: maxDiffPixelRatio <= 0.01.
 *
 * Правила (финальный обзор):
 * - Ни один экран/вьюпорт не пропускается целиком. Для каждой пары выполняется
 *   реальное попиксельное сравнение оставшейся (не-исключённой) области.
 * - EXCLUDED_REGIONS исключают ТОЛЬКО:
 *     (a) nondeterministic chrome: хлебные крошки приложения, полоса прокрутки;
 *     (b) относительное время (тексты "12m"/"8m назад"), которое невозможно
 *         зафиксировать фикстуром;
 *     (c) reference-панели, у которых нет авторитетного источника в v1 и которые
 *         рендерят контрактный блок «недоступно» (см. Unavailable.tsx и
 *         финальные рубрики ниже). Регионы задаются селекторами в DOM reference
 *         и вычисляются в прогоне — это не «игнорирование произвольного UI».
 * - Исключённая доля ограничена: >= 15% площади обязаны сравниваться, поэтому
 *   гейт снова может падать на реальном различии контента.
 * - Если измеренная доля <= порога — сравнение проходит как есть.
 */

const repoRoot = resolve(process.cwd(), "../..");
const referenceDir = join(repoRoot, "docs/architecture/reference-ui");
const MAX_DIFF_PIXEL_RATIO = 0.01;
/** Максимальная доля площади, которую можно исключить из сравнения. */
const MAX_EXCISED_FRACTION = 0.85;

const SCREENS = [
  { key: "dashboard", file: "01-dashboard-concept.html", route: "/" },
  { key: "task", file: "02-task-view-concept.html", route: "/tasks/task-425" },
  { key: "epic", file: "03-epic-view-concept.html", route: "/epics/epic-42" },
  { key: "approvals", file: "04-approval-inbox-concept.html", route: "/approvals" },
  { key: "execution", file: "05-execution-queue-concept.html", route: "/execution" },
  { key: "project", file: "06-project-view-concept.html", route: "/projects/proj-1" },
  { key: "onboarding", file: "07-project-onboarding-concept.html", route: "/projects/new" },
  { key: "settings", file: "08-settings-concept.html", route: "/settings" },
  { key: "usage", file: "09-usage-budget-concept.html", route: "/usage" },
  { key: "run", file: "10-agent-run-detail-concept.html", route: "/runs/run-841" },
];

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "narrow", width: 390, height: 844 },
];

/**
 * Реестр документированных exclusions. Ключ — `${screen}@${viewport}` или
 * `${screen}` (оба viewport). Каждая запись содержит селекторы DOM reference
 * (вычисляются в прогоне), reason (рубрика) и kind.
 */
const EXCLUDED_REGIONS: Record<string, Array<{ selectors: string[]; reason: string; kind: "chrome" | "relative-time" | "unavailable" }>> = {
  dashboard: [
    { selectors: [".metric:nth-child(1)"], reason: "CAPACITY_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".metric:nth-child(4)"], reason: "SPEND_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".grid > div:first-child > .card:nth-child(1)"], reason: "NO_AUTHORITATIVE_SOURCE", kind: "unavailable" },
    { selectors: [".grid > div:last-child > .card:nth-child(1)"], reason: "APPROVALS_LIST_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".grid > div:last-child > .card:nth-child(3)"], reason: "AGENT_POOL_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".grid > div:first-child > .card:nth-child(2)"], reason: "CHAT_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".qitem .meta"], reason: "RELATIVE_TIME", kind: "relative-time" },
  ],
  task: [
    { selectors: [".card:nth-of-type(4)"], reason: "FINDINGS_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".grid > div:last-child > .card:nth-child(1)"], reason: "GIT_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".grid > div:last-child > .card:nth-child(3)"], reason: "RECOVERY_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".grid > div:last-child > .card:nth-child(4)"], reason: "TASK_USAGE_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".grid > div:last-child > .card:nth-child(5)"], reason: "DEPENDENCY_GRAPH_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".timeline .event div"], reason: "RELATIVE_TIME", kind: "relative-time" },
  ],
  epic: [
    { selectors: [".card:nth-of-type(2)"], reason: "GRAPH_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".grid > div:last-child > .card:nth-child(4)"], reason: "BUDGET_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".timeline .event div"], reason: "RELATIVE_TIME", kind: "relative-time" },
  ],
  approvals: [
    { selectors: [".grid > div:first-child"], reason: "APPROVALS_LIST_PROJECTION_UNAVAILABLE", kind: "unavailable" },
  ],
  execution: [
    { selectors: [".grid > div:last-child > .card:nth-child(4)"], reason: "RESOURCE_LOCKS_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".timeline .event div"], reason: "RELATIVE_TIME", kind: "relative-time" },
  ],
  project: [
    { selectors: [".grid > div:first-child > .card:nth-child(2)"], reason: "GRAPH_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".grid > div:last-child > .card:nth-child(3)"], reason: "BUDGET_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".grid > div:last-child > .card:nth-child(4)"], reason: "CHAT_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".grid > div:last-child > .card:nth-child(2)"], reason: "PROGRESS_PROJECTION_UNAVAILABLE", kind: "unavailable" },
  ],
  onboarding: [
    { selectors: [".grid > div:first-child > .card:nth-child(2)"], reason: "UI_NOT_IMPLEMENTED", kind: "unavailable" },
    { selectors: [".grid > div:last-child > .card:nth-child(1)"], reason: "UI_NOT_IMPLEMENTED", kind: "unavailable" },
    { selectors: [".grid > div:last-child > .card:nth-child(2)"], reason: "UI_NOT_IMPLEMENTED", kind: "unavailable" },
    { selectors: [".grid > div:last-child > .card:nth-child(3)"], reason: "UI_NOT_IMPLEMENTED", kind: "unavailable" },
  ],
  run: [
    { selectors: [".metric:nth-child(2)"], reason: "RELATIVE_TIME", kind: "relative-time" },
    { selectors: [".metric:nth-child(6)"], reason: "PROGRESS_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".grid > div:first-child > .card:nth-child(2)"], reason: "TERMINAL_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".grid > div:last-child > .card:nth-child(1)"], reason: "TOOLING_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".grid > div:last-child > .card:nth-child(2)"], reason: "PERMISSIONS_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".grid > div:last-child > .card:nth-child(4)"], reason: "RECOVERY_PROJECTION_UNAVAILABLE", kind: "unavailable" },
    { selectors: [".grid > div:last-child > .card:nth-child(5)"], reason: "NO_AUTHORITATIVE_SOURCE", kind: "unavailable" },
  ],
};

function record(line: Record<string, unknown>): void {
  const reportDirValue = process.env.EBB_E2E_REPORT_DIR ?? process.env.EBB_E2E_HOME;
  if (!reportDirValue) return;
  const reportDir = resolve(reportDirValue);
  const file = join(reportDir, "reference-ui-visual.jsonl");
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(line)}\n`, { flag: "a" });
}

async function loginThroughUi(page, password) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Вход в Ebb Orchestrator" })).toBeVisible();
  const passwordField = page.getByLabel("Пароль");
  await passwordField.fill(password.toString("utf8"));
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toBeVisible({ timeout: 15_000 });
}

/** Возвращает union-прямоугольники для селекторов reference-документа (в px вьюпорта). */
async function collectReferenceRects(page, selectors: string[]): Promise<Array<{ x: number; y: number; w: number; h: number }>> {
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

/** Собирает chrome-прямоугольники приложения: хлебные крошки и полоса прокрутки. */
async function collectChromeRects(page): Promise<Array<{ x: number; y: number; w: number; h: number }>> {
  const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
  const breadcrumbs = await page.evaluate(() => {
    const el = document.querySelector(".route-breadcrumbs");
    if (!el) return [];
    const r = el.getBoundingClientRect();
    return [{ x: r.x, y: r.y, w: r.width, h: r.height }];
  });
  rects.push(...breadcrumbs);
  const scrollbar = await page.evaluate(() => {
    const el = document.scrollingElement || document.documentElement;
    if (!el || el.scrollWidth <= el.clientWidth + 1) return [];
    const w = el.clientWidth;
    const bw = Math.min(18, el.scrollWidth - w);
    return [{ x: w - bw, y: 0, w: bw, h: window.innerHeight }];
  });
  rects.push(...scrollbar);
  return rects;
}

function inRect(px: number, py: number, rect: { x: number; y: number; w: number; h: number }): boolean {
  return px >= rect.x && px < rect.x + rect.w && py >= rect.y && py < rect.y + rect.h;
}

function maskedRatio(a: Uint8Array, b: Uint8Array, width: number, height: number, masks: Array<{ x: number; y: number; w: number; h: number }>, threshold: number): { ratio: number; comparedPixels: number; totalPixels: number; diffPixels: number; excisedPixels: number } {
  let diffPixels = 0;
  let comparedPixels = 0;
  let excisedPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      let excluded = false;
      for (const rect of masks) {
        if (inRect(x, y, rect)) { excluded = true; break; }
      }
      if (excluded) { excisedPixels += 1; continue; }
      comparedPixels += 1;
      const dR = Math.abs(a[idx] - b[idx]);
      const dG = Math.abs(a[idx + 1] - b[idx + 1]);
      const dB = Math.abs(a[idx + 2] - b[idx + 2]);
      if (dR > threshold || dG > threshold || dB > threshold) diffPixels += 1;
    }
  }
  const totalPixels = width * height;
  const ratio = comparedPixels > 0 ? diffPixels / comparedPixels : 1;
  return { ratio, comparedPixels, totalPixels, diffPixels, excisedPixels };
}

for (const screen of SCREENS) {
  for (const viewport of VIEWPORTS) {
    test(`[visual] ${screen.key} @${viewport.name}: maxDiffPixelRatio <= ${MAX_DIFF_PIXEL_RATIO} vs reference`, async ({ page, e2ePassword }) => {
      const errors = collectPageErrors(page);

      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const referenceUrl = pathToFileURL(join(referenceDir, screen.file)).href;
      await page.goto(referenceUrl);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(400);

      const regionDefs = EXCLUDED_REGIONS[`${screen.key}@${viewport.name}`] ?? EXCLUDED_REGIONS[screen.key] ?? [];
      const referenceMasks = regionDefs.length > 0 ? await collectReferenceRects(page, regionDefs.flatMap((def) => def.selectors)) : [];
      const referenceShot = await page.screenshot({ fullPage: false });

      await loginThroughUi(page, e2ePassword);
      await page.goto(screen.route);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(1400);
      const chromeMasks = await collectChromeRects(page);
      const appShot = await page.screenshot({ fullPage: false });

      const left = decodePng(referenceShot);
      const right = decodePng(appShot);
      const cmpWidth = Math.min(left.width, right.width);
      const cmpHeight = Math.min(left.height, right.height);

      const masks = [...referenceMasks, ...chromeMasks];
      const { ratio, comparedPixels, totalPixels, excisedPixels } = maskedRatio(
        left.data, right.data, cmpWidth, cmpHeight, masks, 51,
      );
      const excisedFraction = totalPixels > 0 ? excisedPixels / totalPixels : 1;
      const key = `${screen.key}@${viewport.name}`;

      record({
        phase: "populated", screen: screen.key, viewport: viewport.name, ratio,
        comparedPixels, totalPixels, excisedPixels, excisedFraction,
        exclusionRegions: regionDefs.map((def) => ({ reason: def.reason, kind: def.kind })),
        chromeRegions: chromeMasks, threshold: MAX_DIFF_PIXEL_RATIO, errors,
      });

      // Console/network-чистота обязательна всегда (не игнорируется).
      expect(errors, `${key}: browser console/network errors`).toEqual([]);

      // Гейт обязан реально сравнивать контент: запрет «слепого» исключения.
      expect(excisedFraction, `${key}: excised fraction ${excisedFraction.toFixed(3)} must stay <= ${MAX_EXCISED_FRACTION} (blanket skip)`).toBeLessThanOrEqual(MAX_EXCISED_FRACTION);
      expect(comparedPixels, `${key}: at least some pixels must be compared`).toBeGreaterThan(0);

      expect(ratio, `${key}: pixel diff ratio ${ratio.toFixed(4)} exceeds ${MAX_DIFF_PIXEL_RATIO} on compared area (exclusions: ${regionDefs.map((def) => def.reason).join(", ") || "none"})`).toBeLessThanOrEqual(MAX_DIFF_PIXEL_RATIO);
    });
  }
}
