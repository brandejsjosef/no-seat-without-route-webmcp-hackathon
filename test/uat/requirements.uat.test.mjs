/**
 * Acceptance suite: the requirements a visitor states.
 *
 * A value of 95 was entered into the wheelchair-width box - a value the form itself
 * offers - and the venue answered that no complete bundle exists. Nothing in
 * the suite looked at that number, because every existing test used the
 * defaults. These tests walk every requirement field to its boundary and one
 * step past it, and pin what the DOMAIN actually does there.
 *
 * Pure domain and pure tool-surface work: no server, no port, no sleep, no
 * wall clock, no randomness. Every store is built with a fixed clock and a
 * counting id factory, so nothing here can vary between two runs.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createDemoStore, DomainError, demoDefaults } from '../../lib/domain.mjs';
import { createVisitorTools, TOOL_LIMITS } from '../../public/tools.mjs';
import { checkToolContract } from '../../evals/contract.mjs';

const FIXED_CLOCK = () => Date.parse('2026-08-30T18:00:00.000Z');

function freshStore() {
  let issued = 0;
  return createDemoStore({ clock: FIXED_CLOCK, idFactory: () => `id-${++issued}` });
}

/** A complete requirement set. findBundle refuses anything less. */
function requirements(overrides = {}) {
  return { ...demoDefaults, ...overrides };
}

/**
 * Everything except the field under test relaxed as far as the domain allows,
 * so a refusal can only be blamed on the field under test.
 */
const MOST_PERMISSIVE = Object.freeze({
  maxDistanceM: 500,
  stepFree: false,
  companionCount: 0,
  entranceAssistance: false,
  lowStimulus: false,
});

/** Plans on a store nobody else has touched, so ACTIVE_PLAN_EXISTS can't fire. */
function planWith(overrides = {}) {
  return freshStore().findBundle(requirements(overrides));
}

/**
 * Asserts a call refuses, and hands the refusal back for inspection.
 * An AssertionError is rethrown rather than inspected, so a test that should
 * have failed can never be swallowed and reported as a refusal.
 */
function refusalOf(act) {
  let result;
  try {
    result = act();
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.ok(error instanceof DomainError, `expected a DomainError, got ${error}`);
    return error;
  }
  assert.fail(`expected a refusal, but the venue answered ${JSON.stringify(result?.routeId ?? result)}`);
}

/** Asserts the domain refuses a complete requirement set with one field changed. */
function refusalFrom(overrides = {}) {
  return refusalOf(() => planWith(overrides));
}

const EAST = 'east-lift-route';
const GARDEN = 'garden-lift-route';

/** The rules a route is judged by, in the order the domain emits them. */
function expectedRules(stated) {
  const rules = ['STEP_FREE', 'LOW_STIMULUS', 'ROUTE_DISTANCE', 'DOORWAY_WIDTH', 'LIFT_OPERATIONAL', 'WHEELCHAIR_SPACE'];
  if (stated.companionCount === 1) rules.push('COMPANION_SEAT');
  if (stated.entranceAssistance) rules.push('ENTRANCE_ASSISTANCE');
  return rules;
}

/** The resources a plan on `routeId` must hold, and nothing besides. */
function expectedClaims(routeId, stated) {
  const lift = routeId === EAST ? 'east-lift' : 'garden-lift';
  const host = routeId === EAST ? 'assist-east-1905' : 'assist-garden-1903';
  const ids = [lift, 'space-w12'];
  if (stated.companionCount === 1) ids.push('seat-w13');
  if (stated.entranceAssistance) ids.push(host);
  return ids;
}

function claimIds(plan) {
  return plan.claims.map((claim) => claim.resourceId);
}

const BOOLEAN_COMBINATIONS = Object.freeze(
  Array.from({ length: 8 }, (unused, mask) => Object.freeze({
    stepFree: Boolean(mask & 1),
    entranceAssistance: Boolean(mask & 2),
    lowStimulus: Boolean(mask & 4),
  })),
);

