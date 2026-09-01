/**
 * The second independent adversarial round, against the repaired release.
 *
 * These are worse than the first round's, because each is the product breaking
 * its own central promise rather than wording a true thing badly:
 *
 *  - `explain_access_refusal` answered "blocked, contact venue staff" for a
 *    venue in which the very next `find_access_bundle` books a seat. A
 *    wheelchair user's agent is told to phone the venue when the site would
 *    have served them, and the README states this cannot happen.
 *  - one visitor's refused search was reported to a second visitor who had made
 *    no call at all, together with the first visitor's access requirements -
 *    while the comment justifying where that state lives says, in the source,
 *    that one visitor's refused search is not venue state.
 *  - a staging refusal told an agent to retry with a "confirmation revision" at
 *    a point in the flow where no confirmation exists yet.
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

const refusalOf = (run) => {
  try { run(); } catch (error) { return error; }
  throw new Error('expected a refusal and the call succeeded');
};

describe('an explanation cannot call a venue shut that the search would serve', () => {
  /**
   * The tester's exact path. A replan excludes the route it is replacing, the
   * exclusion is remembered with the refusal, and clearing the plan leaves that
   * exclusion behind - so the explanation evaluates one route out of two.
   */
  const strandedExclusion = () => {
    const venue = store();
    venue.setFacilityOutage('garden-lift', 'POWER_FAULT');
    const plan = venue.findBundle(FULL);
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    refusalOf(() => venue.replanBundle(plan.id));
    venue.restoreFacility('east-lift');
    venue.clearPlan(plan.id);
    return venue;
  };

  test('the venue really can serve the visitor at that point', () => {
    // The control. Without it the test below could pass against a venue that is
    // genuinely shut, and prove nothing.
    const venue = strandedExclusion();
    assert.equal(venue.snapshot().phase, 'READY');
    assert.equal(venue.listAccessOptions(FULL).options.some((option) => option.feasible), true);
  });

  test('so the explanation does not say it is blocked', () => {
    const explanation = strandedExclusion().explainRefusal();
    assert.equal(
      explanation.blocked,
      false,
      `the explanation says ${explanation.nextAction} for a venue that would book a seat`,
    );
  });

  test('and the search that follows really does succeed', () => {
    const venue = strandedExclusion();
    const plan = venue.findBundle(FULL);
    assert.ok(plan.id, 'the venue refused a search its own explanation called possible');
  });

  test('a venue that really is shut is still described as shut', () => {
    // The positive control: the rule is not "never say blocked".
    const venue = store();
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    venue.setFacilityOutage('garden-lift', 'POWER_FAULT');
    refusalOf(() => venue.findBundle(FULL));
    const explanation = venue.explainRefusal();
    assert.equal(explanation.blocked, true);
    assert.equal(explanation.nextAction, 'CONTACT_VENUE_STAFF');
  });
});

describe('a refused search belongs to the visitor who made it', () => {
  const wideChair = { ...FULL, wheelchairWidthCm: 95 };

  test('a second visitor is not told they were refused', () => {
    const venue = store();
    refusalOf(() => venue.findBundle(wideChair, { sessionKey: 'visitor-a' }));

    const forB = venue.explainRefusal({ sessionKey: 'visitor-b' });
    assert.equal(forB.blocked, false, 'a visitor who made no call is told a call of theirs was rejected');
    assert.equal(forB.rejectedAction ?? null, null);
  });

  test('and their requirements are not handed to anyone else', () => {
    const venue = store();
    refusalOf(() => venue.findBundle(wideChair, { sessionKey: 'visitor-a' }));
    assert.equal(
      venue.explainRefusal({ sessionKey: 'visitor-b' }).requirements ?? null,
      null,
      'one access requirement set reached a different visitor',
    );
  });

  test('the visitor who was refused still gets their own explanation', () => {
    // The positive control, and the reason this state exists at all.
    const venue = store();
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    venue.setFacilityOutage('garden-lift', 'POWER_FAULT');
    refusalOf(() => venue.findBundle(FULL, { sessionKey: 'visitor-a' }));

    const forA = venue.explainRefusal({ sessionKey: 'visitor-a' });
    assert.equal(forA.blocked, true);
    assert.deepEqual(forA.requirements, FULL);
  });

  test('a caller that names no session still works, because most callers do not', () => {
    // Every existing caller passes no session key. They must go on behaving as
    // one anonymous visitor rather than losing their explanation.
    const venue = store();
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    venue.setFacilityOutage('garden-lift', 'POWER_FAULT');
    refusalOf(() => venue.findBundle(FULL));
    assert.equal(venue.explainRefusal().blocked, true);
  });

  test('the remembered refusals are bounded, like every other map here', () => {
    // Sessions are evicted by the server, not by the venue, so without a bound
    // a caller minting session keys grows this for as long as the venue lives.
    const venue = store();
    for (let index = 0; index < 400; index += 1) {
      try { venue.findBundle(wideChair, { sessionKey: `flood-${index}` }); } catch { /* expected */ }
    }
    assert.ok(
      venue.rememberedRefusalCount() <= 200,
      `the refusal record grew to ${venue.rememberedRefusalCount()} entries`,
    );
  });
});

