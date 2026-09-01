/**
 * Acceptance suite: the HTTP surface.
 *
 * Real defects were found by using the deployed app, and none of them failed a
 * test because no test looked. This file looks at the front door: every route in
 * server.mjs called with no session, an unknown session, the wrong role and a
 * valid one; with a missing, foreign and malformed Origin; with every method;
 * with bodies that are not objects and bodies on both sides of the 32 KB limit.
 *
 * Two properties are asserted on every single response, success or refusal:
 *   1. the exact HTTP status, and for JSON the exact error.code, and
 *   2. all six security headers with their documented values.
 * A refusal that quietly drops Origin-Agent-Cluster still refuses - and still
 * turns off document.modelContext for the whole origin.
 *
 * One server for the whole file, on a port the OS picks, killed in after().
 * No wall-clock assertions, no sleeps, no randomness: the one place a clock and
 * an id factory are needed (the domain cross-check) gets fixed ones.
 */

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createDemoStore, DomainError } from '../../lib/domain.mjs';
import { startTestServer } from '../helpers/test-server.mjs';

/* ------------------------------------------------------------------ fixtures */

const REPO = new URL('../../', import.meta.url);

/** The exact header set securityHeaders() promises. Values, not just presence. */
const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    + "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
  'origin-agent-cluster': '?1',
  'permissions-policy': 'tools=(self), camera=(), microphone=(), geolocation=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
});

/** Every static path the router knows, with the content type it promises. */
const STATIC_ROUTES = Object.freeze([
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/index.html', 'index.html', 'text/html; charset=utf-8'],
  ['/operator', 'operator.html', 'text/html; charset=utf-8'],
  ['/operator.html', 'operator.html', 'text/html; charset=utf-8'],
  ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/operator.js', 'operator.js', 'text/javascript; charset=utf-8'],
  ['/tools.mjs', 'tools.mjs', 'text/javascript; charset=utf-8'],
  ['/views.mjs', 'views.mjs', 'text/javascript; charset=utf-8'],
  ['/favicon.svg', 'favicon.svg', 'image/svg+xml'],
]);

/**
 * The list above is a copy, and a copy drifts. `/views.mjs` was served for days
 * without appearing here at all, so the one route carrying the page decisions
 * both surfaces share was covered by nothing - and the documentation said nine
 * routes while the server had ten.
 */
test('the routes checked here are exactly the routes the server serves', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../server.mjs', import.meta.url), 'utf8');
  const table = source.slice(source.indexOf('const staticFiles = new Map(['));
  const served = [...table.slice(0, table.indexOf(']);')).matchAll(/\['(\/[^']*)',/g)]
    .map(([, path]) => path)
    .sort();
  assert.deepEqual(
    STATIC_ROUTES.map(([path]) => path).sort(),
    served,
    'a static route is served without being checked here, or checked without being served',
  );
});

/**
 * Every route behind a session, with the role it demands. `null` means any role.
 * Path parameters are deliberately non-existent ids: these rows are only ever
 * called in ways that must be refused before the store is reached, so the id
 * never matters and the venue must come back byte-for-byte unchanged.
 */
const GUARDED_ROUTES = Object.freeze([
  ['GET', '/api/state', null],
  ['GET', '/api/explain', null],
  ['POST', '/api/access-options', null],
  ['POST', '/api/access-routes/east-lift-route/check', null],
  ['POST', '/api/demo/reset', null],
  ['POST', '/api/plans', 'visitor'],
  ['POST', '/api/plans/plan-nobody/stage', 'visitor'],
  ['POST', '/api/plans/plan-nobody/replan', 'visitor'],
  ['POST', '/api/plans/plan-nobody/clear', 'visitor'],
  ['POST', '/api/plans/plan-nobody/prepare-confirmation', 'visitor'],
  ['POST', '/api/plans/plan-nobody/commit', 'visitor'],
  ['POST', '/api/operator/facilities/east-lift/outage', 'operator'],
  ['POST', '/api/operator/facilities/east-lift/restore', 'operator'],
  ['POST', '/api/operator/facilities/east-lift/arm', 'operator'],
]);

const ALL_REQUIREMENTS = Object.freeze({
  wheelchairWidthCm: 72,
  maxDistanceM: 80,
  stepFree: true,
  companionCount: 1,
  entranceAssistance: true,
  lowStimulus: true,
});

/* -------------------------------------------------------------- the harness */

/** One server, one port, chosen by the OS so parallel agents cannot collide. */
const ctx = {
  port: 0,
  origin: '',
  child: null,
  agent: null,
  /** read-only venue: nothing in this file is allowed to mutate it */
  quiet: { visitor: null, operator: null },
  /** write venue: the end-to-end and operator tests own this one */
  live: { visitor: null, operator: null },
};


