/**
 * Acceptance suite: limits, eviction and restart.
 *
 * A demo that anyone can open from a public link is a shared, long-lived
 * process. Nothing in the happy path notices when a structure inside it grows
 * for every visitor, when one caller can lock everyone else out, or when a
 * deploy quietly loses a confirmed booking. Those failures show up as a slow
 * page, a locked front door and a receipt that stops existing - never as a red
 * test, because no test looked.
 *
 * This file looks. Four claims, in order:
 *
 *  1. The venue's own history is bounded. The audit log stops growing at its
 *     documented limit while its sequence number and the venue revision keep
 *     climbing, so the log is a window and not a ledger that outlives the RAM.
 *  2. Superseded plans and their confirmations are removed, not archived. A
 *     replan/clear loop is the one interaction a visitor can repeat forever, so
 *     it is the one that must leave nothing behind - and a plan identifier that
 *     has been superseded or cleared must be dead, not merely inert.
 *  3. One caller cannot spend the whole process's session budget, and cannot
 *     invent a new identity per request by writing a forwarded header - not by
 *     sending a malformed one, not by sending an untrusted one, and not by
 *     sending the trusted one twice. The numbers asserted here are read out of
 *     server.mjs; the last test in this file fails if any of them moves.
 *  4. Losing the process is a total loss, and an honest one: no booking, no
 *     reservation and no plan comes back, and the identifiers issued by the
 *     dead process are refused rather than applied to the venue that replaced
 *     it.
 *
 * Everything is deterministic: a fixed clock, a counting id factory, and HTTP
 * servers on OS-allocated ports so parallel runs cannot collide.
 *
 * Not covered, and deliberately so: eviction by DEMO_TTL_MS / SESSION_TTL_MS.
 * Both are two hours and neither the clock nor the interval is injectable from
 * outside the module, so a TTL test could only be written by sleeping for two
 * hours or by asserting nothing. The LRU half of the same sweep is covered
 * below, including the session cleanup that runs with it.
 */

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createDemoStore } from '../../lib/domain.mjs';
import { spawnOwnedServer, waitForOwnedServer, freePort } from '../helpers/test-server.mjs';

const repoRoot = new URL('../../', import.meta.url);

/**
 * Read from lib/domain.mjs and server.mjs, not assumed. The final test in this
 * file re-reads both sources and fails if a constant here has drifted from the
 * product, so these numbers cannot age silently into a suite that asserts
 * yesterday's limits.
 */
const AUDIT_LIMIT = 120;
const SESSION_RATE_LIMIT = 40;
const SESSION_RATE_WINDOW_MS = 60_000;
const MAX_DEMOS = 500;

const FIXED_CLOCK = Date.parse('2026-08-30T18:00:00.000Z');

const FULL = Object.freeze({
  wheelchairWidthCm: 72,
  maxDistanceM: 80,
  stepFree: true,
  companionCount: 1,
  entranceAssistance: true,
  lowStimulus: true,
});

/** A store with no wall clock and no randomness in it anywhere. */
function venue() {
  let issued = 0;
  return createDemoStore({
    clock: () => FIXED_CLOCK,
    idFactory: () => `id-${String((issued += 1)).padStart(4, '0')}`,
  });
}

/** Runs `call` and returns the DomainError code, or a marker if it did not throw. */
function refusalCode(call) {
  try {
    call();
    return 'NO_REFUSAL';
  } catch (error) {
    return `${error.code}/${error.status}`;
  }
}

// ---------------------------------------------------------------------------
// HTTP harness. Every server binds a port the OS handed out, so several of
// these can run at once beside the existing suite without colliding.
// ---------------------------------------------------------------------------

function allocatePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startVenueServer(extraEnv = {}) {
  let port = null;
  let origin = null;
  let child = null;

  /**
   * Each launch gets its own status object. A restart kills one child and
   * starts another, and the dead one's `exit` event can arrive after the new
   * one is already running; shared flags would let that stale event be read as
   * the new child having died.
   */
  // Held here, not inside launch(), because waitUntilListening() has to read the
  // token of the launch it is waiting for. A restart replaces it, so the poll
  // can never accept the process it just superseded.
  let launchToken = null;

  // The child environment used to be built here, and in every other suite that
  // spawned a server. Each copy carried the same two hard-won decisions - PORT
  // beats NSWR_PORT inside server.mjs, and Render sets
  // NSWR_TRUST_CF_CONNECTING_IP on the service - and each was free to drift from
  // the others. They live in the shared helper now, proved against real impostor
  // servers rather than by being read. A scenario that WANTS the trust on still
  // passes it through extraEnv, which the helper applies after the reset.
  //
  // This suite keeps its own launch/wait pair rather than calling
  // startTestServer, because a restart scenario has to come back on the SAME
  // port: allocating a new one would be testing something else.
  let handle = null;

  function launch() {
    handle = spawnOwnedServer({ port, extraEnv });
    launchToken = handle.instanceToken;
    child = handle.child;
    return handle;
  }

  async function waitUntilListening() {
    const failure = handle.spawnError();
    if (failure) throw new Error(`server.mjs could not be spawned: ${failure.message}`);
    await waitForOwnedServer(handle, { attempts: 400, interval: 15 });
  }

  async function waitUntilGone() {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      // No startup guard here, deliberately. This function waits for a child
      // this test has just killed, so its exit is the success condition, not a
      // failure - an earlier blanket insertion of the readiness guard put one
      // here and would have thrown on the very outcome being waited for.
      try {
        await fetch(`${origin}/api/health`);
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error(`The server on ${origin} did not stop`);
  }

  /**
   * A port that was free when the probe closed it can be taken before the child
   * binds it - by a sibling suite, or by another agent running this repo at the
   * same time. That race makes the child exit immediately, which is not a fact
   * about the product, so it is retried on a freshly allocated port. Only the
   * port moves; nothing about what the tests then assert changes. After three
   * attempts it gives up loudly rather than pretending a server is running.
   */
  async function bringUp() {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      port = await freePort();
      origin = `http://127.0.0.1:${port}`;
      launch();
      try {
        await waitUntilListening();
        return;
      } catch (error) {
        // Never leave a child that started but never answered holding a port.
        child?.kill();
        child = null;
        lastError = error;
      }
    }
    throw lastError;
  }

  /**
   * `headers` may be an array of [name, value] pairs as well as an object. The
   * array form is the only way to send one header name twice, which is the
   * case the rate limiter's own comment claims it survives.
   */
  const post = (path, body, token, headers = {}) => {
    const merged = new Headers({
      'Content-Type': 'application/json',
      Origin: origin,
      ...(token ? { 'X-Demo-Session': token } : {}),
    });
    for (const [name, value] of Array.isArray(headers) ? headers : Object.entries(headers)) {
      merged.append(name, value);
    }
    return fetch(origin + path, { method: 'POST', headers: merged, body: JSON.stringify(body ?? {}) });
  };

  const stateResponse = (token) => fetch(`${origin}/api/state`, { headers: { 'X-Demo-Session': token } });

  async function state(token) {
    const body = await (await stateResponse(token)).json();
    return body.state;
  }

  /** Session POST with full control over the headers the limiter reads. */
  async function sessionAttempt(headers = {}, body = { role: 'visitor' }) {
    const response = await post('/api/session', body, null, headers);
    const payload = await response.json();
    return { status: response.status, payload };
  }

  async function session(role, demoId, headers = {}) {
    const { status, payload } = await sessionAttempt(headers, { role, ...(demoId ? { demoId } : {}) });
    assert.equal(status, 201, `session refused: ${JSON.stringify(payload)}`);
    return payload.session;
  }

  /** Drives a whole booking, so a venue can be made worth protecting from eviction. */
  async function bookEverything(token, requestId) {
    const created = await (await post('/api/plans', { requirements: FULL }, token)).json();
    assert.ok(created.plan, `plan creation failed: ${JSON.stringify(created)}`);
    const plan = created.plan;
    const staged = await post(
      `/api/plans/${encodeURIComponent(plan.id)}/stage`,
      { expectedResourceVersion: plan.basedOnResourceVersion },
      token,
    );
    assert.equal(staged.status, 200, await staged.text());
    const confirmation = (await (await post(
      `/api/plans/${encodeURIComponent(plan.id)}/prepare-confirmation`,
      {},
      token,
    )).json()).confirmation;
    const committed = await (await post(`/api/plans/${encodeURIComponent(plan.id)}/commit`, {
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
      requestId,
    }, token)).json();
    assert.equal(committed.ok, true, JSON.stringify(committed));
    return { plan, confirmation, booking: committed.result.booking };
  }

  await bringUp();

  return {
    get origin() { return origin; },
    kill: () => child?.kill(),
    async restart() {
      child.kill();
      await waitUntilGone();
      await bringUp();
    },
    post,
    state,
    stateResponse,
    session,
    sessionAttempt,
    bookEverything,
  };
}

