import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

import { createDemoStore } from '../lib/domain.mjs';
import {
  TOOL_LIMITS,
  PHASES,
  createVisitorTools,
  createOperatorTools,
  toolsForPhase,
  toolCounts,
} from '../public/tools.mjs';
import { checkToolContract } from '../evals/contract.mjs';

/**
 * Routes tool calls into a real demo store, mirroring server.mjs. The tools
 * therefore run against genuine domain behaviour rather than a mock that could
 * drift away from it.
 */
function createHarness() {
  let counter = 0;
  const store = createDemoStore({
    clock: () => Date.parse('2026-08-29T18:00:00.000Z'),
    idFactory: () => `id-${++counter}`,
  });

  const calls = [];

  async function api(path, options = {}) {
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ method, path });

    if (method === 'GET' && path === '/api/state') return { ok: true, state: store.snapshot() };
    if (method === 'GET' && path === '/api/explain') return { ok: true, explanation: store.explainRefusal() };
    if (method === 'POST' && path === '/api/access-options') {
      return { ok: true, evaluation: store.listAccessOptions(body.requirements ?? {}) };
    }

    const checkMatch = path.match(/^\/api\/access-routes\/([^/]+)\/check$/);
    if (method === 'POST' && checkMatch) {
      return { ok: true, evaluation: store.checkAccessRoute(decodeURIComponent(checkMatch[1]), body.requirements ?? {}) };
    }
    if (method === 'POST' && path === '/api/plans') {
      const plan = store.findBundle(body.requirements ?? {}, { actor: 'webmcp-agent', toolName: 'find_access_bundle' });
      return { ok: true, plan, state: store.snapshot() };
    }

    const stageMatch = path.match(/^\/api\/plans\/([^/]+)\/stage$/);
    if (method === 'POST' && stageMatch) {
      const plan = store.stageBundle(decodeURIComponent(stageMatch[1]), body.expectedResourceVersion, {
        actor: 'webmcp-agent',
        toolName: 'stage_access_bundle',
      });
      return { ok: true, plan, state: store.snapshot() };
    }

    const replanMatch = path.match(/^\/api\/plans\/([^/]+)\/replan$/);
    if (method === 'POST' && replanMatch) {
      const plan = store.replanBundle(decodeURIComponent(replanMatch[1]), {
        actor: 'webmcp-agent',
        toolName: 'replan_access_bundle',
      });
      return { ok: true, plan, state: store.snapshot() };
    }

    const clearMatch = path.match(/^\/api\/plans\/([^/]+)\/clear$/);
    if (method === 'POST' && clearMatch) {
      return { ok: true, state: store.clearPlan(decodeURIComponent(clearMatch[1]), { actor: 'webmcp-agent', toolName: 'clear_access_plan' }) };
    }

    const outageMatch = path.match(/^\/api\/operator\/facilities\/([^/]+)\/outage$/);
    if (method === 'POST' && outageMatch) {
      return { ok: true, state: store.setFacilityOutage(decodeURIComponent(outageMatch[1]), body.reasonCode) };
    }

    const restoreMatch = path.match(/^\/api\/operator\/facilities\/([^/]+)\/restore$/);
    if (method === 'POST' && restoreMatch) {
      return { ok: true, state: store.restoreFacility(decodeURIComponent(restoreMatch[1])) };
    }

    throw new Error(`Unrouted call: ${method} ${path}`);
  }

  let refreshCalls = 0;
  let lastRefreshedState = null;
  const refresh = async () => {
    refreshCalls += 1;
    lastRefreshedState = store.snapshot();
    return lastRefreshedState;
  };
  return {
    store,
    calls,
    refreshCount: () => refreshCalls,
    lastRefreshedState: () => lastRefreshedState,
    visitor: createVisitorTools({ api, refresh }),
    operator: createOperatorTools({ api, refresh }),
  };
}

const FULL_REQUIREMENTS = {
  wheelchairWidthCm: 72,
  maxDistanceM: 80,
  stepFree: true,
  companionCount: 1,
  entranceAssistance: true,
  lowStimulus: true,
};

function toolNamed(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `tool ${name} should exist`);
  return tool;
}

test('the published tool contract holds for both surfaces', () => {
  const { visitor, operator } = createHarness();
  assert.deepEqual(checkToolContract(visitor, 'visitor'), []);
  assert.deepEqual(checkToolContract(operator, 'operator'), []);
});

