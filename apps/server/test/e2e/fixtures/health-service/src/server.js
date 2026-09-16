import http from 'http';

const port = parseInt(process.env.PORT, 10) || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(404);
  res.end('Not Found');
});

const main = require.main === module;
if (main) {
  server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

export default server;
