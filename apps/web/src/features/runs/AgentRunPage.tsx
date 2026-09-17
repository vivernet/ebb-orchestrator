import { useEffect, useState } from 'react';
import { apiClient } from '../../api/client.js';
import SanitizedTerminal from '../../components/SanitizedTerminal.js';

interface AgentRun {
  id: string;
  role: string;
  model: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'pausing';
  triggerReason: string;
  taskId?: string;
  epicId?: string;
  startTime: string;
  endTime?: string;
}

interface UsageRecord {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
}

interface ContextManifest {
  taskContractVersion?: string;
  guidelines: string[];
  decisions: string[];
  findings: string[];
  contextBuilderVersion: string;
  initialTokenSize: number;
}

interface RecoverySignal {
  type: 'resume' | 'retry' | 'escalate' | 'diagnosis';
  fromRunId?: string;
  reason: string;
}

interface Artifact {
  id: string;
  name: string;
  path: string;
  type: 'log' | 'diff' | 'result' | 'other';
}

interface AgentRunPageProps {
  id: string;
}

export default function AgentRunPage({ id }: AgentRunPageProps) {
  const [run, setRun] = useState<AgentRun | null>(null);
  const [usage, setUsage] = useState<UsageRecord | null>(null);
  const [contextManifest, setContextManifest] = useState<ContextManifest | null>(null);
  const [recoverySignals, setRecoverySignals] = useState<RecoverySignal[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [permissions, setPermissions] = useState<string[]>([]);

  useEffect(() => {
    setLoading(true);
    const fetchRunDetails = async () => {
      try {
        const [runData, usageData, contextData, recoveryData, artifactsData, logsData] = await Promise.all([
          apiClient.get<AgentRun>(`/runs/${encodeURIComponent(id)}`),
          apiClient.get<UsageRecord>(`/runs/${encodeURIComponent(id)}/usage`),
          apiClient.get<ContextManifest>(`/runs/${encodeURIComponent(id)}/context`),
          apiClient.get<RecoverySignal[]>(`/runs/${encodeURIComponent(id)}/recovery`),
          apiClient.get<Artifact[]>(`/runs/${encodeURIComponent(id)}/artifacts`),
          apiClient.get<string[]>(`/runs/${encodeURIComponent(id)}/logs`),
        ]);
        setRun(runData);
        setUsage(usageData);
        setContextManifest(contextData);
        setRecoverySignals(recoveryData);
        setArtifacts(artifactsData);
        setTerminalLogs(logsData);

        const permissionResponse = await apiClient.get<string[]>(`/runs/${encodeURIComponent(id)}/permissions`);
        setPermissions(permissionResponse);
      } catch (e) {
        console.error('Failed to fetch run details:', e);
      } finally {
        setLoading(false);
      }
    };
    void fetchRunDetails();
  }, [id]);

  const handleCancel = async () => {
    try {
      await apiClient.post(`/runs/${encodeURIComponent(id)}/cancel`, {});
      setRun((prev) => (prev ? { ...prev, status: 'pausing' } : null));
    } catch (e) {
      console.error('Failed to cancel run:', e);
    }
  };

  if (loading) {
    return <div>Loading run details...</div>;
  }

  if (!run) {
    return <div>Run not found.</div>;
  }

  return (
    <div className="agent-run-page">
      <header className="run-header">
        <h1>Agent Run: {run.id}</h1>
        <div className="run-meta">
          <span className="run-role">{run.role}</span>
          <span className="run-model">{run.model}</span>
          <span className={`run-status status-${run.status}`}>{run.status.toUpperCase()}</span>
        </div>
      </header>

      <section className="run-triggers">
        <h2>Trigger</h2>
        <p>{run.triggerReason}</p>
      </section>

      {run.taskId && (
        <section className="run-context">
          <h2>Context</h2>
          <p>Task: {run.taskId}</p>
          {run.epicId && <p>Epic: {run.epicId}</p>}
        </section>
      )}

      {contextManifest && (
        <section className="context-manifest">
          <h2>Context Manifest</h2>
          <div className="manifest-content">
            <p><strong>Context Builder:</strong> {contextManifest.contextBuilderVersion}</p>
            <p><strong>Initial Token Size:</strong> {contextManifest.initialTokenSize}</p>
            <div className="manifest-section">
              <strong>Guidelines:</strong>
              <ul>
                {contextManifest.guidelines.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </div>
            <div className="manifest-section">
              <strong>Decisions:</strong>
              <ul>
                {contextManifest.decisions.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
            <div className="manifest-section">
              <strong>Findings:</strong>
              <ul>
                {contextManifest.findings.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}

      <section className="run-permissions">
        <h2>Permissions</h2>
        <ul>
          {permissions.map((perm) => (
            <li key={perm}>{perm}</li>
          ))}
        </ul>
      </section>

      {usage && (
        <section className="run-usage">
          <h2>Usage</h2>
          <div className="usage-stats">
            <div className="usage-item">
              <span>Input Tokens:</span>
              <span>{usage.inputTokens}</span>
            </div>
            <div className="usage-item">
              <span>Cached Tokens:</span>
              <span>{usage.cachedTokens}</span>
            </div>
            <div className="usage-item">
              <span>Output Tokens:</span>
              <span>{usage.outputTokens}</span>
            </div>
            <div className="usage-item">
              <span>Total Tokens:</span>
              <span>{usage.totalTokens}</span>
            </div>
            <div className="usage-item">
              <span>Cost:</span>
              <span>${usage.cost.toFixed(4)}</span>
            </div>
          </div>
        </section>
      )}

      {recoverySignals.length > 0 && (
        <section className="run-recovery">
          <h2>Recovery Signals</h2>
          <ul>
            {recoverySignals.map((signal, idx) => (
              <li key={idx}>
                <strong>{signal.type.toUpperCase()}</strong>: {signal.reason}
                {signal.fromRunId && <span> (from {signal.fromRunId})</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {artifacts.length > 0 && (
        <section className="run-artifacts">
          <h2>Artifacts</h2>
          <ul>
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                <span className="artifact-type">{artifact.type}</span>: {artifact.name}
                <span className="artifact-path"> ({artifact.path})</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {terminalLogs.length > 0 && (
        <section className="run-terminal">
          <h2>Terminal Output</h2>
          <SanitizedTerminal logs={terminalLogs} />
        </section>
      )}

      {run.status === 'running' && (
        <footer className="run-actions">
          <button onClick={handleCancel}>Cancel Run</button>
        </footer>
      )}
    </div>
  );
}