/** Fires `count` session requests one after another and reports the statuses. */
async function sessionStatuses(server, count, headersFor) {
  const statuses = [];
  for (let index = 1; index <= count; index += 1) {
    const { status } = await server.sessionAttempt(headersFor(index));
    statuses.push(status);
  }
  return statuses;
}

// ---------------------------------------------------------------------------

describe('the audit log is bounded while the venue keeps counting', () => {
  test('the log stops at its limit but the sequence and the venue revision climb past it', () => {
    const store = venue();

    // 140 operator actions, each of which writes exactly one audit entry.
    const observedLengths = [];
    for (let round = 0; round < 70; round += 1) {
      store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');
      store.restoreFacility('east-lift');
      observedLengths.push(store.snapshot().audit.length);
    }

    const snapshot = store.snapshot();
    assert.equal(
      Math.max(...observedLengths),
      AUDIT_LIMIT,
      'the audit log grew past its limit at some point during the run',
    );
    assert.equal(snapshot.audit.length, AUDIT_LIMIT);

    // The window moved: the oldest entries are gone, not compacted or renumbered.
    assert.equal(snapshot.audit.at(-1).seq, 140, 'the sequence stopped counting when the log stopped growing');
    assert.equal(snapshot.audit[0].seq, 140 - AUDIT_LIMIT + 1);
    for (let index = 1; index < snapshot.audit.length; index += 1) {
      assert.equal(
        snapshot.audit[index].seq,
        snapshot.audit[index - 1].seq + 1,
        `audit sequence jumped at index ${index}`,
      );
    }

    // One entry per action, and one revision per state change, both uncapped.
    assert.equal(snapshot.resourceVersion, 141);
    assert.equal(snapshot.audit.at(-1).action, 'FACILITY_RESTORED');
  });

  test('a demo reset rewinds the audit sequence, so two runs of one venue can issue the same receipt', () => {
    const store = venue();

    const bookOnce = (requestId) => {
      const plan = store.findBundle(FULL);
      store.stageBundle(plan.id, store.snapshot().resourceVersion);
      const confirmation = store.prepareConfirmation(plan.id);
      return store.commitBundle({
        planId: plan.id,
        confirmationId: confirmation.confirmationId,
        expectedResourceVersion: confirmation.expectedResourceVersion,
        accepted: true,
        requestId,
      }).booking;
    };

    const first = bookOnce('run-one');
    store.reset();
    assert.equal(store.snapshot().runId, 'run-002');
    assert.equal(store.snapshot().audit.length, 1);
    assert.equal(store.snapshot().audit[0].seq, 1, 'the audit sequence did not restart at one after a reset');

    const second = bookOnce('run-two');
    store.reset();
    const third = bookOnce('run-three');

    // Three distinct bookings on three ascending venue revisions.
    assert.equal(new Set([first.id, second.id, third.id]).size, 3);
    assert.deepEqual(
      [first.committedResourceVersion, second.committedResourceVersion, third.committedResourceVersion],
      [2, 4, 6],
    );

    // This case used to record the defect, and said in its own comment that it
    // should be rewritten to demand three distinct receipts once the duplicate
    // was fixed. The receipt was derived from the audit sequence and reset()
    // rewinds that sequence, so the number a visitor was shown as their booking
    // reference repeated across runs of one venue: NSWR-00244, NSWR-00245,
    // NSWR-00245. It comes from a private counter outside the venue state now.
    const receipts = [first.receipt, second.receipt, third.receipt];
    for (const receipt of receipts) {
      assert.match(receipt, /^NSWR-\d{5}$/, `${receipt} is not a receipt number`);
    }
    assert.equal(new Set(receipts).size, 3, `two runs of one venue share a receipt: ${receipts.join(', ')}`);
    // Ascending, so uniqueness comes from an allocator rather than a shuffle.
    const numbers = receipts.map((receipt) => Number(receipt.slice(5)));
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), `receipts are not monotonic: ${receipts.join(', ')}`);
  });
});

