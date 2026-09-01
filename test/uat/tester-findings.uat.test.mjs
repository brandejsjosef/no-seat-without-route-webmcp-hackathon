/**
 * What an independent adversarial pass found against the frozen release.
 *
 * Every case here is a defect a tester reproduced by driving the product, not
 * by reading it. They are grouped by what they cost:
 *
 *  - the decision log recording something that did not happen (8);
 *  - an explanation naming a stale episode, or dropping the fields it exists to
 *    deliver, in the states it exists for (9, 10, 11, 12);
 *  - a booking reference that repeats across visitors on one process (13);
 *  - an unbounded map that makes every later refusal slower (1).
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDemoStore } from '../../lib/domain.mjs';

const store = () => createDemoStore({
  clock: () => Date.parse('2026-09-01T09:00:00.000Z'),
  idFactory: ((n) => () => `id-${++n}`)(0),
});

const FULL = Object.freeze({
  wheelchairWidthCm: 72,
  maxDistanceM: 80,
  stepFree: true,
  companionCount: 1,
  entranceAssistance: true,
  lowStimulus: true,
});

const bothLiftsOut = (venue) => {
  venue.setFacilityOutage('east-lift', 'POWER_FAULT');
  venue.setFacilityOutage('garden-lift', 'POWER_FAULT');
  return venue;
};

function stagedPlan(venue) {
  const plan = venue.findBundle(FULL);
  venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
  return plan;
}

const lastEntry = (venue, action) => [...venue.snapshot().audit].reverse().find((row) => row.action === action);

describe('disarming a fault is not a restoration', () => {
  test('clearing an armed fault does not claim the lift came back', () => {
    // restoreFacility() proceeded on a lift that was OPERATIONAL but armed, and
    // wrote FACILITY_RESTORED with "is back in service" - about a lift that had
    // never left it. The decision log is the artefact this product asks to be
    // believed.
    const venue = store();
    venue.armOutage('east-lift');
    assert.equal(venue.snapshot().resources['east-lift'].status, 'OPERATIONAL');

    venue.restoreFacility('east-lift');

    const restored = lastEntry(venue, 'FACILITY_RESTORED');
    assert.equal(restored, undefined, 'disarming was logged as a restoration that never happened');
    assert.equal(venue.snapshot().demo.pendingOutageResourceId, null, 'the fault should be cleared');
  });

  test('it is recorded as what it is, and names the lift', () => {
    const venue = store();
    venue.armOutage('garden-lift');
    venue.restoreFacility('garden-lift');

    const entry = venue.snapshot().audit.at(-1);
    assert.equal(entry.action, 'OUTAGE_SIGNAL_CLEARED');
    assert.match(entry.message, /Garden Lift L4/);
  });

  test('it does not invalidate a plan, because nothing about the venue changed', () => {
    // Measured by the tester over HTTP: disarming pushed a valid STAGED plan to
    // STALE for a facility change that did not occur.
    const venue = store();
    const plan = stagedPlan(venue);
    venue.armOutage('east-lift');
    const revisionBefore = venue.snapshot().resourceVersion;

    venue.restoreFacility('east-lift');

    const after = venue.snapshot();
    assert.equal(after.activePlan.status, 'STAGED', 'disarming invalidated a plan');
    assert.equal(after.phase, 'AWAITING_HUMAN_CONFIRMATION');
    assert.equal(after.resourceVersion, revisionBefore, 'disarming moved the venue revision');
    assert.equal(plan.id, after.activePlan.id);
  });

  test('restoring a lift that really is out still works and still counts', () => {
    // The positive control: the ordinary restore must keep its wording, its
    // revision bump and its power to invalidate.
    const venue = store();
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    const revisionBefore = venue.snapshot().resourceVersion;

    venue.restoreFacility('east-lift');

    assert.equal(venue.snapshot().resources['east-lift'].status, 'OPERATIONAL');
    assert.equal(venue.snapshot().resourceVersion, revisionBefore + 1);
    assert.ok(lastEntry(venue, 'FACILITY_RESTORED'), 'a real restore should be logged as one');
  });
});

describe('an explanation describes the refusal it is about', () => {
  test('a dead end names every lift that is down, not only the plan\'s own', () => {
    const venue = store();
    const plan = stagedPlan(venue);
    bothLiftsOut(venue);
    try { venue.replanBundle(plan.id); } catch { /* expected */ }

    const explanation = venue.explainRefusal();
    const named = explanation.brokenRules.map((rule) => rule.detail).join(' ');
    assert.match(named, /East Lift L2/, 'the East lift is not mentioned');
    assert.match(named, /Garden Lift L4/, 'the Garden lift is not mentioned');
  });

  test('a plan-branch explanation carries the two fields an agent decides with', () => {
    const venue = store();
    const plan = stagedPlan(venue);
    bothLiftsOut(venue);
    try { venue.replanBundle(plan.id); } catch { /* expected */ }

    const explanation = venue.explainRefusal();
    assert.deepEqual(explanation.blockedBy, ['LIFT_OPERATIONAL']);
    assert.equal(explanation.requirementChangeCanHelp, false);
    assert.equal(explanation.nextAction, 'CONTACT_VENUE_STAFF');
  });

  test('it does not name a rejection from an episode that is over', () => {
    // explainRefusal took the last REJECTED audit entry ever written, so a
    // refusal from a previous, fully recovered episode was still reported as
    // the action that had been rejected.
    const venue = store();
    const plan = stagedPlan(venue);
    // Prepared before the venue moves: a stale plan cannot be prepared, which
    // is what my first version of this setup ran into.
    const confirmation = venue.prepareConfirmation(plan.id);
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    try {
      venue.commitBundle({
        planId: plan.id,
        confirmationId: confirmation.confirmationId,
        expectedResourceVersion: confirmation.expectedResourceVersion,
        accepted: true,
        requestId: 'episode-one',
      });
    } catch { /* expected */ }

    const replacement = venue.replanBundle(plan.id);
    venue.restoreFacility('east-lift');
    assert.equal(venue.snapshot().activePlan.id, replacement.id);

    const explanation = venue.explainRefusal();
    if (explanation.blocked) {
      assert.notEqual(
        explanation.rejectedAction?.action,
        'COMMIT_REJECTED_STALE',
        'an explanation names a rejection from an episode that has been recovered',
      );
    } else {
      assert.equal(explanation.rejectedAction ?? null, null, 'an unblocked venue reports a rejected action');
    }
  });
});