// ---------------------------------------------------------------------------

describe('the venue geometry every boundary below is measured against', () => {
  test('the two routes publish the widths, distances and durations the boundaries are drawn from', () => {
    const routes = freshStore().snapshot().routes;
    assert.equal(routes.length, 2, 'this suite is written for exactly two routes');

    const east = routes.find((route) => route.id === EAST);
    const garden = routes.find((route) => route.id === GARDEN);

    assert.deepEqual(
      { minWidthCm: east.minWidthCm, distanceM: east.distanceM, durationMinutes: east.durationMinutes },
      { minWidthCm: 94, distanceM: 64, durationMinutes: 6 },
    );
    assert.deepEqual(
      { minWidthCm: garden.minWidthCm, distanceM: garden.distanceM, durationMinutes: garden.durationMinutes },
      { minWidthCm: 86, distanceM: 78, durationMinutes: 8 },
    );
  });
});

describe('wheelchair width, at every boundary and one step past it', () => {
  test('44 cm is narrower than the venue will accept and is refused before any route is looked at', () => {
    const error = refusalFrom({ wheelchairWidthCm: 44 });
    assert.equal(error.code, 'INVALID_WHEELCHAIR_WIDTH');
    assert.equal(error.status, 422);
  });

  test('45 cm, the narrowest width the form offers, plans the East Entrance route', () => {
    assert.equal(planWith({ wheelchairWidthCm: 45 }).routeId, EAST);
  });

  test('46 cm, one step inside the low boundary, still plans the East Entrance route', () => {
    assert.equal(planWith({ wheelchairWidthCm: 46 }).routeId, EAST);
  });

  test('85 cm leaves both entrances open and the planner takes the shorter East route', () => {
    const store = freshStore();
    const comparison = store.listAccessOptions(requirements({ wheelchairWidthCm: 85 }));
    assert.equal(comparison.feasibleCount, 2);
    // Both routes work, so this pins the tie-break: the planner sorts on
    // duration and East is the 6-minute one.
    assert.equal(planWith({ wheelchairWidthCm: 85 }).routeId, EAST);
    assert.equal(planWith({ wheelchairWidthCm: 85 }).route.durationMinutes, 6);
  });

  test('86 cm is the widest mobility aid the Garden Entrance route can take', () => {
    const store = freshStore();
    const fits = store.checkAccessRoute(GARDEN, requirements({ wheelchairWidthCm: 86 }));
    const tooWide = store.checkAccessRoute(GARDEN, requirements({ wheelchairWidthCm: 87 }));
    assert.equal(fits.feasible, true);
    assert.deepEqual(fits.blockedBy, []);
    assert.equal(tooWide.feasible, false);
    assert.deepEqual(tooWide.blockedBy, ['DOORWAY_WIDTH']);
  });

  test('87 cm closes the Garden Entrance route and leaves the East route as the only answer', () => {
    const store = freshStore();
    const comparison = store.listAccessOptions(requirements({ wheelchairWidthCm: 87 }));
    assert.equal(comparison.feasibleCount, 1);
    assert.deepEqual(
      comparison.options.filter((option) => option.feasible).map((option) => option.routeId),
      [EAST],
    );
    assert.deepEqual(
      comparison.options.find((option) => option.routeId === GARDEN).blockedBy,
      ['DOORWAY_WIDTH'],
    );
    assert.equal(planWith({ wheelchairWidthCm: 87 }).routeId, EAST);
  });

  test('94 cm is the widest mobility aid this venue can serve at all', () => {
    const plan = planWith({ wheelchairWidthCm: 94 });
    assert.equal(plan.routeId, EAST);
    assert.equal(plan.route.minWidthCm, 94);
    // 94 works with every other requirement at its strictest, not only its most
    // permissive: the width is genuinely the last thing standing.
    assert.equal(planWith({ wheelchairWidthCm: 94, ...MOST_PERMISSIVE }).routeId, EAST);
  });

  test('95 cm is offered by the form yet no route can take it, even with every other requirement relaxed', () => {
    // NO_COMPLETE_BUNDLE, not INVALID_WHEELCHAIR_WIDTH: 95 is a legal width
    // that simply has nowhere to go.
    const error = refusalFrom({ wheelchairWidthCm: 95, ...MOST_PERMISSIVE });
    assert.equal(error.code, 'NO_COMPLETE_BUNDLE');
    assert.equal(error.status, 422);
    assert.equal(error.message, 'No complete route, seat and assistance bundle meets every requirement.');
  });

  test('at 95 cm both routes fail on the doorway width and on nothing else', () => {
    const comparison = freshStore().listAccessOptions({ wheelchairWidthCm: 95, ...MOST_PERMISSIVE });
    assert.equal(comparison.feasibleCount, 0);
    assert.deepEqual(comparison.options.map((option) => option.blockedBy), [['DOORWAY_WIDTH'], ['DOORWAY_WIDTH']]);
    assert.deepEqual(
      comparison.options.map((option) => option.checks.find((check) => check.rule === 'DOORWAY_WIDTH').detail),
      [
        'Narrowest point 94 cm against a 95 cm mobility aid.',
        'Narrowest point 86 cm against a 95 cm mobility aid.',
      ],
    );
  });

  test('96 cm is wider than the venue will accept and is refused as an invalid width', () => {
    const error = refusalFrom({ wheelchairWidthCm: 96 });
    assert.equal(error.code, 'INVALID_WHEELCHAIR_WIDTH');
    assert.equal(error.message, 'Wheelchair width must be between 45 and 95 cm.');
  });
});