describe('superseded plans and their confirmations do not pile up', () => {
  test('a replan deletes the plan it superseded rather than keeping it as history', () => {
    const store = venue();
    const original = store.findBundle(FULL);
    store.stageBundle(original.id, 1);
    store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');

    const replacement = store.replanBundle(original.id);
    assert.equal(replacement.supersedesPlanId, original.id);
    assert.equal(replacement.status, 'STAGED');
    assert.notEqual(replacement.id, original.id);

    // NOT_FOUND, not a 409 about a plan in the wrong status: a kept-but-flagged
    // plan would answer 409 here, and would still be in the structure that is
    // deep-cloned on every single request this venue serves.
    assert.equal(refusalCode(() => store.stageBundle(original.id, 2)), 'PLAN_NOT_FOUND/404');
    assert.equal(refusalCode(() => store.replanBundle(original.id)), 'PLAN_NOT_FOUND/404');
    assert.equal(refusalCode(() => store.prepareConfirmation(original.id)), 'PLAN_NOT_FOUND/404');

    // The replacement is the live one and is reachable by its own identifier.
    assert.equal(store.snapshot().activePlan.id, replacement.id);
    assert.equal(store.snapshot().phase, 'REPLAN_READY');
  });

  test('preparing the same confirmation twice hands back the one already prepared', () => {
    const store = venue();
    const plan = store.findBundle(FULL);
    store.stageBundle(plan.id, 1);

    const first = store.prepareConfirmation(plan.id);
    const second = store.prepareConfirmation(plan.id);
    const third = store.prepareConfirmation(plan.id);

    assert.equal(second.confirmationId, first.confirmationId);
    assert.equal(third.confirmationId, first.confirmationId);
    assert.equal(second.expectedResourceVersion, first.expectedResourceVersion);

    // A second and third confirmation object would also mean a second and third
    // audit entry. Three calls, one entry.
    const prepared = store.snapshot().audit.filter((entry) => entry.action === 'HUMAN_CONFIRMATION_PREPARED');
    assert.equal(prepared.length, 1);
  });

  test('a confirmation prepared for a superseded plan cannot book its replacement', () => {
    const store = venue();
    const original = store.findBundle(FULL);
    store.stageBundle(original.id, 1);
    const staleConfirmation = store.prepareConfirmation(original.id);

    store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');
    const replacement = store.replanBundle(original.id);

    assert.equal(refusalCode(() => store.commitBundle({
      planId: replacement.id,
      confirmationId: staleConfirmation.confirmationId,
      expectedResourceVersion: store.snapshot().resourceVersion,
      accepted: true,
      requestId: 'stale-confirmation-replay',
    })), 'INVALID_CONFIRMATION/428');

    // Nothing was booked and nothing was left half-reserved by the attempt.
    const snapshot = store.snapshot();
    assert.equal(snapshot.atomicity.bookingCount, 0);
    assert.equal(snapshot.atomicity.reservedResourceCount, 0);

    // A confirmation prepared for the replacement itself still works, so the
    // refusal above is about the superseded confirmation and not about the
    // replacement being unbookable.
    const fresh = store.prepareConfirmation(replacement.id);
    assert.notEqual(fresh.confirmationId, staleConfirmation.confirmationId);
    const result = store.commitBundle({
      planId: replacement.id,
      confirmationId: fresh.confirmationId,
      expectedResourceVersion: fresh.expectedResourceVersion,
      accepted: true,
      requestId: 'replacement-confirmed',
    });
    assert.equal(result.ok, true);
  });

  test('fifteen replan-and-clear cycles leave no plan alive and a log that stopped growing', () => {
    const store = venue();
    const identifiers = [];
    const auditLengths = [];

    for (let cycle = 0; cycle < 15; cycle += 1) {
      const initial = store.findBundle(FULL);
      store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');
      const afterOutage = store.replanBundle(initial.id);
      store.restoreFacility('east-lift');
      const afterRestore = store.replanBundle(afterOutage.id);
      store.clearPlan(afterRestore.id);

      identifiers.push(initial.id, afterOutage.id, afterRestore.id);
      auditLengths.push(store.snapshot().audit.length);
    }

    const snapshot = store.snapshot();
    assert.equal(identifiers.length, 45);
    assert.equal(new Set(identifiers).size, 45, 'a plan identifier was reused between cycles');

    // Every plan from every cycle is gone, including the ones that were staged
    // and the ones that were only proposed.
    for (const planId of identifiers) {
      assert.equal(
        refusalCode(() => store.stageBundle(planId, snapshot.resourceVersion)),
        'PLAN_NOT_FOUND/404',
        `${planId} outlived its cycle`,
      );
    }

    // Ten audit entries per cycle, so the sequence reached 150 - and the log
    // still holds exactly the last AUDIT_LIMIT of them, having never exceeded it.
    assert.equal(Math.max(...auditLengths), AUDIT_LIMIT);
    assert.equal(snapshot.audit.length, AUDIT_LIMIT);
    assert.equal(snapshot.audit.at(-1).seq, 150);
    assert.equal(snapshot.audit[0].seq, 150 - AUDIT_LIMIT + 1);

    // And the venue is idle again: fifteen cycles of churn left it usable.
    assert.equal(snapshot.phase, 'READY');
    assert.equal(snapshot.activePlan, null);
    assert.equal(snapshot.atomicity.bookingCount, 0);
    assert.equal(snapshot.atomicity.reservedResourceCount, 0);
  });
});

