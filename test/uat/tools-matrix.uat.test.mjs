/**
 * Acceptance suite: the WebMCP tool surface, every tool against every phase.
 *
 * Real defects were found by using the deployed app, and none of them failed a
 * test because no test looked at the whole surface at once. This file looks at
 * all of it: for each of the seven page states it pins the exact registered
 * tool names and the read/write split, then runs every registered tool for real
 * against a store-backed harness and checks what comes back against what the
 * tool's own description promises an agent it will get.
 *
 * Nothing here mocks the domain. The harness routes tool calls into a real
 * createDemoStore, exactly as server.mjs does, so a description that over-
 * promises fails against genuine behaviour rather than against a stub that was
 * written to agree with it.
 *
 * Deterministic: fixed clock, counting id factory, no network, no sleeps.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDemoStore } from '../../lib/domain.mjs';
import {
  TOOL_LIMITS,
  PHASES,
  createVisitorTools,
  createOperatorTools,
  toolsForPhase,
  toolCounts,
} from '../../public/tools.mjs';
import { phaseMatrix } from '../../evals/contract.mjs';

/**
 * Routes tool calls into a real demo store, mirroring server.mjs. Same shape as
 * test/tools.test.mjs, plus a record of every path a tool reached so a call to
 * a confirmation endpoint cannot pass unnoticed.
 */
