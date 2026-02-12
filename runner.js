const http = require('http');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = Number(process.env.RUNNER_PORT || 5050);
const EXAMPLE_SPEC = 'tests/2. Regression/navigation.spec.js';
const MAX_LOG_LINES = 2000;

let runState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  lastError: null,
  currentSpec: null,
  currentTest: null,
  testResults: [],
  logs: [],
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

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function appendLog(line, stream = 'stdout') {
  const entry = {
    ts: new Date().toISOString(),
    stream,
    line,
  };
  runState.logs.push(entry);
  if (runState.logs.length > MAX_LOG_LINES) {
    runState.logs.splice(0, runState.logs.length - MAX_LOG_LINES);
  }
}

function upsertTestResult(testName, status, duration) {
  const idx = runState.testResults.findIndex((x) => x.test === testName);
  const updated = {
    test: testName,
    status,
    duration: duration || null,
    updatedAt: new Date().toISOString(),
  };
  if (idx === -1) {
    runState.testResults.push(updated);
  } else {
    runState.testResults[idx] = { ...runState.testResults[idx], ...updated };
  }
}

function parseOutputLine(rawLine) {
  const clean = stripAnsi(String(rawLine || '')).replace(/\r/g, '').trimEnd();
  if (!clean) return;

  // Current running test from line reporter style: [1/4] tests/...spec.js:3:1 > title
  const currentMatch = clean.match(/\[\d+\/\d+\]\s+(.+?\.spec\.[jt]s(?::\d+:\d+)?\s+[›>]\s+.+)$/);
  if (currentMatch) {
    runState.currentTest = currentMatch[1].trim();
    upsertTestResult(runState.currentTest, 'running');
  }

  // Pass/fail lines from list/line style.
  // e.g. "✓  1 tests/...spec.js:3:1 › title (1.2s)"
  const resultMatch = clean.match(/([✓✘x])\s+\d+\s+(.+?\.spec\.[jt]s(?::\d+:\d+)?\s+[›>]\s+.+?)\s+\(([^)]+)\)$/i);
  if (resultMatch) {
    const symbol = resultMatch[1].toLowerCase();
    const testName = resultMatch[2].trim();
    const duration = resultMatch[3].trim();
    const status = symbol === '✓' ? 'passed' : 'failed';
    upsertTestResult(testName, status, duration);
    runState.currentTest = null;
  }

  // Fallback: plain "ok" and "failed" line reporter summary per test.
  // e.g. "ok 1 [chromium] › tests/...spec.js:3:1 › title (1.2s)"
  const okMatch = clean.match(/^ok\s+\d+\s+.+?\s+[›>]\s+(.+?)\s+\(([^)]+)\)$/i);
  if (okMatch) {
    upsertTestResult(okMatch[1].trim(), 'passed', okMatch[2].trim());
    runState.currentTest = null;
  }

  const failedMatch = clean.match(/^\d+\)\s+.+?\s+[›>]\s+(.+)$/);
  if (failedMatch) {
    upsertTestResult(failedMatch[1].trim(), 'failed');
    runState.currentTest = null;
  }
}

function streamOutput(stream, streamName) {
  let buffer = '';
  stream.on('data', (chunk) => {
    const text = String(chunk);
    process[streamName === 'stderr' ? 'stderr' : 'stdout'].write(chunk);

    buffer += text;
    const lines = buffer.split(/\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      appendLog(stripAnsi(line), streamName);
      parseOutputLine(line);
    }
  });

  stream.on('end', () => {
    if (buffer) {
      appendLog(stripAnsi(buffer), streamName);
      parseOutputLine(buffer);
      buffer = '';
    }
  });
}