describe('a cleared plan identifier is dead', () => {
  test('every action on a cleared plan is refused as not found', () => {
    const store = venue();
    const plan = store.findBundle(FULL);
    store.stageBundle(plan.id, 1);
    const confirmation = store.prepareConfirmation(plan.id);
    store.clearPlan(plan.id);

    for (const [action, call] of [
      ['stage', () => store.stageBundle(plan.id, 1)],
      ['replan', () => store.replanBundle(plan.id)],
      ['clear again', () => store.clearPlan(plan.id)],
      ['prepare confirmation', () => store.prepareConfirmation(plan.id)],
      ['commit', () => store.commitBundle({
        planId: plan.id,
        confirmationId: confirmation.confirmationId,
        expectedResourceVersion: 1,
        accepted: true,
        requestId: 'commit-a-cleared-plan',
      })],
    ]) {
      assert.equal(refusalCode(call), 'PLAN_NOT_FOUND/404', `${action} on a cleared plan was not refused as not found`);
    }

    // The refused commit booked nothing and reserved nothing.
    const snapshot = store.snapshot();
    assert.equal(snapshot.atomicity.bookingCount, 0);
    assert.equal(snapshot.atomicity.reservedResourceCount, 0);
    assert.equal(snapshot.audit.at(-1).action, 'PLAN_CLEARED');
  });

  test('clearing returns the venue to READY and lets a fresh plan be prepared', () => {
    const store = venue();
    const first = store.findBundle(FULL);
    store.stageBundle(first.id, 1);
    store.clearPlan(first.id);

    const cleared = store.snapshot();
    assert.equal(cleared.phase, 'READY');
    assert.equal(cleared.activePlan, null);
    assert.equal(cleared.resourceVersion, 1, 'clearing a plan changed the venue revision');

    const second = store.findBundle(FULL);
    assert.notEqual(second.id, first.id);
    assert.equal(store.snapshot().phase, 'PLAN_READY');
    assert.equal(store.snapshot().activePlan.id, second.id);
    assert.equal(refusalCode(() => store.stageBundle(first.id, 1)), 'PLAN_NOT_FOUND/404');
  });
});

