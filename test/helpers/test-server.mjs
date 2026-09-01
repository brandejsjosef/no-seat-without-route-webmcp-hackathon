/**
 * One way to start a server for a test, so there is one place to get it right.
 *
 * Three separate mistakes lived in the copies this replaces, and each of them
 * could make a run pass against a process the test did not start.
 *
 *  1. Ports were written into the files - 43917, 43919, 43921 and so on - so two
 *     checkouts, or two agents, contended for the same numbers.
 *  2. Asking the OS for a free port fixed the collision but not the race: the
 *     probe closes the socket before the child binds it, and anything may take
 *     it in between. A free port is a hint, not a reservation.
 *  3. The readiness poll returned on the first ok reply from anything listening.
 *     A child that died of EADDRINUSE therefore left every later assertion
 *     running against the winner's server, and passing.
 *
 * Only (3) is fatal on its own, and only (3) is fixable outright: the server
 * echoes NSWR_INSTANCE_TOKEN from /api/health, so readiness can require the
 * token this launch generated AND that this launch's own child is still alive.
 * Neither alone is enough - a stranger can echo a token it inherited with the
 * port, and a live child proves nothing about who answered.
 *
 * test/helpers/test-server.self.test.mjs exercises all of that against real
 * impostor servers rather than reading this file and believing it.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';

const REPO = new URL('../../', import.meta.url);
const SERVICE = 'no-seat-without-route';

/** A port nothing is listening on right now. Still a hint, not a reservation. */
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The environment a test server must start from.
 *
 * PORT wins over NSWR_PORT in server.mjs because a managed host sets it, and
 * Render sets NSWR_TRUST_CF_CONNECTING_IP on the service. Both are inherited by
 * a spawned child, and both have cost this project a deploy. A scenario that
 * wants one of them on sets it through `extraEnv`, which is applied after the
 * reset rather than before it.
 */
export function childEnv(port, instanceToken, extraEnv = {}) {
  const env = {
    ...process.env,
    NSWR_PORT: String(port),
    NSWR_HOST: '127.0.0.1',
    NSWR_INSTANCE_TOKEN: instanceToken,
  };
  delete env.PORT;
  delete env.NSWR_TRUST_PROXY;
  delete env.NSWR_TRUST_CF_CONNECTING_IP;
  return Object.assign(env, extraEnv);
}

/**
 * Resolve only when THIS handle's server answers.
 *
 * Both conditions, on every iteration: the child this handle owns has not
 * exited, and /api/health carries this launch's token and names this service.
 * A different listener returning 200 is not readiness; a different listener
 * returning the expected token is not readiness either once our child is gone.
 */
export async function waitForOwnedServer(handle, { attempts = 200, interval = 50 } = {}) {
  const { child, origin, instanceToken } = handle;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `server exited during startup (code ${child.exitCode}, signal ${child.signalCode})`
        + `${handle.stderr ? `\n--- stderr ---\n${handle.stderr()}` : ''}`,
      );
    }
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) {
        const health = await response.json();
        if (health.instanceToken === instanceToken && health.service === SERVICE) return handle;
        // Someone else holds the port. Not a slow start - a different process.
        throw new Error('PORT_TAKEN');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'PORT_TAKEN') throw error;
      // Still starting.
    }
    await sleep(interval);
  }
  throw new Error(`no server answered on ${origin} with this launch's token`);
}

/**
 * Stop the exact child and prove the instance is gone.
 *
 * Startup and shutdown are different state machines. An earlier version put the
 * startup-exit guard inside the wait for a killed child, so it threw on the
 * outcome it was waiting for. Here the child's exit IS the success condition,
 * and the old origin must stop serving the old token.
 */
export async function waitForOwnedServerGone(handle, { attempts = 200, interval = 50 } = {}) {
  const { child, origin, instanceToken } = handle;
  child.kill();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      try {
        const response = await fetch(`${origin}/api/health`);
        const health = await response.json();
        // Connection refused is the ordinary answer; a different token means
        // something else took the port, which is equally proof we are gone.
        if (health.instanceToken !== instanceToken) return;
      } catch {
        return;
      }
    }
    await sleep(interval);
  }
  throw new Error(`the server on ${origin} did not stop, or is still serving this launch's token`);
}

