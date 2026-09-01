/**
 * Acceptance suite: the booking lifecycle and atomicity.
 *
 * These are the checks a person makes by using the page rather than by reading
 * the code. Every one of them counts resources before and after the call, so
 * "all or nothing" is a number the suite measures, not a promise it repeats.
 *
 * Everything here runs against the real store from lib/domain.mjs with an
 * injected clock and a counting id factory, so no test depends on wall-clock
 * time, a random id, a port or a network.
 *
 * Four blocks below deliberately pin behaviour that looks wrong: the two
 * defects are a request id that binds only on success, and a client-supplied
 * wrong revision that burns a plan no venue change had invalidated. They are
 * marked OBSERVED DEFECT and are reported to a human rather than fixed here.
 * If you repair the product, expect these to fail and flip them.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDemoStore, DomainError, demoDefaults } from '../../lib/domain.mjs';
import { createVisitorTools, toolsForPhase, toolCounts } from '../../public/tools.mjs';

/** Frozen instant. Any Date.now() creeping into the domain breaks a test below. */
const FIXED_INSTANT = '2026-08-30T18:00:00.000Z';

/** The whole bundle a default visitor holds once a booking commits. */
const FULL_BUNDLE_HELD = ['assist-east-1905', 'seat-w13', 'space-w12'];

function freshStore() {
  let issued = 0;
  return createDemoStore({
    clock: () => Date.parse(FIXED_INSTANT),
    idFactory: () => `id-${++issued}`,
  });
}

/** The resources actually held right now, sorted so the count is comparable. */
function heldResourceIds(store) {
  return Object.values(store.snapshot().resources)
    .filter((resource) => resource.status === 'RESERVED')
    .map((resource) => resource.id)
    .sort();
}

function stagedPlan(store, requirements = demoDefaults) {
  const proposed = store.findBundle(requirements);
  return store.stageBundle(proposed.id, proposed.basedOnResourceVersion);
}

/** The exact command the confirm button sends, for a plan the visitor is reviewing. */
function confirmationCommand(store, plan, requestId) {
  const confirmation = store.prepareConfirmation(plan.id);
  return {
    planId: plan.id,
    confirmationId: confirmation.confirmationId,
    expectedResourceVersion: confirmation.expectedResourceVersion,
    accepted: true,
    requestId,
  };
}

