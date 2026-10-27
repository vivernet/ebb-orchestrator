import { useCallback, useState } from 'react';
import { ApiError, getUsageWindow } from '../../api/client.js';
import { PageState } from '../../components/ui/PageState.js';
import { createQueryStore } from '../../state/query-store.js';
import { useQuery } from '../../state/use-query.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { apiErrorMessage } from '../../i18n/ru.js';
import type { UsageWindowProjection, AvailabilityValue } from '@ebb-orchestrator/contracts';
import './usage.css';

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

const usageStore = createQueryStore();
const usageParams = { scope: 'd30' };

const TABS = ['Обзор', 'Проекты', 'Роли', 'Модели', 'Запуски', 'Бюджет'];

/** Число с двумя знаками, безопасное для любой входящей цифры. */
function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'недоступно';
  return `$${value.toFixed(2)}`;
}

/** Число в компактном виде с суффиксом k/M. */
function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'недоступно';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** Процент из AvailabilityValue; unavailable — «недоступно». */
function availabilityPercent(value: AvailabilityValue | null | undefined): string {
  if (!value) return 'недоступно';
  if (value.availability === 'unavailable') return 'недоступно';
  return `${value.value.toFixed(0)}%`;
}

function BudgetBlock({ name, sub, amount, warn, width }: { name: string; sub: string; amount: string; warn?: boolean; width?: number }) {
  return (
    <div className="us-budget">
      <div className="us-budget-head">
        <div><b>{name}</b><div className="us-muted">{sub}</div></div>
        <div className={warn ? 'us-warn' : ''}>{amount}</div>
      </div>
      <div className="pf-progress"><span style={{ width: `${width ?? 0}%` }} /></div>
    </div>
  );
}

/**
 * Экран использования и бюджета (reference 09): метрики, вкладки, проектные
 * бюджеты, разбивки по ролям/причинам/моделям и панель эффективности.
 * Все значения — из backend-проекции /usage; без источника — «недоступно».
 */