/**
 * One scenario per tool, each driven in a harness of its own.
 *
 * A single shared input map cannot do this job. The previous version handed
 * every tool one entry from a WORKING_INPUT map described as "arguments that
 * would let each tool succeed". For restore_facility that was false: East Lift
 * is OPERATIONAL in a fresh store, so restoring it is an accepted no-op that
 * returns the snapshot untouched and writes no audit line. Mislabelling that
 * tool read-only left the snapshot comparison with nothing it could detect.
 *
 * Each scenario therefore drives the exact phase and precondition its tool
 * needs, and declares whether the tool writes. A declared write is proved to
 * move the venue snapshot in the very same call the contract then judges, so
 * the read-only comparison below is only ever made about calls that
 * demonstrably could have changed something.
 */
async function proposedPlan(harness) {
  const found = JSON.parse(await toolNamed(harness.visitor, 'find_access_bundle').execute(FULL_REQUIREMENTS));
  assert.equal(harness.store.snapshot().phase, 'PLAN_READY', 'the scenario should have produced a proposed plan');
  return found.plan;
}

async function stagedPlan(harness) {
  const plan = await proposedPlan(harness);
  await toolNamed(harness.visitor, 'stage_access_bundle').execute({
    planId: plan.id,
    expectedVenueRevision: plan.basedOnRevision,
  });
  assert.equal(harness.store.snapshot().phase, 'AWAITING_HUMAN_CONFIRMATION', 'the scenario should have staged the plan');
  return plan;
}

async function stalePlan(harness) {
  const plan = await stagedPlan(harness);
  await toolNamed(harness.operator, 'report_facility_outage').execute({
    facilityId: 'east-lift',
    reasonCode: 'LIFT_DOOR_FAULT',
  });
  assert.equal(harness.store.snapshot().phase, 'PLAN_STALE', 'the scenario should have invalidated the staged plan');
  return plan;
}

async function liftOutOfService(harness) {
  await toolNamed(harness.operator, 'report_facility_outage').execute({
    facilityId: 'east-lift',
    reasonCode: 'POWER_FAULT',
  });
  assert.equal(
    harness.store.snapshot().resources['east-lift'].status,
    'OUT_OF_SERVICE',
    'the scenario should have taken East Lift out of service',
  );
}

const SCENARIOS = {
  get_event_access_state: {
    surface: 'visitor',
    writes: false,
    setUp: async (harness) => {
      await stagedPlan(harness);
      return {};
    },
  },
  get_access_bundle_status: {
    surface: 'visitor',
    writes: false,
    setUp: async (harness) => {
      await stagedPlan(harness);
      return {};
    },
  },
  list_access_options: {
    surface: 'visitor',
    writes: false,
    setUp: async (harness) => {
      await stagedPlan(harness);
      return FULL_REQUIREMENTS;
    },
  },
  check_access_route: {
    surface: 'visitor',
    writes: false,
    setUp: async (harness) => {
      await stagedPlan(harness);
      return { routeId: 'east-lift-route', ...FULL_REQUIREMENTS };
    },
  },
  explain_access_refusal: {
    // Registered only in PLAN_STALE and NO_ALTERNATIVE. Called in READY it has
    // no refusal to describe, which is not the call worth protecting.
    surface: 'visitor',
    writes: false,
    setUp: async (harness) => {
      await stalePlan(harness);
      return {};
    },
  },
  find_access_bundle: {
    // A fresh store is in READY with no active plan, which is the only phase
    // this is registered in and the only one where a search is accepted.
    surface: 'visitor',
    writes: true,
    setUp: async (harness) => {
      assert.equal(harness.store.snapshot().phase, 'READY', 'a fresh store should be ready to plan');
      return FULL_REQUIREMENTS;
    },
  },
  stage_access_bundle: {
    surface: 'visitor',
    writes: true,
    setUp: async (harness) => {
      const plan = await proposedPlan(harness);
      return { planId: plan.id, expectedVenueRevision: plan.basedOnRevision };
    },
  },
  replan_access_bundle: {
    surface: 'visitor',
    writes: true,
    setUp: async (harness) => {
      const plan = await stalePlan(harness);
      return { stalePlanId: plan.id };
    },
  },
  clear_access_plan: {
    surface: 'visitor',
    writes: true,
    setUp: async (harness) => {
      const plan = await stagedPlan(harness);
      return { planId: plan.id };
    },
  },
  get_facility_status: {
    surface: 'operator',
    writes: false,
    setUp: async (harness) => {
      await liftOutOfService(harness);
      return {};
    },
  },
  report_facility_outage: {
    // Reporting an outage already in force is an accepted no-op, so the lift
    // has to still be in service when the call is made.
    surface: 'operator',
    writes: true,
    setUp: async (harness) => {
      assert.equal(
        harness.store.snapshot().resources['east-lift'].status,
        'OPERATIONAL',
        'the outage scenario needs a lift that is still in service',
      );
      return { facilityId: 'east-lift', reasonCode: 'POWER_FAULT' };
    },
  },
  restore_facility: {
    // The one the shared map got wrong. Restoring a lift that is already
    // OPERATIONAL is accepted and changes nothing, so it has to be out of
    // service first or this scenario proves nothing about a mislabel.
    surface: 'operator',
    writes: true,
    setUp: async (harness) => {
      await liftOutOfService(harness);
      return { facilityId: 'east-lift' };
    },
  },
};