describe('the session rate limiter counts one caller at a time', () => {
  let server;

  before(async () => {
    // Trusted-header mode, so each syntactically valid CF-Connecting-IP is its
    // own bucket and the tests below cannot leak into one another.
    server = await startVenueServer({ NSWR_TRUST_CF_CONNECTING_IP: '1' });
  });
  after(() => server?.kill());

  test('the forty-first session request in a window is the first one refused', async () => {
    const statuses = await sessionStatuses(
      server,
      SESSION_RATE_LIMIT + 2,
      () => ({ 'CF-Connecting-IP': '203.0.113.10' }),
    );

    const firstRefusal = statuses.indexOf(429) + 1;
    assert.equal(firstRefusal, SESSION_RATE_LIMIT + 1, `statuses were ${statuses.join(',')}`);
    assert.deepEqual(
      statuses.slice(0, SESSION_RATE_LIMIT),
      Array(SESSION_RATE_LIMIT).fill(201),
      'a request inside the documented allowance was refused',
    );
    assert.deepEqual(statuses.slice(SESSION_RATE_LIMIT), [429, 429]);

    const { payload } = await server.sessionAttempt({ 'CF-Connecting-IP': '203.0.113.10' });
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'TOO_MANY_SESSIONS');
    assert.match(payload.error.message, /Wait a minute/);
  });

  test('one caller exhausting its window leaves another caller untouched', async () => {
    const exhausted = await sessionStatuses(
      server,
      SESSION_RATE_LIMIT + 1,
      () => ({ 'CF-Connecting-IP': '203.0.113.20' }),
    );
    assert.equal(exhausted.at(-1), 429);

    // A different address, immediately afterwards, inside the same window.
    const neighbour = await sessionStatuses(server, 3, () => ({ 'CF-Connecting-IP': '203.0.113.21' }));
    assert.deepEqual(neighbour, [201, 201, 201], 'the limiter is one shared bucket, not one per caller');

    // And the exhausted caller is still refused, so the neighbour did not reset it.
    const { status } = await server.sessionAttempt({ 'CF-Connecting-IP': '203.0.113.20' });
    assert.equal(status, 429);
  });

  test('with the Cloudflare header trusted, only a syntactically valid address names a bucket', async () => {
    // Every one of these is a caller trying to mint a fresh identity per
    // request: values that are not one address, and the header the server
    // never trusts. All of them must collapse onto the socket's own bucket.
    // '   ' is deliberately absent: Node's HTTP parser strips the whitespace
    // around a header value before the server sees it, so a whitespace-only
    // value is indistinguishable from '' and would only be a second copy of it.
    const invented = ['not-an-ip', '', '1.2.3.4, 5.6.7.8', '999.1.1.1', '::gg', '203.0.113.9/32', '203.0.113.9:8080'];
    const statuses = await sessionStatuses(server, SESSION_RATE_LIMIT + 1, (index) => (
      index % 2 === 0
        ? { 'CF-Connecting-IP': invented[index % invented.length] }
        : { 'X-Forwarded-For': `198.18.${index}.1`, 'X-Real-IP': `192.0.2.${index}` }
    ));

    assert.deepEqual(
      statuses.slice(0, SESSION_RATE_LIMIT),
      Array(SESSION_RATE_LIMIT).fill(201),
    );
    assert.equal(
      statuses.at(-1),
      429,
      'an unparseable or untrusted forwarded address minted its own rate-limit bucket',
    );

    // The socket bucket is now spent, which makes these the sharpest available
    // checks: anything still accepted named a bucket of its own, and anything
    // refused fell back to the socket.
    const ipv6 = await server.sessionAttempt({ 'CF-Connecting-IP': '2001:db8::1' });
    assert.equal(ipv6.status, 201, 'a valid IPv6 address was not accepted as a bucket name');
    const ipv4 = await server.sessionAttempt({ 'CF-Connecting-IP': '203.0.113.30' });
    assert.equal(ipv4.status, 201, 'a second well-formed address did not get its own bucket');

    // Sending the header twice is how a caller smuggles an address past a
    // limiter that splits on commas and believes the first element. Node joins
    // the repeats into "a, b", which is not one address, so this must land back
    // on the spent socket bucket rather than minting a bucket named 203.0.113.31.
    const repeated = await server.sessionAttempt([
      ['CF-Connecting-IP', '203.0.113.31'],
      ['CF-Connecting-IP', '203.0.113.32'],
    ]);
    assert.equal(
      repeated.status,
      429,
      'a repeated CF-Connecting-IP header was split and one of its values named a bucket',
    );
    assert.equal(repeated.payload.error.code, 'TOO_MANY_SESSIONS');
  });
});

describe('forwarded headers are ignored unless the deployment trusts them', () => {
  test('invented Cloudflare and forwarded addresses do not mint new buckets', async (t) => {
    // No NSWR_TRUST_CF_CONNECTING_IP, which is how this runs anywhere that is
    // not behind the proxy that overwrites the header.
    const server = await startVenueServer();
    t.after(() => server.kill());

    // Forty-one requests, forty-one different well-formed addresses in three
    // different forwarding headers. With the header trusted these would be
    // forty-one separate buckets and none would ever be refused.
    const statuses = await sessionStatuses(server, SESSION_RATE_LIMIT + 1, (index) => ({
      'CF-Connecting-IP': `203.0.113.${index}`,
      'X-Forwarded-For': `198.18.0.${index}`,
      'X-Real-IP': `192.0.2.${index}`,
    }));

    assert.deepEqual(statuses.slice(0, SESSION_RATE_LIMIT), Array(SESSION_RATE_LIMIT).fill(201));
    assert.equal(
      statuses.at(-1),
      429,
      'a forwarded header was trusted without NSWR_TRUST_CF_CONNECTING_IP=1',
    );

    const { payload } = await server.sessionAttempt({ 'CF-Connecting-IP': '203.0.113.200' });
    assert.equal(payload.error.code, 'TOO_MANY_SESSIONS');
  });
});

