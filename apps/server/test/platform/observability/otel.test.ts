/**
 * Тесты C5: OTel-наблюдаемость (gen_ai semconv + middleware).
 *
 * Доказывают:
 * - без `OTEL_EXPORTER_OTLP_ENDPOINT` OTel работает в no-op режиме
 *   и не меняет бизнес-результат (Run остаётся COMPLETED);
 * - экспорт в OTLP HTTP происходит только при заданном endpoint;
 * - exported attributes содержат только allowlisted ключи
 *   (`gen_ai.usage.input_tokens`/`gen_ai.usage.output_tokens`
 *   и constant service атрибуты) и не содержат model/provider/URL/prompt;
 * - ошибка экспортёра не блокирует startup/run и не меняет Run outcome;
 * - shutdown имеет ограниченный flush/timeout.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  beginHttpRequestTracing,
  isOtelEnabled,
  recordGenAiUsageTelemetry,
  registerOtel,
  withShutdownTimeout,
} from "../../../src/platform/observability/otel.js";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { FakeAgentRuntime } from "../../fakes/fake-agent-runtime.js";
import { RunService } from "../../../src/modules/runtime/run-service.js";
import { digestRunPromptBytesV1 } from "../../../src/modules/context/context-provenance.js";
import { transitionRunProcessOwnerTx } from "../../../src/modules/runtime/run-process-owner.js";
import type { Database } from "../../../src/platform/database/database.js";
import type { PreparedRunContext } from "../../../src/modules/context/context-types.js";
import type { RunOutcome, StartRunOptions } from "../../../src/modules/runtime/run-types.js";
import { createApp } from "../../../src/app/create-app.js";
import { SchedulerService } from "../../../src/modules/scheduler/scheduler-service.js";
import { createTestAuthService } from "../../helpers/auth.js";

const OTEL_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_METRIC_EXPORT_INTERVAL",
] as const;

function saveOtelEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of OTEL_ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreOtelEnv(saved: Record<string, string | undefined>): void {
  for (const key of OTEL_ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

interface CollectedRequest {
  url: string;
  body: string;
  status: number;
}

interface CollectorHandle {
  server: Server;
  requests: CollectedRequest[];
  baseUrl: string;
  stop(): Promise<void>;
}

/** Поднимает локальный mock-коллектор OTLP HTTP. */
async function startCollector(): Promise<CollectorHandle> {
  const requests: CollectedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
        status: 200,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("collector listen failed");
  const stop = async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { server, requests, baseUrl: `http://127.0.0.1:${address.port}`, stop };
}

/** Поднимает collector, который отклоняет каждый export (500). */
async function startFailingCollector(): Promise<CollectorHandle> {
  const requests: CollectedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8"), status: 500 });
      res.writeHead(500, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("collector listen failed");
  const stop = async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { server, requests, baseUrl: `http://127.0.0.1:${address.port}`, stop };
}

interface ExportedAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string; doubleValue?: number };
}

interface ExportedSpan {
  name: string;
  attributes: ExportedAttribute[];
}

/** Разбирает JSON-тело OTLP ExportTraceServiceRequest. */
function parseTraceExports(requests: CollectedRequest[]): ExportedSpan[] {
  const spans: ExportedSpan[] = [];
  for (const request of requests) {
    if (!request.url.includes("/v1/traces")) continue;
    const root = JSON.parse(request.body) as {
      resourceSpans?: Array<{
        scopeSpans?: Array<{ spans?: Array<{ name?: string; attributes?: ExportedAttribute[] }> }>;
      }>;
    };
    for (const resourceSpan of root.resourceSpans ?? []) {
      for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
        for (const span of scopeSpan.spans ?? []) {
          spans.push({ name: span.name ?? "", attributes: span.attributes ?? [] });
        }
      }
    }
  }
  return spans;
}

function traceAttributeKeys(spans: ExportedSpan[]): string[] {
  return spans.flatMap((span) => span.attributes.map((attribute) => attribute.key));
}

