import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import AppShell from '../src/components/AppShell.js';

function renderShell(pathname: string, element = <div>Task body</div>) {
  const testRouter = createMemoryRouter([
    {
      path: '/',
      Component: AppShell,
      children: [{
        path: 'tasks/:id',
        handle: { breadcrumbLabel: 'Task' },
        element,
      }],
    },
  ], { initialEntries: [pathname] });

  return render(<RouterProvider router={testRouter} />);
}

describe('SSE EventClient integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(''));
  });

  afterEach(() => {
    vi.restoreAllMocks();

  });

  test('initializes an authenticated stream at the server SSE route', async () => {
    const { eventClient } = await import('../src/api/events.js');
    eventClient.connect();

    expect(fetch).toHaveBeenCalledWith('/api/v1/events', expect.objectContaining({ credentials: 'same-origin' }));
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
    renderShell('/tasks/task-7');

    expect(screen.getByRole('navigation', { name: 'Навигационная цепочка' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Навигационная цепочка' })).getByRole('link', { name: 'Обзор' })).toHaveAttribute('href', '/');
    expect(screen.getByText('Task task-7')).toBeInTheDocument();
    expect(screen.getByText('Task body')).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Основная навигация' })).getByRole('link', { name: 'Обзор' })).not.toHaveAttribute('aria-current', 'page');
  });

  test('keeps the breadcrumb landmark outside the outlet content wrapper', () => {
    renderShell('/tasks/task-7');

    const breadcrumbs = screen.getByRole('navigation', { name: 'Навигационная цепочка' });
    const taskBody = screen.getByText('Task body');

    expect(taskBody.closest('.route-breadcrumbs')).toBeNull();
    expect(breadcrumbs.parentElement).toHaveClass('main-content');
  });

  test('renders a once-encoded untrusted identifier as text without decoding it again', () => {
    renderShell('/tasks/%253Cimg%2520src%253Dx%2520onerror%253Dalert(1)%253E');

    expect(screen.getByText('Task %3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  test('keeps malformed route IDs visible without throwing during breadcrumb rendering', () => {
    renderShell('/tasks/%E0%A4%A');

    expect(screen.getByText('Task %E0%A4%A')).toBeInTheDocument();
  });
});
