const http = require('http');
const { spawn } = require('child_process');
const os = require('os');

const HOST = process.env.RUNNER_HOST || '0.0.0.0';
const PORT = Number(process.env.RUNNER_PORT || 5050);
const RUNNER_BROWSER_MODE = (process.env.RUNNER_BROWSER_MODE || 'headed').toLowerCase();
const RUNNER_PUBLIC_HOST =
  process.env.RUNNER_PUBLIC_HOST || `${(os.hostname() || 'testing-automation').toLowerCase()}.local`;
const EXAMPLE_SPEC = 'tests/2. Regression/navigation.spec.js';
const MAX_LOG_LINES = 2000;

let currentChild = null;

function createIdleState(overrides = {}) {
  return {
    running: false,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    lastError: null,
    currentSpec: null,
    browserMode: RUNNER_BROWSER_MODE === 'headless' ? 'headless' : 'headed',
    currentTest: null,
    currentDetail: null,
    structuredEventsSeen: false,
    testResults: [],
    logs: [],
    ...overrides,
  };
}

let runState = createIdleState();
let authState = {
  awaiting: null, // "credentials" | "otp" | null
  requestedBy: null,
  requestedDetail: null,
  credentials: null, // { email, password }
  otp: null, // { code }
  updatedAt: null,
};

function updateAuthState(patch) {
  authState = {
    ...authState,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

function clearAuthState() {
  authState = {
    awaiting: null,
    requestedBy: null,
    requestedDetail: null,
    credentials: null,
    otp: null,
    updatedAt: new Date().toISOString(),
  };
}

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
      if (body.length > 1_000_000) reject(new Error('Request body too large'));
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
  const entry = { ts: new Date().toISOString(), stream, line };
  runState.logs.push(entry);
  if (runState.logs.length > MAX_LOG_LINES) {
    runState.logs.splice(0, runState.logs.length - MAX_LOG_LINES);
  }
}

function upsertTestResult(testName, status, durationMs, error) {
  const idx = runState.testResults.findIndex((x) => x.test === testName);
  const updated = {
    test: testName,
    status,
    durationMs: typeof durationMs === 'number' ? durationMs : (idx >= 0 ? runState.testResults[idx].durationMs : null),
    error: typeof error === 'string' && error.trim() ? error : (idx >= 0 ? runState.testResults[idx].error || null : null),
    updatedAt: new Date().toISOString(),
  };
  if (idx === -1) runState.testResults.push(updated);
  else runState.testResults[idx] = { ...runState.testResults[idx], ...updated };
}

function finalizeAnyRunningTests(status) {
  runState.testResults = runState.testResults.map((t) => {
    if (t.status === 'running') return { ...t, status };
    return t;
  });
}

function parseE2EEvent(cleanLine) {
  const m = cleanLine.match(/\[E2E_EVENT\]\s+(.+)$/);
  if (!m) return false;

  try {
    const evt = JSON.parse(m[1]);
    if (!evt || !evt.type) return true;
    runState.structuredEventsSeen = true;

    if (evt.type === 'test_start' && evt.test) {
      runState.currentTest = evt.test;
      runState.currentDetail = 'Starting test';
      upsertTestResult(evt.test, 'running');
      return true;
    }

    if (evt.type === 'step' && evt.test) {
      runState.currentTest = evt.test;
      runState.currentDetail = evt.detail || null;
      upsertTestResult(evt.test, 'running');
      return true;
    }

    if (evt.type === 'test_end' && evt.test) {
      const mapped = evt.status === 'passed' ? 'passed' : evt.status === 'skipped' ? 'canceled' : 'failed';
      upsertTestResult(evt.test, mapped, typeof evt.durationMs === 'number' ? evt.durationMs : null, evt.error || null);
      if (runState.currentTest === evt.test) {
        runState.currentTest = null;
        runState.currentDetail = null;
      }
      return true;
    }
  } catch {
    // ignore malformed event payload
  }

  return true;
}

function parseOutputLine(rawLine) {
  const clean = stripAnsi(String(rawLine || '')).replace(/\r/g, '').trimEnd();
  if (!clean) return;

  if (parseE2EEvent(clean)) return;
  if (runState.structuredEventsSeen) return;

  const currentMatch = clean.match(/\[\d+\/\d+\]\s+(.+?\.spec\.[jt]s(?::\d+:\d+)?\s+[›>]\s+.+)$/);
  if (currentMatch) {
    runState.currentTest = currentMatch[1].trim();
    runState.currentDetail = 'Playwright reporter running';
    upsertTestResult(runState.currentTest, 'running');
  }

  const resultMatch = clean.match(/([✓✘x])\s+\d+\s+(.+?\.spec\.[jt]s(?::\d+:\d+)?\s+[›>]\s+.+?)\s+\(([^)]+)\)$/i);
  if (resultMatch) {
    const symbol = resultMatch[1].toLowerCase();
    const testName = resultMatch[2].trim();
    const status = symbol === '✓' ? 'passed' : 'failed';
    upsertTestResult(testName, status);
    runState.currentTest = null;
    runState.currentDetail = null;
  }

  const okMatch = clean.match(/^ok\s+\d+\s+.+?\s+[›>]\s+(.+?)\s+\(([^)]+)\)$/i);
  if (okMatch) {
    upsertTestResult(okMatch[1].trim(), 'passed');
    runState.currentTest = null;
    runState.currentDetail = null;
  }

  const failedMatch = clean.match(/^\d+\)\s+.+?\s+[›>]\s+(.+)$/);
  if (failedMatch) {
    upsertTestResult(failedMatch[1].trim(), 'failed');
    runState.currentTest = null;
    runState.currentDetail = null;
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
    }
  });
}

