-- Доводит agent_runs до схемы, необходимой runtime.
ALTER TABLE agent_runs ADD COLUMN prompt TEXT;
