/**
 * Browser-facing domain refusals are product outcomes, not broken HTTP calls.
 *
 * Chrome prints every 4xx response from fetch() as a red DevTools network
 * error even when the page catches it.  The public API must keep conventional
 * error statuses for direct callers, while the first-party visitor/operator
 * pages can request the same typed refusal in a 200 response envelope and
 * handle `ok:false` themselves.  That keeps the safe-failure demo visible
 * without making a successful safety check look like a crashed request.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer } from '../helpers/test-server.mjs';

const REQUIREMENTS = {
  wheelchairWidthCm: 72,
  maxDistanceM: 80,
  stepFree: true,
  companionCount: 1,
  entranceAssistance: true,
  lowStimulus: true,
};

async function json(response) {
  return {
    status: response.status,
    domainStatus: response.headers.get('x-nswr-domain-status'),
    body: await response.json(),
  };
}

async function stageAndArm(server) {
  const visitor = await server.session('visitor');
  const operator = await server.session('operator', visitor.demoId);
  const created = await json(await server.request('/api/plans', {
    method: 'POST', body: { requirements: REQUIREMENTS }, sessionToken: visitor.token,
  }));
  const plan = created.body.plan;
  await server.request(`/api/plans/${plan.id}/stage`, {
    method: 'POST',
    body: { expectedResourceVersion: plan.basedOnResourceVersion },
    sessionToken: visitor.token,
  });
  await server.request('/api/operator/facilities/east-lift/arm', {
    method: 'POST', body: {}, sessionToken: operator.token,
  });
  const prepared = await json(await server.request(`/api/plans/${plan.id}/prepare-confirmation`, {
    method: 'POST', body: {}, sessionToken: visitor.token,
  }));
  return { visitor, plan, confirmation: prepared.body.confirmation };
}

async function commit(server, flow, headers = {}) {
  return json(await server.request(`/api/plans/${flow.plan.id}/commit`, {
    method: 'POST',
    sessionToken: flow.visitor.token,
    headers,
    body: {
      confirmationId: flow.confirmation.confirmationId,
      expectedResourceVersion: flow.confirmation.expectedResourceVersion,
      accepted: true,
      requestId: `request-${crypto.randomUUID()}`,
    },
  }));
}

describe('browser outcome envelope', () => {
  test('the first-party browser can receive a stale refusal without a red 409 request', async (t) => {
    const server = await startTestServer(t);
    const result = await commit(server, await stageAndArm(server), {
      'X-NSWR-Domain-Outcome': 'envelope-v1',
    });

    assert.equal(result.status, 200);
    assert.equal(result.domainStatus, '409');
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'STALE_RESOURCE_VERSION');
    assert.equal(result.body.error.status, 409);
    assert.equal(result.body.error.partialReservations, 0);
  });

  test('the raw API still reports the same refusal as HTTP 409', async (t) => {
    const server = await startTestServer(t);
    const result = await commit(server, await stageAndArm(server));

    assert.equal(result.status, 409);
    assert.equal(result.domainStatus, null);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'STALE_RESOURCE_VERSION');
    assert.equal(result.body.error.partialReservations, 0);
  });
});
