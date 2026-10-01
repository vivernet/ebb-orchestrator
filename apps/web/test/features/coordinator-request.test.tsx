import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiClient } from '../../src/api/client.js';
import CoordinatorRequestPanel from '../../src/features/coordinator/CoordinatorRequestPanel.js';

afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });

describe('Coordinator request panel', () => {
  it('submits the project request and shows authoritative progress', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ requestId: 'request/1', status: 'RECEIVED' });
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ requestId: 'request/1', status: 'PLANNING', classification: null, planId: null, planVersion: null, failureCode: null, plan: null });
    render(<CoordinatorRequestPanel projectId="project/1" />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Запрос для Coordinator' }), { target: { value: 'Создай эпик для выпуска' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить запрос' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/projects/project%2F1/requests', { request: 'Создай эпик для выпуска' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/projects/project%2F1/requests/request%2F1'));
    expect(screen.getByText(/Планирование/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Одобрить план и запустить Epic' })).not.toBeInTheDocument();
  });

  it('shows the complete pending plan before explicit approval', async () => {
    sessionStorage.setItem('coordinator-request:project-1', 'request-1');
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ requestId: 'request-1', status: 'PLAN_PENDING_APPROVAL', classification: 'EPIC', planId: 'plan/1', planVersion: 1, failureCode: null, plan: {
      epic: { title: 'Выпуск', goal: 'Подготовить релиз' },
      planningDecisions: {
        productManager: { outcome: 'PRODUCT_DEFINITION', goal: 'Безопасно выпустить функцию', scope: ['Сборка и публикация'], nonGoals: ['Переписать billing'] },
        architect: { outcome: 'DESIGN', components: ['Существующий build service'], decisions: ['Использовать текущую границу модуля'], proposals: [{ type: 'SCOPE_CHANGE', title: 'Оставить за пределами', rationale: 'Не нужно для выпуска' }] },
      },
      tasks: [{ ref: 'task-a', title: 'Сборка', acceptanceCriteria: ['Артефакт собран'], dependsOn: [] }, { ref: 'task-b', title: 'Публикация', acceptanceCriteria: ['Публикация доступна'], dependsOn: ['task-a'] }],
    } });
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ result: {} });
    render(<CoordinatorRequestPanel projectId="project-1" />);
    expect(await screen.findByText('Подготовить релиз')).toBeInTheDocument();
    expect(screen.getByText('Артефакт собран')).toBeInTheDocument();
    expect(screen.getByText('Публикация доступна')).toBeInTheDocument();
    expect(screen.getByText(/task-a/)).toBeInTheDocument();
    expect(screen.getByText('Решение Product Manager')).toBeInTheDocument();
    expect(screen.getByText('Безопасно выпустить функцию')).toBeInTheDocument();
    expect(screen.getByText('Решение Architect')).toBeInTheDocument();
    expect(screen.getByText('Использовать текущую границу модуля')).toBeInTheDocument();
    expect(screen.getByText(/Оставить за пределами/)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Одобрить план и запустить Epic' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/projects/project-1/epics/plans/plan%2F1/approve-run', { requestId: 'request-1' }));
    expect(get).toHaveBeenCalled();
  });

  it('does not offer approval for a failed request', async () => {
    sessionStorage.setItem('coordinator-request:project-1', 'request-1');
    vi.spyOn(apiClient, 'get').mockResolvedValue({ requestId: 'request-1', status: 'FAILED', classification: null, planId: null, planVersion: null, failureCode: 'COORDINATOR_RUN_FAILED', plan: null });
    render(<CoordinatorRequestPanel projectId="project-1" />);
    expect(await screen.findByText(/Ошибка планирования/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Одобрить план и запустить Epic' })).not.toBeInTheDocument();
  });

  it('shows a safe recovery blocker and offers an explicit retry for an Epic recovery failure', async () => {
    sessionStorage.setItem('coordinator-request:project-1', 'request-1');
    vi.spyOn(apiClient, 'get').mockResolvedValue({ requestId: 'request-1', status: 'FAILED', classification: 'EPIC', planId: 'plan-1', planVersion: 1, failureCode: 'EPIC_RECOVERY_FAILED', plan: { epic: { title: 'Выпуск' }, tasks: [{ ref: 'task-a', title: 'Сборка', acceptanceCriteria: ['Собрано'] }] } });
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ result: {} });
    render(<CoordinatorRequestPanel projectId="project-1" />);

    expect(await screen.findByText('Восстановление Epic заблокировано')).toBeInTheDocument();
    expect(screen.getByText(/Код ошибки:/)).toBeInTheDocument();
    expect(screen.getByText('EPIC_RECOVERY_FAILED')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить запуск Epic' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/projects/project-1/epics/plans/plan-1/approve-run', { requestId: 'request-1' }));
  });
});
