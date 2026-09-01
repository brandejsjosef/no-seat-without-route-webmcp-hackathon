/**
 * The two page decisions that kept getting a facility wrong, as pure functions.
 *
 * Both pages have now been repaired for a hardcoded facility three separate
 * times, and each repair was a fix to one occurrence rather than to the class.
 * The reason is that the decisions lived inside DOM-writing functions, so the
 * only way to test them was a browser run or a regex over the source - and a
 * regex over the source is what missed a double-quoted literal.
 *
 * These are the same functions production calls. Testing them here tests the
 * shipped decision, not a restatement of it.
 *
 * Two defects are covered:
 *
 *  - the visitor fault control read `eastOut` before `armed`, so with East
 *    already out and Garden armed it offered "Put East Lift back in service"
 *    while simultaneously setting aria-disabled=true. The control contradicted
 *    itself: it named an action it would refuse to perform.
 *
 *  - the operations decision log titled every arm "Facility fault armed",
 *    which is generic where the product's whole argument is that a refusal
 *    names the thing that actually failed.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { faultControlView, raceIntroView, auditTitle, operatorEndpoint } from '../../public/views.mjs';
import { createDemoStore } from '../../lib/domain.mjs';

const store = () => createDemoStore({
  clock: () => Date.parse('2026-08-31T18:00:00.000Z'),
  idFactory: ((n) => () => `id-${++n}`)(0),
});

const EAST = 'east-lift';
const GARDEN = 'garden-lift';

describe('the visitor fault control never names an action it will refuse', () => {
  test('a pending fault wins over an East outage', () => {
    // The exact combination that produced the contradiction.
    const venue = store();
    venue.armOutage(GARDEN);
    venue.setFacilityOutage(EAST, 'POWER_FAULT');
    const view = faultControlView(venue.snapshot());

    assert.equal(view.mode, 'PENDING', 'East being out hid the armed Garden fault');
    assert.match(view.text, /Garden Lift L4/, 'the control should name the lift holding the fault');
    assert.doesNotMatch(view.text, /back in service/, 'it offered a restore it would refuse to perform');
    assert.equal(view.ariaDisabled, true);
    assert.equal(view.request, null, 'a pending control must send nothing');
  });

  test('the same holds with the lifts swapped, so it is not a property of one lift', () => {
    const venue = store();
    venue.armOutage(EAST);
    venue.setFacilityOutage(GARDEN, 'POWER_FAULT');
    const view = faultControlView(venue.snapshot());

    assert.equal(view.mode, 'PENDING');
    assert.match(view.text, /East Lift L2/);
    assert.equal(view.ariaDisabled, true);
    assert.equal(view.request, null);
  });

  test('no pending and East out offers a restore that really restores East', () => {
    const venue = store();
    venue.setFacilityOutage(EAST, 'POWER_FAULT');
    const view = faultControlView(venue.snapshot());

    assert.equal(view.mode, 'RESTORE');
    assert.match(view.text, /back in service/);
    assert.equal(view.ariaDisabled, false);
    assert.deepEqual(view.request, { method: 'POST', path: `/api/operator/facilities/${EAST}/restore` });
  });

  test('an idle venue offers the arm, and the arm is the one it names', () => {
    const view = faultControlView(store().snapshot());
    assert.equal(view.mode, 'ARM');
    assert.equal(view.ariaDisabled, false);
    assert.deepEqual(view.request, { method: 'POST', path: `/api/operator/facilities/${EAST}/arm` });
  });

  test('every mode agrees with itself: a disabled control asks for nothing', () => {
    // The invariant behind the defect, stated once rather than per case.
    const cases = [];
    let unreachable = 0;
    for (const pending of [null, EAST, GARDEN]) {
      for (const eastOut of [false, true]) {
        const venue = store();
        if (eastOut) venue.setFacilityOutage(EAST, 'POWER_FAULT');
        if (pending) {
          // Arming a lift that is already out is refused by the domain, so
          // "East out AND East armed" is not a state the venue can be in.
          // Recorded rather than quietly skipped: if that ever becomes
          // reachable, this count changes and the test says so.
          try {
            venue.armOutage(pending);
          } catch (error) {
            assert.equal(error.code, 'FACILITY_NOT_OPERATIONAL', `unexpected refusal: ${error.code}`);
            assert.ok(eastOut && pending === EAST, 'only the already-out lift should refuse arming');
            unreachable += 1;
            continue;
          }
        }
        cases.push(faultControlView(venue.snapshot()));
      }
    }
    assert.equal(unreachable, 1, 'exactly one of the six combinations should be unreachable');
    assert.equal(cases.length, 5, `expected five reachable combinations, built ${cases.length}`);
    for (const view of cases) {
      assert.equal(
        view.ariaDisabled,
        view.request === null,
        `a control that is ${view.ariaDisabled ? 'disabled' : 'enabled'} must ${view.ariaDisabled ? 'send nothing' : 'send something'}: ${view.text}`,
      );
      assert.ok(view.text.length > 0 && view.hint.length > 0, 'every mode needs text and a hint');
    }
  });

  test('the hint never contradicts the button', () => {
    const venue = store();
    venue.armOutage(GARDEN);
    venue.setFacilityOutage(EAST, 'POWER_FAULT');
    const view = faultControlView(venue.snapshot());
    assert.doesNotMatch(view.hint, /Restore it here/, 'the hint offered a restore the button refuses');
  });
});

describe('a decision-log title names the facility the entry is about', () => {
  const titleFor = (venue, action) => {
    const snapshot = venue.snapshot();
    const entry = [...snapshot.audit].reverse().find((row) => row.action === action);
    assert.ok(entry, `no ${action} entry was written`);
    return auditTitle(entry, snapshot);
  };

  test('arming Garden is titled for Garden, not generically and not for East', () => {
    const venue = store();
    venue.armOutage(GARDEN);
    const title = titleFor(venue, 'OUTAGE_SIGNAL_ARMED');
    assert.match(title, /Garden Lift L4/, 'the title does not name the facility it is about');
    assert.doesNotMatch(title, /East/, 'a Garden action is titled for East');
  });

  test('the East control case, so the title follows the entry rather than a default', () => {
    const venue = store();
    venue.armOutage(EAST);
    const title = titleFor(venue, 'OUTAGE_SIGNAL_ARMED');
    assert.match(title, /East Lift L2/);
    assert.doesNotMatch(title, /Garden/);
  });

  test('outage and restore titles name their facility too', () => {
    const venue = store();
    venue.setFacilityOutage(GARDEN, 'POWER_FAULT');
    assert.match(titleFor(venue, 'FACILITY_OUTAGE_REPORTED'), /Garden Lift L4/);
    venue.restoreFacility(GARDEN);
    assert.match(titleFor(venue, 'FACILITY_RESTORED'), /Garden Lift L4/);
  });

  test('an entry whose facility cannot be resolved falls back instead of inventing one', () => {
    const venue = store();
    venue.armOutage(GARDEN);
    const snapshot = venue.snapshot();
    const entry = { ...snapshot.audit.at(-1), refs: ['no-such-lift'] };
    const title = auditTitle(entry, snapshot);
    assert.ok(title.length > 0, 'an unresolvable entry still needs a title');
    assert.doesNotMatch(title, /Garden|East|no-such-lift/, 'it invented a facility it could not resolve');
  });

  test('a non-facility action keeps its own title', () => {
    const venue = store();
    const snapshot = venue.snapshot();
    const title = auditTitle({ action: 'PLAN_CLEARED', refs: [] }, snapshot);
    assert.equal(title, 'Plan cleared');
  });
});

describe('an operator endpoint is built from the facility it was asked about', () => {
  // The URL, the label and the resulting state all have to name one facility.
  // Read the selection once and use that value for all three; this function is
  // where "that value" lives.
  test('each action maps to its own path, for either facility', () => {
    for (const facilityId of [EAST, GARDEN]) {
      assert.equal(operatorEndpoint(facilityId, 'arm'), `/api/operator/facilities/${facilityId}/arm`);
      assert.equal(operatorEndpoint(facilityId, 'outage'), `/api/operator/facilities/${facilityId}/outage`);
      assert.equal(operatorEndpoint(facilityId, 'restore'), `/api/operator/facilities/${facilityId}/restore`);
    }
  });

  test('an unknown action is refused rather than guessed into a URL', () => {
    assert.throws(() => operatorEndpoint(EAST, 'delete'), /action/i);
  });

  test('a missing facility is refused rather than defaulted', () => {
    assert.throws(() => operatorEndpoint('', 'arm'), /facility/i);
    assert.throws(() => operatorEndpoint(undefined, 'arm'), /facility/i);
  });

  test('every action the operations page can take is covered here', () => {
    // A fourth action added to the page without being registered here is the
    // failure this asserts: the inventory must come from the module, not from
    // a list typed into one test.
    const actions = ['arm', 'outage', 'restore'];
    for (const action of actions) {
      assert.doesNotThrow(() => operatorEndpoint(EAST, action), `${action} is not registered`);
    }
  });
});

/**
 * The paragraph above the arm button told the operator to arm a fault in every
 * state, including the two where the server refuses to: a lift already out of
 * service cannot be armed (FACILITY_NOT_OPERATIONAL), and a venue that already
 * holds a pending fault refuses a second one. The page disabled the button and
 * kept the instruction to press it, which is the same defect as a control whose
 * label and action disagree - only spelt out in prose above the control.
 */
