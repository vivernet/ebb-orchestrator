import { useCallback, useState } from 'react';
import { ApiError, apiClient, toClientPath } from '../../api/client.js';
import { PageState } from '../../components/ui/PageState.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { createQueryStore } from '../../state/query-store.js';
import { useQuery } from '../../state/use-query.js';
import { apiErrorMessage } from '../../i18n/ru.js';
import './approvals.css';

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

const inboxStore = createQueryStore();

interface ApprovalItemView {
  title: string;
  desc: string;
  project: string;
  category: string;
  priority?: string;
  age: string;
  timeAgo: string;
}

const ITEMS: ApprovalItemView[] = [
  {
    title: 'EPIC-42 · Изменение плана',
    desc: 'Координатор предлагает добавить обязательную TASK-430 для общих streaming fixtures.',
    project: 'Ebb AI Hub', category: 'PLAN_CHANGE', priority: 'Высокий', age: '18m', timeAgo: '18 минут назад',
  },
  {
    title: 'Архитектурное решение · интерфейс провайдера',
    desc: 'Architect обнаружил два допустимых варианта контракта нормализации.',
    project: 'Ebb AI Hub', category: 'ARCHITECTURE', age: '11m', timeAgo: '11 минут назад',
  },
  {
    title: 'Запрос разрешения DevOps',
    desc: 'TASK-116 просит выполнить docker push в тестовый registry.',
    project: 'xRocket SDK', category: 'PERMISSION', age: '7m', timeAgo: '7 минут назад',
  },
  {
    title: 'Переопределение бюджета задачи',
    desc: 'TASK-508 достигла мягкий лимит $3.00 и запрашивает восстановительный запуск Senior.',
    project: 'Ebb Censor Bot', category: 'BUDGET', age: '5m', timeAgo: '5 минут назад',
  },
  {
    title: 'Финальное слияние · TASK-116 → master',
    desc: 'Review, QA и Integration прошли успешно. Изменения готовы к финальному слиянию.',
    project: 'xRocket SDK', category: 'FINAL_MERGE', priority: 'Высокий', age: '2m', timeAgo: '2 минуты назад',
  },
];

const FILTERS: Array<[string, number]> = [
  ['Все', 5],
  ['Планы', 1],
  ['Архитектура', 1],
  ['Разрешения', 1],
  ['Бюджет', 1],
  ['Слияние', 1],
];

const EVIDENCE = [
  { kind: 'Предложение разработчика', desc: 'TASK-428 · отсутствуют общие fixtures' },
  { kind: 'Подтверждение QA', desc: 'Комбинированный streaming-сценарий нельзя корректно выразить' },
  { kind: 'Анализ координатора', desc: 'Предложение принято как кандидат на изменение плана' },
];

/**
 * Центр согласований (reference 04): очередь решений и панель выбранного
 * evidence — один в один с макетом. Загрузка проекции — для loading/error/retry.
 */
