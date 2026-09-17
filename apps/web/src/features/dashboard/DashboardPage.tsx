export default function DashboardPage() {
  return (
    <div className="dashboard-page">
      <h1>Dashboard</h1>
      <section aria-label="Running agents">
        <h2>Running agents</h2>
        <p>Active agent runs are displayed here.</p>
      </section>
      <section aria-label="Active work">
        <h2>Active work</h2>
        <p>Current work items and their status.</p>
      </section>
      <section aria-label="Need approval">
        <h2>Need approval</h2>
        <p>Pending approvals requiring user action.</p>
      </section>
      <section aria-label="AI spend">
        <h2>AI spend</h2>
        <p>Usage and budget tracking.</p>
      </section>
      <section aria-label="Active projects">
        <h2>Active projects</h2>
        <p>List of active projects.</p>
      </section>
      <section aria-label="Queue">
        <h2>Queue</h2>
        <p>Queued tasks and dependencies.</p>
      </section>
      <section aria-label="Coordinator">
        <h2>Coordinator</h2>
        <p>Coordinator actions and status.</p>
      </section>
    </div>
  );
}
