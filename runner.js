const http = require('http');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = Number(process.env.RUNNER_PORT || 5050);
const DEFAULT_SPEC = 'tests/regression/navigation.spec.js';

let runState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  lastError: null,
  currentSpec: null,
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function startPlaywrightRun(spec) {
  const targetSpec = spec || DEFAULT_SPEC;
  const args = ['playwright', 'test', targetSpec, '--headed'];

  runState = {
    ...runState,
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    lastError: null,
    currentSpec: targetSpec,
  };

  console.log(`[runner] Starting Playwright run: npx ${args.join(' ')}`);

  const child = spawn('npx', args, {
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });

  child.on('exit', (code) => {
    runState = {
      ...runState,
      running: false,
      finishedAt: new Date().toISOString(),
      exitCode: code,
    };
    console.log(`[runner] Playwright finished with exit code: ${code}`);
  });

  child.on('error', (err) => {
    runState = {
      ...runState,
      running: false,
      finishedAt: new Date().toISOString(),
      exitCode: 1,
      lastError: err.message,
    };
    console.error(`[runner] Failed to start Playwright: ${err.message}`);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/status') {
    return sendJson(res, 200, {
      ok: true,
      ...runState,
      usage: {
        trigger: `curl -X POST http://${HOST}:${PORT}/trigger`,
        triggerWithSpec: `curl -X POST http://${HOST}:${PORT}/trigger -H "Content-Type: application/json" -d '{"spec":"tests/regression/navigation.spec.js"}'`,
      },
    });
  }

  if (req.method === 'POST' && url.pathname === '/trigger') {
    if (runState.running) {
      return sendJson(res, 409, {
        ok: false,
        message: 'A Playwright run is already in progress.',
        state: runState,
      });
    }

    try {
      const body = await parseJsonBody(req);
      const spec = typeof body.spec === 'string' && body.spec.trim() ? body.spec.trim() : DEFAULT_SPEC;
      startPlaywrightRun(spec);
      return sendJson(res, 202, {
        ok: true,
        message: 'Playwright run started.',
        spec,
      });
    } catch (err) {
      return sendJson(res, 400, {
        ok: false,
        message: err.message,
      });
    }
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return sendJson(res, 200, {
      ok: true,
      message: 'Runner is alive.',
      endpoints: ['GET /status', 'POST /trigger'],
    });
  }

  return sendJson(res, 404, { ok: false, message: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[runner] Listening on http://${HOST}:${PORT}`);
  console.log(`[runner] Check status: curl http://${HOST}:${PORT}/status`);
  console.log(`[runner] Trigger run:  curl -X POST http://${HOST}:${PORT}/trigger`);
});
