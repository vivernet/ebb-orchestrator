/// <reference types="node" />
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as api from '../src/api/client.js';
import { apiClient } from '../src/api/client.js';
import { readFileSync } from 'node:fs';

const clientSrc = readFileSync('src/api/client.ts', 'utf8');

const T = '2026-10-25T00:00:00.000Z';
const H = 'a'.repeat(64);

const dispatchStateFixture = { paused: false, updatedAt: T };
const cancelAllFixture = { results: [{ runId: 'run-1', outcome: 'CANCELLED' }] };
const controlFixture = { command: 'CHECKPOINT', status: 'COMPLETED', control: { state: 'ACTIVE', version: 1, updatedAt: T, checkpointId: null }, failureCode: null };
const terminalAvailableFixture = { availability: 'available', entries: [{ seq: 0, text: 'ok', at: T }] };
const runEventsPageFixture = { items: [{ id: 'e1', type: 'run_started', createdAt: T, payload: {} }], nextCursor: null };
const runDetailFixture = {
  id: 'run-1', role: 'Developer', runtime: 'hermes', model: 'default',
  taskId: null, epicId: null, status: 'STARTED', sessionId: null, attempt: 1,
  triggerReason: null, startedAt: null, endedAt: null, exitCode: null,
  usage: {
    inputTokens: { availability: 'unavailable', reason: 'NOT_RECORDED' },
    cachedInputTokens: { availability: 'available', value: 0 },
    outputTokens: { availability: 'unavailable', reason: 'NOT_RECORDED' },
    effectiveCost: { availability: 'unavailable', reason: 'NOT_RECORDED' },
  },
  control: null,
};
const projectIndexFixture = { items: [{ id: 'project-1', name: 'repo', displayName: 'Проект', status: 'ACTIVE', updatedAt: null }], nextCursor: null };
const projectPauseFixture = { projectId: 'project-1', state: 'PAUSED', updatedAt: T };
const epicPauseFixture = { epicId: 'epic-1', state: 'PAUSED', updatedAt: T };
const epicReplanFixture = { epicId: 'epic-1', requestId: 'req-1', status: 'PLANNING', createdAt: T };
const taskControlFixture = { taskId: 'task-1', state: 'PAUSED', priorStage: null, updatedAt: T };
const taskPriorityFixture = { taskId: 'task-1', priority: 5, updatedAt: T };
const candidateFixture = {
  candidateId: 'cand-1', projectId: 'project-1', manifestHash: H, expectedManifestHash: H,
  diff: { added: [], removed: [], modified: [] }, status: 'PENDING_REVIEW', createdAt: T,
};
const reconcileFixture = {
  journalId: 'journal-1', projectId: 'project-1', phase: 'RECONCILED_RESTORED', configStatus: 'READY',
  currentCandidateId: 'cand-1', activeRevisionId: null, resolution: 'RESTORE_APPROVED',
  resolvedBy: 'operator', resolvedManifestHash: H, resolvedAt: T,
};
const approvalsInboxFixture = {
  filter: 'resolved',
  summary: { totalPending: 0, totalResolved: 1, oldestPendingCreatedAt: null },
  items: [{ id: 'a1', category: 'scope', status: 'RESOLVED', priority: 'MEDIUM', projectId: 'project-1', title: 't', createdAt: T, resolvedAt: T }],
};
const approvalDetailFixture = {
  id: 'a1', category: 'scope', status: 'PENDING', priority: 'MEDIUM',
  project: { id: 'project-1', displayName: 'П' },
  proposal: { title: 't', summary: 's' }, rationale: 'r',
  planDiff: { before: { title: 'b', scope: 'b' }, after: { title: 'a', scope: 'a' } },
  impacts: { scope: 's', role: 'r', architecture: 'a', delayDays: null, budgetCost: null },
  evidence: [], decision: null,
};
const approvalPolicyFixture = { defaultAction: 'PENDING', requireExactHashForActivation: true, allowedOutcomes: ['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'] };
const executionQueueFixture = {
  running: [], waiting: [], blocked: [],
  capacity: { configured: 4, used: 0 }, locks: [], recentEvents: [],
  dispatchState: { paused: false, updatedAt: null },
};
const usageWindowFixture = {
  window: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z', granularity: 'day' },
  summary: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
  dailySeries: [],
  breakdowns: { byRole: [], byReason: [], byModel: [] },
  modelComparison: [],
  budgets: { configurations: [], contexts: [], activeReservations: [] },
  efficiency: {
    cacheShare: { availability: 'unavailable', reason: 'NO_APPROVED_POLICY' },
    averageInitialContextTokens: { availability: 'unavailable', reason: 'NO_APPROVED_POLICY' },
    averageOutputTokens: { availability: 'unavailable', reason: 'NO_APPROVED_POLICY' },
    aiRunsPerTask: { availability: 'unavailable', reason: 'NO_APPROVED_POLICY' },
    reworkCyclesPerTask: { availability: 'unavailable', reason: 'NO_APPROVED_POLICY' },
    deterministicCheckCount: { availability: 'unavailable', reason: 'NO_DURABLE_CHECK_EXECUTION_SOURCE' },
    deterministicCheckCost: { availability: 'unavailable', reason: 'NO_DURABLE_CHECK_EXECUTION_SOURCE' },
  },
  anomaly: { availability: 'unavailable', reason: 'NO_APPROVED_POLICY' },
  taskRecoveryShare: { availability: 'unavailable', reason: 'NO_APPROVED_POLICY' },
};
const v2Settings = {
  projectDisplayName: 'Ebb',
  defaultBranch: 'develop',
  roles: [],
  scheduler: { concurrency: 4, enablePriorityAging: true, criticalPathBoost: true },
  recovery: { resumeSessions: true, maxAttempts: 3, recoveryCycleMinutes: 60, abortOnNoProgressDays: 7 },
  github: { syncEnabled: false, issueLinking: false, pullRequestSync: false },
  budgets: [],
};