test('a tool marked read-only leaves the venue untouched', async () => {
  const declared = createHarness();
  const everyTool = [
    ...declared.visitor.map((tool) => ['visitor', tool]),
    ...declared.operator.map((tool) => ['operator', tool]),
  ];

  // Both surfaces, not just the visitor's. The operator surface is the one that
  // can take a lift out of service, so its single read-only tool is exactly the
  // one where a mislabelled write would do the most damage - and it used not to
  // be exercised here at all.
  const readOnly = everyTool.filter(([, tool]) => tool.annotations.readOnlyHint);
  // The exact set, not a count. A count is the thing that goes stale silently:
  // adding a read-only tool keeps a >= assertion green while the new tool is
  // never actually exercised, and a hard-coded equality just breaks for the
  // wrong reason. Naming them says which tools this test claims to cover.
  assert.deepEqual(
    readOnly.map(([surface, tool]) => `${surface}:${tool.name}`).sort(),
    [
      'operator:get_facility_status',
      'visitor:check_access_route',
      'visitor:explain_access_refusal',
      'visitor:get_access_bundle_status',
      'visitor:get_event_access_state',
      'visitor:list_access_options',
    ],
    'the read-only surface changed; update this list and confirm each one is still read-only',
  );

  // A new tool with no scenario would otherwise be skipped in silence, and a
  // scenario left behind by a deleted tool would look like coverage it is not.
  assert.deepEqual(
    Object.keys(SCENARIOS).sort(),
    everyTool.map(([, tool]) => tool.name).sort(),
    'every registered tool needs a scenario here, and no scenario may name a tool that is gone',
  );
  for (const [surface, tool] of everyTool) {
    assert.equal(SCENARIOS[tool.name].surface, surface, `the scenario for ${tool.name} names the wrong surface`);
  }

  for (const [surface, tool] of everyTool) {
    const scenario = SCENARIOS[tool.name];
    // A harness per tool. Shared state is how a scenario stops meaning what it
    // says: whichever tool ran first decides what the next one is really doing.
    const harness = createHarness();
    const input = await scenario.setUp(harness);
    const subject = toolNamed(surface === 'visitor' ? harness.visitor : harness.operator, tool.name);

    const before = harness.store.snapshot();
    const result = await subject.execute(input);
    const after = harness.store.snapshot();

    // A refused call changes nothing and would satisfy the read-only comparison
    // for the wrong reason. The scenario has to be one the tool accepts.
    assert.notEqual(
      JSON.parse(result).ok,
      false,
      `${surface} tool ${tool.name} refused its own scenario, so this proves nothing: ${result}`,
    );

    if (scenario.writes) {
      assert.ok(
        !isDeepStrictEqual(before, after),
        `${surface} tool ${tool.name} writes, but its scenario left the venue snapshot identical; `
        + 'a mislabelled read-only annotation on it could not be detected here',
      );
    }

    if (subject.annotations.readOnlyHint) {
      assert.deepStrictEqual(
        after,
        before,
        `${surface} tool ${tool.name} is declared read-only but changed the venue`,
      );
    }
  }
});

