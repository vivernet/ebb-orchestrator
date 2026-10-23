-- Провайдер-конфигурация и credentials (plan-24, Task 2).
--
-- Аддитивная forward-only миграция: не изменяет опубликованные таблицы 001–048
-- и сохраняет все существующие строки, индексы, FK/actions и историю миграций.
--
-- Инварианты:
--  * SQLite хранит только несекретные настройки, opaque references и
--    метаданные; значения секретов живут исключительно в OS SecretStore
--    (service 'ai-provider') и никогда не записываются в базу данных;
--  * конфигурация провайдера версионируется: снимок каждой ревизии
--    сохраняется в provider_config_snapshots и не мутируется после записи
--    (configRevision инкрементируется при изменении конфигурации, старые
--    ревизии остаются доступными);
--  * Run-selection snapshot (run_provider_selections) фиксирует точную
--    ревизию конфигурации до dispatch и потребляется Task 5 (immutable для Run).

CREATE TABLE provider_configurations (
  provider_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  selected_auth_method TEXT NOT NULL,
  -- Несекретные настройки (включая endpoint-поля там, где провайдер их поддерживает).
  config_json TEXT NOT NULL,
  -- Модельные предпочтения: {"defaultModelId": string|null, "roleDefaults": {role: modelId}}.
  model_selection_json TEXT NOT NULL,
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE provider_config_snapshots (
  provider_id TEXT NOT NULL REFERENCES provider_configurations(provider_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  selected_auth_method TEXT NOT NULL,
  config_json TEXT NOT NULL,
  model_selection_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, revision)
);

CREATE TABLE provider_credentials (
  provider_id TEXT NOT NULL REFERENCES provider_configurations(provider_id) ON DELETE CASCADE,
  auth_method_id TEXT NOT NULL,
  -- Стабильное opaque имя записи в SecretStore (service 'ai-provider'); не значение.
  secret_name TEXT NOT NULL,
  -- Opaque reference на метаданные секрета в таблице secrets (без plaintext).
  reference_id TEXT NOT NULL REFERENCES secrets(reference_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISCONNECTED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, auth_method_id)
);

CREATE INDEX idx_provider_credentials_secret_name ON provider_credentials(secret_name);

CREATE TABLE run_provider_selections (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  auth_method_id TEXT NOT NULL,
  config_revision INTEGER NOT NULL CHECK (config_revision >= 1),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_run_provider_selections_provider_revision
  ON run_provider_selections(provider_id, config_revision);
