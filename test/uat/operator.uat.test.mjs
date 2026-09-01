/**
 * Acceptance suite: the venue operations surface and facility state.
 *
 * Written from what a venue operator can actually do to the two lifts, in
 * every order, and from what each of those moves is allowed to do to plans
 * and to a confirmed booking. Everything runs against the real store with a
 * fixed clock and a counting id factory, so no test depends on wall time,
 * randomness, a port or a browser.
 *
 * Two tests here pin behaviour that is arguably wrong rather than behaviour
 * that is right; both say so in a comment and are reported separately.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { OPERATOR_ACTIONS } from '../../public/views.mjs';
import { readFileSync } from 'node:fs';

import { createDemoStore, DomainError } from '../../lib/domain.mjs';
import { createOperatorTools, toolCounts, PHASES } from '../../public/tools.mjs';
import { checkToolContract } from '../../evals/contract.mjs';

const FIXED_CLOCK = () => Date.parse('2026-08-30T18:00:00.000Z');

/** A store whose ids and timestamps are fully determined by call order. */
function newStore() {
  let counter = 0;
  return createDemoStore({ clock: FIXED_CLOCK, idFactory: () => `id-${++counter}` });
}

/** Every requirement stated, which is what an initial plan demands. */
const FULL_REQUIREMENTS = Object.freeze({
  wheelchairWidthCm: 72,
  maxDistanceM: 80,
  stepFree: true,
  companionCount: 1,
  entranceAssistance: true,
  lowStimulus: true,
});

/** The widest set of requirements the validator still accepts. */
const MOST_PERMISSIVE_REQUIREMENTS = Object.freeze({
  wheelchairWidthCm: 45,
  maxDistanceM: 500,
  stepFree: false,
  companionCount: 0,
  entranceAssistance: false,
  lowStimulus: false,
});

const OUTAGE_REASON_CODES = ['LIFT_DOOR_FAULT', 'POWER_FAULT', 'SAFETY_INSPECTION'];

/**
 * The page states spelled out rather than re-exported. Comparing the tool
 * surface against the imported PHASES would compare that array with itself,
 * because every operator tool declares `availableIn: PHASES` by reference.
 */
const EVERY_PAGE_STATE = Object.freeze([
  'READY',
  'PLAN_READY',
  'AWAITING_HUMAN_CONFIRMATION',
  'PLAN_STALE',
  'REPLAN_READY',
  'NO_ALTERNATIVE',
  'CONFIRMED',
]);

function isDomainError(code, status) {
  return (error) => error instanceof DomainError && error.code === code && error.status === status;
}

/**
 * Everything a snapshot says about the venue except the audit log, which
 * records the order commands arrived in and so cannot match across two
 * different orderings of the same commands.
 */
function venueStateExceptAudit(store) {
  const { audit, ...rest } = store.snapshot();
  return rest;
}

function planOnRoute(store, requirements = FULL_REQUIREMENTS) {
  return store.findBundle({ ...requirements });
}

/** Plan, stage, prepare and confirm, returning the committed booking. */
function confirmBooking(store, requestId) {
  const plan = planOnRoute(store);
  store.stageBundle(plan.id, store.snapshot().resourceVersion);
  const confirmation = store.prepareConfirmation(plan.id);
  const result = store.commitBundle({
    planId: plan.id,
    confirmationId: confirmation.confirmationId,
    expectedResourceVersion: confirmation.expectedResourceVersion,
    accepted: true,
    requestId,
  });
  return result.booking;
}

function bothLiftsOut(store) {
  store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');
  store.setFacilityOutage('garden-lift', 'POWER_FAULT');
  return store;
}

function requirementCombinations() {
  const combinations = [];
  for (const wheelchairWidthCm of [45, 72, 95]) {
    for (const maxDistanceM of [20, 80, 500]) {
      for (const stepFree of [true, false]) {
        for (const companionCount of [0, 1]) {
          for (const entranceAssistance of [true, false]) {
            for (const lowStimulus of [true, false]) {
              combinations.push({
                wheelchairWidthCm,
                maxDistanceM,
                stepFree,
                companionCount,
                entranceAssistance,
                lowStimulus,
              });
            }
          }
        }
      }
    }
  }
  return combinations;
}

