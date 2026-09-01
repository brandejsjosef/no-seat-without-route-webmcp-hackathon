/**
 * Advice that contradicts its own diagnosis.
 *
 * With both lifts out the venue answered:
 *
 *   blockedBy: ["LIFT_OPERATIONAL"]
 *   requirementChangeCanHelp: false
 *   nextAction: CHANGE_REQUIREMENTS
 *
 * The second line says no requirement change can help. The third tells the agent
 * to change requirements. An agent that follows the advertised action loops, and
 * the one field that would have stopped it was already there and ignored.
 *
 * The rule is not "say CONTACT_VENUE_STAFF when a lift is down". Aggregate
 * blockers routinely contain both a venue rule and a waivable one, and the
 * advice has to follow whether ANY candidate route could be reopened by a legal
 * requirement value - not whether the blocker list happens to mention distance.
 *
 * Every expectation below is derived from the venue at runtime.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDemoStore } from '../../lib/domain.mjs';
import { startTestServer } from '../helpers/test-server.mjs';
import { incidentView } from '../../public/views.mjs';

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

const refusalOf = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
};

describe('the advertised action follows the diagnosis it ships with', () => {
  test('both lifts out: no requirement value reopens the venue, so do not advise changing them', () => {
    const refusal = refusalOf(() => bothLiftsOut(store()).findBundle(FULL));
    assert.equal(refusal?.code, 'NO_COMPLETE_BUNDLE');
    assert.equal(refusal.details.requirementChangeCanHelp, false);
    assert.equal(
      refusal.details.nextAction,
      'CONTACT_VENUE_STAFF',
      'the advice contradicts the diagnosis shipped beside it',
    );
  });

  test('distance-only no-match still advises changing requirements', () => {
    // The positive control. If this ever flips, the rule has become "a refusal
    // means contact staff", which is useless in the ordinary case.
    const refusal = refusalOf(() => store().findBundle({ ...FULL, maxDistanceM: 20 }));
    assert.equal(refusal?.code, 'NO_COMPLETE_BUNDLE');
    assert.equal(refusal.details.requirementChangeCanHelp, true);
    assert.equal(refusal.details.nextAction, 'CHANGE_REQUIREMENTS');
  });

  test('one lift down plus a relaxable distance is still a requirement problem', () => {
    const venue = store();
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    const refusal = refusalOf(() => venue.findBundle({ ...FULL, maxDistanceM: 20 }));
    assert.equal(refusal?.code, 'NO_COMPLETE_BUNDLE');
    assert.equal(
      refusal.details.requirementChangeCanHelp,
      true,
      'Garden is still operational, so relaxing distance reopens it',
    );
    assert.equal(refusal.details.nextAction, 'CHANGE_REQUIREMENTS');
  });

  test('both lifts out plus a distance blocker is still a venue problem', () => {
    // The aggregate blockedBy contains ROUTE_DISTANCE here. Advice must follow
    // reachability, not the presence of a waivable rule in the list.
    const refusal = refusalOf(() => bothLiftsOut(store()).findBundle({ ...FULL, maxDistanceM: 20 }));
    assert.equal(refusal?.code, 'NO_COMPLETE_BUNDLE');
    assert.ok(refusal.details.blockedBy.includes('ROUTE_DISTANCE'), 'the setup should also block on distance');
    assert.equal(refusal.details.requirementChangeCanHelp, false);
    assert.equal(refusal.details.nextAction, 'CONTACT_VENUE_STAFF');
  });

  test('a failed replan carries the same advice instead of overwriting it', () => {
    const venue = store();
    const plan = venue.findBundle(FULL);
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    bothLiftsOut(venue);

    const refusal = refusalOf(() => venue.replanBundle(plan.id));
    assert.equal(refusal?.code, 'NO_COMPLETE_BUNDLE');
    assert.equal(refusal.details.requirementChangeCanHelp, false);
    assert.equal(
      refusal.details.nextAction,
      'CONTACT_VENUE_STAFF',
      'the replan path overwrote the diagnosis it caught',
    );
  });

  test('a fresh dead-end refusal creates nothing', () => {
    const venue = bothLiftsOut(store());
    const before = venue.snapshot();
    refusalOf(() => venue.findBundle(FULL));
    const after = venue.snapshot();

    assert.equal(after.phase, 'READY', 'a refused search moved the phase');
    assert.equal(after.activePlan, null, 'a refused search opened a plan');
    assert.equal(after.atomicity.bookingCount, 0);
    assert.equal(after.atomicity.reservedResourceCount, 0);
    assert.equal(after.resourceVersion, before.resourceVersion, 'a refused search moved the revision');
  });
});

describe('every surface reports the same advice', () => {
  test('the domain, the explain call and the HTTP refusal agree exactly', async (t) => {
    const server = await startTestServer(t);
    const visitor = await server.session('visitor');
    const operator = await server.session('operator', visitor.demoId);

    await server.post('/api/operator/facilities/east-lift/outage', { reasonCode: 'POWER_FAULT' }, operator.token);
    await server.post('/api/operator/facilities/garden-lift/outage', { reasonCode: 'POWER_FAULT' }, operator.token);

    const response = await server.post('/api/plans', FULL, visitor.token);
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error.code, 'NO_COMPLETE_BUNDLE');
    assert.equal(body.error.requirementChangeCanHelp, false);
    assert.equal(body.error.nextAction, 'CONTACT_VENUE_STAFF', 'the HTTP refusal advertises a different action');

    // The local domain, given the same venue, must produce the same three fields.
    const local = refusalOf(() => bothLiftsOut(store()).findBundle(FULL));
    assert.deepEqual(body.error.blockedBy, local.details.blockedBy);
    assert.equal(body.error.requirementChangeCanHelp, local.details.requirementChangeCanHelp);
    assert.equal(body.error.nextAction, local.details.nextAction);
  });
});

describe('the venue ships the diagnosis the visitor page prints', () => {
  test('a venue-only dead end carries requirementChangeCanHelp false in the state payload', () => {
    const venue = store();
    const plan = venue.findBundle(FULL);
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    bothLiftsOut(venue);
    refusalOf(() => venue.replanBundle(plan.id));

    const snapshot = venue.snapshot();
    assert.equal(snapshot.phase, 'NO_ALTERNATIVE');
    assert.ok(snapshot.diagnosis, 'the page has nothing to print the next action from');
    assert.equal(snapshot.diagnosis.requirementChangeCanHelp, false);
    assert.equal(snapshot.diagnosis.nextAction, 'CONTACT_VENUE_STAFF');
  });

  test('the field is absent where there is nothing to diagnose', () => {
    assert.equal(store().snapshot().diagnosis, undefined, 'an idle venue ships a diagnosis of nothing');
  });

  test('a venue-only dead end never offers to change requirements', () => {
    // The mutation this exists for: reverting the button to a bare "Change
    // requirements" survived the whole gate, because the only guard was against
    // printing a literal NEXT ACTION and the button copy was not covered. The
    // decision is a function now, and both branches are asserted.
    const venue = store();
    const plan = venue.findBundle(FULL);
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    bothLiftsOut(venue);
    refusalOf(() => venue.replanBundle(plan.id));

    const view = incidentView(venue.snapshot());
    assert.equal(view.venueOnly, true, 'the venue-only dead end was not recognised');
    assert.doesNotMatch(view.buttonLabel, /change requirements/i, 'the control claims editing requirements helps');
    assert.doesNotMatch(view.message, /Change a requirement/i, 'the copy claims editing requirements helps');
    assert.equal(view.nextAction, 'CONTACT_VENUE_STAFF');
  });

  test('a dead end a requirement really can fix still says so', () => {
    // The positive control. Without it the rule could become "never mention
    // requirements", which is wrong in the ordinary case.
    const venue = store();
    const plan = venue.findBundle(FULL);
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');

    const view = incidentView(venue.snapshot());
    assert.equal(view.venueOnly, false);
    assert.match(view.buttonLabel, /another complete plan|change requirements/i);
  });

  test('the visitor page takes both from that one function', async () => {
    const source = await import('node:fs/promises')
      .then(({ readFile }) => readFile(new URL('../../public/app.js', import.meta.url), 'utf8'));
    assert.match(source, /incidentView\(/, 'the page decides its own dead-end copy again');
    const literals = source.split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => /setText\(elements\.replanButton, '/.test(line))
      .map(({ number, line }) => `app.js:${number} ${line.trim().slice(0, 60)}`);
    assert.deepEqual(literals, [], `the replan control is set from a literal: ${literals.join(' | ')}`);
  });

  test('the page never prints a next action it decided by itself', async () => {
    // The incident card used to print the literal CHANGE_REQUIREMENTS whatever
    // the venue said. A literal in that position cannot follow the diagnosis, so
    // it is forbidden outright rather than checked for one value.
    const source = await import('node:fs/promises')
      .then(({ readFile }) => readFile(new URL('../../public/app.js', import.meta.url), 'utf8'));
    const printed = source.split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => /next action [A-Z_]{4,}/.test(line))
      .map(({ number, line }) => `app.js:${number} ${line.trim().slice(0, 70)}`);
    assert.deepEqual(printed, [], `these print a next action decided on the page: ${printed.join(' | ')}`);
  });
});

describe('the published tool mapping cannot overwrite a richer diagnosis', () => {
  test('NO_COMPLETE_BUNDLE has no blanket next action that wins over the domain', async () => {
    // NEXT_ACTION_BY_CODE existed as a fallback for refusals that carry no
    // details. For NO_COMPLETE_BUNDLE the domain always has a better answer, so
    // a static entry here can only ever be wrong half the time.
    const source = await import('node:fs/promises')
      .then(({ readFile }) => readFile(new URL('../../public/tools.mjs', import.meta.url), 'utf8'));
    const mapping = source.slice(source.indexOf('NEXT_ACTION_BY_CODE'), source.indexOf('});', source.indexOf('NEXT_ACTION_BY_CODE')));
    assert.doesNotMatch(
      mapping,
      /NO_COMPLETE_BUNDLE\s*:/,
      'a static next action for NO_COMPLETE_BUNDLE can overwrite the domain diagnosis',
    );
  });
});

/**
 * The control has to DO what its label says.
 *
 * The label was decided by the diagnosis in public/views.mjs and the action was
 * decided by the phase in public/app.js. Two sources for one control, so they
 * disagreed exactly where the two disagree: a venue with every lift out and no
 * replan attempted yet is still PLAN_STALE, so the page ran the replan while
 * the button read "Back to my requirements". The visitor was promised their
 * requirements and got a network call the venue had already called useless.
 */
