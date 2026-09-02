/**
 * End-to-end tests against a real browser.
 *
 * Node tests cover the domain and the tool definitions, but they cannot see
 * what the browser actually does with them: whether registration succeeds,
 * whether the tool list really changes with the page state, whether a refusal
 * reaches the caller as something readable. Those only show up in Chrome, and
 * two genuine bugs in this project were found exactly there.
 *
 * Self-contained: starts its own server on its own port and drives a throwaway
 * Chrome profile with the WebMCP flag enabled. The user's browser and profile
 * are untouched.
 *
 *   npm run test:browser
 *
 * Requires Chrome 149 or newer. Set CHROME_PATH to override the location.
 *
 * The engine under test is selectable, because WebMCP is shipping at different
 * speeds in different Chromium builds and a claim about "the browser" that was
 * only ever measured in one of them is not a measurement:
 *
 *   NSWR_BROWSER=edge npm run test:browser   # or set NSWR_BROWSER_PATH
 *
 * Whichever engine drives the main run, a separate scenario also opens
 * Microsoft Edge when it is installed and records what it really exposes.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { PHASES, createVisitorTools, toolsForPhase, toolCounts } from '../public/tools.mjs';
import { spawnOwnedServer, waitForOwnedServer, waitForOwnedServerGone } from '../test/helpers/test-server.mjs';

/**
 * A port nothing is listening on right now.
 *
 * This file used to write four of them down. The Node suites were cleaned of
 * exactly that and this one was missed, because the guard only ever looked at
 * `*.test.mjs` - so the single file that drives real browsers, and the only gate
 * that caught the hardcoded-label defect, sat outside every check. Two runs then
 * contended for the same numbers, which is what happened in practice.
 *
 * Still a hint, not a reservation: the probe closes the socket before the child
 * binds it. What makes the server unambiguous is NSWR_INSTANCE_TOKEN, which the
 * readiness poll below already requires.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.NSWR_TEST_PORT ?? await freePort());
// Chromium is asked for --remote-debugging-port=0 and writes the port it really
// chose into <profile>/DevToolsActivePort. Allocating one ourselves left the
// same TOCTOU race the server ports had: the probe closes the socket before the
// browser binds it. These are filled in by readDevToolsPort() after each launch.
let DEBUG_PORT = null;
let FALLBACK_DEBUG_PORT = null;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let EDGE_DEBUG_PORT = null;
const PROFILE = path.join(os.tmpdir(), `nswr-e2e-${process.pid}`);
const FALLBACK_PROFILE = path.join(os.tmpdir(), `nswr-e2e-fallback-${process.pid}`);
const EDGE_PROFILE = path.join(os.tmpdir(), `nswr-e2e-edge-${process.pid}`);
const INITIAL_DEMO_ID = randomUUID();

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean);

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
].filter(Boolean);

const BROWSER_FAMILIES = { chrome: CHROME_CANDIDATES, edge: EDGE_CANDIDATES };
const REQUESTED_BROWSER = (process.env.NSWR_BROWSER ?? 'chrome').toLowerCase();

/** Notes are printed with the results but are not pass/fail claims. */
const notes = [];

/**
 * The only scenario that deliberately takes the server away, named once because
 * the error accounting at the end has to be able to point at exactly it.
 */
const RESTART_SCENARIO = 'losing the server mid-booking fails visibly instead of inventing a venue';
const OPERATOR_RESTART_SCENARIO = 'the operations page also refuses to show a venue the server has forgotten';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const KEY = Object.freeze({
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
});

const results = [];
let currentScenario = 'setup';

function note(message) {
  notes.push(`[${currentScenario}] ${message}`);
  console.log(`note ${message}`);
}

function check(label, passed, detail = '') {
  results.push({ scenario: currentScenario, label, passed, detail });
  const mark = passed ? 'ok  ' : 'FAIL';
  console.log(`${mark} ${label}${detail && !passed ? `\n       ${detail}` : ''}`);
}

function scenario(name) {
  currentScenario = name;
  console.log(`\n— ${name}`);
}

/* ------------------------------------------------------------------ plumbing */

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
      return;
    }
    if (message.method && listeners.has(message.method)) {
      for (const listener of listeners.get(message.method)) listener(message.params);
    }
  });

  return {
    ready: new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', reject);
    }),
    close: () => socket.close(),
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(listener);
    },
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(description);
  }
  return result.result.value;
}

async function pressKey(client, name) {
  const event = KEY[name];
  if (!event) throw new Error(`Unknown key: ${name}`);
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
  const { text: _text, unmodifiedText: _unmodifiedText, ...released } = event;
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...released });
}

async function tabTo(client, selector, maximum = 60) {
  for (let step = 1; step <= maximum; step += 1) {
    await pressKey(client, 'Tab');
    const reached = await evaluate(client, `return document.activeElement?.matches(${JSON.stringify(selector)}) === true;`);
    if (reached) return step;
  }
  return 0;
}

async function waitForPage(client, expression, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(client, `return Boolean(${expression});`)) return true;
    await sleep(100);
  }
  return false;
}

async function stopProcessTree(child) {
  if (!child?.pid || child.exitCode !== null) return;

  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      killer.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      killer.once('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return;
  }

  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(3_000),
  ]);
}

/** Page-side helpers injected into every evaluate call. */
const PAGE = `
  const mc = document.modelContext;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const names = async () => (await mc.getTools()).map(t => t.name).sort();
  const call = async (name, args) => {
    const tool = (await mc.getTools()).find(t => t.name === name);
    if (!tool) return { __missing: name };
    const raw = await mc.executeTool(tool, JSON.stringify(args ?? {}));
    try { return JSON.parse(raw); } catch { return { __raw: raw }; }
  };
  const rev = () => Number((document.querySelector('#venue-version').textContent.match(/\\d+/) ?? [0])[0]);
  const settle = async () => { await sleep(1600); };
  // One reading of the whole tool surface: the phase the server reports, the
  // exact registry the browser holds, and the badge the visitor can see. Taken
  // through a read-only tool so that measuring the surface cannot change it.
  const surface = async () => {
    const state = await call('get_event_access_state', {});
    return {
      phase: state.phase,
      names: await names(),
      badge: document.querySelector('#webmcp-status-text').textContent.trim(),
      chips: [...document.querySelectorAll('#tool-list .tool-chip')].map((chip) => chip.textContent).sort(),
    };
  };
`;

/**
 * What each phase must register, derived from the declarations the page itself
 * registers from rather than typed out here. TOOLS-01 used to check that one or
 * two expected names were present, which cannot fail when a tool that should
 * have been withdrawn is still registered alongside them. These are exact sets.
 *
 * `set_access_requirements` is the declarative form tool. It lives in the HTML
 * rather than in createVisitorTools, so it is added by hand for READY - the one
 * phase whose form is usable - and counts as a write.
 */
const DECLARATIVE_TOOL = 'set_access_requirements';
const EXPECTED_SURFACE = (() => {
  const declared = createVisitorTools({ api: async () => ({}), refresh: async () => ({}) });
  return new Map(PHASES.map((phase) => {
    const registered = toolsForPhase(declared, phase);
    const { read, write } = toolCounts(registered);
    const declarative = phase === 'READY' ? [DECLARATIVE_TOOL] : [];
    return [phase, {
      names: [...registered.map((tool) => tool.name), ...declarative].sort(),
      read,
      write: write + declarative.length,
    }];
  }));
})();

/** Which phases the run actually observed, asserted for completeness at the end. */
const phasesObserved = new Set();

const FULL = {
  wheelchairWidthCm: 72,
  maxDistanceM: 80,
  stepFree: true,
  companionCount: 1,
  entranceAssistance: true,
  lowStimulus: true,
};

// These are record copy, not transient toasts. Pinning the complete sentence in
// the browser suite makes the route comparison part of the receipt contract:
// checking for only "original" or "replacement" would stay green if the page
// silently reverted to one unconditional sentence around that word.
const ORIGINAL_ROUTE_RECEIPT_INTRO = 'The booking was issued only after the original route was rechecked and confirmation was received from a visitor session on this shared venue.';
const REPLACEMENT_ROUTE_RECEIPT_INTRO = 'The booking was issued only after the replacement route was rechecked and confirmation was received from a visitor session on this shared venue.';

/**
 * The debugging port Chromium actually chose.
 *
 * It writes DevToolsActivePort into its own profile directory: first line the
 * port, second the browser-target path. Reading it is race-free in a way that
 * picking a port never is, and it also proves the browser we are about to drive
 * is the child we just started, because the file lives in that child's profile.
 */
async function readDevToolsPort(profile, child, { attempts = 120, interval = 125 } = {}) {
  const file = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const [line] = (await readFile(file, 'utf8')).split('\n');
      const port = Number(line.trim());
      if (Number.isInteger(port) && port > 0) return port;
    } catch { /* not written yet */ }
    await sleep(interval);
  }
  // Deliberately not "the spawned process exited, therefore fail". On Windows
  // the msedge.exe we start is a launcher: it hands off to the real browser and
  // returns 0 within a second, while the browser it started keeps running and
  // serves the protocol. A liveness guard on the spawned handle reports that as
  // a crash - measured here, after it turned a working Edge scenario red.
  //
  // The file is the better proof in any case. It is written inside the profile
  // directory this run created for this launch, so a port read from it belongs
  // to the browser we started, which is what the liveness check stood in for.
  const exited = child.exitCode !== null || child.signalCode !== null;
  throw new Error(
    `the browser never published a debugging port in ${profile}`
    + (exited ? ` (the spawned process exited with code ${child.exitCode}, which is normal for Edge on Windows)` : ''),
  );
}

/** Writes the throwaway profile that turns the WebMCP testing flag on. */
async function prepareFlaggedProfile(directory) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'Local State'),
    JSON.stringify({ browser: { enabled_labs_experiments: ['enable-webmcp-testing@1'] } }),
  );
}

// The server launch and both waits come from the shared test helper. This file
// used to carry its own copies, and its SERVER_ENV dropped PORT but not the two
// NSWR_TRUST_* variables Render sets on the service - the same omission that has
// cost this project a deploy before.
let serverHandle = null;

function launchServer() {
  serverHandle = spawnOwnedServer({ port: PORT });
  return serverHandle.child;
}

async function waitForServer() {
  await waitForOwnedServer(serverHandle, { attempts: 80, interval: 125 });
}

async function waitForServerGone() {
  await waitForOwnedServerGone(serverHandle, { attempts: 120, interval: 50 });
}

