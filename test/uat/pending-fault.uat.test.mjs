/**
 * A pending venue fault is venue state, so the venue has to defend it.
 *
 * The operations page stopped offering to overwrite a pending fault, and the
 * visitor page stopped too. Neither is the venue. `armOutage()` still assigned
 * `pendingOutageResourceId` unconditionally, so the same overwrite remained one
 * HTTP request away: arm Garden, then POST to the East arm endpoint, and the
 * Garden fault is gone with nothing recording that it was dropped.
 *
 * Enforcing an invariant in the two pages that happen to show it is not
 * enforcing it. The WebMCP tool surface, curl, and any second page reach the
 * same endpoint.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDemoStore, DomainError } from '../../lib/domain.mjs';
import { startTestServer } from '../helpers/test-server.mjs';

const store = () => createDemoStore({
  clock: () => Date.parse('2026-08-31T18:00:00.000Z'),
  idFactory: ((n) => () => `id-${++n}`)(0),
});

/** Everything a refused call must leave exactly as it found it. */
const invariant = (snapshot) => ({
  pending: snapshot.demo.pendingOutageResourceId,
  revision: snapshot.resourceVersion,
  resources: snapshot.resources,
  auditLength: snapshot.audit.length,
  lastSeq: snapshot.audit.at(-1)?.seq ?? null,
  plans: snapshot.plans,
  booking: snapshot.booking,
  atomicity: snapshot.atomicity,
});

describe('the venue refuses to lose a pending fault', () => {
  test('arming a different facility while one is pending is refused', () => {
    const venue = store();
    venue.armOutage('garden-lift');
    assert.equal(venue.snapshot().demo.pendingOutageResourceId, 'garden-lift');

    assert.throws(
      () => venue.armOutage('east-lift'),
      (error) => error instanceof DomainError
        && error.code === 'OUTAGE_ALREADY_ARMED'
        && error.status === 409,
      'arming a second facility must be refused, not silently accepted',
    );
  });

  test('the refusal names the facility that already holds the fault', () => {
    const venue = store();
    venue.armOutage('garden-lift');
    try {
      venue.armOutage('east-lift');
      assert.fail('the second arm should have been refused');
    } catch (error) {
      assert.equal(error.details?.pendingOutageResourceId, 'garden-lift');
      assert.match(error.message, /Garden Lift L4/, 'the message should name the armed lift, not its id');
    }
  });

  test('a refused arm changes nothing at all', () => {
    // Not "changes no facility" - changes nothing. A refusal that moved the
    // revision, or added an audit line, would still have cost the venue
    // something.
    const venue = store();
    const plan = venue.findBundle({
      wheelchairWidthCm: 72, maxDistanceM: 80, stepFree: true,
      companionCount: 1, entranceAssistance: true, lowStimulus: true,
    });
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    venue.armOutage('garden-lift');

    const before = invariant(venue.snapshot());
    assert.throws(() => venue.armOutage('east-lift'));
    assert.deepStrictEqual(invariant(venue.snapshot()), before, 'a refused arm left a trace');
  });

  test('both orderings are refused, not just one', () => {
    for (const [first, second] of [['garden-lift', 'east-lift'], ['east-lift', 'garden-lift']]) {
      const venue = store();
      venue.armOutage(first);
      assert.throws(
        () => venue.armOutage(second),
        (error) => error.code === 'OUTAGE_ALREADY_ARMED',
        `${first} armed, then ${second} should be refused`,
      );
      assert.equal(venue.snapshot().demo.pendingOutageResourceId, first, `${first} should still hold the fault`);
    }
  });

  test('arming the same facility again is accepted and records nothing new', () => {
    // Idempotent, not refused: pressing the same control twice is not an error,
    // and it must not inflate the decision log either.
    const venue = store();
    venue.armOutage('east-lift');
    const before = invariant(venue.snapshot());

    const after = venue.armOutage('east-lift');

    assert.equal(after.demo.pendingOutageResourceId, 'east-lift');
    assert.deepStrictEqual(invariant(venue.snapshot()), before, 'a repeated arm should be a no-op');
  });

  test('the fault can be armed again once the pending one is spent', () => {
    // The invariant must not become a trap. Reporting the outage clears the
    // pending fault, and the other lift can then be armed.
    const venue = store();
    venue.armOutage('garden-lift');
    venue.setFacilityOutage('garden-lift', 'POWER_FAULT');
    assert.equal(venue.snapshot().demo.pendingOutageResourceId, null);

    venue.armOutage('east-lift');
    assert.equal(venue.snapshot().demo.pendingOutageResourceId, 'east-lift');
  });

  test('the refusal a pending fault causes is still atomic', () => {
    // Written the wrong way round first: it asserted a booking SUCCEEDS while a
    // fault is armed. Arming a fault is precisely what makes the commit fail -
    // that is the demo. What has to hold is that the refusal costs nothing.
    const venue = store();
    const plan = venue.findBundle({
      wheelchairWidthCm: 72, maxDistanceM: 80, stepFree: true,
      companionCount: 1, entranceAssistance: true, lowStimulus: true,
    });
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    venue.armOutage('garden-lift');
    assert.throws(() => venue.armOutage('east-lift'));

    const confirmation = venue.prepareConfirmation(plan.id);
    assert.throws(
      () => venue.commitBundle({
        planId: plan.id,
        confirmationId: confirmation.confirmationId,
        expectedResourceVersion: confirmation.expectedResourceVersion,
        accepted: true,
        requestId: 'pending-fault-atomicity',
      }),
      (error) => error.code === 'STALE_RESOURCE_VERSION',
      'the armed fault should overtake the confirmation',
    );

    const after = venue.snapshot();
    assert.equal(after.atomicity.bookingCount, 0, 'nothing may be booked');
    assert.equal(after.atomicity.reservedResourceCount, 0, 'nothing may be reserved');
    assert.equal(venue.explainRefusal().partialReservations, 0, 'and nothing partially so');
  });
});