describe('the incident control does what its label says', () => {
  const staleVenueOnly = () => {
    const venue = store();
    const plan = venue.findBundle(FULL);
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    bothLiftsOut(venue);
    return venue;
  };

  test('the case exists: a venue-only refusal that is still PLAN_STALE', () => {
    // Without this the test below could pass against NO_ALTERNATIVE, which was
    // never broken, and prove nothing about the branch that was.
    const snapshot = staleVenueOnly().snapshot();
    assert.equal(snapshot.phase, 'PLAN_STALE');
    assert.equal(incidentView(snapshot).venueOnly, true);
  });

  test('a control offering the requirements clears the plan instead of replanning', () => {
    const view = incidentView(staleVenueOnly().snapshot());
    assert.match(view.buttonLabel, /back to my requirements/i);
    assert.equal(view.action, 'CLEAR_PLAN', 'the label offers the requirements and the action replans');
  });

  test('an ordinary stale plan still replans, and says so', () => {
    // The positive control: the rule is not "always clear".
    const venue = store();
    const plan = venue.findBundle(FULL);
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');

    const view = incidentView(venue.snapshot());
    assert.equal(view.venueOnly, false);
    assert.equal(view.action, 'REPLAN');
    assert.match(view.buttonLabel, /another complete plan/i);
  });

  test('no reachable state pairs a requirements label with a replan', () => {
    // Exhaustive over the branches rather than over the two cases above: a
    // third branch added later is covered without anyone remembering to.
    const venues = [staleVenueOnly(), (() => {
      const venue = staleVenueOnly();
      refusalOf(() => venue.replanBundle(venue.snapshot().activePlan.id));
      return venue;
    })()];
    for (const venue of venues) {
      const view = incidentView(venue.snapshot());
      const offersRequirements = /requirements/i.test(view.buttonLabel);
      assert.equal(
        offersRequirements && view.action !== 'CLEAR_PLAN',
        false,
        `"${view.buttonLabel}" runs ${view.action} in ${venue.snapshot().phase}`,
      );
    }
  });

  test('the page dispatches on that action, not on the phase', async () => {
    const source = await import('node:fs/promises')
      .then(({ readFile }) => readFile(new URL('../../public/app.js', import.meta.url), 'utf8'));
    assert.match(source, /incident(View\([^)]*\))?\.action|\.action === 'CLEAR_PLAN'/, 'the page decides the action itself again');
    assert.doesNotMatch(
      source,
      /currentState\.phase === 'NO_ALTERNATIVE'\)\s*\{\s*await clearPlanForEditing/,
      'the action is chosen by phase again, which is the disagreement this covers',
    );
  });

  test('the busy label does not promise a replan the control is not running', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /replanButton\.textContent = 'Checking another complete route…'/,
      'the pressed control announces a replan whatever it is about to do',
    );
  });
});
