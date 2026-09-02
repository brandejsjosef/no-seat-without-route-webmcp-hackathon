import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore, DomainError, demoDefaults } from '../lib/domain.mjs';

function freshStore() {
  let id = 0;
  let time = Date.parse('2026-08-27T19:01:54.000Z');
  return createDemoStore({
    idFactory: () => String(++id).padStart(4, '0'),
    clock: () => (time += 1_000),
  });
}

function prepareInitial(store, requirements = demoDefaults) {
  const plan = store.findBundle(requirements);
  return store.stageBundle(plan.id, plan.basedOnResourceVersion);
}

function causeStaleCommit(store, plan) {
  store.armOutage('east-lift');
  const confirmation = store.prepareConfirmation(plan.id);
  assert.throws(
    () => store.commitBundle({
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
      requestId: 'old-plan-click',
    }),
    (error) => error instanceof DomainError && error.code === 'STALE_RESOURCE_VERSION' && error.details.partialReservations === 0,
  );
}

test('initial plan contains a complete route, seats, lift and assistance', () => {
  const store = freshStore();
  const plan = store.findBundle(demoDefaults);
  assert.equal(plan.routeId, 'east-lift-route');
  assert.deepEqual(
    plan.claims.map((claim) => claim.resourceId),
    ['east-lift', 'space-w12', 'seat-w13', 'assist-east-1905'],
  );
  assert.equal(plan.route.distanceM, 64);
  assert.equal(plan.route.minWidthCm >= demoDefaults.wheelchairWidthCm, true);
});

test('finding and staging a plan reserve no resource', () => {
  const store = freshStore();
  const plan = prepareInitial(store);
  const snapshot = store.snapshot();
  assert.equal(plan.status, 'STAGED');
  assert.equal(snapshot.atomicity.bookingCount, 0);
  assert.equal(snapshot.atomicity.reservedResourceCount, 0);
  assert.equal(snapshot.resources['space-w12'].status, 'AVAILABLE');
  assert.equal(snapshot.resources['seat-w13'].status, 'AVAILABLE');
});

test('outage during confirmation rejects old revision with zero partial writes', () => {
  const store = freshStore();
  const plan = prepareInitial(store);
  causeStaleCommit(store, plan);

  const snapshot = store.snapshot();
  assert.equal(snapshot.phase, 'PLAN_STALE');
  assert.equal(snapshot.resourceVersion, 2);
  assert.equal(snapshot.resources['east-lift'].status, 'OUT_OF_SERVICE');
  assert.equal(snapshot.atomicity.bookingCount, 0);
  assert.equal(snapshot.atomicity.reservedResourceCount, 0);
  assert.equal(snapshot.audit.at(-1).action, 'COMMIT_REJECTED_STALE');
  assert.equal(snapshot.audit.at(-1).resourceVersionBefore, snapshot.audit.at(-1).resourceVersionAfter);
});

test('replan excludes failed lift and stages a complete alternative', () => {
  const store = freshStore();
  const initial = prepareInitial(store);
  causeStaleCommit(store, initial);
  const replacement = store.replanBundle(initial.id);

  assert.equal(replacement.routeId, 'garden-lift-route');
  assert.equal(replacement.kind, 'REPLACEMENT');
  assert.equal(replacement.status, 'STAGED');
  assert.equal(replacement.supersedesPlanId, initial.id);
  assert.equal(replacement.claims.some((claim) => claim.resourceId === 'east-lift'), false);
  assert.equal(replacement.claims.some((claim) => claim.resourceId === 'garden-lift'), true);
  assert.equal(store.snapshot().atomicity.reservedResourceCount, 0);
});

test('commit requires explicit acceptance', () => {
  const store = freshStore();
  const plan = prepareInitial(store);
  const confirmation = store.prepareConfirmation(plan.id);
  assert.throws(
    () => store.commitBundle({
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: false,
      requestId: 'not-accepted',
    }),
    (error) => error instanceof DomainError && error.code === 'HUMAN_CONFIRMATION_REQUIRED',
  );
  assert.equal(store.snapshot().atomicity.reservedResourceCount, 0);
});

test('replacement commit reserves the complete bundle exactly once', () => {
  const store = freshStore();
  const initial = prepareInitial(store);
  causeStaleCommit(store, initial);
  const replacement = store.replanBundle(initial.id);
  const confirmation = store.prepareConfirmation(replacement.id);
  const command = {
    planId: replacement.id,
    confirmationId: confirmation.confirmationId,
    expectedResourceVersion: confirmation.expectedResourceVersion,
    accepted: true,
    requestId: 'replacement-click',
  };

  const first = store.commitBundle(command);
  const second = store.commitBundle(command);
  const snapshot = store.snapshot();

  assert.equal(first.ok, true);
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(second.booking.id, first.booking.id);
  assert.equal(snapshot.atomicity.bookingCount, 1);
  assert.equal(snapshot.atomicity.reservedResourceCount, 3);
  assert.equal(snapshot.resources['space-w12'].reservedBy, first.booking.id);
  assert.equal(snapshot.resources['seat-w13'].reservedBy, first.booking.id);
  assert.equal(snapshot.resources['assist-garden-1903'].reservedBy, first.booking.id);
  assert.equal(snapshot.resources['east-lift'].reservedBy, undefined);
  assert.equal(snapshot.resources['garden-lift'].reservedBy, undefined);
  assert.equal(snapshot.activePlan.status, 'COMMITTED');
  assert.equal(snapshot.activePlan.stale, false);
  assert.throws(
    () => store.commitBundle({ ...command, requestId: 'second-distinct-click' }),
    (error) => error instanceof DomainError && error.code === 'PLAN_ALREADY_COMMITTED',
  );
  assert.equal(store.snapshot().activePlan.status, 'COMMITTED');
});

