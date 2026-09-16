import assert from 'node:assert/strict';
import http from 'node:http';
import server from '../src/server.js';

const address = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});

const port = typeof address === 'object' && address !== null ? address.port : 0;
const response = await new Promise((resolve, reject) => {
  const request = http.get(`http://127.0.0.1:${port}/`, resolve);
  request.on('error', reject);
});

assert.equal(response.statusCode, 404);
server.close();