/**
 * node:http rather than fetch, on purpose. Undici normalises the request path
 * (so a traversal attempt never leaves the client) and guards forbidden header
 * names such as Origin and Sec-Fetch-Site. This suite has to send exactly the
 * bytes a hostile client would send.
 */
function raw(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const sent = { ...headers };
    if (body !== undefined) sent['Content-Length'] = Buffer.byteLength(body);
    const request = http.request(
      { host: '127.0.0.1', port: ctx.port, path, method, headers: sent, agent: ctx.agent },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          resolve({
            status: response.statusCode,
            headers: response.headers,
            buf,
            text,
            get body() { return JSON.parse(text); },
            get code() { return JSON.parse(text).error?.code ?? null; },
            where: `${method} ${path}`,
          });
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

const jsonHeaders = (token) => ({
  'Content-Type': 'application/json',
  Origin: ctx.origin,
  ...(token ? { 'X-Demo-Session': token } : {}),
});

const post = (path, body, token, extra = {}) => raw(path, {
  method: 'POST',
  headers: { ...jsonHeaders(token), ...extra },
  body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
});

const get = (path, token) => raw(path, { headers: token ? { 'X-Demo-Session': token } : {} });

async function openSession(role, demoId) {
  const response = await post('/api/session', demoId === undefined ? { role } : { role, demoId });
  assert.equal(response.status, 201, `could not open a ${role} session: ${response.text}`);
  return response.body.session;
}

const readState = async (token) => (await get('/api/state', token)).body.state;

/** Asserted on every response this file makes. Six headers, exact values. */
function assertSecurityHeaders(response, note = response.where) {
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(response.headers[header], value, `${note} lost or changed ${header}`);
  }
}

// The launch used to be written out here: allocate, build the child
// environment, spawn, poll. It is one shared implementation now, exercised
// against real impostor servers in test/helpers/test-server.self.test.mjs
// rather than trusted because the source reads correctly - a guard in this
// project once reported all clear against four ports it was looking at.
const cleanups = [];

before(async () => {
  ctx.agent = new http.Agent({ keepAlive: true, maxSockets: 8 });

  const handle = await startTestServer({ after: (cleanup) => cleanups.push(cleanup) });
  ctx.child = handle.child;
  ctx.port = handle.port;
  ctx.origin = handle.origin;
  ctx.token = handle.instanceToken;

  ctx.quiet.visitor = await openSession('visitor');
  ctx.quiet.operator = await openSession('operator', ctx.quiet.visitor.demoId);
  ctx.live.visitor = await openSession('visitor');
  ctx.live.operator = await openSession('operator', ctx.live.visitor.demoId);
});

after(async () => {
  ctx.agent?.destroy();
  for (const cleanup of cleanups.reverse()) await cleanup();
});

/* ------------------------------------------------------------------- health */

describe('the health endpoint', () => {
  test('a GET answers without any session and names the service', async () => {
    const response = await raw('/api/health');
    assert.equal(response.status, 200);
    // instanceToken is present only because this harness sets NSWR_INSTANCE_TOKEN
    // so readiness can prove it reached its own server rather than whoever else
    // held the port. server.mjs omits the field entirely when the variable is
    // unset, which is the production case. The suite used to delete the variable
    // to keep this assertion tidy, and paid for it with a readiness check that
    // could not tell our server from a stranger's.
    const { instanceToken, ...payload } = response.body;
    assert.deepEqual(payload, { ok: true, service: 'no-seat-without-route' });
    assert.equal(instanceToken, ctx.token, 'the health endpoint should echo the token this launch set');
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assertSecurityHeaders(response);
  });

  test('a HEAD on the health endpoint answers exactly as the GET does, without a body', async () => {
    // This recorded the defect: server.mjs teaches the static router that "HEAD
    // is GET without a body" precisely so an uptime monitor is not told the site
    // is missing - and then /api/health, the one URL a monitor actually probes,
    // was left out of that rule and answered 404.
    const head = await raw('/api/health', { method: 'HEAD' });
    const body = await raw('/api/health');

    assert.equal(body.status, 200, 'GET /api/health is the control for this test');
    assert.equal(head.status, body.status, 'a monitor probing HEAD is told the endpoint is missing');
    assert.equal(head.headers['content-type'], body.headers['content-type']);
    assertSecurityHeaders(head);
  });

  test('any other method on the health endpoint is a named JSON 404', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const response = await raw('/api/health', { method, headers: jsonHeaders() });
      assert.equal(response.status, 404, `${method} /api/health`);
      assert.equal(response.code, 'NOT_FOUND', `${method} /api/health`);
      assertSecurityHeaders(response);
    }
  });
});

/* ------------------------------------------------------- origin enforcement */

