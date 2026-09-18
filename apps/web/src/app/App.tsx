import { RouterProvider } from 'react-router';
import { useEventClient } from '../hooks/useEventClient.js';
import { router } from './router.js';

/**
 * Представляет пользовательский экран App; авторитетные проверки выполняются backend.
 */
function App() {
  // Initialize SSE connection on app startup
  useEventClient();

  return <RouterProvider router={router} />;
}

export default App;