describe('the HTTP API enforces it too, which is where it was reachable', () => {
  test('a second arm over HTTP is refused with 409 and a named code', async (t) => {
    const server = await startTestServer(t);
    const operator = await server.session('operator');

    const first = await server.post('/api/operator/facilities/garden-lift/arm', {}, operator.token);
    assert.equal(first.status, 200, 'the first arm should succeed');

    const second = await server.post('/api/operator/facilities/east-lift/arm', {}, operator.token);
    assert.equal(second.status, 409, 'the second arm should be refused');
    const body = await second.json();
    assert.equal(body.error.code, 'OUTAGE_ALREADY_ARMED');
    // sendError spreads details INTO error rather than nesting them, which is
    // the convention every other refusal in this API already follows. Asserted
    // against the shape the server really sends, not the one I first assumed.
    assert.equal(body.error.pendingOutageResourceId, 'garden-lift');
    assert.equal(body.error.pendingFacilityLabel, 'Garden Lift L4');
    assert.match(body.error.message, /Garden Lift L4/);
  });

  test('the venue still holds the first fault after the refusal', async (t) => {
    const server = await startTestServer(t);
    const operator = await server.session('operator');
    await server.post('/api/operator/facilities/garden-lift/arm', {}, operator.token);
    const before = await server.state(operator.token);

    await server.post('/api/operator/facilities/east-lift/arm', {}, operator.token);
    const after = await server.state(operator.token);

    assert.equal(after.demo.pendingOutageResourceId, 'garden-lift');
    assert.deepStrictEqual(after, before, 'the refused request changed the venue');
  });

  test('repeating the same arm over HTTP is accepted and idempotent', async (t) => {
    const server = await startTestServer(t);
    const operator = await server.session('operator');
    await server.post('/api/operator/facilities/east-lift/arm', {}, operator.token);
    const before = await server.state(operator.token);

    const again = await server.post('/api/operator/facilities/east-lift/arm', {}, operator.token);
    assert.equal(again.status, 200);
    assert.deepStrictEqual(await server.state(operator.token), before, 'a repeated arm changed the venue');
  });
});