describe('same-origin enforcement on state-changing routes', () => {
  test('a write with no Origin header at all is refused as ORIGIN_REQUIRED', async () => {
    for (const [method, path] of GUARDED_ROUTES.filter(([verb]) => verb === 'POST')) {
      const response = await raw(path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Demo-Session': ctx.quiet.visitor.token },
        body: '{}',
      });
      assert.equal(response.status, 403, response.where);
      assert.equal(response.code, 'ORIGIN_REQUIRED', response.where);
      assertSecurityHeaders(response);
    }
  });

  test('a write from a foreign Origin is refused as CROSS_SITE_REQUEST_BLOCKED', async () => {
    for (const [method, path] of GUARDED_ROUTES.filter(([verb]) => verb === 'POST')) {
      const response = await raw(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://evil.example',
          'X-Demo-Session': ctx.quiet.visitor.token,
        },
        body: '{}',
      });
      assert.equal(response.status, 403, response.where);
      assert.equal(response.code, 'CROSS_SITE_REQUEST_BLOCKED', response.where);
      assertSecurityHeaders(response);
    }
  });

  test('an Origin that is not a URL is refused as INVALID_ORIGIN, not accepted and not a 500', async () => {
    // "null" is the literal value a browser sends from a sandboxed iframe or a
    // data: document; the others are what a hand-rolled client sends by mistake.
    // Every one of these makes `new URL(origin)` throw, which is the branch
    // under test: it used to escape as an unhandled URIError and a 500.
    for (const origin of ['not-a-url', 'null', 'http://', '://127.0.0.1', 'http:', 'https://[']) {
      const response = await post('/api/session', { role: 'visitor' }, undefined, { Origin: origin });
      assert.equal(response.status, 403, `Origin: ${JSON.stringify(origin)}`);
      assert.equal(response.code, 'INVALID_ORIGIN', `Origin: ${JSON.stringify(origin)}`);
      assertSecurityHeaders(response);
    }
  });

  test('a matching Origin is still refused when Sec-Fetch-Site says the request is cross-site', async () => {
    const response = await post('/api/session', { role: 'visitor' }, undefined, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(response.status, 403);
    assert.equal(response.code, 'CROSS_SITE_REQUEST_BLOCKED');
    assertSecurityHeaders(response);
  });

  test('same-origin and none are the only Sec-Fetch-Site values a write may carry', async () => {
    for (const value of ['same-origin', 'none']) {
      const accepted = await post('/api/session', { role: 'visitor' }, undefined, { 'Sec-Fetch-Site': value });
      assert.equal(accepted.status, 201, `Sec-Fetch-Site: ${value} should be accepted`);
      assertSecurityHeaders(accepted);
    }
    // same-site is a different subdomain of the same registrable domain, which
    // this single-origin app has no use for, so it is refused with cross-site.
    for (const value of ['same-site', 'SAME-ORIGIN', 'unknown-future-value']) {
      const refused = await post('/api/session', { role: 'visitor' }, undefined, { 'Sec-Fetch-Site': value });
      assert.equal(refused.status, 403, `Sec-Fetch-Site: ${value} should be refused`);
      assert.equal(refused.code, 'CROSS_SITE_REQUEST_BLOCKED', `Sec-Fetch-Site: ${value}`);
    }
  });

  test('a read is not subject to the origin check, so a link in an email still opens the venue', async () => {
    const response = await raw('/api/state', {
      headers: { Origin: 'https://evil.example', 'X-Demo-Session': ctx.quiet.visitor.token },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.state.phase, 'READY');
    assertSecurityHeaders(response);
  });
});

/* ---------------------------------------------------------- sessions, roles */