function startPlaywrightRun(spec) {
  const hasSpec = typeof spec === 'string' && spec.trim().length > 0;
  const targetSpec = hasSpec ? spec.trim() : null;
  const isHeadless = RUNNER_BROWSER_MODE === 'headless';
  const args = hasSpec
    ? ['playwright', 'test', targetSpec, '--reporter=line']
    : ['playwright', 'test', '--reporter=line'];
  if (!isHeadless) args.push('--headed');

  runState = createIdleState({
    running: true,
    startedAt: new Date().toISOString(),
    currentSpec: targetSpec || 'ALL',
    browserMode: isHeadless ? 'headless' : 'headed',
  });
  clearAuthState();

  appendLog(`[runner] Starting Playwright run: npx ${args.join(' ')}`, 'system');
  console.log(`[runner] Starting Playwright run: npx ${args.join(' ')}`);

  currentChild = spawn('npx', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PLAYWRIGHT_HEADLESS: isHeadless ? '1' : '0',
      E2E_HEADLESS: isHeadless ? '1' : '0',
      RUNNER_INTERNAL_URL: `http://127.0.0.1:${PORT}`,
    },
  });

  streamOutput(currentChild.stdout, 'stdout');
  streamOutput(currentChild.stderr, 'stderr');

  currentChild.on('exit', (code) => {
    runState.running = false;
    runState.finishedAt = new Date().toISOString();
    runState.exitCode = code;
    runState.currentTest = null;
    runState.currentDetail = null;

    if (code === 0) finalizeAnyRunningTests('passed');
    else finalizeAnyRunningTests('failed');

    appendLog(`[runner] Playwright finished with exit code: ${code}`, 'system');
    console.log(`[runner] Playwright finished with exit code: ${code}`);
    currentChild = null;
  });

  currentChild.on('error', (err) => {
    runState.running = false;
    runState.finishedAt = new Date().toISOString();
    runState.exitCode = 1;
    runState.lastError = err.message;
    runState.currentTest = null;
    runState.currentDetail = null;
    finalizeAnyRunningTests('failed');

    appendLog(`[runner] Failed to start Playwright: ${err.message}`, 'system');
    console.error(`[runner] Failed to start Playwright: ${err.message}`);
    currentChild = null;
  });
}

function stopCurrentRun() {
  if (!currentChild || !runState.running) {
    return { ok: false, message: 'No run is currently active.' };
  }

  try {
    currentChild.kill('SIGTERM');
    runState.running = false;
    runState.finishedAt = new Date().toISOString();
    runState.exitCode = 130;
    runState.lastError = 'Run stopped by user';
    runState.currentTest = null;
    runState.currentDetail = null;
    finalizeAnyRunningTests('canceled');
    clearAuthState();
    appendLog('[runner] Run stopped by user', 'system');
    return { ok: true, message: 'Run stop requested.' };
  } catch (err) {
    return { ok: false, message: `Failed to stop run: ${err.message}` };
  }
}