function startPlaywrightRun(spec) {
  const hasSpec = typeof spec === 'string' && spec.trim().length > 0;
  const targetSpec = hasSpec ? spec.trim() : null;
  const args = hasSpec
    ? ['playwright', 'test', targetSpec, '--headed', '--reporter=line']
    : ['playwright', 'test', '--headed', '--reporter=line'];

  runState = {
    ...runState,
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    lastError: null,
    currentSpec: targetSpec || 'ALL',
    currentTest: null,
    testResults: [],
    logs: [],
  };

  appendLog(`[runner] Starting Playwright run: npx ${args.join(' ')}`, 'system');
  console.log(`[runner] Starting Playwright run: npx ${args.join(' ')}`);

  const child = spawn('npx', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  streamOutput(child.stdout, 'stdout');
  streamOutput(child.stderr, 'stderr');

  child.on('exit', (code) => {
    runState = {
      ...runState,
      running: false,
      finishedAt: new Date().toISOString(),
      exitCode: code,
      currentTest: null,
    };
    appendLog(`[runner] Playwright finished with exit code: ${code}`, 'system');
    console.log(`[runner] Playwright finished with exit code: ${code}`);
  });

  child.on('error', (err) => {
    runState = {
      ...runState,
      running: false,
      finishedAt: new Date().toISOString(),
      exitCode: 1,
      lastError: err.message,
      currentTest: null,
    };
    appendLog(`[runner] Failed to start Playwright: ${err.message}`, 'system');
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
      :root {
        --bg: #0b0f14;
        --card: #121923;
        --text: #e6edf3;
        --muted: #95a1ad;
        --line: #223044;
        --accent: #d94a46;
        --ok: #2ea043;
        --bad: #f85149;
        --run: #58a6ff;
      }
      body { font-family: Arial, sans-serif; margin: 0; background: var(--bg); color: var(--text); }
      .wrap { max-width: 1100px; margin: 24px auto; padding: 0 16px; }
      .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
      h1 { margin: 0 0 12px; }
      .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      input { flex: 1; min-width: 280px; padding: 10px; border: 1px solid #2f3f57; border-radius: 8px; background: #0f1621; color: var(--text); }
      button { background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 10px 14px; cursor: pointer; font-weight: 700; }
      button:disabled { opacity: 0.65; cursor: not-allowed; }
      .badge { display: inline-block; padding: 4px 8px; border-radius: 999px; font-weight: 700; font-size: 12px; }
      .running { background: #12233d; color: var(--run); }
      .passed { background: #0f2a1b; color: var(--ok); }
      .failed { background: #3a1616; color: var(--bad); }
      .idle { background: #1f2937; color: #9ca3af; }
      .muted { color: var(--muted); }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
      table { width: 100%; border-collapse: collapse; font-size: 14px; }
      th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
      pre { margin: 0; white-space: pre-wrap; word-break: break-word; background: #081021; color: #d1fae5; border-radius: 8px; padding: 12px; max-height: 360px; overflow: auto; font-size: 12px; border: 1px solid #1f2b3d; }
      .kv { margin: 4px 0; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>Playwright Runner</h1>
        <div class="row">
          <input id="spec" name="spec" placeholder="Leave blank to run all tests" />
          <button id="run" type="button">Trigger Run</button>
        </div>
        <div class="row" style="margin-top:10px;">
          <span id="statusBadge" class="badge idle">IDLE</span>
          <span class="muted" id="statusText">Waiting for trigger</span>
        </div>
      </div>

      <div class="grid">
        <div class="card">
          <h3 style="margin-top:0;">Run State</h3>
          <div class="kv"><strong>Current Spec:</strong> <span id="currentSpec" class="mono">-</span></div>
          <div class="kv"><strong>Current Test:</strong> <span id="currentTest" class="mono">-</span></div>
          <div class="kv"><strong>Started:</strong> <span id="startedAt" class="mono">-</span></div>
          <div class="kv"><strong>Finished:</strong> <span id="finishedAt" class="mono">-</span></div>
          <div class="kv"><strong>Exit Code:</strong> <span id="exitCode" class="mono">-</span></div>
          <div class="kv"><strong>Error:</strong> <span id="lastError" class="mono">-</span></div>
        </div>

        <div class="card">
          <h3 style="margin-top:0;">Per-Test Results</h3>
          <table>
            <thead>
              <tr><th>Status</th><th>Test</th><th>Duration</th></tr>
            </thead>
            <tbody id="resultsBody">
              <tr><td colspan="3" class="muted">No test results yet.</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h3 style="margin-top:0;">Live Logs</h3>
        <pre id="logs">Waiting for logs...</pre>
      </div>
    </div>

    <script>
      const statusBadge = document.getElementById('statusBadge');
      const statusText = document.getElementById('statusText');
      const runBtn = document.getElementById('run');
      const specInput = document.getElementById('spec');
      const logsPre = document.getElementById('logs');

      function statusClass(state) {
        if (state.running) return 'running';
        if (typeof state.exitCode === 'number') return state.exitCode === 0 ? 'passed' : 'failed';
        return 'idle';
      }

      function statusLabel(state) {
        if (state.running) return 'IN PROGRESS';
        if (typeof state.exitCode === 'number') return state.exitCode === 0 ? 'PASSED' : 'FAILED';
        return 'IDLE';
      }

      function safe(v) {
        return v === null || v === undefined || v === '' ? '-' : String(v);
      }

      function renderResults(results) {
        const tbody = document.getElementById('resultsBody');
        if (!Array.isArray(results) || results.length === 0) {
          tbody.innerHTML = '<tr><td colspan="3" class="muted">No test results yet.</td></tr>';
          return;
        }
        tbody.innerHTML = results.map((r) => {
          const cls = r.status === 'passed' ? 'passed' : r.status === 'failed' ? 'failed' : 'running';
          return '<tr>' +
            '<td><span class="badge ' + cls + '">' + safe(r.status).toUpperCase() + '</span></td>' +
            '<td class="mono">' + safe(r.test) + '</td>' +
            '<td class="mono">' + safe(r.duration) + '</td>' +
          '</tr>';
        }).join('');
      }

      function renderLogs(logs) {
        if (!Array.isArray(logs) || logs.length === 0) {
          logsPre.textContent = 'No logs yet.';
          return;
        }
        logsPre.textContent = logs.map((l) => '[' + l.ts + '][' + l.stream + '] ' + l.line).join('\\n');
        logsPre.scrollTop = logsPre.scrollHeight;
      }

      async function refreshStatus() {
        let res;
        let data;
        try {
          res = await fetch('/status');
          data = await res.json();
        } catch (err) {
          statusBadge.className = 'badge failed';
          statusBadge.textContent = 'ERROR';
          statusText.textContent = 'Failed to fetch status: ' + (err && err.message ? err.message : err);
          return;
        }

        const cls = statusClass(data);
        statusBadge.className = 'badge ' + cls;
        statusBadge.textContent = statusLabel(data);
        statusText.textContent = data.running
          ? ('Running now. Current test: ' + safe(data.currentTest))
          : ('Last run exit code: ' + safe(data.exitCode));

        document.getElementById('currentSpec').textContent = safe(data.currentSpec);
        document.getElementById('currentTest').textContent = safe(data.currentTest);
        document.getElementById('startedAt').textContent = safe(data.startedAt);
        document.getElementById('finishedAt').textContent = safe(data.finishedAt);
        document.getElementById('exitCode').textContent = safe(data.exitCode);
        document.getElementById('lastError').textContent = safe(data.lastError);

        renderResults(data.testResults);
        renderLogs(data.logs);

        runBtn.disabled = !!data.running;
      }

      async function trigger() {
        runBtn.disabled = true;
        const originalText = runBtn.textContent;
        runBtn.textContent = 'Starting...';
        statusText.textContent = 'Sending trigger request...';

        const spec = specInput.value.trim();
        const query = spec ? ('?spec=' + encodeURIComponent(spec)) : '';

        try {
          const res = await fetch('/trigger' + query);
          const data = await res.json();
          if (!res.ok) {
            statusText.textContent = data.message || 'Failed to trigger run';
            alert(data.message || 'Failed to trigger run');
          } else {
            statusText.textContent = 'Run triggered. Waiting for runner state...';
          }
        } catch (err) {
          const msg = 'Trigger request failed: ' + (err && err.message ? err.message : err);
          statusText.textContent = msg;
          alert(msg);
        } finally {
          runBtn.textContent = originalText;
          await refreshStatus();
        }
      }

      runBtn.addEventListener('click', trigger);
      refreshStatus();
      setInterval(refreshStatus, 1000);
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
  console.log(`[runner] Open dashboard: http://${HOST}:${PORT}/ui`);
  console.log(`[runner] Trigger all:    curl -X POST http://${HOST}:${PORT}/trigger`);
});
