/**
 * Acceptance suite: the phase machine, every state and every move out of it.
 *
 * The gaps in this product were found by using it, not by reading it: a page
 * that offered no way back, a refusal that disappeared on its own, an operator
 * page that could only act on one of two lifts. None of it failed a test,
 * because no test asked "what happens if I press this here?".
 *
 * So that is what this file asks, exhaustively. Every one of the seven declared
 * phases is driven for real, and then every domain mutation is attempted from
 * it. Each of the 63 cells pins one of two things - the phase the venue ends up
 * in, or the exact refusal code - plus the standing safety invariant that no
 * refused move ever leaves a seat half-reserved.
 *
 * Nothing here is mocked. The store is the real one, with a fixed clock and a
 * counting id factory so the same run happens every time.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDemoStore, DomainError, demoDefaults } from '../../lib/domain.mjs';
import { PHASES, createVisitorTools } from '../../public/tools.mjs';
import { phaseMatrix } from '../../evals/contract.mjs';

/** A booked bundle reserves the space, the companion seat and the assistance. */
const CONFIRMED_RESERVED_COUNT = 3;

/** Identifiers the store never issued, for the moves that need one anyway. */
const NEVER_CREATED_PLAN = 'plan-never-created';
const NEVER_ISSUED_CONFIRMATION = 'confirm-never-issued';

function freshStore() {
  let issued = 0;
  return createDemoStore({
    clock: () => Date.parse('2026-08-30T18:00:00.000Z'),
    idFactory: () => `id-${++issued}`,
  });
}

function expectRefusal(fn, code) {
  assert.throws(fn, (error) => error instanceof DomainError && error.code === code, `expected a ${code} refusal`);
}

/*
 * ---------------------------------------------------------------------------
 * Driving the store into each phase.
 *
 * Every builder returns the same context shape, so one table can attempt the
 * same nine moves from all seven states:
 *   planId                 - the plan the page is showing, or one that never existed
 *   confirmationId         - the review the visitor was shown, where the phase has one
 *   expectedResourceVersion- the venue revision that confirmation was bound to
 * ---------------------------------------------------------------------------
 */

function intoReady() {
  return {
    store: freshStore(),
    planId: NEVER_CREATED_PLAN,
    confirmationId: NEVER_ISSUED_CONFIRMATION,
    expectedResourceVersion: 1,
  };
}

function intoPlanReady() {
  const store = freshStore();
  const plan = store.findBundle(demoDefaults);
  return {
    store,
    planId: plan.id,
    confirmationId: NEVER_ISSUED_CONFIRMATION,
    expectedResourceVersion: plan.basedOnResourceVersion,
  };
}

function intoAwaitingHumanConfirmation() {
  const store = freshStore();
  const plan = store.findBundle(demoDefaults);
  store.stageBundle(plan.id, plan.basedOnResourceVersion);
  const confirmation = store.prepareConfirmation(plan.id);
  return {
    store,
    planId: plan.id,
    confirmationId: confirmation.confirmationId,
    expectedResourceVersion: confirmation.expectedResourceVersion,
  };
}

/** The demo's own fault injection: the East lift fails mid-confirmation. */
function intoPlanStale() {
  const store = freshStore();
  const plan = store.findBundle(demoDefaults);
  store.stageBundle(plan.id, plan.basedOnResourceVersion);
  store.armOutage('east-lift');
  const confirmation = store.prepareConfirmation(plan.id);
  expectRefusal(() => store.commitBundle({
    planId: plan.id,
    confirmationId: confirmation.confirmationId,
    expectedResourceVersion: confirmation.expectedResourceVersion,
    accepted: true,
    requestId: 'setup-stale-commit',
  }), 'STALE_RESOURCE_VERSION');
  return {
    store,
    planId: plan.id,
    confirmationId: confirmation.confirmationId,
    expectedResourceVersion: confirmation.expectedResourceVersion,
  };
}