test('event state separates committed reservations from partial writes', async () => {
  const harness = createHarness();
  const found = JSON.parse(await toolNamed(harness.visitor, 'find_access_bundle').execute(FULL_REQUIREMENTS));
  await toolNamed(harness.visitor, 'stage_access_bundle').execute({
    planId: found.plan.id,
    expectedVenueRevision: found.plan.basedOnRevision,
  });
  const confirmation = harness.store.prepareConfirmation(found.plan.id);
  harness.store.commitBundle({
    planId: found.plan.id,
    confirmationId: confirmation.confirmationId,
    expectedResourceVersion: confirmation.expectedResourceVersion,
    accepted: true,
    requestId: 'event-state-metrics',
  });

  const eventState = JSON.parse(await toolNamed(harness.visitor, 'get_event_access_state').execute({}));
  const bundleStatus = JSON.parse(await toolNamed(harness.visitor, 'get_access_bundle_status').execute({}));
  assert.equal(eventState.phase, 'CONFIRMED');
  assert.equal(eventState.reservedResourceCount, 3);
  assert.equal(Object.hasOwn(eventState, 'partialReservations'), false);
  assert.equal(bundleStatus.booking.partialReservations, 0);
});

test('every tool result stays inside the output budget', async () => {
  const harness = createHarness();
  const results = [];

  results.push(await toolNamed(harness.visitor, 'get_event_access_state').execute({}));
  results.push(await toolNamed(harness.visitor, 'list_access_options').execute(FULL_REQUIREMENTS));
  results.push(await toolNamed(harness.visitor, 'check_access_route').execute({ routeId: 'east-lift-route', ...FULL_REQUIREMENTS }));

  const found = await toolNamed(harness.visitor, 'find_access_bundle').execute(FULL_REQUIREMENTS);
  results.push(found);
  const plan = JSON.parse(found).plan;
  results.push(await toolNamed(harness.visitor, 'stage_access_bundle').execute({
    planId: plan.id,
    expectedVenueRevision: plan.basedOnRevision,
  }));
  results.push(await toolNamed(harness.visitor, 'get_access_bundle_status').execute({}));

  await toolNamed(harness.operator, 'report_facility_outage').execute({ facilityId: 'east-lift', reasonCode: 'LIFT_DOOR_FAULT' });
  results.push(await toolNamed(harness.visitor, 'explain_access_refusal').execute({}));

  for (const result of results) {
    assert.equal(typeof result, 'string');
    assert.ok(
      result.length <= TOOL_LIMITS.outputChars,
      `a tool returned ${result.length} characters, over the ${TOOL_LIMITS.outputChars} budget`,
    );
    JSON.parse(result);
  }
});

test('a refusal explains the broken rule and names the routes that still work', async () => {
  const harness = createHarness();
  const found = await toolNamed(harness.visitor, 'find_access_bundle').execute(FULL_REQUIREMENTS);
  const plan = JSON.parse(found).plan;
  await toolNamed(harness.visitor, 'stage_access_bundle').execute({
    planId: plan.id,
    expectedVenueRevision: plan.basedOnRevision,
  });

  await toolNamed(harness.operator, 'report_facility_outage').execute({ facilityId: 'east-lift', reasonCode: 'LIFT_DOOR_FAULT' });

  const explanation = JSON.parse(await toolNamed(harness.visitor, 'explain_access_refusal').execute({}));
  assert.equal(explanation.blocked, true);
  assert.equal(explanation.errorCode, 'STALE_RESOURCE_VERSION');
  assert.equal(explanation.partialReservations, 0);
  assert.ok(explanation.planRevision < explanation.venueRevision);
  assert.ok(explanation.brokenRules.some((rule) => rule.rule === 'LIFT_OPERATIONAL'));
  assert.deepEqual(explanation.validOptionsNow.map((option) => option.routeId), ['garden-lift-route']);
  assert.equal(explanation.nextAction, 'REPLAN');
});

test('an explanation cannot disagree with what the planner does', async () => {
  const harness = createHarness();
  // A route the visitor cannot fit through must be reported as blocked by the
  // read tool and refused by the write tool, from the same rule set.
  const tooNarrow = { ...FULL_REQUIREMENTS, wheelchairWidthCm: 90 };

  const listed = JSON.parse(await toolNamed(harness.visitor, 'list_access_options').execute(tooNarrow));
  assert.equal(listed.feasibleCount, 1);
  const garden = listed.options.find((option) => option.routeId === 'garden-lift-route');
  assert.equal(garden.feasible, false);
  assert.ok(garden.blockedBy.includes('DOORWAY_WIDTH'));

  const planned = JSON.parse(await toolNamed(harness.visitor, 'find_access_bundle').execute(tooNarrow));
  assert.equal(planned.plan.route.at(0), 'East Entrance');
});

