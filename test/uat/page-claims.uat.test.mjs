/**
 * Four sentences the visitor page said that were not true of the page saying
 * them, all found by driving the product rather than reading it.
 *
 *  - The standing refusal banner told a visitor to change a requirement while
 *    the server's own refusal for that very call said no requirement change can
 *    help. `incidentView` already turns that diagnosis into honest copy, but the
 *    incident card renders only in PLAN_STALE and NO_ALTERNATIVE - a READY-phase
 *    refusal opens no plan, so the honest copy was unreachable and a hardcoded
 *    literal was the only thing the visitor ever saw. The same defect class the
 *    project documents as fixed, alive in the one path the fix did not cover.
 *
 *  - Replanning around an outage on the OTHER route announced "the route
 *    changed", offered "the replacement plan" and logged "Old route replaced" -
 *    while handing back a byte-identical route. The domain knows: it clears the
 *    exclusion list precisely because the same route is still the answer. Every
 *    visible string disagreed with it. Asking a disabled visitor to re-evaluate
 *    an arrival route that did not change is the opposite of the promise.
 *
 *  - A confirmed booking's verification line restated the CURRENT venue
 *    revision as the one the booking was committed at, contradicting the
 *    receipt directly beneath it.
 *
 *  - In PLAN_READY the build control read "Preparing your plan..." for ever.
 *    Nothing was preparing anything; if the agent never stages, it is terminal.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDemoStore } from '../../lib/domain.mjs';
import {
  standingRefusalView, replanOutcomeView, incidentView,
  focusRefuge, bookedResourcesOutOfService, bookingBreakageAnnouncement,
} from '../../public/views.mjs';

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

const refusalOf = (run) => {
  try { run(); } catch (error) { return error; }
  throw new Error('expected a refusal and the call succeeded');
};

const appSource = async () => {
  const { readFile } = await import('node:fs/promises');
  return readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
};

describe('the standing refusal repeats the venue diagnosis, not a literal', () => {
  test('a venue-only refusal does not tell the visitor to change a requirement', () => {
    const venue = store();
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    venue.setFacilityOutage('garden-lift', 'POWER_FAULT');
    const error = refusalOf(() => venue.findBundle(FULL));

    // The server's own answer for this exact call.
    assert.equal(error.details.requirementChangeCanHelp, false);
    assert.equal(error.details.nextAction, 'CONTACT_VENUE_STAFF');

    const view = standingRefusalView(error.message, error.details);
    assert.doesNotMatch(view.text, /change a requirement/i, 'the banner contradicts the refusal beside it');
    assert.match(view.text, /operations page|lift/i, 'the banner does not say where the problem is');
    assert.equal(view.requirementChangeCanHelp, false);
  });

  test('a refusal a requirement really can fix still says so', () => {
    // The positive control: the rule is not "never mention requirements".
    const venue = store();
    const error = refusalOf(() => venue.findBundle({ ...FULL, maxDistanceM: 20 }));
    assert.equal(error.details.requirementChangeCanHelp, true);

    const view = standingRefusalView(error.message, error.details);
    assert.match(view.text, /change a requirement/i, 'a fixable refusal hides the fix');
    assert.equal(view.requirementChangeCanHelp, true);
  });

  test('it names the distance that would work when the venue computed one', () => {
    const venue = store();
    const error = refusalOf(() => venue.findBundle({ ...FULL, maxDistanceM: 20 }));
    assert.equal(error.details.shortestFeasibleDistanceM, 64);
    assert.match(standingRefusalView(error.message, error.details).text, /64/);
  });

  test('a refusal with no diagnosis at all still produces a usable sentence', () => {
    const view = standingRefusalView('Something went wrong.', {});
    assert.match(view.text, /Something went wrong\./);
  });

  test('the page takes the banner from that function', async () => {
    const source = await appSource();
    assert.match(source, /standingRefusalView\(/, 'the page writes its own refusal banner again');
    // Secondary mutation backstop only: the browser suite drives the real
    // READY refusal and checks the rendered diagnosis. This catches the small
    // integration mutation that keeps the helper name while throwing away the
    // server's diagnosis before a browser run is reached.
    assert.doesNotMatch(
      source,
      /standingRefusalView\(\s*refusal\?\.message\s*,\s*\{\s*\}\s*\)/,
      'the page calls the right helper but discards the refusal diagnosis',
    );
    assert.doesNotMatch(
      source,
      /Change a requirement, or check the venue operations page/,
      'the literal that contradicted the diagnosis is back',
    );
  });
});

describe('a replan that keeps the same route does not call it a replacement', () => {
  /** The outage is on the OTHER route, so the plan's own route still works. */
  const unrelatedOutage = () => {
    const venue = store();
    const plan = venue.findBundle(FULL);
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    venue.setFacilityOutage('garden-lift', 'POWER_FAULT');
    return { venue, replacement: venue.replanBundle(plan.id), before: plan };
  };

  test('the venue really does hand back the same route', () => {
    // The control. The domain clears the exclusion list on purpose here.
    const { replacement, before } = unrelatedOutage();
    assert.equal(replacement.routeId, before.routeId);
    assert.deepEqual(replacement.route.path, before.route.path);
  });

  test('the plan carries what it superseded, so the page can tell', () => {
    const { replacement, before } = unrelatedOutage();
    assert.equal(replacement.supersedesRouteId, before.routeId);
  });

  test('so the copy says it was rechecked, not replaced', () => {
    const { replacement } = unrelatedOutage();
    const view = replanOutcomeView(replacement);
    assert.equal(view.sameRoute, true);
    assert.doesNotMatch(view.eyebrow, /alternative/i);
    assert.doesNotMatch(view.heading, /route changed/i);
    assert.doesNotMatch(view.confirmLabel, /replacement/i);
    assert.doesNotMatch(view.toast, /replacement/i);
    assert.match(view.heading, /rechecked|re-checked|still/i);
  });

  test('a replan that really does change the route still says replacement', () => {
    // The positive control, and the case the wording was written for.
    const venue = store();
    const plan = venue.findBundle(FULL);
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    const replacement = venue.replanBundle(plan.id);

    assert.notEqual(replacement.routeId, plan.routeId, 'this control no longer changes the route');
    const view = replanOutcomeView(replacement);
    assert.equal(view.sameRoute, false);
    assert.match(view.heading, /changed/i);
    assert.match(view.confirmLabel, /replacement/i);
  });

  test('an ordinary first plan is not described as either', () => {
    const view = replanOutcomeView(store().findBundle(FULL));
    assert.equal(view.sameRoute, null, 'a plan that supersedes nothing was compared to something');
  });

  test('the page takes those strings from that function', async () => {
    const source = await appSource();
    assert.match(source, /replanOutcomeView\(/, 'the page writes its own replan copy again');
    assert.doesNotMatch(
      source,
      /A complete replacement route is ready for your decision\./,
      'the unconditional replacement toast is back',
    );
  });
});