function intoReplanReady() {
  const stale = intoPlanStale();
  const replacement = stale.store.replanBundle(stale.planId);
  const confirmation = stale.store.prepareConfirmation(replacement.id);
  return {
    store: stale.store,
    planId: replacement.id,
    confirmationId: confirmation.confirmationId,
    expectedResourceVersion: confirmation.expectedResourceVersion,
  };
}

/**
 * A 65 m limit leaves only the East route (64 m); the Garden route is 78 m. So
 * when the East lift fails there is genuinely nothing to replan onto.
 */
function intoNoAlternative() {
  const store = freshStore();
  const plan = store.findBundle({ ...demoDefaults, maxDistanceM: 65 });
  store.stageBundle(plan.id, plan.basedOnResourceVersion);
  store.armOutage('east-lift');
  const confirmation = store.prepareConfirmation(plan.id);
  expectRefusal(() => store.commitBundle({
    planId: plan.id,
    confirmationId: confirmation.confirmationId,
    expectedResourceVersion: confirmation.expectedResourceVersion,
    accepted: true,
    requestId: 'setup-no-alternative-commit',
  }), 'STALE_RESOURCE_VERSION');
  expectRefusal(() => store.replanBundle(plan.id), 'NO_COMPLETE_BUNDLE');
  return {
    store,
    planId: plan.id,
    confirmationId: confirmation.confirmationId,
    expectedResourceVersion: confirmation.expectedResourceVersion,
  };
}

function intoConfirmed() {
  const context = intoAwaitingHumanConfirmation();
  context.store.commitBundle({
    planId: context.planId,
    confirmationId: context.confirmationId,
    expectedResourceVersion: context.expectedResourceVersion,
    accepted: true,
    requestId: 'setup-confirmed-commit',
  });
  return { ...context, expectedResourceVersion: context.store.snapshot().resourceVersion };
}

const PHASE_SETUP = {
  READY: intoReady,
  PLAN_READY: intoPlanReady,
  AWAITING_HUMAN_CONFIRMATION: intoAwaitingHumanConfirmation,
  PLAN_STALE: intoPlanStale,
  REPLAN_READY: intoReplanReady,
  NO_ALTERNATIVE: intoNoAlternative,
  CONFIRMED: intoConfirmed,
};

/*
 * ---------------------------------------------------------------------------
 * The nine moves. Each is attempted with the arguments a caller in that phase
 * would actually have: the plan on the page, the review the visitor was shown,
 * and the East lift - the one facility both routes and the demo fault revolve
 * around.
 * ---------------------------------------------------------------------------
 */

const MUTATIONS = {
  findBundle: (context) => context.store.findBundle(demoDefaults),
  stageBundle: (context) => context.store.stageBundle(context.planId, context.store.snapshot().resourceVersion),
  prepareConfirmation: (context) => context.store.prepareConfirmation(context.planId),
  commitBundle: (context) => context.store.commitBundle({
    planId: context.planId,
    confirmationId: context.confirmationId,
    expectedResourceVersion: context.expectedResourceVersion,
    accepted: true,
    requestId: 'uat-attempted-commit',
  }),
  replanBundle: (context) => context.store.replanBundle(context.planId),
  clearPlan: (context) => context.store.clearPlan(context.planId),
  setFacilityOutage: (context) => context.store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT'),
  restoreFacility: (context) => context.store.restoreFacility('east-lift'),
  armOutage: (context) => context.store.armOutage('east-lift'),
};

const MUTATION_NAMES = Object.keys(MUTATIONS);

const moves = (phase, versionDelta = 0) => ({ throws: null, phase, versionDelta });
const refuses = (code, phase, versionDelta = 0) => ({ throws: code, phase, versionDelta });

/**
 * Every outcome of every move out of every phase: 7 phases x 9 mutations.
 *
 * `phase` is always the phase the venue is in once the call returns or throws,
 * so a refusal that quietly changes state cannot hide here. `versionDelta` is
 * how far the venue revision moved, which is the number every open plan and
 * every prepared confirmation is bound to. It is the difference between a move
 * that genuinely did nothing and one that silently invalidated every plan in
 * the building, and the two look identical if only the phase is checked.
 */