test('confirming a booking leaves no tool that can change it', () => {
  const { visitor } = createHarness();
  const confirmed = toolsForPhase(visitor, 'CONFIRMED');
  assert.equal(toolCounts(confirmed).write, 0);
  assert.ok(toolCounts(confirmed).read >= 3);
});

test('the operations role never exposes booking tools', () => {
  const { operator } = createHarness();
  const names = operator.map((tool) => tool.name);
  assert.deepEqual(names, ['get_facility_status', 'report_facility_outage', 'restore_facility']);
  for (const name of names) assert.ok(!name.includes('bundle'), `${name} should not touch bookings`);
});

test('the booking search demands every requirement explicitly', () => {
  const { visitor } = createHarness();
  const search = toolNamed(visitor, 'find_access_bundle');
  assert.deepEqual(search.inputSchema.required.sort(), Object.keys(FULL_REQUIREMENTS).sort());

  // Read-only comparison stays exploratory: partial requirements are allowed.
  const compare = toolNamed(visitor, 'list_access_options');
  assert.equal(compare.inputSchema.required, undefined);
});

test('malformed tool inputs are refused before any HTTP call', async () => {
  const harness = createHarness();
  const before = harness.calls.length;

  const missingRequirements = JSON.parse(await toolNamed(harness.visitor, 'find_access_bundle').execute({ wheelchairWidthCm: 72 }));
  const wrongType = JSON.parse(await toolNamed(harness.visitor, 'find_access_bundle').execute({
    ...FULL_REQUIREMENTS,
    wheelchairWidthCm: '72',
  }));
  const outOfRange = JSON.parse(await toolNamed(harness.visitor, 'find_access_bundle').execute({
    ...FULL_REQUIREMENTS,
    maxDistanceM: 10,
  }));
  const invalidEnum = JSON.parse(await toolNamed(harness.visitor, 'find_access_bundle').execute({
    ...FULL_REQUIREMENTS,
    companionCount: 2,
  }));
  const unknownArgument = JSON.parse(await toolNamed(harness.visitor, 'find_access_bundle').execute({
    ...FULL_REQUIREMENTS,
    diagnosis: 'must never be accepted',
  }));
  const missingRoute = JSON.parse(await toolNamed(harness.visitor, 'check_access_route').execute({}));
  const badRoute = JSON.parse(await toolNamed(harness.visitor, 'check_access_route').execute({ routeId: 'east-lift-route ' }));
  const missingStage = JSON.parse(await toolNamed(harness.visitor, 'stage_access_bundle').execute({}));
  const missingReplan = JSON.parse(await toolNamed(harness.visitor, 'replan_access_bundle').execute({}));
  const missingClear = JSON.parse(await toolNamed(harness.visitor, 'clear_access_plan').execute({}));
  const missingOutageReason = JSON.parse(await toolNamed(harness.operator, 'report_facility_outage').execute({ facilityId: 'east-lift' }));
  const missingRestore = JSON.parse(await toolNamed(harness.operator, 'restore_facility').execute({}));

  assert.equal(missingRequirements.error, 'MISSING_REQUIREMENTS');
  assert.ok(missingRequirements.missing.includes('stepFree'));
  for (const result of [wrongType, outOfRange, invalidEnum]) {
    assert.equal(result.error, 'INVALID_TOOL_ARGUMENT');
    assert.ok(result.argument);
  }
  assert.equal(unknownArgument.error, 'UNSUPPORTED_TOOL_ARGUMENT');
  assert.equal(unknownArgument.argument, 'diagnosis');
  assert.equal(missingRoute.error, 'ROUTE_ID_REQUIRED');
  assert.equal(missingRoute.nextAction, 'CALL_LIST_ACCESS_OPTIONS');
  assert.equal(badRoute.error, 'ROUTE_NOT_FOUND');
  for (const result of [missingStage, missingReplan, missingClear, missingOutageReason, missingRestore]) {
    assert.equal(result.ok, false);
    assert.ok(['MISSING_TOOL_ARGUMENTS', 'INVALID_TOOL_ARGUMENT'].includes(result.error));
    assert.ok(result.missing?.length || result.argument);
  }
  // INPUT-01 claims "every imperative write tool with {}". The calls above were
  // a mixture rather than that claim: find_access_bundle got one requirement and
  // report_facility_outage got a facilityId, so two of the six write tools were
  // never actually called with {} at all. Drive the set from the registered
  // surfaces instead of retyping it, so a new write tool is covered the day it
  // is added rather than the day somebody remembers this list.
  const imperativeWrites = [
    ...harness.visitor.map((tool) => ['visitor', tool]),
    ...harness.operator.map((tool) => ['operator', tool]),
  ].filter(([, tool]) => tool.annotations.readOnlyHint === false);
  assert.deepEqual(
    imperativeWrites.map(([surface, tool]) => `${surface}:${tool.name}`).sort(),
    [
      'operator:report_facility_outage',
      'operator:restore_facility',
      'visitor:clear_access_plan',
      'visitor:find_access_bundle',
      'visitor:replan_access_bundle',
      'visitor:stage_access_bundle',
    ],
    'the imperative write surface changed; INPUT-01 now covers a different set',
  );
  // The declarative tool is deliberately outside that set. Chrome registers
  // set_access_requirements from the markup in public/index.html, never from
  // public/tools.mjs, and by design it keeps the visible form values for fields
  // the caller omits. HITL-01 and HITL-03 are what cover it, in a browser.
  assert.equal(
    [...harness.visitor, ...harness.operator].some((tool) => tool.name === 'set_access_requirements'),
    false,
    'the declarative tool must stay outside the imperative set INPUT-01 measures',
  );

  for (const [surface, tool] of imperativeWrites) {
    const callsBefore = harness.calls.length;
    const refused = JSON.parse(await tool.execute({}));
    assert.equal(refused.ok, false, `${surface}:${tool.name} did not refuse {}`);
    assert.ok(
      ['MISSING_REQUIREMENTS', 'MISSING_TOOL_ARGUMENTS'].includes(refused.error),
      `${surface}:${tool.name} refused {} as ${refused.error}, which is not a missing-argument refusal`,
    );
    assert.ok(refused.missing?.length, `${surface}:${tool.name} did not say what was missing`);
    assert.ok(
      typeof refused.message === 'string' && refused.message.length > 0,
      `${surface}:${tool.name} refused {} without a readable message`,
    );
    assert.ok(refused.nextAction, `${surface}:${tool.name} left the agent with no next action`);
    assert.equal(
      harness.calls.length,
      callsBefore,
      `${surface}:${tool.name} issued an HTTP call for input it had already refused`,
    );
  }

  assert.equal(harness.calls.length, before, 'invalid inputs must not issue doomed network requests');
});

