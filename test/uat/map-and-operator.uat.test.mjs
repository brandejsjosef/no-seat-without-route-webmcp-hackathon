/**
 * The venue map and the operator controls, neither of which any suite touched.
 *
 * A coverage audit against the testing pyramid put these at the top: the map is
 * the largest thing on the visitor page and 224 browser checks never once
 * selected it, and the operator page is one of the two role-scoped surfaces the
 * WebMCP argument rests on. Three defects were sitting in that gap, all of them
 * visible to anyone who looked and invisible to everything that ran.
 *
 * These tests were written before the fixes and watched to fail. What each one
 * failed with is recorded beside it, because a test whose failure nobody saw is
 * a test nobody has any reason to believe.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createDemoStore, demoDefaults } from '../../lib/domain.mjs';
import { auditTitle } from '../../public/views.mjs';

const read = (name) => readFile(new URL(`../../${name}`, import.meta.url), 'utf8');
const store = () => createDemoStore({
  clock: () => Date.parse('2026-08-30T18:00:00.000Z'),
  idFactory: ((n) => () => `id-${++n}`)(0),
});

describe('the map can draw a failure at all', () => {
  test('no SVG element is hidden through the .hidden IDL property', async () => {
    // RED was: "public/app.js toggles .hidden on 1 SVG element(s): east-outage-cross"
    //
    // hidden is an IDL attribute of HTMLElement. SVGElement does not inherit it,
    // so assigning to it creates an ordinary expando and never touches the
    // content attribute the UA stylesheet is matching on. The markup ships with
    // hidden set, so the OUT OF SERVICE cross has almost certainly never
    // rendered in the life of this project. Confirmed in the live browser:
    // after hidden = false, hasAttribute('hidden') was still true and the
    // computed display was still none.
    //
    // The author already knew SVG differs - the sibling line uses
    // className.baseVal rather than classList - and missed that hidden differs
    // in the same way.
    const [html, app] = await Promise.all([read('public/index.html'), read('public/app.js')]);

    const svgStart = html.indexOf('<svg');
    const svg = html.slice(svgStart, html.indexOf('</svg>', svgStart) + 6);
    const svgIds = [...svg.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(svgIds.length > 0, 'the map should carry addressable ids');

    const offenders = svgIds.filter((id) => {
      const handle = app.match(new RegExp(`(\\w+):\\s*document\\.querySelector\\('#${id}'\\)`));
      return handle ? new RegExp(`elements\\.${handle[1]}\\.hidden\\s*=`).test(app) : false;
    });
    assert.deepEqual(
      offenders,
      [],
      `public/app.js sets .hidden on SVG element(s): ${offenders.join(', ')} - `
      + 'SVGElement has no such IDL attribute, so the content attribute survives and the element never appears',
    );
  });

  test('the outage cross is driven by something that reaches the DOM', async () => {
    // Deliberately not tied to a variable name: the first version of this test
    // named elements.eastOutageCross and went red the moment the rendering was
    // generalised over both lifts, which is the fix working. What matters is
    // that every cross reaches the DOM through the attribute.
    const app = await read('public/app.js');
    assert.ok(
      app.includes("cross.toggleAttribute('hidden'"),
      'no outage cross is toggled through the hidden ATTRIBUTE; a property assignment never reaches an SVG element',
    );
  });
});

describe('the map tells the truth about whichever lift the plan uses', () => {
  test('a Garden Lift outage is drawn, not only described', async () => {
    // RED was: "the map has no #garden-outage-cross"
    //
    // app.js read state.resources['east-lift'] by name, so a Garden outage left
    // the map showing a healthy green route while the resource card beside it
    // read "Garden Lift L4 - Out of service". The picture contradicted the text
    // next to it, and no test looked at either.
    const html = await read('public/index.html');
    assert.ok(html.includes('id="garden-outage-cross"'), 'the map has no way to mark the Garden Lift out of service');
  });

  test('the drawing follows the planned lift rather than a hardcoded one', async () => {
    // Same lesson: assert the property, not the shape. The map must decide from
    // the plan's own lift, so both lifts have to appear in whatever drives it,
    // and neither may be the sole subject of the outage lookup.
    const app = await read('public/app.js');
    const start = app.indexOf('elements.routeEast');
    assert.ok(start > 0, 'the map rendering should touch the route lines');
    const block = app.slice(app.lastIndexOf('const lifts', start) >= 0 ? app.lastIndexOf('const lifts', start) : 0, app.indexOf('companionSeatMap', start));
    for (const lift of ['east-lift', 'garden-lift']) {
      assert.ok(block.includes(lift), `the map rendering never mentions ${lift}, so it cannot draw that lift as broken`);
    }
    assert.ok(
      !/const eastOut = state\.resources\['east-lift'\]\.status/.test(app),
      'the map still decides from one hardcoded lift',
    );
  });

  test('the venue really can put either lift out, so the drawing has both cases to make', () => {
    // Not a UI assertion: this is the domain fact the drawing has to keep up
    // with. Nothing prevents either lift going out, or both.
    for (const lift of ['east-lift', 'garden-lift']) {
      const venue = store();
      const before = venue.snapshot().resourceVersion;
      venue.setFacilityOutage(lift, 'POWER_FAULT');
      const after = venue.snapshot();
      assert.equal(after.resources[lift].status, 'OUT_OF_SERVICE', `${lift} should be able to go out of service`);
      assert.equal(after.resourceVersion, before + 1, `taking ${lift} out should move the venue revision`);
    }
  });

  test('the garden route line ends on the wheelchair space, not the companion seat', async () => {
    // The east line ends at the centre of W12. The garden line ended at the
    // centre of W13, which app.js hides entirely when no companion seat is
    // requested - so the route was drawn into empty floor.
    const html = await read('public/index.html');
    const seat = html.match(/<rect class="map-seat" x="352"[^>]*width="(\d+)"[^>]*>/);
    assert.ok(seat, 'the W12 wheelchair space should be addressable');
    const w12Centre = 352 + Number(seat[1]) / 2;

    const garden = html.match(/id="route-garden"[^>]*d="([^"]+)"/);
    assert.ok(garden, 'the garden route line should exist');
    const endX = Number(garden[1].trim().split(/\s+/).slice(-2)[0]);
    assert.equal(
      endX,
      w12Centre,
      `the garden route ends at x=${endX}; W12 is centred at ${w12Centre}, and the seat it pointed at is hidden when no companion is booked`,
    );
  });
});

describe('the refusal names the facility that actually failed', () => {
  /**
   * RED was, for the two tests below:
   *   "the incident wording still names a lift literally: East Lift"
   *   "the incident wording still reads the audit log, so retained history
   *    decides what the visitor is told"
   *
   * public/app.js picked the visitor's incident wording with
   * `state.audit.some((entry) => entry.action === 'COMMIT_REJECTED_STALE')`
   * and then said "East Lift L2 failed between review and commit" whenever that
   * came back true. Two things follow, and both were driven against the domain
   * before this was written:
   *
   *  - a Garden Lift outage is told to the visitor as an East Lift one, beside
   *    a map that - since the sibling fix above - correctly draws the cross
   *    over the Garden Lift;
   *  - the audit is retained history, so the FIRST rejection makes every later
   *    stale state repeat that story, including one where nothing broke at all
   *    and only the venue revision moved.
   *
   * The rule the page now applies is quoted here and asserted to still be in
   * the page, so these cannot drift into testing a rule nothing runs.
   */
  const BROKEN_CLAIM_RULE = "claim.consume ? claim.currentStatus !== 'AVAILABLE' : claim.currentStatus !== 'OPERATIONAL'";
  const brokenClaims = (snapshot) => (snapshot.activePlan?.claims ?? []).filter((claim) => (
    claim.consume ? claim.currentStatus !== 'AVAILABLE' : claim.currentStatus !== 'OPERATIONAL'
  ));
  const auditSaysCommitWasRejected = (snapshot) => snapshot.audit
    .some((entry) => entry.action === 'COMMIT_REJECTED_STALE');

  /** Prose is not code: the explanation above the rule names both lifts. */
  const withoutJsComments = (js) => js
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .replaceAll(/(^|[^:\w])\/\/[^\n]*/gm, '$1');
  const incidentWording = (app) => withoutJsComments(app.slice(
    app.indexOf('function renderIncident'),
    app.indexOf('function renderDecision'),
  ));

  /** Confirms a staged plan the venue invalidates underneath it. */
  const confirmIntoAFailure = (venue, plan, requestId) => {
    const confirmation = venue.prepareConfirmation(plan.id);
    assert.throws(
      () => venue.commitBundle({
        planId: plan.id,
        confirmationId: confirmation.confirmationId,
        expectedResourceVersion: confirmation.expectedResourceVersion,
        accepted: true,
        requestId,
      }),
      (error) => error.code === 'STALE_RESOURCE_VERSION',
      'the confirmation should be refused as stale, with nothing booked',
    );
  };

  test('a Garden Lift failure is not reported to the visitor as an East Lift failure', async () => {
    const venue = store();
    // East is out first, so the planner picks the Garden route - the only way
    // this demo ever puts a plan on the second lift.
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    const plan = venue.findBundle(demoDefaults);
    assert.equal(plan.route.liftId, 'garden-lift', 'this scenario needs a plan on the Garden lift');
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    venue.armOutage('garden-lift');
    confirmIntoAFailure(venue, plan, 'uat-garden-mid-confirmation');

    const snapshot = venue.snapshot();
    assert.equal(snapshot.phase, 'PLAN_STALE');
    assert.deepEqual(
      brokenClaims(snapshot).map((claim) => claim.label),
      ['Garden Lift L4'],
      'the plan carries the status of its own resources, so it can say which one broke',
    );
    // The signal the old wording keyed off is equally true here and says
    // nothing whatever about which lift it was.
    assert.equal(auditSaysCommitWasRejected(snapshot), true);

    const wording = incidentWording(await read('public/app.js'));
    assert.ok(
      wording.includes(BROKEN_CLAIM_RULE),
      `the incident wording no longer applies the rule it is tested against: ${BROKEN_CLAIM_RULE}`,
    );
    const named = [...new Set(wording.match(/East Lift|Garden Lift/g) ?? [])];
    assert.deepEqual(
      named,
      [],
      `the incident wording still names a lift literally: ${named.join(', ')} - `
      + 'whichever facility actually failed, the visitor is told about that one',
    );
  });

  test('an older rejection does not become the story of a later, unrelated stale state', async () => {
    const venue = store();
    const first = venue.findBundle(demoDefaults);
    venue.stageBundle(first.id, venue.snapshot().resourceVersion);
    venue.armOutage('east-lift');
    confirmIntoAFailure(venue, first, 'uat-first-rejection');
    assert.deepEqual(
      brokenClaims(venue.snapshot()).map((claim) => claim.label),
      ['East Lift L2'],
      'the first refusal really is about the East lift',
    );

    // Recover onto the Garden route, then move the venue for a reason that has
    // nothing to do with this plan: the East lift comes back into service.
    const replacement = venue.replanBundle(first.id);
    assert.equal(replacement.route.liftId, 'garden-lift');
    venue.restoreFacility('east-lift');

    const snapshot = venue.snapshot();
    assert.equal(snapshot.phase, 'PLAN_STALE', 'restoring a lift moves the revision and dates every open plan');
    assert.equal(snapshot.resources['east-lift'].status, 'OPERATIONAL');
    assert.equal(snapshot.resources['garden-lift'].status, 'OPERATIONAL');
    assert.deepEqual(
      brokenClaims(snapshot).map((claim) => claim.label),
      [],
      'nothing in this plan is broken; only the venue revision moved past it',
    );
    // The scenario is only interesting while the old rejection is still in the
    // retained log, which is exactly what the previous wording read.
    assert.equal(auditSaysCommitWasRejected(snapshot), true);

    const wording = incidentWording(await read('public/app.js'));
    assert.equal(
      wording.includes('COMMIT_REJECTED_STALE'),
      false,
      'the incident wording still reads the audit log, so retained history decides what the visitor is told',
    );
    assert.ok(
      wording.includes('activePlan?.claims'),
      'the incident wording does not read the plan, so it has no way to know what actually broke',
    );
  });
});