async function main() {
  const candidates = BROWSER_FAMILIES[REQUESTED_BROWSER];
  if (!candidates) {
    console.error(`Unknown NSWR_BROWSER=${REQUESTED_BROWSER}. Use ${Object.keys(BROWSER_FAMILIES).join(' or ')}.`);
    process.exitCode = 1;
    return;
  }
  const chromePath = [process.env.NSWR_BROWSER_PATH, ...candidates]
    .filter(Boolean)
    .find((candidate) => existsSync(candidate));
  if (!chromePath) {
    console.error(`${REQUESTED_BROWSER} not found. Set NSWR_BROWSER_PATH to a Chromium 149+ binary.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Driving ${REQUESTED_BROWSER}: ${chromePath}`);

  await prepareFlaggedProfile(PROFILE);
  await rm(FALLBACK_PROFILE, { recursive: true, force: true });
  await rm(EDGE_PROFILE, { recursive: true, force: true });

  let server = launchServer();

  let chrome = null;
  let client = null;
  let fallbackChrome = null;
  let fallbackClient = null;
  let edgeBrowser = null;
  let edgeClient = null;

  try {
    await waitForServer();

    chrome = spawn(chromePath, [
      '--remote-debugging-port=0',
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--headless=new',
      `${ORIGIN}/?demo=${INITIAL_DEMO_ID}`,
    ], { stdio: 'ignore' });
    DEBUG_PORT = await readDevToolsPort(PROFILE, chrome);

    let page = null;
    for (let attempt = 0; attempt < 60 && !page; attempt++) {
      await sleep(500);
      try {
        const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
        page = targets.find((target) => target.type === 'page' && target.url.startsWith('http')) ?? null;
      } catch { /* starting */ }
    }
    if (!page) throw new Error('Chrome did not expose a page target');

    const consoleErrors = [];
    const consoleWarnings = [];
    const failedResponses = [];
    const responsesReceived = [];
    // Every request the page issues, not only the ones that came back 4xx. A
    // successful request is invisible to failedResponses, so "issued no HTTP
    // request" could never have been proven from it.
    const requestsSent = [];

    const attachClient = async (target) => {
      const attached = connect(target.webSocketDebuggerUrl);
      await attached.ready;
      attached.on('Runtime.exceptionThrown', (params) => {
        consoleErrors.push({
          scenario: currentScenario,
          message: params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'exception',
        });
      });
      attached.on('Runtime.consoleAPICalled', (params) => {
        if (params.type === 'error') {
          consoleErrors.push({
            scenario: currentScenario,
            message: params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '),
          });
        } else if (params.type === 'warning') {
          consoleWarnings.push({
            scenario: currentScenario,
            message: params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '),
          });
        }
      });
      attached.on('Network.requestWillBeSent', (params) => {
        requestsSent.push({
          scenario: currentScenario,
          method: params.request?.method ?? 'GET',
          url: params.request?.url ?? '',
        });
      });
      attached.on('Network.responseReceived', (params) => {
        const headers = params.response.headers ?? {};
        responsesReceived.push({
          scenario: currentScenario,
          status: params.response.status,
          domainStatus: Number(headers['x-nswr-domain-status'] ?? headers['X-NSWR-Domain-Status']) || null,
          url: params.response.url,
        });
        if (params.response.status >= 400) {
          failedResponses.push({ scenario: currentScenario, status: params.response.status, url: params.response.url });
        }
      });
      await attached.send('Runtime.enable');
      await attached.send('Page.enable');
      await attached.send('Network.enable');
      return attached;
    };

    client = await attachClient(page);

    const run = (body) => evaluate(client, `${PAGE}\n${body}`);

    /** Resets the current isolated venue without a renderer-swapping navigation. */
    const freshVenue = async () => {
      await evaluate(client, `document.querySelector('#reset-button').click(); return true;`);
      await sleep(2_600);
    };

    /**
     * Asserts one observed tool surface against the phase's declaration: the
     * page really is in the phase we think it is, the registry is exactly the
     * declared set rather than a superset containing the names we looked for,
     * the visible badge agrees with the counts, and the chips agree with the
     * registry. Records the phase so the run can prove at the end which of the
     * seven it actually reached.
     */
    const verifySurface = (observed, expectedPhase, where) => {
      const expected = EXPECTED_SURFACE.get(expectedPhase);
      const seen = [...(observed?.names ?? [])].sort();
      const wanted = expected?.names ?? [];
      check(`${where}: the page is in ${expectedPhase}`,
        observed?.phase === expectedPhase,
        `reported ${observed?.phase}`);
      check(`${where}: ${expectedPhase} registers exactly its declared tools`,
        observed?.phase === expectedPhase && seen.join() === wanted.join(),
        `browser=[${seen.join(', ')}]  declared=[${wanted.join(', ')}]`);
      check(`${where}: ${expectedPhase} reports ${expected?.read} read · ${expected?.write} write`,
        observed?.badge === `${expected?.read} read · ${expected?.write} write`,
        `badge=${observed?.badge}`);
      check(`${where}: the visible chips match the browser registry`,
        [...(observed?.chips ?? [])].sort().join() === seen.join(),
        `chips=[${[...(observed?.chips ?? [])].sort().join(', ')}]  registry=[${seen.join(', ')}]`);
      if (observed?.phase === expectedPhase) phasesObserved.add(expectedPhase);
    };

    /* ------------------------------------------------------------ scenarios */

    // Which engine actually ran these checks is evidence, not trivia: a suite
    // that does not say what it drove cannot be quoted as proof it drove
    // anything. Edge already reports its build; this does the same for the
    // primary engine, read from the DevTools endpoint rather than the reduced
    // user agent, which only carries the major version.
    const primaryBuild = await (async () => {
      try {
        const meta = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
        return { browser: meta.Browser ?? 'unknown', protocol: meta['Protocol-Version'] ?? 'unknown' };
      } catch {
        return null;
      }
    })();
    note(primaryBuild
      ? `Primary engine: ${primaryBuild.browser} (DevTools protocol ${primaryBuild.protocol})`
      : 'Primary engine: version endpoint did not answer; the engine was not identified.');

    scenario('the page boots as a WebMCP host');
    await sleep(2_500);
    const boot = await run(`
      const exposed = await mc.getTools();
      const declarativeSchemaRaw = exposed.find((tool) => tool.name === 'set_access_requirements')?.inputSchema;
      return JSON.stringify({
        modelContext: typeof mc,
        registerTool: typeof mc?.registerTool,
        originAgentCluster: window.originAgentCluster,
        status: document.querySelector('#webmcp-status-text').textContent,
        title: document.querySelector('#webmcp-status').title,
        tools: exposed.map((tool) => tool.name).sort(),
        readTools: exposed.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name).sort(),
        chips: [...document.querySelectorAll('#tool-list .tool-chip')].map((chip) => chip.textContent).sort(),
        declarativeSchema: typeof declarativeSchemaRaw === 'string'
          ? JSON.parse(declarativeSchemaRaw)
          : declarativeSchemaRaw,
      });`);
    const bootData = JSON.parse(boot);
    check('document.modelContext exists', bootData.modelContext === 'object', boot);
    check('the document is origin-isolated', bootData.originAgentCluster === true, `got ${bootData.originAgentCluster}`);
    check('the page reports its read/write split', /\d+ read · \d+ write/.test(bootData.status), bootData.status);
    const claimed = bootData.status.match(/(\d+) read · (\d+) write/);
    check('the reported count matches what the browser exposes',
      claimed && Number(claimed[1]) + Number(claimed[2]) === bootData.tools.length,
      `page says ${bootData.status}, browser exposes ${bootData.tools.length}: ${bootData.tools.join(', ')}`);
    check('the visible tool names exactly match the browser registry',
      bootData.chips.join() === bootData.tools.join(),
      `chips=${bootData.chips.join(', ')}; browser=${bootData.tools.join(', ')}`);
    check('the read/write split is derived from the exposed annotations',
      claimed
        && Number(claimed[1]) === bootData.readTools.length
        && Number(claimed[2]) === bootData.tools.length - bootData.readTools.length,
      `page says ${bootData.status}; read tools=${bootData.readTools.join(', ')}`);
    check('the tool title names the browser-exposed set',
      bootData.tools.every((name) => bootData.title.includes(name)),
      bootData.title);
    // Was `.length === 5`. A count written into the assertion goes stale the
    // moment a phase gains or loses a tool - and it did, when
    // explain_access_refusal joined READY. The exact set is derived from the
    // same declarations the page registers from, so it cannot disagree.
    check('READY registers exactly the declared imperative tools',
      bootData.tools.filter((n) => n !== DECLARATIVE_TOOL).sort().join()
        === EXPECTED_SURFACE.get('READY').names.filter((n) => n !== DECLARATIVE_TOOL).join(),
      bootData.tools.join(', '));
    check('the declarative form is registered as a tool', bootData.tools.includes('set_access_requirements'), bootData.tools.join(', '));
    check('the declarative schema publishes required numeric bounds',
      bootData.declarativeSchema?.required?.includes('wheelchairWidthCm')
        && bootData.declarativeSchema?.required?.includes('maxDistanceM')
        && bootData.declarativeSchema?.properties?.wheelchairWidthCm?.minimum === 45
        && bootData.declarativeSchema?.properties?.wheelchairWidthCm?.maximum === 95
        && bootData.declarativeSchema?.properties?.maxDistanceM?.minimum === 20
        && bootData.declarativeSchema?.properties?.maxDistanceM?.maximum === 500,
      JSON.stringify(bootData.declarativeSchema));

    const headers = await fetch(`${ORIGIN}/`);
    check('Origin-Agent-Cluster header is sent', headers.headers.get('origin-agent-cluster') === '?1', String(headers.headers.get('origin-agent-cluster')));
    check('the tools permissions policy is declared', (headers.headers.get('permissions-policy') ?? '').includes('tools=(self)'), String(headers.headers.get('permissions-policy')));

    scenario('the first read of an untouched venue is the one the README publishes');
    const firstRead = JSON.parse(await run(`
      return JSON.stringify(await call('get_event_access_state', {}));`));
    check('an untouched venue reads back as READY at revision 1',
      firstRead.phase === 'READY' && firstRead.venueRevision === 1,
      JSON.stringify(firstRead));
    const firstLifts = (firstRead.facilities ?? []).filter((f) => f.label.includes('Lift'));
    check('both lifts are in service before anything is planned',
      firstLifts.length === 2 && firstLifts.every((f) => f.status === 'OPERATIONAL'),
      JSON.stringify(firstLifts));
    const firstActivity = JSON.parse(await run(`return JSON.stringify({
      actor: document.querySelector('#protocol-channel').textContent,
      action: document.querySelector('#protocol-tool').textContent,
      result: document.querySelector('#protocol-result').textContent,
    });`));
    check('an actual browser tool call is visible in the live activity trace',
      firstActivity.actor === 'WebMCP browser agent'
        && firstActivity.action === 'get_event_access_state'
        && firstActivity.result.includes('venue revision 1'),
      JSON.stringify(firstActivity));

    scenario('the recorded judge walkthrough works end to end with native WebMCP and a clean DevTools console');
    const judgeResponseMark = responsesReceived.length;
    const judgeFailureMark = failedResponses.length;
    const judgeErrorMark = consoleErrors.length;
    const judgeWarningMark = consoleWarnings.length;
    const judgeWalkthrough = JSON.parse(await run(`
      const activity = () => ({
        actor: document.querySelector('#protocol-channel').textContent.trim(),
        action: document.querySelector('#protocol-tool').textContent.trim(),
        result: document.querySelector('#protocol-result').textContent.trim(),
      });
      const waitFor = async (test, ms = 10000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (await test()) return true;
          await sleep(80);
        }
        return false;
      };

      const initialSurface = await surface();
      const found = await call('find_access_bundle', ${JSON.stringify(FULL)});
      await waitFor(() => document.querySelector('#plan-state').textContent.trim() === 'Proposed');
      const findActivity = activity();

      await waitFor(async () => (await names()).includes('stage_access_bundle'));
      await call('stage_access_bundle', {
        planId: found.plan.id,
        expectedVenueRevision: found.plan.basedOnRevision,
      });
      await waitFor(() => document.querySelector('#plan-state').textContent.trim() === 'Ready for review');
      const stageActivity = activity();
      const staged = {
        route: document.querySelector('#route-summary').textContent.replace(/\\s+/g, ' ').trim(),
        decisionVisible: !document.querySelector('#decision-section').hidden,
        audit: document.querySelector('#audit-list').textContent.replace(/\\s+/g, ' ').trim(),
        venueRevision: rev(),
      };

      document.querySelector('#fault-button').click();
      await waitFor(() => document.querySelector('#fault-button').getAttribute('aria-disabled') === 'true');
      const beforeConfirm = {
        planState: document.querySelector('#plan-state').textContent.trim(),
        venueRevision: rev(),
      };
      document.querySelector('#confirm-button').click();
      await waitFor(() => !document.querySelector('#incident').hidden);
      await waitFor(() => activity().actor === 'Human visitor'
        && activity().action === 'confirmation refused');
      const detail = document.querySelector('#incident details');
      if (!detail.open) detail.querySelector('summary').click();
      const refusalActivity = activity();
      const refusal = {
        detailOpen: detail.open,
        technical: document.querySelector('#incident-detail').textContent.trim(),
        partial: document.querySelector('#partial-count').textContent.trim(),
        receiptHidden: document.querySelector('#receipt-section').hidden,
        venueRevision: rev(),
      };

      await waitFor(async () => {
        const available = await names();
        return available.includes('explain_access_refusal')
          && available.includes('replan_access_bundle');
      });
      const why = await call('explain_access_refusal', {});
      const explainActivity = activity();
      const replanned = await call('replan_access_bundle', { stalePlanId: found.plan.id });
      await waitFor(() => document.querySelector('#decision-heading').textContent.includes('route changed'));
      const replanActivity = activity();
      const replacement = {
        route: document.querySelector('#route-summary').textContent.replace(/\\s+/g, ' ').trim(),
        planState: document.querySelector('#plan-state').textContent.trim(),
        venueRevision: rev(),
      };

      document.querySelector('#confirm-button').click();
      await waitFor(() => !document.querySelector('#receipt-section').hidden);
      await waitFor(() => activity().actor === 'Human confirmation'
        && activity().action === 'commit booking');
      const confirmationActivity = activity();
      const receipt = {
        reference: document.querySelector('#receipt-number').textContent.trim(),
        details: document.querySelector('#receipt-details').textContent.replace(/\\s+/g, ' ').trim(),
        atomic: document.querySelector('#atomic-proof-text').textContent.replace(/\\s+/g, ' ').trim(),
      };
      const finalSurface = await surface();
      return JSON.stringify({
        initialSurface, found, findActivity, stageActivity, staged,
        beforeConfirm, refusalActivity, refusal, why, explainActivity,
        replanned, replanActivity, replacement, confirmationActivity,
        receipt, finalSurface,
      });
    `));
    check('judge step 1 discovers the complete READY WebMCP surface',
      judgeWalkthrough.initialSurface.phase === 'READY'
        && judgeWalkthrough.initialSurface.badge === '5 read · 2 write'
        && judgeWalkthrough.initialSurface.names.includes('find_access_bundle'),
      JSON.stringify(judgeWalkthrough.initialSurface));
    check('judge step 2 records find_access_bundle as genuine WebMCP activity',
      judgeWalkthrough.findActivity.actor === 'WebMCP browser agent'
        && judgeWalkthrough.findActivity.action === 'find_access_bundle'
        && judgeWalkthrough.findActivity.result.includes('option found'),
      JSON.stringify(judgeWalkthrough.findActivity));
    check('judge step 3 records stage_access_bundle in both activity and the decision log',
      judgeWalkthrough.stageActivity.actor === 'WebMCP browser agent'
        && judgeWalkthrough.stageActivity.action === 'stage_access_bundle'
        && judgeWalkthrough.staged.audit.includes('WebMCP · stage_access_bundle'),
      JSON.stringify({ activity: judgeWalkthrough.stageActivity, audit: judgeWalkthrough.staged.audit }));
    check('judge step 4 presents the complete East plan before page confirmation',
      judgeWalkthrough.staged.route.includes('East Entrance')
        && judgeWalkthrough.staged.route.includes('East Lift L2')
        && judgeWalkthrough.staged.decisionVisible === true
        && judgeWalkthrough.beforeConfirm.planState === 'Ready for review'
        && judgeWalkthrough.beforeConfirm.venueRevision === 1,
      JSON.stringify({ staged: judgeWalkthrough.staged, beforeConfirm: judgeWalkthrough.beforeConfirm }));
    check('judge step 5 shows the real stale refusal with zero partial reservations',
      judgeWalkthrough.refusal.detailOpen === true
        && judgeWalkthrough.refusal.technical.includes('STALE_RESOURCE_VERSION')
        && judgeWalkthrough.refusal.technical.includes('plan revision 1')
        && judgeWalkthrough.refusal.technical.includes('venue revision 2')
        && judgeWalkthrough.refusal.partial === '0'
        && judgeWalkthrough.refusal.receiptHidden === true,
      JSON.stringify(judgeWalkthrough.refusal));
    check('judge step 6 labels the confirmation as page-control activity, never as a WebMCP call',
      judgeWalkthrough.refusalActivity.actor === 'Human visitor'
        && judgeWalkthrough.refusalActivity.action === 'confirmation refused'
        && judgeWalkthrough.refusalActivity.result.includes('0 resources booked'),
      JSON.stringify(judgeWalkthrough.refusalActivity));
    check('judge step 7 explains the stale revision, failed lift rule and Garden alternative through WebMCP',
      judgeWalkthrough.explainActivity.actor === 'WebMCP browser agent'
        && judgeWalkthrough.explainActivity.action === 'explain_access_refusal'
        && judgeWalkthrough.why.errorCode === 'STALE_RESOURCE_VERSION'
        && judgeWalkthrough.why.brokenRules?.some((rule) => rule.rule === 'LIFT_OPERATIONAL')
        && judgeWalkthrough.why.validOptionsNow?.some((option) => option.routeId === 'garden-lift-route')
        && judgeWalkthrough.why.partialReservations === 0,
      JSON.stringify({ activity: judgeWalkthrough.explainActivity, result: judgeWalkthrough.why }));
    check('judge step 8 records replan_access_bundle and prepares the complete Garden route',
      judgeWalkthrough.replanActivity.actor === 'WebMCP browser agent'
         && judgeWalkthrough.replanActivity.action === 'replan_access_bundle'
         && judgeWalkthrough.replacement.route.includes('Garden Entrance')
         && judgeWalkthrough.replacement.route.includes('Garden Lift L4')
         && judgeWalkthrough.replacement.planState === 'Ready for review'
         && judgeWalkthrough.replacement.venueRevision === 2,
      JSON.stringify({ activity: judgeWalkthrough.replanActivity, replacement: judgeWalkthrough.replacement }));
    check('judge step 9 keeps final acceptance human and produces one atomic receipt',
      judgeWalkthrough.confirmationActivity.actor === 'Human confirmation'
        && judgeWalkthrough.confirmationActivity.action === 'commit booking'
         && /^NSWR-\d{5}$/.test(judgeWalkthrough.receipt.reference)
         && judgeWalkthrough.receipt.details.includes('W12')
         && judgeWalkthrough.receipt.details.includes('W13')
         && judgeWalkthrough.receipt.details.includes('Partial reservations0')
         && judgeWalkthrough.receipt.atomic.includes('reserved 0→3'),
      JSON.stringify({ activity: judgeWalkthrough.confirmationActivity, receipt: judgeWalkthrough.receipt }));
    check('judge step 10 ends with four read tools and zero write tools',
      judgeWalkthrough.finalSurface.phase === 'CONFIRMED'
        && judgeWalkthrough.finalSurface.badge === '4 read · 0 write'
        && judgeWalkthrough.finalSurface.names.length === 4,
      JSON.stringify(judgeWalkthrough.finalSurface));
    const judgeResponses = responsesReceived.slice(judgeResponseMark);
    const judgeCommits = judgeResponses.filter(({ url }) => /\/api\/plans\/[^/]+\/commit$/.test(new URL(url).pathname));
    check('judge F12 records a clean typed refusal followed by a clean successful commit',
      judgeCommits.length === 2
        && judgeCommits[0].status === 200
        && judgeCommits[0].domainStatus === 409
        && judgeCommits[1].status === 200
        && judgeCommits[1].domainStatus === null,
      JSON.stringify(judgeCommits));
    check('judge F12 has no failed request, console error or console warning',
      failedResponses.length === judgeFailureMark
        && consoleErrors.length === judgeErrorMark
        && consoleWarnings.length === judgeWarningMark,
      JSON.stringify({
        failed: failedResponses.slice(judgeFailureMark),
        errors: consoleErrors.slice(judgeErrorMark),
        warnings: consoleWarnings.slice(judgeWarningMark),
      }));

    scenario('a read-only tool changes nothing');
    await freshVenue();
    const readOnly = await run(`
      const before = { rev: rev(), tools: await names() };
      await call('get_event_access_state', {});
      await call('list_access_options', { wheelchairWidthCm: 72 });
      await call('check_access_route', { routeId: 'east-lift-route', stepFree: true });
      await call('get_access_bundle_status', {});
      await settle();
      return JSON.stringify({ before, after: { rev: rev(), tools: await names() } });`);
    const ro = JSON.parse(readOnly);
    check('the venue revision does not move', ro.before.rev === ro.after.rev, `${ro.before.rev} -> ${ro.after.rev}`);
    check('the registered tools do not change', ro.before.tools.join() === ro.after.tools.join(), ro.after.tools.join(', '));

    scenario('a comparison names what blocks each route');
    const compare = await run(`
      const wide = await call('list_access_options', { wheelchairWidthCm: 90 });
      const one = await call('check_access_route', { routeId: 'garden-lift-route', wheelchairWidthCm: 90 });
      return JSON.stringify({ wide, one });`);
    const cmp = JSON.parse(compare);
    check('one of two routes fits a 90 cm chair', cmp.wide.feasibleCount === 1, JSON.stringify(cmp.wide));
    check('the blocked route names the failing rule', (cmp.wide.options.find((o) => !o.feasible)?.blockedBy ?? []).includes('DOORWAY_WIDTH'), JSON.stringify(cmp.wide.options));
    check('a single-route check agrees with the comparison', cmp.one.feasible === false && cmp.one.checks.some((c) => c.rule === 'DOORWAY_WIDTH' && !c.ok), JSON.stringify(cmp.one.checks ?? cmp.one));

    scenario('a refusal is readable, not an opaque browser failure');
    await freshVenue();
    const failedBeforeInvalidTools = failedResponses.length;
    const refusals = await run(`
      const missing = await call('find_access_bundle', { wheelchairWidthCm: 72 });
      const missingRoute = await call('check_access_route', {});
      const ok = await call('find_access_bundle', ${JSON.stringify(FULL)});
      await settle();
      const missingStage = await call('stage_access_bundle', {});
      const missingRevision = await call('stage_access_bundle', { planId: ok.plan.id });
      const missingClear = await call('clear_access_plan', {});
      const again = await call('find_access_bundle', ${JSON.stringify(FULL)});
      return JSON.stringify({ missing, missingRoute, missingStage, missingRevision, missingClear, planPhase: ok.phase, again });`);
    const ref = JSON.parse(refusals);
    const invalidToolFailures = failedResponses.slice(failedBeforeInvalidTools);
    check('a partial requirement set is refused by name', ref.missing.error === 'MISSING_REQUIREMENTS', JSON.stringify(ref.missing));
    check('the refusal lists what is missing', Array.isArray(ref.missing.missing) && ref.missing.missing.includes('stepFree'), JSON.stringify(ref.missing.missing));
    check('the refusal says what to do next', typeof ref.missing.nextAction === 'string' && ref.missing.nextAction.length > 0, String(ref.missing.nextAction));
    check('a missing route id is refused by name', ref.missingRoute.error === 'ROUTE_ID_REQUIRED', JSON.stringify(ref.missingRoute));
    check('missing stage and clear arguments are refused locally',
      [ref.missingStage, ref.missingRevision, ref.missingClear].every((result) => result.error === 'MISSING_TOOL_ARGUMENTS'),
      JSON.stringify([ref.missingStage, ref.missingRevision, ref.missingClear]));
    check('invalid tool inputs issue no failing HTTP request', invalidToolFailures.length === 0, JSON.stringify(invalidToolFailures));
    check('a complete requirement set produces a plan', ref.planPhase === 'PLAN_READY', ref.planPhase);
    check('searching twice is refused, not retried blindly', ref.again.__missing === 'find_access_bundle' || ref.again.error === 'ACTIVE_PLAN_EXISTS', JSON.stringify(ref.again));

    scenario('the tool surface follows the page state');
    await freshVenue();
    const matrix = await run(`
      const seen = {};
      seen.READY = await surface();
      const found = await call('find_access_bundle', ${JSON.stringify(FULL)});
      await settle();
      seen.PLAN_READY = await surface();
      await call('stage_access_bundle', { planId: found.plan.id, expectedVenueRevision: found.plan.basedOnRevision });
      await settle();
      seen.AWAITING_HUMAN_CONFIRMATION = await surface();
      document.querySelector('#confirm-button').click();
      await sleep(2200);
      seen.CONFIRMED = await surface();
      return JSON.stringify(seen);`);
    const m = JSON.parse(matrix);
    // Exact sets against the declarations, in every phase this scenario walks.
    // The old version asked whether particular names were present or absent,
    // which stays green when a withdrawn tool is still registered alongside
    // them - the failure the matrix claimed to cover.
    verifySurface(m.READY, 'READY', 'an untouched venue');
    verifySurface(m.PLAN_READY, 'PLAN_READY', 'a proposed plan');
    verifySurface(m.AWAITING_HUMAN_CONFIRMATION, 'AWAITING_HUMAN_CONFIRMATION', 'a staged plan awaiting the visitor');
    verifySurface(m.CONFIRMED, 'CONFIRMED', 'a confirmed booking');
    // The two properties the matrix singles out, stated directly rather than
    // left implicit in the set comparison.
    check('the search is withdrawn as soon as a plan exists',
      !m.PLAN_READY.names.includes('find_access_bundle'), m.PLAN_READY.names.join(', '));
    check('nothing that could confirm is registered while awaiting the visitor',
      !m.AWAITING_HUMAN_CONFIRMATION.names.some((n) => /confirm|commit|book|pay|purchase/i.test(n)),
      m.AWAITING_HUMAN_CONFIRMATION.names.join(', '));

    scenario('an unrelated venue revision exposes recovery instead of trapping the visitor');
    await freshVenue();
    const unrelated = await run(`
      const found = await call('find_access_bundle', ${JSON.stringify(FULL)});
      await settle();
      await call('stage_access_bundle', { planId: found.plan.id, expectedVenueRevision: found.plan.basedOnRevision });
      await settle();

      const id = new URL(location.href).searchParams.get('demo');
      const operator = await (await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'operator', demoId: id }),
      })).json();
      const outageResponse = await fetch('/api/operator/facilities/garden-lift/outage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Demo-Session': operator.session.token },
        body: JSON.stringify({ reasonCode: 'SAFETY_INSPECTION' }),
      });
      await settle();

      const status = await call('get_access_bundle_status', {});
      const staleTools = await names();
      const why = await call('explain_access_refusal', {});
      const east = await call('check_access_route', { routeId: 'east-lift-route', ...${JSON.stringify(FULL)} });
      const incidentVisible = !document.querySelector('#incident').hidden;
      const replanned = await call('replan_access_bundle', { stalePlanId: status.plan.id });
      await settle();
      const sameRoutePrecondition = JSON.stringify(replanned.plan?.route) === JSON.stringify(found.plan?.route);
      const decisionVisibleAfterReplan = !document.querySelector('#decision-section').hidden;
      document.querySelector('#confirm-button').click();
      await sleep(2200);
      const confirmed = await call('get_access_bundle_status', {});
      return JSON.stringify({
        outageStatus: outageResponse.status,
        status,
        staleTools,
        why,
        east,
        replanned,
        incidentVisible,
        sameRoutePrecondition,
        decisionVisibleAfterReplan,
        confirmed,
        receiptShown: !document.querySelector('#receipt-section').hidden,
        receiptIntro: document.querySelector('#receipt-intro-text').textContent,
      });`);
    const unrelatedResult = JSON.parse(unrelated);
    check('the operator change succeeded', unrelatedResult.outageStatus === 200, String(unrelatedResult.outageStatus));
    check('the visitor enters PLAN_STALE immediately', unrelatedResult.status.phase === 'PLAN_STALE', JSON.stringify(unrelatedResult.status));
    check('the recovery tools replace the hidden confirmation path',
      unrelatedResult.staleTools.includes('explain_access_refusal') && unrelatedResult.staleTools.includes('replan_access_bundle'),
      unrelatedResult.staleTools.join(', '));
    check('the stale incident is visible', unrelatedResult.incidentVisible === true, JSON.stringify(unrelatedResult));
    check('the explanation says the original route still works',
      unrelatedResult.why.brokenRules?.length === 0
        && unrelatedResult.why.validOptionsNow?.some((option) => option.routeId === 'east-lift-route'),
      JSON.stringify(unrelatedResult.why));
    check('the route checker agrees that East is feasible', unrelatedResult.east.feasible === true, JSON.stringify(unrelatedResult.east));
    check('replanning revalidates East against the new revision',
      unrelatedResult.replanned.plan?.route?.includes('East Lift L2')
        && unrelatedResult.decisionVisibleAfterReplan === true,
      JSON.stringify(unrelatedResult.replanned));
    check('the unrelated venue change really kept the route byte-for-byte identical',
      unrelatedResult.sameRoutePrecondition === true,
      JSON.stringify({ before: unrelatedResult.status.plan?.route, after: unrelatedResult.replanned.plan?.route }));
    check('the same-route replan can be confirmed into a real booking',
      unrelatedResult.receiptShown === true && Boolean(unrelatedResult.confirmed.booking?.reference),
      JSON.stringify(unrelatedResult.confirmed));
    check('a same-route replan writes the exact original-route receipt introduction',
      unrelatedResult.receiptIntro === ORIGINAL_ROUTE_RECEIPT_INTRO,
      unrelatedResult.receiptIntro);

    scenario('a lift failing between review and commit books nothing');
    await freshVenue();
    const responsesBeforeStaleCommit = responsesReceived.length;
    const consoleBeforeStaleCommit = consoleErrors.length;
    const race = await run(`
      const found = await call('find_access_bundle', ${JSON.stringify(FULL)});
      await settle();
      await call('stage_access_bundle', { planId: found.plan.id, expectedVenueRevision: found.plan.basedOnRevision });
      await settle();
      document.querySelector('#fault-button').click();
      await sleep(1400);
      const beforeConfirm = { state: document.querySelector('#plan-state').textContent.trim(), rev: rev() };
      document.querySelector('#confirm-button').click();
      await sleep(2200);
      const afterConfirm = { rev: rev(), incident: !document.querySelector('#incident').hidden, partial: document.querySelector('#partial-count').textContent };
      const refusedActivity = {
        actor: document.querySelector('#protocol-channel').textContent,
        action: document.querySelector('#protocol-tool').textContent,
        result: document.querySelector('#protocol-result').textContent,
      };
      const why = await call('explain_access_refusal', {});
      const staleSurface = await surface();
      return JSON.stringify({ beforeConfirm, afterConfirm, refusedActivity, why, staleSurface });`);
    const r = JSON.parse(race);
    check('arming the fault leaves the plan looking ready', r.beforeConfirm.state === 'Ready for review', JSON.stringify(r.beforeConfirm));
    check('the venue revision moves during the commit', r.afterConfirm.rev > r.beforeConfirm.rev, `${r.beforeConfirm.rev} -> ${r.afterConfirm.rev}`);
    check('the refusal is shown to the visitor', r.afterConfirm.incident === true, JSON.stringify(r.afterConfirm));
    check('nothing was partially reserved', r.afterConfirm.partial === '0', r.afterConfirm.partial);
    check('the agent is told which rule broke', (r.why.brokenRules ?? []).some((rule) => rule.rule === 'LIFT_OPERATIONAL'), JSON.stringify(r.why));
    check('the agent is told the plan was overtaken, not merely that a rule failed',
      r.why.errorCode === 'STALE_RESOURCE_VERSION', String(r.why.errorCode));
    check('the explanation shows the plan exactly one revision behind the venue',
      Number.isInteger(r.why.planRevision) && r.why.planRevision === r.why.venueRevision - 1,
      'plan ' + r.why.planRevision + ' vs venue ' + r.why.venueRevision);
    check('the agent is told which route still works', (r.why.validOptionsNow ?? []).some((o) => o.routeId === 'garden-lift-route'), JSON.stringify(r.why.validOptionsNow));
    check('the agent is told to replan', r.why.nextAction === 'REPLAN', String(r.why.nextAction));
    verifySurface(r.staleSurface, 'PLAN_STALE', 'a plan overtaken by the venue');
    const staleCommitResponses = responsesReceived.slice(responsesBeforeStaleCommit)
      .filter(({ url }) => /\/api\/plans\/[^/]+\/commit$/.test(new URL(url).pathname));
    check('the expected stale confirmation is a clean HTTP exchange in DevTools',
      staleCommitResponses.length === 1
        && staleCommitResponses[0].status === 200
        && staleCommitResponses[0].domainStatus === 409,
      JSON.stringify(staleCommitResponses));
    check('the safe-failure walkthrough adds no red console entry',
      consoleErrors.length === consoleBeforeStaleCommit,
      JSON.stringify(consoleErrors.slice(consoleBeforeStaleCommit)));
    check('the page labels confirmation as a page-control refusal rather than a WebMCP tool call',
      r.refusedActivity.actor === 'Human visitor'
        && r.refusedActivity.action === 'confirmation refused'
        && r.refusedActivity.result.includes('0 resources booked'),
      JSON.stringify(r.refusedActivity));

    scenario('the agent replans and the visible page control confirms the replacement');
    const recover = await run(`
      const alertBeforeReplan = document.querySelector('#a11y-alert').textContent;
      const status = await call('get_access_bundle_status', {});
      const missingReplan = await call('replan_access_bundle', {});
      const replanned = await call('replan_access_bundle', { stalePlanId: status.plan.id });
      await settle();
      const changedRoutePrecondition = JSON.stringify(replanned.plan?.route) !== JSON.stringify(status.plan?.route);
      const alertAfterReplan = document.querySelector('#a11y-alert').textContent;
      const statusAfterReplan = document.querySelector('#a11y-status').textContent;
      const replanSurface = await surface();
      document.querySelector('#confirm-button').click();
      await sleep(2200);
      const after = await call('get_access_bundle_status', {});
      const eventState = await call('get_event_access_state', {});
      return JSON.stringify({
        missingReplan,
        replanned,
        changedRoutePrecondition,
        after,
        eventState,
        atomic: document.querySelector('#atomic-proof-text').textContent,
        alertBeforeReplan,
        alertAfterReplan,
        statusAfterReplan,
        replanSurface,
        alertAfterConfirmation: document.querySelector('#a11y-alert').textContent,
        statusAfterConfirmation: document.querySelector('#a11y-status').textContent,
        receiptIntro: document.querySelector('#receipt-intro-text').textContent,
      });`);
    const rec = JSON.parse(recover);
    check('a missing stale plan id is refused locally', rec.missingReplan.error === 'MISSING_TOOL_ARGUMENTS', JSON.stringify(rec.missingReplan));
    check('the replacement uses the working lift', (rec.replanned.plan?.route ?? []).includes('Garden Lift L4'), JSON.stringify(rec.replanned.plan?.route));
    check('the replacement route enters by the Garden Entrance',
      (rec.replanned.plan?.route ?? []).includes('Garden Entrance'),
      JSON.stringify(rec.replanned.plan?.route));
    check('this replacement really changed the route rather than only its revision',
      rec.changedRoutePrecondition === true,
      JSON.stringify(rec.replanned.plan?.route));
    check('the booking exists after the visible page control confirms', Boolean(rec.after.booking?.reference), JSON.stringify(rec.after.booking));
    check('the booking reports zero partial reservations', rec.after.booking?.partialReservations === 0, JSON.stringify(rec.after.booking));
    check('the event state labels committed resources without calling them partial',
      rec.eventState.reservedResourceCount === 3 && !Object.hasOwn(rec.eventState, 'partialReservations'),
      JSON.stringify(rec.eventState));
    check('the booking commits exactly one revision past the refusal',
      rec.eventState.venueRevision === r.why.venueRevision + 1,
      'refused at ' + r.why.venueRevision + ', booked at ' + rec.eventState.venueRevision);
    check('the stale refusal populated the assertive alert', rec.alertBeforeReplan.includes('booking stopped'), rec.alertBeforeReplan);
    check('replanning clears the obsolete assertive alert', rec.alertAfterReplan === '', rec.alertAfterReplan);
    check('the replacement is announced through the status region', rec.statusAfterReplan.includes('Complete plan ready'), rec.statusAfterReplan);
    verifySurface(rec.replanSurface, 'REPLAN_READY', 'a replacement plan awaiting the visitor');
    check('successful confirmation leaves no stale assertive alert', rec.alertAfterConfirmation === '', rec.alertAfterConfirmation);
    check('successful confirmation announces success',
      rec.statusAfterConfirmation === 'Every requested resource was confirmed in one transaction.',
      rec.statusAfterConfirmation);
    check('a genuinely changed route writes the exact replacement-route receipt introduction',
      rec.receiptIntro === REPLACEMENT_ROUTE_RECEIPT_INTRO,
      rec.receiptIntro);

    scenario('impossible requirements end in an explained dead end, not a booking');
    await freshVenue();
    const deadEnd = await run(`
      const found = await call('find_access_bundle', { ...${JSON.stringify(FULL)}, maxDistanceM: 70 });
      await settle();
      await call('stage_access_bundle', { planId: found.plan.id, expectedVenueRevision: found.plan.basedOnRevision });
      await settle();
      document.querySelector('#fault-button').click();
      await sleep(1400);
      document.querySelector('#confirm-button').click();
      await sleep(2200);
      const why = await call('explain_access_refusal', {});
      const replan = await call('replan_access_bundle', { stalePlanId: (await call('get_access_bundle_status', {})).plan.id });
      await settle();
      const status = await call('get_access_bundle_status', {});
      const toolsBeforeRepair = await names();
      const deadEndSurface = await surface();

      const id = new URL(location.href).searchParams.get('demo');
      const operator = await (await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'operator', demoId: id }),
      })).json();
      await fetch('/api/operator/facilities/east-lift/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Demo-Session': operator.session.token },
        body: '{}',
      });
      await settle();
      const afterRepair = await call('get_access_bundle_status', {});
      const repairTools = await names();
      const repairWhy = await call('explain_access_refusal', {});
      const recovered = await call('replan_access_bundle', { stalePlanId: afterRepair.plan.id });
      await settle();
      return JSON.stringify({
        why,
        replan,
        booking: status.booking,
        toolsBeforeRepair,
        deadEndSurface,
        afterRepair,
        repairTools,
        repairWhy,
        recovered,
      });`);
    const dead = JSON.parse(deadEnd);
    check('no alternative is offered when none fits', (dead.why.validOptionsNow ?? []).length === 0, JSON.stringify(dead.why.validOptionsNow));
    check('the agent is told to change requirements', dead.why.nextAction === 'CHANGE_REQUIREMENTS', String(dead.why.nextAction));
    check('replanning into nothing is refused readably', dead.replan.ok === false || dead.replan.__missing !== undefined, JSON.stringify(dead.replan));
    check('no booking was created', !dead.booking, JSON.stringify(dead.booking));
    check('the visitor can start over', dead.toolsBeforeRepair.includes('clear_access_plan'), dead.toolsBeforeRepair.join(', '));
    verifySurface(dead.deadEndSurface, 'NO_ALTERNATIVE', 'a venue with no route that fits');
    check('a venue repair makes the dead-end conclusion stale', dead.afterRepair.phase === 'PLAN_STALE', JSON.stringify(dead.afterRepair));
    check('replanning becomes available after the repair', dead.repairTools.includes('replan_access_bundle'), dead.repairTools.join(', '));
    check('the repaired state tells the agent to replan', dead.repairWhy.nextAction === 'REPLAN', JSON.stringify(dead.repairWhy));
    check('the repaired route can be replanned without clearing requirements',
      dead.recovered.plan?.route?.includes('East Lift L2'),
      JSON.stringify(dead.recovered));

    scenario('invalid declarative form input cannot remain in progress forever');
    await freshVenue();
    const failedBeforeInvalidDeclarative = failedResponses.length;
    const requestsBeforeInvalidDeclarative = requestsSent.length;
    const invalidDeclarative = await run(`
      const form = document.querySelector('#requirements-form');
      const width = form.elements.wheelchairWidthCm;
      const distance = form.elements.maxDistanceM;

      const tool = (await mc.getTools()).find((candidate) => candidate.name === 'set_access_requirements');
      const execution = mc.executeTool(tool, JSON.stringify({ wheelchairWidthCm: 0, maxDistanceM: 0 }))
        .then((value) => ({ state: 'resolved', value }))
        .catch((error) => ({ state: 'rejected', message: String(error) }));
      const outcome = await Promise.race([
        execution,
        sleep(2500).then(() => ({ state: 'timeout' })),
      ]);
      const status = await call('get_access_bundle_status', {});
      return JSON.stringify({
        outcome,
        restored: { width: width.value, distance: distance.value },
        status,
        activeAfter: form.matches(':tool-form-active'),
        offeredAfter: (await names()).includes('set_access_requirements'),
      });
    `);
    const invalidForm = JSON.parse(invalidDeclarative);
    const invalidDeclarativeFailures = failedResponses.slice(failedBeforeInvalidDeclarative);
    check('Chrome reports both invalid zero-valued fields',
      invalidForm.outcome?.state === 'rejected'
        && invalidForm.outcome?.message.includes('wheelchairWidthCm')
        && invalidForm.outcome?.message.includes('maxDistanceM'),
      JSON.stringify(invalidForm.outcome));
    check('canceling invalid input restores the safe visible defaults',
      invalidForm.restored?.width === '72' && invalidForm.restored?.distance === '80',
      JSON.stringify(invalidForm.restored));
    // The README states this case as "no HTTP request or plan". A failed-response
    // count cannot support the first half: a request that succeeded would leave
    // no trace in it. Read the full request log, the same way the malformed
    // scenario does, and prove the recorder was live while doing so.
    const invalidApiCalls = requestsSent
      .slice(requestsBeforeInvalidDeclarative)
      .filter(({ url }) => url.includes('/api/'));
    check('invalid declarative input neither plans nor calls the server',
      invalidForm.status?.phase === 'READY' && invalidDeclarativeFailures.length === 0,
      JSON.stringify({ status: invalidForm.status, failed: invalidDeclarativeFailures }));
    check('the request recorder was live throughout the zero-valued declarative window',
      invalidApiCalls.some(({ method, url }) => method === 'GET' && url.includes('/api/state')),
      JSON.stringify(invalidApiCalls));
    check('zero-valued declarative input produced no mutating request at all',
      invalidApiCalls.every(({ method }) => method === 'GET'),
      JSON.stringify(invalidApiCalls.filter(({ method }) => method !== 'GET')));
    // The method is only half of it. A GET is harmless here only if it also went
    // nowhere a plan, a session or the demo lives - GET /api/plans/<id> would be
    // a read of somebody's plan and would pass the check above untouched. Match
    // on the parsed pathname rather than searching the whole URL string: a demo
    // id or query parameter containing "plans" must not read as an endpoint, and
    // an endpoint must not be able to hide inside a query string either. Read
    // from requestsSent directly, so this does not inherit the `/api/` substring
    // filter above.
    const FORBIDDEN_ROOTS = ['/api/plans', '/api/session', '/api/demo'];
    const forbiddenDeclarativeCalls = requestsSent
      .slice(requestsBeforeInvalidDeclarative)
      .filter(({ url }) => {
        const { pathname } = new URL(url, 'http://localhost');
        return FORBIDDEN_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
      });
    check('zero-valued declarative input reached no plan, session or demo endpoint',
      forbiddenDeclarativeCalls.length === 0,
      JSON.stringify(forbiddenDeclarativeCalls));
    check('the canceled form is inactive and available for a valid retry',
      invalidForm.activeAfter === false && invalidForm.offeredAfter === true,
      JSON.stringify({ activeAfter: invalidForm.activeAfter, offeredAfter: invalidForm.offeredAfter }));

    scenario('declarative malformed values always settle without a server call');
    await freshVenue();
    const failedBeforeMalformedDeclarative = failedResponses.length;
    const requestsBeforeMalformedDeclarative = requestsSent.length;
    const malformedDeclarative = await run(`
      const form = document.querySelector('#requirements-form');
      const cases = [
        { name: 'below-minimum', args: { wheelchairWidthCm: 44, maxDistanceM: 19 } },
        { name: 'above-maximum', args: { wheelchairWidthCm: 96, maxDistanceM: 501 } },
        { name: 'wrong-type', args: { wheelchairWidthCm: 'wide', maxDistanceM: 'far' } },
        { name: 'unknown-key', args: { wheelchairWidthCm: 72, maxDistanceM: 80, diagnosis: 'no' } },
        { name: 'null-value', args: { wheelchairWidthCm: null, maxDistanceM: 80 } },
      ];
      const results = [];
      for (const item of cases) {
        const tool = (await mc.getTools()).find((candidate) => candidate.name === 'set_access_requirements');
        const execution = mc.executeTool(tool, JSON.stringify(item.args))
          .then((value) => ({ state: 'resolved', value }))
          .catch((error) => ({ state: 'rejected', message: String(error) }));
        const outcome = await Promise.race([
          execution,
          sleep(2500).then(() => ({ state: 'timeout' })),
        ]);
        const beforeCleanup = {
          width: form.elements.wheelchairWidthCm.value,
          distance: form.elements.maxDistanceM.value,
          active: form.matches(':tool-form-active'),
        };
        if (outcome.state === 'timeout') form.reset();
        await sleep(100);
        results.push({
          name: item.name,
          outcome,
          beforeCleanup,
          after: {
            width: form.elements.wheelchairWidthCm.value,
            distance: form.elements.maxDistanceM.value,
            active: form.matches(':tool-form-active'),
          },
        });
      }
      return JSON.stringify({
        results,
        status: await call('get_access_bundle_status', {}),
        offered: (await names()).includes('set_access_requirements'),
      });
    `);
    const malformedForms = JSON.parse(malformedDeclarative);
    const malformedDeclarativeFailures = failedResponses.slice(failedBeforeMalformedDeclarative);
    check('range, type, null and unknown-key cases all reject instead of hanging',
      malformedForms.results.every((result) => result.outcome?.state === 'rejected'),
      JSON.stringify(malformedForms.results));
    check('every malformed declarative case leaves the form inactive at safe defaults',
      malformedForms.results.every((result) => (
        result.after?.width === '72'
        && result.after?.distance === '80'
        && result.after?.active === false
      )),
      JSON.stringify(malformedForms.results));
    check('malformed declarative cases keep READY and issue no failed request',
      malformedForms.status?.phase === 'READY'
        && malformedForms.offered === true
        && malformedDeclarativeFailures.length === 0,
      JSON.stringify({ status: malformedForms.status, offered: malformedForms.offered, failed: malformedDeclarativeFailures }));

    // "issued no HTTP request" was previously read off failedResponses, which
    // only ever holds 4xx and 5xx. A malformed declarative value that reached
    // the server and was accepted would have left no trace there at all. These
    // three read the full request log instead.
    const malformedRequests = requestsSent.slice(requestsBeforeMalformedDeclarative);
    const malformedApiCalls = malformedRequests.filter(({ url }) => url.includes('/api/'));
    // Non-vacuity first: the scenario ends by reading the bundle status, so a
    // recorder that had silently detached would show an empty window here and
    // make the two assertions below pass for the wrong reason.
    check('the request recorder was live throughout the malformed declarative window',
      malformedApiCalls.some(({ method, url }) => method === 'GET' && url.includes('/api/state')),
      JSON.stringify(malformedApiCalls));
    check('no malformed declarative value produced a mutating request of any kind',
      malformedApiCalls.every(({ method }) => method === 'GET'),
      JSON.stringify(malformedApiCalls.filter(({ method }) => method !== 'GET')));
    check('no malformed declarative value touched a plan, session or demo endpoint',
      !malformedApiCalls.some(({ url }) => /\/api\/(plans|session|demo)/.test(url)),
      JSON.stringify(malformedApiCalls.filter(({ url }) => /\/api\/(plans|session|demo)/.test(url))));

    scenario('the form tool is offered only while the form can be used');
    await freshVenue();
    const declarative = await run(`
      const offeredAtStart = (await names()).includes('set_access_requirements');
      const widthField = document.querySelector('input[name=wheelchairWidthCm]');
      const before = widthField.value;

      // The agent fills the visible form. The call stays open on purpose:
      // there is no toolautosubmit, so only a person can send it.
      const pending = call('set_access_requirements', { wheelchairWidthCm: 68, maxDistanceM: 85, stepFree: true, companion: true, assistance: true, lowStimulus: true });
      await sleep(1400);
      const filled = widthField.value;
      const feedback = document.querySelector('#action-feedback');
      const agentNotice = feedback.textContent;
      const agentNoticeVisible = !feedback.hidden;
      const agentNoticeLiveTargets = [...document.querySelectorAll('[role="status"], [aria-live]')]
        .filter((region) => region.textContent.trim() === agentNotice.trim())
        .map((region) => region.id);
      const settledEarly = await Promise.race([pending.then(() => true), sleep(600).then(() => false)]);

      document.querySelector('#build-plan-button').click();
      const result = await Promise.race([pending, sleep(8000).then(() => 'TIMED OUT')]);
      await settle();

      return JSON.stringify({
        offeredAtStart,
        before,
        filled,
        agentNotice,
        agentNoticeVisible,
        agentNoticeLiveTargets,
        settledEarly,
        result,
        offeredAfterPlanning: (await names()).includes('set_access_requirements'),
      });`);
    const dec = JSON.parse(declarative);
    check('the form is offered as a tool while it is editable', dec.offeredAtStart === true, declarative);
    check('an agent can fill the visible form', dec.before !== dec.filled && dec.filled === '68', `${dec.before} -> ${dec.filled}`);
    check('a valid declarative fill tells the visitor what to do',
      dec.agentNoticeVisible === true
        && dec.agentNotice.includes('Check the values')
        && dec.agentNotice.includes('submit it yourself')
        && dec.agentNoticeLiveTargets.length === 1
        && dec.agentNoticeLiveTargets[0] === 'a11y-status',
      JSON.stringify({ notice: dec.agentNotice, liveTargets: dec.agentNoticeLiveTargets }));
    check('the call does not settle until the visible form is submitted', dec.settledEarly === false, 'it resolved before the visible form was submitted');
    check('submitting hands the result back to the agent', dec.result?.submittedByVisitor === true && Boolean(dec.result?.planId), JSON.stringify(dec.result));
    check('the form tool is withdrawn once a plan exists', dec.offeredAfterPlanning === false, 'it stayed registered after the page left READY');

    scenario('every tool result stays inside the output budget');
    const budget = await run(`
      const sizes = {};
      const tools = await mc.getTools();
      for (const tool of tools) {
        if (tool.name === 'set_access_requirements') continue;
        const args = tool.name === 'check_access_route' ? { routeId: 'east-lift-route' } : {};
        try { sizes[tool.name] = String(await mc.executeTool(tool, JSON.stringify(args))).length; }
        catch (error) { sizes[tool.name] = 'threw: ' + String(error); }
      }
      return JSON.stringify(sizes);`);
    const sizes = JSON.parse(budget);
    const oversize = Object.entries(sizes).filter(([, size]) => typeof size === 'number' && size > 1536);
    const threw = Object.entries(sizes).filter(([, size]) => typeof size === 'string');
    check('no tool result exceeds 1536 characters', oversize.length === 0, JSON.stringify(oversize));
    check('no tool throws instead of returning a refusal', threw.length === 0, JSON.stringify(threw));

    scenario('the operations role is a separate surface over the same venue');
    await freshVenue();
    const demoId = await evaluate(client, `return new URL(location.href).searchParams.get('demo');`);
    const visitorClient = client;
    const operatorTarget = await visitorClient.send('Target.createTarget', { url: `${ORIGIN}/operator?demo=${demoId}` });
    let operatorPage = null;
    for (let attempt = 0; attempt < 40 && !operatorPage; attempt += 1) {
      const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      operatorPage = targets.find((target) => target.id === operatorTarget.targetId) ?? null;
      if (!operatorPage) await sleep(100);
    }
    if (!operatorPage) throw new Error('Chrome did not expose the operator tab');
    client = await attachClient(operatorPage);
    await sleep(3_200);
    const failedBeforeOperatorValidation = failedResponses.length;
    const operator = await run(`
      const tools = await names();
      const before = await call('get_facility_status', {});
      const missingOutage = await call('report_facility_outage', {});
      const missingReason = await call('report_facility_outage', { facilityId: 'east-lift' });
      const missingRestore = await call('restore_facility', {});
      const outage = await call('report_facility_outage', { facilityId: 'east-lift', reasonCode: 'LIFT_DOOR_FAULT' });
      await settle();
      const after = await call('get_facility_status', {});
      const restored = await call('restore_facility', { facilityId: 'east-lift' });
      return JSON.stringify({ tools, before, missingOutage, missingReason, missingRestore, outage, after, restored });`);
    const op = JSON.parse(operator);
    check('the operations page registers its own three tools', op.tools.join() === ['get_facility_status', 'report_facility_outage', 'restore_facility'].join(), op.tools.join(', '));
    check('the operations page offers no booking tool', !op.tools.some((n) => /bundle|plan/.test(n)), op.tools.join(', '));
    check('missing operator arguments are refused locally',
      [op.missingOutage, op.missingReason, op.missingRestore].every((result) => result.error === 'MISSING_TOOL_ARGUMENTS'),
      JSON.stringify([op.missingOutage, op.missingReason, op.missingRestore]));
    check('invalid operator tool inputs issue no failing HTTP request',
      failedResponses.length === failedBeforeOperatorValidation,
      JSON.stringify(failedResponses.slice(failedBeforeOperatorValidation)));
    check('reporting an outage raises the venue revision', op.outage.venueRevision > op.before.venueRevision, `${op.before.venueRevision} -> ${op.outage.venueRevision}`);
    check('the lift really goes out of service', op.after.facilities.find((f) => f.id === 'east-lift')?.status === 'OUT_OF_SERVICE', JSON.stringify(op.after.facilities));
    check('a restored lift raises the revision again', op.restored.venueRevision > op.outage.venueRevision, `${op.outage.venueRevision} -> ${op.restored.venueRevision}`);

    /*
     * The whole operator chain, joined, for both lifts.
     *
     * Everything above tests one link at a time: the tool surface, or an
     * endpoint, or a label, or the log. A build shipped in which the endpoints
     * followed the selector and two of the labels did not, and 224 browser
     * checks could not see it, because none of them read two links in the same
     * breath. This walks the chain end to end and requires every link to name
     * the same lift: the selector value, the three visible control labels, the
     * request the page really issued, the facility status /api/state gave back,
     * the toast, the newest audit entry, and the pending-fault banner.
     *
     * No lift is named here. Both the expected name and every observed name are
     * read from the venue, so the only way to pass is for the page to derive all
     * of them from the selection; a literal that happens to be right for one
     * lift fails on the other. The facility status is read through
     * get_facility_status, whose only implementation is the page's own
     * GET /api/state, so it is the page's session asking, not the harness.
     */
    scenario('every operator control names, acts on and logs the same lift');

    /** Every non-GET /api/ request in one recorded window, as "METHOD path". */
    const operatorMutations = (recorded) => recorded
      .filter(({ method, url }) => method !== 'GET' && new URL(url).pathname.startsWith('/api/'))
      .map(({ method, url }) => `${method} ${new URL(url).pathname}`);

    const chainSetup = JSON.parse(await run(`
      const reset = document.querySelector('#operator-reset-button');
      reset.focus();
      const heldResetFocus = document.activeElement === reset;
      reset.click();
      await sleep(1800);
      return JSON.stringify({
        status: await call('get_facility_status', {}),
        heldResetFocus,
        activeAfterReset: document.activeElement?.id ?? '',
      });`));
    check('resetting synthetic data leaves keyboard focus on the reset control',
      chainSetup.heldResetFocus === true && chainSetup.activeAfterReset === 'operator-reset-button',
      JSON.stringify(chainSetup));
    const chainLifts = (chainSetup.status?.facilities ?? []).map((facility) => {
      const other = (chainSetup.status?.facilities ?? []).find((candidate) => candidate.id !== facility.id);
      return {
        ...facility,
        otherId: other?.id ?? '',
        otherLabel: other?.label ?? '',
        // The word that tells the two apart, taken from the venue rather than
        // typed, so "does this sentence name the wrong lift" is answerable
        // without hardcoding either name.
        otherToken: (other?.label ?? '').split(' ')[0],
      };
    });
    check('the venue offers exactly two lifts whose names cannot be confused',
      chainLifts.length === 2
        && chainLifts.every(({ label, otherLabel, otherToken }) => (
          Boolean(label) && Boolean(otherToken) && label !== otherLabel && !label.includes(otherToken)
        )),
      JSON.stringify(chainLifts));

    const radioMutationMark = requestsSent.length;
    const radioStart = JSON.parse(await run(`
      const radios = [...document.querySelectorAll('input[name="controlled-facility"]')];
      const east = radios.find((radio) => radio.value === 'east-lift');
      east.click();
      east.focus();
      return JSON.stringify({
        count: radios.length,
        selectExists: Boolean(document.querySelector('select, #facility-select')),
        selected: document.querySelector('input[name="controlled-facility"]:checked')?.value,
        active: document.activeElement?.value,
        names: radios.map((radio) => document.querySelector('#' + radio.getAttribute('aria-labelledby'))?.textContent),
        states: radios.map((radio) => document.querySelector('#' + radio.getAttribute('aria-describedby').split(' ')[1])?.textContent),
      });`));
    await pressKey(client, 'ArrowRight');
    await sleep(300);
    const radioAfterArrow = JSON.parse(await run(`
      const selected = document.querySelector('input[name="controlled-facility"]:checked');
      window.__nswrSelectedRadioNode = selected;
      return JSON.stringify({
        selected: selected?.value,
        active: document.activeElement?.value,
        heading: document.querySelector('#manual-control-heading').textContent,
        arm: document.querySelector('#arm-outage-button').textContent,
        outage: document.querySelector('#outage-now-button').textContent,
        restore: document.querySelector('#restore-outage-button').textContent,
      });`));
    await sleep(1_800);
    const radioAfterPoll = JSON.parse(await run(`
      const selected = document.querySelector('input[name="controlled-facility"]:checked');
      return JSON.stringify({
        selected: selected?.value,
        active: document.activeElement?.value,
        sameNode: selected === window.__nswrSelectedRadioNode,
      });`));
    await pressKey(client, 'ArrowLeft');
    await sleep(300);
    const radioAfterReturn = JSON.parse(await run(`
      return JSON.stringify({
        selected: document.querySelector('input[name="controlled-facility"]:checked')?.value,
        active: document.activeElement?.value,
      });`));
    const radioMutations = operatorMutations(requestsSent.slice(radioMutationMark));
    check('the operator uses two directly visible native lift radios and no dropdown',
      radioStart.count === 2
        && radioStart.selectExists === false
        && radioStart.selected === 'east-lift'
        && radioStart.active === 'east-lift'
        && radioStart.names.every(Boolean)
        && radioStart.states.every((value) => value === 'OPERATIONAL'),
      JSON.stringify(radioStart));
    check('arrow keys select the other lift and repaint every control without a write request',
      radioAfterArrow.selected === 'garden-lift'
        && radioAfterArrow.active === 'garden-lift'
        && [radioAfterArrow.heading, radioAfterArrow.arm, radioAfterArrow.outage, radioAfterArrow.restore]
          .every((text) => text.includes('Garden Lift L4'))
        && radioMutations.length === 0,
      JSON.stringify({ radioAfterArrow, radioMutations }));
    check('the one-second live poll preserves the selected radio node and keyboard focus',
      radioAfterPoll.selected === 'garden-lift'
        && radioAfterPoll.active === 'garden-lift'
        && radioAfterPoll.sameNode === true,
      JSON.stringify(radioAfterPoll));
    check('the keyboard can return to East without losing the checked state',
      radioAfterReturn.selected === 'east-lift' && radioAfterReturn.active === 'east-lift',
      JSON.stringify(radioAfterReturn));

    for (const lift of chainLifts) {
      const namesIt = (text) => String(text).includes(lift.label);
      const namesTheOther = (text) => String(text).includes(lift.otherToken);

      const opened = JSON.parse(await run(`
        const radio = [...document.querySelectorAll('input[name="controlled-facility"]')]
          .find((input) => input.value === ${JSON.stringify(lift.id)});
        radio.click();
        await sleep(400);
        return JSON.stringify({
          selected: document.querySelector('input[name="controlled-facility"]:checked')?.value,
          arm: document.querySelector('#arm-outage-button').textContent,
          offline: document.querySelector('#outage-now-button').textContent,
          restore: document.querySelector('#restore-outage-button').textContent,
          offlineDisabled: document.querySelector('#outage-now-button').disabled,
          restoreDisabled: document.querySelector('#restore-outage-button').disabled,
          armedHidden: document.querySelector('#armed-state').hidden,
        });`));
      check(`${lift.label}: the visible radio card and all three controls name the lift they act on`,
        opened.selected === lift.id
          && [opened.arm, opened.offline, opened.restore].every((text) => namesIt(text) && !namesTheOther(text))
          && opened.offlineDisabled === false
          && opened.restoreDisabled === true
          && opened.armedHidden === true,
        JSON.stringify(opened));

      const armMark = requestsSent.length;
      const armedStep = JSON.parse(await run(`
        const feedback = document.querySelector('#operator-action-feedback');
        const priorFeedback = feedback.textContent;
        const waitFor = async (test, ms = 10000) => {
          const deadline = Date.now() + ms;
          while (Date.now() < deadline) { if (test()) return true; await sleep(60); }
          return false;
        };
        const action = document.querySelector('#arm-outage-button');
        action.focus();
        const heldFocus = document.activeElement === action;
        action.click();
        const spoke = await waitFor(() => !feedback.hidden && feedback.textContent !== priorFeedback);
        const message = feedback.textContent;
        const top = document.querySelector('#operator-log .audit-item');
        const title = top.querySelector('strong').textContent;
        const detail = top.querySelector('small').textContent;
        return JSON.stringify({
          spoke,
          heldFocus,
          activeAfter: document.activeElement?.id ?? document.activeElement?.tagName ?? '',
          feedback: message,
          title,
          detail,
          armedHidden: document.querySelector('#armed-state').hidden,
          arm: document.querySelector('#arm-outage-button').textContent,
        });`));
      const armRequests = operatorMutations(requestsSent.slice(armMark));
      check(`${lift.label}: arming issues its own arm request and raises the pending-fault banner`,
        armedStep.spoke === true
          && armRequests.join(' | ') === `POST /api/operator/facilities/${lift.id}/arm`
          && armedStep.armedHidden === false,
        JSON.stringify({ armRequests, armedStep }));
      check(`${lift.label}: the persistent arm result and newest log entry name it and never ${lift.otherLabel}`,
        namesIt(armedStep.feedback) && !namesTheOther(armedStep.feedback)
          && namesIt(armedStep.detail) && !namesTheOther(armedStep.detail)
          && !namesTheOther(armedStep.title),
        JSON.stringify(armedStep));
      check(`${lift.label}: arming from the keyboard moves focus to the stable operations landmark`,
        armedStep.heldFocus === true && armedStep.activeAfter === 'operator-main',
        JSON.stringify(armedStep));

      const pendingStep = JSON.parse(await run(`
        const banner = document.querySelector('#armed-state');
        const armButton = document.querySelector('#arm-outage-button');
        const choose = (id) => [...document.querySelectorAll('input[name="controlled-facility"]')]
          .find((input) => input.value === id).click();
        choose(${JSON.stringify(lift.otherId)});
        await sleep(400);
        const away = {
          hidden: banner.hidden,
          arm: armButton.textContent,
          selected: document.querySelector('input[name="controlled-facility"]:checked')?.value,
          armedCardBadgeVisible: !document.querySelector('#' + ${JSON.stringify(lift.id)} + '-fault').hidden,
          otherCardBadgeVisible: !document.querySelector('#' + ${JSON.stringify(lift.otherId)} + '-fault').hidden,
        };
        choose(${JSON.stringify(lift.id)});
        await sleep(400);
        return JSON.stringify({ away, back: { hidden: banner.hidden, arm: armButton.textContent } });`));
      // This was written the other way round - that moving the selection away
      // HIDES the banner and re-offers the arm button. That is the defect, not
      // the contract. A pending fault is venue-wide state: when the banner
      // followed the selection, an armed Garden fault vanished the moment the
      // selected card moved to East, the page offered to arm East as though nothing
      // were pending, and that second arm silently replaced the first.
      //
      // Two repairs landed in the same pass from different directions and
      // disagreed about which behaviour was correct. Only running this suite
      // showed it; no amount of reading either patch would have.
      //
      // The contract: the banner stays up whichever lift is selected, names the
      // lift actually holding the fault, and arming stays closed until it is
      // spent.
      check(`${lift.label}: the pending fault stays visible and named whichever lift is selected`,
        pendingStep.away.hidden === false
          && pendingStep.back.hidden === false
          && namesIt(pendingStep.away.arm)
          && !namesTheOther(pendingStep.away.arm)
          && namesIt(pendingStep.back.arm)
          && pendingStep.away.selected === lift.otherId
          && pendingStep.away.armedCardBadgeVisible === true
          && pendingStep.away.otherCardBadgeVisible === false,
        JSON.stringify(pendingStep));

      const offlineMark = requestsSent.length;
      const offlineStep = JSON.parse(await run(`
        const feedback = document.querySelector('#operator-action-feedback');
        const priorFeedback = feedback.textContent;
        const waitFor = async (test, ms = 10000) => {
          const deadline = Date.now() + ms;
          while (Date.now() < deadline) { if (test()) return true; await sleep(60); }
          return false;
        };
        const action = document.querySelector('#outage-now-button');
        action.focus();
        const heldFocus = document.activeElement === action;
        action.click();
        const spoke = await waitFor(() => !feedback.hidden && feedback.textContent !== priorFeedback);
        const message = feedback.textContent;
        const top = document.querySelector('#operator-log .audit-item');
        const title = top.querySelector('strong').textContent;
        const detail = top.querySelector('small').textContent;
        const status = await call('get_facility_status', {});
        await sleep(180);
        return JSON.stringify({
          spoke,
          heldFocus,
          activeAfter: document.activeElement?.id ?? document.activeElement?.tagName ?? '',
          feedback: message,
          title,
          detail,
          status,
          arm: document.querySelector('#arm-outage-button').textContent,
          offline: document.querySelector('#outage-now-button').textContent,
          restore: document.querySelector('#restore-outage-button').textContent,
          offlineDisabled: document.querySelector('#outage-now-button').disabled,
          restoreDisabled: document.querySelector('#restore-outage-button').disabled,
          armedHidden: document.querySelector('#armed-state').hidden,
          selectedCardOut: document.querySelector('#' + ${JSON.stringify(lift.id)} + '-card').classList.contains('out'),
          selectedCardBackground: getComputedStyle(document.querySelector('#' + ${JSON.stringify(lift.id)} + '-card')).backgroundColor,
          selectedCardBorder: getComputedStyle(document.querySelector('#' + ${JSON.stringify(lift.id)} + '-card')).borderColor,
        });`));
      const offlineRequests = operatorMutations(requestsSent.slice(offlineMark));
      check(`${lift.label}: taking it offline issues exactly its own outage request`,
        offlineRequests.join(' | ') === `POST /api/operator/facilities/${lift.id}/outage`,
        JSON.stringify(offlineRequests));
      check(`${lift.label}: /api/state reports it out of service and ${lift.otherLabel} untouched`,
        offlineStep.status?.facilities?.find((facility) => facility.id === lift.id)?.status === 'OUT_OF_SERVICE'
          && offlineStep.status?.facilities?.find((facility) => facility.id === lift.otherId)?.status === 'OPERATIONAL',
        JSON.stringify(offlineStep.status));
      check(`${lift.label}: the persistent outage result and newest log entry name it and never ${lift.otherLabel}`,
        offlineStep.spoke === true
          && namesIt(offlineStep.feedback) && !namesTheOther(offlineStep.feedback)
          && namesIt(offlineStep.detail) && !namesTheOther(offlineStep.detail)
          && !namesTheOther(offlineStep.title),
        JSON.stringify(offlineStep));
      check(`${lift.label}: a selected offline card stays visibly red, never green`,
        offlineStep.selectedCardOut === true
          && offlineStep.selectedCardBackground === 'rgb(75, 27, 32)'
          && offlineStep.selectedCardBorder === 'rgb(255, 138, 127)',
        JSON.stringify(offlineStep));
      const visualMatrix = JSON.parse(await run(`
        const choose = (id) => [...document.querySelectorAll('input[name="controlled-facility"]')]
          .find((input) => input.value === id).click();
        const snapshot = (id) => {
          const card = document.querySelector('#' + id + '-card');
          const style = getComputedStyle(card);
          return {
            background: style.backgroundColor,
            border: style.borderColor,
            selectedBadge: getComputedStyle(card.querySelector('.facility-selected')).display,
            selectHint: getComputedStyle(card.querySelector('.facility-select-hint')).display,
          };
        };
        const selectedOffline = snapshot(${JSON.stringify(lift.id)});
        const unselectedOperational = snapshot(${JSON.stringify(lift.otherId)});
        choose(${JSON.stringify(lift.otherId)});
        await sleep(180);
        const unselectedOffline = snapshot(${JSON.stringify(lift.id)});
        const selectedOperational = snapshot(${JSON.stringify(lift.otherId)});
        choose(${JSON.stringify(lift.id)});
        await sleep(180);
        return JSON.stringify({ selectedOffline, unselectedOperational, unselectedOffline, selectedOperational });
      `));
      check(`${lift.label}: all selected/unselected and operational/offline card states remain distinct`,
        visualMatrix.selectedOffline.background === 'rgb(75, 27, 32)'
          && visualMatrix.selectedOffline.border === 'rgb(255, 138, 127)'
          && visualMatrix.selectedOffline.selectedBadge !== 'none'
          && visualMatrix.selectedOffline.selectHint === 'none'
          && visualMatrix.unselectedOffline.background === 'rgb(44, 28, 29)'
          && visualMatrix.unselectedOffline.selectedBadge === 'none'
          && visualMatrix.unselectedOffline.selectHint !== 'none'
          && visualMatrix.selectedOperational.background === 'rgb(26, 51, 44)'
          && visualMatrix.selectedOperational.selectedBadge !== 'none'
          && visualMatrix.selectedOperational.selectHint === 'none'
          && visualMatrix.unselectedOperational.background === 'rgb(22, 43, 37)'
          && visualMatrix.unselectedOperational.selectedBadge === 'none'
          && visualMatrix.unselectedOperational.selectHint !== 'none',
        JSON.stringify(visualMatrix));
      check(`${lift.label}: while it is offline the controls still name it and the pending fault is gone`,
        [offlineStep.arm, offlineStep.offline, offlineStep.restore].every((text) => namesIt(text) && !namesTheOther(text))
          && offlineStep.offlineDisabled === true
          && offlineStep.restoreDisabled === false
          && offlineStep.armedHidden === true,
        JSON.stringify(offlineStep));
      check(`${lift.label}: taking it offline from the keyboard leaves focus on the operations landmark`,
        offlineStep.heldFocus === true && offlineStep.activeAfter === 'operator-main',
        JSON.stringify(offlineStep));

      const restoreMark = requestsSent.length;
      const restoreStep = JSON.parse(await run(`
        const feedback = document.querySelector('#operator-action-feedback');
        const priorFeedback = feedback.textContent;
        const waitFor = async (test, ms = 10000) => {
          const deadline = Date.now() + ms;
          while (Date.now() < deadline) { if (test()) return true; await sleep(60); }
          return false;
        };
        const action = document.querySelector('#restore-outage-button');
        action.focus();
        const heldFocus = document.activeElement === action;
        action.click();
        const spoke = await waitFor(() => !feedback.hidden && feedback.textContent !== priorFeedback);
        const message = feedback.textContent;
        const top = document.querySelector('#operator-log .audit-item');
        const title = top.querySelector('strong').textContent;
        const detail = top.querySelector('small').textContent;
        const status = await call('get_facility_status', {});
        return JSON.stringify({
          spoke,
          heldFocus,
          activeAfter: document.activeElement?.id ?? document.activeElement?.tagName ?? '',
          feedback: message,
          title,
          detail,
          status,
        });`));
      const restoreRequests = operatorMutations(requestsSent.slice(restoreMark));
      check(`${lift.label}: restoring it issues exactly its own restore request`,
        restoreRequests.join(' | ') === `POST /api/operator/facilities/${lift.id}/restore`,
        JSON.stringify(restoreRequests));
      check(`${lift.label}: /api/state reports both lifts operational after the restore`,
        (restoreStep.status?.facilities ?? []).length === 2
          && (restoreStep.status?.facilities ?? []).every((facility) => facility.status === 'OPERATIONAL'),
        JSON.stringify(restoreStep.status));
      check(`${lift.label}: the persistent restore result and newest log entry name it and never ${lift.otherLabel}`,
        restoreStep.spoke === true
          && namesIt(restoreStep.feedback) && !namesTheOther(restoreStep.feedback)
          && namesIt(restoreStep.detail) && !namesTheOther(restoreStep.detail)
          && !namesTheOther(restoreStep.title),
        JSON.stringify(restoreStep));
      check(`${lift.label}: restoring it from the keyboard leaves focus on the operations landmark`,
        restoreStep.heldFocus === true && restoreStep.activeAfter === 'operator-main',
        JSON.stringify(restoreStep));
    }

    scenario('a visitor session cannot act as the venue');
    const roleCheck = await run(`
      const session = await (await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'visitor', demoId: ${JSON.stringify(demoId)} }) })).json();
      const attempt = await fetch('/api/operator/facilities/east-lift/outage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Demo-Session': session.session.token },
        body: JSON.stringify({ reasonCode: 'LIFT_DOOR_FAULT' }),
      });
      return JSON.stringify({ status: attempt.status, body: await attempt.json() });`);
    const role = JSON.parse(roleCheck);
    check('the server refuses a visitor token on an operations endpoint', role.status === 403, JSON.stringify(role));
    check('the refusal names the role boundary', role.body?.error?.code === 'ROLE_FORBIDDEN', JSON.stringify(role.body));

    scenario('confirmed bookings require an explicit operator acknowledgement before their lift is stopped');
    await evaluate(client, `document.querySelector('#operator-reset-button').click(); return true;`);
    await sleep(2_600);
    // Freeze only the operator's state reads so its in-memory UI snapshot stays
    // at READY while the visitor confirms. The next outage click must perform
    // its own fresh read instead of trusting the one-second poll.
    await evaluate(client, `
      window.__operatorQaFetch = window.fetch;
      window.fetch = (...args) => {
        const input = args[0];
        const raw = typeof input === 'string' ? input : input?.url;
        if (new URL(raw, location.href).pathname === '/api/state') return new Promise(() => {});
        return window.__operatorQaFetch(...args);
      };
      return true;`);
    const visitorRun = (body) => evaluate(visitorClient, `${PAGE}\n${body}`);
    // A real visitor sees this tab in the foreground. Chrome deliberately does
    // not perform visual scrolling for a background target, which would turn a
    // viewport assertion into a test-harness artefact rather than a UX check.
    await visitorClient.send('Page.bringToFront');
    const bookedForImpact = JSON.parse(await visitorRun(`
      const waitFor = async (test, ms = 10000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) { if (await test()) return true; await sleep(80); }
        return false;
      };
      await waitFor(async () => (await call('get_access_bundle_status', {})).phase === 'READY');
      document.querySelector('#requirements-form').reset();
      document.querySelector('#build-plan-button').click();
      const staged = await waitFor(() => !document.querySelector('#decision-section').hidden);
      const positioned = await waitFor(() => {
        const rect = document.querySelector('#decision-section').getBoundingClientRect();
        return document.activeElement?.id === 'decision-heading'
          && rect.top < window.innerHeight
          && rect.bottom > 0;
      });
      const plannedRoute = document.querySelector('#route-steps').textContent.replace(/\\s+/g, ' ').trim();
      const decisionRect = document.querySelector('#decision-section').getBoundingClientRect();
      const decisionPlacement = {
        positioned,
        focused: document.activeElement?.id,
        top: decisionRect.top,
        bottom: decisionRect.bottom,
        viewportHeight: window.innerHeight,
      };
      document.querySelector('#confirm-button').click();
      const confirmed = await waitFor(() => !document.querySelector('#receipt-section').hidden);
      const status = await call('get_access_bundle_status', {});
      const event = await call('get_event_access_state', {});
      return JSON.stringify({
        staged,
        confirmed,
        plannedRoute,
        status,
        event,
        decisionPlacement,
        receipt: document.querySelector('#receipt-number').textContent,
      });`));
    check('the shared visitor page has a confirmed East booking before the operator changes anything',
      bookedForImpact.staged === true
        && bookedForImpact.confirmed === true
        && bookedForImpact.status.phase === 'CONFIRMED'
        && bookedForImpact.plannedRoute.includes('East Lift L2')
        && bookedForImpact.decisionPlacement.positioned === true
        && bookedForImpact.decisionPlacement.focused === 'decision-heading'
        && bookedForImpact.decisionPlacement.top < bookedForImpact.decisionPlacement.viewportHeight
        && bookedForImpact.decisionPlacement.bottom > 0
        && /^NSWR-\d{5}$/.test(bookedForImpact.receipt)
        && bookedForImpact.event.reservedResourceCount === 3,
      JSON.stringify(bookedForImpact));
    await client.send('Page.bringToFront');

    const staleOperatorMark = requestsSent.length;
    const staleOperatorGuard = JSON.parse(await run(`
      const waitFor = async (test, ms = 10000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) { if (await test()) return true; await sleep(80); }
        return false;
      };
      window.fetch = window.__operatorQaFetch;
      delete window.__operatorQaFetch;
      const staleBeforeClick = document.querySelector('#proof-phase').textContent;
      document.querySelector('#facility-east').click();
      document.querySelector('#outage-now-button').click();
      const reviewOpened = await waitFor(() => !document.querySelector('#manual-impact-confirmation').hidden);
      const freshAfterClick = document.querySelector('#proof-phase').textContent;
      const liftState = (await call('get_facility_status', {})).facilities
        .find((facility) => facility.id === 'east-lift')?.status;
      document.querySelector('#cancel-outage-button').click();
      return JSON.stringify({
        staleBeforeClick,
        freshAfterClick,
        reviewOpened,
        liftState,
        focused: document.activeElement?.id,
      });`));
    const staleOperatorMutations = operatorMutations(requestsSent.slice(staleOperatorMark));
    check('a booking confirmed between operator polls cannot bypass the inline impact review',
      staleOperatorGuard.staleBeforeClick === 'READY'
        && staleOperatorGuard.freshAfterClick === 'CONFIRMED'
        && staleOperatorGuard.reviewOpened === true
        && staleOperatorGuard.liftState === 'OPERATIONAL'
        && staleOperatorGuard.focused === 'outage-now-button'
        && staleOperatorMutations.length === 0,
      JSON.stringify({ staleOperatorGuard, staleOperatorMutations }));

    const unrelatedBefore = JSON.parse(await run(`
      document.querySelector('#facility-garden').click();
      await sleep(250);
      return JSON.stringify({
        noteHidden: document.querySelector('#manual-impact-note').hidden,
        confirmationHidden: document.querySelector('#manual-impact-confirmation').hidden,
        outageLabel: document.querySelector('#outage-now-button').textContent,
        globalImpactHidden: document.querySelector('#booking-impact').hidden,
        armDisabled: document.querySelector('#arm-outage-button').disabled,
        armLabel: document.querySelector('#arm-outage-button').textContent,
        raceIntro: document.querySelector('#race-intro').textContent,
      });`));
    check('selecting the unbooked Garden lift raises no false booking-impact warning',
      unrelatedBefore.noteHidden === true
        && unrelatedBefore.confirmationHidden === true
        && unrelatedBefore.globalImpactHidden === true
        && unrelatedBefore.armDisabled === true
        && /Safe-failure test complete/.test(unrelatedBefore.armLabel)
        && /Reset the demo/.test(unrelatedBefore.raceIntro)
        && !/before the server commits/.test(unrelatedBefore.raceIntro)
        && !/impact|affect|review/i.test(unrelatedBefore.outageLabel),
      JSON.stringify(unrelatedBefore));

    const unrelatedOutage = JSON.parse(await run(`
      const waitFor = async (test, ms = 10000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) { if (await test()) return true; await sleep(80); }
        return false;
      };
      document.querySelector('#outage-now-button').click();
      await waitFor(() => document.querySelector('#garden-lift-state').textContent === 'OUT OF SERVICE');
      const down = await call('get_facility_status', {});
      const hiddenAfterPoll = document.querySelector('#booking-impact').hidden;
      document.querySelector('#restore-outage-button').click();
      await waitFor(() => document.querySelector('#garden-lift-state').textContent === 'OPERATIONAL');
      const restored = await call('get_facility_status', {});
      return JSON.stringify({ down, hiddenAfterPoll, restored });`));
    check('taking only the unbooked Garden lift offline leaves the East booking intact and raises no impact',
      unrelatedOutage.down.facilities.find((facility) => facility.id === 'garden-lift')?.status === 'OUT_OF_SERVICE'
        && unrelatedOutage.down.bookingImpact === null
        && unrelatedOutage.hiddenAfterPoll === true
        && unrelatedOutage.restored.facilities.every((facility) => facility.status === 'OPERATIONAL'),
      JSON.stringify(unrelatedOutage));

    const impactReviewMark = requestsSent.length;
    const impactReview = JSON.parse(await run(`
      document.querySelector('#facility-east').click();
      await sleep(250);
      const before = {
        noteHidden: document.querySelector('#manual-impact-note').hidden,
        note: document.querySelector('#manual-impact-note').textContent,
        outageLabel: document.querySelector('#outage-now-button').textContent,
        confirmationHidden: document.querySelector('#manual-impact-confirmation').hidden,
      };
      document.querySelector('#outage-now-button').click();
      await sleep(250);
      const review = {
        confirmationHidden: document.querySelector('#manual-impact-confirmation').hidden,
        heading: document.querySelector('#manual-impact-confirmation-heading').textContent,
        message: document.querySelector('#manual-impact-confirmation-message').textContent,
        confirm: document.querySelector('#confirm-outage-button').textContent,
        cancel: document.querySelector('#cancel-outage-button').textContent,
        expanded: document.querySelector('#outage-now-button').getAttribute('aria-expanded'),
        focused: document.activeElement?.id,
      };
      const stillUp = await call('get_facility_status', {});
      document.querySelector('#cancel-outage-button').click();
      await sleep(100);
      const cancelled = {
        confirmationHidden: document.querySelector('#manual-impact-confirmation').hidden,
        expanded: document.querySelector('#outage-now-button').getAttribute('aria-expanded'),
        focused: document.activeElement?.id,
      };
      return JSON.stringify({ before, review, stillUp, cancelled });`));
    const impactReviewMutations = operatorMutations(requestsSent.slice(impactReviewMark));
    check('the booked lift is clearly marked as a booking risk before any action',
      impactReview.before.noteHidden === false
        && impactReview.before.note.includes(bookedForImpact.receipt)
        && impactReview.before.note.includes('will disrupt the route')
        && impactReview.before.note.includes('booking stays active')
        && /Review impact before taking East Lift L2 offline/.test(impactReview.before.outageLabel),
      JSON.stringify(impactReview.before));
    check('the first click opens an inline acknowledgement and performs no outage request',
      impactReview.review.confirmationHidden === false
        && impactReview.review.heading === 'This will break a confirmed route'
        && impactReview.review.message.includes(bookedForImpact.receipt)
        && impactReview.review.message.includes('no email, SMS, cancellation or reroute')
        && impactReview.review.confirm.includes('East Lift L2')
        && impactReview.review.cancel.includes('East Lift L2')
        && impactReview.review.expanded === 'true'
        && impactReview.review.focused === 'manual-impact-confirmation-heading'
        && impactReview.stillUp.facilities.find((facility) => facility.id === 'east-lift')?.status === 'OPERATIONAL'
        && impactReviewMutations.length === 0,
      JSON.stringify({ impactReview, impactReviewMutations }));
    check('cancelling the acknowledgement keeps the lift in service and returns focus to the initiating control',
      impactReview.cancelled.confirmationHidden === true
        && impactReview.cancelled.expanded === 'false'
        && impactReview.cancelled.focused === 'outage-now-button',
      JSON.stringify(impactReview.cancelled));

    const visitorFocusBeforeImpact = await visitorRun(`
      document.querySelector('#copy-prompt-button').focus();
      return document.activeElement?.id;`);
    const bookedOutageMark = requestsSent.length;
    const bookedOutage = JSON.parse(await run(`
      const waitFor = async (test, ms = 10000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) { if (await test()) return true; await sleep(80); }
        return false;
      };
      document.querySelector('#outage-now-button').click();
      const reviewReady = await waitFor(() => (
        !document.querySelector('#manual-impact-confirmation').hidden
          && document.querySelector('#outage-now-button').getAttribute('aria-expanded') === 'true'
          && !document.querySelector('#confirm-outage-button').disabled
          && document.activeElement?.id === 'manual-impact-confirmation-heading'
      ));
      document.querySelector('#confirm-outage-button').click();
      const observed = await waitFor(() => (
        document.querySelector('#east-lift-state').textContent === 'OUT OF SERVICE'
          && !document.querySelector('#booking-impact').hidden
      ));
      const first = {
        observed,
        heading: document.querySelector('#booking-impact-heading').textContent,
        message: document.querySelector('#booking-impact-message').textContent,
        proof: document.querySelector('#booking-impact-proof').textContent,
        atomic: {
          bookings: document.querySelector('#proof-bookings').textContent,
          reserved: document.querySelector('#proof-resources').textContent,
          phase: document.querySelector('#proof-phase').textContent,
        },
      };
      const status = await call('get_facility_status', {});
      await sleep(1800);
      const later = {
        hidden: document.querySelector('#booking-impact').hidden,
        heading: document.querySelector('#booking-impact-heading').textContent,
        message: document.querySelector('#booking-impact-message').textContent,
        proof: document.querySelector('#booking-impact-proof').textContent,
      };
      return JSON.stringify({ reviewReady, first, status, later });`));
    const bookedOutageMutations = operatorMutations(requestsSent.slice(bookedOutageMark));
    check('only the explicit second-step acknowledgement takes the booked East lift offline',
      bookedOutage.reviewReady === true
        && bookedOutageMutations.join(' | ') === 'POST /api/operator/facilities/east-lift/outage'
        && bookedOutage.status.facilities.find((facility) => facility.id === 'east-lift')?.status === 'OUT_OF_SERVICE',
      JSON.stringify({ bookedOutageMutations, status: bookedOutage.status }));
    check('the operator warning names the booking, the failed lift and the actions this demo did not take',
      bookedOutage.first.observed === true
        && bookedOutage.first.heading === 'A confirmed booking has lost its working route'
        && bookedOutage.first.message.includes(bookedForImpact.receipt)
        && bookedOutage.first.message.includes('East Lift L2')
        && bookedOutage.first.proof.includes('sends no email, SMS or staff workflow')
        && bookedOutage.first.proof.includes('performs no cancellation or reroute')
        && bookedOutage.first.atomic.bookings === '1'
        && bookedOutage.first.atomic.reserved === '3'
        && bookedOutage.first.atomic.phase === 'CONFIRMED'
        && bookedOutage.status.bookingImpact.bookingStillStands === true
        && bookedOutage.status.bookingImpact.automaticCancellation === false
        && bookedOutage.status.bookingImpact.automaticReroute === false
        && bookedOutage.status.bookingImpact.pageWarningVisible === true
        && bookedOutage.status.bookingImpact.outOfBandNotification === false,
      JSON.stringify(bookedOutage));
    check('the confirmed-route warning survives an ordinary operator poll unchanged',
      bookedOutage.later.hidden === false
        && bookedOutage.later.heading === bookedOutage.first.heading
        && bookedOutage.later.message === bookedOutage.first.message
        && bookedOutage.later.proof === bookedOutage.first.proof,
      JSON.stringify({ first: bookedOutage.first, later: bookedOutage.later }));

    const visitorImpact = JSON.parse(await visitorRun(`
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && document.querySelector('#booking-impact-alert').hidden) await sleep(80);
      const status = await call('get_access_bundle_status', {});
      const event = await call('get_event_access_state', {});
      return JSON.stringify({
        hidden: document.querySelector('#booking-impact-alert').hidden,
        heading: document.querySelector('#booking-impact-alert-heading').textContent,
        message: document.querySelector('#booking-impact-alert-message').textContent,
        proof: document.querySelector('#booking-impact-alert-proof').textContent,
        receiptVisible: !document.querySelector('#receipt-section').hidden,
        receipt: document.querySelector('#receipt-number').textContent,
        focused: document.activeElement?.id,
        status,
        event,
      });`));
    check('the visitor keeps the receipt but gets a persistent visible warning for the failed booked lift',
      visitorImpact.hidden === false
        && visitorImpact.heading === 'Your confirmed route has been disrupted'
        && visitorImpact.message.includes(bookedForImpact.receipt)
        && visitorImpact.message.includes('East Lift L2')
        && visitorImpact.proof.includes('sends no email, SMS or staff workflow')
        && visitorImpact.proof.includes('performs no cancellation or reroute')
        && visitorImpact.receiptVisible === true
        && visitorImpact.receipt === bookedForImpact.receipt
        && visitorFocusBeforeImpact === 'copy-prompt-button'
        && visitorImpact.focused === 'copy-prompt-button'
        && visitorImpact.status.phase === 'CONFIRMED'
        && visitorImpact.status.booking.partialReservations === 0
        && visitorImpact.event.reservedResourceCount === 3,
      JSON.stringify(visitorImpact));

    const bothOffline = JSON.parse(await run(`
      const waitFor = async (test, ms = 10000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) { if (await test()) return true; await sleep(80); }
        return false;
      };
      document.querySelector('#facility-garden').click();
      document.querySelector('#outage-now-button').click();
      await waitFor(() => document.querySelector('#garden-lift-state').textContent === 'OUT OF SERVICE');
      const status = await call('get_facility_status', {});
      return JSON.stringify({
        status,
        heading: document.querySelector('#booking-impact-heading').textContent,
        message: document.querySelector('#booking-impact-message').textContent,
        hidden: document.querySelector('#booking-impact').hidden,
      });`));
    check('with both lifts offline the operator shows venue-wide loss but attributes impact only to the booked lift',
      bothOffline.hidden === false
        && bothOffline.heading === 'No step-free lift route is currently available'
        && bothOffline.message.includes('Both lifts are out of service')
        && bothOffline.status.facilities.every((facility) => facility.status === 'OUT_OF_SERVICE')
        && bothOffline.status.bookingImpact.affectedFacilities.join() === 'East Lift L2',
      JSON.stringify(bothOffline));

    await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await visitorClient.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(150);
    const impactMobile = await evaluate(client, `
      const warning = document.querySelector('#booking-impact').getBoundingClientRect();
      return {
        hidden: document.querySelector('#booking-impact').hidden,
        warningWidth: warning.width,
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth,
      };`);
    const visitorImpactMobile = await evaluate(visitorClient, `
      const warning = document.querySelector('#booking-impact-alert').getBoundingClientRect();
      return {
        hidden: document.querySelector('#booking-impact-alert').hidden,
        warningWidth: warning.width,
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth,
      };`);
    check('operator and visitor impact warnings fit a 390 px screen without horizontal overflow',
      impactMobile.hidden === false
        && visitorImpactMobile.hidden === false
        && impactMobile.warningWidth > 0
        && visitorImpactMobile.warningWidth > 0
        && impactMobile.contentWidth <= impactMobile.viewportWidth
        && visitorImpactMobile.contentWidth <= visitorImpactMobile.viewportWidth,
      JSON.stringify({ operator: impactMobile, visitor: visitorImpactMobile }));
    await client.send('Emulation.clearDeviceMetricsOverride');
    await visitorClient.send('Emulation.clearDeviceMetricsOverride');

    const recoveredBookingImpact = JSON.parse(await run(`
      const waitFor = async (test, ms = 10000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) { if (await test()) return true; await sleep(80); }
        return false;
      };
      document.querySelector('#facility-east').click();
      document.querySelector('#restore-outage-button').click();
      await waitFor(() => document.querySelector('#east-lift-state').textContent === 'OPERATIONAL');
      return JSON.stringify({ status: await call('get_facility_status', {}) });`));
    const visitorAfterRestore = JSON.parse(await visitorRun(`
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !document.querySelector('#booking-impact-alert').hidden) await sleep(80);
      return JSON.stringify({
        impactHidden: document.querySelector('#booking-impact-alert').hidden,
        a11yAlert: document.querySelector('#a11y-alert').textContent,
        receiptVisible: !document.querySelector('#receipt-section').hidden,
        status: await call('get_access_bundle_status', {}),
      });`));
    check('restoring the booked lift clears both the visible and screen-reader warning without deleting the booking',
      recoveredBookingImpact.status.facilities.find((facility) => facility.id === 'east-lift')?.status === 'OPERATIONAL'
        && recoveredBookingImpact.status.bookingImpact === null
        && visitorAfterRestore.impactHidden === true
        && visitorAfterRestore.a11yAlert === ''
        && visitorAfterRestore.receiptVisible === true
        && visitorAfterRestore.status.phase === 'CONFIRMED',
      JSON.stringify({ operator: recoveredBookingImpact, visitor: visitorAfterRestore }));

    await evaluate(client, `document.querySelector('#operator-reset-button').click(); return true;`);
    const visitorAfterImpactReset = JSON.parse(await visitorRun(`
      const deadline = Date.now() + 10000;
      let status = await call('get_access_bundle_status', {});
      while (Date.now() < deadline && status.phase !== 'READY') {
        await sleep(80);
        status = await call('get_access_bundle_status', {});
      }
      await sleep(1200);
      return JSON.stringify({
        status,
        impactHidden: document.querySelector('#booking-impact-alert').hidden,
        receiptHidden: document.querySelector('#receipt-section').hidden,
        a11yAlert: document.querySelector('#a11y-alert').textContent,
      });`));
    check('reset removes the old receipt and leaves no stale visual or screen-reader disruption warning',
      visitorAfterImpactReset.status.phase === 'READY'
        && visitorAfterImpactReset.impactHidden === true
        && visitorAfterImpactReset.receiptHidden === true
        && visitorAfterImpactReset.a11yAlert === '',
      JSON.stringify(visitorAfterImpactReset));

    scenario('the operator proof and controls remain visible and usable at judge viewports');
    await evaluate(client, `document.querySelector('#operator-reset-button').click(); return true;`);
    await sleep(2_600);
    await evaluate(visitorClient, `document.querySelector('#requirements-form').requestSubmit(); return true;`);
    check('the responsive operator check reaches the long awaiting-confirmation phase',
      await waitForPage(visitorClient, `!document.querySelector('#decision-section').hidden`),
      'the visitor never staged a plan');
    await sleep(1_200);
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1920,
      height: 889,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(100);
    await evaluate(client, `
      document.documentElement.style.scrollBehavior = 'auto';
      window.scrollTo(0, 0);
      return true;
    `);
    await sleep(50);
    const operatorDesktopLayout = await evaluate(client, `
      const proof = document.querySelector('.operator-overview-proof').getBoundingClientRect();
      const status = document.querySelector('#operator-webmcp-status').textContent.replace(/\\s+/g, ' ').trim();
      return {
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth,
        proofTop: proof.top,
        proofBottom: proof.bottom,
        proofDocumentTop: proof.top + window.scrollY,
        proofDocumentBottom: proof.bottom + window.scrollY,
        status,
      };
    `);
    check('the 1920×889 operator layout has no horizontal overflow',
      operatorDesktopLayout.contentWidth <= operatorDesktopLayout.viewportWidth,
      JSON.stringify(operatorDesktopLayout));
    check('the no-half-bookings proof is entirely inside the first desktop viewport',
      operatorDesktopLayout.proofDocumentTop >= 0 && operatorDesktopLayout.proofDocumentBottom <= 889,
      JSON.stringify(operatorDesktopLayout));
    check('the operator badge visibly names WebMCP before its live counts',
      operatorDesktopLayout.status.startsWith('WebMCP ·'),
      operatorDesktopLayout.status);

    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await sleep(100);
    await evaluate(client, `window.scrollTo(0, 0); return true;`);
    await sleep(50);
    const operatorMobileLayout = await evaluate(client, `
      const rect = (selector) => {
        const value = document.querySelector(selector).getBoundingClientRect();
        return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
      };
      const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const brand = rect('.operator-brand');
      const actions = rect('.operator-header-actions');
      const mark = document.querySelector('.operator-brand .wordmark-mark');
      const markStyle = getComputedStyle(mark);
      const facilityCards = ['#east-lift-card', '#garden-lift-card'].map((selector) => rect(selector));
      const buttons = ['#arm-outage-button', '#outage-now-button', '#restore-outage-button']
        .map((selector) => rect(selector));
      const log = document.querySelector('#operator-log');
      const empty = document.createElement('li');
      empty.className = 'audit-empty';
      empty.textContent = 'Waiting for server events.';
      log.append(empty);
      const parseRgb = (value) => (value.match(/\\d+(?:\\.\\d+)?/g) || []).slice(0, 3).map(Number);
      const luminance = (value) => {
        const channels = parseRgb(value).map((part) => part / 255).map((part) => part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4);
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
      };
      const foreground = getComputedStyle(empty).color;
      const background = getComputedStyle(log).backgroundColor;
      const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      const result = {
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth,
        headerOverlap: overlaps(brand, actions),
        brand,
        actions,
        markDisplay: markStyle.display,
        markPlaceItems: markStyle.placeItems,
        facilityCards,
        buttons,
        contrast: (lighter + 0.05) / (darker + 0.05),
        foreground,
        background,
        phase: document.querySelector('#proof-phase').textContent.trim(),
        phaseBox: {
          clientWidth: document.querySelector('#proof-phase').clientWidth,
          scrollWidth: document.querySelector('#proof-phase').scrollWidth,
        },
      };
      empty.remove();
      return result;
    `);
    check('the 390×844 operator layout has no horizontal overflow',
      operatorMobileLayout.contentWidth <= operatorMobileLayout.viewportWidth,
      JSON.stringify(operatorMobileLayout));
    check('the mobile operator brand and toolbar do not overlap',
      operatorMobileLayout.headerOverlap === false,
      JSON.stringify({ brand: operatorMobileLayout.brand, actions: operatorMobileLayout.actions }));
    check('the long internal phase is presented as a compact operator label',
      operatorMobileLayout.phase === 'AWAITING VISITOR'
        && operatorMobileLayout.phaseBox.scrollWidth <= operatorMobileLayout.phaseBox.clientWidth + 1,
      JSON.stringify({ phase: operatorMobileLayout.phase, box: operatorMobileLayout.phaseBox }));
    check('the RH mark remains centred by its rendered layout',
      operatorMobileLayout.markDisplay === 'grid' && operatorMobileLayout.markPlaceItems === 'center',
      JSON.stringify(operatorMobileLayout));
    check('both mobile lift cards remain visible and at least 44 CSS pixels tall',
      operatorMobileLayout.facilityCards.length === 2
        && operatorMobileLayout.facilityCards.every(({ height }) => height >= 44),
      JSON.stringify(operatorMobileLayout.facilityCards));
    check('all three mobile lift controls are at least 44 CSS pixels tall',
      operatorMobileLayout.buttons.every(({ height }) => height >= 44),
      JSON.stringify(operatorMobileLayout.buttons));
    check('the empty operator log meets WCAG AA normal-text contrast',
      operatorMobileLayout.contrast >= 4.5,
      JSON.stringify(operatorMobileLayout));
    const mobileFacilityBeforeKeyboard = await evaluate(client, `
      const east = document.querySelector('#facility-east');
      const gardenCard = document.querySelector('#garden-lift-card');
      east.focus();
      const eastCard = east.nextElementSibling;
      const targetScroll = eastCard.getBoundingClientRect().bottom + window.scrollY - window.innerHeight + 12;
      window.scrollTo(0, Math.max(0, targetScroll));
      const box = gardenCard.getBoundingClientRect();
      return {
        selected: document.querySelector('input[name="controlled-facility"]:checked')?.value,
        gardenTop: box.top,
        gardenBottom: box.bottom,
        viewportHeight: window.innerHeight,
      };
    `);
    await pressKey(client, 'ArrowDown');
    await sleep(150);
    const mobileFacilityKeyboard = await evaluate(client, `
      const radio = document.querySelector('input[name="controlled-facility"]:checked');
      const card = radio.nextElementSibling;
      const box = card.getBoundingClientRect();
      return {
        selected: radio.value,
        focused: document.activeElement === radio,
        focusVisible: radio.matches(':focus-visible'),
        cardTop: box.top,
        cardBottom: box.bottom,
        viewportHeight: window.innerHeight,
      };
    `);
    check('keyboard selection scrolls the visible mobile lift card fully into view',
      mobileFacilityBeforeKeyboard.selected === 'east-lift'
        && mobileFacilityBeforeKeyboard.gardenTop >= mobileFacilityBeforeKeyboard.viewportHeight
        && mobileFacilityKeyboard.selected === 'garden-lift'
        && mobileFacilityKeyboard.focused === true
        && mobileFacilityKeyboard.focusVisible === true
        && mobileFacilityKeyboard.cardTop >= 0
        && mobileFacilityKeyboard.cardBottom <= mobileFacilityKeyboard.viewportHeight,
      JSON.stringify(mobileFacilityKeyboard));
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 568,
      deviceScaleFactor: 1,
      mobile: true,
    });
    const operatorTextZoom = await evaluate(client, `
      document.documentElement.style.fontSize = '200%';
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const viewportWidth = document.documentElement.clientWidth;
      const result = {
        viewportWidth,
        contentWidth: document.documentElement.scrollWidth,
        offenders: [...document.querySelectorAll('body *')]
          .filter((element) => element.getClientRects().length > 0)
          .map((element) => ({
            selector: element.id ? '#' + element.id : element.className ? '.' + String(element.className).trim().replace(/\\s+/g, '.') : element.tagName,
            right: Math.round(element.getBoundingClientRect().right),
          }))
          .filter(({ right }) => right > viewportWidth + 1)
          .slice(0, 12),
      };
      document.documentElement.style.removeProperty('font-size');
      return result;
    `);
    check('the 320 px operator reflows without horizontal scrolling at 200% text size',
      operatorTextZoom.contentWidth <= operatorTextZoom.viewportWidth,
      JSON.stringify(operatorTextZoom));
    await client.send('Emulation.clearDeviceMetricsOverride');

    scenario('a shared link puts both pages on the same venue');
    const shared = await run(`
      const id = new URL(location.href).searchParams.get('demo');
      return JSON.stringify({ id, matches: id === ${JSON.stringify(demoId)} });`);
    check('the operations page joined the visitor venue from the link', JSON.parse(shared).matches === true, shared);
    const operatorClient = client;
    client = visitorClient;
    await visitorClient.send('Target.closeTarget', { targetId: operatorTarget.targetId });
    operatorClient.close();

    scenario('the manual form cannot submit missing numeric requirements');
    await freshVenue();
    const requiredNumbers = await run(`
      const form = document.querySelector('#requirements-form');
      const width = form.elements.wheelchairWidthCm;
      const distance = form.elements.maxDistanceM;
      width.value = '';
      const widthInvalid = !width.checkValidity() && !form.checkValidity();
      document.querySelector('#build-plan-button').click();
      await sleep(300);
      const afterWidth = await call('get_access_bundle_status', {});
      width.value = '72';
      distance.value = '';
      const distanceInvalid = !distance.checkValidity() && !form.checkValidity();
      document.querySelector('#build-plan-button').click();
      await sleep(300);
      const afterDistance = await call('get_access_bundle_status', {});
      distance.value = '80';
      return JSON.stringify({ widthInvalid, distanceInvalid, afterWidth, afterDistance });`);
    const required = JSON.parse(requiredNumbers);
    check('an empty wheelchair width is invalid', required.widthInvalid === true, requiredNumbers);
    check('an empty maximum distance is invalid', required.distanceInvalid === true, requiredNumbers);
    check('neither invalid submit creates a plan',
      required.afterWidth.phase === 'READY' && required.afterDistance.phase === 'READY',
      requiredNumbers);

    scenario('rapid repeated visitor actions create one logical transition');
    await freshVenue();
    const failedBeforeRapidActions = failedResponses.length;
    const rapid = await run(`
      const build = document.querySelector('#build-plan-button');
      build.click();
      build.click();
      await sleep(2400);
      const afterBuild = await call('get_access_bundle_status', {});
      const feedback = document.querySelector('#action-feedback');
      const feedbackAtBuild = {
        visible: !feedback.hidden,
        text: feedback.textContent,
        insidePlan: feedback.closest('#assurance-card')?.id === 'assurance-card',
      };
      // The former overlay disappeared after 4.2 seconds. Cross that boundary
      // and two or more polling cycles before accepting the result as durable.
      await sleep(4600);
      const feedbackAfterFormerTimeout = {
        visible: !feedback.hidden,
        text: feedback.textContent,
        insidePlan: feedback.closest('#assurance-card')?.id === 'assurance-card',
      };

      const confirm = document.querySelector('#confirm-button');
      confirm.click();
      confirm.click();
      await sleep(2400);
      const afterConfirm = await call('get_access_bundle_status', {});
      const eventState = await call('get_event_access_state', {});
      return JSON.stringify({ afterBuild, feedbackAtBuild, feedbackAfterFormerTimeout, afterConfirm, eventState });
    `);
    const repeated = JSON.parse(rapid);
    const rapidFailures = failedResponses.slice(failedBeforeRapidActions);
    check('a double build creates one staged plan',
      repeated.afterBuild.phase === 'AWAITING_HUMAN_CONFIRMATION' && Boolean(repeated.afterBuild.plan?.id),
      JSON.stringify(repeated.afterBuild));
    check('the build result remains visible inside the plan after the former timeout and multiple polls',
      repeated.feedbackAtBuild.visible === true
        && repeated.feedbackAfterFormerTimeout.visible === true
        && repeated.feedbackAfterFormerTimeout.insidePlan === true
        && repeated.feedbackAfterFormerTimeout.text === repeated.feedbackAtBuild.text
        && repeated.feedbackAfterFormerTimeout.text.includes('Nothing is booked yet'),
      JSON.stringify({ atBuild: repeated.feedbackAtBuild, after: repeated.feedbackAfterFormerTimeout }));
    check('a double confirmation creates one booking',
      repeated.afterConfirm.phase === 'CONFIRMED'
        && Boolean(repeated.afterConfirm.booking?.reference)
        && repeated.afterConfirm.booking?.partialReservations === 0,
      JSON.stringify(repeated.afterConfirm));
    check('the repeated clicks reserve exactly one complete resource set',
      repeated.eventState.reservedResourceCount === 3,
      JSON.stringify(repeated.eventState));
    check('rapid repeated visitor actions produce no failed request',
      rapidFailures.length === 0,
      JSON.stringify(rapidFailures));

    scenario('a reload keeps the same venue and rebuilds the correct tool surface');
    await freshVenue();
    const beforeReload = await run(`
      return JSON.stringify({
        demoId: new URL(location.href).searchParams.get('demo'),
        phase: (await call('get_access_bundle_status', {})).phase,
        tools: await names(),
      });
    `);
    await client.send('Page.reload', { ignoreCache: true });
    const reloadReady = await waitForPage(client,
      `document.readyState === 'complete' && Boolean(document.querySelector('#requirements-form'))`,
      10_000);
    await sleep(2_600);
    const afterReload = await run(`
      return JSON.stringify({
        demoId: new URL(location.href).searchParams.get('demo'),
        phase: (await call('get_access_bundle_status', {})).phase,
        tools: await names(),
      });
    `);
    const reloadBefore = JSON.parse(beforeReload);
    const reloadAfter = JSON.parse(afterReload);
    check('the visitor page becomes ready again after reload', reloadReady === true, String(reloadReady));
    check('reload preserves the demo identity and state',
      reloadAfter.demoId === reloadBefore.demoId && reloadAfter.phase === reloadBefore.phase,
      `${beforeReload} -> ${afterReload}`);
    check('reload reconstructs exactly the same tool registry',
      reloadAfter.tools.join() === reloadBefore.tools.join(),
      `${reloadBefore.tools.join(', ')} -> ${reloadAfter.tools.join(', ')}`);

    scenario('the page stays usable without sight or a mouse');
    await freshVenue();
    const a11y = await run(`
      // The focus ring has to be measured while the form is still editable:
      // once a plan is staged the inputs are legitimately disabled.
      const width = document.querySelector('input[name=wheelchairWidthCm]');
      width.focus();
      const focusedTheField = document.activeElement === width;
      const ring = getComputedStyle(width.closest('.input-unit'));
      const focusRing = ring.outlineStyle + ' ' + ring.outlineWidth;

      const before = document.querySelector('#a11y-status').textContent;
      const found = await call('find_access_bundle', ${JSON.stringify(FULL)});
      await settle();
      await call('stage_access_bundle', { planId: found.plan.id, expectedVenueRevision: found.plan.basedOnRevision });
      await settle();
      const announced = document.querySelector('#a11y-status').textContent;

      // A live region that is rewritten on every poll re-announces itself.
      const incidentText = document.querySelector('#incident-message');
      const firstNode = incidentText.firstChild;
      await sleep(2200);
      const nodeSurvivedTwoPolls = incidentText.firstChild === firstNode;

      // Focus must survive the demo control arming itself a second later.
      const fault = document.querySelector('#fault-button');
      fault.focus();
      fault.click();
      await sleep(2200);
      const focusKept = document.activeElement === fault;

      return JSON.stringify({
        focusedTheField,
        focusRing,
        regionsExist: Boolean(document.querySelector('#a11y-status') && document.querySelector('#a11y-alert')),
        statusRole: document.querySelector('#a11y-status').getAttribute('role'),
        actionFeedbackRole: document.querySelector('#action-feedback').getAttribute('role'),
        incidentHasAlertRole: document.querySelector('#incident').getAttribute('role'),
        announcedOnAgentAction: announced !== before && announced.length > 0,
        announcedText: announced,
        nodeSurvivedTwoPolls,
        focusKept,
        faultAriaDisabled: fault.getAttribute('aria-disabled'),
        mainFocusable: document.querySelector('#main').getAttribute('tabindex'),
      });`);
    const acc = JSON.parse(a11y);
    check('both live regions are permanently rendered', acc.regionsExist === true, a11y);
    check('visible action feedback does not duplicate the status announcement',
      acc.statusRole === 'status' && acc.actionFeedbackRole === null,
      `status=${acc.statusRole}, feedback=${acc.actionFeedbackRole}`);
    check('the incident region is not re-announced by the poll', acc.incidentHasAlertRole === null, `role=${acc.incidentHasAlertRole}`);
    check('a plan staged by an agent is announced', acc.announcedOnAgentAction === true, acc.announcedText);
    check('unchanged text is not rewritten on every poll', acc.nodeSurvivedTwoPolls === true, 'the text node was replaced while nothing changed');
    check('the demo control keeps focus when it arms itself', acc.focusKept === true, `aria-disabled=${acc.faultAriaDisabled}`);
    check('an armed control stays focusable via aria-disabled', acc.faultAriaDisabled === 'true', String(acc.faultAriaDisabled));
    check('the number field can take focus while editable', acc.focusedTheField === true, 'the field did not accept focus');
    check('the number field shows a focus ring', acc.focusRing.startsWith('solid') && !acc.focusRing.endsWith('0px'), acc.focusRing);
    check('the skip-link target can take focus', acc.mainFocusable === '-1', String(acc.mainFocusable));

    scenario('responsive layouts have usable touch targets and no overflow');
    await freshVenue();
    const responsive = [];
    const viewportCases = [
      { width: 320, height: 568 },
      { width: 360, height: 800 },
      { width: 375, height: 667 },
      { width: 390, height: 844 },
      { width: 412, height: 915 },
      { width: 768, height: 1024 },
      { width: 568, height: 320 },
      { width: 667, height: 375 },
      { width: 844, height: 390 },
      { width: 915, height: 412 },
      { width: 1440, height: 800 },
      { width: 1920, height: 889 },
    ];
    for (const { width, height } of viewportCases) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width <= 768,
      });
      await sleep(100);
      responsive.push(await evaluate(client, `
        window.scrollTo(0, 0);
        const rect = (selector) => {
          const value = document.querySelector(selector).getBoundingClientRect();
          return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
        };
        const copy = rect('#copy-prompt-button');
        const brand = rect('.wordmark');
        const summary = rect('.tool-disclosure summary');
        const fault = rect('#fault-button');
        const share = rect('#share-link-button');
        const quickStart = rect('.quick-start');
        const quickHeading = rect('#agent-heading');
        const hero = rect('.hero');
        const booking = rect('.booking-section');
        const assurance = rect('#assurance-empty');
        const webmcpBadge = document.querySelector('#webmcp-status');
        const protocolFields = [...document.querySelectorAll('.protocol-field')].map((field) => {
          const value = field.getBoundingClientRect();
          return { left: value.left, top: value.top };
        });
        const focusables = [...document.querySelectorAll('a[href], button, input, select, summary')]
          .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
        const position = (selector) => focusables.indexOf(document.querySelector(selector));
        return {
          width: ${width},
          height: ${height},
          viewportWidth: document.documentElement.clientWidth,
          contentWidth: document.documentElement.scrollWidth,
          pageHeight: document.documentElement.scrollHeight,
          copy,
          brand,
          summary,
          fault,
          share,
          quickStart,
          quickHeading,
          hero,
          booking,
          assurance,
          webmcpBadge: {
            clientWidth: webmcpBadge.clientWidth,
            scrollWidth: webmcpBadge.scrollWidth,
          },
          protocolFields,
          webmcp: document.querySelector('#webmcp-status').textContent.replace(/\\s+/g, ' ').trim(),
          disclosureOpen: document.querySelector('.tool-disclosure').open,
          order: {
            prompt: position('#copy-prompt-button'),
            firstRequirement: position('#requirements-form input'),
            fault: position('#fault-button'),
            share: position('#share-link-button'),
          },
        };
      `));
    }
    for (const layout of responsive) {
      check(`the ${layout.width} px layout has no horizontal overflow`,
        layout.contentWidth <= layout.viewportWidth,
        JSON.stringify(layout));
      check(`the WebMCP badge is not clipped at ${layout.width}×${layout.height}`,
        layout.webmcpBadge.scrollWidth <= layout.webmcpBadge.clientWidth + 1,
        JSON.stringify(layout.webmcpBadge));
    }
    const narrowest = responsive.find((layout) => layout.width === 320);
    check('the Copy control is at least 44 by 44 CSS pixels at 320 px',
      narrowest.copy.width >= 44 && narrowest.copy.height >= 44,
      JSON.stringify(narrowest));
    check('the home wordmark is at least 44 by 44 CSS pixels at 320 px',
      narrowest.brand.width >= 44 && narrowest.brand.height >= 44,
      JSON.stringify(narrowest.brand));

    const judgeDesktop = responsive.find((layout) => layout.width === 1920);
    check('the 1920×889 visitor layout has no horizontal overflow',
      judgeDesktop.contentWidth <= judgeDesktop.viewportWidth,
      JSON.stringify(judgeDesktop));
    check('the agent quick-start and Copy prompt enter the first desktop viewport',
      judgeDesktop.quickHeading.top >= 0
        && judgeDesktop.quickHeading.top < judgeDesktop.height
        && judgeDesktop.copy.bottom <= judgeDesktop.height,
      JSON.stringify(judgeDesktop));
    check('the visitor badge visibly names WebMCP before its live counts',
      judgeDesktop.webmcp.startsWith('WebMCP ·'),
      judgeDesktop.webmcp);
    check('the tool disclosure begins closed instead of dumping internal names into the walkthrough',
      judgeDesktop.disclosureOpen === false,
      JSON.stringify(judgeDesktop));
    check('the READY tab order is prompt, requirements, then the secondary shared link while Step 3 stays hidden',
      judgeDesktop.order.prompt >= 0
        && judgeDesktop.order.prompt < judgeDesktop.order.firstRequirement
        && judgeDesktop.order.firstRequirement < judgeDesktop.order.share
        && judgeDesktop.order.fault === -1,
      JSON.stringify(judgeDesktop.order));

    const judgeMobile = responsive.find((layout) => layout.width === 390);
    check('the 390×844 visitor layout has no horizontal overflow',
      judgeMobile.contentWidth <= judgeMobile.viewportWidth,
      JSON.stringify(judgeMobile));
    check('the mobile hero is materially shorter than the pre-repair 829 px layout',
      judgeMobile.hero.height <= 700,
      JSON.stringify(judgeMobile.hero));
    check('the mobile READY booking section is shorter than the pre-repair 1817 px layout',
      judgeMobile.booking.height <= 1_600,
      JSON.stringify(judgeMobile.booking));
    check('the mobile empty access-plan card is shorter than the pre-repair 721 px layout',
      judgeMobile.assurance.height <= 500,
      JSON.stringify(judgeMobile.assurance));
    check('the mobile prompt, tool disclosure and shared-link action are touch sized',
      [judgeMobile.copy, judgeMobile.summary, judgeMobile.share]
        .every(({ width, height }) => width >= 44 && height >= 44),
      JSON.stringify({ copy: judgeMobile.copy, summary: judgeMobile.summary, share: judgeMobile.share }));
    check('the mobile activity trace reads vertically as Actor, Action, Result',
      judgeMobile.protocolFields.length === 3
        && judgeMobile.protocolFields.every((field, index, fields) => index === 0 || field.top > fields[index - 1].top)
        && judgeMobile.protocolFields.every((field) => Math.abs(field.left - judgeMobile.protocolFields[0].left) < 2),
      JSON.stringify(judgeMobile.protocolFields));

    await evaluate(client, `document.querySelector('.tool-disclosure summary').focus(); return true;`);
    await pressKey(client, 'Enter');
    await sleep(100);
    const disclosure = await evaluate(client, `
      const details = document.querySelector('.tool-disclosure');
      const chips = [...document.querySelectorAll('#tool-list .tool-chip')];
      return { open: details.open, chips: chips.map((chip) => chip.textContent), visible: chips.every((chip) => chip.getBoundingClientRect().height > 0) };
    `);
    check('the browser-tool disclosure opens from the keyboard and reveals the live registry',
      disclosure.open === true && disclosure.chips.length > 0 && disclosure.visible === true,
      JSON.stringify(disclosure));

    const clipboard = await evaluate(client, `
      const original = navigator.clipboard;
      let copied = '';
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (value) => { copied = String(value); } },
      });
      const prompt = document.querySelector('#example-prompt').textContent.trim();
      document.querySelector('#copy-prompt-button').click();
      await new Promise((resolve) => setTimeout(resolve, 25));
      const copiedPrompt = copied;
      document.querySelector('#share-link-button').click();
      await new Promise((resolve) => setTimeout(resolve, 25));
      const copiedUrl = copied;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: original });
      return { prompt, copiedPrompt, copiedUrl, demoId: new URL(location.href).searchParams.get('demo') };
    `);
    check('Copy prompt writes the exact visible request',
      clipboard.copiedPrompt === clipboard.prompt,
      JSON.stringify(clipboard));
    check('the footer shared-link action copies this exact venue identity',
      new URL(clipboard.copiedUrl).searchParams.get('demo') === clipboard.demoId,
      JSON.stringify(clipboard));

    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 568,
      deviceScaleFactor: 1,
      mobile: true,
    });
    const textZoom = await evaluate(client, `
      document.documentElement.style.fontSize = '200%';
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const viewportWidth = document.documentElement.clientWidth;
      const visibleControls = [...document.querySelectorAll('button, summary, .check-row, .number-grid label')]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { id: element.id || element.tagName, width: rect.width, height: rect.height };
        });
      const result = {
        viewportWidth,
        contentWidth: document.documentElement.scrollWidth,
        undersized: visibleControls.filter(({ width, height }) => width < 44 || height < 44),
        offenders: [...document.querySelectorAll('body *')]
          .filter((element) => element.getClientRects().length > 0)
          .map((element) => ({
            selector: element.id ? '#' + element.id : element.className ? '.' + String(element.className).trim().replace(/\\s+/g, '.') : element.tagName,
            right: Math.round(element.getBoundingClientRect().right),
          }))
          .filter(({ right }) => right > viewportWidth + 1)
          .slice(0, 12),
      };
      document.documentElement.style.removeProperty('font-size');
      return result;
    `);
    check('the 320 px visitor reflows without horizontal scrolling at 200% text size',
      textZoom.contentWidth <= textZoom.viewportWidth,
      JSON.stringify(textZoom));
    check('visible visitor controls remain touch sized at 200% text size',
      textZoom.undersized.length === 0,
      JSON.stringify(textZoom.undersized));

    await client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    const reducedMotion = await evaluate(client, `
      const raw = getComputedStyle(document.querySelector('.button')).transitionDuration.split(',')[0].trim();
      const seconds = raw.endsWith('ms') ? Number.parseFloat(raw) / 1000 : Number.parseFloat(raw);
      return {
        matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
        transitionDuration: raw,
        transitionSeconds: seconds,
      };
    `);
    check('prefers-reduced-motion removes material button animation',
      reducedMotion.matches === true && reducedMotion.transitionSeconds <= 0.001,
      JSON.stringify(reducedMotion));
    await client.send('Emulation.setEmulatedMedia', { features: [] });

    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 568,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await evaluate(client, `document.querySelector('#build-plan-button').click(); return true;`);
    const mobileDecisionVisible = await waitForPage(client, `!document.querySelector('#decision-section').hidden`, 10_000);
    await sleep(100);
    const mobileDecisionFocus = await evaluate(client, `
      const decision = document.querySelector('#decision-heading').getBoundingClientRect();
      return {
        focused: document.activeElement?.id,
        top: decision.top,
        bottom: decision.bottom,
        viewportHeight: window.innerHeight,
        scrollY: window.scrollY,
      };
    `);
    check('a 320×568 visitor sees the decision that receives focus after Build',
      mobileDecisionVisible
        && mobileDecisionFocus.focused === 'decision-heading'
        && mobileDecisionFocus.top < mobileDecisionFocus.viewportHeight
        && mobileDecisionFocus.bottom > 0,
      JSON.stringify(mobileDecisionFocus));
    await client.send('Emulation.clearDeviceMetricsOverride');

    scenario('a visitor can complete the failure and recovery path with only the keyboard');
    await freshVenue();

    const focusStartedAtDocument = await evaluate(client, `
      document.body.setAttribute('tabindex', '-1');
      document.body.focus();
      document.body.removeAttribute('tabindex');
      return document.activeElement === document.body;
    `);
    check('the keyboard run starts at the document', focusStartedAtDocument === true, String(focusStartedAtDocument));

    await pressKey(client, 'Tab');
    const skipFocused = await evaluate(client, `return document.activeElement?.matches('.skip-link') === true;`);
    check('the first Tab reaches the skip link', skipFocused === true, String(skipFocused));
    await pressKey(client, 'Enter');
    await sleep(100);
    const mainFocused = await evaluate(client, `return document.activeElement?.id === 'main';`);
    check('Enter moves focus to the booking content', mainFocused === true, String(mainFocused));

    const lowStimulusSteps = await tabTo(client, 'input[name="lowStimulus"]');
    const lowBefore = await evaluate(client, `return document.activeElement?.checked;`);
    await pressKey(client, 'Space');
    const lowAfterOne = await evaluate(client, `return document.activeElement?.checked;`);
    await pressKey(client, 'Space');
    const lowAfterTwo = await evaluate(client, `return document.activeElement?.checked;`);
    check('Tab navigation reaches the lower-stimulus checkbox', lowStimulusSteps > 0, String(lowStimulusSteps));
    check('Space toggles the checkbox and can restore it',
      lowBefore !== lowAfterOne && lowAfterTwo === lowBefore,
      `${lowBefore} -> ${lowAfterOne} -> ${lowAfterTwo}`);

    const widthSteps = await tabTo(client, 'input[name="wheelchairWidthCm"]');
    const widthBefore = await evaluate(client, `return document.activeElement?.value;`);
    await pressKey(client, 'ArrowUp');
    const widthAfterUp = await evaluate(client, `return document.activeElement?.value;`);
    const keyboardRing = await evaluate(client, `
      const ring = getComputedStyle(document.activeElement.closest('.input-unit'));
      return ring.outlineStyle + ' ' + ring.outlineWidth;
    `);
    await pressKey(client, 'ArrowDown');
    const widthAfterDown = await evaluate(client, `return document.activeElement?.value;`);
    check('Tab navigation reaches the wheelchair-width field', widthSteps > 0, String(widthSteps));
    check('arrow keys change and restore the number field',
      Number(widthAfterUp) === Number(widthBefore) + 1 && widthAfterDown === widthBefore,
      `${widthBefore} -> ${widthAfterUp} -> ${widthAfterDown}`);
    check('the keyboard-focused number field has a visible ring',
      keyboardRing.startsWith('solid') && !keyboardRing.endsWith('0px'),
      keyboardRing);

    const buildSteps = await tabTo(client, '#build-plan-button');
    await pressKey(client, 'Enter');
    const planVisible = await waitForPage(client, `!document.querySelector('#decision-section').hidden`, 10_000);
    check('Enter submits the requirements and reveals the decision',
      buildSteps > 0 && planVisible,
      `tabs=${buildSteps}, visible=${planVisible}`);

    const faultSteps = await tabTo(client, '#fault-button');
    await pressKey(client, 'Enter');
    const faultArmed = await waitForPage(client, `document.querySelector('#fault-button').getAttribute('aria-disabled') === 'true'`);
    const faultStillFocused = await evaluate(client, `return document.activeElement?.id === 'fault-button';`);
    check('Enter arms the mid-confirmation fault', faultSteps > 0 && faultArmed, `tabs=${faultSteps}, armed=${faultArmed}`);
    check('the asynchronously armed control keeps keyboard focus', faultStillFocused === true, String(faultStillFocused));

    const firstConfirmSteps = await tabTo(client, '#confirm-button');
    await pressKey(client, 'Enter');
    const incidentVisible = await waitForPage(client, `!document.querySelector('#incident').hidden`, 10_000);
    check('keyboard confirmation reaches the stale-plan refusal',
      firstConfirmSteps > 0 && incidentVisible,
      `tabs=${firstConfirmSteps}, visible=${incidentVisible}`);

    const replanSteps = await tabTo(client, '#replan-button');
    await pressKey(client, 'Enter');
    const replacementVisible = await waitForPage(client,
      `document.querySelector('#incident').hidden && document.querySelector('#decision-heading').textContent.includes('route changed')`,
      10_000);
    const clearedAlert = await evaluate(client, `return document.querySelector('#a11y-alert').textContent;`);
    check('Enter replans to a complete replacement',
      replanSteps > 0 && replacementVisible,
      `tabs=${replanSteps}, visible=${replacementVisible}`);
    check('recovery clears the obsolete assertive alert', clearedAlert === '', clearedAlert);

    const secondConfirmSteps = await tabTo(client, '#confirm-button');
    await pressKey(client, 'Enter');
    const receiptVisible = await waitForPage(client, `!document.querySelector('#receipt-section').hidden`, 10_000);
    await sleep(100);
    const keyboardFinish = await evaluate(client, `
      return {
        focused: document.activeElement?.id,
        status: document.querySelector('#a11y-status').textContent,
        alert: document.querySelector('#a11y-alert').textContent,
      };
    `);
    check('the replacement can be confirmed with Enter',
      secondConfirmSteps > 0 && receiptVisible,
      `tabs=${secondConfirmSteps}, visible=${receiptVisible}`);
    check('success moves focus to the receipt heading', keyboardFinish.focused === 'receipt-heading', JSON.stringify(keyboardFinish));
    check('success is announced without a stale failure',
      keyboardFinish.status === 'Every requested resource was confirmed in one transaction.'
        && keyboardFinish.alert === '',
      JSON.stringify(keyboardFinish));

    scenario('an older state response cannot roll the page or tool registry backwards');
    await freshVenue();
    const refreshRace = await run(`
      const found = await call('find_access_bundle', ${JSON.stringify(FULL)});
      await settle();
      await call('stage_access_bundle', {
        planId: found.plan.id,
        expectedVenueRevision: found.plan.basedOnRevision,
      });
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (document.querySelector('#plan-state').textContent.trim() === 'Ready for review') break;
        await sleep(100);
      }

      const originalFetch = window.fetch.bind(window);
      let stateRequests = 0;
      let releaseFirst;
      let firstCaptured;
      const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
      const captured = new Promise((resolve) => { firstCaptured = resolve; });

      window.fetch = async (input, init = {}) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (url.pathname !== '/api/state' || method !== 'GET') return originalFetch(input, init);

        stateRequests += 1;
        const response = await originalFetch(input, init);
        if (stateRequests === 1) {
          firstCaptured();
          await firstGate;
        }
        return response;
      };

      const stateTool = (await mc.getTools()).find((tool) => tool.name === 'get_event_access_state');
      const oldRead = mc.executeTool(stateTool, '{}');
      const didCapture = await Promise.race([captured.then(() => true), sleep(4000).then(() => false)]);
      document.querySelector('#reset-button').click();
      await sleep(400);
      const requestsBeforeRelease = stateRequests;
      releaseFirst();
      const oldResult = await Promise.race([oldRead, sleep(8000).then(() => 'TIMED OUT')]);

      let finalTools = [];
      for (let attempt = 0; attempt < 80; attempt += 1) {
        finalTools = await names();
        if (!document.querySelector('#build-plan-button').disabled
          && document.querySelector('#decision-section').hidden
          && finalTools.includes('find_access_bundle')) break;
        await sleep(100);
      }
      const result = {
        didCapture,
        requestsBeforeRelease,
        oldResult: oldResult === 'TIMED OUT' ? { phase: oldResult } : JSON.parse(oldResult),
        finalTools,
        badge: document.querySelector('#webmcp-status-text').textContent,
        buildEnabled: !document.querySelector('#build-plan-button').disabled,
        decisionHidden: document.querySelector('#decision-section').hidden,
        activePlanVisible: !document.querySelector('#assurance-plan').hidden,
      };
      window.fetch = originalFetch;
      return JSON.stringify(result);
    `);
    const ordered = JSON.parse(refreshRace);
    // Both the set and the badge come from the declarations now. They were
    // typed out here, and the badge was the literal '4 read · 2 write', so a
    // deliberate change to any phase's surface failed this scenario for the
    // wrong reason - it reported a rollback that had not happened.
    const readySurface = EXPECTED_SURFACE.get('READY');
    const readyTools = [...readySurface.names].sort();
    const readyBadge = `${readySurface.read} read · ${readySurface.write} write`;
    check('the test captured a real older AWAITING snapshot',
      ordered.didCapture === true && ordered.oldResult.phase === 'AWAITING_HUMAN_CONFIRMATION',
      refreshRace);
    check('the reset refresh waited instead of racing the older read',
      ordered.requestsBeforeRelease === 1,
      `state requests before release: ${ordered.requestsBeforeRelease}`);
    check('the final UI stays at the newer READY state',
      ordered.buildEnabled && ordered.decisionHidden && !ordered.activePlanVisible,
      refreshRace);
    check('the final registry is exactly READY, with no stale-plan tools',
      ordered.finalTools.join() === readyTools.join() && ordered.badge === readyBadge,
      `tools=${ordered.finalTools.join(', ')}; badge=${ordered.badge}`);

    scenario('the visitor fault control never offers an action it will refuse');
    await freshVenue();
    // The exact combination that produced the contradiction: East already out
    // AND another lift armed. renderFaultControl read `eastOut` before `armed`,
    // so it rendered "Put East Lift back in service" while setting
    // aria-disabled=true - a control naming an action it would then refuse.
    //
    // Driven through the page rather than the domain, because the defect was
    // only ever visible here, and every request the page makes is recorded so
    // "sends nothing" is measured rather than assumed.
    const combined = await run(`
      const id = new URL(location.href).searchParams.get('demo');
      const operator = await (await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'operator', demoId: id }),
      })).json();
      const asOperator = (path, body) => fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Demo-Session': operator.session.token },
        body: JSON.stringify(body ?? {}),
      });

      await asOperator('/api/operator/facilities/garden-lift/arm');
      await asOperator('/api/operator/facilities/east-lift/outage', { reasonCode: 'POWER_FAULT' });
      await settle();

      const button = document.querySelector('#fault-button');
      const hint = document.querySelector('#fault-hint');
      const before = {
        text: button.textContent.trim(),
        hint: hint.textContent.trim(),
        ariaDisabled: button.getAttribute('aria-disabled'),
      };

      // Every request the click makes, recorded at the page's own fetch.
      const seen = [];
      const originalFetch = window.fetch;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        seen.push(((init && init.method) || 'GET') + ' ' + new URL(url, location.origin).pathname);
        return originalFetch(input, init);
      };
      button.click();
      await settle();
      window.fetch = originalFetch;

      // Read from /api/state, not from get_event_access_state: that tool
      // reports phase, revision and facility statuses and deliberately does not
      // carry the demo's pending fault, so asking it for one returns undefined
      // and would pass this check by accident.
      const venue = await (await fetch('/api/state', {
        headers: { 'X-Demo-Session': operator.session.token },
      })).json();

      return JSON.stringify({
        ...before,
        facilityRequests: seen.filter((entry) => entry.includes('/api/operator/facilities/')),
        pendingAfter: venue.state.demo.pendingOutageResourceId ?? null,
      });
    `);
    const fault = JSON.parse(combined);
    check('the control names the lift actually holding the armed fault',
      fault.text.includes('Garden Lift L4'), fault.text);
    check('it does not offer to restore the lift that is merely out',
      !/back in service/i.test(fault.text) && !/Restore it here/i.test(fault.hint),
      `${fault.text} / ${fault.hint}`);
    check('the pending control is marked unavailable',
      fault.ariaDisabled === 'true', String(fault.ariaDisabled));
    check('pressing it sends no facility request at all',
      fault.facilityRequests.length === 0, fault.facilityRequests.join(' | '));
    check('and the armed fault is still the one that was armed',
      fault.pendingAfter === 'garden-lift', String(fault.pendingAfter));

    scenario('restoring the visitor lift returns focus to the next usable action');
    await freshVenue();
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 568,
      deviceScaleFactor: 1,
      mobile: true,
    });
    const restoreFocus = JSON.parse(await run(`
      const id = new URL(location.href).searchParams.get('demo');
      const operator = await (await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'operator', demoId: id }),
      })).json();
      await fetch('/api/operator/facilities/east-lift/outage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Demo-Session': operator.session.token },
        body: JSON.stringify({ reasonCode: 'POWER_FAULT' }),
      });
      await settle();
      const restore = document.querySelector('#fault-button');
      restore.scrollIntoView({ block: 'center' });
      restore.focus({ preventScroll: true });
      const offered = /back in service/i.test(restore.textContent) && document.activeElement === restore;
      restore.click();
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !document.querySelector('#demo-controls').hidden) await sleep(80);
      const build = document.querySelector('#build-plan-button');
      const rect = build.getBoundingClientRect();
      return JSON.stringify({
        offered,
        controlsHidden: document.querySelector('#demo-controls').hidden,
        focused: document.activeElement?.id,
        top: rect.top,
        bottom: rect.bottom,
        viewportHeight: window.innerHeight,
        scrollY: window.scrollY,
      });
    `));
    check('restoring the lift leaves focus on a visible Build action instead of the document body',
      restoreFocus.offered
        && restoreFocus.controlsHidden
        && restoreFocus.focused === 'build-plan-button'
        && restoreFocus.top < restoreFocus.viewportHeight
        && restoreFocus.bottom > 0,
      JSON.stringify(restoreFocus));
    await client.send('Emulation.clearDeviceMetricsOverride');

    scenario('a visitor can actually start over before confirmation');
    await freshVenue();
    const startedOver = JSON.parse(await run(`
      const found = await call('find_access_bundle', ${JSON.stringify(FULL)});
      await settle();
      await call('stage_access_bundle', {
        planId: found.plan.id,
        expectedVenueRevision: found.plan.basedOnRevision,
      });
      await settle();

      const before = await call('get_access_bundle_status', {});
      const button = document.querySelector('#start-over-button');
      const reachable = before.phase === 'AWAITING_HUMAN_CONFIRMATION'
        && !button.hidden
        && !button.disabled
        && !document.querySelector('#decision-section').hidden;
      button.focus();
      const heldFocus = document.activeElement === button;
      button.click();

      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (!document.querySelector('#build-plan-button').disabled
          && document.querySelector('#decision-section').hidden
          && button.hidden) break;
        await sleep(80);
      }
      const after = await call('get_access_bundle_status', {});
      return JSON.stringify({
        reachable,
        heldFocus,
        phase: after.phase,
        booking: after.booking,
        buildEnabled: !document.querySelector('#build-plan-button').disabled,
        decisionHidden: document.querySelector('#decision-section').hidden,
        startOverHidden: button.hidden,
        focusedName: document.activeElement?.getAttribute?.('name') ?? '',
        focusedTag: document.activeElement?.tagName ?? '',
        status: document.querySelector('#a11y-status').textContent,
      });
    `));
    check('Start over is genuinely reachable on a staged, unconfirmed plan',
      startedOver.reachable === true && startedOver.heldFocus === true,
      JSON.stringify(startedOver));
    check('clicking Start over returns the real page to READY without a booking',
      startedOver.phase === 'READY'
        && !startedOver.booking
        && startedOver.buildEnabled === true
        && startedOver.decisionHidden === true
        && startedOver.startOverHidden === true,
      JSON.stringify(startedOver));
    check('Start over puts focus in the editable requirements instead of dropping it',
      startedOver.focusedTag === 'INPUT' && startedOver.focusedName === 'stepFree',
      JSON.stringify(startedOver));
    check('Start over announces exactly what is editable and what was booked',
      startedOver.status === 'Change a requirement and build a new plan. Nothing was booked.',
      startedOver.status);

    scenario('an agent moving the venue never leaves the visitor focused on nothing');
    await freshVenue();
    // Hiding the section that holds document.activeElement drops focus to
    // <body> in silence, and the agent path is what makes it reachable: the
    // visitor focuses a control, an agent or the venue moves underneath them,
    // and the re-render hides the section the focus was in. A screen-reader
    // user is then at the top of the document with no idea why.
    //
    // Measured in the real browser, because focus does not exist anywhere else.
    const focusDrop = await run(`
      const found = await call('find_access_bundle', {
        wheelchairWidthCm: 72, maxDistanceM: 80, stepFree: true,
        companionCount: 1, entranceAssistance: true, lowStimulus: true,
      });
      // The registry is rebuilt by the re-render, and call() answers
      // {__missing: name} without complaining, so without this wait the stage
      // silently never happened and every check below measured PLAN_READY.
      await settle();
      const staged = await call('stage_access_bundle', { planId: found.plan.id, expectedVenueRevision: found.plan.basedOnRevision });
      await settle();

      const confirm = document.querySelector('#confirm-button');
      confirm.focus();
      const heldFocus = document.activeElement === confirm;
      const why = {
        exists: Boolean(confirm),
        disabled: confirm ? confirm.disabled : null,
        hidden: confirm ? confirm.hidden : null,
        sectionHidden: document.querySelector('#decision-section').hidden,
        phase: (await call('get_event_access_state', {})).phase,
        staged: staged.__missing ? 'TOOL MISSING' : (staged.phase ?? 'no phase'),
        activeNow: document.activeElement ? document.activeElement.tagName + '#' + document.activeElement.id : null,
      };

      const id = new URL(location.href).searchParams.get('demo');
      const operator = await (await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'operator', demoId: id }),
      })).json();
      await fetch('/api/operator/facilities/east-lift/outage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Demo-Session': operator.session.token },
        body: JSON.stringify({ reasonCode: 'POWER_FAULT' }),
      });
      await settle();

      const active = document.activeElement;
      return JSON.stringify({
        heldFocus,
        why,
        activeTag: active ? active.tagName : null,
        activeId: active ? active.id : '',
        decisionHidden: document.querySelector('#decision-section').hidden,
        incidentShown: !document.querySelector('#incident').hidden,
      });
    `);
    const drop = JSON.parse(focusDrop);
    check('the visitor really did hold the control before the venue moved',
      drop.heldFocus === true, JSON.stringify(drop.why));
    check('the section holding that control was hidden by the move',
      drop.decisionHidden === true && drop.incidentShown === true,
      `decision hidden ${drop.decisionHidden} / incident shown ${drop.incidentShown}`);
    check('focus was not dropped to the document body',
      drop.activeTag !== 'BODY', `${drop.activeTag}#${drop.activeId}`);
    check('and it landed somewhere that explains what happened',
      drop.activeId === 'incident-heading', `${drop.activeTag}#${drop.activeId}`);

    scenario('an agent clearing the plan does not leave the visitor nowhere');
    await freshVenue();
    // The path the previous scenario missed. It moved the venue with an OUTAGE,
    // which renders the incident card and focuses its heading. A CLEAR returns
    // the page to READY, where no focus handler ran at all: focus fell to
    // <body>, the assertive region stayed empty, and role=status went on saying
    // a complete plan was ready for a plan that no longer existed.
    const cleared = await run(`
      const found = await call('find_access_bundle', {
        wheelchairWidthCm: 72, maxDistanceM: 80, stepFree: true,
        companionCount: 1, entranceAssistance: true, lowStimulus: true,
      });
      await settle();
      await call('stage_access_bundle', { planId: found.plan.id, expectedVenueRevision: found.plan.basedOnRevision });
      await settle();

      const confirm = document.querySelector('#confirm-button');
      confirm.focus();
      const heldFocus = document.activeElement === confirm;
      const statusBefore = document.querySelector('#a11y-status').textContent.trim();

      // Another client clears the plan, exactly as clear_access_plan would.
      const id = new URL(location.href).searchParams.get('demo');
      const other = await (await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'visitor', demoId: id }),
      })).json();
      await fetch('/api/plans/' + encodeURIComponent(found.plan.id) + '/clear', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Demo-Session': other.session.token,
          'X-WebMCP-Tool': 'clear_access_plan',
        },
        body: '{}',
      });
      await settle();

      const active = document.activeElement;
      return JSON.stringify({
        heldFocus,
        statusBefore,
        decisionHidden: document.querySelector('#decision-section').hidden,
        activeTag: active ? active.tagName : null,
        activeId: active ? active.id : '',
        status: document.querySelector('#a11y-status').textContent.trim(),
      });
    `);
    const gone = JSON.parse(cleared);
    check('the visitor was holding the confirm control before the plan went',
      gone.heldFocus === true, String(gone.heldFocus));
    check('and the plan really did go',
      gone.decisionHidden === true, String(gone.decisionHidden));
    check('focus was not dropped to the document body',
      gone.activeTag !== 'BODY', `${gone.activeTag}#${gone.activeId}`);
    check('the live region no longer says a complete plan is ready',
      !/ready|prepared/i.test(gone.status) || gone.status !== gone.statusBefore,
      `before "${gone.statusBefore}" / after "${gone.status}"`);

    scenario('confirming a plan another session cleared still leaves focus somewhere');
    await freshVenue();
    // The page's own comment claimed this was repaired. It was not: the finally
    // block restored focus to the confirm button, and by then its section was
    // hidden, so focus() was a no-op and the visitor stayed on <body>.
    const failed = await run(`
      const found = await call('find_access_bundle', {
        wheelchairWidthCm: 72, maxDistanceM: 80, stepFree: true,
        companionCount: 1, entranceAssistance: true, lowStimulus: true,
      });
      await settle();
      await call('stage_access_bundle', { planId: found.plan.id, expectedVenueRevision: found.plan.basedOnRevision });
      await settle();

      const id = new URL(location.href).searchParams.get('demo');
      const other = await (await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'visitor', demoId: id }),
      })).json();
      await fetch('/api/plans/' + encodeURIComponent(found.plan.id) + '/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Demo-Session': other.session.token },
        body: '{}',
      });

      // The page has not polled yet, so the control is still on screen.
      const confirm = document.querySelector('#confirm-button');
      confirm.focus();
      const heldFocus = document.activeElement === confirm;
      confirm.click();
      await settle();

      const active = document.activeElement;
      return JSON.stringify({
        heldFocus,
        activeTag: active ? active.tagName : null,
        activeId: active ? active.id : '',
      });
    `);
    const refused = JSON.parse(failed);
    check('the visitor pressed confirm while holding it',
      refused.heldFocus === true, String(refused.heldFocus));
    check('a refused confirmation does not end on the document body',
      refused.activeTag !== 'BODY', `${refused.activeTag}#${refused.activeId}`);

    scenario('a confirmed booking keeps warning when one of its own lifts leaves service');
    await freshVenue();
    const bookingBreakage = JSON.parse(await run(`
      const found = await call('find_access_bundle', ${JSON.stringify(FULL)});
      await settle();
      await call('stage_access_bundle', {
        planId: found.plan.id,
        expectedVenueRevision: found.plan.basedOnRevision,
      });
      await settle();
      document.querySelector('#confirm-button').click();
      const bookingDeadline = Date.now() + 10000;
      while (Date.now() < bookingDeadline && document.querySelector('#receipt-section').hidden) await sleep(80);

      const id = new URL(location.href).searchParams.get('demo');
      const operator = await (await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'operator', demoId: id }),
      })).json();
      const stateBefore = await (await fetch('/api/state', {
        headers: { 'X-Demo-Session': operator.session.token },
      })).json();
      const usedFacility = Object.values(stateBefore.state.resources).find((resource) => (
        resource.kind === 'FACILITY' && stateBefore.state.booking?.resourceIds?.includes(resource.id)
      ));
      const receiptRoute = [...document.querySelectorAll('#receipt-details div')]
        .find((row) => row.querySelector('dt')?.textContent === 'Route')?.querySelector('dd')?.textContent ?? '';
      const precondition = stateBefore.state.phase === 'CONFIRMED'
        && !document.querySelector('#receipt-section').hidden
        && Boolean(usedFacility)
        && receiptRoute.includes(usedFacility?.label ?? '');
      const beforeRevision = rev();
      let outageStatus = null;
      if (usedFacility) {
        outageStatus = (await fetch('/api/operator/facilities/' + encodeURIComponent(usedFacility.id) + '/outage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Session': operator.session.token },
          body: JSON.stringify({ reasonCode: 'POWER_FAULT' }),
        })).status;
      }

      const visibleLiftCard = () => [...document.querySelectorAll('#resource-grid .resource-item')]
        .find((item) => item.textContent.includes(usedFacility?.label ?? '__missing__'));
      const firstPollDeadline = Date.now() + 10000;
      let firstPollObserved = false;
      while (Date.now() < firstPollDeadline) {
        const card = visibleLiftCard();
        const alert = document.querySelector('#booking-impact-alert');
        if (rev() > beforeRevision
          && card && !card.closest('[hidden]') && /Out of service/i.test(card.textContent)
          && !alert.hidden
          && alert.textContent.includes(usedFacility?.label ?? '__missing__')) {
          firstPollObserved = true;
          break;
        }
        await sleep(80);
      }
      const firstCard = visibleLiftCard();
      const first = {
        revision: rev(),
        cardVisible: Boolean(firstCard && !firstCard.closest('[hidden]')),
        cardText: firstCard?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
        impactHidden: document.querySelector('#booking-impact-alert').hidden,
        impactText: document.querySelector('#booking-impact-alert').textContent.replace(/\\s+/g, ' ').trim(),
        impactAriaLabel: document.querySelector('#booking-impact-alert').getAttribute('aria-label'),
        separateAssertiveText: document.querySelector('#a11y-alert').textContent,
      };

      // No read tool or manual refresh here: let at least one more interval
      // poll repaint CONFIRMED, which used to erase this standing alert.
      await sleep(1800);
      const laterCard = visibleLiftCard();
      const afterPoll = {
        revision: rev(),
        cardVisible: Boolean(laterCard && !laterCard.closest('[hidden]')),
        cardText: laterCard?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
        impactHidden: document.querySelector('#booking-impact-alert').hidden,
        impactText: document.querySelector('#booking-impact-alert').textContent.replace(/\\s+/g, ' ').trim(),
        impactAriaLabel: document.querySelector('#booking-impact-alert').getAttribute('aria-label'),
        separateAssertiveText: document.querySelector('#a11y-alert').textContent,
      };
      return JSON.stringify({
        precondition,
        usedFacility,
        receiptRoute,
        beforeRevision,
        outageStatus,
        firstPollObserved,
        first,
        afterPoll,
      });
    `));
    check('the outage target is a lift the confirmed receipt really uses',
      bookingBreakage.precondition === true,
      JSON.stringify(bookingBreakage));
    check('the used-lift outage is observed through the visitor page poll',
      bookingBreakage.outageStatus === 200
        && bookingBreakage.firstPollObserved === true
        && bookingBreakage.first.revision > bookingBreakage.beforeRevision,
      JSON.stringify(bookingBreakage));
    check('the confirmed page visibly names that booked lift as out of service',
      bookingBreakage.first.cardVisible === true
        && bookingBreakage.first.cardText.includes(bookingBreakage.usedFacility?.label ?? '__missing__')
        && /Out of service/i.test(bookingBreakage.first.cardText),
      JSON.stringify(bookingBreakage.first));
    check('one visible accessibility alert names the booked lift and says the booking still stands',
      bookingBreakage.first.impactHidden === false
        && bookingBreakage.first.impactText.includes(bookingBreakage.usedFacility?.label ?? '__missing__')
        && /became unavailable/i.test(bookingBreakage.first.impactAriaLabel)
        && /booking still stands/i.test(bookingBreakage.first.impactAriaLabel)
        && bookingBreakage.first.separateAssertiveText === '',
      JSON.stringify(bookingBreakage.first));
    check('the visible warning survives another ordinary poll without a duplicate assertive message',
      bookingBreakage.afterPoll.cardVisible === true
        && bookingBreakage.afterPoll.cardText === bookingBreakage.first.cardText
        && bookingBreakage.afterPoll.impactHidden === false
        && bookingBreakage.afterPoll.impactText === bookingBreakage.first.impactText
        && bookingBreakage.afterPoll.impactAriaLabel === bookingBreakage.first.impactAriaLabel
        && bookingBreakage.afterPoll.separateAssertiveText === '',
      JSON.stringify({ first: bookingBreakage.first, after: bookingBreakage.afterPoll }));

    scenario('a READY venue-only refusal is visible and clears after the venue recovers');
    await freshVenue();
    // This is deliberately a READY refusal: no plan exists, both lifts are out,
    // and a person presses the visible Build button. The earlier browser check
    // staged a plan first, so it could never exercise showStandingRefusal.
    const standing = JSON.parse(await run(`
      const id = new URL(location.href).searchParams.get('demo');
      const operator = await (await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'operator', demoId: id }),
      })).json();
      const asOperator = (facilityId, action, body) => fetch(
        '/api/operator/facilities/' + encodeURIComponent(facilityId) + '/' + action,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Session': operator.session.token },
          body: JSON.stringify(body ?? {}),
        },
      );
      await asOperator('east-lift', 'outage', { reasonCode: 'POWER_FAULT' });
      await asOperator('garden-lift', 'outage', { reasonCode: 'POWER_FAULT' });
      const readyBeforeRefusal = await call('get_event_access_state', {});

      const build = document.querySelector('#build-plan-button');
      build.focus();
      const heldFocus = document.activeElement === build;
      build.click();
      const feedback = document.querySelector('#plan-feedback');
      const refusalDeadline = Date.now() + 10000;
      while (Date.now() < refusalDeadline && (feedback.hidden || build.disabled)) await sleep(80);
      const explanation = await call('explain_access_refusal', {});
      const duringRevision = rev();
      // A transient toast used to be the only result. Wait longer than its full
      // lifetime and prove the result next to the plan is still there.
      await sleep(4400);
      const feedbackRect = feedback.getBoundingClientRect();
      const during = {
        feedbackShown: !feedback.hidden,
        feedbackText: feedback.textContent.replace(/\\s+/g, ' ').trim(),
        inViewport: feedbackRect.top < window.innerHeight && feedbackRect.bottom > 0,
        insidePlanCard: feedback.closest('#assurance-card')?.id === 'assurance-card',
        emptyPlanHidden: document.querySelector('#assurance-empty').hidden,
        actionFeedbackHidden: document.querySelector('#action-feedback').hidden,
        venueNoticeHidden: document.querySelector('#venue-notice').hidden,
        buttonEnabled: !build.disabled,
        buttonLabel: build.textContent,
        focused: document.activeElement?.id,
        phase: (await call('get_access_bundle_status', {})).phase,
      };

      await asOperator('east-lift', 'restore');
      const recoveryDeadline = Date.now() + 10000;
      let clearedByPoll = false;
      while (Date.now() < recoveryDeadline) {
        if (rev() > duringRevision && feedback.hidden) {
          clearedByPoll = true;
          break;
        }
        await sleep(80);
      }
      const afterUi = {
        revision: rev(),
        feedbackShown: !feedback.hidden,
        feedbackMessage: document.querySelector('#plan-feedback-message').textContent.trim(),
        buttonLabel: build.textContent,
      };
      const afterState = await call('get_event_access_state', {});
      const afterExplanation = await call('explain_access_refusal', {});
      build.click();
      const successfulDeadline = Date.now() + 10000;
      while (Date.now() < successfulDeadline && document.querySelector('#decision-section').hidden) await sleep(80);
      const recoveredPlan = await call('get_access_bundle_status', {});
      return JSON.stringify({
        readyBeforeRefusal,
        heldFocus,
        explanation,
        duringRevision,
        during,
        clearedByPoll,
        afterUi,
        afterState,
        afterExplanation,
        recoveredPlan,
        decisionShown: !document.querySelector('#decision-section').hidden,
        route: document.querySelector('#route-steps').textContent.replace(/\\s+/g, ' ').trim(),
      });
    `));
    const liftsBeforeRefusal = (standing.readyBeforeRefusal.facilities ?? []).filter((facility) => facility.label.includes('Lift'));
    check('the refusal precondition is genuinely READY with both lifts out',
      standing.readyBeforeRefusal.phase === 'READY'
        && liftsBeforeRefusal.length === 2
        && liftsBeforeRefusal.every((facility) => facility.status === 'OUT_OF_SERVICE')
        && standing.heldFocus === true,
      JSON.stringify(standing.readyBeforeRefusal));
    check('the server diagnosis says no requirement change can repair this venue-only refusal',
      standing.explanation.blocked === true
        && standing.explanation.requirementChangeCanHelp === false
        && standing.explanation.nextAction === 'CONTACT_VENUE_STAFF'
        && (standing.explanation.validOptionsNow ?? []).length === 0,
      JSON.stringify(standing.explanation));
    check('the READY refusal stays inline in the access-plan card after any toast lifetime',
      standing.during.feedbackShown === true
        && standing.during.inViewport === true
        && standing.during.insidePlanCard === true
        && standing.during.emptyPlanHidden === true
        && standing.during.actionFeedbackHidden === true
        && standing.during.venueNoticeHidden === true
        && standing.during.feedbackText.includes('One or more lifts are out of service')
        && standing.during.feedbackText.includes('operations page')
        && standing.during.feedbackText.includes('Requirements cannot fix this')
        && standing.during.feedbackText.includes('Nothing was booked or reserved.')
        && !/Change a requirement and try again/i.test(standing.during.feedbackText),
      JSON.stringify(standing.during));
    check('the refused Build action settles in READY with an exact retry label and focus on the error',
      standing.during.buttonEnabled === true
        && standing.during.buttonLabel === 'Recheck route availability'
        && standing.during.phase === 'READY'
        && standing.during.focused === 'plan-feedback-heading'
        && !/checking|in progress/i.test(standing.during.buttonLabel),
      JSON.stringify(standing.during));
    check('an ordinary poll clears the standing result after one usable lift recovers',
      standing.clearedByPoll === true
        && standing.afterUi.revision > standing.duringRevision
        && standing.afterUi.feedbackShown === false
        && standing.afterUi.feedbackMessage === ''
        && standing.afterUi.buttonLabel === 'Build my complete access plan',
      JSON.stringify(standing.afterUi));
    check('with exactly one lift restored the same visible Build control produces a complete plan',
      standing.afterState.phase === 'READY'
        && (standing.afterState.facilities ?? []).filter((facility) => facility.status === 'OPERATIONAL').length === 1
        && standing.afterExplanation.blocked === false
        && standing.decisionShown === true
        && standing.recoveredPlan.phase === 'AWAITING_HUMAN_CONFIRMATION'
        && standing.route.includes('East Lift L2'),
      JSON.stringify({ state: standing.afterState, explanation: standing.afterExplanation, recoveredPlan: standing.recoveredPlan, route: standing.route }));

    scenario('the decision log says which actor really did each thing');
    await freshVenue();
    // The audit badge is a claim about who acted. It is produced from the
    // X-WebMCP-Tool header the tool wrappers send, so nothing below reads a
    // value the test itself supplied: the browser sends the header, the server
    // decides the attribution, and the page renders it.
    const agentAttribution = await run(`
      const found = await call('find_access_bundle', ${JSON.stringify(FULL)});
      await settle();
      await call('stage_access_bundle', { planId: found.plan.id, expectedVenueRevision: found.plan.basedOnRevision });
      await settle();
      const top = document.querySelector('#audit-list .audit-item');
      return JSON.stringify({
        entry: top.querySelector('strong').textContent,
        actor: top.querySelector('.actor-badge').textContent,
        marked: top.querySelector('.actor-badge').classList.contains('webmcp'),
      });`);
    const agentAudit = JSON.parse(agentAttribution);
    check('an agent-staged plan is logged as the agent that staged it',
      agentAudit.entry === 'Plan prepared for review' && agentAudit.actor === 'WebMCP · stage_access_bundle',
      agentAttribution);
    check('the agent entry is visually marked as an agent entry', agentAudit.marked === true, agentAttribution);

    // The operator writes used to ignore the declared invocation path entirely,
    // so the visible ledger could not show whether a lift was taken out of
    // service by a person or by their agent - on the one artefact this product
    // asks to be believed. Driven through the page so the rendered badge is what
    // is measured, not the payload behind it.
    const operatorAttribution = await run(`
      const id = new URL(location.href).searchParams.get('demo');
      const operator = await (await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'operator', demoId: id }),
      })).json();
      const outage = (path, tool) => fetch(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Demo-Session': operator.session.token,
          ...(tool ? { 'X-WebMCP-Tool': tool } : {}),
        },
        body: JSON.stringify({ reasonCode: 'POWER_FAULT' }),
      });

      await outage('/api/operator/facilities/garden-lift/outage', 'report_facility_outage');
      await settle();
      const viaTool = document.querySelector('#audit-list .audit-item');
      const asAgent = {
        entry: viaTool.querySelector('strong').textContent,
        detail: viaTool.querySelector('small').textContent,
        actor: viaTool.querySelector('.actor-badge').textContent,
      };

      await outage('/api/operator/facilities/east-lift/outage', null);
      await settle();
      const viaPage = document.querySelector('#audit-list .audit-item');
      return JSON.stringify({
        asAgent,
        asHuman: {
          entry: viaPage.querySelector('strong').textContent,
          detail: viaPage.querySelector('small').textContent,
          actor: viaPage.querySelector('.actor-badge').textContent,
        },
      });`);
    const operatorAudit = JSON.parse(operatorAttribution);
    check('an outage reported through its tool is shown as an agent action',
      operatorAudit.asAgent.actor === 'WebMCP · report_facility_outage',
      operatorAttribution);
    check('the same outage without the header is shown as the venue, not an agent',
      !/WebMCP/.test(operatorAudit.asHuman.actor),
      operatorAttribution);
    // The visitor's log summarises by action and names the lift in the line
    // beneath, which is a different view from the operations page rather than a
    // weaker one - there the title itself resolves the facility, because there
    // a generic title sat above a detail naming a different lift. Asserted as
    // the property that actually holds: the entry names the lift it is about.
    check('each visitor entry names the lift it is about',
      /Garden Lift L4/.test(operatorAudit.asAgent.detail)
        && /East Lift L2/.test(operatorAudit.asHuman.detail),
      operatorAttribution);

    await freshVenue();
    const humanAttribution = await run(`
      document.querySelector('#build-plan-button').click();
      await sleep(2400);
      const top = document.querySelector('#audit-list .audit-item');
      return JSON.stringify({
        entry: top.querySelector('strong').textContent,
        actor: top.querySelector('.actor-badge').textContent,
        marked: top.querySelector('.actor-badge').classList.contains('webmcp'),
      });`);
    const humanAudit = JSON.parse(humanAttribution);
    check('the same action taken in the visible form is logged as the human',
      humanAudit.entry === 'Plan prepared for review' && humanAudit.actor === 'Human UI',
      humanAttribution);
    check('the human entry carries no agent marking', humanAudit.marked === false, humanAttribution);

    scenario('a 375 px visitor can still see the venue stop being live');
    await freshVenue();
    await client.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
    await sleep(200);
    // At this width the header's live indicator is deliberately hidden, so the
    // refusal card is the only place the venue revision can still be read.
    const narrow = await run(`
      const visible = (selector) => document.querySelector(selector).offsetParent !== null;
      document.querySelector('#build-plan-button').click();
      await sleep(2400);
      const decisionVisible = visible('#decision-section');
      document.querySelector('#fault-button').click();
      await sleep(1600);
      document.querySelector('#confirm-button').click();
      await sleep(2400);
      return JSON.stringify({
        liveIndicatorWhileLive: visible('#venue-live-status'),
        headerRevisionWhileLive: visible('#venue-version'),
        decisionVisible,
        incidentVisible: visible('#incident'),
        incidentDetail: document.querySelector('#incident-detail').textContent,
        partialVisible: visible('#partial-count'),
        partial: document.querySelector('#partial-count').textContent,
        replanVisible: visible('#replan-button'),
        receiptHidden: document.querySelector('#receipt-section').hidden,
        overflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      });`);
    const small = JSON.parse(narrow);
    check('the whole refusal is reachable at 375 px',
      small.decisionVisible && small.incidentVisible && small.partialVisible && small.replanVisible,
      narrow);
    check('the refusal still states the venue revision the header cannot show',
      small.headerRevisionWhileLive === false && /venue revision \d+/.test(small.incidentDetail),
      narrow);
    check('the 375 px refusal reports zero partial reservations and no receipt',
      small.partial === '0' && small.receiptHidden === true,
      narrow);
    check('the 375 px layout does not overflow while refusing', small.overflow === true, narrow);

    // Losing the server is the one thing the hidden indicator has to say
    // anyway. The connection is broken in the page rather than by killing the
    // server, so this stays a pure layout claim about the stale state.
    const narrowStale = await run(`
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (url.pathname === '/api/state') throw new TypeError('Failed to fetch');
        return originalFetch(input, init);
      };
      await sleep(3200);
      const result = {
        staleClass: document.querySelector('#venue-live-status').className,
        staleText: document.querySelector('#venue-live-text').textContent,
        staleVisible: document.querySelector('#venue-live-status').offsetParent !== null,
      };
      window.fetch = originalFetch;
      await sleep(2200);
      result.recoveredText = document.querySelector('#venue-live-text').textContent;
      result.hiddenAgainWhenLive = document.querySelector('#venue-live-status').offsetParent === null;
      return JSON.stringify(result);`);
    const staleNarrow = JSON.parse(narrowStale);
    check('a 375 px page shows the venue going stale',
      staleNarrow.staleVisible === true
        && staleNarrow.staleClass.includes('stale')
        && staleNarrow.staleText.startsWith('Venue data stale'),
      narrowStale);
    check('the indicator hides itself again once the venue is live',
      staleNarrow.hiddenAgainWhenLive === true && staleNarrow.recoveredText.startsWith('Venue data live'),
      narrowStale);
    await client.send('Emulation.clearDeviceMetricsOverride');

    scenario('a browser without WebMCP gets the complete manual fallback');
    await mkdir(FALLBACK_PROFILE, { recursive: true });
    fallbackChrome = spawn(chromePath, [
      '--remote-debugging-port=0',
      `--user-data-dir=${FALLBACK_PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--headless=new',
      `${ORIGIN}/?manual=${Date.now()}`,
    ], { stdio: 'ignore' });
    FALLBACK_DEBUG_PORT = await readDevToolsPort(FALLBACK_PROFILE, fallbackChrome);

    let fallbackPage = null;
    for (let attempt = 0; attempt < 60 && !fallbackPage; attempt += 1) {
      await sleep(500);
      try {
        const targets = await (await fetch(`http://127.0.0.1:${FALLBACK_DEBUG_PORT}/json/list`)).json();
        fallbackPage = targets.find((target) => target.type === 'page' && target.url.startsWith(ORIGIN)) ?? null;
      } catch { /* starting */ }
    }
    if (!fallbackPage) throw new Error('Chrome without the WebMCP flag did not expose a page target');

    // Attached the same way as the flagged page, so this browser's console
    // errors and failed requests are held to the same account at the end.
    fallbackClient = await attachClient(fallbackPage);
    await sleep(3_200);

    // MANUAL-01 claims no tool chip ever appears. That used to be one count read
    // at the end of the flow, which cannot see a chip that appeared during a
    // transition and was removed again before the read. This records every node
    // inserted into the tool list from here until the flow finishes.
    await evaluate(fallbackClient, `
      const list = document.querySelector('#tool-list');
      if (!list) throw new Error('#tool-list is missing; the chip recorder cannot be installed');
      window.__nswrChipLog = { atInstall: list.querySelectorAll('.tool-chip').length, added: [] };
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.matches?.('.tool-chip')) window.__nswrChipLog.added.push(node.textContent);
            for (const nested of node.querySelectorAll?.('.tool-chip') ?? []) {
              window.__nswrChipLog.added.push(nested.textContent);
            }
          }
        }
      }).observe(list, { childList: true, subtree: true });
      return true;
    `);
    const fallback = await evaluate(fallbackClient, `
      return {
        modelContext: typeof document.modelContext,
        status: document.querySelector('#webmcp-status-text').textContent,
        chips: [...document.querySelectorAll('#tool-list .tool-chip')].map((chip) => chip.textContent),
        declarativeAttribute: document.querySelector('#requirements-form').hasAttribute('toolname'),
        buildEnabled: !document.querySelector('#build-plan-button').disabled,
      };
    `);
    check('the unflagged browser exposes no WebMCP API', fallback.modelContext === 'undefined', JSON.stringify(fallback));
    check('the fallback reports manual mode without phantom tool chips',
      fallback.status === 'Manual demo mode' && fallback.chips.length === 0 && fallback.declarativeAttribute === false,
      JSON.stringify(fallback));
    check('the ordinary booking form remains usable', fallback.buildEnabled === true, JSON.stringify(fallback));

    // The README's central claim about this page is that WebMCP is added on
    // top and not in place of anything: with no agent API present at all, the
    // entire failure-and-recovery flow must still be completable by a person
    // pressing the visible buttons. Every step below is a click.
    const manualFlow = await evaluate(fallbackClient, `
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const press = (selector) => document.querySelector(selector).click();
      const waitFor = async (test, ms = 12000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (test()) return true;
          await sleep(100);
        }
        return false;
      };
      const steps = {};

      steps.formEditable = !document.querySelector('input[name=wheelchairWidthCm]').disabled;
      press('#build-plan-button');
      steps.planReached = await waitFor(() => !document.querySelector('#decision-section').hidden);
      steps.planState = document.querySelector('#plan-state').textContent.trim();
      steps.planRoute = document.querySelector('#route-summary').textContent;
      steps.confirmLabel = document.querySelector('#confirm-button').textContent;

      press('#fault-button');
      steps.faultArmed = await waitFor(() => document.querySelector('#fault-button').getAttribute('aria-disabled') === 'true');
      steps.stateStillReady = document.querySelector('#plan-state').textContent.trim();

      press('#confirm-button');
      steps.refusalReached = await waitFor(() => !document.querySelector('#incident').hidden);
      steps.refusalDetail = document.querySelector('#incident-detail').textContent;
      steps.refusalPartial = document.querySelector('#partial-count').textContent;
      steps.noReceiptYet = document.querySelector('#receipt-section').hidden;
      steps.confirmReenabled = !document.querySelector('#confirm-button').disabled;
      steps.alertAfterRefusal = document.querySelector('#a11y-alert').textContent;

      press('#replan-button');
      steps.replacementReached = await waitFor(() => (
        document.querySelector('#incident').hidden
        && document.querySelector('#decision-heading').textContent.includes('route changed')
      ));
      steps.replacementRoute = document.querySelector('#route-summary').textContent;

      press('#confirm-button');
      steps.receiptReached = await waitFor(() => !document.querySelector('#receipt-section').hidden);
      steps.receipt = document.querySelector('#receipt-number').textContent;
      const cell = (label) => [...document.querySelectorAll('#receipt-details div')]
        .find((row) => row.querySelector('dt').textContent === label)?.querySelector('dd').textContent;
      steps.partialReservations = cell('Partial reservations');
      steps.bookedRoute = cell('Route');
      steps.atomicProof = document.querySelector('#atomic-proof-text').textContent;
      steps.statusAfter = document.querySelector('#a11y-status').textContent;
      steps.alertAfter = document.querySelector('#a11y-alert').textContent;
      steps.chipsEver = document.querySelectorAll('#tool-list .tool-chip').length;

      // Prove the recorder was actually live rather than silently detached: an
      // observer that never attached would report an empty log and pass this
      // scenario for the wrong reason. A probe chip must show up, and is then
      // removed and excluded from the reported log.
      const probe = document.createElement('li');
      probe.className = 'tool-chip';
      probe.textContent = '__probe__';
      document.querySelector('#tool-list').append(probe);
      await sleep(80);
      steps.chipRecorderLive = (window.__nswrChipLog?.added ?? []).includes('__probe__');
      probe.remove();
      steps.chipLog = {
        atInstall: window.__nswrChipLog?.atInstall,
        added: (window.__nswrChipLog?.added ?? []).filter((text) => text !== '__probe__'),
      };

      steps.badge = document.querySelector('#webmcp-status-text').textContent;
      steps.declarativeAttribute = document.querySelector('#requirements-form').hasAttribute('toolname');
      return steps;
    `);
    const manual = JSON.stringify(manualFlow);
    check('a plan can be built with no WebMCP present',
      manualFlow.formEditable && manualFlow.planReached && manualFlow.planState === 'Ready for review',
      manual);
    check('the manual page routes through the East lift first',
      manualFlow.planRoute.includes('East Entrance') && manualFlow.confirmLabel === 'Confirm this accessible booking',
      manual);
    check('the fault can be armed without an agent',
      manualFlow.faultArmed && manualFlow.stateStillReady === 'Ready for review',
      manual);
    check('the manual confirmation is refused with the same explanation',
      manualFlow.refusalReached
        && manualFlow.refusalDetail.includes('STALE_RESOURCE_VERSION')
        && manualFlow.refusalDetail.includes('next action REPLAN'),
      manual);
    check('the manual refusal books nothing and reserves nothing',
      manualFlow.refusalPartial === '0' && manualFlow.noReceiptYet === true,
      manual);
    check('the manual refusal is announced and leaves the button usable',
      manualFlow.alertAfterRefusal.includes('booking stopped') && manualFlow.confirmReenabled === true,
      manual);
    check('a person can replan onto the working lift by pressing a button',
      manualFlow.replacementReached && manualFlow.replacementRoute.includes('Garden Entrance'),
      manual);
    check('the replacement can be confirmed and produces a real receipt',
      manualFlow.receiptReached && /^NSWR-\d{5}$/.test(manualFlow.receipt),
      manual);
    check('the manual receipt books the replacement route with zero partial reservations',
      manualFlow.partialReservations === '0'
        && manualFlow.bookedRoute.includes('Garden Lift L4')
        && manualFlow.atomicProof.includes('booking 0→1'),
      manual);
    check('the manual booking is announced without a stale failure',
      manualFlow.statusAfter === 'Every requested resource was confirmed in one transaction.'
        && manualFlow.alertAfter === '',
      manual);
    check('the chip recorder was live for the whole manual flow',
      manualFlow.chipRecorderLive === true,
      manual);
    check('no tool chip was inserted at any point in the manual flow',
      manualFlow.chipLog?.atInstall === 0
        && (manualFlow.chipLog?.added ?? []).length === 0,
      JSON.stringify(manualFlow.chipLog));
    check('the manual page ends with no tool surface and no declarative attribute',
      manualFlow.chipsEver === 0
        && manualFlow.badge === 'Manual demo mode'
        && manualFlow.declarativeAttribute === false,
      manual);

    scenario('Microsoft Edge gets whichever surface it can actually support');
    const edgePath = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
    if (!edgePath) {
      note('Microsoft Edge is not installed on this machine; nothing was measured for it.');
    } else {
      // Edge is Chromium and speaks the same DevTools protocol, but it ships
      // WebMCP on its own schedule. Whether it exposes document.modelContext is
      // recorded rather than required; what IS required is that the page tells
      // the truth about the surface it got, in either case.
      await prepareFlaggedProfile(EDGE_PROFILE);
      const edgeDemo = randomUUID();
      edgeBrowser = spawn(edgePath, [
        '--remote-debugging-port=0',
        `--user-data-dir=${EDGE_PROFILE}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--headless=new',
        `${ORIGIN}/?demo=${edgeDemo}`,
      ], { stdio: 'ignore' });
      EDGE_DEBUG_PORT = await readDevToolsPort(EDGE_PROFILE, edgeBrowser);

      let edgePage = null;
      for (let attempt = 0; attempt < 80 && !edgePage; attempt += 1) {
        await sleep(500);
        try {
          const targets = await (await fetch(`http://127.0.0.1:${EDGE_DEBUG_PORT}/json/list`)).json();
          edgePage = targets.find((target) => target.type === 'page' && target.url.startsWith(ORIGIN)) ?? null;
        } catch { /* starting */ }
      }
      if (!edgePage) throw new Error('Edge did not expose a page target');

      edgeClient = connect(edgePage.webSocketDebuggerUrl);
      await edgeClient.ready;
      await edgeClient.send('Runtime.enable');
      await sleep(3_600);

      const edge = await evaluate(edgeClient, `
        const mc = document.modelContext;
        const exposed = mc && typeof mc.getTools === 'function' ? await mc.getTools() : [];
        return {
          userAgent: navigator.userAgent,
          modelContext: typeof mc,
          registerTool: typeof mc?.registerTool,
          originAgentCluster: window.originAgentCluster,
          tools: exposed.map((tool) => tool.name).sort(),
          readTools: exposed.filter((tool) => tool.annotations?.readOnlyHint === true).length,
          status: document.querySelector('#webmcp-status-text').textContent,
          chips: [...document.querySelectorAll('#tool-list .tool-chip')].map((chip) => chip.textContent).sort(),
          buildEnabled: !document.querySelector('#build-plan-button').disabled,
          declarativeAttribute: document.querySelector('#requirements-form').hasAttribute('toolname'),
        };
      `);
      // Chromium reduces the user agent to major.0.0.0, so the build number has to
      // come from the DevTools endpoint instead. A version typed into the README by
      // hand goes stale the moment the browser updates itself, silently.
      const edgeBuild = await (async () => {
        try {
          const meta = await (await fetch(`http://127.0.0.1:${EDGE_DEBUG_PORT}/json/version`)).json();
          return (meta.Browser ?? '').replace('Edg/', '').trim() || null;
        } catch {
          return null;
        }
      })();
      const edgeVersion = (edge.userAgent.match(/Edg\/([\d.]+)/) ?? [])[1] ?? 'unknown';
      note(`Edge ${edgeBuild ?? edgeVersion}: document.modelContext is ${edge.modelContext}; page badge "${edge.status}"; tools ${edge.tools.length ? edge.tools.join(', ') : 'none'}.`);

      check('the page is origin-isolated in Edge too', edge.originAgentCluster === true, JSON.stringify(edge));
      check('the ordinary booking form works in Edge', edge.buildEnabled === true, JSON.stringify(edge));
      if (edge.modelContext === 'undefined') {
        check('Edge without WebMCP is reported as manual mode, with no invented tools',
          edge.status === 'Manual demo mode' && edge.chips.length === 0 && edge.declarativeAttribute === false,
          JSON.stringify(edge));
      } else {
        const edgeClaim = edge.status.match(/(\d+) read · (\d+) write/);
        check('Edge with WebMCP registers the tool surface',
          edge.tools.length > 0 && edge.chips.join() === edge.tools.join(),
          JSON.stringify(edge));
        check('the badge Edge shows matches what Edge really exposes',
          edgeClaim
            && Number(edgeClaim[1]) + Number(edgeClaim[2]) === edge.tools.length
            && Number(edgeClaim[1]) === edge.readTools,
          JSON.stringify(edge));
      }

      // Whatever Edge exposes, the booking has to work there.
      const edgeBooking = await evaluate(edgeClient, `
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const waitFor = async (test, ms = 12000) => {
          const deadline = Date.now() + ms;
          while (Date.now() < deadline) { if (test()) return true; await sleep(100); }
          return false;
        };
        document.querySelector('#build-plan-button').click();
        const staged = await waitFor(() => !document.querySelector('#decision-section').hidden);
        document.querySelector('#confirm-button').click();
        const booked = await waitFor(() => !document.querySelector('#receipt-section').hidden);
        return {
          staged,
          booked,
          receipt: document.querySelector('#receipt-number').textContent,
          proof: document.querySelector('#atomic-proof-text').textContent,
        };
      `);
      check('a booking completes end to end in Edge',
        edgeBooking.staged && edgeBooking.booked && /^NSWR-\d{5}$/.test(edgeBooking.receipt)
          && edgeBooking.proof.includes('booking 0→1'),
        JSON.stringify(edgeBooking));

      await edgeClient.send('Browser.close').catch(() => {});
      edgeClient.close();
      edgeClient = null;
      await stopProcessTree(edgeBrowser);
      edgeBrowser = null;
    }

    scenario(RESTART_SCENARIO);
    // The venue store is in-process, so a restart is a total loss of state.
    // The page cannot keep the booking; what it must not do is present the
    // replacement venue as the one the visitor was looking at, or swallow a
    // failed action so quietly that nothing on screen changes.
    await freshVenue();
    const beforeLoss = await run(`
      document.querySelector('#build-plan-button').click();
      await sleep(2400);
      document.querySelector('#confirm-button').click();
      await sleep(2600);
      return JSON.stringify({
        receipt: document.querySelector('#receipt-number').textContent,
        receiptHidden: document.querySelector('#receipt-section').hidden,
        demoId: new URL(location.href).searchParams.get('demo'),
        live: document.querySelector('#venue-live-text').textContent,
        noticeHidden: document.querySelector('#venue-notice').hidden,
      });`);
    const booked = JSON.parse(beforeLoss);
    check('a booking exists before the server is taken away',
      booked.receiptHidden === false && /^NSWR-\d{5}$/.test(booked.receipt) && booked.noticeHidden === true,
      beforeLoss);

    await stopProcessTree(server);
    await waitForServerGone();
    // How long a browser takes to give up on a socket that is no longer
    // listening is not fixed, so this waits for the page to notice instead of
    // sampling at an arbitrary moment. It still has to notice.
    const wentStale = await waitForPage(client,
      `document.querySelector('#venue-live-status').classList.contains('stale')`,
      25_000);
    const whileDown = await run(`
      return JSON.stringify({
        staleClass: document.querySelector('#venue-live-status').className,
        live: document.querySelector('#venue-live-text').textContent,
        receiptHidden: document.querySelector('#receipt-section').hidden,
        receipt: document.querySelector('#receipt-number').textContent,
      });`);
    const lost = JSON.parse(whileDown);
    check('the page stops claiming the venue data is live',
      wentStale === true && lost.staleClass.includes('stale') && lost.live.startsWith('Venue data stale'),
      whileDown);
    check('it neither erases nor re-invents the booking it already showed',
      lost.receiptHidden === false && lost.receipt === booked.receipt,
      whileDown);

    server = launchServer();
    await waitForServer();
    await client.send('Page.reload', { ignoreCache: true });
    await waitForPage(client, `document.readyState === 'complete' && Boolean(document.querySelector('#venue-notice'))`, 15_000);
    await sleep(3_000);
    const restartReload = await run(`
      return JSON.stringify({
        demoId: new URL(location.href).searchParams.get('demo'),
        noticeHidden: document.querySelector('#venue-notice').hidden,
        notice: document.querySelector('#venue-notice').textContent,
        alert: document.querySelector('#a11y-alert').textContent,
        live: document.querySelector('#venue-live-text').textContent,
        receiptHidden: document.querySelector('#receipt-section').hidden,
        phase: (await call('get_access_bundle_status', {})).phase,
        rev: rev(),
      });`);
    const rebuilt = JSON.parse(restartReload);
    check('reopening the same venue link after a restart really does land on a new venue',
      rebuilt.demoId === booked.demoId && rebuilt.phase === 'READY' && rebuilt.rev === 1 && rebuilt.receiptHidden === true,
      restartReload);
    check('the page says the venue behind this link is gone, rather than showing an empty one as real',
      rebuilt.noticeHidden === false
        && rebuilt.notice.includes('no longer exists')
        && rebuilt.notice.includes('not carried over'),
      restartReload);
    check('the lost venue is announced assertively, not only drawn',
      rebuilt.alert === rebuilt.notice && rebuilt.alert.length > 0,
      restartReload);

    // Second half: an action taken while the server is unreachable has to say
    // so. Silently re-enabling the button, or leaving it reading "Confirming…"
    // forever, both tell the visitor their booking might be in progress.
    const stagedAgain = await run(`
      document.querySelector('#build-plan-button').click();
      await sleep(2400);
      return JSON.stringify({ phase: (await call('get_access_bundle_status', {})).phase });`);
    check('a plan can still be built on the rebuilt venue', JSON.parse(stagedAgain).phase === 'AWAITING_HUMAN_CONFIRMATION', stagedAgain);

    await stopProcessTree(server);
    await waitForServerGone();
    await sleep(2_600);
    // How long a browser takes to give up on a dead socket is not fixed, and
    // Wait for the failed action to settle rather than sampling it at an
    // arbitrary moment; its contextual result must then remain visible.
    const confirmWhileDown = await evaluate(client, `
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const button = document.querySelector('#confirm-button');
      const feedback = document.querySelector('#action-feedback');
      const statusRegion = document.querySelector('#a11y-status');
      const priorStatus = statusRegion.textContent;
      const priorFeedback = feedback.textContent;
      button.click();

      let announced = '';
      let feedbackSeen = '';
      let settled = false;
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        if (!feedback.hidden && feedback.textContent && feedback.textContent !== priorFeedback) feedbackSeen = feedback.textContent;
        if (statusRegion.textContent !== priorStatus) announced = statusRegion.textContent;
        if (announced && !button.disabled && !button.textContent.includes('Confirming')) {
          settled = true;
          break;
        }
        await sleep(100);
      }
      return {
        settled,
        priorStatus,
        announced,
        feedbackSeen,
        feedbackVisible: !feedback.hidden,
        feedbackInsidePlan: feedback.closest('#assurance-card')?.id === 'assurance-card',
        confirmDisabled: button.disabled,
        confirmLabel: button.textContent,
        receiptHidden: document.querySelector('#receipt-section').hidden,
        incidentHidden: document.querySelector('#incident').hidden,
      };
    `);
    check('a confirmation that cannot reach the server says so',
      confirmWhileDown.announced.length > 0
        && confirmWhileDown.announced !== confirmWhileDown.priorStatus
        && confirmWhileDown.feedbackSeen === confirmWhileDown.announced
        && confirmWhileDown.feedbackVisible === true
        && confirmWhileDown.feedbackInsidePlan === true,
      JSON.stringify(confirmWhileDown));
    check('the confirm button does not stay stuck mid-transaction',
      confirmWhileDown.settled === true
        && confirmWhileDown.confirmDisabled === false
        && !confirmWhileDown.confirmLabel.includes('Confirming'),
      JSON.stringify(confirmWhileDown));
    check('no booking is presented when the server never answered',
      confirmWhileDown.receiptHidden === true && confirmWhileDown.incidentHidden === true,
      JSON.stringify(confirmWhileDown));

    server = launchServer();
    await waitForServer();

    scenario(OPERATOR_RESTART_SCENARIO);
    // The visitor page was fixed first; the operations page received the same
    // signal from the server and ignored it, so an operator could take a lift
    // out of service in a venue nobody was booking in.
    {
      // Start from a venue this scenario created itself. Inheriting whatever the
      // previous scenario left behind would make the result depend on test order,
      // and the restart scenario above deliberately destroys venues.
      // Start from a venue this scenario creates itself, on the visitor page,
      // because the reset control lives there and the scenario above
      // deliberately destroys venues.
      await client.send('Page.navigate', { url: `${ORIGIN}/` });
      await waitForPage(client, `document.readyState === 'complete' && Boolean(document.querySelector('#reset-button'))`, 15_000);
      await sleep(3_000);
      const opDemo = await run(`return new URL(location.href).searchParams.get('demo');`);
      if (!opDemo) throw new Error('the visitor page did not produce a demo identifier');
      await client.send('Page.navigate', { url: `${ORIGIN}/operator?demo=${opDemo}` });
      await waitForPage(client, `document.readyState === 'complete' && Boolean(document.querySelector('#operator-venue-notice'))`, 15_000);
      await sleep(2_500);

      const beforeRestart = await run(`
        const arm = document.querySelector('#arm-outage-button');
        const feedback = document.querySelector('#operator-action-feedback');
        arm.click();
        const feedbackDeadline = Date.now() + 10000;
        while (Date.now() < feedbackDeadline && (feedback.hidden || !feedback.textContent)) await sleep(60);
        return JSON.stringify({
          live: document.querySelector('#operator-live-text').textContent,
          noticeHidden: document.querySelector('#operator-venue-notice').hidden,
          feedbackHidden: feedback.hidden,
          feedback: feedback.textContent,
          version: document.querySelector('#operator-version').textContent,
          facilities: document.querySelectorAll('.facility-card').length,
        });`);
      const opBefore = JSON.parse(beforeRestart);
      check('the operations page reports live venue data while the server is up',
        opBefore.live.startsWith('Venue data live') && opBefore.noticeHidden === true,
        beforeRestart);
      check('the restart case begins with persistent feedback from venue revision 1',
        opBefore.feedbackHidden === false
          && opBefore.feedback.includes('fault will land')
          && opBefore.version === '1',
        beforeRestart);

      server.kill();
      await sleep(1_200);
      const opWentStale = await waitForPage(client,
        `document.querySelector('#operator-live-status').classList.contains('stale')`,
        25_000);
      const opWhileDown = await run(`
        return JSON.stringify({ live: document.querySelector('#operator-live-text').textContent });`);
      const downText = JSON.parse(opWhileDown).live;
      check('the operations page stops claiming its data is live when the server goes',
        opWentStale === true
          && (downText.startsWith('Venue data stale') || downText.startsWith('Venue data unavailable')),
        opWhileDown);

      // No reload: an operator leaves the tab open. The page has to notice the
      // server came back, re-establish its own session, and say that the venue
      // it was watching did not survive - all by itself.
      server = launchServer();
      await waitForServer();
      const recovered = await waitForPage(client,
        `document.querySelector('#operator-venue-notice').hidden === false
          && document.querySelector('#operator-live-text').textContent.startsWith('Venue data live')`,
        25_000);
      const opAfter = await run(`
        return JSON.stringify({
          noticeHidden: document.querySelector('#operator-venue-notice').hidden,
          notice: document.querySelector('#operator-venue-notice').textContent,
          announced: document.querySelector('#a11y-status').textContent,
          live: document.querySelector('#operator-live-text').textContent,
          demoId: new URL(location.href).searchParams.get('demo'),
          feedbackHidden: document.querySelector('#operator-action-feedback').hidden,
          feedback: document.querySelector('#operator-action-feedback').textContent,
          version: document.querySelector('#operator-version').textContent,
        });`);
      const opRebuilt = JSON.parse(opAfter);
      check('the operations page recovers its own session without a reload',
        recovered === true && opRebuilt.live.startsWith('Venue data live'),
        opAfter);
      check('it says the venue it was watching is gone rather than showing an empty one as real',
        opRebuilt.noticeHidden === false
          && opRebuilt.notice.includes('no longer exists')
          && opRebuilt.demoId === opDemo,
        opAfter);
      check('the loss is announced, not only drawn',
        opRebuilt.announced.includes('no longer exists'),
        opAfter);
      check('a replacement venue at the same revision clears feedback from the venue that was lost',
        opRebuilt.version === opBefore.version
          && opRebuilt.feedbackHidden === true
          && opRebuilt.feedback === '',
        `${beforeRestart} -> ${opAfter}`);
    }

    scenario('the page logged no errors while all of that happened');
    const expectedFailures = [
      { scenario: 'a visitor session cannot act as the venue', status: 403, path: /\/api\/operator\/facilities\/east-lift\/outage$/, label: 'the deliberate cross-role request' },
    ];
    const unclaimedFailures = [...failedResponses];
    const missingExpectedFailures = [];
    for (const expected of expectedFailures) {
      const index = unclaimedFailures.findIndex(({ scenario: failureScenario, status, url }) => (
        failureScenario === expected.scenario
        && status === expected.status
        && expected.path.test(new URL(url).pathname)
      ));
      if (index === -1) missingExpectedFailures.push(expected.label);
      else unclaimedFailures.splice(index, 1);
    }
    check('every intentional HTTP refusal occurred exactly once', missingExpectedFailures.length === 0, missingExpectedFailures.join(', '));

    // The restarted server does not know the page's session, so every poll is
    // refused until someone reloads. That is the honest answer and there is no
    // fixed number of them; what matters is that they happened - a page that
    // went quiet, or one that silently re-authenticated itself onto a different
    // venue without saying so, would both show up here as their absence.
    const restartSessionLosses = responsesReceived.filter(({ scenario: where, status, domainStatus, url }) => (
      where === RESTART_SCENARIO
        && status === 200
        && domainStatus === 401
        && new URL(url).pathname === '/api/state'
    ));
    check('the page kept asking the restarted server and received a typed session refusal',
      restartSessionLosses.length > 0,
      'the page stopped polling, or quietly obtained a new session, after the server restarted');

    // The operations page does the same, and then recovers by itself, so the
    // refusals stop rather than continuing forever. Their presence proves it
    // kept asking; the scenario's own checks prove it came back.
    const operatorSessionLosses = responsesReceived.filter(({ scenario: where, status, domainStatus, url }) => (
      where === OPERATOR_RESTART_SCENARIO
        && status === 200
        && domainStatus === 401
        && new URL(url).pathname === '/api/state'
    ));
    check('the operations page kept asking the restarted server and received a typed session refusal',
      operatorSessionLosses.length > 0,
      'the operations page stopped polling after the server restarted');

    check('no other HTTP request failed', unclaimedFailures.length === 0, JSON.stringify(unclaimedFailures.slice(0, 8)));

    // TOOLS-01 claims the registry matches the page state "throughout the
    // flow". That is only a claim about the seven declared phases if all seven
    // were actually reached and checked; a run that quietly stopped visiting
    // NO_ALTERNATIVE would otherwise still report the row as covered.
    const missingPhases = PHASES.filter((phase) => !phasesObserved.has(phase));
    check('every declared phase was reached and its exact tool surface verified',
      missingPhases.length === 0,
      `never observed: ${missingPhases.join(', ') || 'none'}`);

    // And the request recorder saw traffic at all, which is what makes the
    // "no request was sent" assertions above mean something.
    check('the request recorder observed traffic across the run',
      requestsSent.filter(({ url }) => url.includes('/api/')).length > 50,
      `${requestsSent.length} requests recorded in total`);

    // A refused HTTP response is already accounted for above. A connection that
    // cannot be made at all is only expected in the scenario that deliberately
    // takes the server away, and only in that scenario: everything else Chrome
    // reports there - an unhandled rejection above all - still fails the run.
    const nonNetworkConsoleErrors = consoleErrors.filter(({ scenario: where, message }) => {
      if (/Failed to load resource: the server responded with a status of 40\d/.test(message)) return false;
      if ([RESTART_SCENARIO, OPERATOR_RESTART_SCENARIO].includes(where)
        && /net::ERR_(CONNECTION_REFUSED|EMPTY_RESPONSE|CONNECTION_RESET)/.test(message)) return false;
      return true;
    });
    check('no non-network console errors',
      nonNetworkConsoleErrors.length === 0,
      nonNetworkConsoleErrors.slice(0, 5).map((entry) => `[${entry.scenario}] ${entry.message}`).join(' | '));
    check('no console warnings',
      consoleWarnings.length === 0,
      consoleWarnings.slice(0, 5).map((entry) => `[${entry.scenario}] ${entry.message}`).join(' | '));
    check('taking the server away produced only connection errors, not page errors',
      consoleErrors.filter(({ scenario: where }) => where === RESTART_SCENARIO)
        .every(({ message }) => /net::ERR_|Failed to load resource/.test(message)),
      consoleErrors.filter(({ scenario: where, message }) => where === RESTART_SCENARIO && !/net::ERR_|Failed to load resource/.test(message))
        .map((entry) => entry.message).slice(0, 5).join(' | '));

  } finally {
    await client?.send('Browser.close').catch(() => {});
    await fallbackClient?.send('Browser.close').catch(() => {});
    await edgeClient?.send('Browser.close').catch(() => {});
    client?.close();
    fallbackClient?.close();
    edgeClient?.close();
    await Promise.all([
      stopProcessTree(chrome),
      stopProcessTree(fallbackChrome),
      stopProcessTree(edgeBrowser),
      stopProcessTree(server),
    ]);
    await sleep(500);
    // These used to be removed once each, swallowing any failure. On Windows a
    // just-killed Chrome can still hold a lock on its own profile for a moment,
    // so the single attempt lost the race and the directory stayed in the temp
    // folder - silently, run after run. Retry briefly, and if it still cannot be
    // removed, say so rather than leaving the suite claiming a clean exit.
    for (const directory of [PROFILE, FALLBACK_PROFILE, EDGE_PROFILE]) {
      let removed = false;
      for (let attempt = 0; attempt < 10 && !removed; attempt += 1) {
        try {
          await rm(directory, { recursive: true, force: true });
          removed = true;
        } catch {
          await sleep(300);
        }
      }
      if (!removed) console.log(`warning: could not remove the throwaway profile ${directory}`);
    }
  }

  const failed = results.filter((result) => !result.passed);
  if (notes.length) {
    console.log('\nRecorded, not asserted:');
    for (const line of notes) console.log(`  ${line}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const failure of failed) console.log(`  [${failure.scenario}] ${failure.label}\n      ${failure.detail}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Harness error:', error.message);
  process.exitCode = 1;
});