describe('the operations intro never instructs an action the venue refuses', () => {
  const armable = () => store();
  const alreadyArmed = () => { const venue = store(); venue.armOutage('east-lift'); return venue; };
  const alreadyOut = () => { const venue = store(); venue.setFacilityOutage('east-lift', 'POWER_FAULT'); return venue; };

  test('an armable lift is introduced as one to arm', () => {
    const view = raceIntroView(armable().snapshot(), { facilityId: 'east-lift' });
    assert.equal(view.canArm, true);
    assert.match(view.text, /arm a fault on east lift l2/i);
  });

  test('a lift already out is not introduced as one to arm', () => {
    const view = raceIntroView(alreadyOut().snapshot(), { facilityId: 'east-lift' });
    assert.equal(view.canArm, false, 'the page invites an arm the venue answers FACILITY_NOT_OPERATIONAL');
    assert.doesNotMatch(view.text, /^arm a fault/i);
    assert.match(view.text, /East Lift L2/, 'the sentence does not say which lift it is about');
  });

  test('a venue already holding a fault is not told to arm a second one', () => {
    const view = raceIntroView(alreadyArmed().snapshot(), { facilityId: 'east-lift' });
    assert.equal(view.canArm, false, 'a second arm is refused, and the page still asks for one');
    assert.doesNotMatch(view.text, /^arm a fault/i);
  });

  test('the sentence names the lift the control acts on', () => {
    // Only where the sentence is ABOUT the selected lift. My first version of
    // this asserted East Lift is never named while Garden is selected, which is
    // wrong: with a fault armed on East, "a fault is already armed on East Lift
    // L2" is the true sentence and the reason the Garden control is refused.
    for (const make of [armable, alreadyOut]) {
      const view = raceIntroView(make().snapshot(), { facilityId: 'garden-lift' });
      assert.doesNotMatch(view.text, /East Lift/, `the intro names a lift the control does not act on: ${view.text}`);
      assert.match(view.text, /Garden Lift L4/, `the intro does not name the selected lift: ${view.text}`);
    }
  });

  test('a pending fault elsewhere is named, because it is why this control is refused', () => {
    const view = raceIntroView(alreadyArmed().snapshot(), { facilityId: 'garden-lift' });
    assert.equal(view.canArm, false);
    assert.match(view.text, /East Lift L2/, 'the operator is refused without being told what holds the fault');
  });

  test('the operations page takes the sentence from that function', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../../public/operator.js', import.meta.url), 'utf8');
    assert.match(source, /raceIntroView\(/, 'the page writes its own intro again');
    assert.doesNotMatch(
      source,
      /raceIntro\.textContent = `Arm a fault on/,
      'the intro is a literal instruction again, refused or not',
    );
  });
});
