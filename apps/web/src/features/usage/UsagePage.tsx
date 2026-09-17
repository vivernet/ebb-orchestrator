import { useEffect, useState } from 'react';
import { apiClient } from '../../api/client.js';

interface UsageLevel {
  tokens: number;
  cost: number;
}

interface UsageData {
  global: UsageLevel;
  project: UsageLevel;
  epic: UsageLevel;
  task: UsageLevel;
  effectiveLimit: 'global' | 'project' | 'epic' | 'task';
}

export default function UsagePage() {
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void apiClient.get<UsageData>('/usage')
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load usage data'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div>Loading usage data...</div>;
  }

  if (error || !data) {
    return <div>Error: {error ?? 'Data not available'}</div>;
  }

  const { global, project, epic, task, effectiveLimit } = data;

  return (
    <div className="usage-page">
      <h1>Usage & Budget</h1>

      <section aria-label="Usage hierarchy">
        <h2>Budget Hierarchy</h2>
        <p>Effective limit: {effectiveLimit}</p>

        <h3>Global</h3>
        <p>
          Tokens: {global.tokens} · Cost: ${global.cost.toFixed(2)}
        </p>

        <h3>Project</h3>
        <p>
          Tokens: {project.tokens} · Cost: ${project.cost.toFixed(2)}
        </p>

        <h3>Epic</h3>
        <p>
          Tokens: {epic.tokens} · Cost: ${epic.cost.toFixed(2)}
        </p>

        <h3>Task</h3>
        <p>
          Tokens: {task.tokens} · Cost: ${task.cost.toFixed(2)}
        </p>
      </section>

      <section aria-label="Usage details">
        <h2>Usage Details</h2>
        <p>
          Total tokens: {global.tokens} · Total cost: ${global.cost.toFixed(2)}
        </p>
      </section>
    </div>
  );
}
