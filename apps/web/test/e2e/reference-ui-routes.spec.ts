import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, expect, collectPageErrors } from "./fixtures.js";

/**
 * Прямые маршруты 10 экранов в populated-фазе (plan-27 Task 9): реальная
 * загрузка без route-ошибки/not-found, ключевые action-группы реализованного
 * UI и отсутствие console/network-ошибок в браузере.
 */

type RouteCase = {
  key: string;
  route: string;
  heading: string | RegExp | null;
  buttons: string[];
  links: string[];
  content: string[];
};

const ROUTES: RouteCase[] = [
  {
    key: "dashboard", route: "/", heading: "Обзор",
    buttons: [], links: ["Новый запрос"],
    content: ["Ebb AI Hub", "Открыть очередь", "Монитор"],
  },
  {
    key: "task", route: "/tasks/task-425", heading: "Streaming",
    buttons: ["Приостановить задачу", "Применить приоритет"], links: [],
    content: [],
  },
  {
    key: "epic", route: "/epics/epic-42", heading: "Anthropic Provider",
    buttons: ["Перепланировать", "Приостановить эпик"], links: [],
    content: [],
  },
  {
    key: "approvals", route: "/approvals", heading: "Входящие согласования",
    buttons: ["Согласовать", "Отклонить", "Запросить изменения"], links: ["Политики согласований"],
    content: ["Ожидают решения"],
  },
  {
    key: "execution", route: "/execution", heading: "Монитор выполнения",
    buttons: ["Остановить всех агентов", "Обновить"], links: [],
    content: ["run-841", "Выполняются"],
  },
  {
    key: "project", route: "/projects/proj-1", heading: /Ebb AI Hub/,
    buttons: ["Приостановить проект", "Синхронизировать сейчас"], links: [],
    content: [],
  },
  {
    key: "onboarding", route: "/projects/new", heading: "Настройка проекта",
    buttons: ["Начать анализ"], links: [],
    content: [],
  },
  {
    key: "settings", route: "/settings", heading: "Настройки",
    buttons: ["Изменить"], links: [],
    content: ["Выбрать проект"],
  },
  {
    key: "usage", route: "/usage", heading: null,
    buttons: [], links: [],
    content: [],
  },
  {
    key: "run", route: "/runs/run-841", heading: "Запуск агента: run-841",
    buttons: ["Создать контрольную точку", "Приостановить запуск", "Отменить запуск"], links: [],
    content: ["TASK-425"],
  },
];

const ROUTE_ERROR_TEXT = "Не удалось безопасно отобразить эту страницу.";
const NOT_FOUND_TEXT = "Запрошенный маршрут отсутствует в этой системе управления.";

function record(line: Record<string, unknown>): void {
  const reportDirValue = process.env.EBB_E2E_REPORT_DIR ?? process.env.EBB_E2E_HOME;
  if (!reportDirValue) return;
  const reportDir = resolve(reportDirValue);
  const file = join(reportDir, "reference-ui-populated.jsonl");
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(line)}\n`, { flag: "a" });
}

async function loginThroughUi(page: import("@playwright/test").Page, password: Readonly<Buffer>): Promise<void> {
  await page.goto("/");
  const loginHeading = page.getByRole("heading", { name: "Вход в Ebb Orchestrator" });
  if (process.env.EBB_E2E_DEBUG_LOGIN === "1" && !(await loginHeading.isVisible().catch(() => false))) {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 500));
    const title = await page.title();
    console.log(`[DBG-LOGIN] title=${JSON.stringify(title)} body=${JSON.stringify(body)} url=${page.url()}`);
    const shotDir = process.env.EBB_E2E_REPORT_DIR ?? process.env.EBB_E2E_HOME;
    if (shotDir) await page.screenshot({ path: join(resolve(shotDir), "dbg-login.png") });
  }
  await expect(loginHeading).toBeVisible();
  const passwordField = page.getByLabel("Пароль");
  await passwordField.fill(password.toString("utf8"));
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toBeVisible({ timeout: 15_000 });
}

for (const routeCase of ROUTES) {
  test(`[populated] ${routeCase.key}: direct route renders implemented UI without console/network errors`, async ({ page, e2ePassword }) => {
    const errors = collectPageErrors(page);

    await loginThroughUi(page, e2ePassword);
    await page.goto(routeCase.route);
    await expect(page.getByText(ROUTE_ERROR_TEXT)).toHaveCount(0);
    await expect(page.getByText(NOT_FOUND_TEXT)).toHaveCount(0);

    if (routeCase.heading !== null && typeof routeCase.heading === "string") {
      await expect(page.getByRole("heading", { name: routeCase.heading }).first(), `${routeCase.key}: missing heading`).toBeVisible({ timeout: 15_000 });
    } else if (routeCase.heading !== null) {
      await expect(page.getByRole("heading").filter({ hasText: routeCase.heading }).first(), `${routeCase.key}: missing heading`).toBeVisible({ timeout: 15_000 });
    }
    for (const action of routeCase.buttons) {
      await expect(page.getByRole("button", { name: action }).first(), `${routeCase.key}: missing button ${action}`).toBeVisible({ timeout: 15_000 });
    }
    for (const action of routeCase.links) {
      await expect(page.getByRole("link", { name: action }).first(), `${routeCase.key}: missing link ${action}`).toBeVisible({ timeout: 15_000 });
    }
    for (const content of routeCase.content) {
      await expect(page.getByText(content).first(), `${routeCase.key}: missing content ${content}`).toBeVisible({ timeout: 15_000 });
    }

    record({ phase: "populated", screen: routeCase.key, route: routeCase.route, errors });
    expect(errors, `${routeCase.key}: browser console/network errors`).toEqual([]);
  });
}
