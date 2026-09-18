import { RouterProvider } from 'react-router';
import { useEventClient } from '../hooks/useEventClient.js';
import { router } from './router.js';

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
function App() {
  // Initialize SSE connection on app startup
  useEventClient();

  return <RouterProvider router={router} />;
}

export default App;
