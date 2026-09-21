import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { apiClient } from '../src/api/client.js';
import AppShell from '../src/components/AppShell.js';

describe('SSE EventClient integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.sessionToken = 'session-token';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(''));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    apiClient.sessionToken = null;
  });

  test('initializes an authenticated stream at the server SSE route', async () => {
    const { eventClient } = await import('../src/api/events.js');
    eventClient.connect();

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/v1/events', expect.objectContaining({
      headers: { Authorization: 'Bearer session-token' },
    })));
    eventClient.disconnect();
  });

  test('sets up refetch callback for SSE reconnects', async () => {
    const { eventClient } = await import('../src/api/events.js');
    const refetchSpy = vi.fn();
    eventClient.setRefetchCallback(refetchSpy);

    expect(() => eventClient.setRefetchCallback(refetchSpy)).not.toThrow();
  });

  test('disconnects an active authenticated stream', async () => {
    const { eventClient } = await import('../src/api/events.js');
    eventClient.connect();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    eventClient.disconnect();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('renders route context breadcrumbs with a safe detail link', () => {
    render(
      <MemoryRouter initialEntries={['/tasks/task-7']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="tasks/:id" element={<div>Task body</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/');
    expect(screen.getByText('Task task-7')).toBeInTheDocument();
    expect(screen.getByText('Task body')).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current', 'page');
  });

  test('keeps malformed route IDs visible without throwing during breadcrumb rendering', () => {
    render(
      <MemoryRouter initialEntries={['/tasks/%E0%A4%A']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="tasks/:id" element={<div>Task body</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Task %E0%A4%A')).toBeInTheDocument();
  });
});
