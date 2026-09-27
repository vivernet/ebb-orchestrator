export type { PlanMetadata } from './plan-parser.js';
import type { PlanMetadata } from './plan-parser.js';

function selectPlans(plans: PlanMetadata[]): PlanMetadata[] {
  return plans.filter((plan) => plan.kind === 'plan');
}

/** Генерирует Plan-реестр и граф зависимостей без второй группировки.
 * @param plans Проверенные Plans.
 * @returns Markdown-представление Plan metadata.
 */
export function generateRoadmap(plans: PlanMetadata[]): string {
  const planRecords = selectPlans(plans);
  return ['# Автоматический роадмап', '', planRecords.length ? '## Plan Register' : 'Нет доступных планов.', '', renderPlanRegister(planRecords), '', '## Dependency Graph', '', renderDependencyGraph(planRecords)].join('\n');
}

/**
 * Формирует таблицу Plan с исходными идентификаторами, статусами и названиями.
 * @param plans Проверенные Plans в требуемом порядке.
 * @returns Markdown-таблица Plan Register без дополнительной группировки.
 */
export function renderPlanRegister(plans: PlanMetadata[]): string {
  return ['| ID | Status | Title |', '|----|--------|-------|', ...selectPlans(plans).map((plan) => `| ${plan.id} | ${plan.status} | ${plan.title} |`)].join('\n');
}

/**
 * Строит ориентированные рёбра от зависимости к зависящему от неё Plan.
 * @param plans Проверенные Plans с необязательными массивами `depends_on`.
 * @returns Строки графа зависимостей либо сообщение об отсутствии рёбер.
 */
export function renderDependencyGraph(plans: PlanMetadata[]): string {
  const dependencies = selectPlans(plans).flatMap((plan) => (plan.depends_on ?? []).map((dependency) => `${dependency} → ${plan.id}`));
  return dependencies.length ? dependencies.join('\n') : 'No dependencies.';
}