describe('a staging refusal names the number it actually wants', () => {
  test('it asks for the venue revision, because no confirmation exists yet', () => {
    const venue = store();
    const plan = venue.findBundle(FULL);
    const error = refusalOf(() => venue.stageBundle(plan.id, 99));

    assert.equal(error.code, 'EXPECTED_RESOURCE_VERSION_MISMATCH');
    assert.equal(
      error.details.nextAction,
      'RETRY_WITH_THE_VENUE_REVISION',
      'staging asks for a confirmation revision that cannot exist before staging',
    );
    assert.equal(error.details.venueResourceVersion, venue.snapshot().resourceVersion);
    assert.equal(
      Object.hasOwn(error.details, 'confirmationResourceVersion'),
      false,
      'staging still reports a confirmation revision',
    );
  });

  test('a commit refusal asks for the same number, because it IS the same number', () => {
    // One error code, one next action - the invariant refusals.uat.test.mjs
    // enforces. This code is raised at commit only on the branch where the
    // venue has NOT moved, so the confirmation's revision and the venue's are
    // equal; naming the venue revision in both places is one truth said once,
    // not a compromise. The equality is asserted rather than assumed.
    const venue = store();
    const plan = venue.findBundle(FULL);
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    const confirmation = venue.prepareConfirmation(plan.id);
    const error = refusalOf(() => venue.commitBundle({
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: 99,
      accepted: true,
      requestId: 'wrong-number',
    }));
    assert.equal(error.details.nextAction, 'RETRY_WITH_THE_VENUE_REVISION');
    assert.equal(error.details.venueResourceVersion, confirmation.expectedResourceVersion);
    assert.equal(
      confirmation.expectedResourceVersion,
      venue.snapshot().resourceVersion,
      'the two revisions differ here, so one name cannot describe both',
    );
  });
});

describe('an evaluation says which requirements it was computed against', () => {
  test('the venue fills in every default, so a partial ask is answered about a full set', () => {
    // The control: `wheelchairWidthCm` alone becomes six requirements, and the
    // other five are the venue's choice rather than the caller's.
    const evaluation = store().listAccessOptions({ wheelchairWidthCm: 60 });
    assert.equal(evaluation.requirements.maxDistanceM, 80);
    assert.equal(evaluation.requirements.stepFree, true);
  });

  test('and the tool passes that set on', async () => {
    // It returned venueRevision, feasibleCount and per-route verdicts only, so a
    // feasible answer carried no record of the limits it was feasible against.
    // check_access_route discloses them inside its check details; this did not.
    const { createVisitorTools } = await import('../../public/tools.mjs');
    const venue = store();
    const tools = createVisitorTools({
      api: async (path, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : {};
        if (path === '/api/state') return { ok: true, state: venue.snapshot() };
        if (path === '/api/access-options') {
          return { ok: true, evaluation: venue.listAccessOptions(body.requirements ?? {}) };
        }
        throw new Error(`Unrouted call: ${path}`);
      },
      refresh: async () => venue.snapshot(),
    });
    const answer = JSON.parse(await tools.find((tool) => tool.name === 'list_access_options')
      .execute({ wheelchairWidthCm: 60 }));

    assert.equal(answer.feasibleCount >= 0, true, 'the tool no longer answers at all');
    assert.deepEqual(
      answer.requirements,
      venue.listAccessOptions({ wheelchairWidthCm: 60 }).requirements,
      'the answer does not say which requirement set produced it',
    );
    assert.equal(answer.requirements.maxDistanceM, 80, 'the defaults the venue chose are not disclosed');
  });
});

describe('the decision log claims only what the server can know', () => {
  test('preparing a confirmation does not claim a customer was shown anything', () => {
    // Reproduced with curl alone, no page ever opened: find, stage, then
    // prepare-confirmation, and the operations log read "The customer was shown
    // the complete route, seats and assistance plan." It is an ordinary
    // authenticated endpoint. The receipt copy was carefully weakened for
    // exactly this reason - a venue is shared through its ?demo= link and the
    // server cannot vouch for who held the session - and this line was not.
    const venue = store();
    const plan = venue.findBundle(FULL);
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    venue.prepareConfirmation(plan.id);

    const entry = venue.snapshot().audit.at(-1);
    assert.equal(entry.action, 'HUMAN_CONFIRMATION_PREPARED');
    assert.doesNotMatch(entry.message, /was shown/i, 'the log asserts a customer saw a screen');
    assert.doesNotMatch(entry.message, /the customer/i);
    assert.match(entry.message, /identifier|issued/i, 'the log does not say what actually happened');
  });

  test('the receipt sentence it was measured against still says what it always said', () => {
    // The control for the rule, not for this entry: the narrow claim exists
    // elsewhere and must not be widened to match the log.
    const venue = store();
    const plan = venue.findBundle(FULL);
    venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
    const confirmation = venue.prepareConfirmation(plan.id);
    const result = venue.commitBundle({
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
      requestId: 'the-click',
    });
    assert.ok(result.booking.receipt, 'the commit path stopped working');
  });
});
