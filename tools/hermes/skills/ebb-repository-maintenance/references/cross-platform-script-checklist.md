# Cross-platform Node/setup script checklist

Используй для repository tooling, setup/check wrappers и automation scripts.

- Предпочитай Node.js stdlib и ESM `.mjs`, если это соответствует repo convention; не вводи Bun/Deno dependency без необходимости.
- Resolve project root от `import.meta.url`/script location, а не от случайного `process.cwd()`.
- Используй `node:path`; сравниваемые paths нормализуй, учитывая Windows separators/drive letters и MSYS paths при реальной поддержке такого запуска.
- Child process: executable + argv array, `shell:false`; stdout/stderr/exit обрабатываются явно.
- Не читай/перезаписывай real repository `.env` в тесте. Используй `mkdtemp()` fixture и cleanup в `finally`.
- Тестируй launcher минимум из repository root и nested package cwd; проверяй env precedence, argument ordering и missing-file behavior.
- CRLF/LF не должен ломать parser/regex; normalise line endings или допускай `\r?\n`.
- Async file operations должны быть awaited до assertions/cleanup.
- Error path имеет детерминированный non-zero exit и сообщение без secrets/host-specific paths.
