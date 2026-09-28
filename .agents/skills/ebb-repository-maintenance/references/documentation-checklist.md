# Documentation and localization maintenance checklist

- Сначала inventory actual target files; plan filename и прошлый commit не определяют текущий scope.
- Сохраняй code fences, commands, paths, URLs, package/API names, identifiers, enum/state literals и machine-readable metadata, если их изменение не является целью.
- Перевод human-facing prose не должен скрыто менять архитектуру или исправлять факты догадками.
- Для параллельной работы давай агентам непересекающиеся file sets; shared indexes/terminology имеют одного owner.
- После изменения проверь Markdown/HTML structure, links, old-path references, `git diff --check` и changed-file inventory.
- JSDoc/lint может доказать структуру комментария, но не качество русского текста или semantic truth; нужен content review.
- При rename документационного каталога сначала обнови все repository references, затем удаляй старый path.