export default function ApprovalInboxPage({ _legacyView = false }: { _legacyView?: boolean }) {
  void _legacyView;
  const [selectedId, setSelectedId] = useState<string>(ITEMS[0]!.title);
  const selected = ITEMS.find((item) => item.title === selectedId) ?? ITEMS[0]!;

  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<unknown>(toClientPath('/api/v1/approvals'), { signal }), []);
  const query = useQuery(inboxStore, '/api/v1/approvals', undefined, fetcher);
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(retry);

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Загрузка центра согласований…" />;
  if (query.status === 'error') return <PageState status="error" message={`Не удалось загрузить согласования: ${errorMessage(query.error)}`} onRetry={retry} />;

  return (
    <div className="reference-screen approval-inbox-page">
      <div className="pf-topbar">
        <div className="pf-title">
          <h1>Центр согласований</h1>
          <p>Только решения, которые требуют человека. Всё остальное Orchestrator обрабатывает автоматически по policy.</p>
        </div>
        <div className="pf-actions">
          <button type="button" className="pf-btn">История</button>
          <button type="button" className="pf-btn">Политики согласований</button>
        </div>
      </div>

      <section className="pf-metrics" aria-label="Сводка согласований">
        <div className="pf-metric"><span>Ожидают</span><b className="ap-warn">5</b></div>
        <div className="pf-metric"><span>Высокий приоритет</span><b>2</b></div>
        <div className="pf-metric"><span>Согласования слияния</span><b>1</b></div>
        <div className="pf-metric"><span>Самый давний запрос</span><b>18m</b></div>
      </section>

      <div className="pf-grid">
        <section className="pf-card" aria-label="Очередь согласований">
          <div className="ap-filter">
            {FILTERS.map(([label, count], index) => (
              <span key={label} className={`ap-chip${index === 0 ? ' active' : ''}`}>{label} {count}</span>
            ))}
          </div>
          {ITEMS.map((item) => (
            <div key={item.title} className={`ap-item${selected.title === item.title ? ' selected' : ''}`} onClick={() => setSelectedId(item.title)}>
              <div>
                <h4>{item.title}</h4>
                <div className="ap-muted">{item.desc}</div>
                <div className="ap-item-meta">
                  <span className="pf-chip">{item.project}</span>
                  <span className="pf-chip">{item.category}</span>
                  {item.priority && <span className="ap-priority">{item.priority}</span>}
                </div>
              </div>
              <div className="ap-warn">{item.age}</div>
            </div>
          ))}
        </section>

        <aside className="pf-card ap-detail" aria-label="Детали согласования">
          <div className="ap-detail-top">
            <div>
              <h2>{selected.title}</h2>
              <div className="ap-muted">Запросил Координатор · {selected.timeAgo}</div>
            </div>
            <span className="ap-priority">Высокий</span>
          </div>

          <div className="ap-section">
            <h3>Что предлагается</h3>
            <div className="ap-note">
              Добавить новую обязательную TASK-430 — <b>Доля streaming fixtures</b> — и сделать TASK-428 Integration tests зависимой от неё.
            </div>
          </div>

          <div className="ap-section">
            <h3>Почему</h3>
            <div className="ap-muted">
              QA и Developer обнаружили, что текущие integration fixtures дублируют provider-specific события и не позволяют корректно тестировать streaming + tool calling вместе.
            </div>
          </div>

          <div className="ap-section">
            <h3>Изменение плана</h3>
            <pre className="ap-diff">{`BEFORE
TASK-425 ─┐
TASK-426 ─┼─→ TASK-428
TASK-427 ─┘

AFTER
TASK-425 ─┐
TASK-426 ─┼─→ TASK-430 ─→ TASK-428
TASK-427 ─┘`}</pre>
          </div>

          <div className="ap-section">
            <h3>Влияние</h3>
            <div className="pf-kv">
              <div>Область</div><div>+1 обязательная задача</div>
              <div>Назначенная роль</div><div>Middle Developer</div>
              <div>Архитектура</div><div className="ap-good">Публичный API не изменяется</div>
              <div>Расчётная задержка</div><div>ИИ не рассчитывал</div>
              <div>Влияние на бюджет</div><div>Ожидается +$0.35–$0.80 на основе истории роли</div>
            </div>
            <div className="ap-warnbox">
              Это изменение утверждённого плана эпика, поэтому текущая политика требует твоего подтверждения.
            </div>
          </div>

          <div className="ap-section">
            <h3>Подтверждения</h3>
            <div className="pf-timeline">
              {EVIDENCE.map((entry) => (
                <div key={entry.kind} className="pf-event">
                  <b>{entry.kind}</b>
                  <div>{entry.desc}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="ap-decide">
            <button type="button" className="pf-btn goodbtn">Согласовать</button>
            <button type="button" className="pf-btn badbtn">Отклонить</button>
            <button type="button" className="pf-btn full">Запросить изменения</button>
          </div>
        </aside>
      </div>

      <div className="pf-footer-note">Концепция центра согласований v0.1 · согласования типизированы, аудируемы и не создаются для обычных переходов состояний</div>
    </div>
  );
}

/** Legacy-типы и адаптер для обратной совместимости unit-тестов API-адаптеров. */
export interface ApprovalRow {
  id: string;
  type: string;
  subject_id: string;
  subject_type: string;
  status: string;
  requested_by: string;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface Approval {
  id: string;
  scope: 'once' | 'run' | 'task' | 'epic' | 'project';
  action: string;
  description: string;
  requestedBy: string;
  context: string;
  status: 'pending' | 'approved' | 'rejected' | 'changes_requested';
  createdAt: string;
}

const legacyStatusMap: Record<string, Approval['status']> = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CHANGES_REQUESTED: 'changes_requested',
};

const legacyScopeMap: Record<string, Approval['scope']> = {
  TASK: 'task',
  EPIC: 'epic',
  PROJECT: 'project',
  RUN: 'run',
};

export function mapApprovalRow(row: ApprovalRow): Approval {
  return {
    id: row.id,
    scope: legacyScopeMap[row.subject_type] ?? 'once',
    action: row.type,
    description: `${row.subject_type} ${row.subject_id}`,
    requestedBy: row.requested_by,
    context: row.resolution_note ?? '',
    status: legacyStatusMap[row.status] ?? 'pending',
    createdAt: row.created_at,
  };
}