test('a new search after confirmation reports the booking, not an unfinishable plan', () => {
  const store = freshStore();
  const plan = prepareInitial(store);
  const confirmation = store.prepareConfirmation(plan.id);
  store.commitBundle({
    planId: plan.id,
    confirmationId: confirmation.confirmationId,
    expectedResourceVersion: confirmation.expectedResourceVersion,
    accepted: true,
    requestId: 'confirmed-search-refusal',
  });
  const before = store.snapshot();

  assert.throws(
    () => store.findBundle(demoDefaults),
    (error) => error instanceof DomainError && error.code === 'BOOKING_ALREADY_EXISTS',
  );
  assert.deepEqual(store.snapshot(), before);
});

test('missing distance feasibility fails without writing a partial plan', () => {
  const store = freshStore();
  assert.throws(
    () => store.findBundle({ ...demoDefaults, maxDistanceM: 50 }),
    (error) => error instanceof DomainError && error.code === 'NO_COMPLETE_BUNDLE',
  );
  const snapshot = store.snapshot();
  assert.equal(snapshot.activePlan, null);
  assert.equal(snapshot.atomicity.bookingCount, 0);
});

test('a missing assistance resource prevents the whole bundle', () => {
  const store = freshStore();
  store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');
  store.setResourceUnavailable('assist-garden-1903', 'HOST_UNAVAILABLE');
  assert.throws(
    () => store.findBundle(demoDefaults),
    (error) => error instanceof DomainError && error.code === 'NO_COMPLETE_BUNDLE',
  );
  assert.equal(store.snapshot().atomicity.reservedResourceCount, 0);
});

test('a second active plan cannot replace the plan being reviewed', () => {
  const store = freshStore();
  const first = prepareInitial(store);
  assert.throws(
    () => store.findBundle(demoDefaults),
    (error) => error instanceof DomainError && error.code === 'ACTIVE_PLAN_EXISTS' && error.details.activePlanId === first.id,
  );
  assert.equal(store.snapshot().activePlan.id, first.id);
});

test('idempotency key is bound to one normalized confirmation command', () => {
  const store = freshStore();
  const plan = prepareInitial(store);
  const confirmation = store.prepareConfirmation(plan.id);
  const command = {
    planId: plan.id,
    confirmationId: confirmation.confirmationId,
    expectedResourceVersion: confirmation.expectedResourceVersion,
    accepted: true,
    requestId: 'one-command',
  };
  store.commitBundle(command);
  assert.throws(
    () => store.commitBundle({ ...command, accepted: false }),
    (error) => error instanceof DomainError && error.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.throws(
    () => store.commitBundle({ ...command, requestId: '__proto__' }),
    (error) => error instanceof DomainError && error.code === 'REQUEST_ID_REQUIRED',
  );
  assert.equal(store.snapshot().atomicity.bookingCount, 1);
});

test('no alternative becomes a persistent state and can be cleared for editing', () => {
  const store = freshStore();
  const constrained = prepareInitial(store, { ...demoDefaults, maxDistanceM: 65 });
  causeStaleCommit(store, constrained);
  assert.throws(
    () => store.replanBundle(constrained.id),
    (error) => error instanceof DomainError && error.code === 'NO_COMPLETE_BUNDLE' && error.details.nextAction === 'CHANGE_REQUIREMENTS',
  );
  assert.equal(store.snapshot().phase, 'NO_ALTERNATIVE');
  store.clearPlan(constrained.id);
  assert.equal(store.snapshot().phase, 'READY');
  const wider = store.findBundle({ ...demoDefaults, maxDistanceM: 80 });
  assert.equal(wider.routeId, 'garden-lift-route');
});

test('route and receipt data omit an unrequested companion seat', () => {
  const store = freshStore();
  const plan = prepareInitial(store, { ...demoDefaults, companionCount: 0, entranceAssistance: false });
  assert.equal(plan.route.path.at(-1), 'W12');
  assert.equal(plan.claims.some((claim) => claim.resourceId === 'seat-w13'), false);
  assert.equal(plan.claims.some((claim) => claim.role === 'ENTRANCE_ASSISTANCE'), false);
});

test('reset restores resources and makes old plan identifiers unusable', () => {
  const store = freshStore();
  const plan = prepareInitial(store);
  const oldRun = store.snapshot().runId;
  store.reset();
  const snapshot = store.snapshot();
  assert.notEqual(snapshot.runId, oldRun);
  assert.equal(snapshot.resources['east-lift'].status, 'OPERATIONAL');
  assert.throws(
    () => store.stageBundle(plan.id, snapshot.resourceVersion),
    (error) => error instanceof DomainError && error.code === 'PLAN_NOT_FOUND',
  );
});

test('free-text diagnosis is rejected instead of stored', () => {
  const store = freshStore();
  assert.throws(
    () => store.findBundle({ ...demoDefaults, diagnosis: 'private medical text' }),
    (error) => error instanceof DomainError && error.code === 'UNSUPPORTED_REQUIREMENT',
  );
  assert.equal(JSON.stringify(store.snapshot()).includes('private medical text'), false);
});
