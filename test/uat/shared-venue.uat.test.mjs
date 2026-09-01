/**
 * Acceptance suite: two sessions on one venue, and role isolation.
 *
 * A demo link is a shared thing. Two people open the same `?demo=` identifier -
 * a visitor and the person running the venue, or a visitor and the friend
 * booking for them - and they have to be looking at one venue, not two private
 * copies of it that agree by coincidence. The same link also has to keep the
 * two roles apart: the visitor cannot take a lift out of service, and the
 * operator cannot book a seat.
 *
 * "Refused" is not the same claim as "unchanged". A handler that mutated the
 * venue and checked the role afterwards returns exactly the same 403 as one that
 * checked first. Every refusal here is therefore measured by reading the whole
 * venue through an authorised session before and after, and comparing the two
 * responses byte for byte.
 *
 * One server, one OS-allocated port, shared by every HTTP test in this file.
 * The two domain tests at the end need no server at all and run on an injected
 * clock and a counting id factory, so they assert exact values rather than
 * shapes.
 *
 * Budget for anyone extending this file: opening a demo session is rate limited
 * to 40 per minute per caller address, and every refused `demoId` below still
 * spends one. This file spends 27 of the 40 and finishes in about a second, so
 * roughly a dozen more session openings fit before the suite starts failing
 * with 429s that have nothing to do with the behaviour under test.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDemoStore } from '../../lib/domain.mjs';
import { startTestServer } from '../helpers/test-server.mjs';

/** Every requirement, stated explicitly. Booking a bundle refuses anything less. */
const FULL_REQUIREMENTS = Object.freeze({
  wheelchairWidthCm: 72,
  maxDistanceM: 80,
  stepFree: true,
  companionCount: 1,
  entranceAssistance: true,
  lowStimulus: true,
});

let base = null;
let child = null;

// The launch used to be written out here: allocate a port, build a child
// environment, spawn, poll. Every suite that spawned a server carried its own
// copy of those decisions, and the copies drifted - which is how a readiness
// poll that never checked its own child shipped in one of them. There is one
// implementation now, and test/helpers/test-server.self.test.mjs proves it
// against real impostor servers rather than by being read.
const cleanups = [];

before(async () => {
  const handle = await startTestServer({ after: (cleanup) => cleanups.push(cleanup) });
  child = handle.child;
  base = handle.origin;
});

after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function request(path, {
  method = 'GET',
  token = null,
  tool = null,
  body,
  origin = 'self',
  fetchSite = null,
} = {}) {
  const headers = {};
  const writes = method !== 'GET' && method !== 'HEAD';
  if (writes) {
    headers['Content-Type'] = 'application/json';
    if (origin !== null) headers.Origin = origin === 'self' ? base : origin;
  }
  if (token) headers['X-Demo-Session'] = token;
  if (tool) headers['X-WebMCP-Tool'] = tool;
  if (fetchSite) headers['Sec-Fetch-Site'] = fetchSite;
  return fetch(base + path, {
    method,
    headers,
    body: writes ? JSON.stringify(body ?? {}) : undefined,
  });
}

const post = (path, options = {}) => request(path, { ...options, method: 'POST' });

async function errorCode(response) {
  return (await response.json()).error?.code;
}

async function openSession(role, demoId) {
  const response = await post('/api/session', {
    body: demoId === undefined ? { role } : { role, demoId },
  });
  assert.equal(response.status, 201, `opening a ${role} session should succeed`);
  return (await response.json()).session;
}

/** The whole venue as an authorised session sees it, kept as raw bytes. */
async function venueBytes(token) {
  const response = await request('/api/state', { token });
  assert.equal(response.status, 200, 'reading the venue should succeed');
  return response.text();
}

async function venue(token) {
  return JSON.parse(await venueBytes(token)).state;
}

/**
 * The point of the whole file. deepStrictEqual reports *what* moved, so it runs
 * first and gives a readable diff; the raw string comparison is the actual
 * claim, because it also catches a key that was reordered, added as undefined
 * or serialised differently.
 */
