import { ru } from '../../i18n/ru.js';

/**
 * Локализованные причины недоступности контрактной панели/поля.
 * Ключи — wire-значения availability.reason (или канонические коды отсутствия
 * авторитетного источника); отображение никогда не выдумывает данные.
 */
const REASON_LABELS: Record<string, string> = {
  NOT_RECORDED: 'записи не создавались',
  NO_APPROVED_POLICY: 'нет одобренной evidence-backed политики классификации',
  NO_SANITIZED_PERSISTED_SOURCE: 'нет безопасного persisted-источника',
  NO_DURABLE_CHECK_EXECUTION_SOURCE: 'нет durable источника выполнения проверок',
  LEGACY_PROVENANCE_UNAVAILABLE: 'provenance недоступна для legacy-записей',
  NO_AUTHORITATIVE_SOURCE: 'авторитетный источник не подключён',
  UI_NOT_IMPLEMENTED: 'панель не реализована в этой версии интерфейса',
  RELATIVE_TIME: 'относительное время не фиксируется в фикстурe',
  PROJECT_CONFIG_NOT_ACTIVE: 'конфигурация проекта не активирована',
  CYCLE_METRICS_UNAVAILABLE: 'метрики цикла отсутствуют в проекции',
  GRAPH_PROJECTION_UNAVAILABLE: 'граф-проекция отсутствует в проекции',
  BUDGET_PROJECTION_UNAVAILABLE: 'бюджет-проекция отсутствует',
  CHAT_PROJECTION_UNAVAILABLE: 'координатор-чат недоступен для данной проекции',
  STAGES_PROJECTION_UNAVAILABLE: 'проекция этапов отсутствует',
  PROGRESS_PROJECTION_UNAVAILABLE: 'проекция прогресса отсутствует',
  CAPACITY_PROJECTION_UNAVAILABLE: 'проекция ёмкости отсутствует',
  SPEND_PROJECTION_UNAVAILABLE: 'проекция расходов за период отсутствует',
  APPROVALS_LIST_PROJECTION_UNAVAILABLE: 'список согласований в проекции отсутствует',
  AGENT_POOL_PROJECTION_UNAVAILABLE: 'проекция пула агентов отсутствует',
  ACCEPTANCE_PROJECTION_UNAVAILABLE: 'критерии приёмки отсутствуют в проекции',
  GIT_PROJECTION_UNAVAILABLE: 'Git-проекция отсутствует',
  FINDINGS_PROJECTION_UNAVAILABLE: 'проекция findings/defects отсутствует',
  RECOVERY_PROJECTION_UNAVAILABLE: 'проекция восстановления отсутствует',
  DEPENDENCY_GRAPH_PROJECTION_UNAVAILABLE: 'dependency-граф отсутствует в проекции',
  TASK_USAGE_PROJECTION_UNAVAILABLE: 'разбивка использования по фазам отсутствует',
  PERMISSIONS_PROJECTION_UNAVAILABLE: 'проекция разрешений отсутствует',
  TOOLING_PROJECTION_UNAVAILABLE: 'проекция инструментов отсутствует',
  TERMINAL_PROJECTION_UNAVAILABLE: 'санитизированный поток терминала отсутствует',
  IMPACT_PROJECTION_UNAVAILABLE: 'оценка влияния отсутствует',
  EVIDENCE_PROJECTION_UNAVAILABLE: 'evidence-проекция отсутствует',
  DECISION_PROJECTION_UNAVAILABLE: 'проекция решения отсутствует',
  RESOURCE_LOCKS_PROJECTION_UNAVAILABLE: 'проекция блокировок ресурсов отсутствует',
};

/** Локализует wire-код причины; неизвестный код — безопасный fallback. */
export function unsupportedReasonLabel(reason: string | null | undefined): string {
  if (!reason) return ru.unavailable.reasonDefault;
  return REASON_LABELS[reason] ?? ru.unavailable.reasonDefault;
}

interface UnsupportedBlockProps {
  /** wire-код причины (например 'NO_APPROVED_POLICY'). */
  reason?: string | null;
  /** Заголовок блока; по умолчанию локализованная подпись «Недоступно». */
  label?: string;
  className?: string;
}

/**
 * Контрактный блок «недоступно»: рендерится вместо отсутствующей панели/поля,
 * занимая место в макете (детерминированно) и локализуя причину. Никогда не
 * создаёт fallback-данные.
 */
export default function UnsupportedBlock({ reason, label, className = '' }: UnsupportedBlockProps) {
  return (
    <div className={`reference-unsupported${className ? ` ${className}` : ''}`}>
      <span className="reference-unsupported-label">{label ?? ru.unavailable.title}</span>
      <span className="reference-unsupported-reason">{unsupportedReasonLabel(reason)}</span>
    </div>
  );
}