test('a refused call comes back as a readable result, not a thrown error', async () => {
  const harness = createHarness();
  const search = toolNamed(harness.visitor, 'find_access_bundle');

  // Requirements the browser will not enforce for us must still be demanded.
  const missing = JSON.parse(await search.execute({ wheelchairWidthCm: 72 }));
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'MISSING_REQUIREMENTS');
  assert.equal(missing.nextAction, 'ASK_THE_VISITOR_FOR_THE_MISSING_REQUIREMENTS');
  assert.ok(missing.missing.includes('stepFree'));

  await search.execute(FULL_REQUIREMENTS);

  // A second search while a plan is open is refused by the server. The agent
  // must be able to read why; a thrown error reaches it as an opaque browser
  // failure instead.
  const second = JSON.parse(await search.execute(FULL_REQUIREMENTS));
  assert.equal(second.ok, false);
  assert.equal(second.error, 'ACTIVE_PLAN_EXISTS');
  assert.equal(second.nextAction, 'CLEAR_THE_CURRENT_PLAN_OR_LET_THE_VISITOR_CONFIRM_IT');
  assert.ok(second.activePlanId);
  // No write was attempted, so there is no count to report. The field appears
  // only where the server actually counted, rather than always saying zero.
  assert.equal(second.partialReservations, undefined);
});

test('no tool result exceeds the output budget, refusals included', async () => {
  const harness = createHarness();
  const refused = await toolNamed(harness.visitor, 'find_access_bundle').execute({});
  assert.equal(typeof refused, 'string');
  assert.ok(refused.length <= TOOL_LIMITS.outputChars);
  assert.equal(JSON.parse(refused).ok, false);
});

