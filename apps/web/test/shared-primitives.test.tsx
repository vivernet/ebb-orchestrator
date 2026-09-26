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
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  test('keeps the canonical raw status available when showing a label', () => {
    render(<StatusBadge status="awaiting_approval" label="Awaiting approval" variant="warning" />);

    expect(screen.getByText('Ожидает согласования')).toBeInTheDocument();
    expect(screen.getByText('Ожидает согласования')).toHaveAttribute('data-status', 'awaiting_approval');
    expect(screen.getByTitle('Ожидает согласования')).toBeInTheDocument();
  });

  test('localizes known status without a supplied label and retains unknown custom labels', () => {
    render(<><StatusBadge status="IN_PROGRESS" /><StatusBadge status="custom" label="Особый статус" /></>);
    expect(screen.getByText('Выполняется')).toHaveAttribute('data-status', 'IN_PROGRESS');
    expect(screen.getByText('Особый статус')).toHaveAttribute('data-status', 'custom');
  });

  test.each([
    ['STARTED', 'Запущено'], ['COMPLETING', 'Завершается'], ['WAITING', 'Ожидает'],
    ['REJECTED', 'Отклонено'], ['CHANGES_REQUESTED', 'Запрошены изменения'],
    ['once', 'Однократно'], ['run', 'Запуск'], ['task', 'Задача'],
    ['epic', 'Эпик'], ['project', 'Проект'],
  ])('renders %s in Russian while preserving the protocol value', (status, label) => {
    render(<StatusBadge status={status} label={status} />);
    expect(screen.getByText(label)).toHaveAttribute('data-status', status);
  });

  test('does not expose an unrecognized English label as visible text or title', () => {
    render(<StatusBadge status="NEW_SERVER_VALUE" label="Secret backend status" />);
    expect(screen.getByText('Неизвестный статус')).toHaveAttribute('data-status', 'NEW_SERVER_VALUE');
    expect(screen.queryByText('Secret backend status')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Secret backend status')).not.toBeInTheDocument();
  });
});
