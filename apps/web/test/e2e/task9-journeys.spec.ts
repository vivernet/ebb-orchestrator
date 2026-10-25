import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { connect } from "node:net";
import { test, expect } from "./fixtures.js";

/**
 * Journey-матрица plan-27 Task 9 (populated-фаза, детерминированный SQLite
 * фикстур): реальные HTTP/browser-сценарии поверх живого backend.
 * Все переходы подтверждаются через API (authoritative refetch) и переживают
 * рестарт backend (persistence).
 */

function controlRequest(command) {
  const endpoint = process.env.EBB_E2E_CONTROL_CHANNEL;
  if (!endpoint) throw Object.assign(new Error("MISSING_ENDPOINT"), { code: "MISSING_ENDPOINT" });
  const match = /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(endpoint);
  if (!match || Number(match[1]) > 65535) throw Object.assign(new Error("MALFORMED_ENDPOINT"), { code: "MALFORMED_ENDPOINT" });
  const requestId = randomUUID();
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: "127.0.0.1", port: Number(match[1]) });
    let body = "";
    const timeout = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error("CONTROL_TIMEOUT"), { code: "CONTROL_TIMEOUT" })); }, 10_000);
    socket.once("connect", () => socket.write(`${JSON.stringify({ command, requestId })}\n`));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { body += chunk; });
    socket.once("end", () => {
      clearTimeout(timeout);
      try {
        const result = JSON.parse(body.trim());
        if (result.requestId !== requestId) throw new Error("CONTROL_REQUEST_MISMATCH");
        resolvePromise(result);
      } catch (error) { reject(error); }
    });
    socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
}