describe('session tokens and demo roles', () => {
  test('every guarded route refuses a request that carries no session token', async () => {
    const before = await readState(ctx.quiet.visitor.token);
    for (const [method, path] of GUARDED_ROUTES) {
      const response = method === 'GET'
        ? await raw(path)
        : await post(path, {});
      assert.equal(response.status, 401, response.where);
      assert.equal(response.code, 'SESSION_REQUIRED', response.where);
      assertSecurityHeaders(response);
    }
    assert.deepEqual(
      await readState(ctx.quiet.visitor.token),
      before,
      'a sweep of unauthenticated calls changed the venue',
    );
  });

  test('an unknown session token is refused exactly like no token at all', async () => {
    const before = await readState(ctx.quiet.visitor.token);
    const real = ctx.quiet.visitor.token;
    const impostors = [
      '',
      'not-a-token',
      // Map lookups, not object lookups: neither of these may resolve to a session.
      '__proto__',
      'constructor',
      '00000000-0000-4000-8000-000000000000',
      `${real}x`,
      real.slice(0, -1),
      real.toUpperCase(),
    ];
    for (const token of impostors) {
      const response = await raw('/api/state', { headers: { 'X-Demo-Session': token } });
      assert.equal(response.status, 401, `token ${JSON.stringify(token)}`);
      assert.equal(response.code, 'SESSION_REQUIRED', `token ${JSON.stringify(token)}`);
      assertSecurityHeaders(response);
    }
    // Two X-Demo-Session headers arrive joined by ", ", which matches no session.
    const doubled = await raw('/api/state', {
      headers: { 'X-Demo-Session': [ctx.quiet.visitor.token, ctx.quiet.visitor.token] },
    });
    assert.equal(doubled.status, 401, 'a repeated session header must not authenticate');
    assert.equal(doubled.code, 'SESSION_REQUIRED');
    assert.deepEqual(await readState(ctx.quiet.visitor.token), before, 'an impostor token changed the venue');
  });

  test('a visitor token cannot reach an operator route and an operator token cannot reach a visitor route', async () => {
    const before = await readState(ctx.quiet.visitor.token);
    for (const [method, path, role] of GUARDED_ROUTES) {
      if (!role) continue;
      const wrongToken = role === 'visitor' ? ctx.quiet.operator.token : ctx.quiet.visitor.token;
      const response = method === 'GET' ? await get(path, wrongToken) : await post(path, {}, wrongToken);
      assert.equal(response.status, 403, response.where);
      assert.equal(response.code, 'ROLE_FORBIDDEN', response.where);
      assert.match(response.body.error.message, new RegExp(role), `${response.where} should name the role it wants`);
      assertSecurityHeaders(response);
    }
    // A 403 says the request was refused. Only this says the venue was left alone:
    // a handler that mutated first and checked the role afterwards returns 403 too.
    assert.deepEqual(
      await readState(ctx.quiet.visitor.token),
      before,
      'a role refusal still changed the venue',
    );
  });

  test('an unknown role and a demo identifier that is not a UUID are refused before a venue is minted', async () => {
    const badRole = await post('/api/session', { role: 'admin' });
    assert.equal(badRole.status, 422);
    assert.equal(badRole.code, 'INVALID_ROLE');
    assertSecurityHeaders(badRole);

    const badDemo = await post('/api/session', { role: 'visitor', demoId: 'not-a-uuid' });
    assert.equal(badDemo.status, 422);
    assert.equal(badDemo.code, 'INVALID_DEMO_ID');
    assertSecurityHeaders(badDemo);
  });

  test('a shared demo link says whether the venue already existed and is matched case-insensitively', async () => {
    const shared = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const first = await openSession('visitor', shared.toUpperCase());
    assert.equal(first.demoId, shared, 'a demo identifier is stored in lower case');
    assert.equal(first.venueExisted, false, 'the first visitor through a fresh link mints the venue');

    const second = await openSession('operator', shared);
    assert.equal(second.demoId, shared, 'both roles must land on one venue');
    assert.equal(second.venueExisted, true, 'the second visitor must be told the venue was already there');
    assert.equal(second.role, 'operator');
  });
});

/* ------------------------------------------------------------ request bodies */

describe('request bodies', () => {
  test('a body that is not JSON at all is refused as INVALID_JSON', async () => {
    for (const body of ['{not json', '<html></html>', '{"unclosed": ', 'role=visitor']) {
      const response = await post('/api/session', body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.code, 'INVALID_JSON', JSON.stringify(body));
      assertSecurityHeaders(response);
    }
  });

  test('a JSON null, a JSON array and a bare JSON scalar are all refused as INVALID_JSON', async () => {
    // Each of these parses. Only the object check stops a handler dereferencing
    // them: body.role on null throws, and on an array it is silently undefined.
    for (const body of ['null', '[]', '[{"role":"visitor"}]', '"visitor"', '42', 'true']) {
      const response = await post('/api/session', body);
      assert.equal(response.status, 400, `body ${body}`);
      assert.equal(response.code, 'INVALID_JSON', `body ${body}`);
      assertSecurityHeaders(response);
    }
  });

  test('a body of exactly 32768 bytes is read and one byte more is refused as BODY_TOO_LARGE', async () => {
    const sized = (bytes) => {
      const empty = JSON.stringify({ role: 'visitor', filler: '' });
      return JSON.stringify({ role: 'visitor', filler: 'a'.repeat(bytes - empty.length) });
    };
    const under = sized(32_768);
    const over = sized(32_769);
    assert.equal(Buffer.byteLength(under), 32_768, 'the fixture must sit exactly on the limit');
    assert.equal(Buffer.byteLength(over), 32_769, 'the fixture must sit exactly one byte past it');

    const accepted = await post('/api/session', under);
    assert.equal(accepted.status, 201, 'a body on the limit is still read');
    assertSecurityHeaders(accepted);

    const refused = await post('/api/session', over);
    assert.equal(refused.status, 413);
    assert.equal(refused.code, 'BODY_TOO_LARGE');
    assertSecurityHeaders(refused);
  });

  test('an absent body is read as an empty object rather than crashing the handler', async () => {
    const noBody = await raw('/api/session', { method: 'POST', headers: jsonHeaders(), body: '' });
    assert.equal(noBody.status, 422, 'an empty body reaches role validation, so it parsed to {}');
    assert.equal(noBody.code, 'INVALID_ROLE');

    const readOnly = await raw('/api/access-options', {
      method: 'POST',
      headers: jsonHeaders(ctx.quiet.visitor.token),
      body: '',
    });
    assert.equal(readOnly.status, 200, 'an empty body on a read-only route falls back to the defaults');
    assert.equal(readOnly.body.evaluation.feasibleCount, 2);
    assertSecurityHeaders(readOnly);
  });

  test('a requirement the venue does not model is named rather than silently ignored', async () => {
    const response = await post(
      '/api/access-options',
      { requirements: { ...ALL_REQUIREMENTS, guideDog: true } },
      ctx.quiet.visitor.token,
    );
    assert.equal(response.status, 422);
    assert.equal(response.code, 'UNSUPPORTED_REQUIREMENT');
    assert.equal(response.body.error.key, 'guideDog', 'the refusal must say which key it rejected');
    assertSecurityHeaders(response);
  });
});

