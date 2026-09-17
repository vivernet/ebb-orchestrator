interface WorkflowTimelineProps {
  stages: string[];
  currentStage?: string;
}

export default function WorkflowTimeline({ stages, currentStage }: WorkflowTimelineProps) {
  return (
    <div className="workflow-timeline" aria-label="Workflow timeline">
      <ol>
        {stages.map((stage, index) => {
          const isCurrent = stage === currentStage;
          const isPast = currentStage ? stages.indexOf(stage) < stages.indexOf(currentStage) : false;

          return (
            <li key={stage} style={isPast ? { color: '#888' } : isCurrent ? { color: '#fff', fontWeight: '600' } : { color: '#a0a0a0' }}>
              {stage}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