/**
 * Spawn a server on a port the caller already owns, and return its handle.
 *
 * The lower half of startTestServer, exported because a restart scenario has to
 * come back on the SAME port - that is the whole point of the scenario, and
 * allocating a new one would test something else. Callers that only need "a
 * server" should use startTestServer instead.
 *
 * Nothing here waits: the caller decides whether it wants readiness or is about
 * to assert that the child fails.
 */
export function spawnOwnedServer({ port, instanceToken = randomUUID(), extraEnv = {} } = {}) {
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: REPO,
    env: childEnv(port, instanceToken, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Drained rather than ignored, so a failure can say what the server printed
  // instead of only that nothing answered. An unread pipe also fills up and
  // stalls the child.
  let out = '';
  let err = '';
  let spawnError = null;
  child.stdout?.on('data', (chunk) => { out += chunk; });
  child.stderr?.on('data', (chunk) => { err += chunk; });
  // Without a listener a spawn failure is an uncaught exception that lands on
  // whichever test happens to be running.
  child.on('error', (error) => { spawnError = error; });

  return {
    child,
    port,
    origin,
    instanceToken,
    stdout: () => out,
    stderr: () => err,
    spawnError: () => spawnError,
  };
}

/**
 * Start a server the test owns.
 *
 * Registers its own cleanup with `t.after`, so a caller cannot forget. On a lost
 * port it retries with a new port AND a new token: reusing either would let the
 * next attempt accept the same stranger.
 */
export async function startTestServer(t, { extraEnv = {}, attempts = 5 } = {}) {
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const handle = spawnOwnedServer({ port: await freePort(), extraEnv });
    t.after(() => waitForOwnedServerGone(handle).catch(() => handle.child.kill('SIGKILL')));

    try {
      await waitForOwnedServer(handle);
      return makeClient(handle, t);
    } catch (error) {
      handle.child.kill();
      lastError = error;
      if (error instanceof Error && error.message === 'PORT_TAKEN') continue;
      throw error;
    }
  }
  throw new Error(`could not obtain a port of our own after ${attempts} attempts: ${lastError?.message}`);
}

function makeClient(handle, t) {
  const { origin, port, instanceToken, child } = handle;
  const request = (path, { method = 'GET', body, sessionToken, requestOrigin = origin, headers = {} } = {}) =>
    fetch(origin + path, {
      method,
      headers: {
        ...(method === 'GET' || method === 'HEAD' ? {} : { 'Content-Type': 'application/json', Origin: requestOrigin }),
        ...(sessionToken ? { 'X-Demo-Session': sessionToken } : {}),
        ...headers,
      },
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(body ?? {}) }),
    });

  return {
    ...handle,
    // Kept as an alias: several suites were written against `token` before the
    // handle shape was fixed, and renaming them all at once would bury the
    // behaviour changes in this commit under a mechanical diff.
    token: instanceToken,
    request,

    post: (path, body, sessionToken) => request(path, { method: 'POST', body, sessionToken }),
    get: (path, sessionToken) => request(path, { sessionToken }),

    async session(role, demoId) {
      const response = await request('/api/session', { method: 'POST', body: { role, ...(demoId ? { demoId } : {}) } });
      const payload = await response.json();
      if (!response.ok) throw new Error(`could not open a ${role} session: ${payload.error?.code}`);
      return payload.session;
    },

    async state(sessionToken) {
      const response = await request('/api/state', { sessionToken });
      return (await response.json()).state;
    },

    /** Stop the server and prove this instance is no longer answering. */
    stop: () => waitForOwnedServerGone(handle),

    /** Start a replacement on the SAME port, as a restart scenario needs. */
    async restart(extraEnv = {}) {
      const replacement = spawnOwnedServer({ port, extraEnv });
      t.after(() => waitForOwnedServerGone(replacement).catch(() => replacement.child.kill('SIGKILL')));
      await waitForOwnedServer(replacement);
      return replacement;
    },
  };
}

export { freePort };
