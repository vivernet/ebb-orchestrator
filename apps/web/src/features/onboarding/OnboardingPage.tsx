import { useState } from 'react';
import { ApiError, apiClient, toClientPath } from '../../api/client.js';
import { apiErrorMessage } from '../../i18n/ru.js';
import { PageState } from '../../components/ui/PageState.js';
import UnsupportedBlock from '../../components/ui/Unavailable.js';
import './onboarding.css';

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

const DETECTED = [
  { title: 'Default ветка: master', sub: 'Обнаружено в локальном Git.' },
  { title: 'Проект Node.js / TypeScript', sub: 'Обнаружено по package.json, tsconfig.json и исходным файлам.' },
  { title: 'Package manager: pnpm', sub: 'Обнаружено по pnpm-lock.yaml.' },
  { title: 'Test runner: Vitest', sub: 'Обнаружено по скриптам и конфигурации пакета.' },
  { title: 'Найден удалённый репозиторий GitHub', sub: 'origin → github.com/vivernet/ebb-ai-hub' },
];

const REVIEW = [
  ['Название проекта', 'Предложено на основе метаданных репозитория', 'Ebb AI Hub'],
  ['Default branch', 'Обнаруженный факт', 'master'],
  ['Процесс по умолчанию', 'Координатор proposal', 'standard ▾'],
  ['Режим выполнения', 'Значение v1 по умолчанию', 'Local ▾'],
  ['Параллельные агенты', 'Лимит проекта', '3'],
  ['Интеграция с GitHub', 'Удалённый репозиторий обнаружен; подключение необязательно', 'Подключить позже ▾'],
];

/**
 * Подключение проекта (reference 07): шаги discovery → review → approval →
 * activation. Обнаруженные факты отделены от предложений координатора; панели
 * без авторитетного источника рендерят контрактный блок «недоступно».
 */
export default function OnboardingPage({ projectId }: { projectId?: string }) {
  void projectId;
  const [error, setError] = useState<unknown | null>(null);
  const [busy, setBusy] = useState(false);

  const handleDiscover = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.post(toClientPath('/api/v1/onboarding/discover'), { repositoryPath: 'C:/Repos/ebb-ai-hub' });
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="reference-screen onboarding-page">
      <div className="pf-topbar">
        <div>
          <h1>Добавление проекта · обнаружение репозитория</h1>
          <div className="pf-unavail">Orchestrator отделяет то, что он <b>обнаружил</b>, от того, что лишь <b>предлагает</b>. Ничто, имеющее смысл для проекта, не становится политикой без ревью.</div>
        </div>
        <button type="button" className="pf-btn">Отмена</button>
      </div>

      {error ? <p className="on-error">Не удалось выполнить обнаружение: {errorMessage(error)}</p> : null}

      <div className="on-steps" aria-label="Этапы онбординга">
        <div className="on-step done">1. Репозиторий ✓</div>
        <div className="on-step done">2. Обнаружение ✓</div>
        <div className="on-step active">3. Проверка результатов</div>
        <div className="on-step">4. Согласовать config</div>
        <div className="on-step">5. Активация проекта</div>
      </div>

      <div className="pf-grid on-grid">
        <div>
          <section className="pf-card">
            <div className="pf-row">
              <div>
                <h3>Выбранный репозиторий</h3>
                <div className="pf-unavail">Локальный Git-репозиторий успешно обнаружен.</div>
              </div>
              <span className="pf-chip on-good">Git-репозиторий</span>
            </div>
            <div className="on-repo">C:\Repos\ebb-ai-hub</div>

            <div className="on-section">
              <h4>Обнаруженные факты</h4>
              {DETECTED.map((fact) => (
                <div key={fact.title} className="on-item detected">
                  <b>{fact.title}</b>
                  <small>{fact.sub}</small>
                </div>
              ))}
            </div>
          </section>

          <section className="pf-card">
            <div className="pf-row">
              <div>
                <h3>Координатор proposals</h3>
                <div className="pf-unavail">Это рекомендации, а не обнаруженные факты.</div>
              </div>
              <span className="pf-chip">Анализ Hermes</span>
            </div>
            <div className="on-section">
              <UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="Недоступно" />
            </div>
          </section>
        </div>

        <div>
          <section className="pf-card">
            <h3>Проверка конфигурации проекта</h3>
            <div className="pf-unavail">Перед активацией можно принять, изменить или отклонить предложения.</div>
            <UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="Недоступно" />
          </section>

          <section className="pf-card">
            <h3>Создаваемые файлы</h3>
            <UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="Недоступно" />
          </section>

          <section className="pf-card">
            <h3>Итоги активации</h3>
            <UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="Недоступно" />
          </section>
        </div>
      </div>

      <div className="pf-actions on-footer-actions">
        <button type="button" className="pf-btn">Назад к обнаружению</button>
        <button type="button" className="pf-btn primary" disabled={busy} onClick={() => void handleDiscover()}>Согласовать и активировать проект</button>
      </div>

      <div className="pf-footer-note">Концепция подключения проекта v0.1 · ОБНАРУЖЕННЫЕ факты никогда не смешиваются с ПРЕДЛАГАЕМЫМИ политиками.</div>
    </div>
  );
}