describe('Reporting a lift out of service', () => {
  test('takes the east lift out of service and advances the venue revision', () => {
    const store = newStore();
    assert.equal(store.snapshot().resourceVersion, 1);

    const after = store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');

    assert.equal(after.resources['east-lift'].status, 'OUT_OF_SERVICE');
    assert.equal(after.resources['east-lift'].outageReason, 'Lift door fault reported by venue operations.');
    assert.equal(after.resourceVersion, 2);
  });

  test('takes the garden lift out of service and advances the venue revision', () => {
    const store = newStore();

    const after = store.setFacilityOutage('garden-lift', 'SAFETY_INSPECTION');

    assert.equal(after.resources['garden-lift'].status, 'OUT_OF_SERVICE');
    assert.equal(after.resources['garden-lift'].outageReason, 'Lift removed from service for a safety inspection.');
    assert.equal(after.resourceVersion, 2);
  });

  test('leaves the other lift operational when only one is reported out', () => {
    const store = newStore();

    const afterEast = store.setFacilityOutage('east-lift', 'POWER_FAULT');
    assert.equal(afterEast.resources['garden-lift'].status, 'OPERATIONAL');
    assert.equal(Object.hasOwn(afterEast.resources['garden-lift'], 'outageReason'), false);

    const both = store.setFacilityOutage('garden-lift', 'POWER_FAULT');
    assert.equal(both.resources['east-lift'].status, 'OUT_OF_SERVICE');
    assert.equal(both.resources['garden-lift'].status, 'OUT_OF_SERVICE');
  });

  test('records the operator, the reason code and the revision the outage moved', () => {
    const store = newStore();

    const after = store.setFacilityOutage('garden-lift', 'POWER_FAULT');
    const entry = after.audit.at(-1);

    assert.equal(entry.action, 'FACILITY_OUTAGE_REPORTED');
    assert.equal(entry.actor, 'venue-operator');
    assert.equal(entry.outcome, 'SUCCESS');
    assert.equal(entry.reason, 'POWER_FAULT');
    assert.deepEqual(entry.refs, ['garden-lift']);
    assert.equal(entry.resourceVersionBefore, 1);
    assert.equal(entry.resourceVersionAfter, 2);
    assert.equal(entry.at, '2026-08-30T18:00:00.000Z');
  });

  test('keeps a lift armed for the demo fault when the OTHER lift is reported out', () => {
    // This case used to be pinned, not endorsed: the pending flag was cleared
    // for any outage, so arming East and then faulting Garden silently threw
    // the armed East fault away. It is now a positive regression - only the
    // armed facility's own outage spends the fault.
    const store = newStore();
    store.armOutage('east-lift');
    assert.equal(store.snapshot().demo.pendingOutageResourceId, 'east-lift');

    const after = store.setFacilityOutage('garden-lift', 'POWER_FAULT');

    assert.equal(after.demo.pendingOutageResourceId, 'east-lift', 'a Garden outage consumed the East fault');
    assert.equal(after.resources['east-lift'].status, 'OPERATIONAL', 'East is armed, not yet out');
    assert.equal(after.resources['garden-lift'].status, 'OUT_OF_SERVICE', 'Garden should still go out');
  });

  test('reaches the same venue state whichever lift is reported out first', () => {
    const eastFirst = newStore();
    eastFirst.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');
    eastFirst.setFacilityOutage('garden-lift', 'POWER_FAULT');

    const gardenFirst = newStore();
    gardenFirst.setFacilityOutage('garden-lift', 'POWER_FAULT');
    gardenFirst.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');

    assert.deepEqual(venueStateExceptAudit(eastFirst), venueStateExceptAudit(gardenFirst));
    assert.equal(eastFirst.snapshot().resourceVersion, 3);
    assert.equal(gardenFirst.snapshot().resourceVersion, 3);
    assert.equal(eastFirst.snapshot().audit.length, 2);
    assert.equal(gardenFirst.snapshot().audit.length, 2);
  });
});

describe('An operator command that changes nothing', () => {
  test('leaves the venue untouched when an already-out lift is reported out again', () => {
    const store = newStore();
    store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');
    const before = store.snapshot();

    const after = store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');

    assert.deepEqual(after, before);
    assert.equal(after.resourceVersion, 2);
    assert.equal(after.audit.length, before.audit.length);
  });

  test('keeps the first outage reason when the repeat names a different one', () => {
    const store = newStore();
    store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');

    const after = store.setFacilityOutage('east-lift', 'SAFETY_INSPECTION');

    assert.equal(after.resources['east-lift'].outageReason, 'Lift door fault reported by venue operations.');
    assert.equal(after.resourceVersion, 2);
    assert.equal(after.audit.at(-1).reason, 'LIFT_DOOR_FAULT');
  });

  test('still refuses an invalid reason code on a lift that is already out', () => {
    const store = newStore();
    store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');

    assert.throws(
      () => store.setFacilityOutage('east-lift', 'DEFINITELY_NOT_A_REASON'),
      isDomainError('INVALID_OUTAGE_REASON', 422),
    );
    assert.equal(store.snapshot().resourceVersion, 2);
  });

  test('leaves the venue untouched when an operational, unarmed lift is restored', () => {
    const store = newStore();
    const before = store.snapshot();

    const afterEast = store.restoreFacility('east-lift');
    const afterGarden = store.restoreFacility('garden-lift');

    assert.deepEqual(afterEast, before);
    assert.deepEqual(afterGarden, before);
    assert.equal(afterGarden.resourceVersion, 1);
    assert.equal(afterGarden.audit.length, 0);
  });
});

