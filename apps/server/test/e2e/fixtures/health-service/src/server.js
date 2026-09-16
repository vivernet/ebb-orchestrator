import http from 'http';

const port = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(404);
  res.end('Not Found');
});

if (require.main === module) {
  server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

export default server;
