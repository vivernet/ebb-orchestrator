import { createBrowserRouter } from 'react-router';
import AppShell from '../components/AppShell.js';
import DashboardPage from '../features/dashboard/DashboardPage.js';
import ProjectsIndex from '../features/projects/ProjectsIndex.js';
import ProjectPage from '../features/projects/ProjectPage.js';
import EpicPage from '../features/epics/EpicPage.js';
import TaskPage from '../features/tasks/TaskPage.js';
import OnboardingPage from '../features/onboarding/OnboardingPage.js';
import SettingsPage from '../features/settings/SettingsPage.js';
import UsagePage from '../features/usage/UsagePage.js';
import ApprovalInboxPage from '../features/approvals/ApprovalInboxPage.js';
import ExecutionPage from '../features/execution/ExecutionPage.js';
import AgentRunPage from '../features/runs/AgentRunPage.js';
import { Link, useParams, useRevalidator } from 'react-router';
import { ru } from '../i18n/ru.js';

const ProjectRoute = () => <ProjectPage id={useParams().id ?? ''} />;
const EpicRoute = () => <EpicPage id={useParams().id ?? ''} />;
const TaskRoute = () => <TaskPage id={useParams().id ?? ''} />;
const OnboardingRoute = () => <OnboardingPage />;
const OnboardingProjectRoute = () => <OnboardingPage projectId={useParams().id ?? ''} />;
const SettingsRoute = () => <SettingsPage />;
const UsageRoute = () => <UsagePage />;
const ApprovalRoute = () => <ApprovalInboxPage />;
const ExecutionRoute = () => <ExecutionPage />;
const RunRoute = () => <AgentRunPage id={useParams().id ?? ''} />;

/**
 * Представляет безопасное состояние для маршрута, которого нет в текущем V1 control plane.
 */
export function NotFoundPage() {
  return (
    <div className="page-state">
      <p className="eyebrow">404</p>
      <h1>{ru.common.notFound}</h1>
      <p>{ru.common.requestedRouteMissing}</p>
      <Link to="/">{ru.common.backToDashboard}</Link>
    </div>
  );
}

/**
 * Представляет безопасную границу ошибки маршрута без раскрытия внутренних деталей исключения.
 */
export function RouteErrorPage() {
  const revalidator = useRevalidator();

  return (
    <div className="page-state">
      <p className="eyebrow">{ru.common.routeError}</p>
      <h1>{ru.common.unableToRender}</h1>
      <p role="alert">{ru.common.unableToRender}</p>
      <div className="page-actions">
        <button type="button" onClick={() => revalidator.revalidate()} disabled={revalidator.state === 'loading'}>{ru.common.retry}</button>
        <Link to="/">{ru.common.backToDashboard}</Link>
      </div>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    path: '/',
    Component: AppShell,
    errorElement: <RouteErrorPage />,
    children: [
      {
        id: 'dashboard',
        path: '',
        handle: { breadcrumbLabel: ru.breadcrumbs.dashboard },
        Component: DashboardPage,
      },
      {
        id: 'projects-index',
        path: 'projects',
        handle: { breadcrumbLabel: ru.breadcrumbs.projects },
        Component: ProjectsIndex,
      },
      {
        id: 'project',
        path: 'projects/:id',
        handle: { breadcrumbLabel: ru.breadcrumbs.project },
        Component: ProjectRoute,
      },
      {
        id: 'epic',
        path: 'epics/:id',
        handle: { breadcrumbLabel: ru.breadcrumbs.epic },
        Component: EpicRoute,
      },
      {
        id: 'project-epic',
        path: 'projects/:projectId/epics/:epicId',
        handle: { breadcrumbLabel: ru.breadcrumbs.epic },
        Component: EpicRoute,
      },
      {
        id: 'task',
        path: 'tasks/:id',
        handle: { breadcrumbLabel: ru.breadcrumbs.task },
        Component: TaskRoute,
      },
      {
        id: 'project-task',
        path: 'projects/:projectId/tasks/:taskId',
        handle: { breadcrumbLabel: ru.breadcrumbs.task },
        Component: TaskRoute,
      },
      {
        path: 'approvals',
        handle: { breadcrumbLabel: ru.breadcrumbs.approvals },
        Component: ApprovalRoute,
      },
      {
        path: 'execution',
        handle: { breadcrumbLabel: ru.breadcrumbs.execution },
        Component: ExecutionRoute,
      },
      {
        id: 'run',
        path: 'runs/:id',
        handle: { breadcrumbLabel: ru.breadcrumbs.run },
        Component: RunRoute,
      },
      {
        id: 'project-run',
        path: 'projects/:projectId/runs/:runId',
        handle: { breadcrumbLabel: ru.breadcrumbs.run },
        Component: RunRoute,
      },
      {
        path: 'usage',
        handle: { breadcrumbLabel: ru.breadcrumbs.usage },
        Component: UsageRoute,
      },
      {
        path: 'settings',
        handle: { breadcrumbLabel: ru.breadcrumbs.settings },
        Component: SettingsRoute,
      },
      {
        path: 'projects/new',
        handle: { breadcrumbLabel: ru.breadcrumbs.onboarding },
        Component: OnboardingRoute,
      },
      {
        id: 'onboarding-project',
        path: 'onboarding/:id',
        handle: { breadcrumbLabel: ru.breadcrumbs.onboarding },
        Component: OnboardingProjectRoute,
      },
      {
        id: 'not-found',
        path: '*',
        handle: { breadcrumbLabel: ru.breadcrumbs.notFound },
        Component: NotFoundPage,
      },
    ],
  },
]);
