-- Явная привязка провайдера/auth-метода в интенте Scheduler RunRequest (plan-24, Task 5).
--
-- Аддитивная forward-only миграция: не изменяет опубликованные таблицы 001–049
-- и сохраняет все существующие строки, индексы, FK/actions и историю миграций.
--
-- Инварианты:
--  * столбцы provider_id/auth_method_id опциональны (NULL) — legacy-интенты
--    без явного выбора провайдера остаются валидными;
--  * значения несекретны: только идентификаторы конфигурации, никаких
--    credentials/endpoint URL;
--  * итоговая привязка Run фиксируется в run_provider_selections (049) в той же
--    транзакции, что и создание Run; эти столбцы — source-backed intent до dispatch.
ALTER TABLE scheduler_run_requests ADD COLUMN provider_id TEXT;
ALTER TABLE scheduler_run_requests ADD COLUMN auth_method_id TEXT;

CREATE INDEX idx_scheduler_run_requests_provider
  ON scheduler_run_requests(provider_id);