/** Собирает ключи resource-атрибутов из всех OTLP trace-экспортов. */
function parseResourceAttributeKeys(requests: CollectedRequest[]): string[] {
  const keys = new Set<string>();
  for (const request of requests) {
    if (!request.url.includes("/v1/traces")) continue;
    const root = JSON.parse(request.body) as {
      resourceSpans?: Array<{ resource?: { attributes?: ExportedAttribute[] } }>;
    };
    for (const resourceSpan of root.resourceSpans ?? []) {
      for (const attribute of resourceSpan.resource?.attributes ?? []) keys.add(attribute.key);
    }
  }
  return [...keys];
}

interface ExportedHistogramDataPoint {
  sum?: string | number;
  count?: string | number;
}

interface ExportedMetric {
  name?: string;
  histogram?: { dataPoints?: ExportedHistogramDataPoint[] };
}

/** Разбирает JSON-тело OTLP ExportMetricsServiceRequest и возвращает все метрики. */
function parseMetricExports(requests: CollectedRequest[]): ExportedMetric[] {
  const metrics: ExportedMetric[] = [];
  for (const request of requests) {
    if (!request.url.includes("/v1/metrics")) continue;
    const root = JSON.parse(request.body) as {
      resourceMetrics?: Array<{
        scopeMetrics?: Array<{ metrics?: ExportedMetric[] }>;
      }>;
    };
    for (const resourceMetric of root.resourceMetrics ?? []) {
      for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
        for (const metric of scopeMetric.metrics ?? []) metrics.push(metric);
      }
    }
  }
  return metrics;
}

/** Ожидает до timeoutMs появления OTLP metrics-запроса у коллектора. */
async function waitForMetricsRequest(collector: CollectorHandle, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (collector.requests.some((request) => request.url.includes("/v1/metrics"))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe("C5 OTel: no-op без endpoint", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveOtelEnv();
    for (const key of OTEL_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    restoreOtelEnv(savedEnv);
  });

  it("isOtelEnabled=false и registerOtel возвращает no-op shutdown", async () => {
    expect(isOtelEnabled()).toBe(false);
    const shutdown = await registerOtel();
    expect(typeof shutdown).toBe("function");
    await expect(shutdown()).resolves.toBeUndefined();
  });

  it("isOtelEnabled=false при endpoint из одних пробелов (trim)", () => {
    expect(isOtelEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "   " })).toBe(false);
    expect(isOtelEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: " http://127.0.0.1:4318 " })).toBe(true);
  });

  it("запись gen_ai и middleware telemetry не бросает исключений без endpoint", () => {
    expect(() => {
      recordGenAiUsageTelemetry(10, 20);
      beginHttpRequestTracing().finish();
    }).not.toThrow();
  });

  it("без endpoint ни один export не отправляется в коллектор", async () => {
    const collector = await startCollector();
    try {
      const shutdown = await registerOtel();
      recordGenAiUsageTelemetry(1, 2);
      beginHttpRequestTracing().finish();
      await shutdown();
      expect(collector.requests).toEqual([]);
    } finally {
      await collector.stop();
    }
  });

  it("без endpoint бизнес-результат Run не меняется: Run остаётся COMPLETED", async () => {
    const harness = await setupRunHarness();
    try {
      const shutdown = await registerOtel();
      const run = await harness.startRun({ role: "developer", model: "default", taskId: harness.taskId, epicId: null,
        triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
        capability: { workspace: harness.tmpDir, allowedTools: ["submit_result"] } });
      await harness.completePreparedRunViaRuntime(run);
      await shutdown();

      expect(harness.db.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$runId", { runId: run.id })!.status)
        .toBe("COMPLETED");
      expect(harness.db.get<{ input_tokens: number | null; output_tokens: number | null }>(
        "SELECT input_tokens,output_tokens FROM agent_runs WHERE id=$runId", { runId: run.id }))
        .toEqual({ input_tokens: 11, output_tokens: 5 });
    } finally {
      await harness.close();
    }
  });

  it("createApp работает без endpoint и не отправляет экспорт", async () => {
    const collector = await startCollector();
    try {
      const db = createSqliteDatabase(":memory:");
      runMigrations(db, loadTestMigrations());
      const app = createApp({ db, scheduler: new SchedulerService(db),
        runService: { cancelRun: vi.fn(), prepareRun: vi.fn(), executePreparedRun: vi.fn(), validateTaskRequestModel: vi.fn() },
        authService: createTestAuthService() });
      try {
        const response = await app.inject({ method: "GET", url: "/api/v1/health" });
        expect(response.statusCode).toBe(200);
      } finally {
        await app.close();
        db.close();
      }
      expect(collector.requests).toEqual([]);
    } finally {
      await collector.stop();
    }
  });
});

