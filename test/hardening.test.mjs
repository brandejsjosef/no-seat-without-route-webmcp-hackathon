/**
 * Regression tests for defects found by adversarially attacking a running
 * server. Each one is written from the reproduction that found it, so a fix
 * cannot be undone quietly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createDemoStore, DomainError } from '../lib/domain.mjs';
import { spawnOwnedServer, waitForOwnedServer, waitForOwnedServerGone, freePort } from './helpers/test-server.mjs';

const FULL = {
  wheelchairWidthCm: 72,
  maxDistanceM: 80,
  stepFree: true,
  companionCount: 1,
  entranceAssistance: true,
  lowStimulus: true,
};

function freshStore() {
  let counter = 0;
  return createDemoStore({
    clock: () => Date.parse('2026-08-29T20:00:00.000Z'),
    idFactory: () => `id-${++counter}`,
  });
}

test('an inherited property name is not a valid outage reason', () => {
  const store = freshStore();
  for (const hostile of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    assert.throws(
      () => store.setFacilityOutage('east-lift', hostile),
      (error) => error instanceof DomainError && error.code === 'INVALID_OUTAGE_REASON',
      `${hostile} should be refused`,
    );
  }
  // The venue must still be readable: the original defect wrote a function
  // into the store before the snapshot could reject it, bricking the demo.
  const state = store.snapshot();
  assert.equal(state.resources['east-lift'].status, 'OPERATIONAL');
  assert.equal(state.phase, 'READY');
});

test('an outage reason is required instead of silently defaulted', () => {
  const store = freshStore();
  assert.throws(
    () => store.setFacilityOutage('east-lift'),
    (error) => error instanceof DomainError && error.code === 'INVALID_OUTAGE_REASON',
  );
  const state = store.snapshot();
  assert.equal(state.resourceVersion, 1);
  assert.equal(state.resources['east-lift'].status, 'OPERATIONAL');
});

test('outage validation and arming stay strict after a lift is already down', () => {
  const store = freshStore();
  store.setFacilityOutage('east-lift', 'POWER_FAULT');
  const before = store.snapshot();

  assert.throws(
    () => store.setFacilityOutage('east-lift'),
    (error) => error instanceof DomainError && error.code === 'INVALID_OUTAGE_REASON',
  );
  assert.throws(
    () => store.armOutage('east-lift'),
    (error) => error instanceof DomainError && error.code === 'FACILITY_NOT_OPERATIONAL',
  );
  assert.deepEqual(store.snapshot(), before);
});

test('an invalid confirmation cannot trigger the armed venue fault', () => {
  const store = freshStore();
  const plan = store.findBundle(FULL);
  store.stageBundle(plan.id, plan.basedOnResourceVersion);
  store.armOutage('east-lift');
  const before = store.snapshot();

  assert.throws(
    () => store.commitBundle({
      planId: plan.id,
      confirmationId: 'not-a-confirmation',
      expectedResourceVersion: plan.basedOnResourceVersion,
      accepted: true,
      requestId: 'invalid-confirmation-must-not-mutate',
    }),
    (error) => error instanceof DomainError && error.code === 'INVALID_CONFIRMATION',
  );
  assert.deepEqual(store.snapshot(), before);
});

test('an inherited property name is not a plan, a confirmation or a booking', () => {
  const store = freshStore();
  for (const hostile of ['__proto__', 'constructor', 'toString']) {
    assert.throws(
      () => store.stageBundle(hostile, 1),
      (error) => error instanceof DomainError && error.code === 'PLAN_NOT_FOUND',
      `${hostile} should not resolve to a plan`,
    );
  }
});

test('the decision log stops growing so a snapshot cannot be inflated', () => {
  const store = freshStore();
  const plan = store.findBundle(FULL);
  store.stageBundle(plan.id, plan.basedOnResourceVersion);
  // This used to arm the same lift 400 times. Arming is idempotent now - a
  // pending fault is defended by the venue, and re-arming what is already armed
  // writes nothing - so that loop stopped producing audit entries and stopped
  // testing the cap. Clearing and re-finding a plan is real churn: each pass
  // writes two entries and leaves the venue where it started.
  for (let i = 0; i < 200; i += 1) {
    const current = store.snapshot().activePlan;
    store.clearPlan(current.id);
    const next = store.findBundle(FULL);
    store.stageBundle(next.id, next.basedOnResourceVersion);
  }

  const state = store.snapshot();
  assert.ok(state.audit.length <= 120, `audit grew to ${state.audit.length}`);
  // The sequence number keeps counting even though old entries are dropped.
  assert.ok(state.audit.at(-1).seq > 400, `last seq was ${state.audit.at(-1).seq}`);
  assert.ok(JSON.stringify(state).length < 120_000, 'snapshot should stay small');
});

test('a plan invalidated by an unrelated change can use its own route again', () => {
  const store = freshStore();
  const plan = store.findBundle(FULL);
  assert.equal(plan.routeId, 'east-lift-route');
  store.stageBundle(plan.id, plan.basedOnResourceVersion);

  const confirmation = store.prepareConfirmation(plan.id);

  // The venue disturbs the OTHER lift. Nothing this plan depends on changed,
  // but its revision is now behind.
  store.setFacilityOutage('garden-lift', 'POWER_FAULT');

  // A global venue revision binds every open plan. The stored state, public
  // stale flag and phase must agree immediately so the browser can expose the
  // explanation and replan tools instead of hiding confirmation in a dead end.
  const invalidated = store.snapshot();
  assert.equal(invalidated.phase, 'PLAN_STALE');
  assert.equal(invalidated.activePlan.status, 'STALE');
  assert.equal(invalidated.activePlan.stale, true);
  assert.equal(invalidated.atomicity.reservedResourceCount, 0);
  const immediateExplanation = store.explainRefusal();
  assert.equal(immediateExplanation.blocked, true);
  assert.deepEqual(immediateExplanation.brokenRules, []);
  assert.ok(immediateExplanation.validOptionsNow.some((option) => option.routeId === 'east-lift-route'));
  assert.equal(immediateExplanation.nextAction, 'REPLAN');

  // Confirming is still correctly refused: the plan was built against a
  // revision that has moved on.
  assert.throws(
    () => store.commitBundle({
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
      requestId: 'req-unrelated-change',
    }),
    (error) => error instanceof DomainError && error.code === 'STALE_RESOURCE_VERSION',
  );
  assert.equal(store.snapshot().atomicity.reservedResourceCount, 0);

  const explanation = store.explainRefusal();
  assert.equal(explanation.blocked, true);
  assert.ok(
    explanation.validOptionsNow.some((option) => option.routeId === 'east-lift-route'),
    'the still-feasible route must be offered, not filtered out',
  );
  assert.equal(explanation.nextAction, 'REPLAN');

  const replacement = store.replanBundle(plan.id);
  assert.equal(replacement.routeId, 'east-lift-route');

  // The read-only check and the planner must agree about that route.
  const check = store.checkAccessRoute('east-lift-route', FULL);
  assert.equal(check.feasible, true);
});

test('every external venue revision invalidates an open plan, even when it improves another route', () => {
  const restoredStore = freshStore();
  restoredStore.setFacilityOutage('garden-lift', 'POWER_FAULT');
  const planAfterOutage = restoredStore.findBundle(FULL);
  restoredStore.stageBundle(planAfterOutage.id, planAfterOutage.basedOnResourceVersion);
  restoredStore.restoreFacility('garden-lift');
  assert.equal(restoredStore.snapshot().phase, 'PLAN_STALE');

  const inventoryStore = freshStore();
  const eastPlan = inventoryStore.findBundle(FULL);
  inventoryStore.stageBundle(eastPlan.id, eastPlan.basedOnResourceVersion);
  inventoryStore.setResourceUnavailable('assist-garden-1903', 'HOST_UNAVAILABLE');
  const inventoryState = inventoryStore.snapshot();
  assert.equal(inventoryState.phase, 'PLAN_STALE');
  assert.equal(inventoryState.activePlan.routeId, 'east-lift-route');
  assert.equal(inventoryStore.checkAccessRoute('east-lift-route', FULL).feasible, true);
});

test('a venue repair reopens replanning after no alternative existed', () => {
  const store = freshStore();
  const plan = store.findBundle(FULL);
  store.stageBundle(plan.id, plan.basedOnResourceVersion);
  store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');
  store.setFacilityOutage('garden-lift', 'POWER_FAULT');

  assert.throws(
    () => store.replanBundle(plan.id),
    (error) => error instanceof DomainError && error.code === 'NO_COMPLETE_BUNDLE',
  );
  assert.equal(store.snapshot().phase, 'NO_ALTERNATIVE');

  store.restoreFacility('garden-lift');
  assert.equal(store.snapshot().phase, 'PLAN_STALE');
  assert.equal(store.explainRefusal().nextAction, 'REPLAN');

  const replacement = store.replanBundle(plan.id);
  assert.equal(replacement.routeId, 'garden-lift-route');
  assert.equal(store.snapshot().phase, 'REPLAN_READY');
});

test('preparing one staged plan repeatedly reuses one confirmation', () => {
  const store = freshStore();
  const plan = store.findBundle(FULL);
  store.stageBundle(plan.id, plan.basedOnResourceVersion);

  const first = store.prepareConfirmation(plan.id);
  for (let attempt = 0; attempt < 2_500; attempt += 1) {
    assert.deepEqual(store.prepareConfirmation(plan.id), first);
  }

  const preparedEntries = store.snapshot().audit.filter((entry) => entry.action === 'HUMAN_CONFIRMATION_PREPARED');
  assert.equal(preparedEntries.length, 1);
});

test('confirmations for superseded plans do not accumulate across replans', { concurrency: false }, () => {
  const nativeStructuredClone = globalThis.structuredClone;
  let maxConfirmationsSeen = 0;
  globalThis.structuredClone = (value, options) => {
    if (value?.confirmations && value?.plans) {
      maxConfirmationsSeen = Math.max(maxConfirmationsSeen, Object.keys(value.confirmations).length);
    }
    return nativeStructuredClone(value, options);
  };

  try {
    const store = freshStore();
    let plan = store.findBundle(FULL);
    plan = store.stageBundle(plan.id, plan.basedOnResourceVersion);

    for (let attempt = 0; attempt < 12; attempt += 1) {
      store.prepareConfirmation(plan.id);
      if (attempt % 2 === 0) store.setFacilityOutage('garden-lift', 'LIFT_DOOR_FAULT');
      else store.restoreFacility('garden-lift');
      plan = store.replanBundle(plan.id);
    }
  } finally {
    globalThis.structuredClone = nativeStructuredClone;
  }

  assert.equal(maxConfirmationsSeen, 1);
});

test('cleared and superseded plan objects do not accumulate', () => {
  const store = freshStore();
  let firstClearedId;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const plan = store.findBundle(FULL);
    firstClearedId ??= plan.id;
    store.clearPlan(plan.id);
  }
  assert.throws(
    () => store.stageBundle(firstClearedId, 1),
    (error) => error instanceof DomainError && error.code === 'PLAN_NOT_FOUND',
  );

  const original = store.findBundle(FULL);
  store.stageBundle(original.id, original.basedOnResourceVersion);
  store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');
  const replacement = store.replanBundle(original.id);
  assert.throws(
    () => store.stageBundle(original.id, original.basedOnResourceVersion),
    (error) => error instanceof DomainError && error.code === 'PLAN_NOT_FOUND',
  );
  store.clearPlan(replacement.id);
  assert.throws(
    () => store.stageBundle(replacement.id, replacement.basedOnResourceVersion),
    (error) => error instanceof DomainError && error.code === 'PLAN_NOT_FOUND',
  );
});

test('a rejected route is still excluded when it is the one that failed', () => {
  const store = freshStore();
  const plan = store.findBundle(FULL);
  store.stageBundle(plan.id, plan.basedOnResourceVersion);
  // This outage hits the lift the plan depends on, so the plan is invalidated
  // directly and its own route must not come back.
  store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');

  const replacement = store.replanBundle(plan.id);
  assert.equal(replacement.routeId, 'garden-lift-route');
});

/* ------------------------------------------------------------------ server */

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;

