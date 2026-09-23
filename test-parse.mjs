
import { readFileSync } from 'fs';

const content = readFileSync('docs/architecture/plans/01-foundation-persistence.md', 'utf8');

// Найти позицию закрывающего ---
const idx = content.indexOf('---', content.indexOf('id: plan-01'));
console.log('Position of closing ---:', idx);
console.log('Chars at position:', JSON.stringify(content.substring(idx - 5, idx + 10)));
console.log('Char before ---:', content[idx - 1]);
console.log('Char after ---:', content[idx + 3]);
