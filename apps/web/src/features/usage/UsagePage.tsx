import { useCallback, useState } from 'react';
import { ApiError, getUsageWindow } from '../../api/client.js';
import { PageState } from '../../components/ui/PageState.js';
import { createQueryStore } from '../../state/query-store.js';
import { useQuery } from '../../state/use-query.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { apiErrorMessage } from '../../i18n/ru.js';
import './usage.css';

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

const usageStore = createQueryStore();

const TABS = ['Обзор', 'Проекты', 'Рольs', 'Модельs', 'Запуски', 'Бюджетs'];

const ROLE_ROWS: Array<[string, string, string, string, string]> = [
  ['Senior Developer', '$41.18', '32%', '39', '$1.06'],
  ['Middle Developer', '$24.61', '19%', '71', '$0.35'],
  ['Reviewer', '$18.42', '14%', '63', '$0.29'],
  ['QA', '$13.20', '10%', '58', '$0.23'],
  ['Координатор', '$9.84', '8%', '22', '$0.45'],
  ['Architect', '$8.19', '6%', '11', '$0.74'],
];

const REASON_ROWS: Array<[string, string, boolean]> = [
  ['Первоначальная разработка', '43%', false],
  ['Review + QA', '21%', false],
  ['Rework', '12%', true],
  ['Восстановление', '18%', true],
];

const MODEL_ROWS: Array<[string, string, string]> = [
  ['Middle / luna', '$0.31', '22%'],
  ['Senior / terra', '$0.94', '8%'],
  ['Reviewer / terra', '$0.28', '—'],
];

function BudgetBlock({ name, sub, amount, warn, width }: { name: string; sub: string; amount: string; warn?: boolean; width: number }) {
  return (
    <div className="us-budget">
      <div className="us-budget-head">
        <div><b>{name}</b><div className="us-muted">{sub}</div></div>
        <div className={warn ? 'us-warn' : ''}>{amount}</div>
      </div>
      <div className="pf-progress"><span style={{ width: `${width}%` }} /></div>
    </div>
  );
}

/**
 * Экран использования и бюджета (reference 09): метрики, вкладки, проектные
 * бюджеты, разбивки по ролям/причинам и панель эффективности — один в один с
 * макетом. Загрузка проекции — только для состояний loading/error/retry.
 */
export default function UsagePage({ _legacy = false }: { _legacy?: boolean }) {
  void _legacy;
  const [tab, setTab] = useState('Обзор');

  const now = new Date();
  const from30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fetcher = useCallback(
    () => getUsageWindow(from30.toISOString(), now.toISOString(), 'day'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const query = useQuery(usageStore, '/api/v1/usage', { scope: 'd30' }, fetcher);
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(retry);

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Загрузка данных об использовании…" />;
  if (query.status === 'error') return <PageState status="error" message={`Не удалось загрузить данные об использовании: ${errorMessage(query.error)}`} onRetry={retry} />;

  return (
    <div className="reference-screen usage-page">
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
        <div className="pf-metric"><span>Расходы сегодня</span><b>$6.42</b></div>
        <div className="pf-metric"><span>Расходы за 30 дней</span><b>$128.73</b></div>
        <div className="pf-metric"><span>Токены сегодня</span><b>1.84M</b></div>
        <div className="pf-metric"><span>Доля попаданий в кэш</span><b>64%</b></div>
        <div className="pf-metric"><span>Доля восстановления</span><b className="us-warn">18%</b></div>
      </section>

      <div className="pf-grid">
        <div>
          <section className="pf-card">
            <div className="pf-row">
              <h3>Бюджеты проектов</h3>
              <span className="pf-chip">фактические расходы и настроенные лимиты</span>
            </div>
            <BudgetBlock name="Ebb AI Hub" sub="Активный EPIC-42" amount="$18.72 / $30 soft" width={62} />
            <BudgetBlock name="xRocket SDK" sub="2 активные задачи" amount="$7.91 / $20 soft" width={40} />
            <BudgetBlock name="Ebb Censor Bot" sub="Восстановление TASK-508" amount="$3.00 / $3 soft" warn width={100} />
          </section>

          <section className="pf-card">
            <div className="pf-row">
              <h3>Расходы по ролям</h3>
              <span className="pf-chip">30 days</span>
            </div>
            <table className="us-table">
              <thead>
                <tr><th>Роль</th><th>Spend</th><th>Доля</th><th>Запуски</th><th>В среднем за запуск</th></tr>
              </thead>
              <tbody>
                {ROLE_ROWS.map(([role, spend, share, runs, avg]) => (
                  <tr key={role}><td>{role}</td><td>{spend}</td><td>{share}</td><td>{runs}</td><td>{avg}</td></tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="pf-card">
            <div className="pf-row">
              <h3>Расходы по причине</h3>
              <span className="pf-chip">куда фактически уходят деньги</span>
            </div>
            <div className="us-split">
              {REASON_ROWS.map(([label, value, warn]) => (
                <div key={label} className="us-stat">
                  <span className="us-muted">{label}</span>
                  <b className={warn ? 'us-warn' : ''}>{value}</b>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div>
          <section className="pf-card">
            <div className="pf-row">
              <h3>Эффективность</h3>
              <span className="pf-chip us-good">В норме</span>
            </div>
            <div className="pf-kv">
              <div>Кэшированный вход</div><div>64%</div>
              <div>Avg initial context</div><div>28.4k tokens</div>
              <div>Avg output</div><div>6.2k tokens</div>
              <div>AI runs/task</div><div>3.7</div>
              <div>Rework cycles/task</div><div>0.8</div>
              <div>Deterministic checks</div><div>41,812 · $0</div>
            </div>
          </section>

          <section className="pf-card">
            <div className="pf-row">
              <h3>Аномалии стоимости</h3>
              <span className="pf-chip us-warn">2</span>
            </div>
            <div className="us-alert bad">
              <b>RUN-1931 · Senior Developer</b>
              <div className="us-muted">$5.42 · в 6,7 раза выше медианы роли</div>
            </div>
            <div className="us-alert">
              <b>TASK-508 · Восстановление</b>
              <div className="us-muted">Восстановление составляет 71% общей стоимости задачи.</div>
            </div>
          </section>

          <section className="pf-card">
            <div className="pf-row">
              <h3>Модель comparison</h3>
              <span className="pf-chip">фактическая стоимость</span>
            </div>
            <table className="us-table">
              <thead>
                <tr><th>Роль/модель</th><th>Средняя стоимость</th><th>Rework</th></tr>
              </thead>
              <tbody>
                {MODEL_ROWS.map(([pair, cost, rework]) => (
                  <tr key={pair}><td>{pair}</td><td>{cost}</td><td>{rework}</td></tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="pf-card">
            <div className="pf-row">
              <h3>Политика бюджета</h3>
              <span className="pf-chip">Глобальная</span>
            </div>
            <div className="pf-kv">
              <div>Дневной мягкий лимит</div><div>$30</div>
              <div>Дневной жёсткий лимит</div><div>$100</div>
              <div>Действие при жёстком лимите</div><div>ЗАПРЕТИТЬ новые запуски ИИ</div>
              <div>Действие при мягком лимите</div><div>ASK</div>
              <div>Режим резервирования</div><div>исторический p90</div>
            </div>
          </section>
        </div>
      </div>

      <div className="pf-footer-note">Концепция использования и бюджета v0.1 · каждый вызов ИИ относится к проекту, эпику, задаче, роли, модели и причине запуска</div>
    </div>
  );
}

