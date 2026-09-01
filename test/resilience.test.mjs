/**
 * Two things the domain tests structurally cannot see, because they hold a
 * store object in the same process that is asserting about it:
 *
 *  1. What survives losing that process. The venue store is in-memory, so a
 *     restart is a total loss of state. The claim being tested is not that the
 *     plan survives - it cannot - but that its disappearance is honest: no
 *     booking appears, no resource is left reserved, and a plan identifier from
 *     before the restart cannot be staged or committed against the venue that
 *     replaced it.
 *  2. What happens when confirmations arrive genuinely in parallel over the
 *     network rather than one after another on one call stack. The domain
 *     concurrency tests call the store sequentially; these open several sockets
 *     at once and let the server interleave them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnOwnedServer, waitForOwnedServer } from './helpers/test-server.mjs';
import { createServer } from 'node:net';

const FULL = Object.freeze({
  wheelchairWidthCm: 72,
  maxDistanceM: 80,
  stepFree: true,
  companionCount: 1,
  entranceAssistance: true,
  lowStimulus: true,
});


/**
 * A port the operating system says is free, asked for at run time.
 *
 * These files used to write their ports in: 43917, 43929, 43931 and so on. Two
 * copies of the repository, or two agents, then contended for the same numbers -
 * and the loser did not fail. The readiness poll below answered from whichever
 * server was listening, so a run could pass having inspected somebody else's
 * process. An independent audit measured this suite failing 1 run in 6 on
 * unchanged source.
 *
 * test/hardening.test.mjs already carried this fix, and a comment naming the
 * exact bug class, for itself alone.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: chosen } = probe.address();
      probe.close(() => resolve(chosen));
    });
  });
}

function createClient(port) {
  const origin = `http://127.0.0.1:${port}`;
  // Regenerated on every launch(), including a restart, so the poll can never
  // accept the process it just replaced.
  let instanceToken = null;

  // The launch and its readiness poll used to be written out here, as they were
  // in every suite that spawned a server. The copies drifted - one of them
  // guarded on a binding its own scope never declared - so there is a single
  // implementation now, exercised against real impostor servers in
  // test/helpers/test-server.self.test.mjs.
  let handle = null;

  function launch() {
    handle = spawnOwnedServer({ port });
    instanceToken = handle.instanceToken;
    return handle.child;
  }

  async function waitUntilListening() {
    await waitForOwnedServer(handle);
  }

  async function waitUntilGone() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await fetch(`${origin}/api/health`);
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`The server on ${origin} did not stop`);
  }

  const post = (path, body, token) => fetch(origin + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      ...(token ? { 'X-Demo-Session': token } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
  });

  const state = async (token) => (await (await fetch(`${origin}/api/state`, {
    headers: { 'X-Demo-Session': token },
  })).json()).state;

  async function stagedPlan(token) {
    const created = await (await post('/api/plans', { requirements: FULL }, token)).json();
    assert.ok(created.plan, `plan creation failed: ${JSON.stringify(created)}`);
    const staged = await post(
      `/api/plans/${encodeURIComponent(created.plan.id)}/stage`,
      { expectedResourceVersion: created.plan.basedOnResourceVersion },
      token,
    );
    assert.equal(staged.status, 200);
    return created.plan;
  }

  const session = async (role, demoId) => (await (await post('/api/session', { role, demoId })).json()).session;

  return { origin, launch, waitUntilListening, waitUntilGone, post, state, stagedPlan, session };
}

test('a session says whether it joined a live venue or a rebuilt empty one', async (t) => {
  const api = createClient(await freePort());
  let child = api.launch();
  t.after(() => child.kill());
  await api.waitUntilListening();

  // Nobody named a venue, so a fresh identifier was minted for this caller.
  const first = await api.session('visitor');
  assert.equal(first.venueExisted, false);

  // The shared-link case: the venue is already on this process.
  const operator = await api.session('operator', first.demoId);
  assert.equal(operator.demoId, first.demoId);
  assert.equal(operator.venueExisted, true);

  await api.stagedPlan(first.token);
  const rejoinedLive = await api.session('visitor', first.demoId);
  assert.equal(rejoinedLive.venueExisted, true);
  assert.equal((await api.state(rejoinedLive.token)).phase, 'AWAITING_HUMAN_CONFIRMATION');

  child.kill();
  await api.waitUntilGone();
  child = api.launch();
  await api.waitUntilListening();

  // The same link, the same identifier, a different venue. The server has to
  // admit that rather than let the caller present an empty venue as the live
  // one, which is what makes a confirmed booking appear to vanish silently.
  const afterRestart = await api.session('visitor', first.demoId);
  assert.equal(afterRestart.demoId, first.demoId);
  assert.equal(afterRestart.venueExisted, false);
  assert.equal((await api.state(afterRestart.token)).phase, 'READY');

  // And the next caller on that link joins the rebuilt venue for real.
  const afterRebuild = await api.session('operator', first.demoId);
  assert.equal(afterRebuild.venueExisted, true);
});

test('a server restart under a staged plan books nothing and resurrects nothing', async (t) => {
  const api = createClient(await freePort());
  let child = api.launch();
  t.after(() => child.kill());
  await api.waitUntilListening();

  const visitor = await api.session('visitor');
  const plan = await api.stagedPlan(visitor.token);
  const confirmation = (await (await api.post(
    `/api/plans/${encodeURIComponent(plan.id)}/prepare-confirmation`,
    {},
    visitor.token,
  )).json()).confirmation;
  assert.equal((await api.state(visitor.token)).phase, 'AWAITING_HUMAN_CONFIRMATION');

  // The process holding the venue dies while a human is looking at the plan.
  child.kill();
  await api.waitUntilGone();
  child = api.launch();
  await api.waitUntilListening();

  // The page's own session is gone. It must be told so, not handed some other
  // venue that happens to be in the new process.
  const readAfterRestart = await fetch(`${api.origin}/api/state`, {
    headers: { 'X-Demo-Session': visitor.token },
  });
  assert.equal(readAfterRestart.status, 401);
  assert.equal((await readAfterRestart.json()).error.code, 'SESSION_REQUIRED');

  // The confirmation the visitor is holding is not a bearer token for a booking.
  const commitOnDeadSession = await api.post(`/api/plans/${encodeURIComponent(plan.id)}/commit`, {
    confirmationId: confirmation.confirmationId,
    expectedResourceVersion: confirmation.expectedResourceVersion,
    accepted: true,
    requestId: 'commit-across-a-restart',
  }, visitor.token);
  assert.equal(commitOnDeadSession.status, 401);
  assert.equal((await commitOnDeadSession.json()).error.code, 'SESSION_REQUIRED');

  // Reopening the shared link lands on the same demo identifier. The venue
  // behind it is new and empty: an unfinished plan must not come back as a
  // booking, and nothing may be left reserved by the vanished attempt.
  const rejoined = await api.session('visitor', visitor.demoId);
  assert.equal(rejoined.demoId, visitor.demoId);
  const rebuilt = await api.state(rejoined.token);
  assert.equal(rebuilt.phase, 'READY');
  assert.equal(rebuilt.activePlan, null);
  assert.equal(rebuilt.booking, null);
  assert.equal(rebuilt.atomicity.bookingCount, 0);
  assert.equal(rebuilt.atomicity.reservedResourceCount, 0);
  for (const resource of Object.values(rebuilt.resources)) {
    assert.equal(resource.reservedBy, undefined, `${resource.id} came back reserved`);
    assert.ok(['OPERATIONAL', 'AVAILABLE'].includes(resource.status), `${resource.id} came back ${resource.status}`);
  }

  // The identifiers from before the restart are dead, not merely stale: acting
  // on them must be refused rather than silently applied to the new venue.
  for (const path of [
    `/api/plans/${encodeURIComponent(plan.id)}/stage`,
    `/api/plans/${encodeURIComponent(plan.id)}/replan`,
    `/api/plans/${encodeURIComponent(plan.id)}/clear`,
    `/api/plans/${encodeURIComponent(plan.id)}/prepare-confirmation`,
  ]) {
    const response = await api.post(path, { expectedResourceVersion: 1 }, rejoined.token);
    assert.equal(response.status, 404, `${path} should not resolve`);
    assert.equal((await response.json()).error.code, 'PLAN_NOT_FOUND');
  }

  const commitOnNewVenue = await api.post(`/api/plans/${encodeURIComponent(plan.id)}/commit`, {
    confirmationId: confirmation.confirmationId,
    expectedResourceVersion: 1,
    accepted: true,
    requestId: 'commit-onto-the-replacement-venue',
  }, rejoined.token);
  assert.equal(commitOnNewVenue.status, 404);
  assert.equal((await commitOnNewVenue.json()).error.code, 'PLAN_NOT_FOUND');

  const settled = await api.state(rejoined.token);
  assert.equal(settled.atomicity.bookingCount, 0);
  assert.equal(settled.atomicity.reservedResourceCount, 0);
  assert.equal(settled.resourceVersion, 1);
});

test('genuinely parallel HTTP requests commit exactly one booking', async (t) => {
  const api = createClient(await freePort());
  const child = api.launch();
  t.after(() => child.kill());
  await api.waitUntilListening();

  const visitor = await api.session('visitor');

  // Eight sockets ask for a plan at once. Only one plan may become active; the
  // rest have to be refused rather than quietly replacing the one on screen.
  const planAttempts = await Promise.all(Array.from({ length: 8 }, () => (
    api.post('/api/plans', { requirements: FULL }, visitor.token)
  )));
  const created = planAttempts.filter((response) => response.status === 201);
  assert.equal(created.length, 1, `${created.length} plans were created in parallel`);
  const planBodies = await Promise.all(planAttempts.map((response) => response.json()));
  const refusedPlans = planBodies.filter((body) => body.ok !== true);
  assert.equal(refusedPlans.length, 7);
  for (const body of refusedPlans) assert.equal(body.error.code, 'ACTIVE_PLAN_EXISTS');

  const plan = planBodies.find((body) => body.ok === true).plan;
  assert.equal((await api.state(visitor.token)).activePlan.id, plan.id);

  await api.post(
    `/api/plans/${encodeURIComponent(plan.id)}/stage`,
    { expectedResourceVersion: plan.basedOnResourceVersion },
    visitor.token,
  );
  const confirmation = (await (await api.post(
    `/api/plans/${encodeURIComponent(plan.id)}/prepare-confirmation`,
    {},
    visitor.token,
  )).json()).confirmation;

  // Eight distinct request identifiers, so idempotent replay cannot be what
  // makes this pass. Each one is a separate command to book the same bundle.
  const commits = await Promise.all(Array.from({ length: 8 }, (_unused, index) => (
    api.post(`/api/plans/${encodeURIComponent(plan.id)}/commit`, {
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
      requestId: `parallel-commit-${index}`,
    }, visitor.token)
  )));
  const commitBodies = await Promise.all(commits.map(async (response) => ({
    status: response.status,
    body: await response.json(),
  })));

  const accepted = commitBodies.filter((entry) => entry.status === 200 && entry.body.result?.booking);
  assert.equal(accepted.length, 1, `${accepted.length} parallel confirmations produced a booking`);
  assert.equal(accepted[0].body.result.booking.partialReservations, 0);
  for (const entry of commitBodies) {
    if (entry === accepted[0]) continue;
    assert.notEqual(entry.status, 200, 'a losing parallel confirmation returned success');
    assert.equal(entry.body.ok, false);
    assert.ok(entry.body.error.code, JSON.stringify(entry.body));
  }

  const bookingId = accepted[0].body.result.booking.id;
  const committed = await api.state(visitor.token);
  assert.equal(committed.atomicity.bookingCount, 1);
  assert.equal(committed.atomicity.reservedResourceCount, 3);
  assert.equal(committed.phase, 'CONFIRMED');
  assert.equal(committed.booking.id, bookingId);
  const reserved = Object.values(committed.resources).filter((resource) => resource.status === 'RESERVED');
  assert.deepEqual(
    reserved.map((resource) => resource.id).sort(),
    ['assist-east-1905', 'seat-w13', 'space-w12'],
  );
  for (const resource of reserved) {
    assert.equal(resource.reservedBy, bookingId, `${resource.id} belongs to a different booking`);
  }
});

test('commit-first and outage-first HTTP orderings are both atomic', async (t) => {
  const api = createClient(await freePort());
  const child = api.launch();
  t.after(() => child.kill());
  await api.waitUntilListening();

  const prepare = async () => {
    const visitor = await api.session('visitor');
    const operator = await api.session('operator', visitor.demoId);
    const plan = await api.stagedPlan(visitor.token);
    assert.equal(plan.routeId, 'east-lift-route', 'the ordering test must exercise the lift it takes offline');
    const confirmationResponse = await api.post(
      `/api/plans/${encodeURIComponent(plan.id)}/prepare-confirmation`,
      {},
      visitor.token,
    );
    assert.equal(confirmationResponse.status, 200);
    const { confirmation } = await confirmationResponse.json();
    return { visitor, operator, plan, confirmation };
  };

  const commit = ({ visitor, plan, confirmation }, requestId) => api.post(
    `/api/plans/${encodeURIComponent(plan.id)}/commit`,
    {
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
      requestId,
    },
    visitor.token,
  );
  const outage = ({ operator }) => api.post(
    '/api/operator/facilities/east-lift/outage',
    { reasonCode: 'LIFT_DOOR_FAULT' },
    operator.token,
  );

  // Ordering one is explicit: the booking response has arrived before the
  // outage request is sent. A later operational incident may break the route,
  // but it must not turn one committed bundle into a partial reservation.
  const commitFirst = await prepare();
  const committed = await commit(commitFirst, 'deterministic-commit-first');
  assert.equal(committed.status, 200);
  const committedBody = await committed.json();
  assert.equal(committedBody.result.booking.partialReservations, 0);
  assert.equal((await outage(commitFirst)).status, 200);
  const afterCommitFirst = await api.state(commitFirst.visitor.token);
  assert.equal(afterCommitFirst.atomicity.bookingCount, 1);
  assert.equal(afterCommitFirst.atomicity.reservedResourceCount, 3);
  assert.equal(afterCommitFirst.booking.partialReservations, 0);

  // Ordering two is equally explicit: the outage response has arrived before
  // confirmation is attempted. The refusal field is part of the contract, so
  // absence must fail instead of being converted to zero by a test fallback.
  const outageFirst = await prepare();
  assert.equal((await outage(outageFirst)).status, 200);
  const refused = await commit(outageFirst, 'deterministic-outage-first');
  assert.equal(refused.status, 409);
  const refusal = await refused.json();
  assert.equal(refusal.ok, false);
  assert.equal(refusal.error.code, 'STALE_RESOURCE_VERSION');
  assert.equal(Object.hasOwn(refusal.error, 'partialReservations'), true);
  assert.equal(refusal.error.partialReservations, 0);
  const afterOutageFirst = await api.state(outageFirst.visitor.token);
  assert.equal(afterOutageFirst.atomicity.bookingCount, 0);
  assert.equal(afterOutageFirst.atomicity.reservedResourceCount, 0);
  assert.equal(afterOutageFirst.booking, null);
});

test('a confirmation racing a venue outage over HTTP is all-or-nothing', async (t) => {
  const api = createClient(await freePort());
  const child = api.launch();
  t.after(() => child.kill());
  await api.waitUntilListening();

  // Repeated, because which of the two writes the server reaches first is a
  // scheduling detail. Every ordering has to leave the venue whole.
  for (let round = 0; round < 6; round += 1) {
    const visitor = await api.session('visitor');
    const operator = await api.session('operator', visitor.demoId);
    const plan = await api.stagedPlan(visitor.token);
    const confirmation = (await (await api.post(
      `/api/plans/${encodeURIComponent(plan.id)}/prepare-confirmation`,
      {},
      visitor.token,
    )).json()).confirmation;

    const [commit] = await Promise.all([
      api.post(`/api/plans/${encodeURIComponent(plan.id)}/commit`, {
        confirmationId: confirmation.confirmationId,
        expectedResourceVersion: confirmation.expectedResourceVersion,
        accepted: true,
        requestId: `race-${round}`,
      }, visitor.token),
      api.post('/api/operator/facilities/east-lift/outage', { reasonCode: 'LIFT_DOOR_FAULT' }, operator.token),
    ]);

    const after = await api.state(visitor.token);
    const booked = commit.status === 200;
    assert.equal(after.atomicity.bookingCount, booked ? 1 : 0, `round ${round}: booking count disagrees with the commit result`);
    assert.equal(
      after.atomicity.reservedResourceCount,
      booked ? 3 : 0,
      `round ${round}: ${after.atomicity.reservedResourceCount} resources reserved for ${booked ? 'one booking' : 'no booking'}`,
    );
    if (booked) {
      assert.equal(after.booking.partialReservations, 0);
      assert.equal(after.booking.resourceIds.includes('east-lift'), true);
    } else {
      const refusal = await commit.json();
      assert.equal(refusal.ok, false);
      assert.equal(Object.hasOwn(refusal.error, 'partialReservations'), true);
      assert.equal(refusal.error.partialReservations, 0);
    }
  }
});
