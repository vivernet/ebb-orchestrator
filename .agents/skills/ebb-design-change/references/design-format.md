# Ebb design format

Минимальные секции для architectural design:

1. **Goal / Non-goals** — что меняется и что специально не меняется.
2. **Current state** — фактический существующий flow и ограничения.
3. **Decision** — выбранный подход и почему он подходит проекту.
4. **Boundaries & ownership** — какие компоненты владеют state, validation, side effects и lifecycle.
5. **Interfaces** — API/DTO/events/errors/config/schema; exact semantics для load-bearing seams.
6. **State & failure model** — transitions, transaction/rollback, concurrency/idempotency, restart/recovery.
7. **Security** — trust boundaries, authentication/authorization, secrets, path/process/network controls при применимости.
8. **Migration / compatibility** — upgrade path, backwards compatibility, data transition.
9. **Verification strategy** — unit/integration/E2E/security evidence, исходный symptom для bug-driven design.
10. **Open decisions** — только действительно нерешённые вопросы; каждый либо блокирует plan, либо явно non-blocking.