const OUTCOMES = {
  READY: {
    findBundle: moves('PLAN_READY'),
    stageBundle: refuses('PLAN_NOT_FOUND', 'READY'),
    prepareConfirmation: refuses('PLAN_NOT_FOUND', 'READY'),
    commitBundle: refuses('PLAN_NOT_FOUND', 'READY'),
    replanBundle: refuses('PLAN_NOT_FOUND', 'READY'),
    clearPlan: refuses('PLAN_NOT_FOUND', 'READY'),
    // Taking the lift out is the one move here that moves the venue on.
    setFacilityOutage: moves('READY', 1),
    // Restoring a lift that never left service is a no-op, revision included.
    restoreFacility: moves('READY', 0),
    // Arming the demo fault records intent only; nothing about the venue yet.
    armOutage: moves('READY', 0),
  },
  PLAN_READY: {
    findBundle: refuses('ACTIVE_PLAN_EXISTS', 'PLAN_READY'),
    stageBundle: moves('AWAITING_HUMAN_CONFIRMATION'),
    prepareConfirmation: refuses('PLAN_NOT_READY', 'PLAN_READY'),
    // No confirmation has been issued for a plan nobody has reviewed yet.
    commitBundle: refuses('INVALID_CONFIRMATION', 'PLAN_READY'),
    replanBundle: refuses('PLAN_NOT_STALE', 'PLAN_READY'),
    clearPlan: moves('READY'),
    setFacilityOutage: moves('PLAN_STALE', 1),
    restoreFacility: moves('PLAN_READY', 0),
    armOutage: moves('PLAN_READY', 0),
  },
  AWAITING_HUMAN_CONFIRMATION: {
    findBundle: refuses('ACTIVE_PLAN_EXISTS', 'AWAITING_HUMAN_CONFIRMATION'),
    stageBundle: refuses('PLAN_NOT_STAGEABLE', 'AWAITING_HUMAN_CONFIRMATION'),
    // Showing the same unchanged review twice reuses one confirmation, which
    // the cell checks by identifier, not just by phase.
    prepareConfirmation: moves('AWAITING_HUMAN_CONFIRMATION'),
    // Booking the bundle is itself a change to the venue.
    commitBundle: moves('CONFIRMED', 1),
    replanBundle: refuses('PLAN_NOT_STALE', 'AWAITING_HUMAN_CONFIRMATION'),
    clearPlan: moves('READY'),
    setFacilityOutage: moves('PLAN_STALE', 1),
    restoreFacility: moves('AWAITING_HUMAN_CONFIRMATION', 0),
    armOutage: moves('AWAITING_HUMAN_CONFIRMATION', 0),
  },
  PLAN_STALE: {
    findBundle: refuses('ACTIVE_PLAN_EXISTS', 'PLAN_STALE'),
    stageBundle: refuses('PLAN_NOT_STAGEABLE', 'PLAN_STALE'),
    prepareConfirmation: refuses('PLAN_NOT_READY', 'PLAN_STALE'),
    commitBundle: refuses('STALE_RESOURCE_VERSION', 'PLAN_STALE'),
    replanBundle: moves('REPLAN_READY'),
    clearPlan: moves('READY'),
    // The East lift is already out of service, so reporting it again changes
    // nothing at all - not the status, not the venue revision.
    setFacilityOutage: moves('PLAN_STALE', 0),
    // Restoring it does move the revision, and the plan stays stale anyway:
    // it was built against a revision that no longer exists.
    restoreFacility: moves('PLAN_STALE', 1),
    armOutage: refuses('FACILITY_NOT_OPERATIONAL', 'PLAN_STALE'),
  },
  REPLAN_READY: {
    findBundle: refuses('ACTIVE_PLAN_EXISTS', 'REPLAN_READY'),
    stageBundle: refuses('PLAN_NOT_STAGEABLE', 'REPLAN_READY'),
    prepareConfirmation: moves('REPLAN_READY'),
    commitBundle: moves('CONFIRMED', 1),
    replanBundle: refuses('PLAN_NOT_STALE', 'REPLAN_READY'),
    clearPlan: moves('READY'),
    setFacilityOutage: moves('REPLAN_READY', 0),
    // Restoring the failed East lift moves the venue revision, which
    // invalidates the Garden replacement even though it never used that lift.
    restoreFacility: moves('PLAN_STALE', 1),
    armOutage: refuses('FACILITY_NOT_OPERATIONAL', 'REPLAN_READY'),
  },
  NO_ALTERNATIVE: {
    findBundle: refuses('ACTIVE_PLAN_EXISTS', 'NO_ALTERNATIVE'),
    stageBundle: refuses('PLAN_NOT_STAGEABLE', 'NO_ALTERNATIVE'),
    prepareConfirmation: refuses('PLAN_NOT_READY', 'NO_ALTERNATIVE'),
    // The refusal is not inert: it rewrites the dead-end plan back to stale.
    commitBundle: refuses('STALE_RESOURCE_VERSION', 'PLAN_STALE'),
    // A dead end cannot be replanned a second time; it has to be cleared.
    replanBundle: refuses('PLAN_NOT_STALE', 'NO_ALTERNATIVE'),
    clearPlan: moves('READY'),
    setFacilityOutage: moves('NO_ALTERNATIVE', 0),
    // A venue that changes makes a "no alternative" conclusion re-checkable.
    restoreFacility: moves('PLAN_STALE', 1),
    armOutage: refuses('FACILITY_NOT_OPERATIONAL', 'NO_ALTERNATIVE'),
  },
  CONFIRMED: {
    findBundle: refuses('BOOKING_ALREADY_EXISTS', 'CONFIRMED'),
    stageBundle: refuses('PLAN_NOT_STAGEABLE', 'CONFIRMED'),
    prepareConfirmation: refuses('PLAN_NOT_READY', 'CONFIRMED'),
    commitBundle: refuses('PLAN_ALREADY_COMMITTED', 'CONFIRMED'),
    replanBundle: refuses('PLAN_NOT_STALE', 'CONFIRMED'),
    clearPlan: refuses('PLAN_ALREADY_COMMITTED', 'CONFIRMED'),
    // Operations keep operating. The lift goes out, the booking record stands.
    setFacilityOutage: moves('CONFIRMED', 1),
    restoreFacility: moves('CONFIRMED', 0),
    armOutage: moves('CONFIRMED', 0),
  },
};

