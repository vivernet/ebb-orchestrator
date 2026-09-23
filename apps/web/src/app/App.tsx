import { RouterProvider } from 'react-router';
import { useEventClient } from '../hooks/useEventClient.js';
import { router } from './router.js';

/** Параметры корневого интерфейса, определяющие доступность локальной сессии. */
interface AppProps {
  /** Ошибка одноразовой инициализации локальной сессии, если она произошла. */
  bootstrapError?: string;
}

/**
 * Представляет корневой интерфейс. При ошибке bootstrap не монтирует маршруты
 * и event stream, чтобы не маскировать отсутствие авторизованной сессии.
 */
function App({ bootstrapError }: AppProps) {
  if (bootstrapError) {
    return (
      <main className="session-error" role="alert">
        <p className="eyebrow">Доступ к локальной сессии недоступен</p>
        <h1>Не удалось установить локальную сессию</h1>
        <p>{bootstrapError}</p>
        <p>Откройте ссылку локального запуска, сгенерированную Ebb Orchestrator.</p>
      </main>
    );
  }

  // Инициализируем SSE-соединение после успешного запуска локальной сессии.
  useEventClient();

  return <RouterProvider router={router} />;
}

export default App;
