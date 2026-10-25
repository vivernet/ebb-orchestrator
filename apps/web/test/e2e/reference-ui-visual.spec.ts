import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, expect } from "./fixtures.js";

/**
 * Baseline реального браузера (plan-27 Task 1): скриншоты 10 референсных
 * экранов на desktop (1440×900) и narrow (390×844) viewport + запись того,
 * какие reference-секции видны. Ожидается RED до Tasks 2–8; это не pass gate.
 */

type RouteCase = { key: string; label: string; route: string; referenceHeadings: string[] };

const ROUTES: RouteCase[] = [
  { key: "dashboard", label: "Панель управления", route: "/", referenceHeadings: ["Панель управления"] },
  { key: "task", label: "TASK-425", route: "/tasks/task-425", referenceHeadings: [] },
  { key: "epic", label: "EPIC-42", route: "/epics/epic-42", referenceHeadings: [] },
  { key: "approvals", label: "Центр согласований", route: "/approvals", referenceHeadings: ["Центр согласований"] },
  { key: "execution", label: "Очередь выполнения", route: "/execution", referenceHeadings: ["Очередь выполнения"] },
  { key: "project", label: "Ebb AI Hub", route: "/projects/proj-1", referenceHeadings: [] },
  { key: "onboarding", label: "Добавление проекта", route: "/projects/new", referenceHeadings: ["Добавление проекта"] },
  { key: "settings", label: "Настройки проекта", route: "/settings", referenceHeadings: ["Настройки проекта"] },
  { key: "usage", label: "Использование и бюджет", route: "/usage", referenceHeadings: ["Использование и бюджет"] },
  { key: "run", label: "RUN-841", route: "/runs/run-841", referenceHeadings: [] },
];

const VIEWPORTS: Array<{ name: string; width: number; height: number }> = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "narrow", width: 390, height: 844 },
];

function record(line: Record<string, unknown>): void {
  const reportDirValue = process.env.EBB_E2E_REPORT_DIR ?? process.env.EBB_E2E_HOME;
  if (!reportDirValue) return;
  const reportDir = resolve(reportDirValue);
  const file = join(reportDir, "reference-ui-baseline.jsonl");
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(line)}\n`, { flag: "a" });
}

async function loginThroughUi(page: import("@playwright/test").Page, password: Readonly<Buffer>): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Вход в Ebb Orchestrator" })).toBeVisible();
  await page.getByLabel("Пароль").fill(password.toString("utf8"));
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toBeVisible();
}

for (const routeCase of ROUTES) {
  for (const viewport of VIEWPORTS) {
    test(`[baseline] ${routeCase.key} @${viewport.name}: screenshot and visible reference sections`, async ({ page, e2ePassword }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await loginThroughUi(page, e2ePassword);
      await page.goto(routeCase.route);
      await page.waitForTimeout(1500);

      const reportDirValue = process.env.EBB_E2E_REPORT_DIR ?? process.env.EBB_E2E_HOME;
      const reportDir = reportDirValue ? resolve(reportDirValue) : undefined;
      const screenshot = reportDir ? join(reportDir, `reference-${routeCase.key}-${viewport.name}.png`) : undefined;
      if (screenshot) {
        mkdirSync(reportDir!, { recursive: true });
        await page.screenshot({ path: screenshot, fullPage: true });
      }

      const headings = (await page.locator("h1, h2").allTextContents()).map((text) => text.trim()).filter(Boolean);
      const missingSections = routeCase.referenceHeadings.filter((heading) => !headings.includes(heading));
      const bodyTextLength = await page.evaluate(() => document.body.innerText.length);

      record({
        phase: "baseline-visual",
        screen: routeCase.key,
        viewport: viewport.name,
        route: routeCase.route,
        screenshot,
        headings,
        missingSections,
        bodyTextLength,
      });

      expect(bodyTextLength, `${routeCase.key} @${viewport.name}: page rendered no text`).toBeGreaterThan(0);
    });
  }
}