describe('maximum street-to-seat distance, at every boundary and one step past it', () => {
  test('a 19 m limit is below the accepted range and is refused as an invalid distance', () => {
    const error = refusalFrom({ maxDistanceM: 19 });
    assert.equal(error.code, 'INVALID_MAX_DISTANCE');
    assert.equal(error.status, 422);
  });

  test('a 20 m limit is accepted as a number but reaches neither entrance', () => {
    const error = refusalFrom({ maxDistanceM: 20 });
    assert.equal(error.code, 'NO_COMPLETE_BUNDLE');
    const comparison = freshStore().listAccessOptions(requirements({ maxDistanceM: 20 }));
    assert.equal(comparison.feasibleCount, 0);
    assert.deepEqual(comparison.options.map((option) => option.blockedBy), [['ROUTE_DISTANCE'], ['ROUTE_DISTANCE']]);
  });

  test('a 63 m limit falls one metre short of the East route and plans nothing', () => {
    assert.equal(refusalFrom({ maxDistanceM: 63 }).code, 'NO_COMPLETE_BUNDLE');
    const east = freshStore().checkAccessRoute(EAST, requirements({ maxDistanceM: 63 }));
    assert.equal(east.feasible, false);
    // Short by distance and by nothing else, which is what "one metre" claims.
    assert.deepEqual(east.blockedBy, ['ROUTE_DISTANCE']);
    assert.equal(
      east.checks.find((check) => check.rule === 'ROUTE_DISTANCE').detail,
      '64 m of travel against a 63 m limit.',
    );
  });

  test('a 64 m limit exactly matches the East route and is the shortest limit that plans anything', () => {
    const plan = planWith({ maxDistanceM: 64 });
    assert.equal(plan.routeId, EAST);
    assert.equal(plan.route.distanceM, 64);
  });

  test('a 70 m limit plans the East route while the Garden route stays out of reach', () => {
    const comparison = freshStore().listAccessOptions(requirements({ maxDistanceM: 70 }));
    assert.equal(comparison.feasibleCount, 1);
    assert.deepEqual(comparison.options.find((option) => option.routeId === GARDEN).blockedBy, ['ROUTE_DISTANCE']);
    assert.equal(planWith({ maxDistanceM: 70 }).routeId, EAST);
  });

  test('a 77 m limit falls one metre short of the Garden route', () => {
    const garden = freshStore().checkAccessRoute(GARDEN, requirements({ maxDistanceM: 77 }));
    assert.equal(garden.feasible, false);
    assert.deepEqual(garden.blockedBy, ['ROUTE_DISTANCE']);
    assert.equal(
      garden.checks.find((check) => check.rule === 'ROUTE_DISTANCE').detail,
      '78 m of travel against a 77 m limit.',
    );
  });

  test('a 78 m limit exactly matches the Garden route and opens both entrances', () => {
    const comparison = freshStore().listAccessOptions(requirements({ maxDistanceM: 78 }));
    assert.equal(comparison.feasibleCount, 2);
    assert.equal(planWith({ maxDistanceM: 78 }).routeId, EAST);
  });

  test('the 80 m default the form ships with plans the East route', () => {
    assert.equal(demoDefaults.maxDistanceM, 80);
    assert.equal(planWith({ maxDistanceM: 80 }).routeId, EAST);
  });

  test('the two widest accepted limits, 499 m and 500 m, both plan the East route', () => {
    assert.equal(planWith({ maxDistanceM: 499 }).routeId, EAST);
    assert.equal(planWith({ maxDistanceM: 500 }).routeId, EAST);
  });

  test('a 501 m limit is above the accepted range and is refused as an invalid distance', () => {
    const error = refusalFrom({ maxDistanceM: 501 });
    assert.equal(error.code, 'INVALID_MAX_DISTANCE');
    assert.equal(error.message, 'Maximum route distance must be between 20 and 500 metres.');
  });
});

