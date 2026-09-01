import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { spawnOwnedServer, waitForOwnedServer, waitForOwnedServerGone } from './helpers/test-server.mjs';


/**
 * A port the operating system says is free, asked for at run time.
 *
 * These files used to write their ports in: 43917, 43929, 43931 and so on. Two
 * copies of the repository, or two agents, then contended for the same numbers -
 * and the loser did not fail. The readiness poll below answered from whichever
 * server was listening, so a run could pass having inspected somebody else's
 * process. An independent audit measured this suite failing 1 run in 6 on
 * unchanged source.
 *
 * test/hardening.test.mjs already carried this fix, and a comment naming the
 * exact bug class, for itself alone.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: chosen } = probe.address();
      probe.close(() => resolve(chosen));
    });
  });
}

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
// One token per process. Readiness requires the server to echo it, so a
// stranger on this port is a different process rather than a slow start.
const instanceToken = randomUUID();


async function request(path, { method = 'GET', token, body, requestOrigin = origin } = {}) {
  const headers = {};
  if (method !== 'GET') {
    headers.Origin = requestOrigin;
    headers['Content-Type'] = 'application/json';
  }
  if (token) headers['X-Demo-Session'] = token;
  return fetch(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('HTTP API isolates demo sessions, roles and cross-site writes', async (t) => {
  // PORT wins over NSWR_PORT in server.mjs, because a managed host sets PORT and
  // that has to take precedence in production. It also means an inherited PORT
  // silently redirects a spawned test server: this test asked for 43917, the
  // build environment already had PORT set, the child bound that instead, and
  // the poll on 43917 never got an answer. It passed on every machine where
  // PORT happened to be unset. The other two spawns in this file already drop
  // it; this one did not.
  const handle = spawnOwnedServer({ port: port });
  const child = handle.child;
  t.after(() => waitForOwnedServerGone(handle).catch(() => handle.child.kill('SIGKILL')));
  await waitForOwnedServer(handle);

  const missingOrigin = await fetch(`${origin}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'visitor' }),
  });
  assert.equal(missingOrigin.status, 403);

  const evilOrigin = await request('/api/session', {
    method: 'POST',
    requestOrigin: 'https://evil.example',
    body: { role: 'visitor' },
  });
  assert.equal(evilOrigin.status, 403);

  const visitorResponse = await request('/api/session', { method: 'POST', body: { role: 'visitor' } });
  assert.equal(visitorResponse.status, 201);
  const visitor = (await visitorResponse.json()).session;

  const operatorResponse = await request('/api/session', {
    method: 'POST',
    body: { role: 'operator', demoId: visitor.demoId },
  });
  const operator = (await operatorResponse.json()).session;
  assert.equal(operator.demoId, visitor.demoId);

  // A 403 says the request was refused. It does not say the venue was left
  // alone: a handler that mutated first and checked the role afterwards would
  // return exactly the same status. Compare the authorised view of the whole
  // venue across the refusal instead of trusting the status code.
  const readState = async (token) => (await (await request('/api/state', { token })).json()).state;
  const beforeWrongRole = await readState(operator.token);
  const wrongRole = await request('/api/operator/facilities/east-lift/arm', {
    method: 'POST',
    token: visitor.token,
    body: {},
  });
  assert.equal(wrongRole.status, 403);
  assert.deepStrictEqual(
    await readState(operator.token),
    beforeWrongRole,
    'a visitor token was refused on an operator endpoint but the venue still changed',
  );

  const armed = await request('/api/operator/facilities/east-lift/arm', {
    method: 'POST',
    token: operator.token,
    body: {},
  });
  assert.equal(armed.status, 200);

  const visitorState = await request('/api/state', { token: visitor.token });
  assert.equal((await visitorState.json()).state.demo.pendingOutageResourceId, 'east-lift');

  const secondVisitorResponse = await request('/api/session', { method: 'POST', body: { role: 'visitor' } });
  const secondVisitor = (await secondVisitorResponse.json()).session;
  assert.notEqual(secondVisitor.demoId, visitor.demoId);
  const secondState = await request('/api/state', { token: secondVisitor.token });
  assert.equal((await secondState.json()).state.demo.pendingOutageResourceId, null);

  // /api/demo/reset is the most destructive route in the app. If the cross-site
  // guard ever ran after the reset rather than before it, the status would still
  // be 403 and every existing assertion here would still pass, while the armed
  // outage, both sessions and the whole venue quietly went back to their
  // starting values. The snapshot comparison is what makes that visible.
  const beforeCrossSite = await readState(visitor.token);
  const crossSiteReset = await request('/api/demo/reset', {
    method: 'POST',
    token: visitor.token,
    requestOrigin: 'https://evil.example',
    body: {},
  });
  assert.equal(crossSiteReset.status, 403);
  assert.deepStrictEqual(
    await readState(visitor.token),
    beforeCrossSite,
    'a cross-site reset was refused but the venue was reset anyway',
  );
});

/* ------------------------------------------------- refusals nothing reached */

