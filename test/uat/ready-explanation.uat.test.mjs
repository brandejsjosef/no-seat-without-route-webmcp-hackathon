/**
 * Explaining a refusal that never opened a plan.
 *
 * From a fresh visit to a venue with both lifts out, `find_access_bundle`
 * refuses, no plan is created, and the phase stays READY. `explainRefusal()`
 * only ever reported the two phases that carry an open plan, so the agent was
 * refused and then told there was nothing to explain.
 *
 * Registering the tool in READY without fixing that is worse than leaving it
 * absent: the tool named for the question is then present and answers
 * "Nothing is blocked" immediately after a refusal. That false fix was shipped
 * earlier in this project and is what these tests exist to prevent returning.
 *
 * The context is deliberately thin. It stores what was asked and what the venue
 * answered - never a plan, a reservation, or a revision - and it is recomputed
 * against current resources on every read, so a repaired venue can never be
 * described with the blockers it had a minute ago.
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

const bothLiftsOut = (venue) => {
  venue.setFacilityOutage('east-lift', 'POWER_FAULT');
  venue.setFacilityOutage('garden-lift', 'POWER_FAULT');
  return venue;
};

const refuse = (venue, requirements = FULL) => {
  try {
    venue.findBundle(requirements);
    return null;
  } catch (error) {
    return error;
  }
};

describe('a refusal that opened no plan is still explicable', () => {
  test('before anything is asked, nothing is blocked', () => {
    const explanation = bothLiftsOut(store()).explainRefusal();
    assert.equal(explanation.blocked, false, 'a venue nobody has asked cannot have a refusal to explain');
  });

  test('after a failed search in READY, the explanation agrees with the refusal', () => {
    const venue = bothLiftsOut(store());
    const refusal = refuse(venue);
    assert.equal(refusal.code, 'NO_COMPLETE_BUNDLE');
    assert.equal(venue.snapshot().phase, 'READY', 'the refusal must not move the phase');

    const explanation = venue.explainRefusal();
    assert.equal(explanation.blocked, true, 'the tool named for a refusal reported nothing to explain');
    assert.equal(explanation.errorCode, 'NO_COMPLETE_BUNDLE');
    assert.deepEqual(explanation.blockedBy, refusal.details.blockedBy);
    assert.equal(explanation.requirementChangeCanHelp, refusal.details.requirementChangeCanHelp);
    assert.equal(explanation.nextAction, refusal.details.nextAction);
  });

  test('remembering the refusal creates nothing', () => {
    const venue = bothLiftsOut(store());
    const before = venue.snapshot();
    refuse(venue);
    const after = venue.snapshot();

    assert.equal(after.resourceVersion, before.resourceVersion, 'remembering a refusal moved the revision');
    assert.equal(after.activePlan, null, 'remembering a refusal opened a plan');
    assert.equal(after.booking, null);
    assert.equal(after.atomicity.bookingCount, 0);
    assert.equal(after.atomicity.reservedResourceCount, 0);
    assert.equal(venue.explainRefusal().partialReservations, 0);
  });

  test('a repaired venue is never described with the blockers it used to have', () => {
    // The trap this design exists to avoid: a remembered answer presented as a
    // current one. The stored requirements are re-evaluated against the venue as
    // it stands now.
    const venue = bothLiftsOut(store());
    refuse(venue);
    assert.equal(venue.explainRefusal().blocked, true);

    venue.restoreFacility('east-lift');

    const explanation = venue.explainRefusal();
    assert.equal(explanation.blocked, false, 'a restored lift left the old dead end on screen');
  });

  test('a venue that gets worse is described as it is now, not as it was', () => {
    const venue = store();
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    const first = refuse(venue, { ...FULL, maxDistanceM: 20 });
    assert.equal(first.details.requirementChangeCanHelp, true, 'Garden still works, so this is a requirement problem');

    bothLiftsOut(venue);

    const explanation = venue.explainRefusal();
    assert.equal(explanation.blocked, true);
    assert.equal(explanation.requirementChangeCanHelp, false, 'the venue closed and the explanation did not notice');
    assert.equal(explanation.nextAction, 'CONTACT_VENUE_STAFF');
  });

  test('a successful search clears the remembered refusal', () => {
    const venue = bothLiftsOut(store());
    refuse(venue);
    venue.restoreFacility('east-lift');
    venue.findBundle(FULL);
    // Written the wrong way round first: I asserted blocked:true here, which is
    // not what a successful search means. The plan is open and nothing is
    // refused, so the remembered refusal must be gone rather than reported.
    const explanation = venue.explainRefusal();
    assert.equal(explanation.blocked, false, 'a successful plan left a refusal behind');
    assert.equal(explanation.errorCode ?? null, null);
  });

  test('reset clears it', () => {
    const venue = bothLiftsOut(store());
    refuse(venue);
    venue.reset();
    assert.equal(venue.explainRefusal().blocked, false, 'reset left a refusal from the previous venue');
  });

  test('clearing a dead-end plan does not make a still-closed venue inexplicable', () => {
    // The sequence a person actually performs: the replan fails, they clear the
    // plan to start again, and the venue is still shut. Clearing used to silence
    // the explanation entirely.
    const venue = store();
    const plan = venue.findBundle(FULL);
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    bothLiftsOut(venue);
    try { venue.replanBundle(plan.id); } catch { /* expected */ }
    assert.equal(venue.snapshot().phase, 'NO_ALTERNATIVE');

    venue.clearPlan(venue.snapshot().activePlan.id);

    const explanation = venue.explainRefusal();
    assert.equal(explanation.blocked, true, 'clearing the plan silenced a venue that is still shut');
    assert.equal(explanation.requirementChangeCanHelp, false);
    assert.equal(explanation.nextAction, 'CONTACT_VENUE_STAFF');
  });

  test('an open plan still takes precedence over a remembered search', () => {
    const venue = store();
    refuse(venue, { ...FULL, maxDistanceM: 20 });
    const plan = venue.findBundle(FULL);
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    bothLiftsOut(venue);

    const explanation = venue.explainRefusal();
    assert.equal(explanation.planId, plan.id, 'the remembered search hid the plan that is actually open');
  });
});

describe('one venue remembers its own refusal and no one else\'s', () => {
  test('two venues do not see each other', () => {
    const closed = bothLiftsOut(store());
    const open = store();
    refuse(closed);

    assert.equal(closed.explainRefusal().blocked, true);
    assert.equal(open.explainRefusal().blocked, false, 'a refusal leaked into a different venue');
  });

  test('the remembered context is not exposed as venue state', () => {
    // It is private to the explanation. A snapshot is sent to every page on
    // every poll; a refusal one visitor received is not venue state.
    const venue = bothLiftsOut(store());
    refuse(venue);
    const serialised = JSON.stringify(venue.snapshot());
    assert.doesNotMatch(serialised, /lastRefusal/i, 'the refusal context is being broadcast in the snapshot');
  });
});