describe("C5 OTel: экспорт только с endpoint", () => {
  let savedEnv: Record<string, string | undefined>;
  let collector: CollectorHandle | undefined;

  beforeEach(() => {
    savedEnv = saveOtelEnv();
  });

  afterEach(async () => {
    restoreOtelEnv(savedEnv);
    if (collector) {
      await collector.stop();
      collector = undefined;
    }
  });

  it("при endpoint OTLP HTTP export отправляется и содержит span-ы", async () => {
    collector = await startCollector();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.baseUrl;
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";

    const shutdown = await registerOtel();
    recordGenAiUsageTelemetry(111, 22);
    beginHttpRequestTracing().finish();
    await shutdown();

    expect(collector.requests.length).toBeGreaterThanOrEqual(1);
    const spans = parseTraceExports(collector.requests);
    const names = spans.map((span) => span.name);
    expect(names).toEqual(expect.arrayContaining(["gen_ai.client.operation", "http.server.request"]));
    // Гистограмма middleware записывается и флашится в OTLP metrics endpoint;
    // flush метрик может завершиться чуть позже trace-флаша — ожидаем с ретраями.
    expect(await waitForMetricsRequest(collector)).toBe(true);
  });

  it("exported span attributes содержат только allowlisted ключи и не содержат model/provider/URL/prompt", async () => {
    collector = await startCollector();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.baseUrl;
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";

    const shutdown = await registerOtel();
    recordGenAiUsageTelemetry(5, 7);
    beginHttpRequestTracing().finish();
    await shutdown();

    const spans = parseTraceExports(collector.requests);
    expect(spans.length).toBeGreaterThan(0);
    const allowedKeys = new Set([
      "service.name",
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.output_tokens",
    ]);
    for (const key of traceAttributeKeys(spans)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
    const rawBody = collector.requests.map((request) => request.body).join("\n").toLowerCase();
    for (const forbidden of ["provider", "model", "prompt", "http://", "headers"]) {
      expect(rawBody).not.toContain(forbidden);
    }
  });

  it("exported resource attributes содержат только service.name и telemetry.sdk.*, без process/host", async () => {
    collector = await startCollector();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.baseUrl;
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";

    const shutdown = await registerOtel();
    recordGenAiUsageTelemetry(1, 2);
    await shutdown();

    const resourceKeys = parseResourceAttributeKeys(collector.requests);
    expect(resourceKeys.length).toBeGreaterThan(0);
    const allowedKeyOrPrefix = ["service.name", "telemetry.sdk."];
    for (const key of resourceKeys) {
      expect(allowedKeyOrPrefix.some((allowed) => key === allowed || key.startsWith(allowed))).toBe(true);
      expect(key.startsWith("process.")).toBe(false);
      expect(key.startsWith("host.")).toBe(false);
    }
  });

  it("гистограмма http.server.request.duration экспортируется с неотрицательным значением", async () => {
    collector = await startCollector();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.baseUrl;
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";

    const shutdown = await registerOtel();
    beginHttpRequestTracing().finish();
    await shutdown();

    expect(await waitForMetricsRequest(collector)).toBe(true);
    const histograms = parseMetricExports(collector.requests).filter((metric) => metric.name === "http.server.request.duration");
    expect(histograms.length).toBeGreaterThan(0);
    const sums = histograms.flatMap((histogram) => (histogram.histogram?.dataPoints ?? []).map((point) => Number(point.sum)));
    expect(sums.length).toBeGreaterThan(0);
    for (const sum of sums) {
      expect(Number.isFinite(sum)).toBe(true);
      expect(sum).toBeGreaterThanOrEqual(0);
    }
  });

  it("полный Run с usage экспортирует точные gen_ai.usage токены", async () => {
    collector = await startCollector();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.baseUrl;
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";

    const shudown = await registerOtel();
    const harness = await setupRunHarness();
    try {
      const run = await harness.startRun({ role: "developer", model: "default", taskId: harness.taskId, epicId: null,
        triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
        capability: { workspace: harness.tmpDir, allowedTools: ["submit_result"] } });
      await harness.completePreparedRunViaRuntime(run);
      await shudown();

      const spans = parseTraceExports(collector.requests);
      const usageSpan = spans.find((span) => span.name === "gen_ai.client.operation");
      expect(usageSpan).toBeDefined();
      const attributes = Object.fromEntries(usageSpan!.attributes.map((a) => [a.key, a.value.intValue ?? a.value.doubleValue ?? a.value.stringValue]));
      expect(attributes["gen_ai.usage.input_tokens"]).toBe(11);
      expect(attributes["gen_ai.usage.output_tokens"]).toBe(5);
    } finally {
      await harness.close();
    }
  });

  it("exporter failure не блокирует startup/run и не меняет Run outcome", async () => {
    collector = await startFailingCollector();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.baseUrl;
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";

    const started = Date.now();
    const shutdown = await registerOtel();
    const harness = await setupRunHarness();
    try {
      const run = await harness.startRun({ role: "developer", model: "default", taskId: harness.taskId, epicId: null,
        triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
        capability: { workspace: harness.tmpDir, allowedTools: ["submit_result"] } });
      await harness.completePreparedRunViaRuntime(run);
      expect(harness.db.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$runId", { runId: run.id })!.status)
        .toBe("COMPLETED");
      await shutdown();
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      await harness.close();
    }
  });
});

describe("C5 OTel: shutdown ограничен", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveOtelEnv();
    for (const key of OTEL_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    restoreOtelEnv(savedEnv);
  });

  it("shutdown без endpoint завершается немедленно", async () => {
    const started = Date.now();
    const shutdown = await registerOtel();
    await shutdown();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("shutdown с висящим sdk.shutdown резолвится за ~OTEL_SHUTDOWN_TIMEOUT_MS (3000мс)", async () => {
    const started = Date.now();
    await withShutdownTimeout(() => new Promise<void>(() => {}));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(2800);
    expect(elapsed).toBeLessThan(5000);
  });
});

// ── Harness для интеграционных тестов RunService ────────────────────

async function setupRunHarness(): Promise<{
  db: Database;
  tmpDir: string;
  taskId: string;
  runService: RunService;
  fakeRuntime: FakeAgentRuntime;
  startRun(options: StartRunOptions): Promise<Awaited<ReturnType<RunService["startRun"]>>>;
  completePreparedRunViaRuntime(run: { id: string; role: string }): Promise<void>;
  close(): Promise<void>;
}> {
  const tmpDir = await mkdtemp(join(tmpdir(), "orch-otel-test-"));
  const dbPath = join(tmpDir, `test-${randomUUID()}.db`);
  const db = createSqliteDatabase(dbPath);
  runMigrations(db, loadTestMigrations());

  const projectId = randomUUID();
  const taskId = randomUUID();
  const now = new Date().toISOString();
  db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'otel','Otel','ACTIVE',$now,$now)", { id: projectId, now });
  db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,required,created_at,updated_at) VALUES($id,$projectId,'OTEL-TASK','Otel task','READY','{}',1,$now,$now)", { id: taskId, projectId, now });

  const fakeRuntime = new FakeAgentRuntime();
  const contextAssembler = { prepare: (_tx: unknown, input: { prompt: string; role: string; subject: PreparedRunContext["subject"] }) => preparedContext(input.prompt, input.role, input.subject) };
  const runService = new RunService(db, fakeRuntime, contextAssembler);

  const startRun = async (options: StartRunOptions) => runService.startRun(withTestContext(options));

  const markFakeRunNeverLaunched = (runId: string) => {
    db.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId, expectedState: "PREPARED", nextState: "STOPPED", evidence: "NEVER_LAUNCHED",
    }));
  };

  const completePreparedRunViaRuntime = async (run: { id: string; role: string }) => {
    const output = JSON.stringify({ version: "1.0.0", outcome: "COMPLETED", commitSha: "test-commit-sha" });
    fakeRuntime.startRun = async (started) => { markFakeRunNeverLaunched(started.id); };
    fakeRuntime.collectResult = async (collectRunId: string): Promise<RunOutcome> => {
      const accepted = await runService.completionStore().accept(runService.getCapabilityReference(collectRunId), {
        runId: collectRunId, role: run.role, output: JSON.parse(output),
      });
      expect(accepted).toBe(true);
      return {
        success: true, exitCode: 0, output, validatedSubmission: true,
        diagnostics: { runId: collectRunId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] },
      };
    };
    vi.spyOn(fakeRuntime, "collectUsage").mockResolvedValue({ inputTokens: 11, cachedInputTokens: 2, outputTokens: 5, cost: 0.75 });
    await runService.executePreparedRun(run.id);
  };

  const close = async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  };

  return { db, tmpDir, taskId, runService, fakeRuntime, startRun, completePreparedRunViaRuntime, close };
}

