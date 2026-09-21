import { Link, NavLink, Outlet, useLocation } from 'react-router';

function safeDecodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function RouteBreadcrumbs() {
  const { pathname } = useLocation();
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const section = segments[0] ?? '';
  const id = segments[1];
  const labels: Record<string, string> = {
    projects: 'Project', epics: 'Epic', tasks: 'Task', runs: 'Run',
    approvals: 'Approvals', execution: 'Execution', usage: 'Usage', settings: 'Settings',
  };
  const current = section === 'projects' && id === 'new'
    ? 'Project onboarding'
    : id ? `${labels[section] ?? section} ${safeDecodeSegment(id)}` : labels[section] ?? section;

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
          <NavLink to="/projects/new">Projects</NavLink>
          <NavLink to="/approvals">Approvals</NavLink>
          <NavLink to="/execution">Execution</NavLink>
          <NavLink to="/usage">Usage</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <p className="nav-footnote">Local-first control plane</p>
      </aside>
      <main className="main-content">
        <RouteBreadcrumbs />
        <Outlet />
      </main>
    </div>
  );
}

export default AppShell;
