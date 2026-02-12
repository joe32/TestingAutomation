const http = require('http');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = Number(process.env.RUNNER_PORT || 5050);
const EXAMPLE_SPEC = 'tests/2. Regression/navigation.spec.js';

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

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
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
  const hasSpec = typeof spec === 'string' && spec.trim().length > 0;
  const targetSpec = hasSpec ? spec.trim() : null;
  const args = hasSpec ? ['playwright', 'test', targetSpec, '--headed'] : ['playwright', 'test', '--headed'];

  runState = {
    ...runState,
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    lastError: null,
    currentSpec: targetSpec || 'ALL',
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

  if (req.method === 'GET' && url.pathname === '/ui') {
    return sendHtml(
      res,
      200,
      `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Playwright Runner</title>
    <style>
      body { font-family: Arial, sans-serif; max-width: 760px; margin: 32px auto; padding: 0 16px; }
      button { background: #d94a46; color: #fff; border: 0; border-radius: 8px; padding: 10px 14px; cursor: pointer; font-weight: 700; }
      code, pre { background: #f5f5f5; padding: 2px 6px; border-radius: 4px; }
      .row { margin: 14px 0; }
      input { width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 6px; }
      .muted { color: #666; font-size: 14px; }
    </style>
  </head>
  <body>
    <h1>Playwright Runner</h1>
    <div class="row">
      <label>Spec file (optional)</label>
      <input id="spec" placeholder="Leave blank to run all tests" />
    </div>
    <div class="row">
      <button id="run">Trigger Run</button>
    </div>
    <div class="row">
      <strong>Status:</strong>
      <pre id="status">Loading...</pre>
    </div>
    <p class="muted">Use this page only after running <code>npm run runner:start</code>.</p>
    <script>
      async function refreshStatus() {
        const res = await fetch('/status');
        const data = await res.json();
        document.getElementById('status').textContent = JSON.stringify(data, null, 2);
      }
      async function trigger() {
        const spec = document.getElementById('spec').value.trim();
        const opts = spec
          ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spec }) }
          : { method: 'POST' };
        const res = await fetch('/trigger', opts);
        const data = await res.json();
        alert(JSON.stringify(data, null, 2));
        refreshStatus();
      }
      document.getElementById('run').addEventListener('click', trigger);
      refreshStatus();
      setInterval(refreshStatus, 2000);
    </script>
  </body>
</html>`
    );
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    return sendJson(res, 200, {
      ok: true,
      ...runState,
      usage: {
        triggerAll: `curl -X POST http://${HOST}:${PORT}/trigger`,
        triggerWithSpec: `curl -X POST http://${HOST}:${PORT}/trigger -H "Content-Type: application/json" -d '{"spec":"${EXAMPLE_SPEC}"}'`,
      },
    });
  }

  if (req.method === 'GET' && url.pathname === '/trigger') {
    if (runState.running) {
      return sendJson(res, 409, {
        ok: false,
        message: 'A Playwright run is already in progress.',
        state: runState,
      });
    }

    const spec = url.searchParams.get('spec') || '';
    startPlaywrightRun(spec);
    return sendJson(res, 202, {
      ok: true,
      message: 'Playwright run started.',
      spec: spec || 'ALL',
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
      const spec = typeof body.spec === 'string' && body.spec.trim() ? body.spec.trim() : '';
      startPlaywrightRun(spec);
      return sendJson(res, 202, {
        ok: true,
        message: 'Playwright run started.',
        spec: spec || 'ALL',
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
      endpoints: ['GET /status', 'GET /ui', 'GET /trigger', 'POST /trigger'],
    });
  }

  return sendJson(res, 404, { ok: false, message: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[runner] Listening on http://${HOST}:${PORT}`);
  console.log(`[runner] Check status: curl http://${HOST}:${PORT}/status`);
  console.log(`[runner] Trigger run:  curl -X POST http://${HOST}:${PORT}/trigger`);
});
