/**
 * Генератор роадмапа из метаданных планов
 */

import { PlanMetadata } from './plan-parser.js';

/**
 * Информация о стадии с планом
 */
export interface Stage {
  id: string;
  plans: PlanMetadata[];
  done: number;
  total: number;
}

/**
 * Генерирует полный документ роадмапа из метаданных планов
 * @param plans Массив метаданных планов
 * @returns Markdown документ роадмапа
 */
export function generateRoadmap(plans: PlanMetadata[]): string {
  if (plans.length === 0) {
    return generateEmptyRoadmap();
  }

  const stages = groupIntoStages(plans);
  
  const sections = [
    '# Автоматический роадмап',
    '',
    generateIntroduction(plans),
    '',
    '## Stage Register',
    renderStageRegister(stages),
    '',
    '## Plan Register',
    renderPlanRegister(plans),
    '',
    '## Dependency Graph',
    renderDependencyGraph(plans),
  ];

  return sections.join('\n');
}

/**
 * Генерирует документ роадмапа для пустого списка планов
 */
function generateEmptyRoadmap(): string {
  return `# Автоматический роадмап

Нет доступных планов.

## Stage Register

Нет стадий.

## Plan Register

Нет планов.

## Dependency Graph

Нет зависимостей.
`;
}

/**
 * Генерирует вступление к роадмапу
 */
function generateIntroduction(plans: PlanMetadata[]): string {
  const total = plans.length;
  const done = plans.filter(p => p.status === 'done').length;
  const inProgress = plans.filter(p => p.status === 'in-progress').length;
  const proposed = plans.filter(p => p.status === 'proposed').length;

  return `Этот роадмап автоматически сгенерирован из метаданных планов.

| Статус | Количество |
|--------|------------|
| Всего | ${total} |
| Завершено | ${done} |
| В работе | ${inProgress} |
| Предложено | ${proposed} |
`;
}

/**
 * Группирует планы по стадиям
 */
function groupIntoStages(plans: PlanMetadata[]): Stage[] {
  const grouped = new Map<string, PlanMetadata[]>();

  for (const plan of plans) {
    const stage = String(plan.stage || 'unknown');
    if (!grouped.has(stage)) {
      grouped.set(stage, []);
    }
    grouped.get(stage)!.push(plan);
  }

  const stages: Stage[] = [];
  for (const [id, stagePlans] of grouped.entries()) {
    const done = stagePlans.filter(p => p.status === 'done').length;
    stages.push({
      id,
      plans: stagePlans,
      done,
      total: stagePlans.length,
    });
  }

  return stages.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Рендерит таблицу стадий
 */
export function renderStageRegister(stages: Stage[]): string {
  if (stages.length === 0) {
    return 'Нет стадий.';
  }

  const lines: string[] = [
    '| Stage | Total | Done | Progress |',
    '|-------|-------|------|----------|',
  ];

  for (const stage of stages) {
    const progress = stage.done === stage.total ? '100%' : `${Math.round((stage.done / stage.total) * 100)}%`;
    lines.push(`| ${stage.id} | ${stage.total} | ${stage.done} | ${progress} |`);
  }

  return lines.join('\n');
}

/**
 * Рендерит таблицу планов
 */
export function renderPlanRegister(plans: PlanMetadata[]): string {
  if (plans.length === 0) {
    return 'Нет планов.';
  }

  const lines: string[] = [
    '| ID | Stage | Status | Title |',
    '|----|-------|--------|-------|',
  ];

  for (const plan of plans) {
    lines.push(`| ${plan.id} | ${plan.stage} | ${plan.status} | ${plan.title} |`);
  }

  return lines.join('\n');
}

/**
 * Рендерит график зависимостей
 */
export function renderDependencyGraph(plans: PlanMetadata[]): string {
  const dependencies: string[] = [];

  for (const plan of plans) {
    if (plan.depends_on && plan.depends_on.length > 0) {
      for (const depId of plan.depends_on) {
        dependencies.push(`${plan.id} → ${depId}`);
      }
    }
  }

  if (dependencies.length === 0) {
    return 'No dependencies.';
  }

  return dependencies.join('\n');
}