describe('the process caps how many venues it holds', () => {
  test('passing the venue cap evicts the coldest unbooked venue and spares the booked one', async (t) => {
    const server = await startVenueServer({ NSWR_TRUST_CF_CONNECTING_IP: '1' });
    t.after(() => server.kill());

    // Filling the cap needs more session requests than one caller is allowed,
    // so the fillers are spread over buckets well inside the per-caller limit.
    let issued = 0;
    const nextBucket = () => {
      const bucket = { 'CF-Connecting-IP': `198.51.100.${1 + Math.floor(issued / 25)}` };
      issued += 1;
      return bucket;
    };

    // The venue that must survive: a real confirmed booking, three reserved
    // resources, someone looking at the receipt.
    const owner = await server.session('visitor', null, nextBucket());
    const { booking } = await server.bookEverything(owner.token, 'eviction-booking');
    assert.equal((await server.state(owner.token)).atomicity.reservedResourceCount, 3);

    // The venue that must not: created immediately after, then never touched
    // again, so it is the coldest unbooked venue on the process.
    const canary = await server.session('visitor', null, nextBucket());
    assert.equal(canary.venueExisted, false);

    // Past the cap. Each new venue beyond it drops exactly one old venue.
    const fillers = MAX_DEMOS + 6;
    for (let index = 0; index < fillers; index += 1) {
      const { status } = await server.sessionAttempt(nextBucket());
      assert.equal(status, 201, `filler ${index} was refused by the rate limiter`);
    }

    // The booked venue is still there, still holding the booking, and the
    // session token that was watching it still works.
    const rejoinBooked = await server.session('visitor', owner.demoId, nextBucket());
    assert.equal(rejoinBooked.venueExisted, true, 'the venue holding a confirmed booking was evicted');
    const survived = await server.state(owner.token);
    assert.equal(survived.phase, 'CONFIRMED');
    assert.equal(survived.atomicity.bookingCount, 1);
    assert.equal(survived.atomicity.reservedResourceCount, 3);
    assert.equal(survived.booking.id, booking.id);

    // The coldest unbooked venue was dropped, and the session pointing at it is
    // refused rather than being silently attached to somebody else's venue.
    const strandedRead = await server.stateResponse(canary.token);
    assert.equal(strandedRead.status, 401);
    assert.equal((await strandedRead.json()).error.code, 'SESSION_REQUIRED');

    const rejoinCanary = await server.session('visitor', canary.demoId, nextBucket());
    assert.equal(rejoinCanary.demoId, canary.demoId);
    assert.equal(rejoinCanary.venueExisted, false, 'the coldest unbooked venue was never evicted');
    const rebuilt = await server.state(rejoinCanary.token);
    assert.equal(rebuilt.phase, 'READY');
    assert.equal(rebuilt.booking, null);
  });
});

describe('a restart is an honest total loss', () => {
  test('a restart under a confirmed booking resurrects no booking, reservation or plan', async (t) => {
    const server = await startVenueServer();
    t.after(() => server.kill());

    const visitor = await server.session('visitor');
    const { plan, confirmation, booking } = await server.bookEverything(visitor.token, 'restart-idempotency-key');
    const before = await server.state(visitor.token);
    assert.equal(before.phase, 'CONFIRMED');
    assert.equal(before.atomicity.bookingCount, 1);
    assert.equal(before.atomicity.reservedResourceCount, 3);

    await server.restart();

    // The token minted by the dead process is refused, not honoured against
    // whatever venue happens to be in the new one.
    const deadToken = await server.stateResponse(visitor.token);
    assert.equal(deadToken.status, 401);
    assert.equal((await deadToken.json()).error.code, 'SESSION_REQUIRED');

    // The shared link still resolves to the same venue identifier, and the
    // server says plainly that the venue behind it is a rebuilt empty one.
    const rejoined = await server.session('visitor', visitor.demoId);
    assert.equal(rejoined.demoId, visitor.demoId);
    assert.equal(rejoined.venueExisted, false);

    const rebuilt = await server.state(rejoined.token);
    assert.equal(rebuilt.phase, 'READY');
    assert.equal(rebuilt.booking, null);
    assert.equal(rebuilt.activePlan, null);
    assert.equal(rebuilt.resourceVersion, 1);
    assert.equal(rebuilt.audit.length, 0);
    assert.equal(rebuilt.atomicity.bookingCount, 0);
    assert.equal(rebuilt.atomicity.reservedResourceCount, 0);
    // Named one by one rather than "none of them is RESERVED": the exact
    // opening state of every resource, so a rebuild that quietly comes back
    // with a lift out of service or a seat missing is a failure too.
    assert.deepEqual(
      Object.fromEntries(Object.entries(rebuilt.resources).map(([id, resource]) => [id, resource.status])),
      {
        'east-lift': 'OPERATIONAL',
        'garden-lift': 'OPERATIONAL',
        'space-w12': 'AVAILABLE',
        'seat-w13': 'AVAILABLE',
        'assist-east-1905': 'AVAILABLE',
        'assist-garden-1903': 'AVAILABLE',
      },
    );
    for (const resource of Object.values(rebuilt.resources)) {
      assert.equal(resource.reservedBy, undefined, `${resource.id} came back reserved`);
    }

    // The identifiers from before the restart are dead, not stale.
    for (const path of ['stage', 'replan', 'clear', 'prepare-confirmation']) {
      const response = await server.post(
        `/api/plans/${encodeURIComponent(plan.id)}/${path}`,
        { expectedResourceVersion: 1 },
        rejoined.token,
      );
      assert.equal(response.status, 404, `${path} resolved a plan from the dead process`);
      assert.equal((await response.json()).error.code, 'PLAN_NOT_FOUND');
    }

    // Replaying the exact confirmation command, idempotency key included, does
    // not hand back the booking the dead process issued.
    const replay = await server.post(`/api/plans/${encodeURIComponent(plan.id)}/commit`, {
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: 1,
      accepted: true,
      requestId: 'restart-idempotency-key',
    }, rejoined.token);
    assert.equal(replay.status, 404);
    const replayBody = await replay.json();
    assert.equal(replayBody.error.code, 'PLAN_NOT_FOUND');
    assert.equal(JSON.stringify(replayBody).includes(booking.id), false, 'the old booking came back in a replay');

    const settled = await server.state(rejoined.token);
    assert.equal(settled.atomicity.bookingCount, 0);
    assert.equal(settled.atomicity.reservedResourceCount, 0);
    assert.equal(settled.resourceVersion, 1);
  });
});