describe('Restoring a lift', () => {
  test('brings the east lift back into service and advances the revision', () => {
    const store = newStore();
    store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');

    const after = store.restoreFacility('east-lift');

    assert.equal(after.resources['east-lift'].status, 'OPERATIONAL');
    assert.equal(after.resourceVersion, 3);
    assert.equal(after.audit.at(-1).action, 'FACILITY_RESTORED');
    assert.equal(after.audit.at(-1).resourceVersionBefore, 2);
    assert.equal(after.audit.at(-1).resourceVersionAfter, 3);
  });

  test('brings the garden lift back into service and advances the revision', () => {
    const store = newStore();
    store.setFacilityOutage('garden-lift', 'POWER_FAULT');

    const after = store.restoreFacility('garden-lift');

    assert.equal(after.resources['garden-lift'].status, 'OPERATIONAL');
    assert.equal(after.resourceVersion, 3);
    assert.deepEqual(after.audit.at(-1).refs, ['garden-lift']);
  });

  test('drops the outage reason from a restored lift instead of leaving it stale', () => {
    const store = newStore();
    store.setFacilityOutage('east-lift', 'SAFETY_INSPECTION');
    assert.equal(Object.hasOwn(store.snapshot().resources['east-lift'], 'outageReason'), true);

    const after = store.restoreFacility('east-lift');

    assert.equal(Object.hasOwn(after.resources['east-lift'], 'outageReason'), false);
    assert.deepEqual(Object.keys(after.resources['east-lift']), ['id', 'kind', 'label', 'status', 'reservable']);
  });

  test('reaches the same venue state whichever lift is restored first', () => {
    const eastFirst = bothLiftsOut(newStore());
    eastFirst.restoreFacility('east-lift');
    eastFirst.restoreFacility('garden-lift');

    const gardenFirst = bothLiftsOut(newStore());
    gardenFirst.restoreFacility('garden-lift');
    gardenFirst.restoreFacility('east-lift');

    assert.deepEqual(venueStateExceptAudit(eastFirst), venueStateExceptAudit(gardenFirst));
    assert.equal(eastFirst.snapshot().resourceVersion, 5);
    assert.equal(gardenFirst.snapshot().resourceVersion, 5);
    assert.deepEqual(eastFirst.snapshot().resources, newStore().snapshot().resources);
  });

  test('disarms the demo fault when an armed lift that never left service is restored', () => {
    // The one case where restoring an operational lift is not a no-op.
    //
    // These two used to require a revision bump and a FACILITY_RESTORED entry.
    // Both described a restoration that never happened: the lift was armed, not
    // out, so it never left service and nothing about the venue changed. An
    // independent tester reproduced the cost over HTTP - the bump pushed a valid
    // STAGED plan to STALE - and the decision log is the artefact this product
    // asks to be believed. Disarming is now recorded as what it is.
    const store = newStore();
    store.armOutage('east-lift');
    assert.equal(store.snapshot().demo.pendingOutageResourceId, 'east-lift');
    assert.equal(store.snapshot().resourceVersion, 1);

    const after = store.restoreFacility('east-lift');

    assert.equal(after.demo.pendingOutageResourceId, null);
    assert.equal(after.resources['east-lift'].status, 'OPERATIONAL');
    assert.equal(after.resourceVersion, 1, 'disarming moved the venue revision');
    assert.equal(after.audit.at(-1).action, 'OUTAGE_SIGNAL_CLEARED');
    assert.match(after.audit.at(-1).message, /East Lift L2/, 'the entry does not name the lift it cleared');
  });

  test('disarms the garden lift the same way, not only the east one', () => {
    const store = newStore();
    store.armOutage('garden-lift');

    const after = store.restoreFacility('garden-lift');

    assert.equal(after.demo.pendingOutageResourceId, null);
    assert.equal(after.resourceVersion, 1, 'disarming moved the venue revision');
    assert.equal(after.audit.at(-1).action, 'OUTAGE_SIGNAL_CLEARED');
  });

  test('leaves an operational lift alone when a different lift holds the armed fault', () => {
    const store = newStore();
    store.armOutage('garden-lift');
    const before = store.snapshot();

    const after = store.restoreFacility('east-lift');

    assert.deepEqual(after, before);
    assert.equal(after.demo.pendingOutageResourceId, 'garden-lift');
    assert.equal(after.resourceVersion, 1);
  });
});