function assertVenueUntouched(beforeBytes, afterBytes, why) {
  assert.deepStrictEqual(JSON.parse(afterBytes), JSON.parse(beforeBytes), why);
  assert.equal(afterBytes, beforeBytes, `${why} (byte-for-byte)`);
}

async function planFor(token, { tool = null } = {}) {
  const response = await post('/api/plans', { token, tool, body: { requirements: FULL_REQUIREMENTS } });
  assert.equal(response.status, 201, 'a complete set of requirements should produce a plan');
  return (await response.json()).plan;
}

describe('one venue, two sessions', () => {
  test('two visitor sessions that name the same venue share it, and a stranger gets their own', async () => {
    const a = await openSession('visitor');
    const b = await openSession('visitor', a.demoId);
    const stranger = await openSession('visitor');

    assert.equal(b.demoId, a.demoId, 'naming a venue should attach to it, not fork it');
    assert.notEqual(b.token, a.token, 'the two sessions must be separate sessions');
    // The venue identifier travels in a URL people paste to each other. A token
    // derived from it would turn a shared link into the operator's credentials.
    for (const session of [a, b]) {
      assert.notEqual(session.token, session.demoId, 'a shared link must not double as a session token');
    }
    assert.equal(b.venueExisted, true, 'the second session joined a venue that already existed');
    assert.notEqual(stranger.demoId, a.demoId, 'a session that names no venue should get a fresh one');
    assert.equal(stranger.venueExisted, false, 'a freshly minted venue cannot have existed already');

    assertVenueUntouched(
      await venueBytes(a.token),
      await venueBytes(b.token),
      'two sessions on one venue should be reading one venue',
    );

    // A change made through A has to show up in B's own read, otherwise the two
    // sessions merely started from the same defaults.
    const plan = await planFor(a.token);
    const seenByB = await venue(b.token);
    assert.equal(seenByB.activePlan?.id, plan.id, 'B should see the plan A just created');
    assert.equal(seenByB.phase, 'PLAN_READY');

    const seenByStranger = await venue(stranger.token);
    assert.equal(seenByStranger.activePlan, null, 'a different venue must not inherit this plan');
    assert.equal(seenByStranger.phase, 'READY');
  });

  test('a plan created by one visitor session is staged, confirmed and read by the other', async () => {
    const a = await openSession('visitor');
    const b = await openSession('visitor', a.demoId);

    const plan = await planFor(a.token);
    assert.equal(plan.status, 'PROPOSED');

    // B never posted a plan of its own. The plan belongs to the venue.
    const staged = await post(`/api/plans/${encodeURIComponent(plan.id)}/stage`, {
      token: b.token,
      body: { expectedResourceVersion: plan.basedOnResourceVersion },
    });
    assert.equal(staged.status, 200, 'the venue owns the plan, not the session that made it');
    assert.equal((await staged.json()).plan.status, 'STAGED');

    const prepared = await post(`/api/plans/${encodeURIComponent(plan.id)}/prepare-confirmation`, { token: b.token });
    assert.equal(prepared.status, 200);
    const confirmation = (await prepared.json()).confirmation;
    assert.equal(confirmation.planId, plan.id);

    const committed = await post(`/api/plans/${encodeURIComponent(plan.id)}/commit`, {
      token: b.token,
      body: {
        confirmationId: confirmation.confirmationId,
        expectedResourceVersion: confirmation.expectedResourceVersion,
        accepted: true,
        requestId: 'uat-shared-venue-commit',
      },
    });
    assert.equal(committed.status, 200, 'the second session should be able to confirm the shared plan');
    const booking = (await committed.json()).result.booking;
    // The exact receipt, not its shape. Three ledger entries preceded this
    // booking and the receipt is that count plus the demo's fixed offset; a
    // regex over five digits would accept whatever number the venue reached.
    assert.equal(booking.receipt, 'NSWR-00244', 'the receipt counts this venue’s own ledger');

    // A confirmed nothing, and still holds the booking B made.
    const seenByA = await venue(a.token);
    assert.equal(seenByA.phase, 'CONFIRMED');
    assert.equal(seenByA.booking?.id, booking.id, 'A should see the booking B confirmed');
    assert.equal(seenByA.booking.partialReservations, 0, 'a shared confirmation is still all-or-nothing');
    assert.equal(seenByA.atomicity.bookingCount, 1, 'one venue means one booking, not one per session');
    assert.equal(seenByA.atomicity.reservedResourceCount, 3, 'space, companion seat and assistance were taken together');

    assertVenueUntouched(
      await venueBytes(a.token),
      await venueBytes(b.token),
      'both sessions should read the same confirmed venue',
    );

    const second = await post('/api/plans', { token: a.token, body: { requirements: FULL_REQUIREMENTS } });
    assert.equal(second.status, 409, 'the venue already has a booking, whoever made it');
    assert.equal(await errorCode(second), 'BOOKING_ALREADY_EXISTS');
  });

  test('a venue identifier retyped in capitals reaches the same venue', async () => {
    const a = await openSession('visitor');
    const shouted = await openSession('operator', a.demoId.toUpperCase());

    assert.equal(shouted.demoId, a.demoId, 'a shared link must survive being retyped in a different case');
    assert.equal(shouted.venueExisted, true, 'the capitalised identifier is not a second venue');

    // Same venue, proved by a change rather than by matching identifiers.
    const armed = await post('/api/operator/facilities/east-lift/arm', { token: shouted.token });
    assert.equal(armed.status, 200);
    const seenByA = await venue(a.token);
    assert.equal(seenByA.demo.pendingOutageResourceId, 'east-lift');
  });

  test('a session naming a venue this process has never seen gets a new one and is told so', async () => {
    // Used nowhere else in this file, so the first request for it is genuinely
    // the first this server has heard of it.
    const unseen = '3f2f0b6c-9d41-4c0e-8f1a-1c2d3e4f5a6b';

    const first = await openSession('visitor', unseen);
    assert.equal(first.demoId, unseen);
    assert.equal(
      first.venueExisted,
      false,
      'a caller that named a venue and got a rebuilt empty one must be able to tell',
    );

    const fresh = await venue(first.token);
    assert.equal(fresh.phase, 'READY');
    assert.equal(fresh.resourceVersion, 1, 'a rebuilt venue starts at revision 1');
    assert.equal(fresh.activePlan, null);
    assert.equal(fresh.booking, null);
    assert.deepStrictEqual(fresh.audit, [], 'a new venue has nothing in its ledger yet');
    assert.equal(fresh.resources['east-lift'].status, 'OPERATIONAL');
    assert.equal(fresh.resources['space-w12'].status, 'AVAILABLE');

    const second = await openSession('operator', unseen);
    assert.equal(second.venueExisted, true, 'the venue exists now, so the second caller is told so');
    assert.equal(second.demoId, unseen);
  });

  // Named for what it checks: a venue minted behind a refusal would be
  // unreachable and therefore unobservable, but a caller handed a usable
  // session for a nonsense identifier is exactly the silent split to catch.
  test('a malformed venue identifier is refused by name and hands back no session', async () => {
    const malformed = [
      'not-a-uuid',
      '../../etc/passwd',
      '3f2f0b6c-9d41-4c0e-8f1a-1c2d3e4f5a6z',
      '3f2f0b6c9d414c0e8f1a1c2d3e4f5a6b',
      12345,
      { toString: 'x' },
    ];

    for (const demoId of malformed) {
      const response = await post('/api/session', { body: { role: 'visitor', demoId } });
      const named = JSON.stringify(demoId);
      assert.equal(response.status, 422, `demoId ${named} should be refused`);
      const payload = await response.json();
      assert.equal(payload.error?.code, 'INVALID_DEMO_ID', `demoId ${named} should be refused by name`);
      assert.equal(payload.ok, false);
      assert.equal(payload.session, undefined, `demoId ${named} must not hand back a session anyway`);
    }
  });

  test('an outage reported by the operator invalidates the plan the visitor session is holding', async () => {
    const visitor = await openSession('visitor');
    const operator = await openSession('operator', visitor.demoId);

    const plan = await planFor(visitor.token);
    const staged = await post(`/api/plans/${encodeURIComponent(plan.id)}/stage`, {
      token: visitor.token,
      body: { expectedResourceVersion: plan.basedOnResourceVersion },
    });
    assert.equal(staged.status, 200);
    assert.equal((await venue(visitor.token)).phase, 'AWAITING_HUMAN_CONFIRMATION');

    // Take the lift from the plan rather than assuming which route won.
    const facilityId = plan.claims.find((claim) => claim.role === 'ROUTE_FACILITY').resourceId;
    const before = await venue(operator.token);

    const outage = await post(`/api/operator/facilities/${facilityId}/outage`, {
      token: operator.token,
      body: { reasonCode: 'LIFT_DOOR_FAULT' },
    });
    assert.equal(outage.status, 200, 'the operator role may take a lift out of service');

    const afterVisitor = await venue(visitor.token);
    assert.equal(afterVisitor.resources[facilityId].status, 'OUT_OF_SERVICE');
    assert.equal(afterVisitor.resourceVersion, before.resourceVersion + 1, 'the venue revision moved once');
    assert.equal(afterVisitor.phase, 'PLAN_STALE', 'the visitor is not left holding a plan that cannot happen');
    assert.equal(afterVisitor.activePlan.status, 'STALE');
    // Stored status and derived flag are computed separately, and the page
    // reads the flag. If they ever disagreed, the plan would render as usable.
    assert.equal(afterVisitor.activePlan.stale, true, 'the plan reads as stale as well as being marked stale');

    const ledgerEntry = afterVisitor.audit.at(-1);
    assert.equal(ledgerEntry.action, 'FACILITY_OUTAGE_REPORTED');
    assert.equal(ledgerEntry.actor, 'venue-operator', 'the outage is the operator’s action, not the visitor’s');

    assertVenueUntouched(
      await venueBytes(visitor.token),
      await venueBytes(operator.token),
      'the operator and the visitor should be looking at one venue after the outage',
    );
  });
});

