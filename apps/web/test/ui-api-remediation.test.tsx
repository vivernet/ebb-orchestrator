import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ApprovalInboxPage, { mapApprovalRow } from '../src/features/approvals/ApprovalInboxPage.js';
import DashboardPage from '../src/features/dashboard/DashboardPage.js';
import { apiClient } from '../src/api/client.js';

describe('approval UI/API remediation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('maps the server envelope fields and uppercase values to the UI model', () => {
    expect(mapApprovalRow({
      id: 'approval-1', type: 'FINAL_MERGE', subject_id: 'epic-1', subject_type: 'EPIC',
      status: 'PENDING', requested_by: 'orchestrator', resolved_by: null,
      resolution_note: null, created_at: '2026-09-17T00:00:00Z', resolved_at: null,
    })).toEqual({
      id: 'approval-1', scope: 'epic', action: 'FINAL_MERGE', description: 'EPIC epic-1',
      requestedBy: 'orchestrator', context: '', status: 'pending', createdAt: '2026-09-17T00:00:00Z',
    });
  });

  test('only exposes the server-approved approve mutation', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({ approvals: [{
      id: 'approval-1', type: 'FINAL_MERGE', subject_id: 'task-1', subject_type: 'TASK',
      status: 'PENDING', requested_by: 'orchestrator', resolved_by: null,
      resolution_note: null, created_at: '2026-09-17T00:00:00Z', resolved_at: null,
    }] });
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({});
    render(<ApprovalInboxPage />);
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request Changes' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/approvals/approval-1/approve', {}));
  });

  test('loads the inbox through the canonical query path with AbortSignal', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ approvals: [] });
    render(<ApprovalInboxPage />);

    expect(await screen.findByText('No pending approvals.')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/approvals', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  test('refetches the inbox after SSE reconnect and keeps the empty state explicit', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ approvals: [] });
    render(<ApprovalInboxPage />);

    await screen.findByText('No pending approvals.');
    window.dispatchEvent(new CustomEvent('sse-reconnect'));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.getByText('No pending approvals.')).toBeInTheDocument();
  });

  test('deduplicates pending approve and refetches the authoritative approvals list', async () => {
    let resolveApprove!: (value: unknown) => void;
    const approve = new Promise((resolve) => { resolveApprove = resolve; });
    const get = vi.spyOn(apiClient, 'get')
      .mockResolvedValueOnce({ approvals: [{
        id: 'approval-1', type: 'FINAL_MERGE', subject_id: 'task-1', subject_type: 'TASK',
        status: 'PENDING', requested_by: 'orchestrator', resolved_by: null,
        resolution_note: null, created_at: '2026-09-17T00:00:00Z', resolved_at: null,
      }] })
      .mockResolvedValueOnce({ approvals: [] });
    const post = vi.spyOn(apiClient, 'post').mockReturnValue(approve);
    render(<ApprovalInboxPage />);

    const button = await screen.findByRole('button', { name: 'Approve' });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(button).toBeDisabled();
    resolveApprove({});
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('No pending approvals.')).toBeInTheDocument());
  });

  test('renders approval load failures with a retry affordance', async () => {
    const get = vi.spyOn(apiClient, 'get').mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce({ approvals: [] });
    render(<ApprovalInboxPage />);
    expect(await screen.findByText('Unable to load approvals: network down')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.getByText('No pending approvals.')).toBeInTheDocument();
  });

  test('renders approval mutation failures with a reload affordance', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ approvals: [{
      id: 'approval-1', type: 'FINAL_MERGE', subject_id: 'task-1', subject_type: 'TASK',
      status: 'PENDING', requested_by: 'orchestrator', resolved_by: null,
      resolution_note: null, created_at: '2026-09-17T00:00:00Z', resolved_at: null,
    }] });
    vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('approval unavailable'));
    render(<ApprovalInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Unable to update approval: approval unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });
});

describe('dashboard failure states', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('renders explicit projection and queue errors with retry affordances', async () => {
    const get = vi.spyOn(apiClient, 'get').mockRejectedValue(new Error('server unavailable'));
    render(<DashboardPage />);
    expect(await screen.findByText('Unable to load dashboard: server unavailable')).toBeInTheDocument();
    expect(screen.getByText('Unable to load queue: server unavailable')).toBeInTheDocument();
    const retryButtons = screen.getAllByRole('button', { name: 'Retry' });
    expect(retryButtons).toHaveLength(2);
    const projectionRetry = retryButtons.at(0);
    if (!projectionRetry) throw new Error('projection retry button missing');
    fireEvent.click(projectionRetry);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  });

  test('does not expose dead dashboard actions', () => {
    render(<DashboardPage />);
    expect(screen.queryByRole('button', { name: 'Pause All' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New Request' })).not.toBeInTheDocument();
  });
});

describe('API error parsing', () => {
  afterEach(() => vi.restoreAllMocks());

  test('preserves a structured server error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'approval denied' }), {
      status: 403, statusText: 'Forbidden', headers: { 'Content-Type': 'application/json' },
    }));
    await expect(apiClient.get('/approvals')).rejects.toThrow('approval denied');
  });

  test('falls back safely for non-JSON error responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' }));
    await expect(apiClient.get('/approvals')).rejects.toThrow('API error: 502 Bad Gateway');
  });
});
