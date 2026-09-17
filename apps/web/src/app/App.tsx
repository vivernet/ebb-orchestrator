import { RouterProvider } from 'react-router';
import { useEventClient } from '../hooks/useEventClient.js';
import { router } from './router.js';

function App() {
  // Initialize SSE connection on app startup
  useEventClient();

  return <RouterProvider router={router} />;
}

export default App;
