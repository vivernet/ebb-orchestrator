-- Пользовательские модели провайдеров (plan-24, Task 6).
--
-- Аддитивная forward-only миграция: не изменяет опубликованные таблицы 001–050
-- и сохраняет все существующие строки, индексы, FK/actions и историю миграций.
--
-- Инварианты:
--  * хранятся только идентификаторы/имена моделей — никаких секретов и
--    endpoint URL;
--  * model_id уникален в рамках провайдера (PK); валидация формата и
--    привязка к каталогу выполняются прикладным кодом (fail-closed);
--  * FK на provider_configurations нет: пользовательские модели могут быть
--    добавлены и до создания конфигурации провайдера.

CREATE TABLE provider_custom_models (
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, model_id)
);

CREATE INDEX idx_provider_custom_models_provider
  ON provider_custom_models(provider_id);