describe('role isolation', () => {
  test('a visitor token is refused on every venue-operator route and changes nothing', async () => {
    const visitor = await openSession('visitor');
    const operator = await openSession('operator', visitor.demoId);

    // Something worth losing: a plan, a ledger and a live revision, so an
    // unauthorised write that landed would have somewhere visible to land.
    await planFor(visitor.token);
    const before = await venueBytes(operator.token);

    const operatorRoutes = [
      ['/api/operator/facilities/east-lift/outage', { reasonCode: 'LIFT_DOOR_FAULT' }],
      ['/api/operator/facilities/east-lift/restore', {}],
      ['/api/operator/facilities/east-lift/arm', {}],
      ['/api/operator/facilities/garden-lift/outage', { reasonCode: 'POWER_FAULT' }],
      ['/api/operator/facilities/garden-lift/restore', {}],
      ['/api/operator/facilities/garden-lift/arm', {}],
    ];

    for (const [path, body] of operatorRoutes) {
      const response = await post(path, { token: visitor.token, body });
      assert.equal(response.status, 403, `a visitor should be refused on ${path}`);
      const payload = await response.json();
      assert.equal(payload.error?.code, 'ROLE_FORBIDDEN', `${path} should refuse by role, not by accident`);
      assert.match(payload.error.message, /operator/i, `${path} should say which role it wanted`);
    }

    assertVenueUntouched(
      before,
      await venueBytes(operator.token),
      'a visitor token was refused on the operator routes but the venue moved anyway',
    );

    // The refusals above are about the role, not about the routes being broken.
    const allowed = await post('/api/operator/facilities/east-lift/arm', { token: operator.token });
    assert.equal(allowed.status, 200, 'the same route works for the operator role');
    assert.equal((await venue(visitor.token)).demo.pendingOutageResourceId, 'east-lift');
  });

  test('an operator token is refused on every visitor-only route and changes nothing', async () => {
    const visitor = await openSession('visitor');
    const operator = await openSession('operator', visitor.demoId);

    const plan = await planFor(visitor.token);
    const planPath = `/api/plans/${encodeURIComponent(plan.id)}`;
    const before = await venueBytes(operator.token);

    // A real plan id, so a 403 cannot be a disguised "no such plan".
    const visitorRoutes = [
      ['/api/plans', { requirements: FULL_REQUIREMENTS }],
      [`${planPath}/stage`, { expectedResourceVersion: plan.basedOnResourceVersion }],
      [`${planPath}/replan`, {}],
      [`${planPath}/clear`, {}],
      [`${planPath}/prepare-confirmation`, {}],
      [`${planPath}/commit`, {
        confirmationId: 'confirm-anything',
        expectedResourceVersion: plan.basedOnResourceVersion,
        accepted: true,
        requestId: 'uat-operator-attempt',
      }],
    ];

    for (const [path, body] of visitorRoutes) {
      const response = await post(path, { token: operator.token, body });
      assert.equal(response.status, 403, `an operator should be refused on ${path}`);
      const payload = await response.json();
      assert.equal(payload.error?.code, 'ROLE_FORBIDDEN', `${path} should refuse by role before touching the plan`);
      assert.match(payload.error.message, /visitor/i, `${path} should say which role it wanted`);
    }

    assertVenueUntouched(
      before,
      await venueBytes(operator.token),
      'an operator token was refused on the booking routes but the venue moved anyway',
    );

    const allowed = await post(`${planPath}/stage`, {
      token: visitor.token,
      body: { expectedResourceVersion: plan.basedOnResourceVersion },
    });
    assert.equal(allowed.status, 200, 'the same route works for the visitor role');
  });

  test('a cross-site write is refused and leaves the venue byte-for-byte unchanged', async () => {
    const visitor = await openSession('visitor');
    const operator = await openSession('operator', visitor.demoId);

    await planFor(visitor.token);
    const before = await venueBytes(visitor.token);

    // /api/demo/reset is the most destructive route in the app: if the guard
    // ever ran after the reset, the status would still be 403 and only the
    // snapshot comparison would notice the venue had gone back to nothing.
    const attempts = [
      ['a foreign origin resetting the demo', '/api/demo/reset', {
        token: visitor.token, origin: 'https://evil.example', body: {},
      }, 'CROSS_SITE_REQUEST_BLOCKED'],
      ['a foreign origin taking a lift out of service', '/api/operator/facilities/east-lift/outage', {
        token: operator.token, origin: 'https://evil.example', body: { reasonCode: 'POWER_FAULT' },
      }, 'CROSS_SITE_REQUEST_BLOCKED'],
      ['a same-host origin the browser calls cross-site', '/api/plans', {
        token: visitor.token, fetchSite: 'cross-site', body: { requirements: FULL_REQUIREMENTS },
      }, 'CROSS_SITE_REQUEST_BLOCKED'],
      ['a write with no origin at all', '/api/demo/reset', {
        token: visitor.token, origin: null, body: {},
      }, 'ORIGIN_REQUIRED'],
      ['an origin that is not a URL', '/api/demo/reset', {
        token: visitor.token, origin: 'not a url', body: {},
      }, 'INVALID_ORIGIN'],
    ];

    for (const [why, path, options, code] of attempts) {
      const response = await post(path, options);
      assert.equal(response.status, 403, `${why} should be refused`);
      assert.equal(await errorCode(response), code, `${why} should be refused by name`);
    }

    assertVenueUntouched(
      before,
      await venueBytes(visitor.token),
      'a cross-site write was refused but the venue changed anyway',
    );

    // The guard blocks the origin, not the route: the same reset from the
    // demo's own origin really does wipe the venue, which is what made the
    // comparison above worth making.
    const sameOrigin = await post('/api/demo/reset', { token: visitor.token });
    assert.equal(sameOrigin.status, 200);
    const afterReset = (await sameOrigin.json()).state;
    assert.equal(afterReset.phase, 'READY');
    assert.equal(afterReset.activePlan, null, 'a same-origin reset really does discard the plan');
    assert.equal(afterReset.runId, 'run-002', 'the reset started a second run on this venue');
    // A rebuilt venue that reused revision 1 would let a plan held from before
    // the reset match the current revision and confirm against resources that
    // no longer exist, so the revision has to move forward, never back.
    assert.equal(afterReset.resourceVersion, 2, 'the venue revision moves forward across a reset');
    assert.deepStrictEqual(
      afterReset.audit.map((line) => line.action),
      ['DEMO_RESET'],
      'the reset clears the ledger and records itself',
    );
    assert.equal(afterReset.audit[0].actor, 'demo-control');
  });
});

