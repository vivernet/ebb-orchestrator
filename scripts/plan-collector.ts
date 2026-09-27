import { parsePlan, type PlanMetadata } from './plan-parser.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Собирает корректные Plan из непосредственных Markdown-файлов директории.
 * Идентификаторы и массивы зависимостей сохраняются без преобразования; порядок соответствует чтению файлов.
 * @param dir Путь к директории с планами.
 */
export function collectPlans(dir: string): PlanMetadata[] {
  if (!fs.existsSync(dir)) return [];
  const plans: PlanMetadata[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(dir, file);
    try {
      plans.push(parsePlan(filePath));
    } catch (error) {
      console.warn(`Failed to parse plan file: ${filePath}`, error);
    }
  }
  return plans;
}