/* ----------------------------------------------------------- method routing */

describe('method routing', () => {
  test('a route answers only its own method and every other verb is a named JSON 404', async () => {
    const before = await readState(ctx.quiet.visitor.token);
    const verbs = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'];
    for (const [allowed, path] of GUARDED_ROUTES) {
      for (const method of verbs) {
        if (method === allowed) continue;
        const carriesBody = ['POST', 'PUT', 'DELETE'].includes(method);
        const response = await raw(path, {
          method,
          headers: jsonHeaders(ctx.quiet.visitor.token),
          body: carriesBody ? '{}' : undefined,
        });
        assert.equal(response.status, 404, response.where);
        if (method !== 'HEAD') {
          assert.equal(response.code, 'NOT_FOUND', response.where);
        }
        assertSecurityHeaders(response);
      }
    }
    assert.deepEqual(
      await readState(ctx.quiet.visitor.token),
      before,
      'a wrong-method sweep changed the venue',
    );
  });

  test('an API path nobody serves is a JSON 404 while an unknown page is a plain-text 404', async () => {
    const api = await raw('/api/does-not-exist');
    assert.equal(api.status, 404);
    assert.equal(api.code, 'NOT_FOUND');
    assert.equal(api.headers['content-type'], 'application/json; charset=utf-8');
    assertSecurityHeaders(api);

    const page = await raw('/does-not-exist');
    assert.equal(page.status, 404);
    assert.equal(page.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(page.text, 'Not found');
    assertSecurityHeaders(page);
  });
});

/* -------------------------------------------------------------- path pieces */

describe('path segments', () => {
  test('a malformed percent escape in a path is a named 400 rather than a 500', async () => {
    const cases = [
      ['/api/plans/%/stage', ctx.quiet.visitor.token],
      ['/api/plans/%zz/clear', ctx.quiet.visitor.token],
      ['/api/access-routes/%E0%A4%A/check', ctx.quiet.visitor.token],
      ['/api/operator/facilities/%/outage', ctx.quiet.operator.token],
    ];
    for (const [path, token] of cases) {
      const response = await post(path, {}, token);
      assert.equal(response.status, 400, path);
      assert.equal(response.code, 'INVALID_PATH', path);
      assertSecurityHeaders(response);
    }
  });

  test('an id nobody knows is a 404 that names what was not found, and the venue is untouched', async () => {
    const before = await readState(ctx.quiet.visitor.token);
    const expectations = [
      ['/api/access-routes/no-such-route/check', ctx.quiet.visitor.token, 'ROUTE_NOT_FOUND'],
      ['/api/plans/plan-nobody/stage', ctx.quiet.visitor.token, 'PLAN_NOT_FOUND'],
      ['/api/plans/plan-nobody/clear', ctx.quiet.visitor.token, 'PLAN_NOT_FOUND'],
      ['/api/plans/plan-nobody/prepare-confirmation', ctx.quiet.visitor.token, 'PLAN_NOT_FOUND'],
      ['/api/plans/plan-nobody/replan', ctx.quiet.visitor.token, 'PLAN_NOT_FOUND'],
      ['/api/operator/facilities/no-such-lift/outage', ctx.quiet.operator.token, 'FACILITY_NOT_FOUND'],
      ['/api/operator/facilities/no-such-lift/restore', ctx.quiet.operator.token, 'FACILITY_NOT_FOUND'],
      ['/api/operator/facilities/no-such-lift/arm', ctx.quiet.operator.token, 'FACILITY_NOT_FOUND'],
      // A wheelchair space is a resource but not a facility, so the operator
      // routes must not accept it just because the id resolves to something.
      ['/api/operator/facilities/space-w12/arm', ctx.quiet.operator.token, 'FACILITY_NOT_FOUND'],
    ];
    for (const [path, token, code] of expectations) {
      const response = await post(path, { reasonCode: 'POWER_FAULT' }, token);
      assert.equal(response.status, 404, path);
      assert.equal(response.code, code, path);
      assertSecurityHeaders(response);
    }
    assert.deepEqual(await readState(ctx.quiet.visitor.token), before, 'a 404 sweep changed the venue');
  });
});

/* ----------------------------------------------------------- static routing */

describe('the static router', () => {
  test('every static path serves its own file byte for byte with the content type it promises', async () => {
    for (const [path, filename, contentType] of STATIC_ROUTES) {
      const expected = await readFile(new URL(`public/${filename}`, REPO));
      const response = await raw(path);
      assert.equal(response.status, 200, `GET ${path}`);
      assert.equal(response.headers['content-type'], contentType, `GET ${path}`);
      assert.ok(response.buf.equals(expected), `GET ${path} did not serve public/${filename}`);
      assertSecurityHeaders(response, `GET ${path}`);
    }
  });

  test('a HEAD on each static path answers with the same status and headers as the GET', async () => {
    // Deliberately not asserted: that the HEAD carried no bytes. Node strips the
    // body of a HEAD response itself, so that assertion holds no matter what
    // server.mjs does and would only look like a test. What can actually break
    // is the pair below: answering HEAD with a 404 while GET says 200 is exactly
    // the regression that made the home page look dead to a link checker.
    for (const [path, , contentType] of STATIC_ROUTES) {
      const body = await raw(path);
      const head = await raw(path, { method: 'HEAD' });
      assert.equal(body.status, 200, `GET ${path} is the control for this test`);
      assert.ok(body.buf.length > 0, `GET ${path} served an empty file`);
      assert.equal(head.status, body.status, `HEAD ${path} must answer what the GET answers`);
      assert.equal(head.headers['content-type'], contentType, `HEAD ${path}`);
      for (const header of Object.keys(SECURITY_HEADERS)) {
        assert.equal(head.headers[header], body.headers[header], `HEAD ${path} differs from GET on ${header}`);
      }
      assertSecurityHeaders(head, `HEAD ${path}`);
    }
  });

  test('a write method on a static path is refused instead of falling through to a read', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await raw('/', {
        method,
        headers: { ...jsonHeaders(), 'Content-Type': 'text/plain' },
        body: 'x',
      });
      assert.equal(response.status, 404, `${method} /`);
      assert.equal(response.text, 'Not found', `${method} /`);
      assertSecurityHeaders(response, `${method} /`);
    }
  });

  test('a traversal attempt cannot reach a file outside public and leaks nothing about the tree', async () => {
    const attempts = [
      '/../server.mjs',
      '/./../server.mjs',
      '/%2e%2e/server.mjs',
      '/public/../server.mjs',
      '/../lib/domain.mjs',
      '/..%2fserver.mjs',
      '/../package.json',
      '/../.env',
      '/index.html/../../server.mjs',
    ];
    for (const path of attempts) {
      const response = await raw(path);
      assert.equal(response.status, 404, path);
      // Byte-for-byte the flat 404 body and nothing else. A weaker "does not
      // contain source" check would have been implied by this equality and so
      // could never have failed on its own.
      assert.equal(response.text, 'Not found', `${path} answered with something other than the flat 404 body`);
      assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8', path);
      assertSecurityHeaders(response, `GET ${path}`);
    }
  });
});

