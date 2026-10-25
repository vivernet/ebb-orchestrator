import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, expect } from "./fixtures.js";

/**
 * Baseline реального браузера (plan-27 Task 1): прямые маршруты 10 референсных
 * экранов загружаются без route-ошибки, и все показанные в reference-макетах
 * действия присутствуют. Ожидается RED до Tasks 2–8; это не pass gate.
 */

type RouteCase = {
  key: string;
  label: string;
  route: string;
  referenceActions: string[];
};

const ROUTES: RouteCase[] = [
  { key: "dashboard", label: "Панель управления", route: "/", referenceActions: ["Приостановить всё", "Новый запрос", "Открыть согласования"] },
  { key: "task", label: "TASK-425", route: "/tasks/task-425", referenceActions: ["Приостановить задачу", "Изменить приоритет", "Открыть в рабочем дереве"] },
  { key: "epic", label: "EPIC-42", route: "/epics/epic-42", referenceActions: ["Приостановить epic", "Перепланировать", "Открыть Координатор", "Посмотреть предложение"] },
  { key: "approvals", label: "Центр согласований", route: "/approvals", referenceActions: ["История", "Политики согласований", "Согласовать", "Отклонить", "Запросить изменения"] },
  { key: "execution", label: "Очередь выполнения", route: "/execution", referenceActions: ["Приостановить new work", "Остановить всех агентов", "Приостановить", "Отменить запуск"] },
  { key: "project", label: "Ebb AI Hub", route: "/projects/proj-1", referenceActions: ["Приостановить проект", "Синхронизировать GitHub", "Новый запрос"] },
  { key: "onboarding", label: "Добавление проекта", route: "/projects/new", referenceActions: ["Отмена", "Назад к обнаружению", "Согласовать и активировать проект"] },
  { key: "settings", label: "Настройки проекта", route: "/settings", referenceActions: ["Посмотреть diff конфигурации", "Сохранить изменения"] },
  { key: "usage", label: "Использование и бюджет", route: "/usage", referenceActions: ["Последние 30 дней", "Политики бюджета"] },
  { key: "run", label: "RUN-841", route: "/runs/run-841", referenceActions: ["Создать контрольную точку", "Приостановить", "Отменить запуск"] },
];

const ROUTE_ERROR_TEXT = "Не удалось безопасно отобразить эту страницу.";
const NOT_FOUND_TEXT = "Запрошенный маршрут отсутствует в этой системе управления.";

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
  const passwordField = page.getByLabel("Пароль");
  await passwordField.fill(password.toString("utf8"));
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toBeVisible();
}

for (const routeCase of ROUTES) {
  test(`[baseline] ${routeCase.key}: direct route loads without error page`, async ({ page, e2ePassword }) => {
    await loginThroughUi(page, e2ePassword);
    await page.goto(routeCase.route);
    await page.waitForTimeout(1500);

    const routeError = await page.getByText(ROUTE_ERROR_TEXT).count();
    const notFound = await page.getByText(NOT_FOUND_TEXT).count();
    const headings = (await page.locator("h1, h2").allTextContents()).map((text) => text.trim()).filter(Boolean);
    const buttons = (await page.getByRole("button").allTextContents()).map((text) => text.trim()).filter(Boolean);

    const missingActions = routeCase.referenceActions.filter((action) => !buttons.includes(action));
    record({
      phase: "baseline",
      screen: routeCase.key,
      route: routeCase.route,
      routeError,
      notFound,
      headings: headings.slice(0, 12),
      buttons: buttons.slice(0, 25),
      missingActions,
    });

    expect(routeError, `${routeCase.key}: unexpected route error page`).toBe(0);
    expect(notFound, `${routeCase.key}: unexpected not-found page`).toBe(0);
    for (const action of routeCase.referenceActions) {
      await expect(page.getByRole("button", { name: action }), `${routeCase.key}: missing reference action ${action}`).toBeVisible();
    }
  });
}
