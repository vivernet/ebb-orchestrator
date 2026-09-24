/**
 * Минимальный HTTP-сервис для тестирования.
 * Эндпоинт /health возвращает статус здоровья.
 */
import http from 'http';
import { pathToFileURL } from 'node:url';

const port = parseInt(process.env.PORT, 10) || 3000;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.writeHead(404);
  res.end('Not Found');
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

export default server;
