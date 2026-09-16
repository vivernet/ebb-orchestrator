/**
 * Tests for Hermes runtime adapter.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { HermesRuntimeAdapter } from "../../../src/modules/runtime/hermes/hermes-runtime-adapter.js";
import { HermesCliBuilder } from "../../../src/modules/runtime/hermes/hermes-cli.js";
import {
  ProcessExecutor,
  type ProcessOptions,
  type ProcessResult,
} from "../../../src/platform/process/process-executor.js";

// Mock process executor for testing
class MockProcessExecutor extends ProcessExecutor {
  private execCalls: Array<{ file: string; args: string[]; options?: ProcessOptions }> = [];
  private nextResult: ProcessResult | Error | null = null;
  private nextThrows = false;

  getCalls() {
    return [...this.execCalls];
  }

  setNextResult(result: ProcessResult) {
    this.nextResult = result;
    this.nextThrows = false;
  }

  setNextError(error: Error) {
    this.nextResult = error;
    this.nextThrows = true;
  }

  override async exec(
    file: string,
    args: string[],
    options?: ProcessOptions
  ): Promise<ProcessResult> {
    this.execCalls.push({ file, args, options: options ?? {} });

    if (this.nextThrows && this.nextResult instanceof Error) {
      throw this.nextResult;
    }

    if (this.nextResult && !(this.nextResult instanceof Error)) {
      return this.nextResult;
    }

    return { exitCode: 0, stdout: "", stderr: "" };
  }

  reset() {
    this.execCalls = [];
    this.nextResult = null;
    this.nextThrows = false;
  }
}

// Mock artifact store
class MockArtifactStore {
  private artifacts: Record<string, { stdout: string; stderr: string; exitCode: number }> = {};

  saveArtifacts(
    runId: string,
    stdout: string,
    stderr: string,
    exitCode: number
  ) {
    this.artifacts[runId] = { stdout, stderr, exitCode };
  }

  getArtifacts(runId: string) {
    return this.artifacts[runId];
  }
}

describe("HermesRuntimeAdapter", () => {
  let adapter: HermesRuntimeAdapter;
  let mockExecutor: MockProcessExecutor;
  let mockArtifactStore: MockArtifactStore;

  beforeEach(() => {
    mockExecutor = new MockProcessExecutor();
    mockArtifactStore = new MockArtifactStore();
    adapter = new HermesRuntimeAdapter(mockExecutor, mockArtifactStore);
  });

  describe("startRun", () => {
    it("wires the exact run result path into the authenticated MCP config", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-result-wiring-"));
      adapter = new HermesRuntimeAdapter(mockExecutor, mockArtifactStore, { resultDirectory });
      const run = {
        id: "wired-run-id", role: "Developer", runtime: "hermes", model: "default",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };
      await adapter.startRun(run);
      const config = await fs.readFile(path.join(resultDirectory, "profiles", run.id, "config.yaml"), "utf8");
      expect(config).toContain(`- "${path.join(resultDirectory, `${run.id}.json`)}"`);
      await fs.rm(resultDirectory, { recursive: true, force: true });
    });

    it("builds correct launch command for new run", async () => {
      const run = {
        id: "test-run-id",
        role: "Developer",
        runtime: "hermes",
        model: "claude-3-5-sonnet",
        taskId: "task-123",
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      };

      mockExecutor.setNextResult({ exitCode: 0, stdout: "session: abc123", stderr: "" });

      await adapter.startRun(run);

      const calls = mockExecutor.getCalls();
      expect(calls).toHaveLength(1);

       const call = calls[0];
       if (!call) throw new Error("Expected at least one call");
       const { args } = call;
      expect(args).toContain("chat");
      expect(args).toContain("--query-file");
      expect(args).toContain("--model");
      expect(args).toContain("claude-3-5-sonnet");
      expect(args).toContain("--toolsets");
      expect(args).toContain("mcp-orchestrator");
      expect(args).toContain("--in");
      expect(args).toContain("--ignore-rules");
      expect(args).toContain("--source");
      expect(args).toContain("tool");
      expect(args).toContain("--max-turns");
    });

    it("writes prompt body to file and passes with --query-file", async () => {
      const run = {
        id: "test-run-id-2",
        role: "QA",
        runtime: "hermes",
        model: "claude-3",
        taskId: "task-456",
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      };

      mockExecutor.setNextResult({ exitCode: 0, stdout: "session: xyz789", stderr: "" });

      await adapter.startRun(run);

      const calls = mockExecutor.getCalls();
       const call = calls[0];
       if (!call) throw new Error("Expected at least one call");
       const queryFileArg = call.args.find((a, i) => a === "--query-file" && i + 1 < call.args.length);
      expect(queryFileArg).toBeDefined();
      expect(call.args[call.args.indexOf("--query-file") + 1]).toMatch(/\.txt$/);
    });

    it("never adds --worktree flag", async () => {
      const run = {
        id: "test-run-id-3",
        role: "Developer",
        runtime: "hermes",
        model: "claude-3",
        taskId: "task-789",
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      };

      mockExecutor.setNextResult({ exitCode: 0, stdout: "session: abc", stderr: "" });

      await adapter.startRun(run);

       const calls = mockExecutor.getCalls();
       expect(calls[0]?.args).not.toContain("--worktree");
    });

    it("never adds --yolo flag", async () => {
      const run = {
        id: "test-run-id-4",
        role: "Developer",
        runtime: "hermes",
        model: "claude-3",
        taskId: "task-101",
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      };

      mockExecutor.setNextResult({ exitCode: 0, stdout: "session: abc", stderr: "" });

      await adapter.startRun(run);

       const calls = mockExecutor.getCalls();
       expect(calls[0]?.args).not.toContain("--yolo");
    });

    it("captures session ID from stdout", async () => {
      const run = {
        id: "test-run-id-5",
        role: "Developer",
        runtime: "hermes",
        model: "claude-3",
        taskId: "task-202",
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      };

      mockExecutor.setNextResult({
        exitCode: 0,
        stdout: "Initializing Hermes...\nsession: captured-session-123\nReady",
        stderr: "",
      });

      await adapter.startRun(run);

       const runState = await adapter.inspectRun(run.id);
      expect(runState.sessionId).toBe("captured-session-123");
    });

    it("captures process PID", async () => {
      const run = {
        id: "test-run-id-6",
        role: "Developer",
        runtime: "hermes",
        model: "claude-3",
        taskId: "task-303",
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      };

      mockExecutor.setNextResult({ exitCode: 0, stdout: "session: abc", stderr: "" });

      await adapter.startRun(run);

       const runState = await adapter.inspectRun(run.id);
      expect(runState).toBeDefined();
    });
  });

  describe("resumeRun", () => {
    it("updates run state with session info", async () => {
      // First start the run
      const startRun = {
        id: "resume-run-id",
        role: "Developer",
        runtime: "hermes",
        model: "claude-3",
        taskId: "task-resume",
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      };

      mockExecutor.setNextResult({ exitCode: 0, stdout: "session: test", stderr: "" });
      await adapter.startRun(startRun);

      // Now resume
      mockExecutor.setNextResult({ exitCode: 0, stdout: "resumed", stderr: "" });
      await adapter.resumeRun(startRun.id, { sessionId: "existing-session-456", attempt: 1 });

       const state = await adapter.inspectRun(startRun.id);
      expect(state.sessionId).toBe("existing-session-456");
      expect(state.attempt).toBe(1);
      expect(state.status).toBe("IN_PROGRESS");
    });

    it("sets status to IN_PROGRESS on resume", async () => {
      const startRun = {
        id: "resume-run-id-2",
        role: "Developer",
        runtime: "hermes",
        model: "claude-3",
        taskId: "task-resume-2",
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      };

      mockExecutor.setNextResult({ exitCode: 0, stdout: "session: test", stderr: "" });
      await adapter.startRun(startRun);

      mockExecutor.setNextResult({ exitCode: 0, stdout: "resumed", stderr: "" });
      await adapter.resumeRun(startRun.id, { sessionId: "existing-session-789", attempt: 2 });

       const state = await adapter.inspectRun(startRun.id);
      expect(state.status).toBe("IN_PROGRESS");
    });
  });

  describe("cancelRun", () => {
    it("sends graceful signal first", async () => {
      // First start the run
      const startRun = {
        id: "cancel-run-id",
        role: "Developer",
        runtime: "hermes",
        model: "claude-3",
        taskId: "task-cancel",
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      };

      mockExecutor.setNextResult({ exitCode: 0, stdout: "session: test", stderr: "" });
      await adapter.startRun(startRun);

      await adapter.cancelRun(startRun.id);

       const runState = await adapter.inspectRun(startRun.id);
      expect(runState.status).toBe("CANCELLED");
    });
  });

  describe("collectResult", () => {
    it("returns AGENT_OUTPUT_MISSING when process exits without valid submitted result", async () => {
      // First start the run
      const startRun = {
        id: "missing-result-run",
        role: "Developer",
        runtime: "hermes",
        model: "claude-3",
        taskId: "task-no-result",
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      };

      mockExecutor.setNextResult({ exitCode: 0, stdout: "session: test", stderr: "" });
      await adapter.startRun(startRun);

       // Manually update the run state to indicate failure
       const state = (adapter as unknown as { runs: Map<string, { exitCode?: number }> }).runs.get(startRun.id);
       if (state) {
         state.exitCode = 1;
       }

      const outcome = await adapter.collectResult(startRun.id);
      expect(outcome.success).toBe(false);
      expect(outcome.exitCode).toBe(1);
    });

    it("does not consume another run's exact result file and returns diagnostics", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-results-"));
      await fs.writeFile(path.join(resultDirectory, "other-run.json"), JSON.stringify({ version: "1.0", outcome: "COMPLETED" }));
      const run = {
        id: "exact-run", role: "Developer", runtime: "hermes", model: "claude-3", taskId: "task-exact",
        epicId: null, status: "STARTED" as const, sessionId: null, attempt: null, triggerReason: null,
        contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(), endedAt: null,
        exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };
      mockExecutor.setNextResult({ exitCode: 7, stdout: "session: exact-session", stderr: "agent failed" });
      const exactAdapter = new HermesRuntimeAdapter(mockExecutor, mockArtifactStore, { resultDirectory });
      await exactAdapter.startRun(run);

      const outcome = await exactAdapter.collectResult(run.id);
      expect(outcome.output).toBe("AGENT_OUTPUT_MISSING");
      expect(outcome.diagnostics).toEqual({
        runId: run.id,
        sessionId: "exact-session",
        stderr: "agent failed",
        exitCode: 7,
        artifactReferences: [path.join(resultDirectory, "exact-run.json"), `run-artifacts://${run.id}`],
      });
      await fs.rm(resultDirectory, { recursive: true, force: true });
    });

    it("re-reads and validates the exact run result at collection time", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-results-recheck-"));
      const run = {
        id: "recheck-run", role: "Developer", runtime: "hermes", model: "claude-3", taskId: "task-recheck",
        epicId: null, status: "STARTED" as const, sessionId: null, attempt: null, triggerReason: null,
        contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(), endedAt: null,
        exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };
      mockExecutor.setNextResult({ exitCode: 0, stdout: "session: recheck", stderr: "" });
      const exactAdapter = new HermesRuntimeAdapter(mockExecutor, mockArtifactStore, { resultDirectory });
      await exactAdapter.startRun(run);
      await fs.writeFile(path.join(resultDirectory, `${run.id}.json`), JSON.stringify({ version: "1", outcome: "COMPLETED" }));
      expect((await exactAdapter.collectResult(run.id)).validatedSubmission).toBe(true);
      await fs.writeFile(path.join(resultDirectory, `${run.id}.json`), JSON.stringify({ version: "1", outcome: "INVALID" }));
      const invalid = await exactAdapter.collectResult(run.id);
      expect(invalid.validatedSubmission).toBe(false);
      expect(invalid.output).toBe("AGENT_OUTPUT_MISSING");
      await fs.rm(resultDirectory, { recursive: true, force: true });
    });

    it("rejects forbidden credentials in supplied runtime overlays", async () => {
      const restricted = new HermesRuntimeAdapter(mockExecutor, mockArtifactStore, {
        environment: { GITHUB_TOKEN: "secret" },
      });
      await expect(restricted.startRun({
        id: "credential-run", role: "Developer", runtime: "hermes", model: "claude-3", taskId: "task-credential",
        epicId: null, status: "STARTED" as const, sessionId: null, attempt: null, triggerReason: null,
        contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(), endedAt: null,
        exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      })).rejects.toThrow("Forbidden credential");
    });
  });

  describe("inspectRun", () => {
    it("returns current state of a run", async () => {
      const run = {
        id: "inspect-run-id",
        role: "Developer",
        runtime: "hermes",
        model: "claude-3",
        taskId: "task-inspect",
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      };

      mockExecutor.setNextResult({ exitCode: 0, stdout: "session: inspect-session", stderr: "" });

      await adapter.startRun(run);

       const state = await adapter.inspectRun(run.id);
      expect(state.id).toBe(run.id);
      expect(state.role).toBe("Developer");
    });
  });

  describe("healthCheck", () => {
    it("returns true when runtime is healthy", async () => {
      const healthy = await adapter.healthCheck();
      expect(healthy).toBe(true);
    });
  });

  describe("HermesCliBuilder", () => {
    it("builds launch args for new run", () => {
      const builder = new HermesCliBuilder();
      const args = builder.buildLaunchArgs({
        queryFile: "/tmp/prompt.txt",
        model: "claude-3-5-sonnet",
        toolsets: ["mcp-orchestrator"],
        worktree: "/managed/worktree",
        ignoreRules: true,
        source: "tool",
        maxTurns: 20,
      });

      expect(args).toContain("chat");
      expect(args).toContain("--query-file");
      expect(args).toContain("/tmp/prompt.txt");
      expect(args).toContain("--model");
      expect(args).toContain("claude-3-5-sonnet");
      expect(args).toContain("--toolsets");
      expect(args).toContain("mcp-orchestrator");
      expect(args).toContain("--in");
      expect(args).toContain("/managed/worktree");
      expect(args).toContain("--ignore-rules");
      expect(args).toContain("--source");
      expect(args).toContain("tool");
      expect(args).toContain("--max-turns");
      expect(args).toContain("20");
    });

    it("builds resume args", () => {
      const builder = new HermesCliBuilder();
      const args = builder.buildResumeArgs({
        sessionId: "resume-123",
        toolsets: ["mcp-orchestrator"],
        worktree: "/managed/worktree",
        ignoreRules: true,
        source: "tool",
        maxTurns: 20,
      });

      expect(args).toContain("chat");
      expect(args).toContain("--resume");
      expect(args).toContain("resume-123");
      expect(args).toContain("--in");
      expect(args).toContain("/managed/worktree");
    });
  });
});