describe('how many companions the visitor brings', () => {
  test('minus one companion is refused as an invalid companion count', () => {
    const error = refusalFrom({ companionCount: -1 });
    assert.equal(error.code, 'INVALID_COMPANION_COUNT');
    assert.equal(error.status, 422);
  });

  test('travelling alone books the lift, the wheelchair space and the host, and no companion seat', () => {
    const plan = planWith({ companionCount: 0 });
    assert.deepEqual(claimIds(plan), ['east-lift', 'space-w12', 'assist-east-1905']);
  });

  test('one companion adds the adjacent seat W13 to the very same plan', () => {
    const plan = planWith({ companionCount: 1 });
    assert.deepEqual(claimIds(plan), ['east-lift', 'space-w12', 'seat-w13', 'assist-east-1905']);
    const seat = plan.claims.find((claim) => claim.resourceId === 'seat-w13');
    assert.equal(seat.role, 'COMPANION_SEAT');
    assert.equal(seat.consume, true);
  });

  test('the seats the visitor is shown at the end of the route follow the companion count', () => {
    assert.equal(planWith({ companionCount: 0 }).route.path.at(-1), 'W12');
    assert.equal(planWith({ companionCount: 1 }).route.path.at(-1), 'W12 + W13');
  });

  test('two companions are refused: this venue seats at most one', () => {
    const error = refusalFrom({ companionCount: 2 });
    assert.equal(error.code, 'INVALID_COMPANION_COUNT');
    assert.equal(error.message, 'This demo supports zero or one companion.');
  });

  test('half a companion is refused because the count must be a whole number', () => {
    assert.equal(refusalFrom({ companionCount: 0.5 }).code, 'INVALID_COMPANION_COUNT');
  });
});