describe('a booking reference is unique on this process', () => {
  test('four venues in one process issue four different receipts', () => {
    // The counter was private per venue, so on the deployment every visitor's
    // first booking carried the same reference.
    const receipts = [];
    for (let index = 0; index < 4; index += 1) {
      const venue = store();
      const plan = stagedPlan(venue);
      const confirmation = venue.prepareConfirmation(plan.id);
      receipts.push(venue.commitBundle({
        planId: plan.id,
        confirmationId: confirmation.confirmationId,
        expectedResourceVersion: confirmation.expectedResourceVersion,
        accepted: true,
        requestId: `venue-${index}`,
      }).booking.receipt);
    }
    for (const receipt of receipts) assert.match(receipt, /^NSWR-\d{5}$/);
    assert.equal(new Set(receipts).size, 4, `venues share a receipt: ${receipts.join(', ')}`);
  });
});

describe('a refused command does not make the next one slower for ever', () => {
  test('the idempotency record is bounded', () => {
    // Every refused commit bound its request id and nothing pruned the map, so
    // a caller could grow it without limit and make each later refusal cost
    // more than the last. The audit log is capped for exactly this reason.
    const venue = store();
    for (let index = 0; index < 400; index += 1) {
      try {
        venue.commitBundle({
          planId: 'no-such-plan',
          confirmationId: 'none',
          expectedResourceVersion: 1,
          accepted: true,
          requestId: `flood-${index}`,
        });
      } catch { /* expected */ }
    }
    assert.ok(
      venue.idempotencyRecordCount() <= 200,
      `the idempotency record grew to ${venue.idempotencyRecordCount()} entries`,
    );
  });

  test('a recent id is still honoured after ordinary use', () => {
    // Bounded must not mean forgetful about anything the caller might retry.
    const venue = store();
    const plan = stagedPlan(venue);
    const confirmation = venue.prepareConfirmation(plan.id);
    const command = {
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
      requestId: 'the-visitor-click',
    };
    const first = venue.commitBundle(command);
    const replay = venue.commitBundle(command);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.booking.receipt, first.booking.receipt);
  });
});