/** Runs a call that must be refused and hands back the refusal to inspect. */
function refusalFrom(call) {
  try {
    call();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new assert.AssertionError({ message: 'Expected a DomainError refusal, but the call succeeded.' });
}

/** Books the default bundle and returns everything a later assertion needs. */
function bookedStore(requestId = 'visitor-confirm-click') {
  const store = freshStore();
  const plan = stagedPlan(store);
  const command = confirmationCommand(store, plan, requestId);
  const result = store.commitBundle(command);
  return { store, plan, command, booking: result.booking };
}

describe('confirming the same plan twice', () => {
  test('the same confirmation click sent twice produces exactly one booking', () => {
    const store = freshStore();
    const plan = stagedPlan(store);
    const command = confirmationCommand(store, plan, 'double-click');
    assert.deepEqual(heldResourceIds(store), []);

    const first = store.commitBundle(command);
    const heldAfterFirst = heldResourceIds(store);
    const second = store.commitBundle(command);

    assert.equal(first.ok, true);
    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    assert.equal(second.booking.id, first.booking.id);
    assert.deepEqual(heldAfterFirst, FULL_BUNDLE_HELD);
    assert.deepEqual(heldResourceIds(store), FULL_BUNDLE_HELD);
    assert.equal(store.snapshot().atomicity.bookingCount, 1);
  });

  test('the replay hands back the first receipt untouched rather than issuing a second', () => {
    const store = freshStore();
    const plan = stagedPlan(store);
    const command = confirmationCommand(store, plan, 'impatient-visitor');

    const first = store.commitBundle(command);
    const second = store.commitBundle(command);

    assert.deepEqual(second.booking, first.booking);
    // Read the receipt back off the venue, not off the returned copy: a second
    // booking record would show up here even if the replay handed back a clone.
    assert.equal(store.snapshot().booking.receipt, first.booking.receipt);
    assert.equal(store.snapshot().atomicity.bookingCount, 1);
    assert.equal(store.snapshot().resourceVersion, first.booking.committedResourceVersion);
  });

  test('confirming a bundle moves the venue revision on by exactly one', () => {
    const store = freshStore();
    const plan = stagedPlan(store);
    const revisionBefore = store.snapshot().resourceVersion;
    const command = confirmationCommand(store, plan, 'revision-step');

    store.commitBundle(command);
    const afterCommit = store.snapshot().resourceVersion;
    store.commitBundle(command);

    assert.equal(afterCommit, revisionBefore + 1);
    assert.equal(store.snapshot().resourceVersion, afterCommit);
  });

  test('a second confirmation click carrying a fresh request id is refused as already committed', () => {
    const { store, command } = bookedStore('first-click');
    const heldBefore = heldResourceIds(store);
    const revisionBefore = store.snapshot().resourceVersion;

    const error = refusalFrom(() => store.commitBundle({ ...command, requestId: 'second-click' }));

    assert.equal(error.code, 'PLAN_ALREADY_COMMITTED');
    assert.equal(error.status, 409);
    assert.deepEqual(heldBefore, FULL_BUNDLE_HELD);
    assert.deepEqual(heldResourceIds(store), FULL_BUNDLE_HELD);
    assert.equal(store.snapshot().atomicity.bookingCount, 1);
    assert.equal(store.snapshot().resourceVersion, revisionBefore);
  });
});

describe('a refused confirmation holds nothing back', () => {
  test('a confirmation quoting an unknown confirmation id is refused and reserves nothing', () => {
    const store = freshStore();
    const plan = stagedPlan(store);
    const command = confirmationCommand(store, plan, 'forged-confirmation');
    const heldBefore = heldResourceIds(store);

    const error = refusalFrom(() => store.commitBundle({ ...command, confirmationId: 'confirm-not-issued' }));

    assert.equal(error.code, 'INVALID_CONFIRMATION');
    assert.equal(error.status, 428);
    assert.deepEqual(heldBefore, []);
    assert.deepEqual(heldResourceIds(store), []);
    assert.equal(store.snapshot().atomicity.bookingCount, 0);
    assert.equal(store.snapshot().activePlan.status, 'STAGED');
    assert.equal(store.snapshot().phase, 'AWAITING_HUMAN_CONFIRMATION');
  });

  test('a lift failing mid-confirmation refuses the booking and counts zero partial reservations', () => {
    const store = freshStore();
    const plan = stagedPlan(store);
    store.armOutage('east-lift');
    const command = confirmationCommand(store, plan, 'outage-during-click');
    const heldBefore = heldResourceIds(store);

    const error = refusalFrom(() => store.commitBundle(command));

    assert.equal(error.code, 'STALE_RESOURCE_VERSION');
    assert.equal(error.status, 409);
    assert.equal(error.details.partialReservations, 0);
    assert.equal(error.details.planResourceVersion, plan.basedOnResourceVersion);
    assert.equal(error.details.currentResourceVersion, plan.basedOnResourceVersion + 1);
    assert.equal(error.details.nextAction, 'REPLAN');
    assert.deepEqual(heldBefore, []);
    assert.deepEqual(heldResourceIds(store), []);
    assert.equal(store.snapshot().atomicity.bookingCount, 0);
    assert.equal(store.snapshot().resources['east-lift'].status, 'OUT_OF_SERVICE');
  });

  test('a customer declining the plan leaves the venue byte-for-byte unchanged', () => {
    const store = freshStore();
    const plan = stagedPlan(store);
    const command = confirmationCommand(store, plan, 'declined-click');
    const before = store.snapshot();

    const error = refusalFrom(() => store.commitBundle({ ...command, accepted: false }));

    assert.equal(error.code, 'HUMAN_CONFIRMATION_REQUIRED');
    assert.equal(error.status, 428);
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual(heldResourceIds(store), []);
    assert.equal(store.snapshot().atomicity.bookingCount, 0);
  });

  test('an acceptance that is merely truthy is not an acceptance', () => {
    const store = freshStore();
    const plan = stagedPlan(store);
    const command = confirmationCommand(store, plan, 'truthy-accept');

    // One request id per attempt. They used to share one, which was harmless
    // while a refusal left the id unrecorded; now that a refusal binds it, a
    // second attempt under the same id is an IDEMPOTENCY_CONFLICT and this
    // would stop testing what it is named for.
    for (const [index, accepted] of ['true', 1, undefined].entries()) {
      const error = refusalFrom(() => store.commitBundle({
        ...command,
        accepted,
        requestId: `truthy-accept-${index}`,
      }));
      assert.equal(error.code, 'HUMAN_CONFIRMATION_REQUIRED');
    }

    assert.deepEqual(heldResourceIds(store), []);
    assert.equal(store.snapshot().atomicity.bookingCount, 0);
  });

  test('a confirmation for a plan the visitor already cleared is refused as missing', () => {
    const store = freshStore();
    const plan = stagedPlan(store);
    const command = confirmationCommand(store, plan, 'confirm-after-clear');
    store.clearPlan(plan.id);
    const revisionBefore = store.snapshot().resourceVersion;

    const error = refusalFrom(() => store.commitBundle(command));

    assert.equal(error.code, 'PLAN_NOT_FOUND');
    assert.equal(error.status, 404);
    assert.equal(store.snapshot().phase, 'READY');
    assert.equal(store.snapshot().activePlan, null);
    assert.deepEqual(heldResourceIds(store), []);
    assert.equal(store.snapshot().atomicity.bookingCount, 0);
    assert.equal(store.snapshot().resourceVersion, revisionBefore);
  });

  test('a confirmation with no request id is refused before anything could be reserved', () => {
    const store = freshStore();
    const plan = stagedPlan(store);
    const command = confirmationCommand(store, plan, 'placeholder');
    const before = store.snapshot();

    const error = refusalFrom(() => store.commitBundle({ ...command, requestId: undefined }));

    assert.equal(error.code, 'REQUEST_ID_REQUIRED');
    assert.equal(error.status, 422);
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual(heldResourceIds(store), []);
  });

  test('a request id outside the permitted alphabet books nothing', () => {
    const store = freshStore();
    const plan = stagedPlan(store);
    const command = confirmationCommand(store, plan, 'placeholder');

    for (const requestId of ['', 'has a space', '__proto__', 'constructor', 'prototype', 'x'.repeat(101), 42]) {
      const error = refusalFrom(() => store.commitBundle({ ...command, requestId }));
      assert.equal(error.code, 'REQUEST_ID_REQUIRED');
      assert.deepEqual(heldResourceIds(store), []);
    }

    assert.equal(store.snapshot().atomicity.bookingCount, 0);
  });

  test('an unreadable venue revision is treated as a mismatch, not as a match', () => {
    const store = freshStore();
    const plan = stagedPlan(store);
    const command = confirmationCommand(store, plan, 'garbage-revision');

    const error = refusalFrom(() => store.commitBundle({ ...command, expectedResourceVersion: 'not-a-number' }));

    // Still a mismatch rather than a match - that is what this test is for.
    // What changed is which refusal it is: a number the caller got wrong is not
    // a venue change, and reporting it as one burnt a plan nothing had
    // invalidated.
    assert.equal(error.code, 'EXPECTED_RESOURCE_VERSION_MISMATCH');
    assert.equal(error.details.partialReservations, 0);
    assert.deepEqual(heldResourceIds(store), []);
    assert.equal(store.snapshot().atomicity.bookingCount, 0);
    assert.equal(store.snapshot().activePlan.status, 'STAGED', 'unreadable input burnt the plan');
  });
});

describe('once a booking exists', () => {
  test('searching for a new plan is refused and the booking is left alone', () => {
    const { store } = bookedStore();
    const before = store.snapshot();

    const error = refusalFrom(() => store.findBundle(demoDefaults));

    assert.equal(error.code, 'BOOKING_ALREADY_EXISTS');
    assert.equal(error.status, 409);
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual(heldResourceIds(store), FULL_BUNDLE_HELD);
    assert.equal(store.snapshot().atomicity.bookingCount, 1);
  });

  test('replanning is refused because a committed plan is not a stale one', () => {
    const { store, plan } = bookedStore();
    const heldBefore = heldResourceIds(store);

    const error = refusalFrom(() => store.replanBundle(plan.id));

    assert.equal(error.code, 'PLAN_NOT_STALE');
    assert.equal(error.status, 409);
    assert.deepEqual(heldResourceIds(store), heldBefore);
    assert.equal(store.snapshot().atomicity.bookingCount, 1);
    assert.equal(store.snapshot().phase, 'CONFIRMED');
  });

  test('clearing the confirmed plan is refused so a booking cannot be dropped through the back door', () => {
    const { store, plan, booking } = bookedStore();

    const error = refusalFrom(() => store.clearPlan(plan.id));

    assert.equal(error.code, 'PLAN_ALREADY_COMMITTED');
    assert.equal(error.status, 409);
    assert.deepEqual(heldResourceIds(store), FULL_BUNDLE_HELD);
    assert.equal(store.snapshot().atomicity.bookingCount, 1);
    assert.equal(store.snapshot().booking.id, booking.id);
    assert.equal(store.snapshot().activePlan.id, plan.id);
  });

  test('staging the confirmed plan again is refused', () => {
    const { store, plan } = bookedStore();
    const revision = store.snapshot().resourceVersion;

    const error = refusalFrom(() => store.stageBundle(plan.id, revision));

    assert.equal(error.code, 'PLAN_NOT_STAGEABLE');
    assert.equal(error.status, 409);
    assert.deepEqual(heldResourceIds(store), FULL_BUNDLE_HELD);
    assert.equal(store.snapshot().atomicity.bookingCount, 1);
  });

  test('no agent tool is registered that could book or re-book; every confirmed-phase tool only reads', () => {
    const tools = createVisitorTools({ api: async () => ({}), refresh: async () => ({}) });
    const confirmedPhaseTools = toolsForPhase(tools, 'CONFIRMED');
    const writeTools = tools.filter((tool) => tool.annotations.readOnlyHint !== true);

    assert.deepEqual(
      confirmedPhaseTools.map((tool) => tool.name).sort(),
      ['check_access_route', 'get_access_bundle_status', 'get_event_access_state', 'list_access_options'],
    );
    assert.equal(toolCounts(confirmedPhaseTools).write, 0);
    // Pin the whole write set, so a newly added confirming tool has to be
    // declared here before it can reach any phase.
    assert.deepEqual(writeTools.map((tool) => tool.name).sort(), [
      'clear_access_plan',
      'find_access_bundle',
      'replan_access_bundle',
      'stage_access_bundle',
    ]);
    for (const tool of writeTools) {
      assert.equal(tool.availableIn.includes('CONFIRMED'), false, `${tool.name} is offered after confirmation`);
    }
  });
});

describe('the receipt', () => {
  test('the receipt carries exactly the documented fields and no others', () => {
    const { booking } = bookedStore();

    assert.deepEqual(Object.keys(booking).sort(), [
      'committedResourceVersion',
      'confirmedAt',
      'id',
      'partialReservations',
      'planId',
      'receipt',
      'requirements',
      'resourceIds',
      'resourceLabels',
      'route',
      'routeId',
    ]);
    assert.match(booking.receipt, /^NSWR-\d{5}$/);
    assert.equal(booking.planId, 'plan-id-1');
    assert.equal(booking.routeId, 'east-lift-route');
  });

  test('the committed revision is exactly one past the revision the plan was built on', () => {
    const { store, plan, booking } = bookedStore();

    assert.equal(plan.basedOnResourceVersion, 1);
    assert.equal(booking.committedResourceVersion, plan.basedOnResourceVersion + 1);
    assert.equal(store.snapshot().resourceVersion, booking.committedResourceVersion);
  });

  test('a replacement plan built after an outage commits one past its own revision, not the original one', () => {
    const store = freshStore();
    const original = stagedPlan(store);
    store.armOutage('east-lift');
    refusalFrom(() => store.commitBundle(confirmationCommand(store, original, 'outage-click')));

    const replacement = store.replanBundle(original.id);
    const result = store.commitBundle(confirmationCommand(store, replacement, 'replacement-click'));

    assert.equal(original.basedOnResourceVersion, 1);
    assert.equal(replacement.basedOnResourceVersion, 2);
    assert.equal(result.booking.committedResourceVersion, 3);
    assert.equal(result.booking.routeId, 'garden-lift-route');
    assert.deepEqual(heldResourceIds(store), ['assist-garden-1903', 'seat-w13', 'space-w12']);
  });

  test('the receipt names exactly the resources the plan claimed, in the order the plan named them', () => {
    const { store, plan, booking } = bookedStore();

    assert.deepEqual(booking.resourceIds, plan.claims.map((claim) => claim.resourceId));
    assert.deepEqual(booking.resourceIds, ['east-lift', 'space-w12', 'seat-w13', 'assist-east-1905']);
    assert.deepEqual(
      booking.resourceLabels,
      booking.resourceIds.map((id) => store.snapshot().resources[id].label),
    );
  });

  test('only the consumable claims are held; the lift is travelled through, not reserved', () => {
    const { store, plan, booking } = bookedStore();
    const consumable = plan.claims.filter((claim) => claim.consume).map((claim) => claim.resourceId).sort();

    assert.deepEqual(heldResourceIds(store), consumable);
    assert.deepEqual(heldResourceIds(store), FULL_BUNDLE_HELD);
    assert.equal(booking.resourceIds.includes('east-lift'), true);
    assert.equal(store.snapshot().resources['east-lift'].status, 'OPERATIONAL');
    assert.equal(store.snapshot().resources['east-lift'].reservedBy, undefined);
    for (const id of consumable) {
      assert.equal(store.snapshot().resources[id].reservedBy, booking.id);
    }
  });

  test('the success path reports zero partial reservations while genuinely holding three resources', () => {
    const { store, booking } = bookedStore();

    assert.equal(booking.partialReservations, 0);
    assert.equal(heldResourceIds(store).length, 3);
    assert.equal(store.snapshot().atomicity.reservedResourceCount, 3);
  });

  test('a visitor travelling without a companion holds one resource and the receipt says only that', () => {
    const store = freshStore();
    const plan = stagedPlan(store, { ...demoDefaults, companionCount: 0, entranceAssistance: false });
    const result = store.commitBundle(confirmationCommand(store, plan, 'solo-visitor'));

    assert.deepEqual(result.booking.resourceIds, ['east-lift', 'space-w12']);
    assert.deepEqual(result.booking.resourceLabels, ['East Lift L2', 'Wheelchair space W12']);
    assert.deepEqual(heldResourceIds(store), ['space-w12']);
    assert.equal(result.booking.partialReservations, 0);
    assert.equal(result.booking.route.path.at(-1), 'W12');
    assert.equal(store.snapshot().resources['seat-w13'].status, 'AVAILABLE');
    assert.equal(store.snapshot().resources['assist-east-1905'].status, 'AVAILABLE');
  });

  test('the confirmation time on the receipt comes from the injected clock, never from the wall clock', () => {
    const { booking } = bookedStore();

    assert.equal(booking.confirmedAt, FIXED_INSTANT);
  });
});

describe('an idempotency key is bound to one normalised command', () => {
  test('the same request id carrying a different revision is refused as a conflict', () => {
    const { store, command } = bookedStore('one-command-only');

    const error = refusalFrom(() => store.commitBundle({ ...command, expectedResourceVersion: 99 }));

    assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(error.status, 409);
    assert.equal(store.snapshot().atomicity.bookingCount, 1);
    assert.deepEqual(heldResourceIds(store), FULL_BUNDLE_HELD);
  });

  test('the same request id naming a different plan is refused before that plan is even looked up', () => {
    const { store, command } = bookedStore('bound-to-one-plan');

    const error = refusalFrom(() => store.commitBundle({ ...command, planId: 'plan-that-does-not-exist' }));

    // A plan lookup running first would answer PLAN_NOT_FOUND with status 404.
    assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(error.status, 409);
    assert.equal(store.snapshot().atomicity.bookingCount, 1);
    assert.deepEqual(heldResourceIds(store), FULL_BUNDLE_HELD);
  });

  test('the same request id with the revision written as text is still the same command', () => {
    const { store, command, booking } = bookedStore('normalised-revision');

    const replay = store.commitBundle({
      ...command,
      expectedResourceVersion: String(command.expectedResourceVersion),
    });

    assert.equal(replay.idempotent, true);
    assert.deepEqual(replay.booking, booking);
    assert.equal(store.snapshot().atomicity.bookingCount, 1);
    assert.deepEqual(heldResourceIds(store), FULL_BUNDLE_HELD);
  });

  test('a request id is bound on the first execution, refusal included', () => {
    const store = freshStore();
    const plan = stagedPlan(store);
    const command = confirmationCommand(store, plan, 'reused-after-refusal');

    refusalFrom(() => store.commitBundle({ ...command, accepted: false }));

    // This pinned the defect: only a successful commit recorded the request id,
    // so the very same id could carry different content later and be accepted
    // rather than refused. A failed attempt must not become a different
    // successful command under one id.
    const conflict = refusalFrom(() => store.commitBundle(command));

    assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(store.snapshot().atomicity.bookingCount, 0);
    assert.deepEqual(heldResourceIds(store), []);

    // And a fresh id still works, so this is a conflict rather than a lockout.
    const committed = store.commitBundle({ ...command, requestId: 'a-different-id' });
    assert.equal(committed.ok, true);
    assert.equal(store.snapshot().atomicity.bookingCount, 1);
    assert.deepEqual(heldResourceIds(store), FULL_BUNDLE_HELD);
  });
});

describe('a wrong revision number sent by a client', () => {
  // These four cases pinned a defect rather than a contract: a stale browser
  // tab, a retry with a remembered number or a typo produced
  // STALE_RESOURCE_VERSION and pushed a plan nothing had invalidated to STALE.
  // The refusal then reported two identical revisions, an empty broken-rule
  // list and offered back the route the plan was already holding, because the
  // venue had not moved at all. They are positive regressions now.
  test('does not burn a plan that no venue change had invalidated', () => {
    const store = freshStore();
    const plan = stagedPlan(store);
    const command = confirmationCommand(store, plan, 'stale-tab-click');
    const revisionBefore = store.snapshot().resourceVersion;

    const error = refusalFrom(() => store.commitBundle({ ...command, expectedResourceVersion: 0 }));

    assert.equal(error.code, 'EXPECTED_RESOURCE_VERSION_MISMATCH');
    assert.equal(error.details.partialReservations, 0);
    assert.deepEqual(heldResourceIds(store), []);
    assert.equal(store.snapshot().atomicity.bookingCount, 0);
    assert.equal(store.snapshot().resourceVersion, revisionBefore);

    assert.equal(store.snapshot().phase, 'AWAITING_HUMAN_CONFIRMATION', 'the plan was burnt by a bad number');
    assert.equal(store.snapshot().activePlan.status, 'STAGED');
  });

  test('leaves the stored plan status agreeing with the derived stale flag', () => {
    const store = freshStore();
    const plan = stagedPlan(store);
    const command = confirmationCommand(store, plan, 'stale-tab-flag');
    refusalFrom(() => store.commitBundle({ ...command, expectedResourceVersion: 0 }));

    const snapshot = store.snapshot();

    // lib/domain.mjs states that the stored status is kept in step with this
    // derived flag, so the page and the tool surface cannot disagree about
    // whether recovery is available. They agree now.
    assert.equal(snapshot.activePlan.status, 'STAGED');
    assert.equal(snapshot.activePlan.stale, false);
    assert.equal(snapshot.phase, 'AWAITING_HUMAN_CONFIRMATION');
  });

  test('produces no refusal to explain, because nothing is blocked', () => {
    const store = freshStore();
    const plan = stagedPlan(store);
    const command = confirmationCommand(store, plan, 'stale-tab-explain');
    refusalFrom(() => store.commitBundle({ ...command, expectedResourceVersion: 0 }));

    // An agent used to be told the plan was stale while being shown an empty
    // rule list and two equal revisions. The plan is simply still open.
    const explanation = store.explainRefusal();
    assert.equal(explanation.blocked, false, 'a wrong number left the venue looking blocked');
  });

  test('the plan is confirmed by retrying with the number it was prepared with', () => {
    const store = freshStore();
    const plan = stagedPlan(store);
    const command = confirmationCommand(store, plan, 'stale-tab-recovery');
    refusalFrom(() => store.commitBundle({ ...command, expectedResourceVersion: 0 }));

    // No replan needed: the plan was never invalidated, so the same command
    // with the right number completes. A mistyped number must not cost a
    // booking, which is the whole point of separating the two refusals.
    const result = store.commitBundle({ ...command, requestId: 'recovered-click' });

    assert.equal(result.ok, true);
    assert.equal(result.booking.partialReservations, 0);
    assert.deepEqual(heldResourceIds(store), FULL_BUNDLE_HELD);
    assert.equal(store.snapshot().atomicity.bookingCount, 1);
  });

  test('a venue that really moved still burns the plan and offers a replan', () => {
    // The positive control for all four above. Without it the repair could
    // become "never report a stale venue", which is the demo's central claim.
    const store = freshStore();
    const plan = stagedPlan(store);
    const command = confirmationCommand(store, plan, 'genuinely-stale');
    store.setFacilityOutage('garden-lift', 'POWER_FAULT');

    const error = refusalFrom(() => store.commitBundle(command));

    assert.equal(error.code, 'STALE_RESOURCE_VERSION');
    assert.equal(store.snapshot().activePlan.status, 'STALE');
    assert.equal(store.snapshot().phase, 'PLAN_STALE');

    const replacement = store.replanBundle(plan.id);
    assert.equal(replacement.routeId, 'east-lift-route');
    assert.equal(replacement.kind, 'REPLACEMENT');
    assert.equal(replacement.supersedesPlanId, plan.id);
    const result = store.commitBundle(confirmationCommand(store, replacement, 'recovered-after-real-change'));
    assert.equal(result.booking.partialReservations, 0);
    assert.equal(store.snapshot().atomicity.bookingCount, 1);
  });
});