describe('the limits this suite asserts are the limits in the source', () => {
  test('server.mjs and lib/domain.mjs still declare the numbers used above', async () => {
    const server = await readFile(new URL('server.mjs', repoRoot), 'utf8');
    const domain = await readFile(new URL('lib/domain.mjs', repoRoot), 'utf8');

    // A limit that moves without these acceptance numbers moving with it is the
    // failure mode this test exists to make loud.
    assert.ok(
      domain.includes(`const AUDIT_LIMIT = ${AUDIT_LIMIT};`),
      `lib/domain.mjs no longer caps the audit log at ${AUDIT_LIMIT}`,
    );
    assert.ok(
      server.includes(`const SESSION_RATE_LIMIT = ${SESSION_RATE_LIMIT};`),
      `server.mjs no longer allows ${SESSION_RATE_LIMIT} sessions per window`,
    );
    // Derived from the constant, not written out again, so the searched text
    // and the number in the message can never say two different things.
    assert.ok(
      server.includes(`const SESSION_RATE_WINDOW_MS = ${SESSION_RATE_WINDOW_MS / 1000}_000;`),
      `server.mjs no longer uses a ${SESSION_RATE_WINDOW_MS} ms rate-limit window`,
    );
    assert.ok(
      server.includes(`const MAX_DEMOS = ${MAX_DEMOS};`),
      `server.mjs no longer caps the process at ${MAX_DEMOS} venues`,
    );

    // Not asserted by behaviour anywhere in this file - two hours cannot be
    // waited out and neither timer is injectable - so it is at least pinned
    // here, where a change to it is visible.
    assert.ok(
      server.includes('const DEMO_TTL_MS = 2 * 60 * 60 * 1000;'),
      'the demo TTL moved; no test in this suite covers TTL eviction by behaviour',
    );
    assert.ok(
      server.includes('const SESSION_TTL_MS = 2 * 60 * 60 * 1000;'),
      'the session TTL moved; no test in this suite covers TTL eviction by behaviour',
    );

    // The one header the limiter is allowed to believe, and only behind a flag.
    assert.ok(
      server.includes("fromEnv('NSWR_TRUST_CF_CONNECTING_IP') === '1'"),
      'the forwarded-header trust is no longer gated on NSWR_TRUST_CF_CONNECTING_IP=1',
    );
    assert.ok(
      server.includes("request.headers['cf-connecting-ip']"),
      'server.mjs no longer reads the one forwarded header it is allowed to trust',
    );
    assert.ok(
      server.includes('isIP(trimmed) !== 0'),
      'the limiter no longer requires the trusted header to be exactly one IP address',
    );
    assert.equal(
      server.includes("headers['x-forwarded-for']"),
      false,
      'server.mjs started reading X-Forwarded-For, which a caller writes itself',
    );
  });
});