const task1AdapterNames = [
  'setDispatchState', 'cancelAllRuns', 'createRunCheckpoint', 'pauseRun', 'resumeRun',
  'getRunTerminal', 'getRunEventsPage', 'getRunDetail',
  'pauseProject', 'resumeProject', 'pauseEpic', 'resumeEpic', 'replanEpic',
  'resumeTask', 'setTaskPriority', 'getProjectIndex',
  'saveProjectConfigCandidate', 'reconcileProjectConfigJournal',
  'listApprovals', 'getApprovalDetail', 'getApprovalPolicies', 'getUsageWindow',
];

const fixturesByClientPath: Record<string, unknown> = {
  '/scheduler/dispatch-state': dispatchStateFixture,
  '/runs/cancel-all': cancelAllFixture,
  '/runs/run-1/checkpoint': controlFixture,
  '/runs/run-1/pause': controlFixture,
  '/runs/run-1/resume': controlFixture,
  '/runs/run-1/terminal': terminalAvailableFixture,
  '/runs/run-1/events?afterId=evt-1&limit=50': runEventsPageFixture,
  '/runs/run-1': runDetailFixture,
  '/projects/project-1/pause': projectPauseFixture,
  '/projects/project-1/resume': projectPauseFixture,
  '/epics/epic-1/pause': epicPauseFixture,
  '/epics/epic-1/resume': epicPauseFixture,
  '/epics/epic-1/replan': epicReplanFixture,
  '/tasks/task-1/resume': taskControlFixture,
  '/tasks/task-1/priority': taskPriorityFixture,
  '/projects?cursor=c1&limit=20': projectIndexFixture,
  '/projects/project-1/config/candidates/editor': candidateFixture,
  '/projects/project-1/config/journals/journal-1/reconcile': reconcileFixture,
  '/approvals?status=resolved': approvalsInboxFixture,
  '/approvals/approval-1': approvalDetailFixture,
  '/approvals/policies': approvalPolicyFixture,
  '/usage?from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-02T00%3A00%3A00.000Z&granularity=day': usageWindowFixture,
  '/execution': executionQueueFixture,
};

