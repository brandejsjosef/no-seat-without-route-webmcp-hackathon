/**
 * The harness proves it tested its own server. This proves the harness.
 *
 * Every other suite's GREEN rests on readiness meaning "the process I started is
 * answering". An audit measured the previous version failing 1 run in 6 and
 * traced it to something worse than flakiness: ports were written into the
 * files, and the poll returned on the first ok reply from anything listening. A
 * child that died of EADDRINUSE therefore left every later assertion running
 * against a stranger's server, and passing.
 *
 * A guard that is only read cannot be trusted - one written earlier in this
 * project reported all clear against four ports it was looking straight at,
 * because escaping had turned its word boundaries into control characters. So
 * these are executable: real impostor servers, real dead children, real
 * cross-matching attempts.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import { startTestServer, waitForOwnedServer, childEnv } from './test-server.mjs';

/** A server that answers /api/health with whatever token it is given. */
function impostor(token) {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, service: 'no-seat-without-route', instanceToken: token }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** A child that is alive but is not our server, and one that has already exited. */
const liveChild = () => ({ exitCode: null, signalCode: null });
const deadChild = () => ({ exitCode: 1, signalCode: null });

const rejects = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
};

describe('readiness accepts only the server this launch started', () => {
  test('a 200 with the wrong token is refused', async (t) => {
    const stranger = await impostor(randomUUID());
    t.after(() => stranger.close());

    const error = await rejects(
      waitForOwnedServer({ child: liveChild(), origin: stranger.origin, instanceToken: randomUUID() }, { attempts: 3, interval: 10 }),
    );
    assert.ok(error, 'a foreign server answering 200 was accepted as ours');
  });

  test('an owned child that has already exited is refused even when the token matches', async (t) => {
    // The nastiest case: the port is answering with exactly the token we set,
    // because something else inherited it - but our own process is gone.
    const token = randomUUID();
    const stranger = await impostor(token);
    t.after(() => stranger.close());

    const error = await rejects(
      waitForOwnedServer({ child: deadChild(), origin: stranger.origin, instanceToken: token }, { attempts: 3, interval: 10 }),
    );
    assert.ok(error, 'a dead child was reported ready because a stranger echoed its token');
    assert.match(error.message, /exit/i, `the failure should name the exit, not the port: ${error.message}`);
  });

  test('a live child on a port serving a different token is refused', async (t) => {
    const stranger = await impostor('not-the-token-we-set');
    t.after(() => stranger.close());

    const error = await rejects(
      waitForOwnedServer({ child: liveChild(), origin: stranger.origin, instanceToken: randomUUID() }, { attempts: 3, interval: 10 }),
    );
    assert.ok(error, 'a live child plus a foreign token was accepted');
  });

  test('a real server answering with its own token is accepted', async (t) => {
    const handle = await startTestServer(t);
    const health = await (await fetch(`${handle.origin}/api/health`)).json();
    assert.equal(health.instanceToken, handle.instanceToken, 'the handle and the server disagree about the token');
    assert.equal(health.service, 'no-seat-without-route');
    assert.equal(handle.child.exitCode, null, 'the server exited during its own test');
  });
});

describe('shutdown is a different state machine from startup', () => {
  test('a normal stop succeeds and is not reported as a startup failure', async (t) => {
    const handle = await startTestServer(t);
    await handle.stop();
    assert.notEqual(handle.child.exitCode === null && handle.child.signalCode === null, true, 'the child is still running');
  });

  test('after stopping, the old token is no longer served from the old origin', async (t) => {
    const handle = await startTestServer(t);
    const { origin, instanceToken } = handle;
    await handle.stop();

    let served = null;
    try {
      served = (await (await fetch(`${origin}/api/health`)).json()).instanceToken;
    } catch {
      served = null;
    }
    assert.notEqual(served, instanceToken, 'the stopped instance is still answering on its old origin');
  });
});

describe('two launches cannot be mistaken for each other', () => {
  test('separate handles get separate ports and separate tokens', async (t) => {
    const first = await startTestServer(t);
    const second = await startTestServer(t);

    assert.notEqual(first.port, second.port, 'two servers were given the same port');
    assert.notEqual(first.instanceToken, second.instanceToken, 'two servers were given the same token');

    const firstHealth = await (await fetch(`${first.origin}/api/health`)).json();
    const secondHealth = await (await fetch(`${second.origin}/api/health`)).json();
    assert.equal(firstHealth.instanceToken, first.instanceToken);
    assert.equal(secondHealth.instanceToken, second.instanceToken);
    assert.notEqual(firstHealth.instanceToken, secondHealth.instanceToken);
  });

  test('one handle cannot be validated against the other origin', async (t) => {
    const first = await startTestServer(t);
    const second = await startTestServer(t);

    const error = await rejects(
      waitForOwnedServer(
        { child: first.child, origin: second.origin, instanceToken: first.instanceToken },
        { attempts: 3, interval: 10 },
      ),
    );
    assert.ok(error, 'a handle was satisfied by a different launch of the same server');
  });
});

describe('the child environment is built, not inherited', () => {
  test('Render-style variables are removed unless a scenario asks for them', () => {
    // PORT beats NSWR_PORT in server.mjs and Render sets both PORT and
    // NSWR_TRUST_CF_CONNECTING_IP on the service. Inheriting either has cost
    // this project a deploy.
    const polluted = { PORT: '10000', NSWR_TRUST_PROXY: '1', NSWR_TRUST_CF_CONNECTING_IP: '1' };
    const original = {};
    for (const [key, value] of Object.entries(polluted)) {
      original[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      const clean = childEnv(4321, 'token', {});
      assert.equal(clean.PORT, undefined, 'PORT was inherited and beats NSWR_PORT');
      assert.equal(clean.NSWR_TRUST_PROXY, undefined);
      assert.equal(clean.NSWR_TRUST_CF_CONNECTING_IP, undefined);
      assert.equal(clean.NSWR_PORT, '4321');
      assert.equal(clean.NSWR_INSTANCE_TOKEN, 'token');
      assert.equal(clean.NSWR_HOST, '127.0.0.1');

      // extraEnv is applied AFTER the reset, so a scenario that wants one of
      // these on can still have it.
      const asked = childEnv(4321, 'token', { NSWR_TRUST_PROXY: '1' });
      assert.equal(asked.NSWR_TRUST_PROXY, '1', 'a scenario could not opt back in');
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
