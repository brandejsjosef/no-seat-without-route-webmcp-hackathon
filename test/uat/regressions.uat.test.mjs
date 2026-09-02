/**
 * One test per defect found by using the deployed application.
 *
 * Every one of these shipped green. The suite was thorough about the domain and
 * the protocol and silent about the person using the product, so a stale event
 * date, a plan nobody could back out of, a refusal that erased itself after four
 * seconds and a receipt row that could never say anything else all passed.
 *
 * These were written after the fixes, which is not TDD and is worth saying
 * plainly rather than dressing up. The clean release repository does not retain
 * the discarded pre-release snapshots as reproducible Git history. What can be
 * checked here is the repaired behaviour each test now locks.
 *
 * They are deliberately static. A DOM-level assertion that reads the shipped
 * files catches a regression on any machine in milliseconds, without a browser,
 * which is what the browser suite could not offer for the price.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPlanButtonView } from '../../public/views.mjs';

const read = (name) => readFile(new URL(`../../${name}`, import.meta.url), 'utf8');

describe('the event date cannot silently age', () => {
  test('the hero ticket names no calendar day', async () => {
    // "Thursday 27 August" was correct when it was written and three days stale
    // when the deployed page was opened. Nothing read the string - no test, no eval, no
    // scenario - so it could only ever be caught by a person looking at it.
    const html = await read('public/index.html');
    const start = html.indexOf('class="event-ticket"');
    assert.ok(start > 0, 'the event ticket should exist');
    const ticket = html.slice(start, html.indexOf('</article>', start));

    const MONTHS = 'January|February|March|April|May|June|July|August'
      + '|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
    const dated = [...ticket.matchAll(new RegExp(`\\b\\d{1,2}\\s*(?:${MONTHS})\\b|\\b(?:${MONTHS})\\s*\\d{1,2}\\b`, 'gi'))];
    assert.deepEqual(
      dated.map((match) => match[0]),
      [],
      'the ticket names a calendar day, which will be wrong on some day it is read',
    );
  });

  test('the ticket badge and the ticket line agree', async () => {
    // The badge is a separate pair of literals from the line above it. Moving one
    // and not the other produces a ticket that contradicts itself, which is worse
    // than the stale date it replaced.
    const html = await read('public/index.html');
    const badge = html.slice(html.indexOf('class="ticket-date"'), html.indexOf('</article>', html.indexOf('class="ticket-date"')));
    assert.ok(/7:30/.test(badge), 'the badge should carry the same time the ticket line does');
    assert.ok(!/AUG|SEP|\b27\b/i.test(badge), 'the badge still carries the old calendar date');
  });

  test('the page and the server describe the event the same way', async () => {
    const [html, domain] = await Promise.all([read('public/index.html'), read('lib/domain.mjs')]);
    const served = domain.match(/date:\s*'([^']+)'/);
    assert.ok(served, 'the domain should ship an event date');
    assert.ok(
      html.includes(served[1]),
      `the server serves "${served[1]}" and the page shows something else`,
    );
  });
});

describe('a visitor can always get back to their requirements', () => {
  test('a human control clears the plan, not only a tool', async () => {
    // clear_access_plan was registered for an agent in four phases and wired to
    // no human control at all. On a page whose whole claim is that the person
    // stays in charge, the agent could back out and the person could not.
    const [html, app] = await Promise.all([read('public/index.html'), read('public/app.js')]);
    assert.ok(html.includes('id="start-over-button"'), 'no control exists for a visitor to discard a plan');
    assert.ok(
      /elements\.startOverButton\.addEventListener\('click',\s*clearPlanForEditing\)/.test(app),
      'the control exists but is not wired to the clear endpoint',
    );
  });

  test('that control is shown whenever there is a plan to discard', async () => {
    const app = await read('public/app.js');
    assert.ok(
      /const clearable = Boolean\(state\.activePlan\) && !state\.booking;/.test(app)
      && /elements\.startOverButton\.hidden = !clearable;/.test(app),
      'the control is not driven by whether a clearable plan exists',
    );
  });

  test('the escape does not depend on the incident card, which most phases hide', async () => {
    // The pre-existing way out was the incident card's button, and renderIncident
    // shows that card only in PLAN_STALE and NO_ALTERNATIVE. In PLAN_READY and
    // AWAITING_HUMAN_CONFIRMATION - the two phases a visitor actually reaches by
    // pressing Build - it is not on the page at all.
    const [html, app] = await Promise.all([read('public/index.html'), read('public/app.js')]);
    const incidentStart = html.indexOf('id="incident"');
    const incident = html.slice(incidentStart, html.indexOf('</section>', incidentStart));
    assert.ok(!incident.includes('id="start-over-button"'), 'the escape is inside the card that most phases hide');
    assert.ok(
      /\['PLAN_STALE', 'NO_ALTERNATIVE'\]\.includes\(state\.phase\)/.test(app),
      'renderIncident no longer restricts the incident card; re-check where the escape lives',
    );
  });
});

describe('a disabled control says something true', () => {
  test('no phase label claims a plan is in progress after a booking', async () => {
    const app = await read('public/app.js');
    assert.match(app, /buildPlanButtonView\(state\.phase/, 'the page bypasses the tested phase decision');
    const confirmed = buildPlanButtonView('CONFIRMED').label;
    assert.match(confirmed, /Booked/);
    assert.doesNotMatch(confirmed, /progress/i);
    assert.ok(
      !/Plan already in progress/.test(app),
      'the label that was shown after a confirmed booking is still present',
    );
  });

  test('a label that names a way out names a control the page really offers', async () => {
    // Caught by clicking through the deployed page rather than reading the
    // source. The CONFIRMED label was written as "start over below to plan
    // again", and #start-over-button is hidden in CONFIRMED - clearable is
    // activePlan && !booking - so the only thing below is Reset demo, which is
    // a different action with a different consequence: it destroys the decision
    // log and the receipt the demo exists to show.
    //
    // Directing someone to a control that is not there, under a different name
    // than the one it carries, is the same defect as every other one repaired
    // today, committed while repairing them.
    // The first version of this test checked only that a control with matching
    // words EXISTS in the markup, and passed - #start-over-button does exist,
    // it is simply hidden in CONFIRMED. Existence is not availability, and the
    // weaker check would have shipped the wrong label. Availability is what a
    // reader of the label needs, so that is what is asserted.
    const app = await read('public/app.js');
    assert.match(app, /buildPlanButtonView\(state\.phase/, 'the page bypasses the tested phase decision');
    const confirmedLabel = buildPlanButtonView('CONFIRMED').label;

    // In CONFIRMED the venue holds a booking, so `clearable` is false and the
    // Start over control is hidden. Reset demo is the only way onward, and it
    // is a different action: it destroys the decision log and the receipt.
    assert.ok(
      /const clearable = Boolean\(state\.activePlan\) && !state\.booking;/.test(app),
      'Start over is no longer gated on the absence of a booking; re-check what CONFIRMED can offer',
    );
    assert.ok(
      !/start over/i.test(confirmedLabel),
      `the confirmed label says "${confirmedLabel}", but Start over is hidden once a booking exists`,
    );
    assert.ok(
      /reset/i.test(confirmedLabel),
      `the confirmed label should name Reset demo, the only control still available; it says "${confirmedLabel}"`,
    );
  });

  test('no label sends a visitor without an agent to wait for one', async () => {
    // A manual visitor in PLAN_READY was told "waiting for agent to prepare it".
    // There may be no agent. There was no other control on the page.
    const labels = [
      'PLAN_READY',
      'AWAITING_HUMAN_CONFIRMATION',
      'PLAN_STALE',
      'REPLAN_READY',
      'NO_ALTERNATIVE',
      'CONFIRMED',
    ].map((phase) => buildPlanButtonView(phase).label);
    assert.deepEqual(labels.filter((label) => /agent/i.test(label)), [], 'a disabled control still waits for an agent');
  });
});

describe('a refusal the visitor cannot act on stays on the page', () => {
  test('an impossible bundle leaves a standing notice, not only a toast', async () => {
    // showToast clears itself after 4200ms. Wheelchair width 95 is inside the
    // form's own max and no route is 95cm wide, so the largest value the page
    // offers can never succeed - and four seconds later the page looked new,
    // with an empty decision log and a re-enabled build button.
    const app = await read('public/app.js');
    assert.ok(/function showStandingRefusal\(/.test(app), 'there is no standing refusal notice');
    const branch = app.indexOf("error.code === 'NO_COMPLETE_BUNDLE'");
    assert.notEqual(branch, -1, 'nothing handles the impossible-bundle refusal');
    assert.ok(
      app.slice(branch, branch + 600).includes('showStandingRefusal('),
      'the impossible-bundle refusal does not raise a standing notice',
    );
  });

  test('the standing notice is cleared when a plan finally succeeds', async () => {
    const app = await read('public/app.js');
    assert.ok(/function clearStandingRefusal\(/.test(app), 'the notice can never be cleared');
    const success = app.slice(app.indexOf('async function buildPlanManually'), app.indexOf('} catch (error) {', app.indexOf('async function buildPlanManually')));
    assert.ok(success.includes('clearStandingRefusal()'), 'a successful build leaves the old refusal on screen');
  });

  test('the notice points at the other cause a visitor cannot see', async () => {
    // Requirements are one way to reach NO_COMPLETE_BUNDLE. An out-of-service
    // lift is the other, and nothing on the visitor page said so.
    //
    // This used to read the literal out of the call site. The sentence is a
    // decision now, taken from the diagnosis the venue shipped, so the guard
    // asks the decision instead of the source: the old shape passed while the
    // sentence contradicted the very refusal it was printing.
    const { standingRefusalView } = await import('../../public/views.mjs');
    const { createDemoStore } = await import('../../lib/domain.mjs');
    const venue = createDemoStore({ clock: () => 0, idFactory: ((n) => () => `id-${++n}`)(0) });
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    venue.setFacilityOutage('garden-lift', 'POWER_FAULT');
    let refusal = null;
    try {
      venue.findBundle({
        wheelchairWidthCm: 72,
        maxDistanceM: 80,
        stepFree: true,
        companionCount: 1,
        entranceAssistance: true,
        lowStimulus: true,
      });
    } catch (error) { refusal = error; }
    assert.ok(refusal, 'the venue no longer refuses with every lift out');

    const notice = standingRefusalView(refusal.message, refusal.details).text;
    assert.match(notice, /operations page/i, 'the notice does not name the other cause');
    assert.doesNotMatch(notice, /change a requirement/i, 'the notice blames requirements the venue said cannot help');
  });
});

describe('the page does not describe itself incorrectly', () => {
  test('booking state is not called session-scoped', async () => {
    // State is keyed by demoId, which is why two browsers on one link share a
    // venue - and the page says exactly that thirty lines earlier.
    const [html, server] = await Promise.all([read('public/index.html'), read('server.mjs')]);
    assert.ok(!/session-scoped booking state/.test(html), 'the agent callout still calls the venue state session-scoped');
    assert.ok(/demoId/.test(server), 'state is no longer keyed by demoId; re-check what the callout should say');
  });

  test('an invalid-input message does not speak schema keys to a person', async () => {
    // showToast is also read out to screen readers, so "wheelchairWidthCm" was
    // spoken aloud.
    const app = await read('public/app.js');
    const start = app.indexOf('Your agent supplied');
    assert.ok(start > 0, 'the declarative invalid-input message should exist');
    const line = app.slice(app.lastIndexOf('\n', start), app.indexOf('\n', start));
    assert.ok(!/wheelchairWidthCm|maxDistanceM|companionCount/.test(line), 'the message interpolates raw schema keys');
    assert.ok(/FIELD_WORDS/.test(app), 'there is no mapping from schema keys to words a person uses');
  });

  test('the receipt states nothing that is structurally always true', async () => {
    // "Requirements met / All requested" cannot say anything else: commitBundle
    // only succeeds when the bundle is feasible.
    const app = await read('public/app.js');
    assert.ok(
      !/<dt>Requirements met<\/dt>/.test(app),
      'the receipt carries a row whose value the commit path makes constant',
    );
  });

  test('every partial-reservation count the documents state is zero', async () => {
    // Found by running the sabotage proofs by hand rather than delegating them.
    // Changing "0 partial reservations" to "7" in the walkthrough TABLE is
    // caught by the row contract; changing it in the walkthrough PROSE, four
    // lines of instructions above that table, was not caught by anything. Both
    // are read by a judge, and the prose is read first.
    //
    // Zero is not a preference here. commitBundle swaps one draft or none, so
    // any other number in either document is false about the product.
    const documents = ['README.md', 'QA_TEST_MATRIX.md'];
    const wrong = [];
    for (const name of documents) {
      const text = await read(name);
      text.split('\n').forEach((line, index) => {
        for (const match of line.matchAll(/(\d+)\s+partial reservations?/gi)) {
          if (match[1] !== '0') wrong.push(`${name}:${index + 1} claims "${match[0]}"`);
        }
      });
    }
    assert.deepEqual(
      wrong,
      [],
      `a document states a non-zero partial-reservation count: ${wrong.join('; ')}`,
    );
  });

  test('every venue revision the walkthrough prose states matches the table', async () => {
    // Same gap, same fix: the prose names revisions too, and only the table was
    // under contract.
    const readme = await read('README.md');
    const start = readme.indexOf('## Try it in 90 seconds');
    assert.ok(start > 0, 'the walkthrough section should exist');
    const prose = readme.slice(start, readme.indexOf('\n## ', start + 10));

    const table = readme.slice(readme.indexOf('| Step | Result |'));
    const tableRevisions = new Set([...table.matchAll(/revision (\d+)/gi)].map((match) => match[1]));
    assert.ok(tableRevisions.size > 0, 'the walkthrough table should state revisions');

    const stray = [...prose.matchAll(/revision (\d+)/gi)]
      .map((match) => match[1])
      .filter((revision) => !tableRevisions.has(revision));
    assert.deepEqual(
      stray,
      [],
      `the walkthrough prose names revision(s) the table never records: ${stray.join(', ')}`,
    );
  });
});