async function post(path, body, token) {
  return fetch(origin + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      ...(token ? { 'X-Demo-Session': token } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
  });
}

test('the server refuses hostile requests instead of failing open', async (t) => {
  // Launch and readiness both come from the shared helper. This scenario used a
  // port fixed in an outer scope and its own copy of the poll, whose child guard
  // was written as `typeof child !== "undefined"` - true only because a binding
  // of that name happened to exist, and false in the sibling copy below.
  const handle = spawnOwnedServer({ port });
  t.after(() => waitForOwnedServerGone(handle).catch(() => handle.child.kill('SIGKILL')));
  await waitForOwnedServer(handle);

  const session = (await (await post('/api/session', { role: 'visitor' })).json()).session;

  // A JSON null parses successfully and used to be dereferenced by handlers.
  assert.equal((await post('/api/access-options', 'null', session.token)).status, 400);
  assert.equal((await post('/api/session', 'null')).status, 400);

  // A malformed escape threw a URIError that reached the generic handler.
  assert.equal((await post('/api/plans/%/stage', {}, session.token)).status, 400);
  // The role check runs first, so an operator path needs an operator token to
  // reach the decoding at all.
  const operator = (await (await post('/api/session', { role: 'operator', demoId: session.demoId })).json()).session;
  assert.equal((await post('/api/operator/facilities/%E0%A4%A/outage', { reasonCode: 'POWER_FAULT' }, operator.token)).status, 400);

  const beforeMissingReason = await (await fetch(`${origin}/api/state`, { headers: { 'X-Demo-Session': session.token } })).json();
  const missingReason = await post('/api/operator/facilities/east-lift/outage', {}, operator.token);
  assert.equal(missingReason.status, 422);
  const afterMissingReason = await (await fetch(`${origin}/api/state`, { headers: { 'X-Demo-Session': session.token } })).json();
  assert.equal(afterMissingReason.state.resourceVersion, beforeMissingReason.state.resourceVersion);
  assert.equal(afterMissingReason.state.resources['east-lift'].status, 'OPERATIONAL');

  // Creating sessions mints demos, and minting demos evicts old ones.
  let refused = 0;
  for (let i = 0; i < 120; i += 1) {
    if ((await post('/api/session', { role: 'visitor' })).status === 429) refused += 1;
  }
  assert.ok(refused > 0, 'session creation should be rate limited');

  // The original session must still work after the flood.
  const after = await fetch(`${origin}/api/state`, { headers: { 'X-Demo-Session': session.token } });
  assert.equal(after.status, 200);
});