describe('the operator can act on every lift the venue has', () => {
  test('every facility the venue operates has a control on the operator page', async () => {
    // RED was: "operator.html offers controls for east-lift only; the venue
    // operates east-lift, garden-lift"
    //
    // Garden Lift L4 was listed on the page with no control of any kind. Both
    // lifts can be taken out through the tool surface or the raw API with no
    // guard, so the page was the only place the second lift was unreachable -
    // and it is the page a judge is given.
    const [operatorHtml, operatorJs] = await Promise.all([
      read('public/operator.html'),
      read('public/operator.js'),
    ]);
    const surface = `${operatorHtml}\n${operatorJs}`;

    const facilities = Object.values(store().snapshot().resources)
      .filter((resource) => resource.kind === 'FACILITY')
      .map((resource) => resource.id);
    assert.deepEqual(facilities.sort(), ['east-lift', 'garden-lift'], 'the venue should operate two lifts');

    const uncontrolled = facilities.filter((id) => !surface.includes(id));
    assert.deepEqual(
      uncontrolled,
      [],
      `the operator page offers no control for: ${uncontrolled.join(', ')}`,
    );
  });

  test('every control that acts on the selected lift says which lift that is', async () => {
    // Found by clicking the deployed page, and introduced by the fix above.
    // Making the ENDPOINTS follow the selector without making the LABELS follow
    // it produced three buttons that act on Garden Lift while two of them read
    // "East Lift" - worse than the original defect, because the original was
    // merely incomplete and this one is untrue. Measured live: with Garden Lift
    // selected, pressing "Take East Lift offline now" took Garden Lift offline.
    //
    // The arm button was already rewritten on every render; the other two were
    // static markup nobody touched.
    const operatorJs = await read('public/operator.js');
    const acting = ['armButton', 'outageNowButton', 'restoreButton'];

    const unlabelled = acting.filter((key) => !operatorJs.includes(`elements.${key}.textContent =`));
    assert.deepEqual(
      unlabelled,
      [],
      `these controls act on the selected lift but never rewrite their label: ${unlabelled.join(', ')}`,
    );

    // And each label must be built from the facility rather than from a second
    // hardcoded name that happens to agree today.
    const hardcoded = [];
    for (const key of acting) {
      const at = operatorJs.indexOf(`elements.${key}.textContent =`);
      const expression = operatorJs.slice(at, operatorJs.indexOf(';', at));
      if (/East Lift|Garden Lift/.test(expression)) hardcoded.push(key);
    }
    assert.deepEqual(
      hardcoded,
      [],
      `these labels name a lift literally instead of the selected one: ${hardcoded.join(', ')}`,
    );
  });

  test('no sentence the operations page shows about the selected lift names a lift literally', async () => {
    // The button labels were fixed; the prose around them was not. Reproduced on
    // the deployed page with Garden Lift L4 selected: the blurb read "Arm an
    // East Lift fault", arming raised "East Lift fault will land...", the
    // outage control raised "East Lift is now out of service", restoring raised
    // "East Lift is back in service", and the audit row was titled "East Lift
    // fault armed" directly above its own detail line naming Garden Lift L4.
    //
    // Every one of those acted on Garden. The three buttons had been made to
    // follow the selector, which is what made the rest worse: a page where the
    // control and the sentence beside it name different lifts is not merely
    // incomplete, it is telling an operator something untrue about a change
    // that has already happened.
    const [operatorHtml, operatorJs] = await Promise.all([
      read('public/operator.html'),
      read('public/operator.js'),
    ]);

    // Every persistent result on this page reports an action on the SELECTED
    // lift, so no result may carry a lift name decided when the line was written.
    const feedbackCalls = operatorJs.split('\n').filter((line) => line.includes('showActionFeedback('));
    assert.ok(feedbackCalls.length >= 4, `expected the page to raise several results, saw ${feedbackCalls.length}`);
    const lyingFeedback = feedbackCalls.filter((line) => /East Lift|Garden Lift/.test(line));
    assert.deepEqual(
      lyingFeedback,
      [],
      `these results name a lift literally instead of the one acted on:\n${lyingFeedback.join('\n')}`,
    );

    // The audit title used to be one static string per action, so every arm read
    // "Facility fault armed" whatever it armed. This test read that map's source
    // and only checked it named no lift - which a generic title trivially
    // satisfies while telling the operator nothing.
    //
    // The title is now resolved from the entry's own refs, so the stronger
    // property is available: it names the lift the entry IS about, and never one
    // it is not. Asserted through the function the page calls, for both lifts,
    // so a literal cannot satisfy it.
    for (const [armed, other] of [['garden-lift', 'East'], ['east-lift', 'Garden']]) {
      const scratch = store();
      scratch.armOutage(armed);
      const snapshot = scratch.snapshot();
      const entry = [...snapshot.audit].reverse().find((row) => row.action === 'OUTAGE_SIGNAL_ARMED');
      assert.ok(entry, 'the arming action wrote no decision-log entry');
      const title = auditTitle(entry, snapshot);
      assert.match(title, new RegExp(snapshot.resources[armed].label), `the title does not name ${armed}`);
      assert.doesNotMatch(title, new RegExp(other), `a ${armed} entry is titled for ${other}`);
    }

    // The demo-control blurb sits above the selector and describes the arm
    // button, so it has to be repainted with it rather than left as markup.
    assert.ok(
      operatorHtml.includes('id="race-intro"'),
      'the demo-control blurb has no id, so nothing can rewrite it when the lift changes',
    );
    assert.match(
      operatorJs,
      /elements\.raceIntro\.textContent\s*=/,
      'the demo-control blurb is never rewritten for the selected lift',
    );

    // Both directly visible radio cards opt out of browser form restoration, so
    // a reload cannot select Garden underneath static East control copy before
    // the first live render paints the labels.
    const radioTags = [...operatorHtml.matchAll(/<input\b[^>]*type="radio"[^>]*name="controlled-facility"[^>]*>/g)]
      .map((match) => match[0]);
    assert.equal(radioTags.length, 2, 'both lifts are not represented by a native radio card');
    assert.ok(radioTags.every((tag) => /autocomplete="off"/.test(tag)), 'a lift radio may be restored across reload');
    assert.equal(radioTags.filter((tag) => /\schecked(?:\s|>)/.test(tag)).length, 1, 'the radio group has no single default');
  });

  test('an armed fault stays visible whichever lift the selector shows', async () => {
    // RED was: "armed while east-lift is pending and garden-lift is selected
    // ... false !== true".
    //
    // Reproduced on the deployed page: arm Garden, move the selector to East,
    // and the armed banner disappears while the arm button offers itself again.
    // Pressing it replaced the pending Garden fault, and switching back showed
    // Garden as unarmed. A pending fault is venue-wide state, so keying the
    // banner to the selection let armed state vanish from the page and then be
    // overwritten with nothing on screen saying so.
    //
    // This runs the real shipped lines rather than matching their text. The
    // opening of render() is pure - it reads the snapshot and the selector and
    // touches no element - so it can be evaluated here with a stub snapshot.
    const operatorJs = await read('public/operator.js');
    const from = operatorJs.indexOf('const facilityId = selectedFacility();');
    const to = operatorJs.indexOf('const raceIntro = raceIntroView(', from);
    assert.ok(from > 0 && to > from, 'render() no longer opens with the pure facility prelude');
    const prelude = operatorJs.slice(from, to);
    assert.ok(!prelude.includes('elements.'), 'the prelude now touches the DOM and cannot be evaluated here');

    // The prelude also calls facilityLabel(), a module-scope helper introduced
    // when the operator copy was made to name the selected lift. It is extracted
    // from the same file rather than stubbed, so this still runs shipped code
    // and a change to how a label is resolved reaches this test.
    const helperStart = operatorJs.indexOf('function facilityLabel(');
    assert.ok(helperStart > 0, 'facilityLabel() is gone; the prelude may no longer be pure');
    const helper = operatorJs.slice(helperStart, operatorJs.indexOf('}', helperStart) + 1);

    const decide = new Function(
      'snapshot',
      'selectedFacility',
      `let pendingOutageConfirmationId = null; ${helper} ${prelude} return { armed, label, selectedOut };`,
    );
    const venue = store().snapshot();
    const facilities = ['east-lift', 'garden-lift'];

    for (const pending of facilities) {
      for (const selected of facilities) {
        const seen = decide({ ...venue, demo: { pendingOutageResourceId: pending } }, () => selected);
        assert.equal(
          seen.armed,
          true,
          `armed while ${pending} is pending and ${selected} is selected`,
        );
      }
    }

    const idle = decide({ ...venue, demo: { pendingOutageResourceId: null } }, () => 'east-lift');
    assert.equal(idle.armed, false, 'a venue with nothing pending must not read as armed');

    // And the control that would overwrite the pending fault has to be closed
    // while one is held, not merely relabelled.
    // Anchored on the call rather than on an assignment: the page routes every
    // disable through disableSafely() now, because setting .disabled directly
    // dropped the operator's keyboard focus to <body> on all four controls.
    const at = operatorJs.indexOf('disableSafely(elements.armButton,');
    assert.ok(at > 0, 'the arm control is no longer disabled through the page helper');
    const disabled = operatorJs.slice(at, operatorJs.indexOf(';', at));
    assert.ok(
      disabled.includes('!raceIntro.canArm'),
      'the arm control bypasses the shared decision that closes pending and completed confirmations',
    );
  });

  test('the operator page can restore whichever lift it took out', async () => {
    const operatorJs = await read('public/operator.js');
    assert.ok(
      /restore/i.test(operatorJs) && /selectedFacility|facilityId/.test(operatorJs),
      'restoring is not parameterised by facility, so only one lift can ever be put back',
    );
  });

  test('taking both lifts out is refused as a bundle, not as a bad requirement', () => {
    // The domain half of the same story, and the reason the operator page must
    // be able to reach this state: with both lifts out, every requirement
    // combination fails, including the most permissive legal one. An agent told
    // to CHANGE_REQUIREMENTS can loop forever.
    const venue = store();
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    venue.setFacilityOutage('garden-lift', 'POWER_FAULT');

    const mostPermissive = {
      wheelchairWidthCm: 45,
      maxDistanceM: 500,
      stepFree: false,
      companionCount: 0,
      entranceAssistance: false,
      lowStimulus: false,
    };
    assert.throws(
      () => venue.findBundle(mostPermissive, { actor: 'test', toolName: 'find_access_bundle' }),
      (error) => error.code === 'NO_COMPLETE_BUNDLE',
      'with both lifts out even the most permissive legal requirements should be refused',
    );

    const evaluation = venue.listAccessOptions(mostPermissive);
    assert.equal(evaluation.feasibleCount, 0, 'no route should be feasible with both lifts out');
    for (const option of evaluation.options) {
      assert.ok(
        (option.blockedBy ?? []).includes('LIFT_OPERATIONAL'),
        `${option.routeId} should name the lift as the blocker, not a requirement the visitor could change`,
      );
    }
  });
});
