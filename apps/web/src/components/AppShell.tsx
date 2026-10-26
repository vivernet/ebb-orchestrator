import { Link, NavLink, Outlet, useLocation, useMatches } from 'react-router';
import { useCallback } from 'react';
import { apiPaths } from '@ebb-orchestrator/contracts';
import { getDashboard } from '../features/dashboard/api.js';
import { useQuery } from '../state/use-query.js';
import { toClientPath } from '../api/client.js';
import { ru } from '../i18n/ru.js';
import { ref } from '../i18n/ref.js';

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
    <nav className="route-breadcrumbs" aria-label={ru.common.breadcrumb}>
      <Link to="/">{ru.common.dashboard}</Link>
      <span aria-hidden="true">/</span>
      <span aria-current="page">{current}</span>
    </nav>
  );
}

/**
 * Пункт навигации «Эпики и задачи» активен для маршрутов эпиков и задач.
 */
function EpicTasksNavLink() {
  const { pathname } = useLocation();
  const active = /^\/(epics|tasks)(\/|$)/.test(pathname);
  return (
    <NavLink to="/projects" className={active ? 'active' : ''} data-epic-tasks-nav>
      {ref.nav.epicsAndTasks}
    </NavLink>
  );
}

/**
 * Представляет пользовательский экран AppShell; авторитетные проверки выполняются backend.
 * Боковая панель повторяет структуру reference-ui: бренд, пункты навигации,
 * счётчик ожидающих согласований и нижняя подпись среды.
 */
function AppShell() {
  const dashboardPath = toClientPath(apiPaths.dashboard);
  const approvalsFetcher = useCallback((_signal: AbortSignal) => getDashboard(), []);
  const approvalsQuery = useQuery(null, dashboardPath, undefined, approvalsFetcher);
  const pendingApprovals = approvalsQuery.status === 'success' && typeof approvalsQuery.data?.approvals === 'number'
    ? approvalsQuery.data.approvals
    : null;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">{ru.common.skipToContent}</a>
      <aside className="left-nav">
        <div className="brand">
          <div>
            <strong>{ref.nav.brand}</strong>
            <span>{ref.nav.brandSub}</span>
          </div>
        </div>
        <nav aria-label={ru.common.primaryNavigation}>
          <NavLink to="/" end>{ref.nav.dashboard}</NavLink>
          <NavLink to="/projects">{ref.nav.projects}</NavLink>
          <EpicTasksNavLink />
          <NavLink to="/execution">{ref.nav.execution}</NavLink>
          <NavLink to="/approvals">
            {ref.nav.approvals}
            {pendingApprovals !== null && pendingApprovals > 0 && <span className="warn">{pendingApprovals}</span>}
          </NavLink>
          <a href="#">{ref.nav.agents}</a>
          <NavLink to="/usage">{ref.nav.usage}</NavLink>
          <NavLink to="/settings">{ref.nav.settings}</NavLink>
        </nav>
        <div className="nav-footnote ref-sidebar-bottom">
          {ref.nav.runtime}
          <br />
          {ref.nav.slots}
        </div>
      </aside>
      <main id="main-content" className="main-content">
        <RouteBreadcrumbs />
        <div className="route-outlet">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export default AppShell;
