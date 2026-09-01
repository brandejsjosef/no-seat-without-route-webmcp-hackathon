/**
 * The third adversarial round, and the reason it is the most useful of the
 * three: it drove the repairs the second round had asked for and found that one
 * of them had never taken effect at all.
 *
 * A refusal was supposed to belong to the visitor who made it. The domain took
 * a `sessionKey`, the server passed `session.token`, and the test asserted the
 * behaviour by calling the domain directly with a key. Nobody checked that the
 * server had a token to pass: `createSession` stored `{ role, demoId, ... }`
 * and never the token itself, so every HTTP caller arrived as `undefined` and
 * landed in the same shared bucket the repair existed to remove. The fix was
 * one word; the lesson is that the test proved the layer that was already
 * right.
 *
 * So every test here goes over HTTP, through the real server, including the
 * ones whose logic lives in the domain.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomUUID } from 'node:crypto';

import { createDemoStore } from '../../lib/domain.mjs';
import { startTestServer } from '../helpers/test-server.mjs';

const IMPOSSIBLE = Object.freeze({
  wheelchairWidthCm: 95,
  maxDistanceM: 80,
  stepFree: true,
  companionCount: 1,
  entranceAssistance: true,
  lowStimulus: true,
});

const FULL = Object.freeze({
  wheelchairWidthCm: 72,
  maxDistanceM: 80,
  stepFree: true,
  companionCount: 1,
  entranceAssistance: true,
  lowStimulus: true,
});

/** The helper returns a Response; every assertion here wants the payload. */
const read = async (response) => ({ status: response.status, body: await response.json() });

const store = () => createDemoStore({
  clock: () => Date.parse('2026-09-01T09:00:00.000Z'),
  idFactory: ((n) => () => `id-${++n}`)(0),
});

describe('a refused search belongs to one visitor, over HTTP as well', () => {
  /** Two visitors and one operator, all on the same shared venue. */
  const crowd = async (t) => {
    const server = await startTestServer(t);
    const demoId = randomUUID();
    return {
      server,
      a: await server.session('visitor', demoId),
      b: await server.session('visitor', demoId),
      operator: await server.session('operator', demoId),
    };
  };

  test('two visitors on one venue are given tokens that differ', async (t) => {
    // The whole repair rests on the session being distinguishable, and nothing
    // checked it. This is the control: if the tokens were equal, every test
    // below would pass while proving nothing.
    const { a, b } = await crowd(t);
    assert.ok(a.token && b.token, 'a session was issued without a token');
    assert.notEqual(a.token, b.token, 'two visitors share one session token');
  });

  test('a second visitor is not told a call of theirs was rejected', async (t) => {
    const { server, a, b } = await crowd(t);
    const refused = await read(await server.request('/api/plans', {
      method: 'POST',
      body: { requirements: IMPOSSIBLE },
      sessionToken: a.token,
    }));
    assert.equal(refused.status, 422, 'this scenario no longer produces a refusal');

    const explained = await read(await server.request('/api/explain', { sessionToken: b.token }));
    assert.equal(
      explained.body.explanation.blocked,
      false,
      'a visitor who called nothing is told their own search was rejected',
    );
    assert.equal(explained.body.explanation.rejectedAction ?? null, null);
  });

  test("and is not handed the first visitor's access requirements", async (t) => {
    const { server, a, b } = await crowd(t);
    await server.request('/api/plans', {
      method: 'POST',
      body: { requirements: { ...IMPOSSIBLE, wheelchairWidthCm: 91 } },
      sessionToken: a.token,
    });
    const explained = await read(await server.request('/api/explain', { sessionToken: b.token }));
    assert.equal(
      explained.body.explanation.requirements ?? null,
      null,
      "one visitor's access requirements reached another over HTTP",
    );
  });

  test('an operator is not told a visitor tool of theirs was rejected', async (t) => {
    // The operator role is forbidden from calling find_access_bundle at all, so
    // being told that call of theirs was rejected is doubly wrong.
    const { server, a, operator } = await crowd(t);
    await server.request('/api/plans', {
      method: 'POST',
      body: { requirements: IMPOSSIBLE },
      sessionToken: a.token,
    });
    const explained = await read(await server.request('/api/explain', { sessionToken: operator.token }));
    assert.notEqual(
      explained.body.explanation.rejectedAction?.action,
      'FIND_ACCESS_BUNDLE',
      'the operator is told a visitor tool call of theirs was rejected',
    );
  });

  test('the visitor who was refused still gets their own explanation', async (t) => {
    // The positive control. Scoping must not mean losing it.
    const { server, a, operator } = await crowd(t);
    await server.post('/api/operator/facilities/east-lift/outage', { reasonCode: 'POWER_FAULT' }, operator.token);
    await server.post('/api/operator/facilities/garden-lift/outage', { reasonCode: 'POWER_FAULT' }, operator.token);
    await server.request('/api/plans', {
      method: 'POST',
      body: { requirements: FULL },
      sessionToken: a.token,
    });

    const explained = await read(await server.request('/api/explain', { sessionToken: a.token }));
    assert.equal(explained.body.explanation.blocked, true, 'the visitor lost their own explanation');
    assert.deepEqual(explained.body.explanation.requirements, FULL);
  });

  test("one visitor's successful search does not erase another's refusal", async (t) => {
    // The other half of the same bug: forgetRefusal(undefined) deleted whatever
    // the shared bucket held, so a stranger's success answered "nothing is
    // blocked" to a visitor who really was blocked.
    const { server, a, b, operator } = await crowd(t);
    await server.post('/api/operator/facilities/east-lift/outage', { reasonCode: 'POWER_FAULT' }, operator.token);
    await server.request('/api/plans', {
      method: 'POST',
      body: { requirements: { ...FULL, maxDistanceM: 70 } },
      sessionToken: a.token,
    });
    const refusedFirst = await read(await server.request('/api/explain', { sessionToken: a.token }));

    // B asks for something the venue can still serve.
    const served = await read(await server.request('/api/plans', {
      method: 'POST',
      body: { requirements: FULL },
      sessionToken: b.token,
    }));
    assert.equal(served.status, 201, "this control needs B's search to succeed");

    const refusedAfter = await read(await server.request('/api/explain', { sessionToken: a.token }));
    assert.equal(
      refusedAfter.body.explanation.blocked,
      refusedFirst.body.explanation.blocked,
      "another visitor's success changed what this visitor is told about their own refusal",
    );
  });
});

