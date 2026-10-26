import { useCallback, useState } from 'react';
import {
  type SettingsProjection,
} from '@ebb-orchestrator/contracts';
import { ApiError, getSettings, toClientPath } from '../../api/client.js';
import { PageState } from '../../components/ui/PageState.js';
import { createQueryStore } from '../../state/query-store.js';
import { useQuery } from '../../state/use-query.js';
import { apiErrorMessage } from '../../i18n/ru.js';
import './settings.css';

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

const settingsStore = createQueryStore();

const NAV = ['General', 'Роли и модели', 'Процессы', 'Среда выполнения', 'Scheduler', 'Восстановление', 'Разрешения', 'Git & GitHub', 'Бюджетs', 'Рекомендации', 'Secrets'];

const ROLE_MODEL_ROWS: Array<[string, string, string, string]> = [
  ['Координатор', 'Hermes', 'gpt-5.6-terra', 'Project'],
  ['Product Manager', 'Hermes', 'gpt-5.6-luna', 'Глобальная'],
  ['Architect', 'Hermes', 'gpt-5.6-terra', 'Project'],
  ['Middle Developer', 'Hermes', 'gpt-5.6-luna', 'Project'],
  ['Senior Developer', 'Hermes', 'gpt-5.6-terra', 'Project'],
  ['Reviewer', 'Hermes', 'gpt-5.6-terra', 'Project'],
  ['QA', 'Hermes', 'gpt-5.6-luna', 'Глобальная'],
  ['Integration', 'Hermes', 'gpt-5.6-terra', 'Project'],
  ['DevOps', 'Hermes', 'gpt-5.6-terra', 'Project'],
];

function Row({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="st-row">
      <div>
        <b>{title}</b>
        {desc ? <div className="st-desc">{desc}</div> : null}
      </div>
      <div className="st-control">{children}</div>
    </div>
  );
}

function Switch({ on }: { on: boolean }) {
  return (
    <span className={`st-switch${on ? ' on' : ''}`}><span /></span>
  );
}

/**
 * Экран настроек (reference 08): разделы-карточки повторяют макет один в один.
 * Значения — проекция настроек (если доступна) либо контрактные подписи макета.
 */
