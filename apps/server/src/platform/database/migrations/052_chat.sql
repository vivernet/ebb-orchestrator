-- Постоянная история чата с координатором (дизайн-контракт, план 25).
--
-- Аддитивная forward-only миграция: не изменяет опубликованные таблицы 001–051
-- и сохраняет все существующие строки, индексы, FK/actions и историю миграций.
--
-- Инварианты:
--  * conversation_id → project_id: чат всегда принадлежит проекту;
--  * role ∈ ('user','coordinator','system'), kind ∈ ('text','status_update',
--    'need_input','approval_request','approval_result','error');
--  * request_id → planning_requests(id), plan_id → planning_plans(id):
--    связь сообщения с контрактом планирования (nullable);
--  * статус планирования (status) зеркалит PlanningRequestStatus и ограничен
--    CHECK-списком тех же значений (plan-25 Task 2 Interfaces).

CREATE TABLE chat_conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
  role TEXT NOT NULL
    CHECK (role IN ('user','coordinator','system')),
  kind TEXT NOT NULL
    CHECK (kind IN ('text','status_update','need_input','approval_request','approval_result','error')),
  content TEXT NOT NULL,
  request_id TEXT REFERENCES planning_requests(id),
  plan_id TEXT REFERENCES planning_plans(id),
  status TEXT
    CHECK (status IS NULL OR status IN ('RECEIVED','PLANNING','NEEDS_INPUT',
      'PLAN_PENDING_APPROVAL','MATERIALIZED','REJECTED','FAILED')),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_chat_messages_conv
  ON chat_messages(conversation_id, created_at);
