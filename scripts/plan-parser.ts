import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';

export interface PlanMetadata {
  id: string;
  kind: string;
  roadmap: string | number;
  stage: string | number;
  status: string;
  title: string;
  created: string;
  updated: string;
  depends_on: string[];
  specs: string[];
  evidence: string[];
}

export function parsePlan(path: string): PlanMetadata {
  const content = readFileSync(path, 'utf-8');
  const delimiter = '---';
  const parts = content.split(delimiter);
  
  if (parts.length < 3) {
    throw new Error(`Файл ${path} не содержит valid YAML frontmatter`);
  }
  
  try {
    const yamlContent = parts[1].trim();
    const metadata = yaml.load(yamlContent) as PlanMetadata;
    
    if (!metadata.id || !metadata.kind || !metadata.roadmap) {
      throw new Error(`План в ${path} не содержит обязательные поля`);
    }
    
    return metadata;
  } catch (e) {
    const err = new Error(`Ошибка парсинга YAML из ${path}: ${(e as Error).message}`);
    (err as Error & { cause?: unknown }).cause = e;
    throw err;
  }
}