export default function UsagePage() {
  const [tab, setTab] = useState('Обзор');

  const now = new Date();
  const from30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fetcher = useCallback(
    () => getUsageWindow(from30.toISOString(), now.toISOString(), 'day'),
    [],
  );
  const query = useQuery(usageStore, '/api/v1/usage', usageParams, fetcher);
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(retry);

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Загрузка данных об использовании…" />;
  if (query.status === 'error') return <PageState status="error" message={`Не удалось загрузить данные об использовании: ${errorMessage(query.error)}`} onRetry={retry} />;

  const projection: UsageWindowProjection | undefined = query.data;
  const summary = projection?.summary;
  const efficiency = projection?.efficiency;
  const anomaly = projection?.anomaly;
  const recoveryShare = projection?.taskRecoveryShare;
  const budgets = projection?.budgets;
  const byRole = projection?.breakdowns?.byRole ?? [];
  const byReason = projection?.breakdowns?.byReason ?? [];
  const modelComparison = projection?.modelComparison ?? [];

  return (
    <div className="reference-screen usage-page reference-screen--usage">
      <div className="pf-topbar">
        <div className="pf-title">
          <h1>Использование и бюджет</h1>
          <p>Куда уходят токены и деньги, какие роли создают доработка и где система тратит больше нормы.</p>
        </div>
        <div className="pf-actions">
          <button type="button" className="pf-btn">Последние 30 дней</button>
          <a className="pf-btn primary" href="#/settings">Политики бюджета</a>
        </div>
      </div>

      <div className="pf-tabs">
        {TABS.map((t) => (
          <div key={t} className={`pf-tab${t === tab ? ' active' : ''}`} onClick={() => setTab(t)}>{t}</div>
        ))}
      </div>

      <section className="pf-metrics pf-metrics--5" aria-label="Сводка использования">
        <div className="pf-metric"><span>Расходы за 30 дней</span><b>{money(summary?.cost)}</b></div>
        <div className="pf-metric"><span>Токены за 30 дней</span><b>{compactNumber(summary?.totalTokens)}</b></div>
        <div className="pf-metric"><span>Вход</span><b>{compactNumber(summary?.inputTokens)}</b></div>
        <div className="pf-metric"><span>Выход</span><b>{compactNumber(summary?.outputTokens)}</b></div>
        <div className="pf-metric"><span>Кэшировано</span><b>{compactNumber(summary?.cachedTokens)}</b></div>
      </section>

      <div className="pf-grid">
        <div>
          <section className="pf-card">
            <div className="pf-row">
              <h3>Бюджеты проектов</h3>
              <span className="pf-chip">фактические расходы и настроенные лимиты</span>
            </div>
            {!budgets || (budgets.configurations.length === 0 && budgets.contexts.length === 0) ? (
              <div className="us-muted">недоступно</div>
            ) : (
              budgets.contexts.map((ctx) => (
                <BudgetBlock
                  key={`${ctx.scope}-${ctx.scopeId}`}
                  name={ctx.scopeId === 'global' ? 'Глобальный' : ctx.scopeId}
                  sub={`${ctx.scope} · лимит ${ctx.effectiveLimit === null ? 'недоступно' : money(ctx.effectiveLimit.limitCost)}`}
                  amount={ctx.applicableLimits.length > 0 ? `${ctx.applicableLimits.length} лимита` : '—'}
                />
              ))
            )}
          </section>

          <section className="pf-card">
            <div className="pf-row">
              <h3>Расходы по ролям</h3>
              <span className="pf-chip">30 days</span>
            </div>
            {byRole.length === 0 ? (
              <div className="us-muted">недоступно</div>
            ) : (
              <table className="us-table">
                <thead>
                  <tr><th>Роль</th><th>Spend</th><th>Доля</th><th>Запуски</th><th>В среднем за запуск</th></tr>
                </thead>
                <tbody>
                  {byRole.map((row) => (
                    <tr key={row.key}><td>{row.key}</td><td>{money(row.spend)}</td><td>{`${(row.share * 100).toFixed(0)}%`}</td><td>{row.runCount}</td><td>{row.runCount > 0 ? money(row.spend / row.runCount) : '—'}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="pf-card">
            <div className="pf-row">
              <h3>Расходы по причине</h3>
              <span className="pf-chip">куда фактически уходят деньги</span>
            </div>
            {byReason.length === 0 ? (
              <div className="us-muted">недоступно</div>
            ) : (
              <div className="us-split">
                {byReason.map((row) => (
                  <div key={row.key} className="us-stat">
                    <span className="us-muted">{row.key}</span>
                    <b>{`${(row.share * 100).toFixed(0)}%`}</b>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div>
          <section className="pf-card">
            <div className="pf-row">
              <h3>Эффективность</h3>
              <span className="pf-chip us-good">В норме</span>
            </div>
            <div className="pf-kv">
              <div>Кэшированный вход</div><div>{availabilityPercent(efficiency?.cacheShare)}</div>
              <div>Avg initial context</div><div>{(efficiency?.averageInitialContextTokens && efficiency.averageInitialContextTokens.availability === 'available') ? `${efficiency.averageInitialContextTokens.value.toFixed(1)}k tokens` : 'недоступно'}</div>
              <div>Avg output</div><div>{(efficiency?.averageOutputTokens && efficiency.averageOutputTokens.availability === 'available') ? `${efficiency.averageOutputTokens.value.toFixed(1)}k tokens` : 'недоступно'}</div>
              <div>AI runs/task</div><div>{(efficiency?.aiRunsPerTask && efficiency.aiRunsPerTask.availability === 'available') ? efficiency.aiRunsPerTask.value.toFixed(1) : 'недоступно'}</div>
              <div>Rework cycles/task</div><div>{(efficiency?.reworkCyclesPerTask && efficiency.reworkCyclesPerTask.availability === 'available') ? efficiency.reworkCyclesPerTask.value.toFixed(1) : 'недоступно'}</div>
              <div>Deterministic checks</div><div>{(efficiency?.deterministicCheckCount && efficiency.deterministicCheckCount.availability === 'available') ? `${efficiency.deterministicCheckCount.value} · ${money(efficiency.deterministicCheckCost?.availability === 'available' ? efficiency.deterministicCheckCost.value : null)}` : 'недоступно'}</div>
            </div>
          </section>

          <section className="pf-card">
            <div className="pf-row">
              <h3>Аномалии стоимости</h3>
              <span className="pf-chip us-warn">{anomaly && anomaly.availability === 'available' ? anomaly.value : 'недоступно'}</span>
            </div>
            {!anomaly || anomaly.availability !== 'available' ? (
              <div className="us-muted">Доступно после утверждения политики классификации.</div>
            ) : (
              <div className="us-alert bad"><b>Аномалий: {anomaly.value}</b></div>
            )}
          </section>

          <section className="pf-card">
            <div className="pf-row">
              <h3>Доля восстановления</h3>
              <span className="pf-chip">по задачам</span>
            </div>
            <div className="pf-kv">
              <div>Task recovery share</div>
              <div>{!recoveryShare || recoveryShare.availability !== 'available' ? 'недоступно' : `${(recoveryShare.value * 100).toFixed(0)}%`}</div>
            </div>
          </section>

          <section className="pf-card">
            <div className="pf-row">
              <h3>Модель comparison</h3>
              <span className="pf-chip">фактическая стоимость</span>
            </div>
            {modelComparison.length === 0 ? (
              <div className="us-muted">недоступно</div>
            ) : (
              <table className="us-table">
                <thead>
                  <tr><th>Роль/модель</th><th>Средняя стоимость</th><th>Запуски</th></tr>
                </thead>
                <tbody>
                  {modelComparison.map((row, index) => (
                    <tr key={index}><td>{row.role} / {row.model}</td><td>{money(row.averageCostPerRun)}</td><td>{row.runs}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="pf-card">
            <div className="pf-row">
              <h3>Политика бюджета</h3>
              <span className="pf-chip">Глобальная</span>
            </div>
            <div className="pf-kv">
              <div>Активные резервирования</div><div>{budgets?.activeReservations.length ?? 'недоступно'}</div>
              <div>Мягкий/жёсткий лимиты</div><div>настраиваются в Настройках</div>
            </div>
          </section>
        </div>
      </div>

      <div className="pf-footer-note">Концепция использования и бюджета v0.1 · каждый вызов ИИ относится к проекту, эпику, задаче, роли, модели и причине запуска</div>
    </div>
  );
}
