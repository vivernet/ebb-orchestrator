import { Outlet, NavLink } from 'react-router';

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
function AppShell() {
  return (
    <div className="app-shell">
      <nav className="left-nav" aria-label="left nav">
        <NavLink to="/">Dashboard</NavLink>
        <NavLink to="/projects/new">Projects</NavLink>
        <NavLink to="/approvals">Approvals</NavLink>
        <NavLink to="/execution">Execution</NavLink>
        <NavLink to="/usage">Usage</NavLink>
        <NavLink to="/settings">Settings</NavLink>
      </nav>
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}

export default AppShell;
