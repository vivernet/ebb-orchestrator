interface WorkflowTimelineProps {
  stages: string[];
  currentStage?: string;
}

export default function WorkflowTimeline({ stages, currentStage }: WorkflowTimelineProps) {
  const normalizedStage = currentStage?.toUpperCase().replace('DEVELOPMENT', 'DEV');
  return (
    <div className="workflow-timeline" aria-label="Workflow timeline">
      <ol>
        {stages.map((stage, index) => {
          const isCurrent = stage === normalizedStage;
          const currentIndex = normalizedStage ? stages.indexOf(normalizedStage) : -1;
          const isPast = currentIndex >= 0 && index < currentIndex;

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