describe('a confirmed booking is not a partial reservation', () => {
  test('the venue really does hold three reserved resources after a booking', () => {
    // The control: the number the explanation reports is not zero by accident.
    const venue = store();
    const plan = venue.findBundle(FULL);
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    const confirmation = venue.prepareConfirmation(plan.id);
    venue.commitBundle({
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
      requestId: 'the-click',
    });
    const reserved = Object.values(venue.snapshot().resources).filter((r) => r.status === 'RESERVED');
    assert.equal(reserved.length, 3, 'a booking no longer reserves three resources');
  });

  test('and reports none of them as partially reserved', () => {
    // The setup matters, and my first version of it did not have one: with no
    // stored refusal for the session asking, explainRefusal answers
    // blocked:false and carries no partialReservations field at all, so the
    // assertion passed without reaching the code it was about. The mutation
    // matrix caught that - reverting the repair left this green. A second
    // visitor is refused FIRST, so there is a refusal to explain when the
    // booking lands.
    const other = 'a-visitor-who-was-refused';
    // README: "zero - the bundle commits as one write or not at all". The READY
    // branch of explainRefusal labelled the raw RESERVED count
    // partialReservations, so a completed atomic booking was reported as three
    // dangling reservations - the exact claim this product exists to disprove.
    const venue = store();
    try {
      venue.findBundle({ ...FULL, wheelchairWidthCm: 95 }, { sessionKey: other });
    } catch { /* expected: this is what gives that visitor something to explain */ }

    const plan = venue.findBundle(FULL, { sessionKey: 'the-visitor-who-booked' });
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    const confirmation = venue.prepareConfirmation(plan.id);
    venue.commitBundle({
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
      requestId: 'the-click',
    });

    // Three reserved resources is the atomicity proof, not a defect. The number
    // that must be zero is the PARTIAL one, and explainRefusal reported the
    // reserved count under that name.
    assert.equal(venue.snapshot().atomicity.reservedResourceCount, 3);

    const explanation = venue.explainRefusal({ sessionKey: other });
    assert.equal(explanation.blocked, true, 'this scenario no longer reaches the branch under test');
    assert.equal(
      Object.hasOwn(explanation, 'partialReservations'),
      true,
      'the field is absent, so asserting its value proves nothing',
    );
    assert.equal(
      explanation.partialReservations,
      0,
      'a committed booking is reported as partial reservations',
    );
  });

  test('a refusal with nothing reserved still reports zero', () => {
    const venue = store();
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    venue.setFacilityOutage('garden-lift', 'POWER_FAULT');
    try { venue.findBundle(FULL); } catch { /* expected */ }
    assert.equal(venue.explainRefusal().partialReservations, 0);
  });
});