const branchPort = await freePort();
const branchOrigin = `http://127.0.0.1:${branchPort}`;

test('the listed refusal branches are reachable, and each is named or the plain 404', async (t) => {
  const handle = spawnOwnedServer({ port: branchPort });
  const child = handle.child;
  t.after(() => waitForOwnedServerGone(handle).catch(() => handle.child.kill('SIGKILL')));
  await waitForOwnedServer(handle);

  // Every response this test produces is recorded, so the header assertion at
  // the end covers whatever refusals the test actually creates rather than the
  // three that happened to be named in a list. A copy is taken while the body
  // is still unread, because the assertions below consume the originals.
  const seen = [];
  const send = async (path, { method = 'POST', headers = {}, body = '{}', omitOrigin = false } = {}) => {
    const base = method === 'GET'
      ? {}
      : { 'Content-Type': 'application/json', ...(omitOrigin ? {} : { Origin: branchOrigin }) };
    const response = await fetch(branchOrigin + path, {
      method,
      headers: { ...base, ...headers },
      body: method === 'GET' ? undefined : body,
    });
    seen.push({ path, method, response, copy: response.clone() });
    return response;
  };
  const codeOf = async (response) => (await response.json()).error?.code;

  // A request with no session at all, on a read that never validates anything else.
  const noSession = await send('/api/state', { method: 'GET' });
  assert.equal(noSession.status, 401);
  assert.equal(await codeOf(noSession), 'SESSION_REQUIRED');

  const unknownToken = await send('/api/state', { method: 'GET', headers: { 'X-Demo-Session': 'not-a-token' } });
  assert.equal(unknownToken.status, 401);
  assert.equal(await codeOf(unknownToken), 'SESSION_REQUIRED');

  // No Origin header at all is its own branch, taken before anything is parsed.
  // It is the one a non-browser client hits first, and until now the only test
  // that reached it asserted the 403 without ever reading the code.
  const noOrigin = await send('/api/session', {
    omitOrigin: true,
    body: JSON.stringify({ role: 'visitor' }),
  });
  assert.equal(noOrigin.status, 403);
  assert.equal(await codeOf(noOrigin), 'ORIGIN_REQUIRED');

  // An Origin header that is not a URL at all takes a different branch from a
  // valid origin belonging to somebody else.
  const brokenOrigin = await send('/api/session', { headers: { Origin: 'not a url' }, body: JSON.stringify({ role: 'visitor' }) });
  assert.equal(brokenOrigin.status, 403);
  assert.equal(await codeOf(brokenOrigin), 'INVALID_ORIGIN');

  // A same-host Origin is not enough when the browser says the request came
  // from somewhere else.
  const crossFetchSite = await send('/api/session', {
    headers: { 'Sec-Fetch-Site': 'cross-site' },
    body: JSON.stringify({ role: 'visitor' }),
  });
  assert.equal(crossFetchSite.status, 403);
  assert.equal(await codeOf(crossFetchSite), 'CROSS_SITE_REQUEST_BLOCKED');

  const sameOriginFetchSite = await send('/api/session', {
    headers: { 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ role: 'visitor' }),
  });
  assert.equal(sameOriginFetchSite.status, 201);
  const session = (await sameOriginFetchSite.json()).session;

  // Body that is not JSON at all, as opposed to JSON that is not an object.
  const brokenJson = await send('/api/access-options', {
    headers: { 'X-Demo-Session': session.token },
    body: '{"requirements":',
  });
  assert.equal(brokenJson.status, 400);
  assert.equal(await codeOf(brokenJson), 'INVALID_JSON');

  // The 32 KB body ceiling, which nothing else in the suite approaches.
  const oversized = await send('/api/access-options', {
    headers: { 'X-Demo-Session': session.token },
    body: JSON.stringify({ padding: 'x'.repeat(40_000) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal(await codeOf(oversized), 'BODY_TOO_LARGE');

  // A body just under the ceiling still reaches the domain, so the guard is a
  // size limit rather than a blanket rejection of large-ish requests.
  const acceptedSize = await send('/api/access-options', {
    headers: { 'X-Demo-Session': session.token },
    body: JSON.stringify({ padding: 'x'.repeat(30_000) }),
  });
  assert.equal(acceptedSize.status, 422);
  assert.equal(await codeOf(acceptedSize), 'UNSUPPORTED_REQUIREMENT');

  for (const role of ['admin', '', 42, null]) {
    const badRole = await send('/api/session', { body: JSON.stringify({ role }) });
    assert.equal(badRole.status, 422, `role ${JSON.stringify(role)} should be refused`);
    assert.equal(await codeOf(badRole), 'INVALID_ROLE');
  }

  for (const demoId of ['not-a-uuid', '../etc/passwd', 12345, { toString: 'x' }]) {
    const badDemo = await send('/api/session', { body: JSON.stringify({ role: 'visitor', demoId }) });
    assert.equal(badDemo.status, 422, `demoId ${JSON.stringify(demoId)} should be refused`);
    assert.equal(await codeOf(badDemo), 'INVALID_DEMO_ID');
  }

  // A well-formed identifier in a different case is the same venue, not a
  // second one: a shared link must survive being retyped.
  const mixedCase = await send('/api/session', {
    body: JSON.stringify({ role: 'visitor', demoId: session.demoId.toUpperCase() }),
  });
  assert.equal(mixedCase.status, 201);
  assert.equal((await mixedCase.json()).session.demoId, session.demoId);

  // Unknown API routes and non-GET requests for static files are refused
  // rather than falling through to a handler that was not written for them.
  const unknownApi = await send('/api/does-not-exist', { headers: { 'X-Demo-Session': session.token } });
  assert.equal(unknownApi.status, 404);
  assert.equal(await codeOf(unknownApi), 'NOT_FOUND');

  const wrongMethodOnApi = await send('/api/state', {
    method: 'DELETE',
    headers: { 'X-Demo-Session': session.token },
  });
  assert.equal(wrongMethodOnApi.status, 404);
  assert.equal(await codeOf(wrongMethodOnApi), 'NOT_FOUND');

  const postedStaticFile = await send('/styles.css');
  assert.equal(postedStaticFile.status, 404);
  assert.equal(postedStaticFile.headers.get('content-type'), 'text/plain; charset=utf-8');

  const missingStaticFile = await send('/../server.mjs', { method: 'GET' });
  assert.equal(missingStaticFile.status, 404);

  // Every refusal this test produced, not the three that used to be listed by
  // hand. A new refusal branch that answered from somewhere other than
  // securityHeaders() would previously have gone unnoticed simply because
  // nobody added it to that list; now it has to opt out to be missed.
  //
  // "Every refusal this test produced" is not "every refusal branch in
  // server.mjs", and the name of this test no longer claims it is. Deliberately
  // outside the list below: ROLE_FORBIDDEN (API-01), DEMO_NOT_FOUND (no test
  // reaches it), TOO_MANY_SESSIONS (LIMIT-01 to LIMIT-06), INVALID_PATH and the
  // non-object JSON body (API-02), the Origin-host mismatch inside
  // CROSS_SITE_REQUEST_BLOCKED (API-01, by status only), and INTERNAL_ERROR,
  // which needs fault injection to reach at all.
  const refusals = seen.filter(({ response }) => response.status >= 400);
  assert.ok(refusals.length >= 15, `expected many refusal branches, recorded ${refusals.length}`);

  for (const { path, method, response } of refusals) {
    const where = `${method} ${path} -> ${response.status}`;
    assert.equal(response.headers.get('origin-agent-cluster'), '?1', `${where} lost origin isolation`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', `${where} lost nosniff`);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer', `${where} lost the referrer policy`);
    assert.equal(response.headers.get('cache-control'), 'no-store', `${where} lost no-store`);
    assert.ok(
      response.headers.get('permissions-policy')?.includes('tools=(self)'),
      `${where} lost the tools permissions policy`,
    );
    assert.ok(
      response.headers.get('content-security-policy')?.includes("default-src 'self'"),
      `${where} lost its CSP`,
    );
  }

  // Two different kinds of refusal, and only one of them is named. The matrix
  // used to claim every refusal carried a code; the static router answers with
  // plain text and no JSON body at all, so that was never true.
  const isJson = ({ response }) => (response.headers.get('content-type') ?? '').startsWith('application/json');
  const isPlain = ({ response }) => (response.headers.get('content-type') ?? '').startsWith('text/plain');
  const named = refusals.filter(isJson);
  const plain = refusals.filter(isPlain);
  assert.equal(named.length + plain.length, refusals.length, 'a refusal answered with a third content type');
  assert.ok(plain.length >= 2, 'the plain-text static refusals should still be exercised');

  for (const { path, method, copy } of named) {
    const body = await copy.json();
    assert.ok(
      typeof body?.error?.code === 'string' && body.error.code.length > 0,
      `${method} ${path} is a JSON refusal with no error code`,
    );
  }

  for (const { path, method, copy } of plain) {
    assert.equal((await copy.text()).trim(), 'Not found', `${method} ${path} should be the plain static refusal`);
  }
});

test('the WebMCP tool header is what marks an action as an agent action', async (t) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const handle = spawnOwnedServer({ port: port });
  const child = handle.child;
  t.after(() => waitForOwnedServerGone(handle).catch(() => handle.child.kill('SIGKILL')));
  await waitForOwnedServer(handle);

  const post = (path, body, token, toolName) => fetch(origin + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'X-Demo-Session': token,
      ...(toolName ? { 'X-WebMCP-Tool': toolName } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const audit = async (token) => (await (await fetch(`${origin}/api/state`, {
    headers: { 'X-Demo-Session': token },
  })).json()).state.audit;

  const requirements = {
    wheelchairWidthCm: 72,
    maxDistanceM: 80,
    stepFree: true,
    companionCount: 1,
    entranceAssistance: true,
    lowStimulus: true,
  };
  const visitor = (await (await post('/api/session', { role: 'visitor' })).json()).session;

  // The declared tool name is the one thing that distinguishes an agent call
  // from the same call made by the visible form. This is what the decision log
  // shows the visitor as "WebMCP · <tool>", so it is a claim about who acted.
  const agentPlan = (await (await post('/api/plans', { requirements }, visitor.token, 'find_access_bundle')).json()).plan;
  const created = (await audit(visitor.token)).at(-1);
  assert.equal(created.action, 'PLAN_CREATED');
  assert.equal(created.actor, 'webmcp-agent');
  assert.equal(created.toolName, 'find_access_bundle');

  // A header naming a different tool is not an endorsement of this one.
  await post(
    `/api/plans/${encodeURIComponent(agentPlan.id)}/stage`,
    { expectedResourceVersion: agentPlan.basedOnResourceVersion },
    visitor.token,
    'find_access_bundle',
  );
  const mismatched = (await audit(visitor.token)).at(-1);
  assert.equal(mismatched.action, 'PLAN_STAGED');
  assert.equal(mismatched.actor, 'human-ui');
  assert.equal(mismatched.toolName, null);

  // The same endpoint without the header is the visible form, and says so.
  await post(`/api/plans/${encodeURIComponent(agentPlan.id)}/clear`, {}, visitor.token);
  const cleared = (await audit(visitor.token)).at(-1);
  assert.equal(cleared.action, 'PLAN_CLEARED');
  assert.equal(cleared.actor, 'human-ui');
  assert.equal(cleared.toolName, null);

  // And with it, the same endpoint is attributed to the agent's own tool.
  const secondPlan = (await (await post('/api/plans', { requirements }, visitor.token, 'find_access_bundle')).json()).plan;
  await post(
    `/api/plans/${encodeURIComponent(secondPlan.id)}/stage`,
    { expectedResourceVersion: secondPlan.basedOnResourceVersion },
    visitor.token,
    'stage_access_bundle',
  );
  const staged = (await audit(visitor.token)).at(-1);
  assert.equal(staged.action, 'PLAN_STAGED');
  assert.equal(staged.actor, 'webmcp-agent');
  assert.equal(staged.toolName, 'stage_access_bundle');
});


test('HEAD answers a static route the way GET does, without a body', async (t) => {
  // HEAD used to fall through to the 404 branch, so anything that probes a site
  // that way - a link checker, an uptime monitor, `curl -I` before opening it -
  // saw the home page as missing while a browser loaded it fine.
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const handle = spawnOwnedServer({ port: port });
  const child = handle.child;
  t.after(() => waitForOwnedServerGone(handle).catch(() => handle.child.kill('SIGKILL')));
  await waitForOwnedServer(handle);

  // Every path the static router serves, not a sample of them. The matrix used
  // to say "every static route" while the test checked five of the nine.
  const staticRoutes = [
    '/', '/index.html', '/operator', '/operator.html', '/styles.css',
    '/app.js', '/operator.js', '/tools.mjs', '/favicon.svg',
  ];
  // A 404 carries a different set, so a HEAD that fell through to it would look
  // superficially fine while losing exactly the headers WebMCP depends on.
  const mustMatch = [
    'cache-control', 'content-security-policy', 'origin-agent-cluster',
    'permissions-policy', 'referrer-policy', 'x-content-type-options',
  ];

  for (const route of staticRoutes) {
    const head = await fetch(origin + route, { method: 'HEAD' });
    const get = await fetch(origin + route);
    assert.equal(head.status, 200, `HEAD ${route} should answer like GET`);
    assert.equal(head.status, get.status, `HEAD and GET disagree on ${route}`);
    assert.equal(
      head.headers.get('content-type'),
      get.headers.get('content-type'),
      `HEAD ${route} should carry the same content type`,
    );
    for (const header of mustMatch) {
      assert.equal(
        head.headers.get(header),
        get.headers.get(header),
        `HEAD ${route} disagrees with GET on ${header}`,
      );
    }
    assert.equal(head.headers.get('origin-agent-cluster'), '?1', `HEAD ${route} lost origin isolation`);
    assert.equal((await head.text()).length, 0, `HEAD ${route} must not send a body`);
    await get.text();
  }

  // A route that does not exist is still a 404, and a write method is still refused.
  const missing = await fetch(`${origin}/nope`, { method: 'HEAD' });
  assert.equal(missing.status, 404, 'HEAD on an unknown path should still be 404');
  const written = await fetch(`${origin}/`, { method: 'PUT' });
  assert.equal(written.status, 404, 'a write method on a static route is still refused');
});


test('a second visitor session on the same venue can confirm the first one\u2019s plan', async (t) => {
  // This is what the receipt is not allowed to claim away: a plan belongs to the
  // venue, not to the session that created it, so a second session can commit it.
  //
  // Scope, precisely. This is a direct HTTP test. Session B is created by posting
  // the same demoId to /api/session - it never opens a page, parses a ?demo=
  // query string or navigates anywhere. What it proves is cross-session behaviour
  // inside one shared venue store. That a browser reaches that store by following
  // a ?demo= link is the product's design and is covered elsewhere; it is not
  // asserted here.
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const handle = spawnOwnedServer({ port: port });
  const child = handle.child;
  t.after(() => waitForOwnedServerGone(handle).catch(() => handle.child.kill('SIGKILL')));
  await waitForOwnedServer(handle);

  const send = (path, body, token) => fetch(origin + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      ...(token ? { 'X-Demo-Session': token } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const read = (path, token) => fetch(origin + path, {
    headers: { Origin: origin, 'X-Demo-Session': token },
  });

  const a = await (await send('/api/session', { role: 'visitor' })).json();
  const b = await (await send('/api/session', { role: 'visitor', demoId: a.session.demoId })).json();
  assert.equal(b.session.demoId, a.session.demoId, 'both sessions should attach to the same venue store');
  assert.notEqual(b.session.token, a.session.token, 'the two sessions should be distinct');

  const requirements = {
    wheelchairWidthCm: 72, maxDistanceM: 80, stepFree: true,
    companionCount: 1, entranceAssistance: true, lowStimulus: true,
  };
  const created = await (await send('/api/plans', { requirements }, a.session.token)).json();
  const planId = created.plan.id;
  const beforeStage = await (await read('/api/state', a.session.token)).json();
  const staged = await send(`/api/plans/${planId}/stage`,
    { expectedResourceVersion: beforeStage.state.resourceVersion }, a.session.token);
  assert.equal(staged.status, 200, 'session A should be able to stage its own plan');

  // Session B has issued no POST /api/plans of its own - the only plan on this
  // venue is A's. It obtains a confirmation for it and commits it.
  const prepared = await send(`/api/plans/${planId}/prepare-confirmation`, {}, b.session.token);
  assert.equal(prepared.status, 200, 'the venue, not the session, owns the plan');
  const confirmation = (await prepared.json()).confirmation;

  const committed = await send(`/api/plans/${planId}/commit`, {
    confirmationId: confirmation.confirmationId,
    expectedResourceVersion: confirmation.expectedResourceVersion,
    accepted: true,
    requestId: 'two-session-regression',
  }, b.session.token);
  assert.equal(committed.status, 200, 'session B should be able to commit the shared plan');

  // Session A sees exactly one booking, which it never confirmed.
  const seenByA = await (await read('/api/state', a.session.token)).json();
  // The domain calls it receipt; only the tool surface renames it to reference.
  assert.ok(seenByA.state.booking?.receipt, 'session A should see the booking session B made');
  assert.equal(seenByA.state.booking.partialReservations, 0, 'a shared confirmation is still atomic');
  assert.equal(seenByA.state.atomicity.bookingCount, 1, 'exactly one booking should exist');

  const second = await send('/api/plans', { requirements }, a.session.token);
  assert.equal(second.status, 409, 'exactly one booking should exist on the venue');
});
