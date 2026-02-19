const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 5050;
const DEFAULT_BASE_DOMAIN = 'app.bullet-ai.com';
const EXAMPLE_SPEC = 'tests/2. Regression/10-navigation.spec.js';
const MAX_LOG_LINES = 2000;
const TESTS_DIR = path.join(__dirname, 'tests');
const RUNNER_NAME_RE = /@runner-name:\s*(.+)$/im;
const RUNNER_CHILDREN_RE = /@runner-children:\s*(.+)$/im;

let currentChild = null;
const subtestTimers = new Map();

function createIdleState(overrides = {}) {
  return {
    running: false,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    lastError: null,
    currentSpec: null,
    selectedSpecs: [],
    selectedTasks: [],
    currentTest: null,
    currentDetail: null,
    baseDomain: DEFAULT_BASE_DOMAIN,
    testResults: [],
    logs: [],
    ...overrides,
  };
}

let runState = createIdleState();

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

function normalizeBaseDomain(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return DEFAULT_BASE_DOMAIN;

  let normalized = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!normalized) normalized = DEFAULT_BASE_DOMAIN;

  if (/[/?#\s]/.test(normalized)) {
    throw new Error('Base domain must be host only (example: app.bullet-ai.com)');
  }
  return normalized;
}

function appendLog(line, stream = 'stdout') {
  const entry = { ts: new Date().toISOString(), stream, line };
  runState.logs.push(entry);
  if (runState.logs.length > MAX_LOG_LINES) {
    runState.logs.splice(0, runState.logs.length - MAX_LOG_LINES);
  }
}