/* -------------------------------------------------- trusted client identity */


/** Each scenario gets its own process, so one scenario's buckets cannot leak into another. */
async function startServer(t, extraEnv = {}) {
  const handle = spawnOwnedServer({ port: await freePort(), extraEnv });
  t.after(() => waitForOwnedServerGone(handle).catch(() => handle.child.kill('SIGKILL')));
  await waitForOwnedServer(handle);
  return handle.origin;
}

const openSession = (serverOrigin, headers = {}) => fetch(`${serverOrigin}/api/session`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: serverOrigin, ...headers },
  body: JSON.stringify({ role: 'visitor' }),
});

/** 40 allowed then 20 refused: the shape one caller must see across 60 attempts. */
function histogram(statuses) {
  const counts = new Map();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  return counts;
}

const PROXY_SUFFIX = '70.41.3.18, 150.172.238.178';

test('a caller cannot mint limiter buckets by varying the forwarded header', async (t) => {
  // The leftmost X-Forwarded-For element is written by whoever sent the request.
  // Trusting it made "40 sessions per visitor" mean "40 per invented address",
  // which is no limit at all: 60 requests from one caller all returned 201.
  const serverOrigin = await startServer(t, { NSWR_TRUST_CF_CONNECTING_IP: '1' });

  const statuses = [];
  for (let i = 0; i < 60; i += 1) {
    const response = await openSession(serverOrigin, {
      'CF-Connecting-IP': '203.0.113.9',
      'X-Forwarded-For': `192.0.2.${(i % 250) + 1}, 203.0.113.9, ${PROXY_SUFFIX}`,
    });
    statuses.push(response.status);
  }

  const counts = histogram(statuses);
  assert.equal(counts.get(201), 40, `expected 40 accepted, saw ${[...counts]}`);
  assert.equal(counts.get(429), 20, `expected 20 refused, saw ${[...counts]}`);

  const firstRefusal = statuses.indexOf(429);
  assert.notEqual(firstRefusal, -1, 'the caller was never limited');
  assert.equal(
    statuses.slice(firstRefusal).filter((status) => status === 201).length,
    0,
    'a spoofed forwarded value re-opened the bucket after the limit was reached',
  );
});