test('no registered tool can prepare or commit a booking, in any page state', async () => {
  // HITL-02 used to be a claim about a handful of snapshots plus the phrase
  // "confirmation remains human-only". That phrase overreached: the server
  // cannot prove a human was present, and test/http.test.mjs demonstrates a
  // plain HTTP session committing a booking with no page involved.
  //
  // What is actually enforceable is the tool-surface boundary, so that is what
  // this asserts, over every phase rather than a sample: whatever the page is
  // showing, the registered set contains nothing that reaches a confirmation
  // endpoint, and driving all of it leaves the venue without a booking.
  const harness = createHarness();
  const CONFIRMATION_PATHS = /(prepare-confirmation|\/commit$)/;

  const everyRegisteredName = new Set();
  for (const phase of PHASES) {
    const registered = toolsForPhase(harness.visitor, phase);
    assert.ok(registered.length > 0, `${phase} should register at least one tool`);

    for (const tool of registered) {
      everyRegisteredName.add(tool.name);
      const before = harness.calls.length;
      // Best-effort input. Most of these refuse, because the store is not in the
      // phase being enumerated - which is the point: even a refused call must
      // not have reached a confirmation endpoint on the way to refusing.
      const input = tool.name === 'check_access_route'
        ? { routeId: 'east-lift-route', ...FULL_REQUIREMENTS }
        : tool.name === 'list_access_options' || tool.name === 'find_access_bundle'
          ? FULL_REQUIREMENTS
          : tool.name === 'stage_access_bundle'
            ? { planId: 'id-1', expectedVenueRevision: 1 }
            : tool.name === 'replan_access_bundle'
              ? { stalePlanId: 'id-1' }
              : tool.name === 'clear_access_plan'
                ? { planId: 'id-1' }
                : {};
      await tool.execute(input);

      for (const call of harness.calls.slice(before)) {
        assert.equal(
          CONFIRMATION_PATHS.test(call.path),
          false,
          `${tool.name} reached ${call.path} while registered in ${phase}`,
        );
      }
    }
  }

  // The registry never grew a confirmation tool under some other spelling.
  for (const name of everyRegisteredName) {
    assert.equal(
      /confirm|commit|accept|book(?!ing_status)/i.test(name),
      false,
      `${name} is registered and reads as a confirmation tool`,
    );
  }

  // And the decisive one: after driving every tool in every phase, nothing is
  // booked. A tool that found a route to a confirmation the regexes above did
  // not anticipate would still be caught here.
  assert.equal(harness.store.snapshot().booking, null, 'the tool surface produced a booking');
});

/**
 * Drives a fresh harness to a committed booking over the east lift and returns
 * the stored booking record. Confirmation deliberately does not go through the
 * tool surface - the test above asserts that no registered tool can reach it -
 * so it goes through the store, exactly as server.mjs does when a person
 * presses confirm.
 */
async function bookEastLiftRoute(harness, requestId) {
  const found = JSON.parse(await toolNamed(harness.visitor, 'find_access_bundle').execute(FULL_REQUIREMENTS));
  await toolNamed(harness.visitor, 'stage_access_bundle').execute({
    planId: found.plan.id,
    expectedVenueRevision: found.plan.basedOnRevision,
  });
  const confirmation = harness.store.prepareConfirmation(found.plan.id);
  harness.store.commitBundle({
    planId: found.plan.id,
    confirmationId: confirmation.confirmationId,
    expectedResourceVersion: confirmation.expectedResourceVersion,
    accepted: true,
    requestId,
  });
  const booking = harness.store.snapshot().booking;
  assert.ok(booking, 'the scenario needs a committed booking');
  assert.equal(booking.routeId, 'east-lift-route', 'this scenario needs the booking to run over the east lift');
  return booking;
}

