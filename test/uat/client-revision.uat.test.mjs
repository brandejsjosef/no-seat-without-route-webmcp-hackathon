/**
 * A number the caller got wrong is not a venue change.
 *
 * `commitBundle` compared the caller's `expectedResourceVersion` in the same
 * condition as the plan's and the confirmation's, so a stale browser tab, a
 * retry with a remembered number, or a typo produced `STALE_RESOURCE_VERSION`
 * and pushed a plan nothing had invalidated to STALE. The venue had not moved:
 * the refusal reported two identical revisions, an empty broken-rule list, and
 * offered back the very route the plan was already holding.
 *
 * Worse, the check ran after the demo's pending fault had been triggered, so a
 * bad number could spend a fault the venue was holding for a real confirmation.
 *
 * The two cases are different and now answer differently:
 *
 *   the caller's number is wrong   -> EXPECTED_RESOURCE_VERSION_MISMATCH,
 *                                     nothing moves, the plan stays usable
 *   the venue really moved         -> STALE_RESOURCE_VERSION, replan
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDemoStore } from '../../lib/domain.mjs';

const store = () => createDemoStore({
  clock: () => Date.parse('2026-08-31T18:00:00.000Z'),
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

/** A staged plan and the exact command a confirmed booking would carry. */
function readyToConfirm(venue, requestId) {
  const plan = venue.findBundle(FULL);
  venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
  const confirmation = venue.prepareConfirmation(plan.id);
  return {
    plan,
    command: {
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
      requestId,
    },
  };
}

/** Everything a refusal about a wrong NUMBER must leave exactly as it was. */
const invariant = (snapshot) => ({
  revision: snapshot.resourceVersion,
  resources: snapshot.resources,
  plans: snapshot.plans,
  booking: snapshot.booking,
  phase: snapshot.phase,
  pending: snapshot.demo.pendingOutageResourceId,
  auditLength: snapshot.audit.length,
  atomicity: snapshot.atomicity,
});

describe('staging carries the same truthfulness as confirming', () => {
  // The repair was applied to commitBundle and not to stageBundle, which folds
  // the caller's number into the same condition as the plan's. The number is
  // agent-supplied through stage_access_bundle's expectedVenueRevision, so an
  // agent that remembers a stale number is told the venue changed when it did
  // not - two identical revisions in the refusal - and is sent to REPLAN, which
  // then answers PLAN_NOT_STALE.
  test('a wrong number is a mismatch, not a venue change', () => {
    const venue = store();
    const plan = venue.findBundle(FULL);

    assert.throws(
      () => venue.stageBundle(plan.id, 99),
      (error) => error.code === 'EXPECTED_RESOURCE_VERSION_MISMATCH',
      'staging still reports a caller mistake as a venue change',
    );
  });

  test('it changes nothing and the plan is still stageable', () => {
    const venue = store();
    const plan = venue.findBundle(FULL);
    const before = invariant(venue.snapshot());

    assert.throws(() => venue.stageBundle(plan.id, 99));
    assert.deepStrictEqual(invariant(venue.snapshot()), before, 'a wrong number moved the venue');

    const staged = venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    assert.equal(staged.status, 'STAGED', 'the plan could not be staged with the right number');
  });

  test('a venue that really moved is never reported as a caller mistake', () => {
    // Written first as "must be STALE_RESOURCE_VERSION", which was my error:
    // the outage invalidates the plan, so PLAN_NOT_STAGEABLE fires first and
    // says planStatus STALE with nextAction REPLAN - strictly more useful than
    // the revision code. What must hold is the property, not one of the two
    // codes: a moved venue is a venue problem, never the caller's arithmetic.
    const venue = store();
    const plan = venue.findBundle(FULL);
    venue.setFacilityOutage('garden-lift', 'POWER_FAULT');

    try {
      venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
      assert.fail('staging onto a moved venue should be refused');
    } catch (error) {
      assert.notEqual(
        error.code,
        'EXPECTED_RESOURCE_VERSION_MISMATCH',
        'a real venue change was reported as a caller mistake',
      );
      assert.ok(
        ['STALE_RESOURCE_VERSION', 'PLAN_NOT_STAGEABLE'].includes(error.code),
        `unexpected refusal: ${error.code}`,
      );
      assert.equal(error.details.nextAction, 'REPLAN', 'the advice must send the agent to a replan');
    }
  });

  test('every unreadable number is a mismatch too', () => {
    for (const wrong of [undefined, null, 'two', Number.NaN, -1]) {
      const venue = store();
      const plan = venue.findBundle(FULL);
      try {
        venue.stageBundle(plan.id, wrong);
        assert.fail(`${String(wrong)} was accepted`);
      } catch (error) {
        assert.equal(error.code, 'EXPECTED_RESOURCE_VERSION_MISMATCH', `${String(wrong)} gave ${error.code}`);
      }
    }
  });
});