test('one exhausted visitor does not lock out a genuinely different one', async (t) => {
  const serverOrigin = await startServer(t, { NSWR_TRUST_CF_CONNECTING_IP: '1' });

  for (let i = 0; i < 41; i += 1) {
    await openSession(serverOrigin, { 'CF-Connecting-IP': '203.0.113.9' });
  }
  const noisyAgain = await openSession(serverOrigin, { 'CF-Connecting-IP': '203.0.113.9' });
  assert.equal(noisyAgain.status, 429, 'the noisy visitor should still be limited');

  const bystander = await openSession(serverOrigin, { 'CF-Connecting-IP': '198.51.100.4' });
  assert.equal(bystander.status, 201, 'a second visitor behind the same proxy must still be served');

  const sixIsNotFour = await openSession(serverOrigin, { 'CF-Connecting-IP': '2001:db8::1' });
  assert.equal(sixIsNotFour.status, 201, 'a valid IPv6 caller is its own bucket');
});

test('the forwarded header alone is never a trusted identity', async (t) => {
  // Proxy trust is on, but the provider header is missing. The forwarded chain
  // must not be promoted to a bucket key just because it is the only thing left.
  const serverOrigin = await startServer(t, { NSWR_TRUST_CF_CONNECTING_IP: '1' });

  const statuses = [];
  for (let i = 0; i < 60; i += 1) {
    const response = await openSession(serverOrigin, {
      'X-Forwarded-For': `192.0.2.${(i % 250) + 1}, ${PROXY_SUFFIX}`,
    });
    statuses.push(response.status);
  }

  const counts = histogram(statuses);
  assert.equal(counts.get(201), 40, `expected 40 accepted, saw ${[...counts]}`);
  assert.equal(counts.get(429), 20, `expected 20 refused, saw ${[...counts]}`);
});