/* ------------------------------------------------------ the authorised path */

describe('a valid session on every route', () => {
  test('a visitor can plan, stage, review and confirm a complete bundle over HTTP', async () => {
    const token = ctx.live.visitor.token;

    const options = await post('/api/access-options', { requirements: ALL_REQUIREMENTS }, token);
    assert.equal(options.status, 200);
    assert.equal(options.body.evaluation.feasibleCount, 2, 'both routes are usable before anything breaks');

    const check = await post('/api/access-routes/east-lift-route/check', { requirements: ALL_REQUIREMENTS }, token);
    assert.equal(check.status, 200);
    assert.equal(check.body.evaluation.feasible, true);

    const explainQuiet = await get('/api/explain', token);
    assert.equal(explainQuiet.status, 200);
    assert.equal(explainQuiet.body.explanation.blocked, false, 'nothing is blocked yet, so there is no refusal');

    // Planning demands every requirement stated explicitly - the whole point of
    // the app is that no access need is filled in by a default nobody asked for.
    const vague = await post('/api/plans', { requirements: { stepFree: true } }, token);
    assert.equal(vague.status, 422);
    assert.equal(vague.code, 'MISSING_REQUIREMENTS');
    assert.ok(vague.body.error.missing.includes('wheelchairWidthCm'), 'the refusal must list what is missing');

    const planned = await post('/api/plans', { requirements: ALL_REQUIREMENTS }, token);
    assert.equal(planned.status, 201);
    assert.equal(planned.body.state.phase, 'PLAN_READY');
    const planId = planned.body.plan.id;
    const version = planned.body.state.resourceVersion;

    const staged = await post(`/api/plans/${planId}/stage`, { expectedResourceVersion: version }, token);
    assert.equal(staged.status, 200);
    assert.equal(staged.body.state.phase, 'AWAITING_HUMAN_CONFIRMATION');

    const prepared = await post(`/api/plans/${planId}/prepare-confirmation`, {}, token);
    assert.equal(prepared.status, 200);
    const confirmation = prepared.body.confirmation;

    const notAccepted = await post(`/api/plans/${planId}/commit`, {
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: false,
      requestId: 'uat-not-accepted',
    }, token);
    assert.equal(notAccepted.status, 428, 'a commit without an explicit human yes is refused');
    assert.equal(notAccepted.code, 'HUMAN_CONFIRMATION_REQUIRED');

    const noRequestId = await post(`/api/plans/${planId}/commit`, {
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
    }, token);
    assert.equal(noRequestId.status, 422);
    assert.equal(noRequestId.code, 'REQUEST_ID_REQUIRED');

    const command = {
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
      requestId: 'uat-commit-1',
    };
    const committed = await post(`/api/plans/${planId}/commit`, command, token);
    assert.equal(committed.status, 200);
    assert.equal(committed.body.state.phase, 'CONFIRMED');
    assert.equal(committed.body.state.booking.planId, planId);
    assert.equal(committed.body.state.atomicity.bookingCount, 1);
    assertSecurityHeaders(committed);

    // Replaying the same command with the same request id must not book twice.
    const replay = await post(`/api/plans/${planId}/commit`, command, token);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.result.idempotent, true, 'a replayed confirmation must be recognised, not re-run');
    assert.equal(replay.body.state.atomicity.bookingCount, 1, 'a replay booked the venue a second time');

    // The same request id with a different command is a conflict, not a silent
    // acceptance of whichever arrived second.
    const reused = await post(`/api/plans/${planId}/commit`, { ...command, accepted: false }, token);
    assert.equal(reused.status, 409);
    assert.equal(reused.code, 'IDEMPOTENCY_CONFLICT');

    const cleared = await post(`/api/plans/${planId}/clear`, {}, token);
    assert.equal(cleared.status, 409, 'a confirmed booking is not a plan that can be cleared away');
    assert.equal(cleared.code, 'PLAN_ALREADY_COMMITTED');
  });

  test('the operator routes work for both lifts, not only the east one', async () => {
    // The deployed operator page could only switch one of the two lifts. That
    // limit is not in the HTTP surface: every operator route accepts either
    // facility, so a regression here would mean the server grew the bug too.
    const token = ctx.live.operator.token;
    const reader = ctx.live.visitor.token;

    for (const facility of ['east-lift', 'garden-lift']) {
      const armed = await post(`/api/operator/facilities/${facility}/arm`, {}, token);
      assert.equal(armed.status, 200, `arm ${facility}`);
      assert.equal(armed.body.state.demo.pendingOutageResourceId, facility, `arm ${facility}`);
      assertSecurityHeaders(armed);

      const badReason = await post(`/api/operator/facilities/${facility}/outage`, { reasonCode: 'BECAUSE' }, token);
      assert.equal(badReason.status, 422, `outage ${facility} with an invented reason`);
      assert.equal(badReason.code, 'INVALID_OUTAGE_REASON');

      const missingReason = await post(`/api/operator/facilities/${facility}/outage`, {}, token);
      assert.equal(missingReason.status, 422, `outage ${facility} with no reason at all`);
      assert.equal(missingReason.code, 'INVALID_OUTAGE_REASON');

      const down = await post(`/api/operator/facilities/${facility}/outage`, { reasonCode: 'POWER_FAULT' }, token);
      assert.equal(down.status, 200, `outage ${facility}`);
      assert.equal(down.body.state.resources[facility].status, 'OUT_OF_SERVICE', `outage ${facility}`);

      const back = await post(`/api/operator/facilities/${facility}/restore`, {}, token);
      assert.equal(back.status, 200, `restore ${facility}`);
      assert.equal(back.body.state.resources[facility].status, 'OPERATIONAL', `restore ${facility}`);
    }

    // Both lifts back in service is what the visitor must be able to read.
    const seen = await readState(reader);
    assert.equal(seen.resources['east-lift'].status, 'OPERATIONAL');
    assert.equal(seen.resources['garden-lift'].status, 'OPERATIONAL');
  });

  test('a reset returns the venue to its opening state for either role', async () => {
    const token = ctx.live.visitor.token;
    const reset = await post('/api/demo/reset', {}, token);
    assert.equal(reset.status, 200);
    assert.equal(reset.body.state.phase, 'READY');
    assert.equal(reset.body.state.booking, null, 'a reset must clear the confirmed booking');
    assert.equal(reset.body.state.atomicity.reservedResourceCount, 0, 'a reset must release every held resource');
    assertSecurityHeaders(reset);

    const byOperator = await post('/api/demo/reset', {}, ctx.live.operator.token);
    assert.equal(byOperator.status, 200, 'reset is not role-restricted');
  });
});

