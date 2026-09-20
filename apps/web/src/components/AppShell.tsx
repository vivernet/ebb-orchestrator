import { Outlet, NavLink } from 'react-router';

/**
 * Представляет пользовательский экран AppShell; авторитетные проверки выполняются backend.
 */
function AppShell() {
  return (
    <div className="app-shell">
      <aside className="left-nav">
        <div className="brand"><span className="brand-mark" aria-hidden="true">E</span><div><strong>Ebb</strong><span>Orchestrator</span></div></div>
        <nav aria-label="Primary navigation">
          <NavLink to="/">Dashboard</NavLink>
          <NavLink to="/projects/new">Projects</NavLink>
          <NavLink to="/approvals">Approvals</NavLink>
          <NavLink to="/execution">Execution</NavLink>
          <NavLink to="/usage">Usage</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <p className="nav-footnote">Local-first control plane</p>
      </aside>
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}

export default AppShell;