export default function SettingsPage({ initialProjectId }: { initialProjectId?: string } = {}) {
  void initialProjectId;
  const [nav, setNav] = useState('General');

  const fetcher = useCallback((signal: AbortSignal) => getSettings({ signal }), []);
  const query = useQuery(settingsStore, toClientPath('/api/v1/settings'), undefined, fetcher);
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Загрузка настроек…" />;
  if (query.status === 'error') return <PageState status="error" message={`Не удалось загрузить настройки: ${errorMessage(query.error)}`} onRetry={retry} />;

  const data: SettingsProjection = query.data!;
  const global = data.effectiveHierarchy.global;
  const schedulerMax = global?.globalMax ?? 3;

  return (
    <div className="reference-screen settings-page">
      <div className="pf-topbar">
        <div className="pf-title">
          <h1>Настройки проекта · Ebb AI Hub</h1>
          <p>Версионируемые правила проекта отделены от локальных секретов, путей и состояния выполнения.</p>
        </div>
        <div className="pf-actions">
          <button type="button" className="pf-btn">Посмотреть diff конфигурации</button>
          <button type="button" className="pf-btn primary">Сохранить изменения</button>
        </div>
      </div>

      <div className="st-layout">
        <aside className="st-nav" aria-label="Разделы настроек">
          {NAV.map((item) => (
            <div key={item} className={`st-nav-item${item === nav ? ' active' : ''}`} onClick={() => setNav(item)}>{item}</div>
          ))}
        </aside>

        <div>
          <section className="pf-card" aria-label="General">
            <h3>General</h3>
            <div className="st-subtitle">Идентичность проекта и значения по умолчанию на уровне репозитория.</div>
            <Row title="Название проекта" desc="Удобочитаемое имя в Orchestrator.">
              <span className="st-field">Ebb AI Hub</span>
            </Row>
            <Row title="Репозиторий" desc="Локальный Git-репозиторий, которым управляет этот проект.">
              <span className="st-field">C:\Repos\ebb-ai-hub</span>
            </Row>
            <Row title="Default branch" desc="Целевая ветка для отдельных задач и эпиков.">
              <span className="st-select">master ▾</span>
            </Row>
            <Row title="Режим выполнения" desc="В v1 — локальный режим; Container станет доступен позже.">
              <span className="st-select">Local ▾</span>
            </Row>
          </section>

          <section className="pf-card" aria-label="Роли и модели">
            <h3>Роли и модели</h3>
            <div className="st-subtitle">Роль определяет работу. Модель определяет способность рассуждать. Среда выполнения исполняет роль.</div>
            <table className="st-table">
              <thead>
                <tr><th>Роль</th><th>Среда выполнения</th><th>Модель</th><th>Переопределение</th></tr>
              </thead>
              <tbody>
                {ROLE_MODEL_ROWS.map(([role, runtime, model, override]) => (
                  <tr key={role}>
                    <td>{role}</td>
                    <td>{runtime}</td>
                    <td>{model}</td>
                    <td><span className="pf-chip">{override}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="pf-card" aria-label="Планировщик">
            <h3>Scheduler</h3>
            <div className="st-subtitle">Детерминированные лимиты; LLM не вызывается для решения об обычном допуске в очередь.</div>
            <Row title="Параллельные агенты проекта" desc="Максимальное число одновременных запусков для этого репозитория.">
              <span className="st-field">{schedulerMax}</span>
            </Row>
            <Row title="Старение приоритета" desc="Не допускать бесконечного голодания низкоприоритетных работ.">
              <Switch on />
            </Row>
            <Row title="Повышение критического пути" desc="Повышать приоритет задач, разблокирующих самую длинную последующую цепочку.">
              <Switch on />
            </Row>
          </section>

          <section className="pf-card" aria-label="Восстановление">
            <h3>Восстановление</h3>
            <div className="st-subtitle">Повторная попытка считается ограниченным ресурсом, а не ответом по умолчанию на каждую ошибку.</div>
            <Row title="Сначала возобновлять сессию Hermes">
              <Switch on />
            </Row>
            <Row title="Попытки Middle до эскалации">
              <span className="st-field">2</span>
            </Row>
            <Row title="Senior attempts">
              <span className="st-field">2</span>
            </Row>
            <Row title="Обнаружение циклов">
              <Switch on />
            </Row>
            <Row title="Порог отсутствия прогресса">
              <span className="st-field">2 последовательных запуска</span>
            </Row>
          </section>

          <section className="pf-card" aria-label="Git и GitHub">
            <h3>Git & GitHub</h3>
            <div className="st-subtitle">Git работает по принципу «сначала локально». GitHub — необязательная синхронизация и совместная работа.</div>
            <Row title="Стратегия интеграции" desc="Как целевые изменения включаются перед интеграцией.">
              <span className="st-select">Слияние ▾</span>
            </Row>
            <Row title="Интеграция с GitHub">
              <span className="st-good">Подключён</span>
            </Row>
            <Row title="Создавать Issues для задач">
              <Switch on />
            </Row>
            <Row title="Сливать через GitHub PR">
              <Switch on />
            </Row>
            <Row title="GitHub sync">
              <span className="st-select">Polling + manual sync ▾</span>
            </Row>
          </section>

          <section className="pf-card" aria-label="Владение конфигурацией">
            <h3>Владение конфигурацией</h3>
            <div className="st-subtitle">Чёткая граница между версионируемой конфигурацией проекта и состоянием локальной машины.</div>
            <pre className="st-code">{`Репозиторий (.ebb-orchestrator/)
├── project.yaml
├── workflows.yaml
└── guidelines/
    ├── architecture.md
    ├── database.md
    └── git.md

Local SQLite / secure storage
├── absolute paths
├── Hermes sessions
├── task runtime state
├── approvals
├── usage
├── GitHub credentials
├── secrets
└── recovery state`}</pre>
            <div className="st-note">
              Конфигурация репозитория отвечает: <b>«Как следует разрабатывать этот проект?»</b><br />
              Локальное состояние отвечает: <b>«Что сейчас происходит на этой машине?»</b>
            </div>
            <div className="st-warn">
              Смысловые изменения утверждённых рекомендаций или процессов могут требовать согласования до активации.
            </div>
          </section>
        </div>
      </div>

      <div className="pf-footer-note">Концепция настроек v0.1 · глобальные значения по умолчанию → переопределения проекта → переопределения роли → переопределение задачи/эпика</div>
    </div>
  );
}