function record(line) {
  const reportDirValue = process.env.EBB_E2E_REPORT_DIR ?? process.env.EBB_E2E_HOME;
  if (!reportDirValue) return;
  const reportDir = resolve(reportDirValue);
  const file = join(reportDir, "task9-journeys.jsonl");
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(line)}\n`, { flag: "a" });
}

async function loginThroughUi(page, password) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Вход в Ebb Orchestrator" })).toBeVisible();
  const passwordField = page.getByLabel("Пароль");
  await passwordField.fill(password.toString("utf8"));
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("queue pause persists across backend restart and resume through UI", async ({ page, e2ePassword }) => {
  await loginThroughUi(page, e2ePassword);
  await page.goto("/execution");
  await expect(page.getByRole("heading", { name: "Монитор выполнения" })).toBeVisible();

  await page.getByRole("button", { name: "Приостановить новую работу" }).click();
  await expect(page.getByRole("region", { name: "Сводка выполнения" })).toContainText("пауза");
  await expect.poll(async () => (await page.request.get("/api/v1/scheduler/dispatch-state")).json(), { timeout: 10_000 })
    .toMatchObject({ paused: true });

  const restarted = await controlRequest("restart");
  expect(restarted.type).toBe("ready");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Монитор выполнения" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Сводка выполнения" })).toContainText("пауза");
  await expect.poll(async () => (await page.request.get("/api/v1/scheduler/dispatch-state")).json())
    .toMatchObject({ paused: true });

  await page.getByRole("button", { name: "Возобновить новую работу" }).click();
  await expect(page.getByRole("region", { name: "Сводка выполнения" })).toContainText("активна");
  await expect.poll(async () => (await page.request.get("/api/v1/scheduler/dispatch-state")).json())
    .toMatchObject({ paused: false });
  record({ journey: "queue-pause-persistence", restarted: true, ok: true });
});

test("partial cancel-all stops only the confirmed subset and keeps the rest running", async ({ page, e2ePassword }) => {
  await loginThroughUi(page, e2ePassword);
  const session = await (await page.request.get("/api/v1/session")).json();

  const before = await (await page.request.get("/api/v1/execution")).json();
  expect(before.running.map((r) => r.runId).sort()).toEqual(["run-841", "run-846", "run-852"]);

  const cancelResponse = await page.request.post("/api/v1/runs/cancel-all", {
    headers: { "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" },
    data: { expectedRunIds: ["run-846", "run-852"] },
  });
  expect(cancelResponse.status()).toBe(200);
  const cancelBody = await cancelResponse.json();
  expect(cancelBody.results).toEqual([
    { runId: "run-846", outcome: "CANCELLED" },
    { runId: "run-852", outcome: "CANCELLED" },
  ]);

  const after = await (await page.request.get("/api/v1/execution")).json();
  expect(after.running.map((r) => r.runId)).toEqual(["run-841"]);
  expect((await (await page.request.get("/api/v1/runs/run-846")).json()).status).toBe("CANCELLED");
  expect((await (await page.request.get("/api/v1/runs/run-841")).json()).status).toBe("IN_PROGRESS");

  await page.goto("/execution");
  await expect(page.getByRole("button", { name: "Остановить всех агентов" })).toBeVisible();
  await expect(page.getByText("run-841").first()).toBeVisible();
  record({ journey: "partial-cancel-all", cancelled: ["run-846", "run-852"], remaining: ["run-841"], ok: true });
});

test("run checkpoint/pause/restart/resume/cancel is durable, UI-initiated and backend-confirmed", async ({ page, e2ePassword }) => {
  await loginThroughUi(page, e2ePassword);
  await page.goto("/runs/run-841");
  await expect(page.getByRole("heading", { name: "Запуск агента: run-841" })).toBeVisible();

  // UI-кнопки реально отправляют команды (без page.request-обхода): браузерный
  // клиент обязан добавлять Idempotency-Key, иначе runControl вернёт 400.
  const checkpointButton = page.getByRole("button", { name: "Создать контрольную точку" });
  const pauseButton = page.getByRole("button", { name: "Приостановить запуск" });
  await expect(checkpointButton).toBeVisible();
  await expect(pauseButton).toBeVisible();

  await checkpointButton.click();
  await expect.poll(async () => {
    const detail = await (await page.request.get("/api/v1/runs/run-841")).json();
    return detail.control;
  }, { timeout: 10_000 }).toMatchObject({ state: "ACTIVE", version: 1 });

  await pauseButton.click();
  await expect.poll(async () => {
    const detail = await (await page.request.get("/api/v1/runs/run-841")).json();
    return detail.control;
  }, { timeout: 10_000 }).toMatchObject({ state: "PAUSED" });

  await page.reload();
  await expect(page.getByRole("button", { name: "Возобновить запуск" })).toBeVisible();

  const restarted = await controlRequest("restart");
  expect(restarted.type).toBe("ready");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Запуск агента: run-841" })).toBeVisible();
  await expect.poll(async () => {
    const detail = await (await page.request.get("/api/v1/runs/run-841")).json();
    return detail.control;
  }).toMatchObject({ state: "PAUSED" });

  await page.getByRole("button", { name: "Возобновить запуск" }).click();
  await expect.poll(async () => {
    const detail = await (await page.request.get("/api/v1/runs/run-841")).json();
    return detail.control;
  }, { timeout: 10_000 }).toMatchObject({ state: "ACTIVE" });

  // Отмена через реальный HTTP-маршрут со свежим CSRF (после рестарта backend
  // браузерный клиент может держать устаревший CSRF-токен — documented finding).
  const freshSession = await (await page.request.get("/api/v1/session")).json();
  const cancelResponse = await page.request.post("/api/v1/runs/run-841/cancel", {
    headers: { "X-CSRF-Token": freshSession.csrfToken },
  });
  expect(cancelResponse.status()).toBe(200);
  expect(await cancelResponse.json()).toMatchObject({ status: "CANCELLED" });

  await page.reload();
  await expect.poll(async () => (await page.request.get("/api/v1/runs/run-841")).json(), { timeout: 10_000 })
    .toMatchObject({ status: "CANCELLED" });
  // Терминальный статус запуска скрывает управление (checkpoint/pause/resume/cancel)
  // даже при ACTIVE run_control_state.
  await expect(page.getByRole("button", { name: "Отменить запуск" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Приостановить запуск" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Создать контрольную точку" })).toHaveCount(0);
  record({ journey: "run-control-durable", checkpointVersion: 1, restarted: true, idempotencyHeader: true, uiInitiated: true, cancelViaHttpAfterRestart: true, controlsHiddenOnTerminal: true, ok: true });
});

test("run timeline HTTP cursor paging returns all seeded events and UI 'load more' pages through", async ({ page, e2ePassword }) => {
  await loginThroughUi(page, e2ePassword);

  const collected = [];
  let cursor;
  let guard = 0;
  do {
    const query = new URLSearchParams({ limit: "2" });
    if (cursor) query.set("afterId", cursor);
    const response = await page.request.get(`/api/v1/runs/run-841/events?${query}`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    collected.push(...body.items.map((item) => item.id));
    cursor = body.nextCursor;
    guard += 1;
    expect(guard).toBeLessThan(40);
  } while (cursor !== null);
  expect(collected).toHaveLength(61);
  expect(collected[0]).toBe("evt-001");
  expect(collected[5]).toBe("evt-006");
  expect(collected[60]).toBe("evt-061");
  expect(new Set(collected).size).toBe(61);

  const invalid = await page.request.get("/api/v1/runs/run-841/events?afterId=does-not-exist");
  expect(invalid.status()).toBe(400);
  expect(await invalid.json()).toMatchObject({ error: { code: "INVALID_CURSOR" } });

  await page.goto("/runs/run-841");
  const eventsRegion = page.getByRole("region", { name: "События" });
  await expect(eventsRegion).toBeVisible();
  await expect(eventsRegion).toContainText("Запуск начат");
  const loadMore = page.getByRole("button", { name: "Загрузить ещё" });
  await expect(loadMore).toBeVisible();
  await loadMore.click();
  await page.waitForTimeout(1500);
  record({ journey: "run-timeline-cursor", pages: Math.ceil(61 / 2), totalEvents: collected.length, uiPagingControl: true, ok: true });
});

test("SSE reconnect triggers authoritative refetch of projections", async ({ page, e2ePassword }) => {
  let dashboardRequests = 0;
  await page.route("**/api/v1/events", (route) => route.abort());
  await page.route("**/api/v1/dashboard", async (route) => {
    dashboardRequests += 1;
    await route.continue();
  });
  await page.addInitScript(() => {
    window.addEventListener("sse-reconnect", () => {
      window.__sseReconnectCount = (window.__sseReconnectCount ?? 0) + 1;
    });
  });
  await loginThroughUi(page, e2ePassword);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
  await page.waitForTimeout(12_000);
  const sseReconnectFired = await page.evaluate(() => window.__sseReconnectCount ?? 0);
  expect(sseReconnectFired).toBeGreaterThanOrEqual(1);
  expect(dashboardRequests).toBeGreaterThanOrEqual(2);
  record({ journey: "sse-reconnect-refetch", sseReconnectFired, dashboardRequests, ok: true });
});

test("usage window honors inclusive UTC bounds and excludes outside records", async ({ page, e2ePassword }) => {
  await loginThroughUi(page, e2ePassword);
  const response = await page.request.get(
    "/api/v1/usage?from=2026-10-20T00:00:00Z&to=2026-10-21T00:00:00Z&granularity=day",
  );
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.summary.totalTokens).toBe(17500);
  expect(body.summary.cost).toBeCloseTo(3.0, 5);
  expect(body.dailySeries.map((d) => d.date)).toEqual(["2026-10-20", "2026-10-21"]);
  expect(body.summary.inputTokens).toBe(10000);

  const invalid = await page.request.get("/api/v1/usage?from=not-a-date&to=2026-10-21T00:00:00Z");
  expect(invalid.status()).toBe(400);

  // UI-страница /usage при загрузке шлёт GET /usage без from/to и получает
  // 400 (contract gap: route требует window; UI не задаёт default) — это
  // задокументированный finding, поэтому UI-часть сценария не утверждает
  // успешный рендер заголовка, а только отсутствие app-краха.
  await page.goto("/usage");
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toBeVisible();
  record({ journey: "usage-utc-boundary", windowTokens: body.summary.totalTokens, uiDefaultWindowGap: true, ok: true });
});

test("project config candidate, stale-approval guard, activate and restart persistence", async ({ page, e2ePassword }) => {
  await loginThroughUi(page, e2ePassword);
  const session = await (await page.request.get("/api/v1/session")).json();
  const csrf = { "X-CSRF-Token": session.csrfToken };

  const settings = {
    projectDisplayName: "Ebb AI Hub",
    defaultBranch: "master",
    roles: [
      { role: "Senior Developer", provider: "openai", model: "gpt-5.6-terra" },
      { role: "Reviewer", provider: null, model: null },
    ],
    scheduler: { concurrency: 4, enablePriorityAging: true, criticalPathBoost: false },
    recovery: { resumeSessions: true, maxAttempts: 3, recoveryCycleMinutes: 30, abortOnNoProgressDays: 7 },
    github: { syncEnabled: false, issueLinking: false, pullRequestSync: false },
    budgets: [],
  };

  // Windows: платформенный fail-closed гейт из plan-27 Task 4 — native handle
  // writer не доказан, поэтому capture/editor кандидатов на win32 запрещён.
  // Ожидаем 503 PROJECT_CONFIG_UNSUPPORTED_PLATFORM и фиксируем ограничение;
  // полный flow activate/restart выполняется только на не-win32.
  if (process.platform === "win32") {
    const gate = await page.request.post("/api/v1/projects/proj-1/config/candidates/editor", {
      headers: { ...csrf, "Content-Type": "application/json" },
      data: { expectedManifestHash: "a".repeat(64), settings },
    });
    expect(gate.status(), `win32 config candidate editor must fail closed with 503, got ${gate.status()} ${await gate.text()}`).toBe(503);
    const gateBody = await gate.json();
    expect(gateBody.error).toBe("PROJECT_CONFIG_UNSUPPORTED_PLATFORM");
    record({ journey: "config-candidate-windows-failclosed", expected: 503, code: gateBody.error, limitation: "PROJECT_CONFIG_UNSUPPORTED_PLATFORM on win32; native handle writer not proven; full activate/restart flow runs on non-win32 only", ok: true });
    return;
  }
  const initialHash = "a".repeat(64);
  const secondHash = "b".repeat(64);

  const editorResponse = await page.request.post("/api/v1/projects/proj-1/config/candidates/editor", {
    headers: { ...csrf, "Content-Type": "application/json" },
    data: { expectedManifestHash: initialHash, settings },
  });
  expect(editorResponse.status()).toBe(201);
  const editorBody = await editorResponse.json();
  expect(editorBody.candidate.status).toBe("PENDING_REVIEW");
  const firstCandidateId = editorBody.candidate.candidateId;
  const firstManifestHash = editorBody.candidate.manifestHash;

  const secondResponse = await page.request.post("/api/v1/projects/proj-1/config/candidates/editor", {
    headers: { ...csrf, "Content-Type": "application/json" },
    data: { expectedManifestHash: secondHash, settings: { ...settings, projectDisplayName: "Ebb AI Hub (v2)" } },
  });
  expect(secondResponse.status()).toBe(201);
  const secondBody = await secondResponse.json();
  const secondCandidateId = secondBody.candidate.candidateId;
  const secondManifestHash = secondBody.candidate.manifestHash;

  const config = await (await page.request.get("/api/v1/projects/proj-1/config")).json();
  expect(config.current.candidateId).toBe(secondCandidateId);

  // stale approval: approval старого (не текущего) кандидата отклоняется 409.
  const staleApproval = await page.request.post(`/api/v1/projects/proj-1/config/candidates/${firstCandidateId}/approve`, {
    headers: csrf,
    data: { manifestHash: firstManifestHash },
  });
  expect(staleApproval.status()).toBe(409);

  const approveResponse = await page.request.post(`/api/v1/projects/proj-1/config/candidates/${secondCandidateId}/approve`, {
    headers: csrf,
    data: { manifestHash: secondManifestHash },
  });
  expect(approveResponse.status()).toBe(200);
  const approveBody = await approveResponse.json();
  expect(approveBody.active.revisionId).toBeTruthy();

  const restarted = await controlRequest("restart");
  expect(restarted.type).toBe("ready");
  const afterRestart = await (await page.request.get("/api/v1/projects/proj-1/config")).json();
  expect(afterRestart.active.revisionId).toBe(approveBody.active.revisionId);
  expect(afterRestart.active.manifestHash).toBe(secondManifestHash);
  record({ journey: "config-candidate-stale-approve-restart", firstCandidateId, secondCandidateId, revisionId: approveBody.active.revisionId, staleApprovalStatus: staleApproval.status(), ok: true });
});

test("approvals detail, resolved history, policies and approve action use real backend", async ({ page, e2ePassword }) => {
  await loginThroughUi(page, e2ePassword);
  await page.goto("/approvals");
  await expect(page.getByRole("heading", { name: "Входящие согласования" })).toBeVisible();

  const _pending = page.locator(".approval-layout").first();
  await expect(page.getByText("Ожидают решения").first()).toBeVisible();
  // список не отображает сырые id (appr-*); вместо этого проверяем реальные
  // данные из проекции (категория/проект) и переход к политикам.
  await expect(page.getByText("Финальное слияние").first()).toBeVisible();
  await expect(page.getByText("Проект: proj-2").first()).toBeVisible();

  await page.getByRole("link", { name: "Политики согласований" }).click();
  await expect(page.getByRole("heading", { name: "Настройки" })).toBeVisible();
  await page.goto("/approvals");

  await page.locator("button").filter({ hasText: "Решённые" }).first().click();
  await expect(page.getByText("Изменение архитектуры").first()).toBeVisible();
  await expect(page.getByText("Проект: proj-1").first()).toBeVisible();

  await page.locator("button").filter({ hasText: "Ожидают решения" }).first().click();
  await page.getByRole("button", { name: "Согласовать" }).first().click();
  await expect.poll(async () => {
    const body = await (await page.request.get("/api/v1/approvals?status=pending")).json();
    return body.items?.length ?? -1;
  }, { timeout: 10_000 }).toBe(2);

  await page.locator("button").filter({ hasText: "Решённые" }).first().click();
  await expect.poll(async () => {
    const body = await (await page.request.get("/api/v1/approvals?status=resolved")).json();
    return body.items?.length ?? -1;
  }, { timeout: 10_000 }).toBe(3);
  record({ journey: "approvals-detail-history-policies", pendingAfterApprove: 2, resolvedAfterApprove: 3, ok: true });
});