describe('Operator commands the venue refuses', () => {
  const badReasonCodes = [
    '',
    'toString',
    'constructor',
    '__proto__',
    'hasOwnProperty',
    'valueOf',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    'lift_door_fault',
    'LIFT_DOOR_FAULT ',
    ' LIFT_DOOR_FAULT',
    'MAINTENANCE',
    'OPERATOR_UNAVAILABLE',
    null,
    0,
    false,
    {},
  ];

  test('refuses every reason code outside the published vocabulary, inherited names included', () => {
    const store = newStore();

    for (const reasonCode of badReasonCodes) {
      assert.throws(
        () => store.setFacilityOutage('east-lift', reasonCode),
        isDomainError('INVALID_OUTAGE_REASON', 422),
        `expected ${JSON.stringify(reasonCode)} to be refused`,
      );
      assert.equal(store.snapshot().resources['east-lift'].status, 'OPERATIONAL');
    }
    assert.equal(store.snapshot().resourceVersion, 1);
  });

  test('refuses an outage reported with no reason code at all', () => {
    const store = newStore();

    assert.throws(() => store.setFacilityOutage('east-lift'), isDomainError('INVALID_OUTAGE_REASON', 422));
    assert.throws(() => store.setFacilityOutage('garden-lift', undefined), isDomainError('INVALID_OUTAGE_REASON', 422));
    assert.equal(store.snapshot().resourceVersion, 1);
  });

  test('names the reason codes it will accept when it refuses one', () => {
    const store = newStore();

    assert.throws(
      () => store.setFacilityOutage('east-lift', 'toString'),
      (error) => {
        assert.equal(error instanceof DomainError, true);
        assert.equal(error.code, 'INVALID_OUTAGE_REASON');
        assert.equal(error.status, 422);
        assert.deepEqual(error.details.allowedReasonCodes, OUTAGE_REASON_CODES);
        return true;
      },
    );
  });

  test('refuses a single-element array whose text matches a reason code', () => {
    // This case used to be pinned, not endorsed: the reason code was matched
    // after string coercion, so ["POWER_FAULT"] took the lift out of service
    // and was written into the decision log as an array. Object.hasOwn converts
    // its key to a string; the type check now happens before that lookup.
    const store = newStore();
    const before = store.snapshot();

    assert.throws(
      () => store.setFacilityOutage('east-lift', ['POWER_FAULT']),
      (error) => error.code === 'INVALID_OUTAGE_REASON' && error.status === 422,
      'an array was accepted as an outage reason',
    );

    const after = store.snapshot();
    assert.equal(after.resources['east-lift'].status, 'OPERATIONAL', 'the lift went out on a non-reason');
    assert.equal(after.resourceVersion, before.resourceVersion, 'the refusal moved the venue revision');
    assert.equal(after.audit.length, before.audit.length, 'the refusal wrote a decision-log entry');
  });

  test('refuses an unknown facility id for both outage and restore', () => {
    const store = newStore();
    const unknownIds = ['north-lift', 'east_lift', 'EAST-LIFT', '', 'toString', 'constructor', '__proto__', 'hasOwnProperty'];

    for (const facilityId of unknownIds) {
      assert.throws(
        () => store.setFacilityOutage(facilityId, 'POWER_FAULT'),
        isDomainError('FACILITY_NOT_FOUND', 404),
        `expected outage on ${JSON.stringify(facilityId)} to be refused`,
      );
      assert.throws(
        () => store.restoreFacility(facilityId),
        isDomainError('FACILITY_NOT_FOUND', 404),
        `expected restore of ${JSON.stringify(facilityId)} to be refused`,
      );
    }
  });

  test('refuses a reservable resource id such as space-w12 and leaves it available', () => {
    const store = newStore();

    for (const resourceId of ['space-w12', 'seat-w13', 'assist-east-1905', 'assist-garden-1903']) {
      assert.throws(
        () => store.setFacilityOutage(resourceId, 'POWER_FAULT'),
        isDomainError('FACILITY_NOT_FOUND', 404),
        `expected outage on ${resourceId} to be refused`,
      );
      assert.throws(() => store.restoreFacility(resourceId), isDomainError('FACILITY_NOT_FOUND', 404));
      assert.throws(() => store.armOutage(resourceId), isDomainError('FACILITY_NOT_FOUND', 404));
      assert.equal(store.snapshot().resources[resourceId].status, 'AVAILABLE');
    }
  });

  test('checks the facility before the reason, so a bad id and a bad reason report the id', () => {
    const store = newStore();

    assert.throws(
      () => store.setFacilityOutage('space-w12', 'NOT_A_REASON'),
      isDomainError('FACILITY_NOT_FOUND', 404),
    );
  });

  test('refuses to arm a lift that is already out of service', () => {
    const store = newStore();
    store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');

    assert.throws(() => store.armOutage('east-lift'), isDomainError('FACILITY_NOT_OPERATIONAL', 409));
    assert.equal(store.snapshot().demo.pendingOutageResourceId, null);
  });

  test('leaves the venue byte-for-byte unchanged after a run of refused commands', () => {
    const store = newStore();
    const before = store.snapshot();

    const refused = [
      ['an unknown reason on a real lift', () => store.setFacilityOutage('east-lift', 'NOPE'), 'INVALID_OUTAGE_REASON', 422],
      ['an outage with no reason at all', () => store.setFacilityOutage('east-lift'), 'INVALID_OUTAGE_REASON', 422],
      ['an outage on a lift that does not exist', () => store.setFacilityOutage('north-lift', 'POWER_FAULT'), 'FACILITY_NOT_FOUND', 404],
      ['an outage on a wheelchair space', () => store.setFacilityOutage('space-w12', 'POWER_FAULT'), 'FACILITY_NOT_FOUND', 404],
      ['a restore of a lift that does not exist', () => store.restoreFacility('north-lift'), 'FACILITY_NOT_FOUND', 404],
      ['a restore of a companion seat', () => store.restoreFacility('seat-w13'), 'FACILITY_NOT_FOUND', 404],
      ['arming a lift that does not exist', () => store.armOutage('north-lift'), 'FACILITY_NOT_FOUND', 404],
    ];
    for (const [what, command, code, status] of refused) {
      assert.throws(command, isDomainError(code, status), `expected ${what} to be refused with ${code} ${status}`);
    }

    assert.deepEqual(store.snapshot(), before);
  });
});

