interface WorkflowTimelineProps {
  stages: string[];
  currentStage?: string;
}

export const TASK_LIFECYCLE_STAGES = [
  'DRAFT', 'READY', 'DEVELOPMENT', 'REVIEW', 'QA',
  'READY_FOR_INTEGRATION', 'INTEGRATION', 'INTEGRATED_INTO_EPIC',
  'READY_FOR_MERGE', 'MERGING', 'DONE', 'RELEASED',
  'WAITING_FOR_DEPENDENCY', 'WAITING_FOR_APPROVAL', 'BLOCKED', 'PAUSED', 'FAILED', 'CANCELLED',
];

const EXCEPTIONAL_LIFECYCLE_STAGES = new Set([
  'WAITING_FOR_DEPENDENCY', 'WAITING_FOR_APPROVAL', 'BLOCKED', 'PAUSED', 'FAILED', 'CANCELLED',
]);

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
  const rawStage = currentStage?.toUpperCase();
  const normalizedStage = rawStage && stages.includes(rawStage)
    ? rawStage
    : currentStage ? displayStageForLifecycle(currentStage) ?? rawStage : undefined;
  const statusOnly = normalizedStage && !stages.includes(normalizedStage);
  const currentIndex = normalizedStage && !EXCEPTIONAL_LIFECYCLE_STAGES.has(normalizedStage)
    ? stages.indexOf(normalizedStage)
    : -1;
  return (
    <div className="workflow-timeline" aria-label="Workflow timeline">
      <ol>
        {stages.map((stage, index) => {
          const isCurrent = stage === normalizedStage;
          const isPast = currentIndex >= 0 && index < currentIndex;

          return (
            <li key={stage} style={isPast ? { color: '#888' } : isCurrent ? { color: '#fff', fontWeight: '600' } : { color: '#a0a0a0' }}>
              {stage}
            </li>
          );
        })}
        {statusOnly && <li style={{ color: '#fff', fontWeight: '600' }}>{currentStage!.toUpperCase()}</li>}
      </ol>
    </div>
  );
}
