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
import { useParams } from 'react-router';

const ProjectRoute = () => <ProjectPage id={useParams().id ?? ''} />;
const EpicRoute = () => <EpicPage id={useParams().id ?? ''} />;
const TaskRoute = () => <TaskPage id={useParams().id ?? ''} />;
const OnboardingRoute = () => <ProjectOnboardingPage id={useParams().id ?? ''} />;
const SettingsRoute = () => <SettingsPage />;
const UsageRoute = () => <UsagePage />;
const ApprovalRoute = () => <ApprovalInboxPage />;
const ExecutionRoute = () => <ExecutionPage />;
const RunRoute = () => <AgentRunPage id={useParams().id ?? ''} />;

export const router = createBrowserRouter([
  {
    path: '/',
    Component: AppShell,
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
    ],
  },
]);