function clearRunnerState() {
  if (runState.running) {
    return { ok: false, message: 'Cannot clear while a run is active. Stop it first.' };
  }
  runState = createIdleState();
  clearAuthState();
  return { ok: true, message: 'Runner state cleared.' };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/ui') {
    return sendHtml(res, 200, `<!doctype html>
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
      button.secondary { background: #334155; }
      button.warn { background: #b91c1c; }
      button:disabled { opacity: 0.65; cursor: not-allowed; }
      .badge { display: inline-block; padding: 4px 8px; border-radius: 999px; font-weight: 700; font-size: 12px; }
      .running { background: #12233d; color: var(--run); }
      .passed { background: #0f2a1b; color: var(--ok); }
      .failed { background: #3a1616; color: var(--bad); }
      .idle { background: #1f2937; color: #9ca3af; }
      .canceled { background: #3f2d16; color: #f59e0b; }
      .muted { color: var(--muted); }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
      table { width: 100%; border-collapse: collapse; font-size: 14px; }
      th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
      pre { margin: 0; white-space: pre-wrap; word-break: break-word; background: #081021; color: #d1fae5; border-radius: 8px; padding: 12px; max-height: 360px; overflow: auto; font-size: 12px; border: 1px solid #1f2b3d; }
      .kv { margin: 4px 0; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      details summary { cursor: pointer; color: #fca5a5; font-weight: 700; }
      .error-box { margin-top: 6px; background: #220f14; border: 1px solid #55202a; border-radius: 6px; padding: 8px; white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow: auto; font-size: 12px; }
      .auth-modal { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); display: none; align-items: center; justify-content: center; z-index: 9999; }
      .auth-modal.show { display: flex; }
      .auth-card { width: min(520px, 92vw); background: #111827; border: 1px solid #334155; border-radius: 12px; padding: 16px; }
      .auth-title { margin: 0 0 8px 0; font-size: 20px; }
      .auth-field { margin-top: 10px; display: grid; gap: 6px; }
      .auth-help { color: #9ca3af; font-size: 13px; margin-top: 6px; }
      .auth-actions { margin-top: 14px; display: flex; gap: 10px; }
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
          <button id="stop" type="button" class="warn">Stop Current</button>
          <button id="clear" type="button" class="secondary">Clear</button>
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
          <div class="kv"><strong>Browser Mode:</strong> <span id="browserMode" class="mono">-</span></div>
          <div class="kv"><strong>Current Test:</strong> <span id="currentTest" class="mono">-</span></div>
          <div class="kv"><strong>Current Detail:</strong> <span id="currentDetail" class="mono">-</span></div>
          <div class="kv"><strong>Started:</strong> <span id="startedAt" class="mono">-</span></div>
          <div class="kv"><strong>Finished:</strong> <span id="finishedAt" class="mono">-</span></div>
          <div class="kv"><strong>Exit Code:</strong> <span id="exitCode" class="mono">-</span></div>
          <div class="kv"><strong>Error:</strong> <span id="lastError" class="mono">-</span></div>
        </div>

        <div class="card">
          <h3 style="margin-top:0;">Per-Test Results</h3>
          <table>
            <thead>
              <tr><th>Test</th><th>Result</th><th>Duration (ms)</th></tr>
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

    <div id="authModal" class="auth-modal">
      <div class="auth-card">
        <h3 class="auth-title" id="authTitle">Authentication Required</h3>
        <div class="auth-help" id="authHelp">Provide requested authentication data to continue headless run.</div>

        <div id="credentialsForm" style="display:none;">
          <div class="auth-field">
            <label for="authEmail">Email</label>
            <input id="authEmail" type="email" autocomplete="username" />
          </div>
          <div class="auth-field">
            <label for="authPassword">Password</label>
            <input id="authPassword" type="password" autocomplete="current-password" />
          </div>
          <div class="auth-actions">
            <button id="submitCredentials" type="button">Send Credentials</button>
          </div>
        </div>

        <div id="otpForm" style="display:none;">
          <div class="auth-field">
            <label for="authOtp">Authentication Code</label>
            <input id="authOtp" type="text" inputmode="numeric" autocomplete="one-time-code" />
          </div>
          <div class="auth-actions">
            <button id="submitOtp" type="button">Send Code</button>
          </div>
        </div>
      </div>
    </div>

    <script>
      const statusBadge = document.getElementById('statusBadge');
      const statusText = document.getElementById('statusText');
      const runBtn = document.getElementById('run');
      const stopBtn = document.getElementById('stop');
      const clearBtn = document.getElementById('clear');
      const specInput = document.getElementById('spec');
      const logsPre = document.getElementById('logs');
      const authModal = document.getElementById('authModal');
      const authTitle = document.getElementById('authTitle');
      const authHelp = document.getElementById('authHelp');
      const credentialsForm = document.getElementById('credentialsForm');
      const otpForm = document.getElementById('otpForm');
      const authEmail = document.getElementById('authEmail');
      const authPassword = document.getElementById('authPassword');
      const authOtp = document.getElementById('authOtp');
      const submitCredentialsBtn = document.getElementById('submitCredentials');
      const submitOtpBtn = document.getElementById('submitOtp');

      function statusClass(state) {
        if (state.running) return 'running';
        if (state.lastError === 'Run stopped by user') return 'canceled';
        if (typeof state.exitCode === 'number') return state.exitCode === 0 ? 'passed' : 'failed';
        return 'idle';
      }

      function statusLabel(state) {
        if (state.running) return 'IN PROGRESS';
        if (state.lastError === 'Run stopped by user') return 'CANCELED';
        if (typeof state.exitCode === 'number') return state.exitCode === 0 ? 'PASSED' : 'FAILED';
        return 'IDLE';
      }

      function safe(v) {
        return v === null || v === undefined || v === '' ? '-' : String(v);
      }

      function esc(v) {
        return safe(v)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      function renderResults(results) {
        const tbody = document.getElementById('resultsBody');
        if (!Array.isArray(results) || results.length === 0) {
          tbody.innerHTML = '<tr><td colspan="3" class="muted">No test results yet.</td></tr>';
          return;
        }

        tbody.innerHTML = results.map((r) => {
          const cls = r.status === 'passed' ? 'passed' : r.status === 'failed' ? 'failed' : r.status === 'canceled' ? 'canceled' : 'running';
          const errorHtml = r.error
            ? '<details><summary>Show failure reason</summary><div class="error-box mono">' + esc(r.error) + '</div></details>'
            : '';
          return '<tr>' +
            '<td class="mono">' + esc(r.test) + errorHtml + '</td>' +
            '<td><span class="badge ' + cls + '">' + esc(r.status).toUpperCase() + '</span></td>' +
            '<td class="mono">' + esc(r.durationMs) + '</td>' +
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

      function setAuthMode(auth) {
        const awaiting = auth && auth.awaiting ? auth.awaiting : null;
        if (!awaiting) {
          authModal.classList.remove('show');
          credentialsForm.style.display = 'none';
          otpForm.style.display = 'none';
          return;
        }

        authModal.classList.add('show');
        if (awaiting === 'credentials') {
          authTitle.textContent = 'Login Required';
          authHelp.textContent = (auth && auth.requestedDetail) ? auth.requestedDetail : 'Enter email and password for the test login.';
          credentialsForm.style.display = 'block';
          otpForm.style.display = 'none';
          authEmail.focus();
        } else if (awaiting === 'otp') {
          authTitle.textContent = 'Authentication Code Required';
          authHelp.textContent = (auth && auth.requestedDetail) ? auth.requestedDetail : 'Enter the one-time authentication code.';
          credentialsForm.style.display = 'none';
          otpForm.style.display = 'block';
          authOtp.focus();
        }
      }

      async function submitCredentials() {
        const email = authEmail.value.trim();
        const password = authPassword.value;
        if (!email || !password) {
          alert('Email and password are required.');
          return;
        }
        submitCredentialsBtn.disabled = true;
        try {
          const res = await fetch('/auth/credentials', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
          });
          const data = await res.json();
          if (!res.ok) {
            alert(data.message || 'Failed to submit credentials');
            return;
          }
          authPassword.value = '';
          await refreshStatus();
        } finally {
          submitCredentialsBtn.disabled = false;
        }
      }

      async function submitOtp() {
        const code = authOtp.value.trim();
        if (!code) {
          alert('Authentication code is required.');
          return;
        }
        submitOtpBtn.disabled = true;
        try {
          const res = await fetch('/auth/otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
          });
          const data = await res.json();
          if (!res.ok) {
            alert(data.message || 'Failed to submit code');
            return;
          }
          authOtp.value = '';
          await refreshStatus();
        } finally {
          submitOtpBtn.disabled = false;
        }
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
          ? ('Running: ' + safe(data.currentTest) + ' | ' + safe(data.currentDetail))
          : ('Last run exit code: ' + safe(data.exitCode));

        document.getElementById('currentSpec').textContent = safe(data.currentSpec);
        document.getElementById('browserMode').textContent = safe(data.browserMode);
        document.getElementById('currentTest').textContent = safe(data.currentTest);
        document.getElementById('currentDetail').textContent = safe(data.currentDetail);
        document.getElementById('startedAt').textContent = safe(data.startedAt);
        document.getElementById('finishedAt').textContent = safe(data.finishedAt);
        document.getElementById('exitCode').textContent = safe(data.exitCode);
        document.getElementById('lastError').textContent = safe(data.lastError);

        renderResults(data.testResults);
        renderLogs(data.logs);
        setAuthMode(data.auth);

        runBtn.disabled = !!data.running;
        stopBtn.disabled = !data.running;
        clearBtn.disabled = !!data.running;
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

      async function stopRun() {
        try {
          const res = await fetch('/stop');
          const data = await res.json();
          if (!res.ok) alert(data.message || 'Failed to stop run');
        } catch (err) {
          alert('Stop request failed: ' + (err && err.message ? err.message : err));
        } finally {
          await refreshStatus();
        }
      }

      async function clearState() {
        try {
          const res = await fetch('/clear');
          const data = await res.json();
          if (!res.ok) alert(data.message || 'Failed to clear state');
        } catch (err) {
          alert('Clear request failed: ' + (err && err.message ? err.message : err));
        } finally {
          await refreshStatus();
        }
      }

      runBtn.addEventListener('click', trigger);
      stopBtn.addEventListener('click', stopRun);
      clearBtn.addEventListener('click', clearState);
      submitCredentialsBtn.addEventListener('click', submitCredentials);
      submitOtpBtn.addEventListener('click', submitOtp);
      refreshStatus();
      setInterval(refreshStatus, 500);
    </script>
  </body>
</html>`);
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    return sendJson(res, 200, {
      ok: true,
      ...runState,
      auth: {
        awaiting: authState.awaiting,
        requestedBy: authState.requestedBy,
        requestedDetail: authState.requestedDetail,
        hasCredentials: !!authState.credentials,
        hasOtp: !!authState.otp,
        updatedAt: authState.updatedAt,
      },
      publicHost: RUNNER_PUBLIC_HOST,
      dashboardUrl: `http://${RUNNER_PUBLIC_HOST}:${PORT}/ui`,
      usage: {
        triggerAll: `curl -X POST http://${HOST}:${PORT}/trigger`,
        triggerWithSpec: `curl -X POST http://${HOST}:${PORT}/trigger -H "Content-Type: application/json" -d '{"spec":"${EXAMPLE_SPEC}"}'`,
        stop: `curl http://${HOST}:${PORT}/stop`,
        clear: `curl http://${HOST}:${PORT}/clear`,
        authCredentials: `curl -X POST http://${HOST}:${PORT}/auth/credentials -H "Content-Type: application/json" -d '{"email":"you@example.com","password":"***"}'`,
        authOtp: `curl -X POST http://${HOST}:${PORT}/auth/otp -H "Content-Type: application/json" -d '{"code":"123456"}'`,
      },
    });
  }

  if (req.method === 'POST' && url.pathname === '/auth/request') {
    try {
      const body = await parseJsonBody(req);
      const kind = body.kind === 'otp' ? 'otp' : body.kind === 'credentials' ? 'credentials' : null;
      if (!kind) return sendJson(res, 400, { ok: false, message: 'Invalid auth request kind.' });

      updateAuthState({
        awaiting: kind,
        requestedBy: body.test || null,
        requestedDetail: body.detail || null,
      });
      return sendJson(res, 200, { ok: true, awaiting: authState.awaiting });
    } catch (err) {
      return sendJson(res, 400, { ok: false, message: err.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/auth/credentials') {
    try {
      const body = await parseJsonBody(req);
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!email || !password) return sendJson(res, 400, { ok: false, message: 'Email and password are required.' });

      updateAuthState({
        credentials: { email, password },
      });
      return sendJson(res, 200, { ok: true, message: 'Credentials received.' });
    } catch (err) {
      return sendJson(res, 400, { ok: false, message: err.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/auth/otp') {
    try {
      const body = await parseJsonBody(req);
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (!code) return sendJson(res, 400, { ok: false, message: 'Authentication code is required.' });

      updateAuthState({
        otp: { code },
      });
      return sendJson(res, 200, { ok: true, message: 'Authentication code received.' });
    } catch (err) {
      return sendJson(res, 400, { ok: false, message: err.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/auth/consume') {
    const kind = url.searchParams.get('kind');
    if (kind === 'credentials') {
      const value = authState.credentials;
      if (!value) return sendJson(res, 200, { ok: true, available: false });
      updateAuthState({
        awaiting: null,
        requestedBy: null,
        requestedDetail: null,
        credentials: null,
      });
      return sendJson(res, 200, { ok: true, available: true, email: value.email, password: value.password });
    }

    if (kind === 'otp') {
      const value = authState.otp;
      if (!value) return sendJson(res, 200, { ok: true, available: false });
      updateAuthState({
        awaiting: null,
        requestedBy: null,
        requestedDetail: null,
        otp: null,
      });
      return sendJson(res, 200, { ok: true, available: true, code: value.code });
    }

    return sendJson(res, 400, { ok: false, message: 'Invalid consume kind.' });
  }

  if (req.method === 'GET' && url.pathname === '/auth/clear') {
    clearAuthState();
    return sendJson(res, 200, { ok: true, message: 'Auth state cleared.' });
  }

  if (req.method === 'GET' && url.pathname === '/trigger') {
    if (runState.running) {
      return sendJson(res, 409, { ok: false, message: 'A Playwright run is already in progress.', state: runState });
    }
    const spec = url.searchParams.get('spec') || '';
    startPlaywrightRun(spec);
    return sendJson(res, 202, { ok: true, message: 'Playwright run started.', spec: spec || 'ALL' });
  }

  if (req.method === 'POST' && url.pathname === '/trigger') {
    if (runState.running) {
      return sendJson(res, 409, { ok: false, message: 'A Playwright run is already in progress.', state: runState });
    }

    try {
      const body = await parseJsonBody(req);
      const spec = typeof body.spec === 'string' && body.spec.trim() ? body.spec.trim() : '';
      startPlaywrightRun(spec);
      return sendJson(res, 202, { ok: true, message: 'Playwright run started.', spec: spec || 'ALL' });
    } catch (err) {
      return sendJson(res, 400, { ok: false, message: err.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/stop') {
    const result = stopCurrentRun();
    return sendJson(res, result.ok ? 200 : 409, result);
  }

  if (req.method === 'GET' && url.pathname === '/clear') {
    const result = clearRunnerState();
    return sendJson(res, result.ok ? 200 : 409, result);
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return sendJson(res, 200, {
      ok: true,
      message: 'Runner is alive.',
      endpoints: [
        'GET /status',
        'GET /ui',
        'GET /trigger',
        'POST /trigger',
        'GET /stop',
        'GET /clear',
        'POST /auth/request',
        'POST /auth/credentials',
        'POST /auth/otp',
        'GET /auth/consume?kind=credentials|otp',
        'GET /auth/clear',
      ],
    });
  }

  return sendJson(res, 404, { ok: false, message: 'Not found' });
});

server.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const ipv4 = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ipv4.push(net.address);
    }
  }

  console.log(`[runner] Listening on http://${HOST}:${PORT}`);
  console.log(`[runner] Browser mode: ${RUNNER_BROWSER_MODE === 'headless' ? 'headless' : 'headed'}`);
  console.log(`[runner] Open dashboard (local): http://127.0.0.1:${PORT}/ui`);
  console.log(`[runner] Open dashboard (hostname): http://${RUNNER_PUBLIC_HOST}:${PORT}/ui`);
  if (ipv4.length) {
    console.log(`[runner] Open dashboard (LAN):   http://${ipv4[0]}:${PORT}/ui`);
  }
  console.log(`[runner] Trigger all:    curl -X POST http://${HOST}:${PORT}/trigger`);
});
