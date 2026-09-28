# Ebb skill curation decision matrix

| Verdict | Когда использовать |
|---|---|
| `MERGE_PATTERN` | Candidate содержит устойчивый reusable pattern, но trigger/owner уже принадлежит существующему `ebb-*` |
| `NEW_EBB` | Есть отдельный повторяемый Ebb workflow, собственный trigger и независимая ответственность |
| `REPLACE_EBB` | Existing `ebb-*` имеет неверную boundary и новая форма полностью её заменяет |
| `REJECT` | One-off, stale, ошибочный, слишком узкий, дублирующий или не относится к Ebb workflow |
| `NEEDS_EVIDENCE` | Польза предполагается, но usage/pressure/application tests её не подтверждают |

## Mandatory questions

1. Какой конкретный task/symptom должен загружать capability?
2. Какой повторяемый failure mode она предотвращает?
3. Какой существующий `ebb-*` уже владеет этим trigger?
4. Можно ли встроить pattern в owner skill/reference вместо нового top-level skill?
5. Если capability обязательна Ebb workflow — где её собственная реализация внутри canonical set?
6. Как изменение влияет на discovery overlap и startup token footprint?
7. Может ли Codex и Hermes прочитать этот же repository file без host-specific копии?
8. Каким RED/application scenario доказана необходимость и каким GREEN scenario — результат?