describe('a revision number the caller got wrong', () => {
  test('is refused as a mismatch, not as a venue change', () => {
    const venue = store();
    const { command } = readyToConfirm(venue, 'stale-tab');

    assert.throws(
      () => venue.commitBundle({ ...command, expectedResourceVersion: 0 }),
      (error) => error.code === 'EXPECTED_RESOURCE_VERSION_MISMATCH' && error.status === 409,
      'a wrong number is still reported as the venue having changed',
    );
  });

  test('the refusal says which number to retry with', () => {
    const venue = store();
    const { command } = readyToConfirm(venue, 'stale-tab-advice');
    try {
      venue.commitBundle({ ...command, expectedResourceVersion: 0 });
      assert.fail('the wrong number should have been refused');
    } catch (error) {
      assert.equal(error.details.nextAction, 'RETRY_WITH_THE_VENUE_REVISION');
      assert.equal(error.details.venueResourceVersion, command.expectedResourceVersion);
      assert.match(error.message, /\S/, 'the refusal needs a human sentence');
    }
  });

  test('it changes nothing at all', () => {
    const venue = store();
    const { command } = readyToConfirm(venue, 'stale-tab-invariant');
    const before = invariant(venue.snapshot());

    assert.throws(() => venue.commitBundle({ ...command, expectedResourceVersion: 0 }));

    assert.deepStrictEqual(invariant(venue.snapshot()), before, 'a wrong number moved the venue');
  });

  test('the plan is still usable afterwards, and confirms with the right number', () => {
    // The point of the whole repair: a mistyped number must not cost a booking.
    const venue = store();
    const { command } = readyToConfirm(venue, 'stale-tab-recovers');
    assert.throws(() => venue.commitBundle({ ...command, expectedResourceVersion: 0 }));

    const snapshot = venue.snapshot();
    assert.equal(snapshot.activePlan.status, 'STAGED', 'the plan was burnt by a wrong number');
    assert.equal(snapshot.activePlan.stale, false, 'the derived flag and the stored status disagree');
    assert.equal(snapshot.phase, 'AWAITING_HUMAN_CONFIRMATION');

    const committed = venue.commitBundle({ ...command, requestId: 'stale-tab-second-try' });
    assert.equal(committed.ok, true, 'the plan could not be confirmed after a wrong number');
    assert.equal(venue.snapshot().atomicity.bookingCount, 1);
  });

  test('it does not spend a fault the venue was holding', () => {
    // The check used to run after the demo fault had already been triggered, so
    // a number the caller got wrong could consume a fault armed for a real
    // confirmation - and the venue really did move, because of the bad command.
    const venue = store();
    const { command } = readyToConfirm(venue, 'stale-tab-fault');
    venue.armOutage('east-lift');
    const before = invariant(venue.snapshot());

    assert.throws(() => venue.commitBundle({ ...command, expectedResourceVersion: 0 }));

    const after = venue.snapshot();
    assert.equal(after.demo.pendingOutageResourceId, 'east-lift', 'a bad number spent the armed fault');
    assert.equal(after.resources['east-lift'].status, 'OPERATIONAL', 'a bad number took the lift out');
    assert.deepStrictEqual(invariant(after), before);
  });

  test('a venue that really moved is still STALE_RESOURCE_VERSION', () => {
    // The positive control. Without it the repair could become "never report a
    // stale venue", which is the demo's central claim.
    const venue = store();
    const { command } = readyToConfirm(venue, 'genuinely-stale');
    venue.setFacilityOutage('garden-lift', 'POWER_FAULT');

    assert.throws(
      () => venue.commitBundle(command),
      (error) => error.code === 'STALE_RESOURCE_VERSION',
      'a real venue change must still be reported as one',
    );
    assert.equal(venue.snapshot().activePlan.status, 'STALE');
    assert.equal(venue.snapshot().phase, 'PLAN_STALE');
  });

  test('the armed-fault race still refuses and books nothing', () => {
    // The demo's own scenario: the fault lands during a confirmation that
    // carried the correct number. That is a venue change and must stay one.
    const venue = store();
    const { command } = readyToConfirm(venue, 'demo-race');
    venue.armOutage('east-lift');

    assert.throws(
      () => venue.commitBundle(command),
      (error) => error.code === 'STALE_RESOURCE_VERSION',
      'the demo race no longer reports a stale venue',
    );
    const after = venue.snapshot();
    assert.equal(after.atomicity.bookingCount, 0, 'nothing may be booked');
    assert.equal(after.atomicity.reservedResourceCount, 0, 'nothing may be reserved');
    assert.equal(venue.explainRefusal().partialReservations, 0);
    assert.equal(after.demo.pendingOutageResourceId, null, 'the armed fault should have been spent');
  });

  test('a stale venue is reported as stale even when the number is also wrong', () => {
    // The caller-revision check ran first and unconditionally, so a venue that
    // really had moved answered EXPECTED_RESOURCE_VERSION_MISMATCH - whose
    // message says "the plan is still valid" while the plan was STALE, and
    // whose advice, followed exactly, then returned STALE_RESOURCE_VERSION.
    // A refusal that states something false about the venue is the defect this
    // whole product is about.
    const venue = store();
    const { command } = readyToConfirm(venue, 'both-wrong');
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    assert.equal(venue.snapshot().activePlan.status, 'STALE', 'the setup should have invalidated the plan');

    const current = venue.snapshot().resourceVersion;
    assert.throws(
      () => venue.commitBundle({ ...command, expectedResourceVersion: current }),
      (error) => error.code === 'STALE_RESOURCE_VERSION',
      'a moved venue was reported as a caller mistake',
    );
  });

  test('the mismatch refusal only ever claims the plan is valid when it is', () => {
    // Both refusals in one property: whatever is reported, the sentence must
    // agree with the plan the venue is actually holding.
    for (const alsoMoveTheVenue of [false, true]) {
      const venue = store();
      const { command } = readyToConfirm(venue, `claim-${alsoMoveTheVenue}`);
      if (alsoMoveTheVenue) venue.setFacilityOutage('east-lift', 'POWER_FAULT');

      let refusal = null;
      try {
        venue.commitBundle({ ...command, expectedResourceVersion: 0 });
      } catch (error) {
        refusal = error;
      }
      assert.ok(refusal, 'a wrong number should always be refused');

      const stillValid = venue.snapshot().activePlan.status !== 'STALE';
      const saysStillValid = /still valid/i.test(refusal.message);
      assert.equal(
        saysStillValid,
        stillValid,
        `the refusal ${saysStillValid ? 'claims' : 'denies'} the plan is valid while it is ${stillValid ? 'valid' : 'STALE'}`,
      );
    }
  });

  test('every non-numeric or absent revision is a mismatch, not a venue change', () => {
    for (const wrong of [undefined, null, 'two', Number.NaN, -1, 99]) {
      const venue = store();
      const { command } = readyToConfirm(venue, `wrong-${String(wrong)}`);
      const before = invariant(venue.snapshot());
      try {
        venue.commitBundle({ ...command, expectedResourceVersion: wrong });
        assert.fail(`${String(wrong)} was accepted as a revision`);
      } catch (error) {
        assert.equal(
          error.code,
          'EXPECTED_RESOURCE_VERSION_MISMATCH',
          `${String(wrong)} was refused as ${error.code}`,
        );
      }
      assert.deepStrictEqual(invariant(venue.snapshot()), before, `${String(wrong)} moved the venue`);
    }
  });
});
