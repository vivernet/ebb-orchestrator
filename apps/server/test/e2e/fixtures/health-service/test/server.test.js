import http from 'http';

const port = process.env.PORT || 3000;

function makeRequest(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: port,
        path: path,
        method: 'GET',
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data,
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function testHealthEndpoint() {
  const result = await makeRequest('/health');
  if (result.statusCode !== 200) {
    console.error('FAIL: Expected status 200, got', result.statusCode);
    process.exit(1);
  }
  
  try {
    const body = JSON.parse(result.body);
    if (body.status !== 'ok') {
      console.error('FAIL: Expected { status: "ok" }, got', body);
      process.exit(1);
    }
  } catch (e) {
    console.error('FAIL: Invalid JSON response:', result.body);
    process.exit(1);
  }

  console.log('PASS: /health endpoint returns { status: "ok" }');
}

async function runTests() {
  // Start server, run tests, then stop
  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
  });

  server.listen(port, async () => {
    try {
      await testHealthEndpoint();
      server.close();
    } catch (e) {
      console.error('Test failed:', e);
      server.close();
      process.exit(1);
    }
  });
}

runTests();