/** Runs one cell of the matrix on its own store and reports what happened. */
function runCell(phase, mutationName) {
  const context = PHASE_SETUP[phase]();
  const before = context.store.snapshot();
  assert.equal(before.phase, phase, `setup for ${phase} did not reach ${phase}`);
  let error = null;
  let result = null;
  try {
    result = MUTATIONS[mutationName](context);
  } catch (caught) {
    error = caught;
  }
  const snapshot = context.store.snapshot();
  return {
    context,
    before,
    error,
    result,
    snapshot,
    versionDelta: snapshot.resourceVersion - before.resourceVersion,
  };
}

describe('the phase machine answers for every move out of every phase', () => {
  for (const phase of Object.keys(OUTCOMES)) {
    for (const mutationName of MUTATION_NAMES) {
      const expected = OUTCOMES[phase][mutationName];
      const sentence = expected.throws
        ? `in ${phase}, ${mutationName} is refused with ${expected.throws} and the venue ends in ${expected.phase}`
        : expected.phase === phase
          ? `in ${phase}, ${mutationName} succeeds and the phase stays ${phase}`
          : `in ${phase}, ${mutationName} succeeds and moves the venue to ${expected.phase}`;

      test(sentence, () => {
        const { context, error, result, snapshot, versionDelta } = runCell(phase, mutationName);

        if (expected.throws === null) {
          assert.equal(error, null, `${phase} · ${mutationName} was refused with ${error?.code ?? error?.message}`);
        } else {
          assert.ok(error, `${phase} · ${mutationName} succeeded but should have been refused with ${expected.throws}`);
          assert.ok(error instanceof DomainError, `${phase} · ${mutationName} threw ${error?.name}, not a DomainError`);
          assert.equal(error.code, expected.throws, `${phase} · ${mutationName} refusal code`);
        }

        assert.equal(snapshot.phase, expected.phase, `${phase} · ${mutationName} left the venue in the wrong phase`);

        // How far the venue moved, not just where it landed. A move that is
        // supposed to change nothing must not quietly bump the revision every
        // open plan and prepared confirmation is bound to, and a move that is
        // supposed to change the venue must actually say so.
        assert.equal(
          versionDelta,
          expected.versionDelta,
          `${phase} · ${mutationName} moved the venue revision by ${versionDelta}, expected ${expected.versionDelta}`,
        );

        // The standing invariant behind the whole product: a bundle is either
        // fully booked or not booked at all. No move, refused or accepted, may
        // leave a seat, a space or a host half-taken. Read from the expectation
        // table, not from the snapshot, so the invariant cannot agree with
        // itself about a phase that was never supposed to happen.
        const booked = expected.phase === 'CONFIRMED';
        assert.equal(
          snapshot.atomicity.bookingCount,
          booked ? 1 : 0,
          `${phase} · ${mutationName} left the wrong number of bookings`,
        );
        assert.equal(
          snapshot.atomicity.reservedResourceCount,
          booked ? CONFIRMED_RESERVED_COUNT : 0,
          `${phase} · ${mutationName} left a partial reservation`,
        );

        // Showing the visitor the same unchanged review again must hand back
        // the review they are already looking at. A fresh one every time is how
        // a page ends up holding a confirmation the visitor never saw.
        if (mutationName === 'prepareConfirmation' && expected.throws === null) {
          assert.equal(
            result.confirmationId,
            context.confirmationId,
            `${phase} · ${mutationName} issued a second confirmation for one unchanged review`,
          );
        }
      });
    }
  }
});