function upsertTestResult(key, status, durationMs, error, testNameOverride) {
  const idx = runState.testResults.findIndex((x) => x.key === key);
  const existing = idx >= 0 ? runState.testResults[idx] : null;
  const resolvedTestName = testNameOverride || (existing && existing.test) || key;
  const updated = {
    key,
    test: resolvedTestName,
    status,
    durationMs:
      typeof durationMs === 'number'
        ? durationMs
        : idx >= 0
          ? runState.testResults[idx].durationMs
          : null,
    error:
      typeof error === 'string' && error.trim()
        ? error
        : idx >= 0
          ? runState.testResults[idx].error || null
          : null,
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

function extractSpecIdFromEventTest(rawTest) {
  const clean = String(rawTest || '');
  const m = clean.match(/tests[\\/].+?\.spec\.[jt]s/i);
  if (!m) return null;
  return m[0].replaceAll('\\', '/');
}

function parseE2EEvent(cleanLine) {
  const m = cleanLine.match(/\[E2E_EVENT\]\s+(.+)$/);
  if (!m) return false;

  try {
    const evt = JSON.parse(m[1]);
    if (!evt || !evt.type) return true;

    if (evt.type === 'test_start' && evt.test) {
      runState.currentTest = evt.test;
      runState.currentDetail = 'Starting test';
      const specId = extractSpecIdFromEventTest(evt.test);
      const key = `${specId || evt.test}::__self`;
      const hasSubtestsPlanned = runState.testResults.some((r) => String(r.key || '').startsWith(`${specId}::`) && !String(r.key).endsWith('::__self'));
      if (!hasSubtestsPlanned) {
        upsertTestResult(key, 'running', null, null, evt.test);
      }
      return true;
    }

    if (evt.type === 'step' && evt.test) {
      if (!runState.currentTest) runState.currentTest = evt.test;
      runState.currentDetail = evt.detail || null;
      return true;
    }

    if (evt.type === 'subtest_start' && evt.test && evt.subtestId) {
      const specId = extractSpecIdFromEventTest(evt.test);
      const key = `${specId || evt.test}::${evt.subtestId}`;
      const label = evt.subtestName || evt.subtestId;
      runState.currentTest = label;
      runState.currentDetail = `Running ${label}`;
      subtestTimers.set(key, Date.now());
      upsertTestResult(key, 'running');
      return true;
    }

    if (evt.type === 'subtest_end' && evt.test && evt.subtestId) {
      const specId = extractSpecIdFromEventTest(evt.test);
      const key = `${specId || evt.test}::${evt.subtestId}`;
      const mapped = evt.status === 'passed' ? 'passed' : evt.status === 'skipped' ? 'canceled' : 'failed';
      const startedAt = subtestTimers.get(key);
      const calculatedDuration = typeof startedAt === 'number' ? (Date.now() - startedAt) : null;
      subtestTimers.delete(key);
      upsertTestResult(
        key,
        mapped,
        typeof evt.durationMs === 'number' ? evt.durationMs : calculatedDuration,
        evt.error || null
      );
      return true;
    }

    if (evt.type === 'test_end' && evt.test) {
      const mapped = evt.status === 'passed' ? 'passed' : evt.status === 'skipped' ? 'canceled' : 'failed';
      const specId = extractSpecIdFromEventTest(evt.test);
      const key = `${specId || evt.test}::__self`;
      const hasSubtestsPlanned = runState.testResults.some((r) => String(r.key || '').startsWith(`${specId}::`) && !String(r.key).endsWith('::__self'));
      if (!hasSubtestsPlanned) {
        upsertTestResult(key, mapped, typeof evt.durationMs === 'number' ? evt.durationMs : null, evt.error || null, evt.test);
      } else if (specId) {
        runState.testResults = runState.testResults.map((r) => {
          if (!String(r.key || '').startsWith(`${specId}::`)) return r;
          if (String(r.key).endsWith('::__self')) return r;
          if (r.status !== 'pending' && r.status !== 'running') return r;

          // If the test fails, only the already-executing failed subtest should be FAILED.
          // Subtests that never started are CANCELED.
          if (mapped === 'failed') {
            if (r.status === 'pending') {
              return { ...r, status: 'canceled' };
            }
            return { ...r, status: 'failed', error: evt.error || r.error || null };
          }

          return { ...r, status: mapped, error: mapped === 'failed' ? (evt.error || r.error || null) : r.error };
        });
      }
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

function walkSpecFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSpecFiles(full));
      continue;
    }
    if (/\.spec\.[cm]?[jt]s$/i.test(entry.name)) files.push(full);
  }
  return files;
}

function discoverTests() {
  if (!fs.existsSync(TESTS_DIR)) return [];

  const files = walkSpecFiles(TESTS_DIR).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return files.map((absPath) => {
    let displayName = path.basename(absPath);
    let children = [];
    try {
      const top = fs.readFileSync(absPath, 'utf8').split(/\r?\n/).slice(0, 30).join('\n');
      const m = top.match(RUNNER_NAME_RE);
      if (m && m[1]) displayName = m[1].trim();
      const childMatch = top.match(RUNNER_CHILDREN_RE);
      if (childMatch && childMatch[1]) {
        children = childMatch[1]
          .split(';')
          .map((chunk) => chunk.trim())
          .filter(Boolean)
          .map((chunk) => {
            const eq = chunk.indexOf('=');
            if (eq === -1) return { id: chunk, label: chunk, required: false };
            const id = chunk.slice(0, eq).trim();
            const label = chunk.slice(eq + 1).trim();
            const required = /\(required\)/i.test(label);
            return { id, label, required };
          });
      }
    } catch {
      // ignore parsing errors and fallback to filename
    }

    const rel = path.relative(__dirname, absPath).split(path.sep).join('/');
    if (!children.length) {
      children = [{ id: '__self', label: displayName, required: false }];
    }

    return {
      id: rel,
      displayName,
      children,
    };
  });
}

function startPlaywrightRun(selection) {
  const selectedSpecs = Array.isArray(selection?.specs)
    ? selection.specs.map((s) => String(s || '').trim()).filter(Boolean)
    : (typeof selection === 'string' && selection.trim() ? [selection.trim()] : []);
  const selectedTasks = Array.isArray(selection?.tasks)
    ? selection.tasks.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  const selectedTaskIds = selectedTasks
    .map((k) => k.split('::')[1] || k)
    .filter(Boolean);
  const plannedResults = Array.isArray(selection?.plannedResults) ? selection.plannedResults : [];
  const baseDomain = normalizeBaseDomain(selection?.baseDomain);
  const baseUrl = `https://${baseDomain}/`;

  const args = selectedSpecs.length > 0
    ? ['playwright', 'test', ...selectedSpecs, '--headed', '--reporter=line']
    : ['playwright', 'test', '--headed', '--reporter=line'];

  runState = createIdleState({
    running: true,
    startedAt: new Date().toISOString(),
    currentSpec: selectedSpecs.length > 0 ? selectedSpecs.join(', ') : 'ALL',
    baseDomain,
    selectedSpecs,
    selectedTasks: selectedTaskIds,
    testResults: plannedResults.map((x) => ({
      key: x.key,
      test: x.test,
      status: 'pending',
      durationMs: null,
      error: null,
      updatedAt: new Date().toISOString(),
    })),
  });

  appendLog(`[runner] Starting Playwright run: npx ${args.join(' ')}`, 'system');
  appendLog(`[runner] Base URL: ${baseUrl}`, 'system');
  subtestTimers.clear();

  currentChild = spawn('npx', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      RUNNER_TASKS: selectedTaskIds.join(','),
      PLAYWRIGHT_BASE_URL: baseUrl,
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
    subtestTimers.clear();
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
  subtestTimers.clear();
  return { ok: true, message: 'Runner state cleared.' };
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
      button { background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 10px 14px; cursor: pointer; font-weight: 700; }
      button.secondary { background: #334155; }
      button.warn { background: #b91c1c; }
      button:disabled { opacity: 0.65; cursor: not-allowed; }
      .tests-list { margin-top: 10px; border: 1px solid var(--line); border-radius: 8px; max-height: 220px; overflow: auto; background: #0f1621; }
      .test-parent { border-bottom: 1px solid #1b2535; padding: 8px 10px; }
      .test-item { display: flex; align-items: flex-start; gap: 10px; padding: 6px 0; }
      .test-children { margin-left: 26px; }
      .test-main { display: flex; flex-direction: column; gap: 4px; }
      .test-path { font-size: 12px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .required-note { font-size: 11px; color: #fbbf24; }
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
      @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>Playwright Runner</h1>
        <div class="row">
          <label for="baseDomainInput" class="muted" style="font-weight:700;">Base domain</label>
          <input id="baseDomainInput" type="text" value="${DEFAULT_BASE_DOMAIN}" style="background:#0f1621;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px 10px;min-width:220px;" />
          <button id="run" type="button">Trigger Run</button>
          <button id="stop" type="button" class="warn">Stop Current</button>
          <button id="clear" type="button" class="secondary">Clear</button>
          <button id="selectAll" type="button" class="secondary">Select All</button>
          <button id="unselectAll" type="button" class="secondary">Unselect All</button>
          <span class="muted" id="selectedCount">Selected: 0</span>
        </div>
        <div id="testsList" class="tests-list muted">Loading tests...</div>
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

    <script>
      const statusBadge = document.getElementById('statusBadge');
      const statusText = document.getElementById('statusText');
      const runBtn = document.getElementById('run');
      const stopBtn = document.getElementById('stop');
      const clearBtn = document.getElementById('clear');
      const selectAllBtn = document.getElementById('selectAll');
      const unselectAllBtn = document.getElementById('unselectAll');
      const selectedCountEl = document.getElementById('selectedCount');
      const baseDomainInput = document.getElementById('baseDomainInput');
      const testsListEl = document.getElementById('testsList');
      const logsPre = document.getElementById('logs');
      const openFailureDetails = new Set();
      let discoveredTests = [];
      let selectedTaskKeys = new Set();
      let lastResultsSignature = '';
      let lastLogsSignature = '';
      let userPinnedToBottom = true;

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
      function safe(v) { return v === null || v === undefined || v === '' ? '-' : String(v); }
      function esc(v) {
        return safe(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
      }

      function taskKey(specId, childId) { return specId + '::' + childId; }

      function updateSelectedCount() {
        selectedCountEl.textContent = 'Selected: ' + selectedTaskKeys.size;
      }

      function renderTestsChooser() {
        if (!Array.isArray(discoveredTests) || discoveredTests.length === 0) {
          testsListEl.innerHTML = '<div class="test-item muted">No tests found.</div>';
          updateSelectedCount();
          return;
        }

        testsListEl.innerHTML = discoveredTests.map((spec) => {
          const childKeys = spec.children.map((c) => taskKey(spec.id, c.id));
          const checkedCount = childKeys.filter((k) => selectedTaskKeys.has(k)).length;
          const parentChecked = checkedCount === childKeys.length;
          const parentIndeterminate = checkedCount > 0 && checkedCount < childKeys.length;
          const parentHtml = '<label class="test-item"><input type="checkbox" data-parent="' + esc(spec.id) + '"' + (parentChecked ? ' checked' : '') + '><div class="test-main"><strong>' + esc(spec.displayName) + '</strong></div></label>';
          const childrenHtml = spec.children.map((child) => {
            const key = taskKey(spec.id, child.id);
            const checked = selectedTaskKeys.has(key) ? ' checked' : '';
            const disabled = child.required ? ' disabled' : '';
            const note = child.required ? '<span class="required-note">Required - cannot disable</span>' : '';
            return '<label class="test-item"><input type="checkbox" data-child="' + esc(key) + '"' + checked + disabled + '><div class="test-main"><span>• ' + esc(child.label) + '</span>' + note + '</div></label>';
          }).join('');
          return '<div class="test-parent" data-parent-wrap="' + esc(spec.id) + '">' + parentHtml + '<div class="test-children">' + childrenHtml + '</div></div>';
        }).join('');

        testsListEl.querySelectorAll('input[data-parent]').forEach((input) => {
          const specId = input.getAttribute('data-parent');
          const spec = discoveredTests.find((s) => s.id === specId);
          if (!spec) return;
          const childKeys = spec.children.map((c) => taskKey(spec.id, c.id));
          const checkedCount = childKeys.filter((k) => selectedTaskKeys.has(k)).length;
          input.indeterminate = checkedCount > 0 && checkedCount < childKeys.length;

          input.addEventListener('change', () => {
            if (input.checked) {
              spec.children.forEach((c) => selectedTaskKeys.add(taskKey(spec.id, c.id)));
            } else {
              spec.children.forEach((c) => {
                const key = taskKey(spec.id, c.id);
                if (c.required) selectedTaskKeys.add(key);
                else selectedTaskKeys.delete(key);
              });
            }
            renderTestsChooser();
          });
        });

        testsListEl.querySelectorAll('input[data-child]').forEach((input) => {
          input.addEventListener('change', () => {
            const key = input.getAttribute('data-child');
            if (!key) return;
            if (input.checked) selectedTaskKeys.add(key);
            else selectedTaskKeys.delete(key);
            renderTestsChooser();
          });
        });

        updateSelectedCount();
      }

      async function loadTests() {
        const res = await fetch('/tests');
        const data = await res.json();
        discoveredTests = Array.isArray(data.tests) ? data.tests : [];
        selectedTaskKeys = new Set();
        discoveredTests.forEach((spec) => spec.children.forEach((child) => selectedTaskKeys.add(taskKey(spec.id, child.id))));
        renderTestsChooser();
      }

      function renderResults(results) {
        const tbody = document.getElementById('resultsBody');
        if (!Array.isArray(results) || results.length === 0) {
          tbody.innerHTML = '<tr><td colspan="3" class="muted">No test results yet.</td></tr>';
          return;
        }

        tbody.innerHTML = results.map((r) => {
          const cls = r.status === 'passed' ? 'passed' : r.status === 'failed' ? 'failed' : r.status === 'canceled' ? 'canceled' : r.status === 'pending' ? 'idle' : 'running';
          const rawKey = safe(r.key);
          const encodedKey = encodeURIComponent(rawKey);
          const isOpen = openFailureDetails.has(rawKey);
          const errorHtml = r.error ? '<details data-failure-key="' + encodedKey + '"' + (isOpen ? ' open' : '') + '><summary>Show failure reason</summary><div class="error-box mono">' + esc(r.error) + '</div></details>' : '';
          const label = r.parent ? ('&nbsp;&nbsp;&nbsp;&nbsp;↳ ' + esc(r.test)) : ('<strong>' + esc(r.test) + '</strong>');
          return '<tr><td>' + label + errorHtml + '</td><td><span class="badge ' + cls + '">' + esc(r.status).toUpperCase() + '</span></td><td class="mono">' + esc(r.durationMs) + '</td></tr>';
        }).join('');
      }

      function renderLogs(logs) {
        if (!Array.isArray(logs) || logs.length === 0) {
          const emptySig = 'EMPTY';
          if (lastLogsSignature !== emptySig) {
            logsPre.textContent = 'No logs yet.';
            lastLogsSignature = emptySig;
          }
          return;
        }
        const nextText = logs.map((l) => '[' + l.ts + '][' + l.stream + '] ' + l.line).join('\\n');
        if (nextText === lastLogsSignature) return;
        logsPre.textContent = nextText;
        lastLogsSignature = nextText;
        if (userPinnedToBottom) {
          logsPre.scrollTop = logsPre.scrollHeight;
        }
      }

      async function refreshStatus() {
        const res = await fetch('/status');
        const data = await res.json();
        const cls = statusClass(data);
        statusBadge.className = 'badge ' + cls;
        statusBadge.textContent = statusLabel(data);
        statusText.textContent = data.running ? ('Running: ' + safe(data.currentTest) + ' | ' + safe(data.currentDetail)) : ('Last run exit code: ' + safe(data.exitCode));
        document.getElementById('currentSpec').textContent = safe(data.currentSpec);
        document.getElementById('currentTest').textContent = safe(data.currentTest);
        document.getElementById('currentDetail').textContent = safe(data.currentDetail);
        document.getElementById('startedAt').textContent = safe(data.startedAt);
        document.getElementById('finishedAt').textContent = safe(data.finishedAt);
        document.getElementById('exitCode').textContent = safe(data.exitCode);
        document.getElementById('lastError').textContent = safe(data.lastError);
        if (data.baseDomain && !baseDomainInput.matches(':focus')) {
          baseDomainInput.value = String(data.baseDomain);
        }
        const sig = JSON.stringify(data.testResults || []);
        if (sig !== lastResultsSignature) {
          renderResults(data.testResults);
          lastResultsSignature = sig;
        }
        renderLogs(data.logs);
        runBtn.disabled = !!data.running;
        stopBtn.disabled = !data.running;
        clearBtn.disabled = !!data.running;
        selectAllBtn.disabled = !!data.running;
        unselectAllBtn.disabled = !!data.running;
        baseDomainInput.disabled = !!data.running;
      }

      function buildSelectionPayload() {
        const tasks = Array.from(selectedTaskKeys);
        const specsSet = new Set(tasks.map((key) => key.split('::')[0]));
        const specs = Array.from(specsSet);
        const baseDomain = (baseDomainInput.value || '').trim();
        const plannedResults = tasks.map((key) => {
          const [specId, childId] = key.split('::');
          const spec = discoveredTests.find((s) => s.id === specId);
          const child = spec ? spec.children.find((c) => c.id === childId) : null;
          const parent = spec ? spec.displayName : specId;
          const label = child ? child.label : key;
          return { key, test: parent + ' > ' + label, parent: childId !== '__self' };
        });
        return { specs, tasks, plannedResults, baseDomain };
      }

      async function trigger() {
        const payload = buildSelectionPayload();
        if (payload.tasks.length === 0) {
          alert('Select at least one test first.');
          return;
        }
        runBtn.disabled = true;
        const original = runBtn.textContent;
        runBtn.textContent = 'Starting...';
        try {
          const res = await fetch('/trigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          const data = await res.json();
          if (!res.ok) alert(data.message || 'Failed to trigger run');
        } finally {
          runBtn.textContent = original;
          await refreshStatus();
        }
      }

      async function stopRun() { await fetch('/stop'); await refreshStatus(); }
      async function clearState() { await fetch('/clear'); await refreshStatus(); }

      runBtn.addEventListener('click', trigger);
      stopBtn.addEventListener('click', stopRun);
      clearBtn.addEventListener('click', clearState);
      selectAllBtn.addEventListener('click', () => {
        selectedTaskKeys = new Set();
        discoveredTests.forEach((spec) => spec.children.forEach((child) => selectedTaskKeys.add(taskKey(spec.id, child.id))));
        renderTestsChooser();
      });
      unselectAllBtn.addEventListener('click', () => {
        selectedTaskKeys = new Set();
        discoveredTests.forEach((spec) => spec.children.forEach((child) => { if (child.required) selectedTaskKeys.add(taskKey(spec.id, child.id)); }));
        renderTestsChooser();
      });
      document.addEventListener('toggle', (event) => {
        const detailsEl = event.target;
        if (!detailsEl || detailsEl.tagName !== 'DETAILS') return;
        const key = detailsEl.getAttribute('data-failure-key');
        if (!key) return;
        const decodedKey = decodeURIComponent(key);
        if (detailsEl.open) openFailureDetails.add(decodedKey); else openFailureDetails.delete(decodedKey);
      });
      logsPre.addEventListener('scroll', () => {
        const distanceFromBottom = logsPre.scrollHeight - logsPre.scrollTop - logsPre.clientHeight;
        userPinnedToBottom = distanceFromBottom < 16;
      });

      (async () => {
        await loadTests();
        await refreshStatus();
        setInterval(refreshStatus, 500);
      })();
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
        triggerWithSpec: `curl -X POST http://${HOST}:${PORT}/trigger -H "Content-Type: application/json" -d '{"specs":["${EXAMPLE_SPEC}"]}'`,
        baseDomain: `optional in POST body, defaults to ${DEFAULT_BASE_DOMAIN}`,
        stop: `curl http://${HOST}:${PORT}/stop`,
        clear: `curl http://${HOST}:${PORT}/clear`,
      },
    });
  }

  if (req.method === 'GET' && url.pathname === '/tests') {
    return sendJson(res, 200, {
      ok: true,
      tests: discoverTests(),
    });
  }

  if (req.method === 'GET' && url.pathname === '/trigger') {
    if (runState.running) {
      return sendJson(res, 409, { ok: false, message: 'A Playwright run is already in progress.', state: runState });
    }
    const spec = url.searchParams.get('spec') || '';
    const baseDomain = normalizeBaseDomain(url.searchParams.get('baseDomain') || DEFAULT_BASE_DOMAIN);
    startPlaywrightRun({ specs: spec ? [spec] : [], baseDomain });
    return sendJson(res, 202, { ok: true, message: 'Playwright run started.', spec: spec || 'ALL', baseDomain });
  }

  if (req.method === 'POST' && url.pathname === '/trigger') {
    if (runState.running) {
      return sendJson(res, 409, { ok: false, message: 'A Playwright run is already in progress.', state: runState });
    }

    try {
      const body = await parseJsonBody(req);
      const requestedSpecs = Array.isArray(body.specs)
        ? body.specs.map((s) => String(s || '').trim()).filter(Boolean)
        : (typeof body.spec === 'string' && body.spec.trim() ? [body.spec.trim()] : []);
      const requestedTasks = Array.isArray(body.tasks)
        ? body.tasks.map((s) => String(s || '').trim()).filter(Boolean)
        : [];
      const plannedResults = Array.isArray(body.plannedResults) ? body.plannedResults : [];
      const baseDomain = normalizeBaseDomain(body.baseDomain);

      const availableTests = discoverTests();
      const availableIds = new Set(availableTests.map((t) => t.id));
      const invalidSpecs = requestedSpecs.filter((s) => !availableIds.has(s));
      if (invalidSpecs.length > 0) {
        return sendJson(res, 400, { ok: false, message: `Unknown test ids: ${invalidSpecs.join(', ')}` });
      }

      startPlaywrightRun({ specs: requestedSpecs, tasks: requestedTasks, plannedResults, baseDomain });
      return sendJson(res, 202, {
        ok: true,
        message: 'Playwright run started.',
        specs: requestedSpecs.length > 0 ? requestedSpecs : ['ALL'],
        baseDomain,
      });
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
      endpoints: ['GET /status', 'GET /tests', 'GET /ui', 'GET /trigger', 'POST /trigger', 'GET /stop', 'GET /clear'],
    });
  }

  return sendJson(res, 404, { ok: false, message: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[runner] Open dashboard (local): http://127.0.0.1:5050/ui`);
});