test('an outage rewrites no booking, and only a booking over the reported lift loses a facility', async () => {
  // report_facility_outage used to tell an agent, of every outage, that the
  // booking survives "though the lift named in its route is now unavailable".
  // A booking runs over one lift and an operator may report the other, so that
  // clause was false whenever the two differ. Both halves are asserted here.

  // The facilities a booking's own route names, read out of the booking record
  // instead of hard-coded, so this keeps meaning the same thing if the venue
  // ever gains a third lift.
  const facilitiesNamedByRoute = (state, booking) => Object.values(state.resources)
    .filter((resource) => resource.kind === 'FACILITY')
    .filter((resource) => booking.resourceIds.includes(resource.id) || booking.route.path.includes(resource.label));

  // (a) The operator reports the lift the booking actually runs over.
  {
    const harness = createHarness();
    const booked = await bookEastLiftRoute(harness, 'outage-on-the-booked-lift');
    const before = harness.store.snapshot();

    await toolNamed(harness.operator, 'report_facility_outage').execute({
      facilityId: 'east-lift',
      reasonCode: 'LIFT_DOOR_FAULT',
    });

    const after = harness.store.snapshot();
    assert.ok(
      after.resourceVersion > before.resourceVersion,
      'the outage never took effect, so this case would prove nothing',
    );
    assert.deepStrictEqual(after.booking, booked, 'the outage cancelled or rewrote the booking record');

    const named = facilitiesNamedByRoute(after, after.booking);
    assert.ok(named.length > 0, 'the booking names no facility at all; the status check below would be vacuous');
    assert.deepEqual(
      named.map((facility) => `${facility.id}:${facility.status}`),
      ['east-lift:OUT_OF_SERVICE'],
      'the booking is over the reported lift, so its stored route must now name an out-of-service facility',
    );
  }

  // (b) The operator reports the other lift. Same booking, and this time
  // nothing its route names has left service.
  {
    const harness = createHarness();
    const booked = await bookEastLiftRoute(harness, 'outage-on-another-lift');
    const before = harness.store.snapshot();

    await toolNamed(harness.operator, 'report_facility_outage').execute({
      facilityId: 'garden-lift',
      reasonCode: 'LIFT_DOOR_FAULT',
    });

    const after = harness.store.snapshot();
    assert.ok(
      after.resourceVersion > before.resourceVersion,
      'the outage never took effect, so this case would prove nothing',
    );
    assert.equal(
      after.resources['garden-lift'].status,
      'OUT_OF_SERVICE',
      'the reported lift is still in service; this case is not testing what it claims',
    );
    assert.deepStrictEqual(after.booking, booked, 'an outage on another lift cancelled or rewrote the booking record');

    const named = facilitiesNamedByRoute(after, after.booking);
    assert.ok(named.length > 0, 'the booking names no facility at all; the status check below would be vacuous');
    assert.deepEqual(
      named.map((facility) => `${facility.id}:${facility.status}`),
      ['east-lift:OPERATIONAL'],
      'the booking is over another lift, so every facility its route names must still be operational',
    );
  }

  // And the sentence itself. Behaviour alone would stay green if the false
  // wording came back, because the wording is what was wrong, not the store.
  const { operator } = createHarness();
  assert.equal(
    /though the lift named in its route is now unavailable/i.test(toolNamed(operator, 'report_facility_outage').description),
    false,
    'the description states of every outage what is only true when the booking uses the reported lift',
  );
});

test('operator write tools repaint the page before claiming a booking-impact warning is visible', async () => {
  const harness = createHarness();
  const booking = await bookEastLiftRoute(harness, 'operator-write-repaint');

  const beforeOutageRefreshes = harness.refreshCount();
  const outage = JSON.parse(await toolNamed(harness.operator, 'report_facility_outage').execute({
    facilityId: 'east-lift',
    reasonCode: 'LIFT_DOOR_FAULT',
  }));
  assert.equal(harness.refreshCount() - beforeOutageRefreshes, 1, 'outage returned before repainting the page');
  assert.equal(harness.lastRefreshedState().resources['east-lift'].status, 'OUT_OF_SERVICE');
  assert.equal(outage.bookingImpact.bookingReference, booking.receipt);
  assert.equal(outage.bookingImpact.pageWarningVisible, true);
  assert.equal(outage.bookingImpact.bookingStillStands, true);

  const beforeRestoreRefreshes = harness.refreshCount();
  const restored = JSON.parse(await toolNamed(harness.operator, 'restore_facility').execute({ facilityId: 'east-lift' }));
  assert.equal(harness.refreshCount() - beforeRestoreRefreshes, 1, 'restore returned before clearing the page warning');
  assert.equal(harness.lastRefreshedState().resources['east-lift'].status, 'OPERATIONAL');
  assert.equal(restored.bookingImpact, null);
  assert.equal(harness.store.snapshot().booking.receipt, booking.receipt, 'restore deleted the confirmed booking');
});