describe('the matrix covers the phase machine the tool surface declares', () => {
  test('every declared phase has a setup and a row of expected outcomes', () => {
    const declared = [...PHASES].sort();
    assert.deepEqual(Object.keys(PHASE_SETUP).sort(), declared);
    assert.deepEqual(Object.keys(OUTCOMES).sort(), declared);
    for (const phase of PHASES) {
      assert.deepEqual(
        Object.keys(OUTCOMES[phase]).sort(),
        [...MUTATION_NAMES].sort(),
        `${phase} does not attempt every mutation`,
      );
    }
  });

  test('every declared phase is genuinely reachable in the real store', () => {
    for (const phase of PHASES) {
      const { store } = PHASE_SETUP[phase]();
      assert.equal(store.snapshot().phase, phase, `${phase} was never reached`);
    }
  });

  test('every way of changing the venue is driven from every phase', () => {
    const store = freshStore();
    for (const name of MUTATION_NAMES) {
      assert.equal(typeof store[name], 'function', `the store no longer exposes ${name}`);
    }

    /** Reads cannot move the venue, so the phase matrix does not drive them. */
    const readOnly = [
      'snapshot', 'hasBooking', 'listAccessOptions', 'checkAccessRoute', 'explainRefusal',
      'idempotencyRecordCount', // how many request ids are remembered; a measurement of the bound, not a move
      'rememberedRefusalCount', // likewise for the per-visitor refusal record
    ];
    /** Writes deliberately left out, each with the reason it is not a visitor move. */
    const notAVisitorMove = [
      'reset', // demo control: throws the whole session away, phases included
      'setResourceUnavailable', // operator move on a seat, covered by the operator suite
      'releaseSession', // HTTP lifecycle cleanup for one caller's private refusal; no venue phase can change
    ];

    // The repeatedly observed gap was a move nobody had tried from that state.
    // So a new way to change the venue must not be able to appear in
    // the store without someone deciding what it does in all seven phases.
    const undriven = Object.keys(store).filter((name) => (
      !MUTATION_NAMES.includes(name) && !readOnly.includes(name) && !notAVisitorMove.includes(name)
    ));
    assert.deepEqual(undriven, [], `the store grew ${undriven.join(', ')}; add it to the matrix or say why not`);
  });

  test('no move out of any phase produces a state the page cannot describe or leave', () => {
    const registered = new Map(phaseMatrix(inertVisitorTools()).map((row) => [row.phase, row]));
    for (const phase of Object.keys(OUTCOMES)) {
      for (const mutationName of MUTATION_NAMES) {
        const { snapshot } = runCell(phase, mutationName);
        assert.ok(
          PHASES.includes(snapshot.phase),
          `${phase} · ${mutationName} produced the undeclared phase ${snapshot.phase}`,
        );

        // `registered` is keyed by PHASES, so the assertion above already
        // guarantees a row here; checking for one would be checking nothing.
        const row = registered.get(snapshot.phase);
        assert.ok(
          row.names.includes('get_event_access_state'),
          `${snapshot.phase} leaves the agent with no tool to read the page`,
        );

        // The dead end. Every phase a move can land in must register a way out,
        // and the only state allowed to have none is the one where the visitor
        // has what they came for.
        if (snapshot.phase === 'CONFIRMED') {
          assert.equal(row.write, 0, 'a confirmed booking must not offer a way to rewrite itself');
        } else {
          assert.ok(
            row.write >= 1,
            `${phase} · ${mutationName} lands in ${snapshot.phase}, which registers no way out`,
          );
        }
      }
    }
  });
});

