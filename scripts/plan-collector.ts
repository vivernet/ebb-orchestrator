/**
 * План-коллектор для сбора метаданных планов из директории
 */

import { parsePlan, PlanMetadata } from './plan-parser.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Собирает метаданные всех планов из указанной директории
 * @param dir Путь к директории с планами
 * @returns Массив метаданных планов
 */
export function collectPlans(dir: string): PlanMetadata[] {
  // Проверяем существование директории
  if (!fs.existsSync(dir)) {
    return [];
  }

  const plans: PlanMetadata[] = [];
  
  // Читаем все файлы в директории
  const files = fs.readdirSync(dir);
  
  for (const file of files) {
    // Фильтруем только .md файлы
    if (!file.endsWith('.md')) {
      continue;
    }
    
    const filePath = path.join(dir, file);
    
    try {
      // Парсим план и добавляем в результат
      const plan = parsePlan(filePath);
      // Фильтруем только планы (kind: plan)
      if (plan.kind === 'plan') {
        plans.push(plan);
      }
    } catch (error) {
      // Игнорируем ошибки парсинга отдельных файлов
      console.warn(`Failed to parse plan file: ${filePath}`, error);
    }
  }

  return plans;
}

/**
 * Группирует планы по стадии (stage)
 * @param plans Массив метаданных планов
 * @returns Map, где ключ - stage, значение - массив планов этой стадии
 */
export function groupedByStage(plans: PlanMetadata[]): Map<string, PlanMetadata[]> {
  const grouped = new Map<string, PlanMetadata[]>();
  
  for (const plan of plans) {
    const stage = plan.stage || 'unknown';
    if (!grouped.has(stage)) {
      grouped.set(stage, []);
    }
    grouped.get(stage)!.push(plan);
  }
  
  return grouped;
}