test('a malformed trusted header falls back instead of naming its own bucket', async (t) => {
  const serverOrigin = await startServer(t, { NSWR_TRUST_CF_CONNECTING_IP: '1' });

  // Each of these is either not an address or not a single address. None may
  // become a key, or the caller is choosing the bucket again.
  const rejected = [
    '',
    '   ',
    'not-an-ip',
    '198.51.100.4, 10.0.0.1',
    '2001:db8::zzzz',
    '999.999.999.999',
    '203.0.113.9:443',
  ];

  const statuses = [];
  for (let i = 0; i < 60; i += 1) {
    const response = await openSession(serverOrigin, {
      'CF-Connecting-IP': rejected[i % rejected.length],
    });
    statuses.push(response.status);
  }

  const counts = histogram(statuses);
  assert.equal(counts.get(201), 40, `malformed values created extra buckets: ${[...counts]}`);
  assert.equal(counts.get(429), 20, `malformed values created extra buckets: ${[...counts]}`);

  // A well-formed address is still honoured, so validation is not simply off.
  const valid = await openSession(serverOrigin, { 'CF-Connecting-IP': '198.51.100.77' });
  assert.equal(valid.status, 201);
});

test('the retired proxy variable cannot switch forwarded-header trust back on', async (t) => {
  // NSWR_TRUST_PROXY used to mean "trust the leftmost X-Forwarded-For element",
  // and render.yaml set it in production. Sixty requests from one caller then
  // returned sixty 201s, because the caller wrote that element itself. The name
  // is retired; setting it must do nothing at all.
  //
  // Scope: this covers that one variable and unconditional forwarded-header
  // trust. It cannot detect a differently named variable that has never been
  // written, so it is not a guarantee against every future spelling - the
  // sibling test above is what proves the forwarded chain is not promoted to an
  // identity when no trust is configured at all.
  const serverOrigin = await startServer(t, { NSWR_TRUST_PROXY: '1' });

  const statuses = [];
  for (let i = 0; i < 60; i += 1) {
    const response = await openSession(serverOrigin, {
      'X-Forwarded-For': `192.0.2.${(i % 250) + 1}, ${PROXY_SUFFIX}`,
    });
    statuses.push(response.status);
  }

  const counts = histogram(statuses);
  assert.equal(counts.get(201), 40, `the retired variable still enabled XFF trust: ${[...counts]}`);
  assert.equal(counts.get(429), 20, `the retired variable still enabled XFF trust: ${[...counts]}`);
});

test('without proxy trust configured the forwarded headers are ignored', async (t) => {
  const serverOrigin = await startServer(t);

  const statuses = [];
  for (let i = 0; i < 60; i += 1) {
    const response = await openSession(serverOrigin, {
      'CF-Connecting-IP': `203.0.113.${(i % 250) + 1}`,
      'X-Forwarded-For': `192.0.2.${(i % 250) + 1}, ${PROXY_SUFFIX}`,
    });
    statuses.push(response.status);
  }

  const counts = histogram(statuses);
  assert.equal(counts.get(201), 40, `direct mode honoured a proxy header: ${[...counts]}`);
  assert.equal(counts.get(429), 20, `direct mode honoured a proxy header: ${[...counts]}`);
});