/** Tool definitions used only for their phase declarations, never executed. */
function inertVisitorTools() {
  const unused = async () => {
    throw new Error('this suite reads tool declarations, it never calls them');
  };
  return createVisitorTools({ api: unused, refresh: unused });
}

describe('the reachability graph out of READY and into CONFIRMED', () => {
  test('READY reaches only PLAN_READY in one move, and never a booking', () => {
    const reached = new Set();
    for (const mutationName of MUTATION_NAMES) {
      const { snapshot } = runCell('READY', mutationName);
      reached.add(snapshot.phase);
      assert.equal(snapshot.atomicity.bookingCount, 0, `${mutationName} booked something from READY`);
      assert.equal(snapshot.atomicity.reservedResourceCount, 0, `${mutationName} reserved something from READY`);
    }
    // An exact set, not a membership test: naming the two phases that may be
    // reached also says that CONFIRMED is not one of them, which a separate
    // `reached.has('CONFIRMED') === false` could only restate.
    assert.deepEqual(
      [...reached].sort(),
      ['PLAN_READY', 'READY'],
      'a single move from READY must reach nothing but a proposed plan',
    );
  });

  test('CONFIRMED is terminal: no move leaves it or rewrites the booking', () => {
    const original = intoConfirmed().store.snapshot().booking;
    // Pinned, not merely truthy: two bookings that both lost their receipt
    // would otherwise compare equal below and prove nothing.
    assert.match(original.receipt, /^NSWR-\d{5}$/, 'the setup produced no usable receipt to compare against');
    assert.deepEqual(
      original.resourceIds,
      ['east-lift', 'space-w12', 'seat-w13', 'assist-east-1905'],
      'the booking must name the whole bundle: the route facility, the space, the companion seat and the host',
    );

    // Each cell books in its own store, so the comparison is within that cell:
    // the booking as it stood before the move against the booking after it.
    // Comparing every cell against `original` instead compared two DIFFERENT
    // bookings and passed only because a per-venue counter handed them the same
    // reference - the receipt collision an independent tester later reproduced
    // on the deployment. The assertion rested on the defect it should have
    // caught, which is why `original` now only pins the shape of a real
    // booking, and never stands in for another store's.
    for (const mutationName of MUTATION_NAMES) {
      const { before, snapshot } = runCell('CONFIRMED', mutationName);
      assert.equal(snapshot.phase, 'CONFIRMED', `${mutationName} moved the venue out of CONFIRMED`);
      assert.equal(snapshot.booking.id, before.booking.id, `${mutationName} replaced the booking`);
      assert.equal(snapshot.booking.receipt, before.booking.receipt, `${mutationName} rewrote the receipt`);
      assert.deepEqual(snapshot.booking.resourceIds, before.booking.resourceIds, `${mutationName} rewrote the booked bundle`);
      assert.deepEqual(snapshot.booking.resourceIds, original.resourceIds, `${mutationName} booked a different bundle`);
      assert.equal(snapshot.booking.partialReservations, 0);
    }
  });

  test('losing the replacement lift sends REPLAN_READY back to PLAN_STALE and then to a dead end', () => {
    // The matrix reports the East lift because that is where the demo fault
    // lives, and by REPLAN_READY it is already out of service. The Garden lift
    // is the one the replacement actually depends on.
    const context = intoReplanReady();
    const before = context.store.snapshot();
    assert.equal(before.resources['garden-lift'].status, 'OPERATIONAL', 'the replacement lift should start in service');

    context.store.setFacilityOutage('garden-lift', 'POWER_FAULT');
    const snapshot = context.store.snapshot();

    assert.equal(snapshot.phase, 'PLAN_STALE');
    assert.equal(snapshot.resources['garden-lift'].status, 'OUT_OF_SERVICE');
    assert.equal(snapshot.resourceVersion, before.resourceVersion + 1, 'losing the replacement lift must move the venue on');
    assert.equal(snapshot.atomicity.reservedResourceCount, 0);
    // Both lifts are now out, so replanning has nothing left to offer.
    expectRefusal(() => context.store.replanBundle(snapshot.activePlan.id), 'NO_COMPLETE_BUNDLE');
    assert.equal(context.store.snapshot().phase, 'NO_ALTERNATIVE');
  });
});

