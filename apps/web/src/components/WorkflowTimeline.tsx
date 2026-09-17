interface WorkflowTimelineProps {
  stages: string[];
  currentStage?: string;
}

export const displayStageForLifecycle = (lifecycle: string): string | null => {
  const state = lifecycle.toUpperCase();
  if (state === 'DRAFT') return null;
  if (state === 'READY' || state === 'DEVELOPMENT') return 'DEV';
  if (state === 'WAITING_FOR_DEPENDENCY' || state === 'WAITING_FOR_APPROVAL' || state === 'PAUSED') return null;
  if (state === 'REVIEW') return 'REVIEW';
  if (state === 'QA') return 'QA';
  if (state === 'READY_FOR_INTEGRATION' || state === 'INTEGRATION' || state === 'INTEGRATED_INTO_EPIC') return 'INTEGRATION';
  if (state === 'READY_FOR_MERGE' || state === 'MERGING' || state === 'DONE' || state === 'RELEASED') return 'MERGE';
  return null;
};

export default function WorkflowTimeline({ stages, currentStage }: WorkflowTimelineProps) {
  const normalizedStage = currentStage ? displayStageForLifecycle(currentStage) ?? currentStage.toUpperCase() : undefined;
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
