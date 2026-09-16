import http from 'http';

const port = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

if (require.main === module) {
  server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

export default server;