describe('a blocked phase names the way out', () => {
  test('PLAN_STALE explains the failure and names replanning as the way back', () => {
    const { store } = intoPlanStale();
    const explanation = store.explainRefusal();

    assert.equal(explanation.blocked, true);
    assert.equal(explanation.phase, 'PLAN_STALE');
    assert.equal(explanation.errorCode, 'STALE_RESOURCE_VERSION');
    assert.equal(explanation.nextAction, 'REPLAN');
    assert.equal(explanation.partialReservations, 0);
    assert.ok(
      explanation.brokenRules.some((rule) => rule.rule === 'LIFT_OPERATIONAL'),
      'the broken lift is the rule that has to be reported',
    );
    assert.deepEqual(explanation.validOptionsNow.map((option) => option.routeId), ['garden-lift-route']);

    // And the named way back is actually the write tool this phase registers.
    const row = phaseMatrix(inertVisitorTools()).find((candidate) => candidate.phase === 'PLAN_STALE');
    assert.deepEqual(
      row.names.filter((name) => name.startsWith('replan')),
      ['replan_access_bundle'],
    );
    assert.equal(row.write, 1, 'PLAN_STALE should offer exactly one way forward');
  });

  test('NO_ALTERNATIVE explains the dead end and names changing requirements', () => {
    const { store } = intoNoAlternative();
    const explanation = store.explainRefusal();

    assert.equal(explanation.blocked, true);
    assert.equal(explanation.phase, 'NO_ALTERNATIVE');
    assert.equal(explanation.errorCode, 'NO_COMPLETE_BUNDLE');
    assert.equal(explanation.nextAction, 'CHANGE_REQUIREMENTS');
    assert.deepEqual(explanation.validOptionsNow, []);
    assert.equal(explanation.rejectedAction.reason, 'NO_COMPLETE_BUNDLE');

    const row = phaseMatrix(inertVisitorTools()).find((candidate) => candidate.phase === 'NO_ALTERNATIVE');
    assert.deepEqual(
      row.names.filter((name) => name.startsWith('clear')),
      ['clear_access_plan'],
      'the only way out of a dead end must be registered as a tool',
    );
    assert.equal(row.write, 1);
  });

  test('a refusal survives until something changes it', () => {
    // The observed refusal disappeared after four seconds. Reading the state
    // repeatedly must not resolve it; only a real move may.
    const { store, planId } = intoPlanStale();
    const first = store.snapshot();
    for (let read = 0; read < 5; read += 1) {
      const snapshot = store.snapshot();
      const explanation = store.explainRefusal();
      assert.equal(snapshot.phase, 'PLAN_STALE', `read ${read} found the refusal gone`);
      assert.equal(explanation.blocked, true, `read ${read} found nothing to explain`);
      assert.equal(explanation.errorCode, 'STALE_RESOURCE_VERSION', `read ${read} changed the reason`);
      // Reading is not a move: the revision and the plan on the page are the
      // same ones the visitor was looking at before they read anything.
      assert.equal(snapshot.resourceVersion, first.resourceVersion, `read ${read} moved the venue revision`);
      assert.equal(snapshot.activePlan.id, first.activePlan.id, `read ${read} replaced the plan on the page`);
    }
    store.clearPlan(planId);
    assert.equal(store.snapshot().phase, 'READY');
    assert.equal(store.explainRefusal().blocked, false);
  });
});