describe('a confirmed booking is described by its own numbers', () => {
  test('the committed revision is the booking\'s, not whatever the venue is now', async () => {
    const source = await appSource();
    assert.doesNotMatch(
      source,
      /Committed together . venue revision \$\{state\.resourceVersion\}/,
      'the confirmation line restates the current revision as the committed one',
    );
    assert.match(source, /committedResourceVersion/, 'the page never reads the number the booking carries');
  });

  test('and the venue really can move after a booking, which is why it matters', () => {
    const venue = store();
    const plan = venue.findBundle(FULL);
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    const confirmation = venue.prepareConfirmation(plan.id);
    venue.commitBundle({
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
      requestId: 'the-click',
    });
    const committedAt = venue.snapshot().booking.committedResourceVersion;
    venue.setFacilityOutage('garden-lift', 'POWER_FAULT');

    assert.notEqual(
      venue.snapshot().resourceVersion,
      committedAt,
      'the two numbers are equal here, so this scenario cannot catch the defect',
    );
    assert.equal(venue.snapshot().booking.committedResourceVersion, committedAt);
  });
});

describe('a disabled control does not claim work nobody is doing', () => {
  test('the build control does not say a plan is being prepared', async () => {
    const source = await appSource();
    assert.doesNotMatch(
      source,
      /Preparing your plan/,
      'PLAN_READY is terminal if the agent never stages, so this never stops being wrong',
    );
  });

  test('every control that disables itself mid-request keeps focus somewhere', async () => {
    // confirmPlan, replan and clearPlanForEditing set .disabled directly rather
    // than through the page's own disableSafely helper, so pressing one with the
    // keyboard dropped focus to <body> - and on the failure paths it was never
    // put back.
    const source = await appSource();
    const raw = source.split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => /^elements\.\w+Button\.disabled = true;$/.test(line)
        || /button\.disabled = true;/.test(line));
    assert.deepEqual(
      raw.map(({ number, line }) => `app.js:${number} ${line}`),
      [],
      'a control is disabled without the focus guard',
    );
  });
});

