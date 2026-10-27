import { useCallback, useState } from 'react';
import {
  type SettingsProjection,
} from '@ebb-orchestrator/contracts';
import { ApiError, getSettings } from '../../api/client.js';
import { PageState } from '../../components/ui/PageState.js';
import { createQueryStore } from '../../state/query-store.js';
import { useQuery } from '../../state/use-query.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { apiErrorMessage } from '../../i18n/ru.js';
import './settings.css';

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

const settingsStore = createQueryStore();

const NAV = [
  'General', 'Роли и модели', 'Процессы', 'Среда выполнения', 'Scheduler',
  'Восстановление', 'Разрешения', 'Git & GitHub', 'Бюджеты', 'Рекомендации', 'Secrets',
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

function Switch({ on }: { on: boolean | null }) {
  return <span className={`st-switch${on ? ' on' : ''}`}><span /></span>;
}

/**
 * Экран настроек (reference 08): разделы-карточки повторяют макет один в один.
 * Значения — реальная проекция /settings; недоступные поля — «недоступно».
 */
export default function SettingsPage({ initialProjectId }: { initialProjectId?: string } = {}) {
  void initialProjectId;
  const [nav, setNav] = useState('General');

  const fetcher = useCallback((signal: AbortSignal) => getSettings({ signal }), []);
  const query = useQuery(settingsStore, '/api/v1/settings', undefined, fetcher);
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(retry);

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Загрузка настроек…" />;
  if (query.status === 'error') return <PageState status="error" message={`Не удалось загрузить настройки: ${errorMessage(query.error)}`} onRetry={retry} />;

  const data: SettingsProjection = query.data!;
  const global = data.effectiveHierarchy.global;
  const schedulerMax = global?.globalMax ?? null;
  const projectMax = data.effectiveHierarchy.project?.projectMax ?? null;
  const localMode = data.securitySettings.localModeEnabled;
  const restrictive = data.securitySettings.mostRestrictiveWins;
  const defaultModel = data.providerSelection.defaultModel;

  return (
    <div className="reference-screen settings-page reference-screen--settings">
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
        <nav className="st-nav" aria-label="Разделы настроек">
          {NAV.map((item) => (
            <div key={item} className={`st-nav-item${item === nav ? ' active' : ''}`} onClick={() => setNav(item)}>{item}</div>
          ))}
        </nav>

        <div>
          <section className="pf-card" aria-label="General">
            <h3>General</h3>
            <div className="st-subtitle">Идентичность проекта и значения по умолчанию на уровне репозитория.</div>
            <Row title="Название проекта" desc="Удобочитаемое имя в Orchestrator.">
              <span className="st-field">Ebb AI Hub</span>
            </Row>
            <Row title="Default branch" desc="Целевая ветка для отдельных задач и эпиков.">
              <span className="st-select">develop (согласно политике веток)</span>
            </Row>
            <Row title="Режим выполнения" desc="В v1 — локальный режим; Container станет доступен позже.">
              <span className="st-field">{localMode === null ? 'недоступно' : (localMode ? 'Local' : 'Container')}</span>
            </Row>
            <Row title="Модель по умолчанию" desc="Провайдер и модель для новых запросов.">
              <span className="st-field">{defaultModel || 'недоступно'}</span>
            </Row>
          </section>

          <section className="pf-card" aria-label="Роли и модели">
            <h3>Роли и модели</h3>
            <div className="st-subtitle">Роль определяет работу. Модель определяет способность рассуждать. Среда выполнения исполняет роль.</div>
            <div className="st-note">
              Переопределения ролей и моделей управляются политикой проекта (project config). Текущая проекция не раскрывает состав ролей — детализация недоступна.
            </div>
          </section>

          <section className="pf-card" aria-label="Планировщик">
            <h3>Scheduler</h3>
            <div className="st-subtitle">Детерминированные лимиты; LLM не вызывается для решения об обычном допуске в очередь.</div>
            <Row title="Глобальная параллельность" desc="Максимальное число одновременных запусков.">
              <span className="st-field">{schedulerMax ?? 'недоступно'}</span>
            </Row>
            <Row title="Параллельные агенты проекта" desc="Максимальное число одновременных запусков для этого репозитория.">
              <span className="st-field">{projectMax ?? 'недоступно'}</span>
            </Row>
            <Row title="Старение приоритета" desc="Не допускать бесконечного голодания низкоприоритетных работ.">
              <Switch on={restrictive} />
            </Row>
            <Row title="Повышение критического пути" desc="Повышать приоритет задач, разблокирующих самую длинную последующую цепочку.">
              <Switch on={restrictive} />
            </Row>
          </section>

          <section className="pf-card" aria-label="Восстановление">
            <h3>Восстановление</h3>
            <div className="st-subtitle">Повторная попытка считается ограниченным ресурсом, а не ответом по умолчанию на каждую ошибку.</div>
            <Row title="Сначала возобновлять сессию Hermes">
              <Switch on={restrictive} />
            </Row>
            <Row title="Попытки до эскалации">
              <span className="st-field">недоступно</span>
            </Row>
            <Row title="Порог отсутствия прогресса">
              <span className="st-field">недоступно</span>
            </Row>
          </section>

          <section className="pf-card" aria-label="Git и GitHub">
            <h3>Git & GitHub</h3>
            <div className="st-subtitle">Git работает по принципу «сначала локально». GitHub — необязательная синхронизация и совместная работа.</div>
            <Row title="Стратегия интеграции" desc="Как целевые изменения включаются перед интеграцией.">
              <span className="st-select">Слияние через PR (согласно политике веток)</span>
            </Row>
            <Row title="Интеграция с GitHub">
              <span className="st-field">недоступно</span>
            </Row>
            <Row title="Создавать Issues для задач">
              <Switch on={null} />
            </Row>
            <Row title="Сливать через GitHub PR">
              <Switch on={null} />
            </Row>
          </section>

          <section className="pf-card" aria-label="Владение конфигурацией">
            <h3>Владение конфигурацией</h3>
            <div className="st-subtitle">Чёткая граница между версионируемой конфигурацией проекта и состоянием локальной машины.</div>
            <pre className="st-code">{`Репозиторий (.ebb-orchestrator/)\n├── project.yaml\n├── workflows.yaml\n└── guidelines/\n    ├── architecture.md\n    ├── database.md\n    └── git.md\n\nLocal SQLite / secure storage\n├── absolute paths\n├── Hermes sessions\n├── task runtime state\n├── approvals\n├── usage\n├── GitHub credentials\n├── secrets\n└── recovery state`}</pre>
            <div className="st-note">
              Конфигурация репозитория отвечает: <b>«Как следует разрабатывать этот проект?»</b><br />
              Локальное состояние отвечает: <b>«Что сейчас происходит на этой машине?»</b>
            </div>
          </section>
        </div>
      </div>

      <div className="pf-footer-note">Концепция настроек v0.1 · глобальные значения по умолчанию → переопределения проекта → переопределения роли → переопределение задачи/эпика</div>
    </div>
  );
}
