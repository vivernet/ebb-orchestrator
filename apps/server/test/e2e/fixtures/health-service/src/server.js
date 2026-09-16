import http from 'http';
import { pathToFileURL } from 'node:url';

const port = parseInt(process.env.PORT, 10) || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(404);
  res.end('Not Found');
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

export default server;