describe('the three yes-or-no requirements, in both states', () => {
  test('every one of the eight boolean combinations leaves both entrances usable', () => {
    const store = freshStore();
    for (const combination of BOOLEAN_COMBINATIONS) {
      const stated = requirements(combination);
      for (const routeId of [EAST, GARDEN]) {
        const evaluation = store.checkAccessRoute(routeId, stated);
        assert.equal(
          evaluation.feasible,
          true,
          `${routeId} should stay usable with ${JSON.stringify(combination)}`,
        );
        assert.deepEqual(
          evaluation.checks.map((check) => check.rule),
          expectedRules(stated),
          `${routeId} judged the wrong set of rules for ${JSON.stringify(combination)}`,
        );
        assert.deepEqual(evaluation.blockedBy, []);
      }
    }
  });

  test('every boolean combination, with and without a companion, plans exactly the resources it asked for', () => {
    for (const combination of BOOLEAN_COMBINATIONS) {
      for (const companionCount of [0, 1]) {
        const stated = requirements({ ...combination, companionCount });
        const plan = planWith(stated);
        assert.equal(plan.routeId, EAST);
        assert.deepEqual(
          claimIds(plan),
          expectedClaims(EAST, stated),
          `wrong resources for ${JSON.stringify(stated)}`,
        );
      }
    }
  });

  test('asking for step-free travel changes nothing here, because both routes already are', () => {
    const store = freshStore();
    for (const routeId of [EAST, GARDEN]) {
      for (const stepFree of [true, false]) {
        const check = store.checkAccessRoute(routeId, requirements({ stepFree }))
          .checks.find((rule) => rule.rule === 'STEP_FREE');
        assert.equal(check.ok, true);
        assert.equal(check.detail, 'Every segment is step-free.');
      }
    }
    assert.deepEqual(claimIds(planWith({ stepFree: true })), claimIds(planWith({ stepFree: false })));
  });

  test('asking for a lower-stimulus arrival changes nothing here, because both routes avoid the busy foyer', () => {
    const store = freshStore();
    for (const routeId of [EAST, GARDEN]) {
      for (const lowStimulus of [true, false]) {
        const check = store.checkAccessRoute(routeId, requirements({ lowStimulus }))
          .checks.find((rule) => rule.rule === 'LOW_STIMULUS');
        assert.equal(check.ok, true);
        assert.equal(check.detail, 'Avoids the busiest foyer.');
      }
    }
    assert.deepEqual(claimIds(planWith({ lowStimulus: true })), claimIds(planWith({ lowStimulus: false })));
  });

  test('entrance assistance is the only boolean that puts another resource in the plan', () => {
    const withHost = planWith({ entranceAssistance: true });
    const withoutHost = planWith({ entranceAssistance: false });
    assert.deepEqual(claimIds(withHost), ['east-lift', 'space-w12', 'seat-w13', 'assist-east-1905']);
    assert.deepEqual(claimIds(withoutHost), ['east-lift', 'space-w12', 'seat-w13']);
    assert.equal(
      withHost.claims.find((claim) => claim.resourceId === 'assist-east-1905').label,
      'Host at East Entrance · 7:05 PM',
    );
    // The host time reaches the visitor by two independent paths - the claim
    // reads the resource, the plan card reads route.assistanceLabel - and
    // nothing in the domain keeps the two copies in step.
    assert.equal(withHost.route.assistanceLabel, 'Host at East Entrance · 7:05 PM');
  });

  test('the host in the plan belongs to the entrance actually planned, not to a fixed one', () => {
    const store = freshStore();
    store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');
    const plan = store.findBundle(requirements());
    assert.equal(plan.routeId, GARDEN);
    assert.deepEqual(claimIds(plan), ['garden-lift', 'space-w12', 'seat-w13', 'assist-garden-1903']);
    assert.equal(
      plan.claims.find((claim) => claim.role === 'ENTRANCE_ASSISTANCE').label,
      'Host at Garden Entrance · 7:03 PM',
    );
    assert.equal(plan.route.assistanceLabel, 'Host at Garden Entrance · 7:03 PM');
  });
});