describe('an unrelated outage cannot consume a fault armed on another lift', () => {
  // `setFacilityOutage()` cleared `pendingOutageResourceId` unconditionally, so
  // arming Garden and then reporting East out erased the Garden fault with
  // nothing recording that it was dropped. The arm invariant added earlier
  // guarded the arm endpoint and left this second door open: the pending fault
  // is venue state, and every path that touches it has to defend it.
  test('reporting a different facility leaves the pending fault where it was', () => {
    const venue = store();
    venue.armOutage('garden-lift');

    venue.setFacilityOutage('east-lift', 'POWER_FAULT');

    assert.equal(
      venue.snapshot().demo.pendingOutageResourceId,
      'garden-lift',
      'an East outage consumed the fault armed on Garden',
    );
    assert.equal(venue.snapshot().resources['east-lift'].status, 'OUT_OF_SERVICE', 'East should still go out');
  });

  test('reporting the armed facility itself does consume it', () => {
    const venue = store();
    venue.armOutage('garden-lift');
    venue.setFacilityOutage('garden-lift', 'POWER_FAULT');
    assert.equal(venue.snapshot().demo.pendingOutageResourceId, null, 'the matching outage should spend the fault');
  });

  test('both orderings, so this is not a property of one lift', () => {
    for (const [armed, reported] of [['garden-lift', 'east-lift'], ['east-lift', 'garden-lift']]) {
      const venue = store();
      venue.armOutage(armed);
      venue.setFacilityOutage(reported, 'POWER_FAULT');
      assert.equal(venue.snapshot().demo.pendingOutageResourceId, armed, `${reported} out consumed ${armed}'s fault`);
    }
  });

  test('restoring an unrelated facility also leaves the pending fault alone', () => {
    const venue = store();
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    venue.armOutage('garden-lift');

    venue.restoreFacility('east-lift');

    assert.equal(venue.snapshot().demo.pendingOutageResourceId, 'garden-lift', 'a restore consumed the pending fault');
  });
});

describe('an outage reason has to be a reason', () => {
  // `Object.hasOwn(OUTAGE_REASONS, reasonCode)` converts its key to a string, so
  // `['POWER_FAULT']` resolved to the key "POWER_FAULT" and was accepted. The
  // lift then went out of service on an argument that is not a reason code, and
  // the raw array was written into the decision log as `reason`.
  const NOT_REASON_CODES = [
    ['an array that stringifies to a valid code', ['POWER_FAULT']],
    ['an object with a matching toString', { toString: () => 'POWER_FAULT' }],
    ['null', null],
    ['a number', 1],
    ['a boolean', true],
  ];

  for (const [label, value] of NOT_REASON_CODES) {
    test(`${label} is refused as INVALID_OUTAGE_REASON`, () => {
      const venue = store();
      assert.throws(
        () => venue.setFacilityOutage('east-lift', value),
        (error) => error.code === 'INVALID_OUTAGE_REASON' && error.status === 422,
        `${label} was accepted as an outage reason`,
      );
    });

    test(`${label} changes nothing at all`, () => {
      const venue = store();
      const before = invariant(venue.snapshot());
      assert.throws(() => venue.setFacilityOutage('east-lift', value));
      assert.deepStrictEqual(invariant(venue.snapshot()), before, `${label} moved the venue`);
    });
  }

  test('a valid code is still accepted, so this is not a blanket refusal', () => {
    const venue = store();
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    assert.equal(venue.snapshot().resources['east-lift'].status, 'OUT_OF_SERVICE');
  });

  test('no audit entry ever carries a non-string reason', () => {
    // The refusal is the fix; this is the property it exists to protect.
    const venue = store();
    for (const [, value] of NOT_REASON_CODES) {
      try { venue.setFacilityOutage('east-lift', value); } catch { /* expected */ }
    }
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    const wrong = venue.snapshot().audit
      .filter((entry) => entry.reason !== undefined && entry.reason !== null)
      .filter((entry) => typeof entry.reason !== 'string');
    assert.deepEqual(wrong, [], 'the decision log stored a reason that is not a string');
  });
});