function fixture(path: string): unknown {
  if (!(path in fixturesByClientPath)) throw new Error(`no fixture for client path: ${path}`);
  return fixturesByClientPath[path];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function errorEnvelope(code: string, message: string, status = 403): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('Типизированные адаптеры API (Task 1 пути)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    apiClient.csrfToken = null;
  });

  test('каждый путь Task 1 покрыт адаптером', () => {
    for (const name of task1AdapterNames) {
      expect(typeof (api as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  test('в новых адаптерах нет сырых endpoint-строк', () => {
    expect(clientSrc).not.toMatch(/['"`]\/api\/v1\//);
  });

  test('адаптеры обращаются к каноническим путям через apiPaths', async () => {
    const hit: Array<{ method: string; url: string; body?: unknown }> = [];
    const spyGet = vi.spyOn(apiClient, 'get').mockImplementation(async (path: string) => fixture(path));
    const spyPost = vi.spyOn(apiClient, 'post').mockImplementation(async (path: string) => {
      hit.push({ method: 'post', url: path });
      return fixture(path);
    });
    const spyPut = vi.spyOn(apiClient, 'put').mockImplementation(async (path: string, body?: unknown) => {
      hit.push({ method: 'put', url: path, body });
      return fixture(path);
    });

    await api.setDispatchState(false);
    await api.cancelAllRuns(['run-1']);
    await api.createRunCheckpoint('run-1');
    await api.pauseRun('run-1');
    await api.resumeRun('run-1');
    await api.getRunTerminal('run-1');
    await api.getRunEventsPage('run-1', { afterId: 'evt-1', limit: 50 });
    await api.getRunDetail('run-1');
    await api.pauseProject('project-1');
    await api.resumeProject('project-1');
    await api.pauseEpic('epic-1');
    await api.resumeEpic('epic-1');
    await api.replanEpic('epic-1');
    await api.resumeTask('task-1');
    await api.setTaskPriority('task-1', 5);
    await api.getProjectIndex({ cursor: 'c1', limit: 20 });
    await api.saveProjectConfigCandidate('project-1', { expectedManifestHash: H, settings: v2Settings });
    await api.reconcileProjectConfigJournal('project-1', 'journal-1', {
      expectedPhase: 'DEGRADED', observedManifestHash: H, resolution: 'RESTORE_APPROVED',
    });
    await api.listApprovals('resolved');
    await api.getApprovalDetail('approval-1');
    await api.getApprovalPolicies();
    await api.getUsageWindow('2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'day');
    await api.getExecutionQueue();

    expect(spyPut).toHaveBeenCalledWith('/scheduler/dispatch-state', { paused: false });
    expect(spyPost).toHaveBeenCalledWith('/runs/cancel-all', { expectedRunIds: ['run-1'] });
    expect(spyPost).toHaveBeenCalledWith('/epics/epic-1/replan', {});
    expect(spyPost).toHaveBeenCalledWith('/tasks/task-1/resume');
    expect(spyGet).toHaveBeenCalledWith('/runs/run-1/events?afterId=evt-1&limit=50');
    expect(spyGet).toHaveBeenCalledWith('/projects?cursor=c1&limit=20');
    expect(spyGet).toHaveBeenCalledWith('/approvals?status=resolved');
    expect(spyGet).toHaveBeenCalledWith('/usage?from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-02T00%3A00%3A00.000Z&granularity=day');
    expect(spyGet).toHaveBeenCalledWith('/execution');
    expect(hit).toContainEqual({ method: 'put', url: '/scheduler/dispatch-state', body: { paused: false } });
  });

  test('адаптеры отвергают malformed ответы как INVALID_RESPONSE', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ nope: true }));
    await expect(api.getExecutionQueue()).rejects.toMatchObject({ name: 'ApiError', code: 'INVALID_RESPONSE' });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
    await expect(api.setDispatchState(true)).rejects.toMatchObject({ name: 'ApiError', code: 'INVALID_RESPONSE' });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ items: [{ id: 'e1' }], nextCursor: null }));
    await expect(api.getRunEventsPage('run-1')).rejects.toMatchObject({ name: 'ApiError', code: 'INVALID_RESPONSE' });
  });

  test('ошибки сервера сохраняют HTTP статус и код без fallback', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorEnvelope('APPROVAL_DENIED', 'denied', 403));
    await expect(api.getApprovalPolicies()).rejects.toMatchObject({
      name: 'ApiError', status: 403, code: 'APPROVAL_DENIED',
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorEnvelope('AUTH_UNAVAILABLE', 'unavailable', 503));
    await expect(api.getRunTerminal('run-1')).rejects.toMatchObject({
      name: 'ApiError', status: 503, code: 'AUTH_UNAVAILABLE',
    });
  });

  test('состояния unavailable и null-vs-zero сохраняются без выдумывания данных', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(runDetailFixture));
    const detail = await api.getRunDetail('run-1');
    expect(detail.usage.inputTokens).toEqual({ availability: 'unavailable', reason: 'NOT_RECORDED' });
    expect(detail.usage.cachedInputTokens).toEqual({ availability: 'available', value: 0 });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ availability: 'unavailable', reason: 'NO_SANITIZED_PERSISTED_SOURCE' }));
    const terminal = await api.getRunTerminal('run-1');
    expect(terminal.availability).toBe('unavailable');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(usageWindowFixture));
    const usage = await api.getUsageWindow('2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'day');
    expect(usage.anomaly).toEqual({ availability: 'unavailable', reason: 'NO_APPROVED_POLICY' });
    expect(usage.efficiency.deterministicCheckCount).toEqual({
      availability: 'unavailable', reason: 'NO_DURABLE_CHECK_EXECUTION_SOURCE',
    });
  });
});
