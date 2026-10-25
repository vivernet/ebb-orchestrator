-- Durable scheduler dispatch controls (plan-27 Task 2).
--
-- Аддитивная forward-only миграция: не перестраивает таблицы, добавляет
-- глобальную паузу диспетчеризации в scheduler_config и таблицу scoped-пауз
-- scheduler_scope_pauses для проектов и эпиков.
--
-- Инварианты:
--  * dispatch_paused ∈ {0,1}, дефолт 0 (dispatch активен);
--  * dispatch_paused_at — UTC ISO инстант последнего изменения dispatch-состояния;
--  * scope ∈ ('PROJECT','EPIC'); один (scope, scope_id) — одна пауза;
--  * пауза блокирует только НОВЫЕ reservation; текущие Run не отменяются.

ALTER TABLE scheduler_config ADD COLUMN dispatch_paused INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_paused IN (0,1));
ALTER TABLE scheduler_config ADD COLUMN dispatch_paused_at TEXT;

CREATE TABLE scheduler_scope_pauses (
  scope TEXT NOT NULL CHECK (scope IN ('PROJECT','EPIC')),
  scope_id TEXT NOT NULL,
  paused_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id)
);
