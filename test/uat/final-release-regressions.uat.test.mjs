/**
 * Regressions found only after the release candidate had passed every shipped
 * gate. Each test crosses the HTTP boundary that made the defect reachable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDemoStore, REFUSAL_LIMIT } from '../../lib/domain.mjs';
import { startTestServer } from '../helpers/test-server.mjs';

const FULL = Object.freeze({
  wheelchairWidthCm: 72,
  maxDistanceM: 80,
  stepFree: true,
  companionCount: 1,
  entranceAssistance: true,
  lowStimulus: true,
});

const IMPOSSIBLE = Object.freeze({ ...FULL, wheelchairWidthCm: 95 });
const read = async (response) => ({ status: response.status, body: await response.json() });

const open = async (server, role, demoId, headers = {}) => read(await server.request('/api/session', {
  method: 'POST',
  body: { role, demoId },
  headers,
}));

const command = async (server, path, body, token, toolName = null, headers = {}) => read(await server.request(path, {
  method: 'POST',
  body,
  sessionToken: token,
  headers: {
    ...(toolName ? { 'X-WebMCP-Tool': toolName } : {}),
    ...headers,
  },
}));

test('a successful superseding replan retires every session route exclusion for the old plan', async (t) => {
  const server = await startTestServer(t);
  const demoId = randomUUID();
  const a = (await open(server, 'visitor', demoId)).body.session;
  const b = (await open(server, 'visitor', demoId)).body.session;
  const operator = (await open(server, 'operator', demoId)).body.session;

  const created = await command(server, '/api/plans', { requirements: FULL }, a.token, 'find_access_bundle');
  assert.equal(created.status, 201);
  const originalId = created.body.plan.id;
  await command(
    server,
    `/api/plans/${encodeURIComponent(originalId)}/stage`,
    { expectedResourceVersion: created.body.state.resourceVersion },
    a.token,
    'stage_access_bundle',
  );
  await command(server, '/api/operator/facilities/east-lift/outage', { reasonCode: 'POWER_FAULT' }, operator.token);
  await command(server, '/api/operator/facilities/garden-lift/outage', { reasonCode: 'POWER_FAULT' }, operator.token);

  const aRefused = await command(
    server,
    `/api/plans/${encodeURIComponent(originalId)}/replan`,
    {},
    a.token,
    'replan_access_bundle',
  );
  assert.equal(aRefused.status, 422, 'visitor A never acquired the plan-scoped exclusion');

  await command(server, '/api/operator/facilities/garden-lift/restore', {}, operator.token);
  const replacement = await command(
    server,
    `/api/plans/${encodeURIComponent(originalId)}/replan`,
    {},
    b.token,
    'replan_access_bundle',
  );
  assert.equal(replacement.status, 200, 'visitor B did not supersede the plan');
  assert.equal(replacement.body.plan.routeId, 'garden-lift-route');

  await command(server, '/api/operator/facilities/east-lift/restore', {}, operator.token);
  await command(server, '/api/operator/facilities/garden-lift/outage', { reasonCode: 'POWER_FAULT' }, operator.token);
  const cleared = await command(
    server,
    `/api/plans/${encodeURIComponent(replacement.body.plan.id)}/clear`,
    {},
    b.token,
    'clear_access_plan',
  );
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.state.phase, 'READY');

  const options = await command(server, '/api/access-options', { requirements: FULL }, a.token);
  const explanation = await read(await server.get('/api/explain', a.token));
  const nextSearch = await command(server, '/api/plans', { requirements: FULL }, a.token, 'find_access_bundle');

  assert.deepEqual(
    options.body.evaluation.options.filter((option) => option.feasible).map((option) => option.routeId),
    ['east-lift-route'],
    'the control venue cannot actually serve East',
  );
  assert.equal(explanation.body.explanation.blocked, false, JSON.stringify(explanation.body.explanation));
  assert.equal(nextSearch.status, 201);
  assert.equal(nextSearch.body.plan.routeId, 'east-lift-route');
});

test('the refusal bound rejects a new session instead of erasing an active visitor explanation', async (t) => {
  const server = await startTestServer(t, { extraEnv: { NSWR_TRUST_CF_CONNECTING_IP: '1' } });
  const demoId = randomUUID();
  let first = null;

  for (let index = 0; index < REFUSAL_LIMIT; index += 1) {
    const ip = `10.0.${Math.floor(index / 254)}.${(index % 254) + 1}`;
    const opened = await open(server, 'visitor', demoId, { 'CF-Connecting-IP': ip });
    assert.equal(opened.status, 201, `session ${index + 1} was refused before the declared bound`);
    const refused = await command(
      server,
      '/api/plans',
      { requirements: IMPOSSIBLE },
      opened.body.session.token,
      'find_access_bundle',
      { 'CF-Connecting-IP': ip },
    );
    assert.equal(refused.status, 422);
    if (index === 0) first = { token: opened.body.session.token, ip };
  }

  const overflowIp = '10.0.1.250';
  const overflow = await open(server, 'visitor', demoId, { 'CF-Connecting-IP': overflowIp });
  assert.equal(overflow.status, 429);
  assert.equal(overflow.body.error.code, 'TOO_MANY_SESSIONS');

  const state = await read(await server.request('/api/state', {
    sessionToken: first.token,
    headers: { 'CF-Connecting-IP': first.ip },
  }));
  const explanation = await read(await server.request('/api/explain', {
    sessionToken: first.token,
    headers: { 'CF-Connecting-IP': first.ip },
  }));
  assert.equal(state.status, 200, 'the first session was sacrificed to admit the overflow session');
  assert.equal(explanation.body.explanation.blocked, true, 'the first active visitor lost its refusal');
  assert.equal(explanation.body.explanation.errorCode, 'NO_COMPLETE_BUNDLE');
});

test('an expired session is refused before its request can refresh lastSeenAt', async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'nswr-fake-clock-'));
  const offsetFile = path.join(scratch, 'offset.txt');
  await writeFile(offsetFile, '0');
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const preload = new URL('../helpers/fake-clock-preload.mjs', import.meta.url);
  const server = await startTestServer(t, {
    extraEnv: {
      NODE_OPTIONS: `--import=${preload.href}`,
      NSWR_FAKE_TIME_OFFSET_FILE: offsetFile,
      NSWR_TRUST_CF_CONNECTING_IP: '1',
    },
  });
  const demoId = randomUUID();
  const visitors = [];
  // Fill both the session capacity and the refusal map. The insertion order of
  // the refusal map deliberately remains unchanged when a session is refreshed.
  for (let index = 0; index < REFUSAL_LIMIT; index += 1) {
    const ip = `10.1.${Math.floor(index / 254)}.${(index % 254) + 1}`;
    const opened = await open(server, 'visitor', demoId, { 'CF-Connecting-IP': ip });
    assert.equal(opened.status, 201, `session ${index + 1} was refused before the capacity was full`);
    const refused = await command(
      server,
      '/api/plans',
      { requirements: IMPOSSIBLE },
      opened.body.session.token,
      null,
      { 'CF-Connecting-IP': ip },
    );
    assert.equal(refused.status, 422);
    visitors.push({ token: opened.body.session.token, ip });
  }

  // Refresh the first 199 sessions halfway through their life. The last token
  // will expire at 2h, while the oldest refusal still belongs to a live caller.
  await writeFile(offsetFile, String(60 * 60 * 1000));
  for (const visitor of visitors.slice(0, -1)) {
    const state = await read(await server.request('/api/state', {
      sessionToken: visitor.token,
      headers: { 'CF-Connecting-IP': visitor.ip },
    }));
    assert.equal(state.status, 200);
  }

  await writeFile(offsetFile, String(2 * 60 * 60 * 1000 + 1));
  const expiring = visitors.at(-1);
  const expired = await read(await server.request('/api/explain', {
    sessionToken: expiring.token,
    headers: { 'CF-Connecting-IP': expiring.ip },
  }));
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error.code, 'SESSION_REQUIRED');
  const stillExpired = await read(await server.request('/api/explain', {
    sessionToken: expiring.token,
    headers: { 'CF-Connecting-IP': expiring.ip },
  }));
  assert.equal(stillExpired.status, 401, 'the first rejected request revived the expired token');
  assert.equal(stillExpired.body.error.code, 'SESSION_REQUIRED');

  const replacement = await open(server, 'visitor', demoId, { 'CF-Connecting-IP': '10.1.1.250' });
  assert.equal(replacement.status, 201, 'the expired session still occupied the per-demo capacity');
  const replacementRefusal = await command(
    server,
    '/api/plans',
    { requirements: IMPOSSIBLE },
    replacement.body.session.token,
    null,
    { 'CF-Connecting-IP': '10.1.1.250' },
  );
  assert.equal(replacementRefusal.status, 422);

  // If the HTTP expiry path forgets to release its private refusal record, the
  // replacement refusal evicts this oldest still-live visitor from the map.
  const oldest = visitors[0];
  const explanation = await read(await server.request('/api/explain', {
    sessionToken: oldest.token,
    headers: { 'CF-Connecting-IP': oldest.ip },
  }));
  assert.equal(explanation.status, 200);
  assert.equal(explanation.body.explanation.blocked, true, 'expiry cleanup erased a live visitor instead of the expired one');
  assert.equal(explanation.body.explanation.errorCode, 'NO_COMPLETE_BUNDLE');
});

test('releasing an expired session removes its private refusal record', () => {
  const store = createDemoStore();
  assert.throws(() => store.findBundle(IMPOSSIBLE, { sessionKey: 'expired-visitor' }));
  assert.equal(store.rememberedRefusalCount(), 1);
  assert.equal(store.releaseSession('expired-visitor'), true);
  assert.equal(store.rememberedRefusalCount(), 0);
  assert.equal(store.explainRefusal('expired-visitor').blocked, false);
});

test('a direct search refusal still identifies FIND_ACCESS_BUNDLE as the rejected action', async (t) => {
  const server = await startTestServer(t);
  const visitor = (await open(server, 'visitor', randomUUID())).body.session;
  const refused = await command(
    server,
    '/api/plans',
    { requirements: IMPOSSIBLE },
    visitor.token,
    'find_access_bundle',
  );
  assert.equal(refused.status, 422);

  const explanation = await read(await server.get('/api/explain', visitor.token));
  assert.equal(explanation.body.explanation.blocked, true);
  assert.equal(explanation.body.explanation.rejectedAction.action, 'FIND_ACCESS_BUNDLE');
  assert.equal(explanation.body.explanation.rejectedAction.reason, 'NO_COMPLETE_BUNDLE');
});

test('clearing a failed replan preserves which action was actually rejected', async (t) => {
  const server = await startTestServer(t);
  const demoId = randomUUID();
  const visitor = (await open(server, 'visitor', demoId)).body.session;
  const operator = (await open(server, 'operator', demoId)).body.session;

  const created = await command(server, '/api/plans', { requirements: FULL }, visitor.token, 'find_access_bundle');
  const planId = created.body.plan.id;
  await command(
    server,
    `/api/plans/${encodeURIComponent(planId)}/stage`,
    { expectedResourceVersion: created.body.state.resourceVersion },
    visitor.token,
    'stage_access_bundle',
  );
  await command(server, '/api/operator/facilities/east-lift/outage', { reasonCode: 'POWER_FAULT' }, operator.token);
  await command(server, '/api/operator/facilities/garden-lift/outage', { reasonCode: 'POWER_FAULT' }, operator.token);
  const refused = await command(
    server,
    `/api/plans/${encodeURIComponent(planId)}/replan`,
    {},
    visitor.token,
    'replan_access_bundle',
  );
  assert.equal(refused.status, 422);

  const before = await read(await server.get('/api/explain', visitor.token));
  assert.equal(before.body.explanation.rejectedAction.action, 'NO_ALTERNATIVE_FOUND');

  const cleared = await command(
    server,
    `/api/plans/${encodeURIComponent(planId)}/clear`,
    {},
    visitor.token,
    'clear_access_plan',
  );
  assert.equal(cleared.status, 200);
  const after = await read(await server.get('/api/explain', visitor.token));
  assert.equal(after.body.explanation.blocked, true);
  assert.equal(after.body.explanation.rejectedAction.action, 'NO_ALTERNATIVE_FOUND');
  assert.equal(after.body.explanation.rejectedAction.reason, 'NO_COMPLETE_BUNDLE');
});
