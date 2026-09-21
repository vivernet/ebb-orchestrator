import { createBrowserRouter } from 'react-router';
import AppShell from '../components/AppShell.js';
import DashboardPage from '../features/dashboard/DashboardPage.js';
import ProjectPage from '../features/projects/ProjectPage.js';
import EpicPage from '../features/epics/EpicPage.js';
import TaskPage from '../features/tasks/TaskPage.js';
import ProjectOnboardingPage from '../features/onboarding/ProjectOnboardingPage.js';
import SettingsPage from '../features/settings/SettingsPage.js';
import UsagePage from '../features/usage/UsagePage.js';
import ApprovalInboxPage from '../features/approvals/ApprovalInboxPage.js';
import ExecutionPage from '../features/execution/ExecutionPage.js';
import AgentRunPage from '../features/runs/AgentRunPage.js';
import { isRouteErrorResponse, Link, useParams, useRevalidator, useRouteError } from 'react-router';

const ProjectRoute = () => <ProjectPage id={useParams().id ?? ''} />;
const EpicRoute = () => <EpicPage id={useParams().id ?? ''} />;
const TaskRoute = () => <TaskPage id={useParams().id ?? ''} />;
const OnboardingRoute = () => <ProjectOnboardingPage id={useParams().id ?? ''} />;
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
      <h1>Page not found</h1>
      <p>The requested route does not exist in this control plane.</p>
      <Link to="/">Back to Dashboard</Link>
    </div>
  );
}

/**
 * Представляет безопасную границу ошибки маршрута без раскрытия внутренних деталей исключения.
 */
export function RouteErrorPage() {
  const error = useRouteError();
  const revalidator = useRevalidator();
  const detail = isRouteErrorResponse(error)
    ? `${error.status}: ${error.statusText}`
    : 'The route could not be rendered safely.';

  return (
    <div className="page-state">
      <p className="eyebrow">Route error</p>
      <h1>Unable to render this page</h1>
      <p role="alert">{detail}</p>
      <div className="page-actions">
        <button type="button" onClick={() => revalidator.revalidate()} disabled={revalidator.state === 'loading'}>Retry</button>
        <Link to="/">Back to Dashboard</Link>
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
        Component: DashboardPage,
      },
      {
        id: 'project',
        path: 'projects/:id',
        Component: ProjectRoute,
      },
      {
        id: 'epic',
        path: 'epics/:id',
        Component: EpicRoute,
      },
      {
        id: 'task',
        path: 'tasks/:id',
        Component: TaskRoute,
      },
      {
        path: 'approvals',
        Component: ApprovalRoute,
      },
      {
        path: 'execution',
        Component: ExecutionRoute,
      },
      {
        path: 'runs/:id',
        Component: RunRoute,
      },
      {
        path: 'usage',
        Component: UsageRoute,
      },
      {
        path: 'settings',
        Component: SettingsRoute,
      },
      {
        path: 'projects/new',
        Component: OnboardingRoute,
      },
      {
        id: 'not-found',
        path: '*',
        Component: NotFoundPage,
      },
    ],
  },
]);
