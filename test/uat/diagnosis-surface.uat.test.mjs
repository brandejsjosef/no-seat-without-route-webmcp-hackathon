/**
 * A number the venue computes and nobody is allowed to read.
 *
 * `diagnoseNoBundle` works out `shortestFeasibleDistanceM`: the shortest route
 * the venue actually has, which is the one value that turns "no plan" into "ask
 * for 64 m instead of 20". Every surface between that calculation and an agent
 * hand-copied the diagnosis field by field, so the number was computed on every
 * distance-only dead end and reached nobody.
 *
 * The tool that drops it is `explain_access_refusal` - the tool whose entire purpose is
 * telling an agent how to correct itself.
 *
 * public/tools.mjs already carries the comment "Both were computed and then
 * dropped here" about the two fields before it. The same defect, in the same
 * lines, for the third field. So the last test here is not about distance at
 * all: it derives the diagnosis's own field list at runtime and fails if any
 * field does not reach the tool surface, which is the only version of this that
 * cannot happen a fourth time.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDemoStore } from '../../lib/domain.mjs';
import { createVisitorTools } from '../../public/tools.mjs';

/** Both routes are 64 m and 78 m, so a 20 m limit blocks on distance ALONE. */
const TOO_SHORT = Object.freeze({
  wheelchairWidthCm: 72,
  maxDistanceM: 20,
  stepFree: true,
  companionCount: 1,
  entranceAssistance: true,
  lowStimulus: true,
});

function harness() {
  let counter = 0;
  const store = createDemoStore({
    clock: () => Date.parse('2026-09-01T09:00:00.000Z'),
    idFactory: () => `id-${++counter}`,
  });
  async function api(path, options = {}) {
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : {};
    if (method === 'GET' && path === '/api/state') return { ok: true, state: store.snapshot() };
    if (method === 'GET' && path === '/api/explain') return { ok: true, explanation: store.explainRefusal() };
    if (method === 'POST' && path === '/api/plans') {
      const plan = store.findBundle(body.requirements ?? {}, { actor: 'webmcp-agent', toolName: 'find_access_bundle' });
      return { ok: true, plan, state: store.snapshot() };
    }
    throw new Error(`Unrouted call: ${method} ${path}`);
  }
  const tools = createVisitorTools({ api, refresh: async () => store.snapshot() });
  // A misspelled name used to surface as "cannot read properties of undefined",
  // which reads like a product failure and is not one. It says which name it
  // looked for and what exists.
  return {
    store,
    tool: (name) => {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`no visitor tool named ${name}; there are: ${tools.map((entry) => entry.name).join(', ')}`);
      return found;
    },
  };
}

/** The diagnosis as the domain itself produces it, read off a real refusal. */
function domainDiagnosis(store) {
  try {
    store.findBundle(TOO_SHORT);
  } catch (error) {
    return error.details ?? {};
  }
  throw new Error('the venue found a plan: this scenario no longer produces a dead end');
}

describe('the shortest route the venue has reaches the agent asking for it', () => {
  test('the scenario is a distance-only dead end, and the venue does compute the number', () => {
    const { store } = harness();
    const details = domainDiagnosis(store);
    assert.deepEqual(details.blockedBy, ['ROUTE_DISTANCE'], 'this dead end is no longer distance-only');
    assert.equal(details.requirementChangeCanHelp, true);
    assert.equal(details.shortestFeasibleDistanceM, 64, 'the venue stopped computing the number');
  });

  test('explainRefusal carries it', () => {
    const { store } = harness();
    domainDiagnosis(store);
    const explanation = store.explainRefusal();
    assert.equal(explanation.blocked, true);
    assert.equal(
      explanation.shortestFeasibleDistanceM,
      64,
      'the explanation drops the one number that says which value to try',
    );
  });

  test('the explain_access_refusal tool carries it', async () => {
    const { store, tool } = harness();
    domainDiagnosis(store);
    const answer = JSON.parse(await tool('explain_access_refusal').execute({}));
    assert.equal(answer.blocked, true);
    assert.equal(answer.shortestFeasibleDistanceM, 64, 'the self-correction tool drops the value to correct to');
  });

  test('a failed search carries it too', async () => {
    const { tool } = harness();
    // The refusal envelope is flat: ok:false, error carrying the code, and the
    // diagnosis beside it.
    const answer = JSON.parse(await tool('find_access_bundle').execute({ ...TOO_SHORT }));
    assert.equal(answer.ok, false);
    assert.equal(answer.error, 'NO_COMPLETE_BUNDLE');
    assert.equal(answer.shortestFeasibleDistanceM, 64, 'the refusal drops the value to correct to');
  });

  test('a dead end with no distance answer does not invent one', () => {
    // The negative control. The field is absent, not zero and not guessed, when
    // no route could be reopened by any distance a visitor may legally ask for.
    const { store } = harness();
    store.setFacilityOutage('east-lift', 'POWER_FAULT');
    store.setFacilityOutage('garden-lift', 'POWER_FAULT');
    try { store.findBundle({ ...TOO_SHORT, maxDistanceM: 500 }); } catch { /* expected */ }
    assert.equal(
      Object.hasOwn(store.explainRefusal(), 'shortestFeasibleDistanceM'),
      false,
      'a venue-only dead end advertises a distance that would not help',
    );
  });

  test('every field the diagnosis produces reaches the tool surface', async () => {
    // Derived, not listed. Three surfaces hand-copied the diagnosis field by
    // field, so each new field had to be added in four places or it was silently
    // dropped - which is what happened, twice. This compares the domain's own
    // output against what an agent can read, so a fifth field is covered by
    // this test on the day it is written.
    const { store, tool } = harness();
    const produced = domainDiagnosis(store);
    const answer = JSON.parse(await tool('explain_access_refusal').execute({}));
    const missing = Object.keys(produced).filter((key) => !Object.hasOwn(answer, key));
    assert.deepEqual(missing, [], `the diagnosis produces ${missing.join(', ')} and no agent can read it`);
  });
});
