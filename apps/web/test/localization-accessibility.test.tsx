import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import WorkflowTimeline from '../src/components/WorkflowTimeline.js';
import { ConnectionIndicator } from '../src/components/ui/ConnectionIndicator.js';
import { NotificationIndicator } from '../src/components/ui/NotificationIndicator.js';
import SanitizedTerminal from '../src/components/SanitizedTerminal.js';
import { PageState } from '../src/components/ui/PageState.js';
import StatusBadge from '../src/components/ui/StatusBadge.js';
import LoginPage from '../src/features/auth/LoginPage.js';
import OnboardingPage from '../src/features/onboarding/OnboardingPage.js';
import ProjectOnboardingPage from '../src/features/onboarding/ProjectOnboardingPage.js';
import { apiErrorMessage } from '../src/i18n/ru.js';
import { authErrorCodes, onboardingErrorCodes } from '@ebb-orchestrator/contracts';

const sensitiveApiError = () => new Response(JSON.stringify({
  error: { message: 'SYNTHETIC_SECRET_TOKEN_7f3a private/database/path Bearer sensitive-test-value', code: 'SYNTHETIC_UNKNOWN_BACKEND_CODE' },
}), { status: 500, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.restoreAllMocks());

const inventory = [
  'components/AppShell.tsx', 'app/router.tsx', 'components/ui/PageState.tsx',
  'components/ui/StatusBadge.tsx', 'components/ui/ConnectionIndicator.tsx',
  'components/ui/NotificationIndicator.tsx', 'components/WorkflowTimeline.tsx',
  'components/SanitizedTerminal.tsx', 'app/App.tsx', 'main.tsx',
  'features/auth/LoginPage.tsx', 'features/dashboard/DashboardPage.tsx',
  'features/projects/ProjectsIndex.tsx', 'features/projects/ProjectPage.tsx',
  'features/epics/EpicPage.tsx', 'features/tasks/TaskPage.tsx',
  'features/approvals/ApprovalInboxPage.tsx', 'features/execution/ExecutionPage.tsx',
  'features/runs/AgentRunPage.tsx', 'features/usage/UsagePage.tsx',
  'features/settings/SettingsPage.tsx', 'features/onboarding/OnboardingPage.tsx',
  'features/onboarding/ProjectOnboardingPage.tsx',
];

const sourceFiles = import.meta.glob('../src/**/*.{ts,tsx}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;
const normalizedSourceFiles = Object.fromEntries(
  Object.entries(sourceFiles).map(([path, source]) => [path.replace('../src/', ''), source]),
);
const src = (path: string) => normalizedSourceFiles[path] ?? '';
const tsxFiles = () => Object.keys(normalizedSourceFiles).filter((path) => path.endsWith('.tsx')).sort();

describe('Russian UI and accessibility inventory', () => {
  it('matches the complete approved source inventory exactly', () => {
    expect(tsxFiles()).toEqual([...inventory].sort());
    for (const path of inventory) expect(src(path), path).not.toBe('');
    expect(src('i18n/ru.ts')).toContain('AUTH_SESSION_REQUIRED');
    expect(src('i18n/ru.ts')).toContain('Не удалось выполнить запрос.');
    expect(src('i18n/ru.ts')).toContain('Object.hasOwn');
  });

  it('uses a safe fallback for inherited and unknown error-code keys', () => {
    expect(apiErrorMessage('toString')).toBe('Не удалось выполнить запрос.');
    expect(apiErrorMessage('constructor')).toBe('Не удалось выполнить запрос.');
    expect(apiErrorMessage('UNRECOGNIZED')).toBe('Не удалось выполнить запрос.');
  });

  it('maps every stable auth and onboarding contract code to a specific safe Russian message', () => {
    for (const code of [...authErrorCodes, ...onboardingErrorCodes]) {
      const message = apiErrorMessage(code);
      expect(message, code).not.toBe('Не удалось выполнить запрос.');
      expect(message, code).toMatch(/[А-Яа-яЁё]/);
      expect(message, code).not.toContain(code);
    }
    expect(apiErrorMessage('UNRECOGNIZED')).toBe('Не удалось выполнить запрос.');
  });

  it('announces a known auth error without exposing backend details', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: 'AUTH_UNAVAILABLE', message: 'SYNTHETIC_SECRET_TOKEN_7f3a' },
    }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
    render(<LoginPage onAuthenticated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'synthetic-password' } });
    fireEvent.submit(screen.getByLabelText('Пароль').closest('form')!);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Сервис входа временно недоступен.');
    expect(alert).not.toHaveTextContent('SYNTHETIC_SECRET_TOKEN_7f3a');
  });

  it('renders localized accessible names and shared action labels', () => {
    render(<>
      <WorkflowTimeline stages={['DEV', 'REVIEW']} currentStage="REVIEW" />
      <ConnectionIndicator autoSubscribe={false} />
      <NotificationIndicator count={2} />
      <SanitizedTerminal logs={['output']} />
      <PageState status="error" message="Ошибка" onRetry={() => {}} />
      <StatusBadge status="READY" label="Готово" />
    </>);
    expect(screen.getByRole('region', { name: 'Хронология рабочего процесса' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'В сети' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Уведомления' })).toBeTruthy();
    expect(screen.getByLabelText('Вывод терминала')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy();
    expect(screen.getByText('Готово')).toBeTruthy();
    expect(screen.getByText('Проверка')).toBeTruthy();
  });

  it('updates the named connection indicator on offline and online events', () => {
    render(<ConnectionIndicator />);
    expect(screen.getByRole('img', { name: 'В сети' })).toHaveAttribute('data-online', 'true');
    fireEvent(window, new Event('offline'));
    expect(screen.getByRole('img', { name: 'Не в сети' })).toHaveAttribute('data-online', 'false');
    fireEvent(window, new Event('online'));
    expect(screen.getByRole('img', { name: 'В сети' })).toHaveAttribute('data-online', 'true');
  });

  it('keeps shared shell accessible names localized in source', () => {
    const shell = src('components/AppShell.tsx');
    const router = src('app/router.tsx');
    for (const text of ['Breadcrumb', 'Primary navigation', 'Dashboard', 'Projects', 'Settings']) {
      expect(shell).not.toContain(`"${text}"`);
    }
    for (const text of ['Page not found', 'Route error', 'Retry', 'Back to Dashboard']) {
      expect(router).not.toContain(`>${text}<`);
    }
  });

  it('associates and announces login/onboarding errors and keeps settings read-only', () => {
    const onboarding = src('features/onboarding/OnboardingPage.tsx');
    const login = src('features/auth/LoginPage.tsx');
    expect(onboarding).toMatch(/aria-describedby=/);
    expect(onboarding).toMatch(/role="alert"|aria-live=/);
    expect(onboarding).toMatch(/aria-invalid=/);
    expect(onboarding).toContain('focus(');
    expect(login).toMatch(/aria-describedby=/);
    expect(login).toMatch(/role="alert"|aria-live=/);
    expect(login).toContain('focus(');
    expect(src('features/settings/SettingsPage.tsx')).not.toMatch(/<button|<input|<select/);
  });

  it('rejects untranslated and mixed-language visible copy across seven work pages', () => {
    const workPages = [
      'features/dashboard/DashboardPage.tsx',
      'features/projects/ProjectsIndex.tsx',
      'features/projects/ProjectPage.tsx',
      'features/epics/EpicPage.tsx',
      'features/tasks/TaskPage.tsx',
      'features/execution/ExecutionPage.tsx',
      'features/runs/AgentRunPage.tsx',
    ];
    for (const path of workPages) {
      const source = src(path);
      expect(source, path).not.toMatch(/(?:Loading|unavailable|not found|Input|Cached|Output)\s*(?:токенов)?/);
      expect(source, path).not.toMatch(/[А-Яа-яЁё][^\n<>]*\b(?:unavailable|not found|Loading|Input|Cached|Output)\b/);
    }
    expect(src('features/tasks/TaskPage.tsx')).not.toContain("'Loading'");
    expect(src('features/tasks/TaskPage.tsx')).not.toContain('Related work unavailable.');
    expect(src('features/tasks/TaskPage.tsx')).not.toContain('Dependencies and events unavailable.');
    expect(src('features/epics/EpicPage.tsx')).not.toContain('Epic branch and approvals unavailable.');
    expect(src('features/runs/AgentRunPage.tsx')).not.toContain('not found');
    expect(src('features/runs/AgentRunPage.tsx')).not.toContain('Input токенов');
    expect(src('features/runs/AgentRunPage.tsx')).not.toContain('Cached токенов');
    expect(src('features/runs/AgentRunPage.tsx')).not.toContain('Output токенов');
    expect(src('features/tasks/TaskPage.tsx')).toContain('ru.common.loading');
    expect(src('features/tasks/TaskPage.tsx')).toContain('ru.tasks.relatedWorkUnavailable');
    expect(src('features/epics/EpicPage.tsx')).toContain('ru.epics.branchApprovalsUnavailable');
    expect(src('features/runs/AgentRunPage.tsx')).toContain('ru.runs.notFound');
    expect(src('features/runs/AgentRunPage.tsx')).toContain('ru.runs.inputTokens');
    expect(src('i18n/ru.ts')).toContain("inputTokens: 'Входные токены'");
    expect(src('i18n/ru.ts')).toContain("cachedTokens: 'Кэшированные токены'");
    expect(src('i18n/ru.ts')).toContain("outputTokens: 'Выходные токены'");
    expect(src('i18n/ru.ts')).toContain("notFound: 'не найден.'");
    expect(src('features/tasks/TaskPage.tsx')).toContain('query.status === \'error\'');
    expect(src('features/epics/EpicPage.tsx')).toContain('query.status === \'success\'');
    expect(src('features/runs/AgentRunPage.tsx')).toContain("['STARTED', 'IN_PROGRESS', 'COMPLETING']");
  });

  it('uses localized safe fallbacks and avoids mixed-language project errors', () => {
    for (const path of [
      'features/dashboard/DashboardPage.tsx',
      'features/projects/ProjectsIndex.tsx',
      'features/projects/ProjectPage.tsx',
      'features/epics/EpicPage.tsx',
      'features/tasks/TaskPage.tsx',
      'features/approvals/ApprovalInboxPage.tsx',
      'features/execution/ExecutionPage.tsx',
      'features/runs/AgentRunPage.tsx',
      'features/usage/UsagePage.tsx',
    ]) {
      expect(src(path), path).not.toContain('unknown error');
    }
    expect(src('features/projects/ProjectsIndex.tsx')).not.toContain('проекты list');
    expect(src('features/projects/ProjectsIndex.tsx')).toContain('Не удалось загрузить список проектов.');
  });

  it('does not render API error details on login', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sensitiveApiError());
    render(<LoginPage onAuthenticated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'synthetic-password' } });
    fireEvent.submit(screen.getByLabelText('Пароль').closest('form')!);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Не удалось выполнить запрос.');
    expect(alert).not.toHaveTextContent(/SYNTHETIC_SECRET_TOKEN|private\/database\/path|Bearer sensitive-test-value/);
  });

  it('does not render API error details on onboarding discovery', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sensitiveApiError());
    render(<OnboardingPage />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Путь к репозиторию' }), { target: { value: 'C:/synthetic/repository' } });
    fireEvent.submit(screen.getByRole('textbox', { name: 'Путь к репозиторию' }).closest('form')!);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Не удалось выполнить запрос.');
    expect(alert).not.toHaveTextContent(/SYNTHETIC_SECRET_TOKEN|private\/database\/path|Bearer sensitive-test-value/);
  });

  it('does not render API error details on project onboarding', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sensitiveApiError());
    render(<ProjectOnboardingPage id="synthetic-project" />);

    await waitFor(() => expect(screen.getByText('Ошибка: Не удалось выполнить запрос.')).toBeTruthy());
    expect(document.body).not.toHaveTextContent(/SYNTHETIC_SECRET_TOKEN|private\/database\/path|Bearer sensitive-test-value/);
  });

  it('never renders arbitrary login, restore, or onboarding error details', () => {
    const paths = [
      'features/auth/LoginPage.tsx',
      'main.tsx',
      'features/onboarding/OnboardingPage.tsx',
      'features/onboarding/ProjectOnboardingPage.tsx',
    ];
    const syntheticDetails = [
      'SYNTHETIC_SECRET_TOKEN_7f3a',
      'private/database/path',
      'Bearer sensitive-test-value',
    ];

    for (const path of paths) {
      const source = src(path);
      expect(source, path).toContain('apiErrorMessage(');
      expect(source, path).not.toMatch(/(?:cause|e|error)\.message/);
      if (path === 'features/onboarding/OnboardingPage.tsx') {
        expect(source.match(/apiErrorMessage\(/g)).toHaveLength(5);
      }
      for (const detail of syntheticDetails) expect(source, path).not.toContain(detail);
    }

    expect(apiErrorMessage('AUTH_INVALID_CREDENTIALS')).toBe('Неверный пароль.');
    expect(apiErrorMessage('AUTH_SESSION_REQUIRED')).toBe('Войдите, чтобы продолжить.');
    expect(apiErrorMessage('SYNTHETIC_UNKNOWN_BACKEND_CODE')).toBe('Не удалось выполнить запрос.');
    expect(apiErrorMessage(undefined)).toBe('Не удалось выполнить запрос.');
  });

  it('maps only stable API error codes on every reviewed page', () => {
    const errorPages = [
      'features/dashboard/DashboardPage.tsx',
      'features/approvals/ApprovalInboxPage.tsx',
      'features/execution/ExecutionPage.tsx',
      'features/usage/UsagePage.tsx',
      'features/tasks/TaskPage.tsx',
      'features/epics/EpicPage.tsx',
      'features/runs/AgentRunPage.tsx',
      'features/projects/ProjectPage.tsx',
    ];
    for (const path of errorPages) {
      expect(src(path), path).toContain('apiErrorMessage(');
      expect(src(path), path).not.toMatch(/error\.message|query\.error\.message/);
    }
  });

  it('localizes all remaining authorized feature-page copy while preserving technical identifiers', () => {
    for (const path of [
      'features/dashboard/DashboardPage.tsx',
      'features/auth/LoginPage.tsx',
      'features/usage/UsagePage.tsx',
      'features/settings/SettingsPage.tsx',
      'features/onboarding/OnboardingPage.tsx',
      'features/onboarding/ProjectOnboardingPage.tsx',
    ]) {
      const source = src(path);
      expect(source, path).not.toMatch(/>(Dashboard|Usage|Settings|Loading|Retry|Repository|Security|Actions|Approval Status|Project onboarding)</);
      expect(source, path).not.toMatch(/aria-label="(Running agents|Active work|Repository|Security settings|Actions|Approval status)"/);
    }
    expect(src('features/usage/UsagePage.tsx')).toContain('project_id');
    expect(src('features/onboarding/ProjectOnboardingPage.tsx')).toContain("'PENDING' | 'APPROVED'");
    expect(src('features/onboarding/OnboardingPage.tsx')).toContain("result.status === 'APPROVAL_PENDING'");
  });
});
