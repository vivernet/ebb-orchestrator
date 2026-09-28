# Ebb test-first protocol

## RED

- Один test = одно observable behavior.
- Test должен упражнять реальный production path; mock допустим только если boundary иначе недоступен.
- Запусти test до production change и прочитай failure. Если он уже PASS — test не доказывает новое поведение.

## GREEN

- Сделай наименьшее изменение, которое удовлетворяет contract.
- Не расширяй public API, config, abstractions или dependencies без требования.
- Запусти тот же test и убедись в PASS.

## REFACTOR

- Только после GREEN удаляй duplication/улучшай names/structure.
- После refactor снова запусти focused test и neighboring suite.

## Regression-proof

Для критичной регрессии при возможности докажи causal test: green с fix → временно revert/load old behavior → test снова RED → restore → GREEN. Не делай destructive history operation ради этого; используй безопасный локальный probe.

## Exceptions

Pure docs/generated configuration может не иметь классического failing unit test. Тогда RED заменяется проверяемым precondition/validator failure, а GREEN — тем же validator после изменения. Исключение должно быть записано в task evidence, а не подразумеваться.
