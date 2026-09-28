# Security-sensitive testing checklist

Применяй выборочно к затронутому контракту.

## Platform / process

- Раздели portable behavior и platform-specific assertions; OS-specific test не должен делать весь suite непереносимым.
- Для headless credential input предпочитай stdin/memory; не передавай raw secret через argv, command text, env, temp files или logs без утверждённой причины.
- PTY/ConPTY — optional capability, если тест не проверяет именно TTY semantics.
- При child process используй argv + `shell:false`, проверяй cwd/path containment и cleanup.

## Failure semantics

Различай:

- malformed/unsupported input;
- valid input + wrong secret/credential;
- runtime/native/IO operational failure.

Operational failure нельзя blanket-catch превращать в обычный auth mismatch.

## Exact verification

- Убедись, что targeted command выбрал нужные files/tests; запиши actual counts.
- Для encoded security value проверяй textual layout и decoded lengths/parameters/canonical round-trip.
- Не логируй secrets; проверяй stdout/stderr/fixtures на leakage.

## Concurrency / fakes

- Fakes должны отвергать как legacy sequence, так и повторный new operation, если contract требует ровно один side effect.
- Concurrency harness подтверждает unique readiness/release/acquisition/completion events; launch order не доказывает transaction order.
- Сравнивай полный durable snapshot before/after race, включая revoke/expiry/timestamps и related fields, а не одну финальную метку.