function createHarness() {
  let counter = 0;
  const store = createDemoStore({
    clock: () => Date.parse('2026-08-30T18:00:00.000Z'),
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

  const refresh = async () => store.snapshot();
  return {
    store,
    calls,
    visitor: createVisitorTools({ api, refresh }),
    operator: createOperatorTools({ api, refresh }),
  };
}

const FULL_REQUIREMENTS = Object.freeze({
  wheelchairWidthCm: 72,
  maxDistanceM: 80,
  stepFree: true,
  companionCount: 1,
  entranceAssistance: true,
  lowStimulus: true,
});

function toolNamed(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `tool ${name} should exist on this surface`);
  return tool;
}

const surfacesOf = (harness) => [['visitor', harness.visitor], ['operator', harness.operator]];

/**
 * The full registered surface, phase by phase, written out rather than derived.
 *
 * A derived expectation cannot catch a deliberate-looking edit to `availableIn`,
 * because it moves with it. These literals are the record of what the demo is
 * documented to offer, so widening or narrowing a phase has to be a conscious
 * edit here as well.
 */
const EXPECTED_VISITOR_MATRIX = Object.freeze({
  READY: {
    // explain_access_refusal joined READY deliberately. With both lifts out the
    // first search refuses without opening a plan and the phase stays here, so
    // this was the one state where the tool named for a refusal was absent at
    // the exact moment a refusal happened.
    read: 5,
    write: 1,
    names: [
      'check_access_route',
      'explain_access_refusal',
      'find_access_bundle',
      'get_access_bundle_status',
      'get_event_access_state',
      'list_access_options',
    ],
  },
  PLAN_READY: {
    read: 4,
    write: 2,
    names: [
      'check_access_route',
      'clear_access_plan',
      'get_access_bundle_status',
      'get_event_access_state',
      'list_access_options',
      'stage_access_bundle',
    ],
  },
  AWAITING_HUMAN_CONFIRMATION: {
    read: 4,
    write: 1,
    names: [
      'check_access_route',
      'clear_access_plan',
      'get_access_bundle_status',
      'get_event_access_state',
      'list_access_options',
    ],
  },
  PLAN_STALE: {
    read: 5,
    write: 1,
    names: [
      'check_access_route',
      'explain_access_refusal',
      'get_access_bundle_status',
      'get_event_access_state',
      'list_access_options',
      'replan_access_bundle',
    ],
  },
  REPLAN_READY: {
    read: 4,
    write: 1,
    names: [
      'check_access_route',
      'clear_access_plan',
      'get_access_bundle_status',
      'get_event_access_state',
      'list_access_options',
    ],
  },
  NO_ALTERNATIVE: {
    read: 5,
    write: 1,
    names: [
      'check_access_route',
      'clear_access_plan',
      'explain_access_refusal',
      'get_access_bundle_status',
      'get_event_access_state',
      'list_access_options',
    ],
  },
  CONFIRMED: {
    read: 4,
    write: 0,
    names: [
      'check_access_route',
      'get_access_bundle_status',
      'get_event_access_state',
      'list_access_options',
    ],
  },
});

const EXPECTED_OPERATOR_ROW = Object.freeze({
  read: 1,
  write: 2,
  names: ['get_facility_status', 'report_facility_outage', 'restore_facility'],
});

/** Inverted index over `availableIn`: a second construction of the same fact. */
function registeredNamesByPhase(tools) {
  const byPhase = new Map(PHASES.map((phase) => [phase, []]));
  for (const tool of tools) {
    for (const phase of tool.availableIn) byPhase.get(phase)?.push(tool.name);
  }
  return byPhase;
}

/**
 * Arguments each tool would accept in the phase the harness is currently in.
 * Returning null for an unknown tool is deliberate: a newly added tool must be
 * given a real input here rather than silently falling back to `{}`, which is
 * how a write tool ends up "exercised" by a refusal that touches nothing.
 */
function workingInput(harness, toolName) {
  const state = harness.store.snapshot();
  const plan = state.activePlan;
  const planId = plan?.id ?? 'plan-that-does-not-exist';
  switch (toolName) {
    case 'get_event_access_state':
    case 'get_access_bundle_status':
    case 'explain_access_refusal':
    case 'get_facility_status':
      return {};
    case 'list_access_options':
    case 'find_access_bundle':
      return { ...FULL_REQUIREMENTS };
    case 'check_access_route':
      return { routeId: 'east-lift-route', ...FULL_REQUIREMENTS };
    case 'stage_access_bundle':
      return { planId, expectedVenueRevision: plan?.basedOnResourceVersion ?? state.resourceVersion };
    case 'replan_access_bundle':
      return { stalePlanId: planId };
    case 'clear_access_plan':
      return { planId };
    case 'report_facility_outage':
      return { facilityId: 'garden-lift', reasonCode: 'SAFETY_INSPECTION' };
    case 'restore_facility':
      return { facilityId: 'garden-lift' };
    default:
      return null;
  }
}

/**
 * Drives a fresh harness into one page state using the real tools and the real
 * store, then proves it arrived. Every phase in this suite is reached this way,
 * so a state machine that stops producing a phase fails here first.
 */
async function harnessInPhase(phase) {
  const harness = createHarness();
  const visitor = (name) => toolNamed(harness.visitor, name);
  const operator = (name) => toolNamed(harness.operator, name);

  if (phase !== 'READY') {
    const found = JSON.parse(await visitor('find_access_bundle').execute({ ...FULL_REQUIREMENTS })).plan;
    assert.ok(found?.id, 'the initial search should produce a plan to drive the later phases from');

    if (phase !== 'PLAN_READY') {
      await visitor('stage_access_bundle').execute({ planId: found.id, expectedVenueRevision: found.basedOnRevision });

      if (phase === 'PLAN_STALE' || phase === 'REPLAN_READY') {
        await operator('report_facility_outage').execute({ facilityId: 'east-lift', reasonCode: 'POWER_FAULT' });
        if (phase === 'REPLAN_READY') {
          await visitor('replan_access_bundle').execute({ stalePlanId: found.id });
        }
      } else if (phase === 'NO_ALTERNATIVE') {
        await operator('report_facility_outage').execute({ facilityId: 'east-lift', reasonCode: 'POWER_FAULT' });
        await operator('report_facility_outage').execute({ facilityId: 'garden-lift', reasonCode: 'POWER_FAULT' });
        await visitor('replan_access_bundle').execute({ stalePlanId: found.id });
      } else if (phase === 'CONFIRMED') {
        // The confirmation is deliberately taken through the store, not a tool:
        // no registered tool is allowed to reach it, which is what the last
        // test in this file asserts.
        const confirmation = harness.store.prepareConfirmation(found.id);
        harness.store.commitBundle({
          planId: found.id,
          confirmationId: confirmation.confirmationId,
          expectedResourceVersion: confirmation.expectedResourceVersion,
          accepted: true,
          requestId: `uat-${phase.toLowerCase()}`,
        });
      }
    }
  }

  assert.equal(
    harness.store.snapshot().phase,
    phase,
    `the harness did not reach ${phase}; the rest of this test would be checking the wrong page state`,
  );
  return harness;
}

describe('the registered tool surface, phase by phase', () => {
  test('a phase offers exactly the tools that name it, and its read count is the number annotated read-only', () => {
    // Both helpers first against a hand-written list. Every other assertion in
    // this file reads the surface through them, so if the phase filter inverted
    // or the read/write split swapped, the failure should say that plainly
    // instead of surfacing as a mysteriously wrong matrix three tests later.
    const sample = [
      { name: 'reader', annotations: { readOnlyHint: true }, availableIn: ['READY'] },
      { name: 'writer', annotations: { readOnlyHint: false }, availableIn: ['READY', 'CONFIRMED'] },
      { name: 'late_writer', annotations: { readOnlyHint: false }, availableIn: ['CONFIRMED'] },
    ];
    assert.deepEqual(toolsForPhase(sample, 'READY').map((tool) => tool.name), ['reader', 'writer']);
    assert.deepEqual(toolsForPhase(sample, 'PLAN_STALE'), [], 'a phase no tool names must offer nothing');
    assert.deepEqual(toolCounts(sample), { total: 3, read: 1, write: 2 });

    const harness = createHarness();
    assert.equal(PHASES.length, 7, 'this suite claims to cover seven page states');

    for (const [surface, tools] of surfacesOf(harness)) {
      const byPhase = registeredNamesByPhase(tools);
      for (const phase of PHASES) {
        const registered = toolsForPhase(tools, phase);
        assert.deepEqual(
          registered.map((tool) => tool.name).sort(),
          [...byPhase.get(phase)].sort(),
          `${surface} registration in ${phase} disagrees with the tools' own availableIn lists`,
        );

        const counts = toolCounts(registered);
        assert.equal(counts.total, registered.length, `${surface} ${phase}: total is not the number of registered tools`);
        assert.equal(counts.read + counts.write, counts.total, `${surface} ${phase}: reads and writes do not add up to the total`);
        assert.equal(
          counts.read,
          registered.filter((tool) => tool.annotations.readOnlyHint === true).length,
          `${surface} ${phase}: the read count does not match the tools annotated read-only`,
        );
      }
    }
  });

  test('the visitor surface registers these exact tools, reads and writes, in each of the seven phases', () => {
    const { visitor } = createHarness();
    assert.deepEqual(Object.keys(EXPECTED_VISITOR_MATRIX).sort(), [...PHASES].sort(), 'the expected matrix does not cover every phase');

    for (const phase of PHASES) {
      const expected = EXPECTED_VISITOR_MATRIX[phase];
      const registered = toolsForPhase(visitor, phase);
      assert.deepEqual(
        registered.map((tool) => tool.name).sort(),
        expected.names,
        `the visitor tools registered in ${phase} changed; confirm the new set is intended and update this list`,
      );
      assert.deepEqual(
        toolCounts(registered),
        { total: expected.names.length, read: expected.read, write: expected.write },
        `the read/write split in ${phase} changed`,
      );
    }

    // The same numbers as the published eval prints, from the eval's own helper.
    const rows = phaseMatrix(visitor);
    assert.deepEqual(rows.map((row) => row.phase), [...PHASES]);
    for (const row of rows) {
      const expected = EXPECTED_VISITOR_MATRIX[row.phase];
      assert.equal(row.read, expected.read, `the eval matrix reports a different read count for ${row.phase}`);
      assert.equal(row.write, expected.write, `the eval matrix reports a different write count for ${row.phase}`);
      assert.deepEqual([...row.names].sort(), expected.names, `the eval matrix reports different tools for ${row.phase}`);
    }
  });

  test('the operator surface registers the same one read and two writes in every phase', () => {
    const { operator } = createHarness();
    for (const phase of PHASES) {
      const registered = toolsForPhase(operator, phase);
      assert.deepEqual(
        registered.map((tool) => tool.name).sort(),
        EXPECTED_OPERATOR_ROW.names,
        `the operator tools registered in ${phase} changed`,
      );
      assert.deepEqual(
        toolCounts(registered),
        { total: EXPECTED_OPERATOR_ROW.names.length, read: EXPECTED_OPERATOR_ROW.read, write: EXPECTED_OPERATOR_ROW.write },
        `the operator read/write split in ${phase} changed`,
      );
    }

    // The operator page can switch either lift, in any phase. This is the
    // assertion that a surface which can only reach one of the two fails.
    const outage = toolNamed(operator, 'report_facility_outage');
    const restore = toolNamed(operator, 'restore_facility');
    assert.deepEqual(outage.inputSchema.properties.facilityId.enum, ['east-lift', 'garden-lift']);
    assert.deepEqual(restore.inputSchema.properties.facilityId.enum, ['east-lift', 'garden-lift']);
  });
});

describe('every registered tool, run for real in every phase that registers it', () => {
  test('every visitor tool offered in a phase actually works there, and answers inside the output budget', async () => {
    // The dead-end defect in one assertion: a tool the page offers in a phase it
    // cannot succeed in leaves the agent holding a refusal and no way forward.
    let executions = 0;
    for (const phase of PHASES) {
      for (const registered of toolsForPhase(createHarness().visitor, phase)) {
        // A fresh harness per tool: a write tool must not change the phase the
        // next tool in the list is supposed to be tested in.
        const harness = await harnessInPhase(phase);
        const tool = toolNamed(harness.visitor, registered.name);
        const input = workingInput(harness, tool.name);
        assert.notEqual(input, null, `visitor tool ${tool.name} has no working input here; add one so this test really calls it`);

        const result = await tool.execute(input);
        assert.equal(typeof result, 'string', `${tool.name} in ${phase} returned ${typeof result}, not a JSON string`);
        assert.ok(
          result.length <= TOOL_LIMITS.outputChars,
          `${tool.name} in ${phase} returned ${result.length} characters, over the ${TOOL_LIMITS.outputChars} budget`,
        );
        const parsed = JSON.parse(result);
        assert.equal(typeof parsed, 'object', `${tool.name} in ${phase} did not return a JSON object`);
        assert.notEqual(parsed, null, `${tool.name} in ${phase} returned JSON null`);
        assert.notEqual(
          parsed.ok,
          false,
          `${tool.name} is offered in ${phase} but refused there with ${parsed.error}: ${parsed.message ?? ''}`,
        );
        assert.notEqual(parsed.truncated, true, `${tool.name} in ${phase} was cut down to the too-large notice, so the agent got no answer`);
        executions += 1;
      }
    }
    assert.equal(executions, 38, 'the number of visitor tool/phase pairs changed; the matrix above says which');
  });

  test('every operator tool offered in a phase actually works there, and answers inside the output budget', async () => {
    let executions = 0;
    for (const phase of PHASES) {
      for (const registered of toolsForPhase(createHarness().operator, phase)) {
        const harness = await harnessInPhase(phase);
        const tool = toolNamed(harness.operator, registered.name);
        const input = workingInput(harness, tool.name);
        assert.notEqual(input, null, `operator tool ${tool.name} has no working input here; add one so this test really calls it`);

        const result = await tool.execute(input);
        assert.equal(typeof result, 'string', `${tool.name} in ${phase} returned ${typeof result}, not a JSON string`);
        assert.ok(
          result.length <= TOOL_LIMITS.outputChars,
          `${tool.name} in ${phase} returned ${result.length} characters, over the ${TOOL_LIMITS.outputChars} budget`,
        );
        const parsed = JSON.parse(result);
        assert.equal(typeof parsed, 'object', `${tool.name} in ${phase} did not return a JSON object`);
        assert.notEqual(parsed, null, `${tool.name} in ${phase} returned JSON null`);
        assert.notEqual(
          parsed.ok,
          false,
          `${tool.name} is offered in ${phase} but refused there with ${parsed.error}: ${parsed.message ?? ''}`,
        );
        assert.notEqual(parsed.truncated, true, `${tool.name} in ${phase} was cut down to the too-large notice, so the agent got no answer`);
        executions += 1;
      }
    }
    assert.equal(executions, 21, 'the number of operator tool/phase pairs changed');
  });

  test('no registered tool on either surface reaches a confirmation endpoint or moves a booking', async () => {
    const CONFIRMATION_PATH = /(prepare-confirmation|confirm|\/commit$)/i;
    const exercised = new Set();

    for (const phase of PHASES) {
      for (const [surface, blueprint] of surfacesOf(createHarness())) {
        for (const registered of toolsForPhase(blueprint, phase)) {
          const harness = await harnessInPhase(phase);
          const tool = toolNamed(surface === 'visitor' ? harness.visitor : harness.operator, registered.name);
          const bookingBefore = harness.store.snapshot().booking?.receipt ?? null;
          const before = harness.calls.length;

          const input = workingInput(harness, tool.name);
          // A null input would be refused before the tool touched anything, and
          // this test would then pass by never having run it.
          assert.notEqual(input, null, `${surface} tool ${tool.name} has no working input here, so this check would prove nothing`);
          await tool.execute(input);
          exercised.add(`${surface}:${tool.name}`);

          for (const call of harness.calls.slice(before)) {
            assert.equal(
              CONFIRMATION_PATH.test(call.path),
              false,
              `${surface} tool ${tool.name} reached ${call.path} while registered in ${phase}`,
            );
          }
          assert.equal(
            harness.store.snapshot().booking?.receipt ?? null,
            bookingBefore,
            `${surface} tool ${tool.name} changed the booking while registered in ${phase}`,
          );
        }
      }
    }

    // Every tool on both surfaces really was driven, so the loop above is not
    // quietly passing over an untested one.
    assert.deepEqual(
      [...exercised].sort(),
      [
        'operator:get_facility_status',
        'operator:report_facility_outage',
        'operator:restore_facility',
        'visitor:check_access_route',
        'visitor:clear_access_plan',
        'visitor:explain_access_refusal',
        'visitor:find_access_bundle',
        'visitor:get_access_bundle_status',
        'visitor:get_event_access_state',
        'visitor:list_access_options',
        'visitor:replan_access_bundle',
        'visitor:stage_access_bundle',
      ],
      'the set of tools this test drove changed',
    );
  });
});

describe('what a tool description promises an agent', () => {
  test('every tool description is between 40 and 500 characters', () => {
    const harness = createHarness();
    for (const [surface, tools] of surfacesOf(harness)) {
      for (const tool of tools) {
        const length = tool.description?.length ?? 0;
        assert.ok(length >= 40, `${surface}:${tool.name} has a ${length}-character description; say what it does and when to use it`);
        assert.ok(
          length <= TOOL_LIMITS.descriptionChars,
          `${surface}:${tool.name} has a ${length}-character description, over the ${TOOL_LIMITS.descriptionChars} limit`,
        );
      }
    }
  });

  test('no two tools share a description, across both surfaces', () => {
    const harness = createHarness();
    const byDescription = new Map();
    for (const [surface, tools] of surfacesOf(harness)) {
      for (const tool of tools) {
        const previous = byDescription.get(tool.description);
        assert.equal(
          previous,
          undefined,
          `${surface}:${tool.name} is worded exactly like ${previous}; an agent cannot tell them apart`,
        );
        byDescription.set(tool.description, `${surface}:${tool.name}`);
      }
    }
    assert.equal(byDescription.size, 12, 'the number of tools changed; check the new one has its own wording');
  });

  test('every field a description promises is present in a real result', async () => {
    // One phase per tool where it is registered and can actually do its job,
    // plus the keys its wording commits to. A tool with no entry fails, so a new
    // description has to state what it promises before this suite will pass.
    const PROMISED = {
      get_event_access_state: { surface: 'visitor', phase: 'READY', keys: ['phase', 'venueRevision', 'facilities', 'reservedResourceCount'] },
      get_access_bundle_status: { surface: 'visitor', phase: 'CONFIRMED', keys: ['phase', 'venueRevision', 'plan', 'booking'] },
      list_access_options: { surface: 'visitor', phase: 'READY', keys: ['venueRevision', 'feasibleCount', 'options'] },
      check_access_route: { surface: 'visitor', phase: 'READY', keys: ['routeId', 'label', 'feasible', 'venueRevision', 'checks'] },
      explain_access_refusal: {
        surface: 'visitor',
        phase: 'PLAN_STALE',
        keys: ['blocked', 'errorCode', 'planRevision', 'venueRevision', 'brokenRules', 'partialReservations', 'validOptionsNow', 'nextAction'],
      },
      find_access_bundle: { surface: 'visitor', phase: 'READY', keys: ['phase', 'venueRevision', 'plan', 'booking'] },
      stage_access_bundle: { surface: 'visitor', phase: 'PLAN_READY', keys: ['phase', 'venueRevision', 'plan', 'booking'] },
      replan_access_bundle: { surface: 'visitor', phase: 'PLAN_STALE', keys: ['phase', 'venueRevision', 'plan', 'booking'] },
      clear_access_plan: { surface: 'visitor', phase: 'PLAN_READY', keys: ['phase', 'venueRevision', 'bookingCreated', 'nextAction'] },
      get_facility_status: { surface: 'operator', phase: 'READY', keys: ['venueRevision', 'facilities'] },
      report_facility_outage: { surface: 'operator', phase: 'READY', keys: ['venueRevision', 'facility', 'status'] },
      restore_facility: { surface: 'operator', phase: 'READY', keys: ['venueRevision', 'facility', 'status'] },
    };

    const blueprint = createHarness();
    for (const [surface, tools] of surfacesOf(blueprint)) {
      for (const tool of tools) {
        assert.ok(Object.hasOwn(PROMISED, tool.name), `${surface}:${tool.name} has no promised-field entry; add what its description commits to`);
        assert.equal(PROMISED[tool.name].surface, surface, `${tool.name} is listed under the wrong surface`);
      }
    }

    for (const [name, { surface, phase, keys }] of Object.entries(PROMISED)) {
      const harness = await harnessInPhase(phase);
      const tool = toolNamed(surface === 'visitor' ? harness.visitor : harness.operator, name);
      assert.ok(tool.availableIn.includes(phase), `${name} is not registered in ${phase}, so this check would prove nothing`);

      const parsed = JSON.parse(await tool.execute(workingInput(harness, name)));
      assert.notEqual(parsed.ok, false, `${name} refused in ${phase}: ${parsed.message ?? ''}`);
      for (const key of keys) {
        assert.ok(Object.hasOwn(parsed, key), `${name} promises "${key}" in its description but the result has no such field`);
      }
    }
  });

  test('both facility readers list exactly the FACILITY resources, and every one of them is a lift', async () => {
    // Two descriptions promise lifts: get_event_access_state says "the status of
    // every lift" and get_facility_status says "every lift the venue operates".
    // Both are implemented as a kind === 'FACILITY' filter, so the promise holds
    // only while every FACILITY is a lift and no lift is stored as another kind.
    const harness = await harnessInPhase('READY');
    await toolNamed(harness.operator, 'report_facility_outage').execute({ facilityId: 'garden-lift', reasonCode: 'SAFETY_INSPECTION' });

    const resources = Object.values(harness.store.snapshot().resources);
    const facilities = resources.filter((resource) => resource.kind === 'FACILITY');
    const expectedIds = facilities.map((resource) => resource.id).sort();
    assert.ok(expectedIds.length >= 2, 'the venue should operate at least two facilities for this to mean anything');

    for (const reader of [
      ['visitor', toolNamed(harness.visitor, 'get_event_access_state')],
      ['operator', toolNamed(harness.operator, 'get_facility_status')],
    ]) {
      const [surface, tool] = reader;
      const parsed = JSON.parse(await tool.execute({}));
      assert.deepEqual(
        parsed.facilities.map((facility) => facility.id).sort(),
        expectedIds,
        `${surface}:${tool.name} does not report exactly the FACILITY resources`,
      );

      for (const facility of parsed.facilities) {
        assert.ok(/lift/i.test(facility.label), `${tool.name} calls ${facility.id} a lift, but its label is "${facility.label}"`);
        assert.equal(typeof facility.status, 'string', `${tool.name} reports no status for ${facility.id}`);
      }

      // The live status, not a cached one: the lift taken out of service above
      // must be reported out of service here.
      const garden = parsed.facilities.find((facility) => facility.id === 'garden-lift');
      assert.equal(garden.status, 'OUT_OF_SERVICE', `${tool.name} reports a stale status for garden-lift`);

      // And nothing that is not a facility leaks into a list described as lifts.
      const nonFacilityIds = resources.filter((resource) => resource.kind !== 'FACILITY').map((resource) => resource.id);
      assert.ok(nonFacilityIds.length > 0, 'the venue should hold non-facility resources for this to mean anything');
      for (const id of nonFacilityIds) {
        assert.equal(
          parsed.facilities.some((facility) => facility.id === id),
          false,
          `${tool.name} lists ${id}, which is not a facility`,
        );
      }
    }
  });

  test('a refusal caused only by a revision change reports no broken rule, exactly as the description says', async () => {
    // explain_access_refusal promises: "A refusal caused only by a revision
    // change has no failed rule to report." Taking the other lift out of service
    // moves the venue revision and invalidates this plan without breaking a
    // single rule on its own route. If brokenRules were filled in anyway, the
    // agent would be told a rule failed that an operator could not act on.
    const harness = await harnessInPhase('AWAITING_HUMAN_CONFIRMATION');
    const planned = JSON.parse(await toolNamed(harness.visitor, 'get_access_bundle_status').execute({}));
    assert.equal(planned.plan.route.at(0), 'East Entrance', 'this check assumes the plan runs over the east lift');

    await toolNamed(harness.operator, 'report_facility_outage').execute({ facilityId: 'garden-lift', reasonCode: 'SAFETY_INSPECTION' });
    assert.equal(harness.store.snapshot().phase, 'PLAN_STALE', 'an unrelated outage should still invalidate the open plan');

    const explanation = JSON.parse(await toolNamed(harness.visitor, 'explain_access_refusal').execute({}));
    assert.equal(explanation.blocked, true);
    assert.equal(explanation.errorCode, 'STALE_RESOURCE_VERSION');
    assert.deepEqual(explanation.brokenRules, [], 'a revision-only refusal reported a failed rule');
    assert.ok(explanation.planRevision < explanation.venueRevision, 'a revision-only refusal must show the revision that moved');
    assert.equal(explanation.partialReservations, 0);
    assert.deepEqual(explanation.validOptionsNow.map((option) => option.routeId), ['east-lift-route']);
    assert.equal(explanation.nextAction, 'REPLAN');

    // The contrast case, so the empty list above is not just this tool never
    // reporting rules: a refusal that really has a broken rule reports it.
    const other = await harnessInPhase('PLAN_STALE');
    const broken = JSON.parse(await toolNamed(other.visitor, 'explain_access_refusal').execute({}));
    assert.deepEqual(broken.brokenRules.map((rule) => rule.rule), ['LIFT_OPERATIONAL']);
  });

  test('the route readers report a pass or fail for every rule their descriptions name', async () => {
    // check_access_route promises "a pass or fail for each rule, such as
    // step-free travel, doorway width, lift status and companion seat
    // availability"; list_access_options promises "for the others exactly which
    // rule fails". Both are checked against a venue where one lift is down.
    const harness = await harnessInPhase('READY');
    await toolNamed(harness.operator, 'report_facility_outage').execute({ facilityId: 'east-lift', reasonCode: 'LIFT_DOOR_FAULT' });

    const checked = JSON.parse(await toolNamed(harness.visitor, 'check_access_route').execute({
      routeId: 'east-lift-route',
      ...FULL_REQUIREMENTS,
    }));
    assert.equal(checked.feasible, false);
    for (const check of checked.checks) {
      assert.equal(typeof check.ok, 'boolean', `${check.rule} came back without a pass or fail`);
      assert.ok(check.detail?.length > 0, `${check.rule} came back without a reason`);
    }
    for (const rule of ['STEP_FREE', 'DOORWAY_WIDTH', 'LIFT_OPERATIONAL', 'COMPANION_SEAT']) {
      assert.ok(checked.checks.some((check) => check.rule === rule), `check_access_route names ${rule} in its description but did not report it`);
    }
    assert.deepEqual(checked.checks.filter((check) => !check.ok).map((check) => check.rule), ['LIFT_OPERATIONAL']);

    const listed = JSON.parse(await toolNamed(harness.visitor, 'list_access_options').execute({ ...FULL_REQUIREMENTS }));
    assert.equal(listed.feasibleCount, 1);
    const blocked = listed.options.find((option) => option.routeId === 'east-lift-route');
    const working = listed.options.find((option) => option.routeId === 'garden-lift-route');
    assert.equal(blocked.feasible, false);
    assert.deepEqual(blocked.blockedBy, ['LIFT_OPERATIONAL'], 'a blocked route must say exactly which rule failed');
    assert.ok(blocked.reasons.length > 0, 'a blocked route must say why');
    assert.equal(working.feasible, true);
    assert.equal(Object.hasOwn(working, 'blockedBy'), false, 'a route that works must not carry a blocking reason');
  });

  test('find_access_bundle reserves nothing and books nothing, as its description says', async () => {
    const harness = await harnessInPhase('READY');
    const before = harness.store.snapshot();

    const found = JSON.parse(await toolNamed(harness.visitor, 'find_access_bundle').execute({ ...FULL_REQUIREMENTS }));
    assert.equal(found.phase, 'PLAN_READY');
    assert.ok(found.plan.id, 'the search should return a plan');
    assert.equal(found.plan.requiresHumanConfirmation, true);

    const after = harness.store.snapshot();
    assert.equal(after.booking, null, 'the search created a booking');
    assert.equal(after.atomicity.reservedResourceCount, 0, 'the search reserved a resource');
    assert.equal(after.atomicity.bookingCount, 0);
    assert.deepEqual(
      Object.values(after.resources).map((resource) => [resource.id, resource.status]),
      Object.values(before.resources).map((resource) => [resource.id, resource.status]),
      'the search changed the status of a venue resource',
    );
    assert.equal(after.resourceVersion, before.resourceVersion, 'planning is not a venue change and must not move the revision');
  });

  test('stage_access_bundle fails on a revision that moved on, and still reserves nothing', async () => {
    const harness = await harnessInPhase('PLAN_READY');
    const planId = harness.store.snapshot().activePlan.id;

    // The description says it "Fails when the venue revision moved on", and the
    // agent needs to be told to replan rather than retry.
    const mismatched = JSON.parse(await toolNamed(harness.visitor, 'stage_access_bundle').execute({
      planId,
      expectedVenueRevision: 999,
    }));
    // A number the agent invented is its own arithmetic, not a venue change.
    // This asserted STALE_RESOURCE_VERSION, which reported two identical
    // revisions and advised a replan that was itself refused.
    assert.equal(mismatched.ok, false);
    assert.equal(mismatched.error, 'EXPECTED_RESOURCE_VERSION_MISMATCH');
    assert.equal(mismatched.nextAction, 'RETRY_WITH_THE_VENUE_REVISION');
    assert.equal(mismatched.venueRevision, harness.store.snapshot().resourceVersion);

    // And when the venue really does move under an open plan, staging it is
    // refused too. The refusal reaches the agent as a readable result rather
    // than a thrown error, which a browser would report as an opaque failure.
    await toolNamed(harness.operator, 'report_facility_outage').execute({ facilityId: 'garden-lift', reasonCode: 'POWER_FAULT' });
    const afterChange = JSON.parse(await toolNamed(harness.visitor, 'stage_access_bundle').execute({
      planId,
      expectedVenueRevision: harness.store.snapshot().resourceVersion,
    }));
    assert.equal(afterChange.ok, false);
    // Asserting the behaviour as it is: the plan was already marked stale by the
    // outage, so the refusal names the plan status rather than the revision.
    // This asked for the deliberate edit and here it is: the agent used to be
    // sent to re-read, which tells it nothing it did not already know. The
    // action is computed from what the plan became - stale, so replan.
    assert.equal(afterChange.error, 'PLAN_NOT_STAGEABLE');
    assert.equal(afterChange.nextAction, 'REPLAN');
    assert.equal(afterChange.planStatus, 'STALE', 'the refusal should say what the plan became');

    const state = harness.store.snapshot();
    assert.equal(state.booking, null, 'a refused staging issued a ticket');
    assert.equal(state.atomicity.reservedResourceCount, 0, 'a refused staging reserved a seat');
  });

  test('replan_access_bundle keeps the same requirements and moves to the lift that still works', async () => {
    const harness = await harnessInPhase('PLAN_STALE');
    const stalePlanId = harness.store.snapshot().activePlan.id;

    const replanned = JSON.parse(await toolNamed(harness.visitor, 'replan_access_bundle').execute({ stalePlanId }));
    assert.equal(replanned.phase, 'REPLAN_READY');
    assert.equal(replanned.plan.kind, 'REPLACEMENT');
    assert.notEqual(replanned.plan.id, stalePlanId, 'the replacement should be a new plan');
    assert.equal(replanned.plan.route.at(0), 'Garden Entrance', 'the replacement should route over the lift that still works');
    assert.equal(replanned.booking, null, 'replanning is not a booking');

    // "keeping the same requirements" - the whole point of the tool.
    assert.deepEqual(
      harness.store.snapshot().activePlan.requirements,
      { ...FULL_REQUIREMENTS },
      'the replacement plan was built against different requirements from the one it replaces',
    );
    assert.equal(harness.store.snapshot().atomicity.reservedResourceCount, 0);
  });

  test('clear_access_plan reports that no booking was created and refuses to touch a confirmed one', async () => {
    const open = await harnessInPhase('PLAN_READY');
    const planId = open.store.snapshot().activePlan.id;
    const cleared = JSON.parse(await toolNamed(open.visitor, 'clear_access_plan').execute({ planId }));
    assert.equal(cleared.bookingCreated, false);
    assert.equal(cleared.phase, 'READY');
    assert.equal(cleared.nextAction, 'ASK_VISITOR_FOR_NEW_REQUIREMENTS');
    assert.equal(open.store.snapshot().activePlan, null, 'the plan should be gone so requirements are editable again');
    assert.equal(open.store.snapshot().booking, null);

    // "never affects an existing booking": the tool is not registered once a
    // booking exists, and calling it anyway is refused rather than obeyed.
    const confirmed = await harnessInPhase('CONFIRMED');
    const tool = toolNamed(confirmed.visitor, 'clear_access_plan');
    assert.equal(tool.availableIn.includes('CONFIRMED'), false, 'clear_access_plan must not be registered after confirmation');

    const before = confirmed.store.snapshot();
    const refused = JSON.parse(await tool.execute({ planId: before.activePlan.id }));
    assert.equal(refused.ok, false);
    assert.equal(refused.error, 'PLAN_ALREADY_COMMITTED');
    assert.equal(refused.nextAction, 'READ_THE_BOOKING_INSTEAD');
    assert.equal(confirmed.store.snapshot().booking.receipt, before.booking.receipt, 'the booking was rewritten');
    assert.equal(confirmed.store.snapshot().atomicity.reservedResourceCount, 3, 'the confirmed reservations were released');
  });

  test('reporting an outage that is already in force leaves the venue revision where it was', async () => {
    const harness = await harnessInPhase('READY');
    const outage = toolNamed(harness.operator, 'report_facility_outage');
    const startingRevision = harness.store.snapshot().resourceVersion;

    const first = JSON.parse(await outage.execute({ facilityId: 'east-lift', reasonCode: 'LIFT_DOOR_FAULT' }));
    assert.equal(first.status, 'OUT_OF_SERVICE');
    assert.equal(first.venueRevision, startingRevision + 1, 'a real outage must advance the revision');

    const repeat = JSON.parse(await outage.execute({ facilityId: 'east-lift', reasonCode: 'POWER_FAULT' }));
    assert.equal(repeat.status, 'OUT_OF_SERVICE');
    assert.equal(repeat.venueRevision, first.venueRevision, 'reporting an outage already in force moved the revision');
    assert.equal(harness.store.snapshot().resourceVersion, first.venueRevision);
  });

  test('restoring a lift that is already in service leaves the venue revision where it was', async () => {
    const harness = await harnessInPhase('READY');
    const restore = toolNamed(harness.operator, 'restore_facility');
    const startingRevision = harness.store.snapshot().resourceVersion;

    const noop = JSON.parse(await restore.execute({ facilityId: 'east-lift' }));
    assert.equal(noop.status, 'OPERATIONAL');
    assert.equal(noop.venueRevision, startingRevision, 'restoring a working lift moved the revision');

    await toolNamed(harness.operator, 'report_facility_outage').execute({ facilityId: 'east-lift', reasonCode: 'SAFETY_INSPECTION' });
    const restored = JSON.parse(await restore.execute({ facilityId: 'east-lift' }));
    assert.equal(restored.status, 'OPERATIONAL');
    assert.equal(restored.venueRevision, startingRevision + 2, 'a real restoration must advance the revision');
  });
});