describe('requirements that are not requirements', () => {
  test('a yes-or-no requirement sent as a string is refused with the offending field named', () => {
    const error = refusalFrom({ stepFree: 'yes' });
    assert.equal(error.code, 'INVALID_REQUIREMENT_TYPE');
    assert.equal(error.status, 422);
    assert.equal(error.details.key, 'stepFree');
    assert.equal(error.message, `Send "stepFree" as true or false.`);
  });

  test('a requirement the venue does not know is refused rather than quietly ignored', () => {
    const error = refusalFrom({ quietRoom: true });
    assert.equal(error.code, 'UNSUPPORTED_REQUIREMENT');
    assert.equal(error.status, 422);
    assert.equal(error.details.key, 'quietRoom');
  });

  test('planning refuses to invent an access requirement the visitor never stated', () => {
    const store = freshStore();
    const error = refusalOf(() => store.findBundle({ wheelchairWidthCm: 72 }));
    assert.equal(error.code, 'MISSING_REQUIREMENTS');
    assert.equal(error.status, 422);
    assert.deepEqual(
      error.details.missing,
      ['maxDistanceM', 'stepFree', 'companionCount', 'entranceAssistance', 'lowStimulus'],
    );
  });

  test('the read-only comparison does fall back to the published defaults', () => {
    // Pinned separately on purpose: the first assertion pins what the published
    // defaults are, the second pins that the read-only path actually uses them.
    assert.deepEqual(demoDefaults, {
      wheelchairWidthCm: 72,
      maxDistanceM: 80,
      stepFree: true,
      companionCount: 1,
      entranceAssistance: true,
      lowStimulus: true,
    });
    assert.deepEqual(freshStore().listAccessOptions({}).requirements, demoDefaults);
    assert.deepEqual(freshStore().checkAccessRoute(EAST, {}).requirements, demoDefaults);
  });
});