describe('who acted', () => {
  test('the ledger names the operator, the visitor page and the agent as different actors', async () => {
    const visitor = await openSession('visitor');
    const operator = await openSession('operator', visitor.demoId);

    // The visible form: no tool header.
    const plan = await planFor(visitor.token);
    // The agent: the same visitor session, declaring the tool it is running.
    await post(`/api/plans/${encodeURIComponent(plan.id)}/stage`, {
      token: visitor.token,
      tool: 'stage_access_bundle',
      body: { expectedResourceVersion: plan.basedOnResourceVersion },
    });
    await post(`/api/plans/${encodeURIComponent(plan.id)}/prepare-confirmation`, { token: visitor.token });
    await post('/api/operator/facilities/garden-lift/arm', { token: operator.token });

    const ledger = (await venue(visitor.token)).audit;
    const entryFor = (action) => {
      const found = ledger.find((line) => line.action === action);
      assert.ok(found, `the ledger should record ${action}`);
      return found;
    };

    const created = entryFor('PLAN_CREATED');
    assert.equal(created.actor, 'human-ui', 'a plan made through the form is the person’s action');
    assert.equal(created.toolName, null, 'no tool is credited when no tool ran');

    const stagedByAgent = entryFor('PLAN_STAGED');
    assert.equal(stagedByAgent.actor, 'webmcp-agent');
    assert.equal(stagedByAgent.toolName, 'stage_access_bundle');

    const prepared = entryFor('HUMAN_CONFIRMATION_PREPARED');
    assert.equal(prepared.actor, 'human-ui', 'showing the plan to the customer is never an agent action');
    assert.equal(prepared.toolName ?? null, null);

    const armed = entryFor('OUTAGE_SIGNAL_ARMED');
    assert.equal(armed.actor, 'venue-operator', 'the operator session is recorded as the operator');

    // No visitor action may be filed under the operator, and no operator action
    // under the booking side, whatever order they arrived in.
    const operatorActions = ['OUTAGE_SIGNAL_ARMED', 'FACILITY_OUTAGE_REPORTED', 'FACILITY_RESTORED', 'RESOURCE_UNAVAILABLE'];
    for (const line of ledger) {
      if (operatorActions.includes(line.action)) {
        assert.equal(line.actor, 'venue-operator', `${line.action} should be the operator’s`);
      } else {
        assert.notEqual(line.actor, 'venue-operator', `${line.action} is not an operator action`);
      }
    }

    assert.deepStrictEqual(
      ledger,
      (await venue(operator.token)).audit,
      'both roles read one ledger, not a per-role edit of it',
    );
  });

  test('the X-WebMCP-Tool header alone decides whether an action reads as an agent action', async () => {
    const visitor = await openSession('visitor');
    const operator = await openSession('operator', visitor.demoId);
    const last = async () => (await venue(visitor.token)).audit.at(-1);

    // Identical route, identical body, identical session. The only difference
    // between these three calls is the header, and it is what the decision log
    // shows the visitor as "WebMCP - <tool>".
    const agentPlan = await planFor(visitor.token, { tool: 'find_access_bundle' });
    const created = await last();
    assert.equal(created.action, 'PLAN_CREATED');
    assert.equal(created.actor, 'webmcp-agent');
    assert.equal(created.toolName, 'find_access_bundle');

    // A header naming some other tool is not an endorsement of this one.
    await post(`/api/plans/${encodeURIComponent(agentPlan.id)}/stage`, {
      token: visitor.token,
      tool: 'find_access_bundle',
      body: { expectedResourceVersion: agentPlan.basedOnResourceVersion },
    });
    const mismatched = await last();
    assert.equal(mismatched.action, 'PLAN_STAGED');
    assert.equal(mismatched.actor, 'human-ui', 'a header for a different tool must not credit this one');
    assert.equal(mismatched.toolName, null);

    // No header: the visible form.
    await post(`/api/plans/${encodeURIComponent(agentPlan.id)}/clear`, { token: visitor.token });
    const cleared = await last();
    assert.equal(cleared.action, 'PLAN_CLEARED');
    assert.equal(cleared.actor, 'human-ui');
    assert.equal(cleared.toolName, null);

    // This recorded the gap: on the venue-operator routes the header decided
    // nothing, so the ledger could not show an operator whether a lift was
    // taken out of service by a person or by their agent - on the one artefact
    // this product asks to be believed. The context travels through those
    // routes now.
    const byOperatorAgent = await post('/api/operator/facilities/garden-lift/outage', {
      token: operator.token,
      tool: 'report_facility_outage',
      body: { reasonCode: 'SAFETY_INSPECTION' },
    });
    assert.equal(byOperatorAgent.status, 200);
    const outage = await last();
    assert.equal(outage.action, 'FACILITY_OUTAGE_REPORTED');
    assert.equal(outage.actor, 'webmcp-agent', 'the operator routes still ignore the declared path');
    assert.equal(outage.toolName, 'report_facility_outage');

    // And a header for some other tool is not an endorsement of this one here
    // either: it falls back to the operator, not to the visitor page's actor.
    await post('/api/operator/facilities/east-lift/outage', {
      token: operator.token,
      tool: 'find_access_bundle',
      body: { reasonCode: 'POWER_FAULT' },
    });
    const mismatchedOperator = await last();
    assert.equal(mismatchedOperator.actor, 'venue-operator');
    assert.equal(mismatchedOperator.toolName ?? null, null);
  });

  test('the venue ledger credits the tool an agent ran and leaves it empty for the page', () => {
    const store = createDemoStore({
      clock: () => Date.parse('2026-08-30T18:00:00.000Z'),
      idFactory: (n => () => `id-${++n}`)(0),
    });

    const plan = store.findBundle(FULL_REQUIREMENTS, { actor: 'webmcp-agent', toolName: 'find_access_bundle' });
    assert.equal(plan.id, 'plan-id-1', 'the injected id factory is the one in use');

    const created = store.snapshot().audit.at(-1);
    assert.equal(created.action, 'PLAN_CREATED');
    assert.equal(created.actor, 'webmcp-agent');
    assert.equal(created.toolName, 'find_access_bundle');
    assert.equal(created.at, '2026-08-30T18:00:00.000Z', 'the injected clock is the one in use');
    assert.equal(created.seq, 1);

    store.clearPlan(plan.id, { actor: 'human-ui', toolName: null });
    const cleared = store.snapshot().audit.at(-1);
    assert.equal(cleared.action, 'PLAN_CLEARED');
    assert.equal(cleared.actor, 'human-ui');
    assert.equal(cleared.toolName, null, 'the page credits no tool');
    assert.equal(cleared.seq, 2, 'the ledger sequence keeps counting across actors');
  });

  test('an operator change is filed under the operator and does not rewrite the agent’s entry', () => {
    const store = createDemoStore({
      clock: () => Date.parse('2026-08-30T18:00:00.000Z'),
      idFactory: (n => () => `id-${++n}`)(0),
    });

    store.findBundle(FULL_REQUIREMENTS, { actor: 'webmcp-agent', toolName: 'find_access_bundle' });
    store.stageBundle('plan-id-1', 1, { actor: 'webmcp-agent', toolName: 'stage_access_bundle' });
    const stagedEntry = store.snapshot().audit.at(-1);
    assert.equal(stagedEntry.actor, 'webmcp-agent');

    store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');
    const snapshot = store.snapshot();
    const outage = snapshot.audit.at(-1);
    assert.equal(outage.action, 'FACILITY_OUTAGE_REPORTED');
    assert.equal(outage.actor, 'venue-operator');
    assert.equal(outage.resourceVersionBefore, 1);
    assert.equal(outage.resourceVersionAfter, 2, 'the operator’s change is what moved the revision');

    assert.equal(snapshot.phase, 'PLAN_STALE', 'the agent’s staged plan cannot survive the lift going out');
    assert.equal(snapshot.activePlan.status, 'STALE');

    // History is append-only: the operator's action must not restate who staged.
    const rewritten = snapshot.audit.find((line) => line.action === 'PLAN_STAGED');
    assert.deepStrictEqual(rewritten, stagedEntry, 'an operator action must not rewrite an earlier entry');
  });
});
