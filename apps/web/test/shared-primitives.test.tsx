import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PageState } from '../src/components/ui/PageState.js';
import StatusBadge from '../src/components/ui/StatusBadge.js';

describe('shared presentation primitives', () => {
  test('renders loading as a status region', () => {
    render(<PageState status="loading" message="Loading tasks" />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading tasks');
  });

  test('renders an error alert with a retry action', () => {
    const onRetry = vi.fn();
    render(<PageState status="error" message="Could not load tasks" onRetry={onRetry} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load tasks');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  test('renders an empty state with its optional action slot', () => {
    render(
      <PageState
        status="empty"
        message="No tasks yet"
        action={<button type="button">Create task</button>}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('No tasks yet');
    expect(screen.getByRole('button', { name: 'Create task' })).toBeInTheDocument();
  });

  test('renders a not-found state with a back action', () => {
    const onBack = vi.fn();
    render(<PageState status="not-found" message="Task not found" onBack={onBack} />);

    expect(screen.getByRole('status')).toHaveTextContent('Task not found');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  test('keeps the canonical raw status available when showing a label', () => {
    render(<StatusBadge status="awaiting_approval" label="Awaiting approval" variant="warning" />);

    expect(screen.getByText('Awaiting approval')).toBeInTheDocument();
    expect(screen.getByTitle('awaiting_approval')).toBeInTheDocument();
  });
});