describe('Open plans on an operator transition', () => {
  test('stales a proposed plan routed over the east lift when the garden lift goes out', () => {
    const store = newStore();
    const plan = planOnRoute(store);
    assert.equal(plan.routeId, 'east-lift-route');
    assert.equal(plan.status, 'PROPOSED');

    const after = store.setFacilityOutage('garden-lift', 'POWER_FAULT');

    assert.equal(after.activePlan.status, 'STALE');
    assert.equal(after.activePlan.stale, true);
    assert.equal(after.phase, 'PLAN_STALE');
    assert.equal(after.resources['east-lift'].status, 'OPERATIONAL');
  });

  test('stales a staged plan routed over the east lift when the garden lift goes out', () => {
    const store = newStore();
    const plan = planOnRoute(store);
    const staged = store.stageBundle(plan.id, store.snapshot().resourceVersion);
    assert.equal(staged.status, 'STAGED');

    const after = store.setFacilityOutage('garden-lift', 'LIFT_DOOR_FAULT');

    assert.equal(after.activePlan.status, 'STALE');
    assert.equal(after.phase, 'PLAN_STALE');
  });

  test('keeps the east route feasible even though the plan built on it is stale', () => {
    const store = newStore();
    planOnRoute(store);
    store.setFacilityOutage('garden-lift', 'POWER_FAULT');

    const eastRoute = store.checkAccessRoute('east-lift-route', FULL_REQUIREMENTS);
    const refusal = store.explainRefusal();

    assert.equal(eastRoute.feasible, true);
    assert.deepEqual(eastRoute.blockedBy, []);
    assert.equal(refusal.blocked, true);
    assert.equal(refusal.errorCode, 'STALE_RESOURCE_VERSION');
    assert.equal(refusal.nextAction, 'REPLAN');
    assert.deepEqual(refusal.validOptionsNow.map((option) => option.routeId), ['east-lift-route']);
    assert.equal(refusal.partialReservations, 0);
  });

  test('stales a plan routed over the garden lift when the east lift is restored', () => {
    const store = newStore();
    store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');
    const plan = planOnRoute(store);
    assert.equal(plan.routeId, 'garden-lift-route');

    const after = store.restoreFacility('east-lift');

    assert.equal(after.activePlan.status, 'STALE');
    assert.equal(after.phase, 'PLAN_STALE');
    assert.equal(after.resources['garden-lift'].status, 'OPERATIONAL');
  });

  test('does not stale an open plan when the repeat outage changes nothing', () => {
    const store = newStore();
    store.setFacilityOutage('garden-lift', 'POWER_FAULT');
    const plan = planOnRoute(store);
    assert.equal(plan.routeId, 'east-lift-route');

    const after = store.setFacilityOutage('garden-lift', 'POWER_FAULT');

    assert.equal(after.activePlan.status, 'PROPOSED');
    assert.equal(after.activePlan.stale, false);
    assert.equal(after.phase, 'PLAN_READY');
  });

  test('leaves a committed plan committed when a lift goes out', () => {
    const store = newStore();
    confirmBooking(store, 'uat-committed-plan');

    const after = store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');

    assert.equal(after.activePlan.status, 'COMMITTED');
    assert.equal(after.activePlan.stale, false);
    assert.equal(after.phase, 'CONFIRMED');
  });
});

