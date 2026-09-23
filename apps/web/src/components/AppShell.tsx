import { Link, NavLink, Outlet, useMatches } from 'react-router';
import { ConnectionIndicator } from './ui/ConnectionIndicator.js';
import { NotificationIndicator } from './ui/NotificationIndicator.js';

function getBreadcrumbLabel(handle: unknown): string | null {
  if (typeof handle !== 'object' || handle === null || !('breadcrumbLabel' in handle)) return null;
  const { breadcrumbLabel } = handle as { breadcrumbLabel?: unknown };
  return typeof breadcrumbLabel === 'string' ? breadcrumbLabel : null;
}

function RouteBreadcrumbs() {
  const matchedRoute = [...useMatches()].reverse().find((match) => getBreadcrumbLabel(match.handle) !== null);
  const label = getBreadcrumbLabel(matchedRoute?.handle);
  if (label === null) return null;

  const id = matchedRoute?.params.id;
  const current = id === undefined ? label : `${label} ${id}`;

  return (
    <nav className="route-breadcrumbs" aria-label="Breadcrumb">
      <Link to="/">Dashboard</Link>
      <span aria-hidden="true">/</span>
      <span aria-current="page">{current}</span>
    </nav>
  );
}

/**
 * Представляет пользовательский экран AppShell; авторитетные проверки выполняются backend.
 */
function AppShell() {
  return (
    <div className="app-shell">
      <aside className="left-nav">
        <div className="brand"><span className="brand-mark" aria-hidden="true">E</span><div><strong>Ebb</strong><span>Orchestrator</span></div></div>
        <nav aria-label="Primary navigation">
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/projects">Projects</NavLink>
          <NavLink to="/approvals">Approvals</NavLink>
          <NavLink to="/execution">Execution</NavLink>
          <NavLink to="/usage">Usage</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="nav-status">
          <ConnectionIndicator />
          <NotificationIndicator count={0} />
        </div>
        <p className="nav-footnote">Local-first control plane</p>
      </aside>
      <main className="main-content">
        <RouteBreadcrumbs />
        <div className="route-outlet">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export default AppShell;
