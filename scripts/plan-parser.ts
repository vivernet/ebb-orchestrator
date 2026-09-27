import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';

/** Допустимое состояние жизненного цикла Plan. */
export type PlanStatus = 'proposed' | 'planned' | 'in_progress' | 'blocked' | 'completed' | 'superseded' | 'cancelled';

/** Проверенные метаданные Plan; прочие ключи YAML не входят в контракт. */
export interface PlanMetadata {
  id: string;
  kind: 'plan';
  status: PlanStatus;
  title: string;
  created: string;
  updated: string;
  summary?: string;
  depends_on?: string[];
  specs?: string[];
  evidence?: string[];
}

const statuses = new Set<PlanStatus>(['proposed', 'planned', 'in_progress', 'blocked', 'completed', 'superseded', 'cancelled']);
const requiredFields = ['id', 'kind', 'status', 'title', 'created', 'updated'] as const;
const optionalArrayFields = ['depends_on', 'specs', 'evidence'] as const;
const allowedFields = new Set<string>([...requiredFields, 'summary', ...optionalArrayFields]);

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Читает YAML frontmatter и возвращает только метаданные Plan, соответствующие контракту.
 * Неизвестные поля отклоняются; поля второго измерения группировки не входят в контракт.
 * @param path Путь к Markdown-файлу плана.
 */
export function parsePlan(path: string): PlanMetadata {
  const content = readFileSync(path, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`Файл ${path} не содержит valid YAML frontmatter`);
  const raw: unknown = yaml.load(match[1]);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Метаданные плана в ${path} должны быть объектом`);
  const data = raw as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    if (!allowedFields.has(key)) throw new Error(`Неизвестное поле frontmatter "${key}" в плане ${path}`);
  }
  for (const key of requiredFields) if (!(key in data)) throw new Error(`План в ${path} не содержит обязательное поле ${key}`);
  for (const key of ['id', 'title'] as const) if (typeof data[key] !== 'string') throw new Error(`Поле ${key} в ${path} должно быть строкой`);
  if (data.kind !== 'plan') throw new Error(`Поле kind в ${path} должно быть 'plan'`);
  if (typeof data.status !== 'string' || !statuses.has(data.status as PlanStatus)) throw new Error(`Недопустимый статус Plan в ${path}`);
  for (const key of ['created', 'updated'] as const) if (!isCalendarDate(data[key])) throw new Error(`Поле ${key} в ${path} должно быть корректной датой YYYY-MM-DD`);
  if ('summary' in data && typeof data.summary !== 'string') throw new Error(`Поле summary в ${path} должно быть строкой`);
  for (const key of optionalArrayFields) {
    if (key in data && (!Array.isArray(data[key]) || !(data[key] as unknown[]).every((item) => typeof item === 'string'))) {
      throw new Error(`Поле ${key} в ${path} должно быть массивом строк`);
    }
  }
  const result: PlanMetadata = {
    id: data.id as string, kind: 'plan', status: data.status as PlanStatus, title: data.title as string,
    created: data.created as string, updated: data.updated as string,
  };
  if ('summary' in data) result.summary = data.summary as string;
  for (const key of optionalArrayFields) if (key in data) result[key] = data[key] as string[];
  return result;
}
