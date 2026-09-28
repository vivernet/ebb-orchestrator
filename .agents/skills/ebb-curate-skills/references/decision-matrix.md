# Skill curation decision matrix

| Verdict | Когда использовать |
|---|---|
| `KEEP_EXTERNAL` | Общая техника уже качественно покрыта Superpowers/runtime skill и Ebb-specific delta минимален |
| `MERGE` | Candidate содержит устойчивый project-specific pattern, но отдельный trigger совпадает с существующим ebb-* |
| `NEW_EBB` | Есть отдельный повторяемый Ebb workflow, собственный trigger и независимая ответственность |
| `REPLACE` | Existing ebb-* имеет неверную границу ответственности; новая форма полностью заменяет его |
| `REJECT` | One-off, stale, ошибочный, слишком узкий или дублирующий pattern |
| `NEEDS_EVIDENCE` | Польза предполагается, но usage/pressure scenarios не подтверждают её |

## Review questions

1. Какой пользовательский/task trigger должен загрузить skill?
2. Почему generic Superpowers/runtime skill недостаточен?
3. Какой Ebb-specific invariant или workflow он добавляет?
4. Есть ли существующий ebb-* с тем же trigger?
5. Можно ли вынести редкую деталь в reference вместо нового skill?
6. Сколько startup description/context добавляет решение?
7. Работает ли структура в `.agents/skills` для Codex и Hermes без host-specific копии?
8. Есть ли evidence, что skill предотвращает реальный повторяемый failure mode?
