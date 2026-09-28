# UI localization and accessibility checklist

Используй только когда изменение затрагивает user-facing copy/localization/accessibility.

- Классифицируй строку до перевода: visible UI copy можно локализовать; protocol codes, API values, routes, commands, selectors и adversarial fixtures сохраняют canonical value.
- Не выводи arbitrary server `message`/`reason` в DOM без утверждённого safe formatter; known codes маппятся на локализованный текст, unknown values получают безопасный fallback.
- Сохраняй semantic elements, labels, accessible names, error association, live regions и focus behavior.
- Меняй test expectations только для намеренно локализованного UI; API assertions продолжают проверять исходные protocol values.
- Security/adversarial payload остаётся неизменным и проверяется на отсутствие leakage.
- Сверь полный production UI inventory и найди untranslated visible strings; один resource test не доказывает полную локализацию.