describe('the requirement schema a browser agent is handed', () => {
  function visitorSurface() {
    const reached = [];
    const tools = createVisitorTools({
      api: async (path) => { reached.push(path); throw new DomainError('REACHED_THE_VENUE', 'stub', 500); },
      refresh: async () => { reached.push('refresh'); throw new DomainError('REACHED_THE_VENUE', 'stub', 500); },
    });
    return { tools, reached, tool: (name) => tools.find((candidate) => candidate.name === name) };
  }

  test('the published schema states the same bounds the venue enforces, and demands all six fields', () => {
    const { tool } = visitorSurface();
    const schema = tool('find_access_bundle').inputSchema;
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, [
      'wheelchairWidthCm', 'maxDistanceM', 'stepFree', 'companionCount', 'entranceAssistance', 'lowStimulus',
    ]);
    assert.deepEqual(schema.properties.wheelchairWidthCm, {
      type: 'number', minimum: 45, maximum: 95, description: 'Width of the mobility aid in centimetres.',
    });
    assert.deepEqual(schema.properties.maxDistanceM, {
      type: 'number', minimum: 20, maximum: 500, description: 'Longest acceptable street-to-seat route in metres.',
    });
    assert.deepEqual(schema.properties.companionCount.enum, [0, 1]);
    assert.equal(schema.properties.companionCount.type, 'integer');
    for (const name of ['stepFree', 'entranceAssistance', 'lowStimulus']) {
      assert.equal(schema.properties[name].type, 'boolean', `${name} should be a boolean`);
    }
  });

  test('a requirement outside the published bounds is refused before any request leaves the page', async () => {
    const cases = [
      [{ wheelchairWidthCm: 44 }, 'INVALID_TOOL_ARGUMENT', 'wheelchairWidthCm'],
      [{ wheelchairWidthCm: 96 }, 'INVALID_TOOL_ARGUMENT', 'wheelchairWidthCm'],
      [{ maxDistanceM: 19 }, 'INVALID_TOOL_ARGUMENT', 'maxDistanceM'],
      [{ maxDistanceM: 501 }, 'INVALID_TOOL_ARGUMENT', 'maxDistanceM'],
      [{ companionCount: -1 }, 'INVALID_TOOL_ARGUMENT', 'companionCount'],
      [{ companionCount: 2 }, 'INVALID_TOOL_ARGUMENT', 'companionCount'],
      [{ companionCount: 0.5 }, 'INVALID_TOOL_ARGUMENT', 'companionCount'],
      [{ stepFree: 'yes' }, 'INVALID_TOOL_ARGUMENT', 'stepFree'],
    ];
    for (const [overrides, code, argument] of cases) {
      const { tool, reached } = visitorSurface();
      const result = JSON.parse(await tool('find_access_bundle').execute(requirements(overrides)));
      assert.equal(result.ok, false, `${JSON.stringify(overrides)} should be refused`);
      assert.equal(result.error, code);
      assert.equal(result.argument, argument);
      assert.equal(result.nextAction, 'READ_THE_TOOL_SCHEMA_AND_RETRY');
      assert.deepEqual(reached, [], `${JSON.stringify(overrides)} must not reach the venue`);
    }
  });

  test('95 cm passes the published schema and is only refused once the venue has been asked', async () => {
    const { tool, reached } = visitorSurface();
    const result = JSON.parse(await tool('find_access_bundle').execute(requirements({ wheelchairWidthCm: 95 })));
    assert.equal(result.ok, false);
    // The schema does not catch it - the request is made and the venue answers.
    assert.deepEqual(reached, ['/api/plans']);
    assert.equal(result.error, 'REACHED_THE_VENUE');
  });

  test('a requirement the schema does not declare is refused with the allowed list attached', async () => {
    const { tool, reached } = visitorSurface();
    const result = JSON.parse(await tool('find_access_bundle').execute(requirements({ quietRoom: true })));
    assert.equal(result.error, 'UNSUPPORTED_TOOL_ARGUMENT');
    assert.equal(result.argument, 'quietRoom');
    assert.deepEqual(result.allowed, [
      'wheelchairWidthCm', 'maxDistanceM', 'stepFree', 'companionCount', 'entranceAssistance', 'lowStimulus',
    ]);
    assert.deepEqual(reached, []);
  });

  test('an incomplete requirement set is named field by field so the agent can ask the visitor', async () => {
    const { tool, reached } = visitorSurface();
    const result = JSON.parse(await tool('find_access_bundle').execute({ wheelchairWidthCm: 72, maxDistanceM: 80 }));
    assert.equal(result.error, 'MISSING_REQUIREMENTS');
    assert.deepEqual(result.missing, ['stepFree', 'companionCount', 'entranceAssistance', 'lowStimulus']);
    assert.equal(result.nextAction, 'ASK_THE_VISITOR_FOR_THE_MISSING_REQUIREMENTS');
    assert.deepEqual(reached, []);
  });

  test('every requirement field is typed, described, inside the parameter budget, and the surface passes the tool contract', () => {
    const { tools, tool } = visitorSurface();
    const properties = tool('find_access_bundle').inputSchema.properties;
    assert.equal(Object.keys(properties).length, 6);
    for (const [name, definition] of Object.entries(properties)) {
      assert.ok(definition.type, `${name} declares no type`);
      assert.ok(definition.description?.length > 0, `${name} has no description`);
      assert.ok(
        definition.description.length <= TOOL_LIMITS.parameterDescriptionChars,
        `${name} description is ${definition.description.length} characters, over the ${TOOL_LIMITS.parameterDescriptionChars} budget`,
      );
    }
    assert.deepEqual(checkToolContract(tools, 'visitor booking'), []);
  });
});

describe('the form and the venue disagree about the widest wheelchair', () => {
  test('the visitor form offers a 95 cm width that no route in the venue can serve', () => {
    const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
    const field = html.match(/<input[^>]*name="wheelchairWidthCm"[^>]*>/);
    assert.ok(field, 'the requirements form should still have a wheelchair width field');
    const max = Number(field[0].match(/max="(\d+)"/)[1]);
    const min = Number(field[0].match(/min="(\d+)"/)[1]);

    assert.equal(min, 45);
    assert.equal(max, 95);
    // What the form offers, and what the venue can actually do, are one apart.
    // This is the observed gap; it is asserted, not fixed, here.
    assert.equal(refusalFrom({ wheelchairWidthCm: max, ...MOST_PERMISSIVE }).code, 'NO_COMPLETE_BUNDLE');
    assert.equal(planWith({ wheelchairWidthCm: max - 1 }).routeId, EAST);
  });
});