/* ------------------------------------------------- the domain owns the codes */

describe('the HTTP status is the domain error, not a translation', () => {
  test('a refusal carries the domain code, status and details all the way to the client', async () => {
    // A fixed clock and a counting id factory: this store must behave the same
    // on every machine and every run.
    const store = createDemoStore({
      clock: () => Date.parse('2026-08-30T18:00:00.000Z'),
      idFactory: ((n) => () => `id-${(n += 1)}`)(0),
    });

    let thrown = null;
    try {
      store.checkAccessRoute('no-such-route', ALL_REQUIREMENTS);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof DomainError, 'the domain must refuse an unknown route');
    assert.equal(thrown.code, 'ROUTE_NOT_FOUND');
    assert.equal(thrown.status, 404);
    assert.deepEqual(thrown.details.knownRouteIds, ['east-lift-route', 'garden-lift-route']);

    const overHttp = await post(
      '/api/access-routes/no-such-route/check',
      { requirements: ALL_REQUIREMENTS },
      ctx.quiet.visitor.token,
    );
    assert.equal(overHttp.status, thrown.status, 'the HTTP status must be the domain status');
    assert.equal(overHttp.code, thrown.code, 'the HTTP error code must be the domain code');
    assert.equal(overHttp.body.error.message, thrown.message, 'the message must not be rewritten in transit');
    assert.deepEqual(
      overHttp.body.error.knownRouteIds,
      thrown.details.knownRouteIds,
      'the details that let a caller self-correct must survive the trip',
    );
    assertSecurityHeaders(overHttp);
  });

  test('every wrong way of calling this API is a named refusal, never a 5xx', async () => {
    // Every wrong way of calling this API that this file knows about, gathered in
    // one place. A 5xx here would mean an unhandled throw reached the top of the
    // request handler - but "not a 500" alone is a low bar that a 200 would also
    // clear, so each probe states the exact status and code it must come back
    // with. A HEAD and the plain-text 404 carry no JSON, so they name no code.
    const token = ctx.quiet.visitor.token;
    const probes = [
      ['GET /api/state without a token', await raw('/api/state'), 401, 'SESSION_REQUIRED'],
      // Answers as its GET does now, so an uptime monitor is not told the
      // one URL it probes is missing.
      ['HEAD /api/health', await raw('/api/health', { method: 'HEAD' }), 200, null],
      ['POST /api/session with a JSON null body', await post('/api/session', 'null'), 400, 'INVALID_JSON'],
      ['a plan id that is a lone percent sign', await post('/api/plans/%/stage', {}, token), 400, 'INVALID_PATH'],
      ['a wheelchair width that is a word',
        await post('/api/access-options', { requirements: { wheelchairWidthCm: 'wide' } }, token),
        422, 'INVALID_WHEELCHAIR_WIDTH'],
      ['four companions in a demo that models one',
        await post('/api/access-options', { requirements: { companionCount: 4 } }, token),
        422, 'INVALID_COMPANION_COUNT'],
      ['a boolean requirement sent as the string "yes"',
        await post('/api/access-options', { requirements: { stepFree: 'yes' } }, token),
        422, 'INVALID_REQUIREMENT_TYPE'],
      ['a negative maximum distance',
        await post('/api/access-options', { requirements: { maxDistanceM: -1 } }, token),
        422, 'INVALID_MAX_DISTANCE'],
      ['a traversal out of the public directory', await raw('/../server.mjs'), 404, null],
      ['OPTIONS on a POST-only route', await raw('/api/session', { method: 'OPTIONS', headers: jsonHeaders() }), 404, 'NOT_FOUND'],
    ];
    for (const [what, response, status, code] of probes) {
      assert.ok(response.status < 500, `${what} answered ${response.status}`);
      assert.equal(response.status, status, what);
      if (code !== null) assert.equal(response.code, code, what);
      assertSecurityHeaders(response, what);
    }
  });
});