describe('a route check says which requirements it was checked against', () => {
  test('the tool answers a call that states one requirement', async (t) => {
    // routeId is the only required property, so this is a legal call - and the
    // venue fills in five more limits the caller never stated. stepFree and
    // lowStimulus are unknowable from the result, because those checks are
    // emitted ok:true whether or not they were required.
    const server = await startTestServer(t);
    const visitor = await server.session('visitor');
    const answer = await read(await server.request('/api/access-routes/garden-lift-route/check', {
      method: 'POST',
      body: { requirements: {} },
      sessionToken: visitor.token,
    }));
    assert.equal(answer.status, 200);
    assert.ok(answer.body.evaluation.requirements, 'the endpoint stopped resolving the requirement set');
  });

  test('and the tool forwards that set, as its sibling does', async () => {
    const { createVisitorTools } = await import('../../public/tools.mjs');
    const venue = store();
    const tools = createVisitorTools({
      api: async (path, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : {};
        if (path === '/api/state') return { ok: true, state: venue.snapshot() };
        const match = path.match(/^\/api\/access-routes\/([^/]+)\/check$/);
        if (match) {
          return { ok: true, evaluation: venue.checkAccessRoute(decodeURIComponent(match[1]), body.requirements ?? {}) };
        }
        throw new Error(`Unrouted call: ${path}`);
      },
      refresh: async () => venue.snapshot(),
    });
    const answer = JSON.parse(await tools.find((tool) => tool.name === 'check_access_route')
      .execute({ routeId: 'garden-lift-route' }));

    assert.equal(answer.feasible !== undefined, true, 'the tool stopped answering');
    assert.equal(
      answer.requirements?.maxDistanceM,
      80,
      'a feasible verdict is returned without the limits it is feasible against',
    );
    assert.equal(answer.requirements?.stepFree, true, 'the unknowable requirements are still unknowable');
  });
});

describe('the restore tool describes what it does to an armed lift', () => {
  test('disarming changes venue state without moving the revision', () => {
    // The control for the sentence below.
    const venue = store();
    venue.armOutage('east-lift');
    const before = venue.snapshot().resourceVersion;
    venue.restoreFacility('east-lift');

    assert.equal(venue.snapshot().demo.pendingOutageResourceId, null, 'the fault was not cleared');
    assert.equal(venue.snapshot().resourceVersion, before, 'disarming moved the revision');
    assert.equal(venue.snapshot().audit.at(-1).action, 'OUTAGE_SIGNAL_CLEARED');
  });

  test('the description says so instead of promising nothing changed', async () => {
    // It said a lift "already in service and not armed for the demo fault is
    // left alone, and the revision does not move" - true - and nothing about
    // the armed case, which does change state without moving the revision. An
    // agent that disarms and assumes its cached plan went stale is wrong; one
    // that assumes nothing happened is also wrong.
    const { createOperatorTools } = await import('../../public/tools.mjs');
    const description = createOperatorTools({ api: async () => ({}), refresh: async () => ({}) })
      .find((tool) => tool.name === 'restore_facility').description;

    assert.match(description, /arm/i, 'the description never mentions the armed case');
    assert.match(
      description,
      /disarm|clears the (pending |armed )?fault|no longer armed/i,
      'the description does not say what happens to an armed lift',
    );
  });
});