function withTestContext(options: StartRunOptions): StartRunOptions {
  const subject = options.taskId !== null ? { type: "TASK" as const, id: options.taskId }
    : options.epicId !== null ? { type: "EPIC" as const, id: options.epicId }
      : { type: "REQUEST" as const, id: options.requestId ?? "request-test" };
  const effectiveTools = subject.type === "REQUEST"
    ? (options.capability?.allowedTools ?? [])
    : (options.capability?.allowedTools ?? ["submit_result"]);
  return {
    ...options,
    contextInput: options.contextInput ?? {
      prompt: options.prompt ?? "otel caller prompt",
      subject,
      role: options.role.toLowerCase() as PreparedRunContext["role"],
      roleInputs: {},
      versions: { roleVersion: null, runtime: "default", runtimeVersion: null, model: "test", modelVersion: null, outputSchemaVersion: "1", contextVersion: "1" },
      execution: {
        workspaceIdentity: { repository: "test-repository", workspace: "test-worktree", worktree: "test-worktree" },
        targetHead: null, targetBranch: null, effectiveCapabilityIds: effectiveTools,
        policyIdentity: { providerId: null, providerPolicyId: null, runtimeId: "default", runtimePolicyId: null },
      },
    },
  } as StartRunOptions;
}

function preparedContext(finalPrompt: string, role = "developer", subject: PreparedRunContext["subject"] = { type: "TASK", id: "task" }): PreparedRunContext {
  return {
    finalPrompt,
    subject,
    role: role as PreparedRunContext["role"],
    contractDigest: null,
    items: [],
    contextBuilderVersion: "1.0.0",
    promptHash: digestRunPromptBytesV1(new TextEncoder().encode(finalPrompt)),
    contextHash: "b".repeat(64),
    initialTokenSize: null,
    workspaceFingerprint: "c".repeat(64),
  };
}