describe('the incident heading names what actually happened', () => {
  const stagedPlan = (venue) => {
    const plan = venue.findBundle(FULL);
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    return plan;
  };

  test('an outage on the other route did not change this route', () => {
    // The control: the plan's own claims all still hold.
    const venue = store();
    stagedPlan(venue);
    venue.setFacilityOutage('garden-lift', 'POWER_FAULT');
    const snapshot = venue.snapshot();

    assert.equal(snapshot.phase, 'PLAN_STALE');
    assert.equal(
      snapshot.activePlan.claims.every((claim) => ['OPERATIONAL', 'AVAILABLE'].includes(claim.currentStatus)),
      true,
      'this scenario no longer leaves the route intact, so it cannot catch the defect',
    );

    const view = incidentView(snapshot);
    assert.doesNotMatch(view.heading, /route changed/i, 'the page announces a route change that did not happen');
    assert.match(view.heading, /venue|updated/i);
  });

  test('an outage on this route really did change it, and says so', () => {
    // The positive control: the static heading was right in this case, which is
    // why it survived. It has to stay right.
    const venue = store();
    stagedPlan(venue);
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');

    const view = incidentView(venue.snapshot());
    assert.match(view.heading, /route/i);
  });

  test('the page takes the heading from that function', async () => {
    const source = await appSource();
    assert.match(source, /incidentHeading, incident\.heading|setText\(elements\.incidentHeading/, 'the heading is static markup again');
  });
});

describe('a booking whose route breaks afterwards is not reported as fine in silence', () => {
  test('the venue really can break a booked route', () => {
    // The control. Nothing is refunded or cancelled - the booking stands - but
    // the page showed "Your accessible booking is complete." over a resource
    // grid reading "East Lift L2 - Out of service", and announced nothing.
    const venue = store();
    const plan = venue.findBundle(FULL);
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    const confirmation = venue.prepareConfirmation(plan.id);
    venue.commitBundle({
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
      requestId: 'the-click',
    });
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');

    const snapshot = venue.snapshot();
    assert.equal(snapshot.phase, 'CONFIRMED');
    assert.equal(snapshot.booking.resourceIds.includes('east-lift'), true);
    assert.equal(snapshot.resources['east-lift'].status, 'OUT_OF_SERVICE');
  });

  test('the page announces it', async () => {
    const source = await appSource();
    assert.match(
      source,
      /bookingBreakageAnnouncement\(/,
      'nothing on the page notices that a booked resource left service',
    );
    // The browser test proves a used lift is named and the alert survives a
    // later poll. This regex only stops a mutation from preserving the helper
    // call while replacing its live labels with an always-empty array.
    assert.doesNotMatch(
      source,
      /bookingBreakageAnnouncement\(\s*\[\s*\]\s*\)/,
      'the page calls the announcer with no booked-resource failures',
    );
  });
});

/**
 * Three decisions that used to live in public/app.js, where no Node test can
 * reach them - so each was "covered" by a test that searched the source for a
 * name. The mutation matrix showed what that was worth: reverting all three
 * repairs left every one of those tests green, because a name survives a
 * mutation that empties the thing it names.
 *
 * They are pure functions in public/views.mjs now, imported by the page and by
 * these tests, so the shipped decision is the one under test.
 */
describe('focus lands somewhere real when a held control is disabled', () => {
  test('nothing moves when the visitor was not holding the control', () => {
    assert.equal(focusRefuge({ focusIsOnControl: false, fallbackVisible: true }), 'NONE');
    assert.equal(focusRefuge({ focusIsOnControl: false, fallbackVisible: false }), 'NONE');
  });

  test('the preferred landing place is used when it is actually on screen', () => {
    assert.equal(focusRefuge({ focusIsOnControl: true, fallbackVisible: true }), 'FALLBACK');
  });

  test('and #main takes it when that landing place is inside a hidden section', () => {
    // The defect: focus() on a hidden element is a no-op, so disabling the
    // control then dropped focus to <body>. Reached by an agent creating a plan
    // under a visitor typing their requirements - #decision-heading lives in a
    // section that is hidden in PLAN_READY.
    assert.equal(focusRefuge({ focusIsOnControl: true, fallbackVisible: false }), 'MAIN');
  });

  test('focus is never left nowhere: holding the control always yields a target', () => {
    // The property, rather than the three cases. A fourth combination added
    // later is covered by this without anyone remembering to add it.
    for (const fallbackVisible of [true, false]) {
      assert.notEqual(
        focusRefuge({ focusIsOnControl: true, fallbackVisible }),
        'NONE',
        `focus is dropped when the fallback is ${fallbackVisible ? 'visible' : 'hidden'}`,
      );
    }
  });

  test('a call with no arguments at all does not claim focus was moved', () => {
    assert.equal(focusRefuge(), 'NONE');
  });
});

describe('a booked resource leaving service is noticed and said', () => {
  const confirmedVenue = () => {
    const venue = store();
    const plan = venue.findBundle(FULL);
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    const confirmation = venue.prepareConfirmation(plan.id);
    venue.commitBundle({
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
      requestId: 'the-click',
    });
    return venue;
  };

  test('an intact booking has nothing to report', () => {
    // The control: silence has to mean something.
    const snapshot = confirmedVenue().snapshot();
    const out = bookedResourcesOutOfService(snapshot.booking, snapshot.resources);
    assert.deepEqual(out, []);
    assert.equal(bookingBreakageAnnouncement(out), null);
  });

  test('a lift that goes out after the booking is named', () => {
    const venue = confirmedVenue();
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    const snapshot = venue.snapshot();

    const out = bookedResourcesOutOfService(snapshot.booking, snapshot.resources);
    assert.deepEqual(out, ['East Lift L2'], 'the broken booked resource is not noticed');

    const said = bookingBreakageAnnouncement(out);
    assert.match(said, /East Lift L2/);
    assert.match(said, /still stands/i, 'the visitor is not told the booking survives');
  });

  test('an outage on a lift this booking does not use is not reported', () => {
    // The negative control: the booking is on the East route, so a Garden Lift
    // outage is none of its business.
    const venue = confirmedVenue();
    venue.setFacilityOutage('garden-lift', 'POWER_FAULT');
    const snapshot = venue.snapshot();
    assert.deepEqual(bookedResourcesOutOfService(snapshot.booking, snapshot.resources), []);
  });

  test('two broken resources are both named', () => {
    const venue = confirmedVenue();
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    venue.setResourceUnavailable('space-w12');
    const snapshot = venue.snapshot();

    const out = bookedResourcesOutOfService(snapshot.booking, snapshot.resources);
    assert.equal(out.length, 2, `only ${out.join(', ')} was reported`);
    assert.match(bookingBreakageAnnouncement(out), / and /);
  });

  test('a booking that is not there is not described as broken', () => {
    assert.deepEqual(bookedResourcesOutOfService(null, {}), []);
    assert.equal(bookingBreakageAnnouncement([]), null);
  });
});