describe('the recovery that was missing: clearing an unbooked plan', () => {
  for (const phase of ['PLAN_READY', 'AWAITING_HUMAN_CONFIRMATION']) {
    test(`clearing the plan in ${phase} returns the visitor to READY with nothing held`, () => {
      const context = PHASE_SETUP[phase]();
      assert.equal(context.store.snapshot().phase, phase);

      context.store.clearPlan(context.planId);
      const snapshot = context.store.snapshot();

      assert.equal(snapshot.phase, 'READY');
      assert.equal(snapshot.activePlan, null, 'the cleared plan must leave the page');
      assert.equal(snapshot.booking, null);
      assert.equal(snapshot.atomicity.bookingCount, 0);
      assert.equal(snapshot.atomicity.reservedResourceCount, 0);
      assert.equal(snapshot.resources['space-w12'].status, 'AVAILABLE');
      assert.equal(snapshot.resources['seat-w13'].status, 'AVAILABLE');
      assert.equal(snapshot.resources['assist-east-1905'].status, 'AVAILABLE');
      assert.equal(snapshot.audit.at(-1).action, 'PLAN_CLEARED');

      // READY has to mean READY: the visitor can start again with new needs,
      // and the new plan has to be built from those needs rather than from the
      // ones the cleared plan was carrying.
      const restarted = context.store.findBundle({ ...demoDefaults, companionCount: 0 });
      assert.equal(restarted.status, 'PROPOSED');
      assert.equal(restarted.requirements.companionCount, 0, 'the restart kept the old requirements');
      assert.deepEqual(
        restarted.claims.map((claim) => claim.role),
        ['ROUTE_FACILITY', 'WHEELCHAIR_SPACE', 'ENTRANCE_ASSISTANCE'],
        'a visitor travelling alone must not be given a companion seat',
      );
      assert.equal(context.store.snapshot().phase, 'PLAN_READY');
    });
  }

  test('a confirmation prepared before clearing cannot book afterwards', () => {
    const context = intoAwaitingHumanConfirmation();
    context.store.clearPlan(context.planId);

    expectRefusal(() => context.store.commitBundle({
      planId: context.planId,
      confirmationId: context.confirmationId,
      expectedResourceVersion: context.expectedResourceVersion,
      accepted: true,
      requestId: 'commit-after-clearing',
    }), 'PLAN_NOT_FOUND');

    const snapshot = context.store.snapshot();
    assert.equal(snapshot.phase, 'READY');
    assert.equal(snapshot.atomicity.bookingCount, 0);
    assert.equal(snapshot.atomicity.reservedResourceCount, 0);
  });
});
