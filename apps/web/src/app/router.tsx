import { createBrowserRouter } from 'react-router';
import AppShell from '../components/AppShell.js';

export const router = createBrowserRouter([
  {
    path: '/',
    Component: AppShell,
    children: [
      {
        path: '',
        Component: () => <div>Dashboard</div>,
      },
      {
        path: 'projects/:id',
        Component: () => <div>Project</div>,
      },
      {
        path: 'epics/:id',
        Component: () => <div>Epic</div>,
      },
      {
        path: 'tasks/:id',
        Component: () => <div>Task</div>,
      },
      {
        path: 'approvals',
        Component: () => <div>Approvals</div>,
      },
      {
        path: 'execution',
        Component: () => <div>Execution</div>,
      },
      {
        path: 'runs/:id',
        Component: () => <div>Run</div>,
      },
      {
        path: 'usage',
        Component: () => <div>Usage</div>,
      },
      {
        path: 'settings',
        Component: () => <div>Settings</div>,
      },
      {
        path: 'projects/new',
        Component: () => <div>New Project</div>,
      },
    ],
  },
]);