describe('A confirmed booking on an operator transition', () => {
  test('is neither cancelled nor rewritten when the lift on its own route goes out', () => {
    const store = newStore();
    const booking = confirmBooking(store, 'uat-east-own-lift');
    assert.equal(booking.routeId, 'east-lift-route');
    const before = store.snapshot().booking;

    const after = store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');

    assert.deepEqual(after.booking, before);
    assert.deepEqual(after.booking.resourceIds, ['east-lift', 'space-w12', 'seat-w13', 'assist-east-1905']);
    assert.equal(after.resources['east-lift'].status, 'OUT_OF_SERVICE');
    assert.equal(after.phase, 'CONFIRMED');
    assert.equal(after.atomicity.bookingCount, 1);
  });

  test('is neither cancelled nor rewritten when the other lift goes out', () => {
    const store = newStore();
    const booking = confirmBooking(store, 'uat-east-other-lift');
    assert.equal(booking.routeId, 'east-lift-route');
    const before = store.snapshot().booking;

    const after = store.setFacilityOutage('garden-lift', 'POWER_FAULT');

    assert.deepEqual(after.booking, before);
    assert.equal(after.resources['east-lift'].status, 'OPERATIONAL');
    assert.equal(after.resources['garden-lift'].status, 'OUT_OF_SERVICE');
    assert.equal(after.phase, 'CONFIRMED');
  });

  test('survives an outage on its own garden lift when the booking was routed that way', () => {
    const store = newStore();
    store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');
    const booking = confirmBooking(store, 'uat-garden-own-lift');
    assert.equal(booking.routeId, 'garden-lift-route');
    const before = store.snapshot().booking;

    const after = store.setFacilityOutage('garden-lift', 'SAFETY_INSPECTION');

    assert.deepEqual(after.booking, before);
    assert.deepEqual(after.booking.resourceIds, ['garden-lift', 'space-w12', 'seat-w13', 'assist-garden-1903']);
    assert.equal(after.resources['garden-lift'].status, 'OUT_OF_SERVICE');
  });

  test('survives the other lift being restored and then reported out again', () => {
    const store = newStore();
    store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');
    const booking = confirmBooking(store, 'uat-garden-other-lift');
    assert.equal(booking.routeId, 'garden-lift-route');
    const before = store.snapshot().booking;

    const restored = store.restoreFacility('east-lift');
    assert.deepEqual(restored.booking, before);

    const outAgain = store.setFacilityOutage('east-lift', 'POWER_FAULT');

    assert.deepEqual(outAgain.booking, before);
    assert.equal(outAgain.resources['garden-lift'].status, 'OPERATIONAL');
    assert.equal(outAgain.phase, 'CONFIRMED');
  });

  test('keeps every reserved resource reserved through an outage and a restore', () => {
    const store = newStore();
    const booking = confirmBooking(store, 'uat-reserved-resources');
    assert.equal(store.snapshot().atomicity.reservedResourceCount, 3);

    store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');
    store.restoreFacility('east-lift');
    const after = store.snapshot();

    assert.equal(after.atomicity.reservedResourceCount, 3);
    for (const resourceId of ['space-w12', 'seat-w13', 'assist-east-1905']) {
      assert.equal(after.resources[resourceId].status, 'RESERVED');
      assert.equal(after.resources[resourceId].reservedBy, booking.id);
    }
    assert.equal(after.resources['east-lift'].status, 'OPERATIONAL');
  });

  test('cannot arm a confirmation fault after the only booking is already confirmed', () => {
    const store = newStore();
    confirmBooking(store, 'uat-no-future-confirmation');
    const before = store.snapshot();

    assert.throws(
      () => store.armOutage('east-lift'),
      isDomainError('BOOKING_ALREADY_CONFIRMED', 409),
    );
    assert.deepEqual(store.snapshot(), before, 'the refused arm changed a confirmed venue');
  });
});

describe('Both lifts out of service', () => {
  test('refuses to plan for every legal requirement combination', () => {
    const store = bothLiftsOut(newStore());
    const combinations = requirementCombinations();
    assert.equal(combinations.length, 144);

    for (const requirements of combinations) {
      assert.throws(
        () => store.findBundle(requirements),
        isDomainError('NO_COMPLETE_BUNDLE', 422),
        `expected no bundle for ${JSON.stringify(requirements)}`,
      );
    }
  });

  test('leaves no plan and no audit entry behind after refusing every combination', () => {
    const store = bothLiftsOut(newStore());
    const before = store.snapshot();

    for (const requirements of requirementCombinations()) {
      assert.throws(() => store.findBundle(requirements), DomainError);
    }

    assert.deepEqual(store.snapshot(), before);
    assert.equal(store.snapshot().activePlan, null);
    assert.equal(store.snapshot().phase, 'READY');
  });

  test('refuses the most permissive legal requirement set and blames only the lift rule', () => {
    const store = bothLiftsOut(newStore());

    assert.throws(
      () => store.findBundle({ ...MOST_PERMISSIVE_REQUIREMENTS }),
      isDomainError('NO_COMPLETE_BUNDLE', 422),
    );

    const options = store.listAccessOptions({ ...MOST_PERMISSIVE_REQUIREMENTS });
    assert.equal(options.feasibleCount, 0);
    assert.equal(options.options.length, 2);
    for (const option of options.options) {
      assert.equal(option.feasible, false);
      assert.deepEqual(option.blockedBy, ['LIFT_OPERATIONAL']);
    }
  });

  test('reports no alternative for an open plan and then recovers when the east lift returns', () => {
    const store = newStore();
    const plan = planOnRoute(store);
    bothLiftsOut(store);
    assert.equal(store.snapshot().activePlan.status, 'STALE');

    // Both lifts are out, so no legal requirement value reopens the venue. The
    // advice used to be CHANGE_REQUIREMENTS beside requirementChangeCanHelp:
    // false - an agent that followed it would loop.
    assert.throws(() => store.replanBundle(plan.id), (error) => {
      assert.equal(error.code, 'NO_COMPLETE_BUNDLE');
      assert.equal(error.details.requirementChangeCanHelp, false);
      assert.equal(error.details.nextAction, 'CONTACT_VENUE_STAFF');
      return true;
    });
    assert.equal(store.snapshot().phase, 'NO_ALTERNATIVE');
    assert.equal(store.explainRefusal().nextAction, 'CONTACT_VENUE_STAFF');

    store.restoreFacility('east-lift');
    assert.equal(store.snapshot().phase, 'PLAN_STALE');

    const replacement = store.replanBundle(plan.id);
    assert.equal(replacement.routeId, 'east-lift-route');
    assert.equal(replacement.status, 'STAGED');
    assert.equal(store.snapshot().phase, 'REPLAN_READY');
  });

  test('recovers just as well when the garden lift is the one restored', () => {
    const store = newStore();
    const plan = planOnRoute(store);
    bothLiftsOut(store);
    assert.throws(() => store.replanBundle(plan.id), isDomainError('NO_COMPLETE_BUNDLE', 422));

    store.restoreFacility('garden-lift');

    const replacement = store.replanBundle(plan.id);
    assert.equal(replacement.routeId, 'garden-lift-route');
    assert.equal(store.snapshot().phase, 'REPLAN_READY');
  });

  test('lets a fresh visitor plan again once either lift is back', () => {
    const eastBack = bothLiftsOut(newStore());
    eastBack.restoreFacility('east-lift');
    assert.equal(eastBack.findBundle({ ...FULL_REQUIREMENTS }).routeId, 'east-lift-route');

    const gardenBack = bothLiftsOut(newStore());
    gardenBack.restoreFacility('garden-lift');
    assert.equal(gardenBack.findBundle({ ...FULL_REQUIREMENTS }).routeId, 'garden-lift-route');
  });
});

