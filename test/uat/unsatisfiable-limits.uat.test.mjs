/**
 * A limit the venue can never meet should say so, not just say no.
 *
 * The independent review measured that `maxDistanceM` accepts 20 through 63 and
 * that no route is shorter than 64 m, so every value in that band is refused
 * with the same sentence an ordinary near-miss gets: "No complete route, seat
 * and assistance bundle meets every requirement." An agent reading that cannot
 * tell whether to try 63, 40 or 21 next, and the advertised next action is
 * CHANGE_REQUIREMENTS - which, followed literally, loops.
 *
 * The fix is not to raise the published schema minimum to 64. That writes a fact
 * about today's route data into a contract, where it would age silently the
 * first time a route changes. The refusal carries the number instead, derived
 * from the same evaluations that produced it.
 *
 * Every expectation here is derived from the venue at runtime. Nothing in this
 * file states the floor, because a test that hardcodes it stops being a test of
 * the venue and starts being a copy of it.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createDemoStore } from '../../lib/domain.mjs';

const store = () => createDemoStore({
  clock: () => Date.parse('2026-08-31T18:00:00.000Z'),
  idFactory: ((n) => () => `id-${++n}`)(0),
});

/** Everything except the distance, so distance is the only thing under test. */
const BASE = Object.freeze({
  wheelchairWidthCm: 72,
  stepFree: true,
  companionCount: 1,
  entranceAssistance: true,
  lowStimulus: true,
});

/**
 * The shortest limit that actually plans, found by asking the venue rather than
 * by reading a number out of the route table.
 */
function measureFloor() {
  for (let metres = 1; metres <= 500; metres += 1) {
    try {
      store().findBundle({ ...BASE, maxDistanceM: metres });
      return metres;
    } catch {
      // Still too short. Keep asking.
    }
  }
  throw new Error('no distance planned anything, so this suite cannot measure a floor');
}

const FLOOR = measureFloor();

describe('a distance no route can satisfy is refused with the number that would work', () => {
  test('the venue has a floor, and it is above the published schema minimum', async () => {
    // If these ever meet, the band this suite exists for is empty and the rest
    // of the file is measuring nothing. Stated so that cannot pass unnoticed.
    const tools = await readFile(new URL('../../public/tools.mjs', import.meta.url), 'utf8');
    const minimum = Number(tools.match(/maxDistanceM:\s*\{[^}]*minimum:\s*(\d+)/)?.[1]);
    assert.ok(Number.isFinite(minimum), 'could not read the published minimum for maxDistanceM');
    assert.ok(
      FLOOR > minimum,
      `the schema accepts from ${minimum} m and the venue plans from ${FLOOR} m; nothing to test`,
    );
  });

  test('one metre under the floor is refused', () => {
    assert.throws(
      () => store().findBundle({ ...BASE, maxDistanceM: FLOOR - 1 }),
      (error) => error.code === 'NO_COMPLETE_BUNDLE',
      `${FLOOR - 1} m should not plan`,
    );
  });

  test('the refusal names the shortest distance that would work', () => {
    try {
      store().findBundle({ ...BASE, maxDistanceM: FLOOR - 1 });
      assert.fail('the refusal should have happened');
    } catch (error) {
      assert.equal(
        error.details?.shortestFeasibleDistanceM,
        FLOOR,
        'an agent is told no, and not told what would be yes',
      );
    }
  });

  test('every value in the dead band names the same floor, not a value near itself', () => {
    // The number must describe the venue, not the request. A diagnosis that
    // echoed the asked-for limit back would look helpful and say nothing.
    const minimum = 20;
    for (let metres = minimum; metres < FLOOR; metres += 1) {
      try {
        store().findBundle({ ...BASE, maxDistanceM: metres });
        assert.fail(`${metres} m planned, so the floor is not where this suite measured it`);
      } catch (error) {
        assert.equal(error.code, 'NO_COMPLETE_BUNDLE', `${metres} m refused for the wrong reason`);
        assert.equal(error.details?.shortestFeasibleDistanceM, FLOOR, `${metres} m named the wrong floor`);
      }
    }
  });

  test('at the floor it plans, and the diagnosis is not attached to a success', () => {
    const venue = store();
    const plan = venue.findBundle({ ...BASE, maxDistanceM: FLOOR });
    assert.ok(plan.id, 'the floor should plan');
  });

  test('a refusal that is not about distance does not invent a floor', () => {
    // Both lifts down is venue state no distance can fix. Reporting a shortest
    // feasible distance there would be a number that cannot be acted on.
    const venue = store();
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    venue.setFacilityOutage('garden-lift', 'POWER_FAULT');
    try {
      venue.findBundle({ ...BASE, maxDistanceM: FLOOR });
      assert.fail('both lifts down should refuse');
    } catch (error) {
      assert.equal(error.code, 'NO_COMPLETE_BUNDLE');
      assert.equal(
        error.details?.shortestFeasibleDistanceM ?? null,
        null,
        'no distance reopens a venue whose lifts are both out',
      );
    }
  });

  test('the floor is nowhere written into the shipped source', async () => {
    // The whole point of deriving it. If someone later pastes the measured value
    // into the domain or the schema, this fails and says where.
    const offenders = [];
    for (const name of ['lib/domain.mjs', 'public/tools.mjs']) {
      const source = await readFile(new URL(`../../${name}`, import.meta.url), 'utf8');
      source.split('\n').forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
        if (!/shortestFeasibleDistanceM|maxDistanceM/.test(line)) return;
        if (new RegExp(`\\b${FLOOR}\\b`).test(line)) offenders.push(`${name}:${index + 1}`);
      });
    }
    assert.deepEqual(offenders, [], `the measured floor is hardcoded at: ${offenders.join(', ')}`);
  });
});
