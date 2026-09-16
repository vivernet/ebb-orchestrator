import assert from 'node:assert/strict';
import http from 'node:http';
import server from '../src/server.js';

const address = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});

const port = typeof address === 'object' && address !== null ? address.port : 0;
const response = await new Promise((resolve, reject) => {
  const request = http.get(`http://127.0.0.1:${port}/health`, resolve);
  request.on('error', reject);
});

assert.equal(response.statusCode, 200);
assert.deepEqual(JSON.parse(await new Promise((resolve, reject) => {
  let body = '';
  response.setEncoding('utf8');
  response.on('data', (chunk) => { body += chunk; });
  response.on('end', () => resolve(body));
  response.on('error', reject);
})), { status: 'ok' });
const rootResponse = await new Promise((resolve, reject) => {
  const request = http.get(`http://127.0.0.1:${port}/`, resolve);
  request.on('error', reject);
});
assert.equal(rootResponse.statusCode, 404);
server.close();