describe('The venue operations tool surface', () => {
  const operatorTools = createOperatorTools({});
  const byName = new Map(operatorTools.map((tool) => [tool.name, tool]));

  test('registers one read tool and two write tools in every page state', () => {
    assert.deepEqual(operatorTools.map((tool) => tool.name), [
      'get_facility_status',
      'report_facility_outage',
      'restore_facility',
    ]);
    assert.deepEqual(toolCounts(operatorTools), { total: 3, read: 1, write: 2 });
    assert.equal(byName.get('get_facility_status').annotations.readOnlyHint, true);
    assert.equal(byName.get('report_facility_outage').annotations.readOnlyHint, false);
    assert.equal(byName.get('restore_facility').annotations.readOnlyHint, false);
    assert.deepEqual([...PHASES], EVERY_PAGE_STATE);
    for (const tool of operatorTools) {
      assert.deepEqual([...tool.availableIn], EVERY_PAGE_STATE, `${tool.name} is missing a page state`);
    }
  });

  test('offers both lifts to the outage tool and to the restore tool', () => {
    const lifts = Object.values(newStore().snapshot().resources).filter((resource) => resource.kind === 'FACILITY');
    const liftIds = lifts.map((resource) => resource.id);

    assert.deepEqual(liftIds, ['east-lift', 'garden-lift']);
    // A lift is switched by an operator, never booked by a visitor. If one ever
    // became reservable it would show up in a bundle and be double-managed.
    for (const lift of lifts) {
      assert.equal(lift.reservable, false, `${lift.id} must not be reservable`);
      assert.equal(lift.status, 'OPERATIONAL');
    }
    assert.deepEqual(byName.get('report_facility_outage').inputSchema.properties.facilityId.enum, liftIds);
    assert.deepEqual(byName.get('restore_facility').inputSchema.properties.facilityId.enum, liftIds);
    assert.deepEqual(byName.get('report_facility_outage').inputSchema.required, ['facilityId', 'reasonCode']);
    assert.deepEqual(byName.get('restore_facility').inputSchema.required, ['facilityId']);
  });

  test('offers exactly the reason codes the venue will accept', () => {
    const store = newStore();
    let allowedByVenue = null;
    assert.throws(
      () => store.setFacilityOutage('east-lift', 'NOT_A_REASON'),
      (error) => {
        assert.equal(error.code, 'INVALID_OUTAGE_REASON');
        allowedByVenue = error.details.allowedReasonCodes;
        return true;
      },
    );

    assert.deepEqual(allowedByVenue, OUTAGE_REASON_CODES);
    assert.deepEqual(byName.get('report_facility_outage').inputSchema.properties.reasonCode.enum, allowedByVenue);
    for (const reasonCode of allowedByVenue) {
      const fresh = newStore();
      assert.equal(fresh.setFacilityOutage('east-lift', reasonCode).resources['east-lift'].status, 'OUT_OF_SERVICE');
    }
  });

  test('passes the published tool-authoring contract with no problems', () => {
    assert.deepEqual(checkToolContract(operatorTools, 'venue operations'), []);
  });

  test('drives every lift the venue has from the human operator page', () => {
    // This was pinned, not endorsed: the WebMCP tools above reached both lifts
    // while the operator page's own buttons posted to east-lift paths only, so
    // a human could not arm, fault or restore the Garden Lift from the page an
    // operator is actually given. The agent had a capability the person did not
    // — the same asymmetry the visitor page had with clear_access_plan.
    //
    // The controls follow a facility selector now, so what is asserted is that
    // no facility is left unreachable, and that the endpoints are built from
    // the selection rather than naming one lift.
    const source = readFileSync(new URL('../../public/operator.js', import.meta.url), 'utf8');
    const markup = readFileSync(new URL('../../public/operator.html', import.meta.url), 'utf8');

    const literalIds = new Set(
      [...source.matchAll(/\/api\/operator\/facilities\/([a-z0-9-]+)\//g)].map((match) => match[1]),
    );
    assert.deepEqual(
      [...literalIds],
      [],
      `the operator page still hardcodes facility ids in its endpoints: ${[...literalIds].join(', ')}`,
    );
    // This used to require the literal source text `${selectedFacility()}` inside
    // the URL. That pinned the exact second read of the selector which has since
    // been removed: the URL is now built from the id captured in the same tick as
    // the toast, through public/views.mjs::operatorEndpoint, so the path, the
    // sentence and the facility that changes cannot be three different lifts.
    assert.match(source, /operatorEndpoint\(/, 'the page no longer builds its endpoints through one function');

    // The two checks above are each satisfied by one good endpoint. Freezing a
    // single control - outage, say - while arm and restore stay parameterised
    // passes the second, and passes the first as soon as the frozen id is held
    // in a constant rather than written into the path. So the endpoints are
    // discovered on both sides and matched one for one.
    //
    // Server side: every operator facility route the server actually answers,
    // read from the route patterns themselves rather than listed here, so a
    // fourth route cannot be added there and left frozen on the page.
    // Backslashes are stripped first, so the scan does not depend on how the
    // route regex chose to escape its slashes.
    const serverSource = readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8').replace(/\\/g, '');
    const exposed = [...new Set(
      [...serverSource.matchAll(/\/api\/operator\/facilities\/.+?\/([a-z][a-z0-9-]*)\$/g)].map((match) => match[1]),
    )].sort();
    assert.ok(exposed.length > 0, 'no operator facility route was discovered in server.mjs; this guard would prove nothing');

    // Page side: every call site, in whatever quote or template form it is
    // written. What is captured is the facility segment exactly as authored, so
    // a bare id, a frozen constant and an interpolated expression are all
    // visible. A segment built by concatenation breaks the path apart and
    // disappears from this list - the one-for-one check below catches that.
    const wired = [...source.matchAll(/operatorEndpoint\(\s*([^,]+?)\s*,\s*['"]([a-z][a-z0-9-]*)['"]\s*\)/g)]
      .map((match) => ({ segment: match[1], action: match[2] }));

    // The facility must come from a binding, not from a quoted id. A literal in
    // that position is the defect this page has been repaired for three times,
    // in both quote styles.
    const frozen = wired
      .filter(({ segment }) => /^['"`]/.test(segment.trim()))
      .map(({ action, segment }) => `${action} (posts to ${segment})`);
    assert.deepEqual(
      frozen,
      [],
      `these operator endpoints no longer follow the facility selector: ${frozen.join('; ')}`,
    );

    // Every handler must read the selection, not a name decided when the line
    // was written. Freezing `const actedOn = 'east-lift'` - or the same thing in
    // double quotes - survived the whole gate: the endpoint check above sees a
    // binding in the facility position and is satisfied, because the literal
    // moved one line up.
    const captures = [...source.matchAll(/const actedOn = ([^;]+);/g)].map((match) => match[1].trim());
    assert.ok(captures.length >= 3, `expected each operator handler to capture the selection, found ${captures.length}`);
    const frozenCaptures = captures.filter((expression) => /^['"`]/.test(expression));
    assert.deepEqual(
      frozenCaptures,
      [],
      `these handlers act on a facility decided in the source: ${frozenCaptures.join(', ')}`,
    );

    const wiredActions = [...new Set(wired.map(({ action }) => action))].sort();
    assert.deepEqual(
      wiredActions,
      exposed,
      'every operator facility route the server exposes must be posted to from the page as one readable path: '
      + `server exposes ${exposed.join(', ')}; the page wires ${wiredActions.join(', ') || 'nothing'}`,
    );

    const facilities = ['east-lift', 'garden-lift'];
    const unreachable = facilities.filter((id) => !`${markup}\n${source}`.includes(id));
    assert.deepEqual(unreachable, [], `no control reaches: ${unreachable.join(', ')}`);

    // And the module that builds those URLs must know exactly the actions the
    // server answers - no more, no less. Adding a fourth to the list with no
    // route behind it changed nothing anywhere and survived the whole gate.
    assert.deepEqual(
      [...OPERATOR_ACTIONS].sort(),
      exposed,
      `public/views.mjs registers ${[...OPERATOR_ACTIONS].sort().join(', ')} `
      + `while the server exposes ${exposed.join(', ')}`,
    );
  });
});
