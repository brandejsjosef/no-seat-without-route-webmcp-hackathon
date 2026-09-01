/**
 * Who the decision log says did a thing, and what that claim is worth.
 *
 * The visitor tools pass an interaction context through, so a plan staged by an
 * agent is recorded as one. The two operator writes did not: taking a lift out
 * of service or restoring it was always recorded as the venue operator, whether
 * the call arrived from the operations page or from `report_facility_outage`.
 * The decision log is the artefact this whole product asks to be believed, and
 * it was silent about half of what it records.
 *
 * The claim itself is deliberately modest, and the wording matters. An
 * authorised HTTP client can send any header it likes, so `X-WebMCP-Tool` is a
 * DECLARED INVOCATION PATH, not an authenticated identity. Proving identity
 * would need a server-issued, unforgeable, scoped capability, which this demo
 * does not have and does not claim.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDemoStore } from '../../lib/domain.mjs';
import { startTestServer } from '../helpers/test-server.mjs';

const store = () => createDemoStore({
  clock: () => Date.parse('2026-08-31T18:00:00.000Z'),
  idFactory: ((n) => () => `id-${++n}`)(0),
});

const lastEntry = (venue, action) => [...venue.snapshot().audit].reverse().find((row) => row.action === action);

describe('an operator write records the path it arrived through', () => {
  test('an outage reported through its tool is attributed to the agent, and names the tool', () => {
    const venue = store();
    venue.setFacilityOutage('east-lift', 'POWER_FAULT', { actor: 'webmcp-agent', toolName: 'report_facility_outage' });
    const entry = lastEntry(venue, 'FACILITY_OUTAGE_REPORTED');
    assert.equal(entry.actor, 'webmcp-agent', 'a tool call is still recorded as the venue operator');
    assert.equal(entry.toolName, 'report_facility_outage');
  });

  test('a restore through its tool is attributed the same way', () => {
    const venue = store();
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    venue.restoreFacility('east-lift', { actor: 'webmcp-agent', toolName: 'restore_facility' });
    const entry = lastEntry(venue, 'FACILITY_RESTORED');
    assert.equal(entry.actor, 'webmcp-agent');
    assert.equal(entry.toolName, 'restore_facility');
  });

  test('the same write from the page stays attributed to the venue operator', () => {
    const venue = store();
    venue.setFacilityOutage('east-lift', 'POWER_FAULT');
    const entry = lastEntry(venue, 'FACILITY_OUTAGE_REPORTED');
    assert.equal(entry.actor, 'venue-operator');
    assert.equal(entry.toolName ?? null, null, 'a human action must not carry a tool name');
  });
});

describe('the header is a declared path, not an identity', () => {
  test('a header naming a different tool is not promoted to an agent', async (t) => {
    // The server compares the header against the tool that owns the endpoint.
    // Anything else is a client saying something the endpoint did not ask for,
    // and is recorded as the venue operator rather than believed.
    const server = await startTestServer(t);
    const operator = await server.session('operator');

    await server.request('/api/operator/facilities/east-lift/outage', {
      method: 'POST',
      body: { reasonCode: 'POWER_FAULT' },
      sessionToken: operator.token,
      headers: { 'X-WebMCP-Tool': 'something_else_entirely' },
    });

    const state = await server.state(operator.token);
    const entry = [...state.audit].reverse().find((row) => row.action === 'FACILITY_OUTAGE_REPORTED');
    assert.equal(entry.actor, 'venue-operator', 'an arbitrary header was believed');
    assert.equal(entry.toolName ?? null, null);
  });

  test('the matching header records the declared path', async (t) => {
    const server = await startTestServer(t);
    const operator = await server.session('operator');

    await server.request('/api/operator/facilities/east-lift/outage', {
      method: 'POST',
      body: { reasonCode: 'POWER_FAULT' },
      sessionToken: operator.token,
      headers: { 'X-WebMCP-Tool': 'report_facility_outage' },
    });

    const state = await server.state(operator.token);
    const entry = [...state.audit].reverse().find((row) => row.action === 'FACILITY_OUTAGE_REPORTED');
    assert.equal(entry.actor, 'webmcp-agent');
    assert.equal(entry.toolName, 'report_facility_outage');
  });

  test('no absent header is treated as an agent', async (t) => {
    const server = await startTestServer(t);
    const operator = await server.session('operator');

    await server.post('/api/operator/facilities/garden-lift/restore', {}, operator.token);
    await server.post('/api/operator/facilities/east-lift/outage', { reasonCode: 'POWER_FAULT' }, operator.token);

    const state = await server.state(operator.token);
    const agentEntries = state.audit.filter((row) => row.actor === 'webmcp-agent');
    assert.deepEqual(agentEntries, [], 'a call with no header was recorded as an agent');
  });
});

/**
 * Narrow patterns rather than a denial heuristic. "Skip any line that contains a
 * negation" is defeated by a claim sitting beside a denial, which is exactly how
 * the sibling guard in test/documentation.test.mjs let its own mutation through
 * the whole gate: the heading "What this record is, and what it is not."
 * silenced the injected claim.
 *
 * These match an assertion of identity and not a denial of one, so the shipped
 * wording - "declared invocation path, not an authenticated identity" - passes
 * without needing an exemption.
 */
const IDENTITY_CLAIM = /is an? (?:trusted|authenticated|verified) (?:identity|actor)|proves who acted|identifies the caller/i;

describe('the documentation does not overstate what the header proves', () => {
  test('the wording guard actually recognises a claim and lets a denial through', () => {
    // A guard nothing checks can be emptied without anything noticing: a
    // mutation replacing the pattern with one that matches nothing survived the
    // complete gate. Guarding every guard is infinite regress, but a pattern can
    // be held to known examples, which is finite and real.
    const claims = [
      'X-WebMCP-Tool is a trusted identity',
      'X-WebMCP-Tool is an authenticated actor for the write',
      'webmcp-agent proves who acted on the venue',
    ];
    const denials = [
      'X-WebMCP-Tool is a DECLARED invocation path, not an authenticated identity',
      'X-WebMCP-Tool is a declared invocation path rather than a verified actor',
    ];
    for (const line of claims) {
      assert.ok(IDENTITY_CLAIM.test(line), `the guard no longer recognises a claim: ${line}`);
    }
    for (const line of denials) {
      assert.equal(IDENTITY_CLAIM.test(line), false, `the guard now flags a denial: ${line}`);
    }
  });

  test('no shipped document calls it a trusted or authenticated identity', async () => {
    const { readFile } = await import('node:fs/promises');
    const offenders = [];
    for (const name of ['README.md', 'QA_TEST_MATRIX.md', 'public/tools.mjs', 'server.mjs']) {
      const source = await readFile(new URL(`../../${name}`, import.meta.url), 'utf8');
      source.split('\n').forEach((line, index) => {
        if (!/X-WebMCP-Tool|webmcp-agent/i.test(line)) return;
        if (IDENTITY_CLAIM.test(line)) offenders.push(`${name}:${index + 1}`);
      });
    }
    assert.deepEqual(offenders, [], `these claim the header proves identity: ${offenders.join(', ')}`);
  });

  test('there is no operator arm tool to attribute anything to', async () => {
    // The arm endpoint is a demo control on the operations page. Documenting a
    // WebMCP tool for it would be inventing a surface that does not exist.
    const { createOperatorTools } = await import('../../public/tools.mjs');
    const names = createOperatorTools({ api: async () => ({}), refresh: async () => ({}) }).map((tool) => tool.name);
    assert.equal(names.includes('arm_facility_fault'), false, 'an operator arm tool appeared');
    assert.ok(names.includes('report_facility_outage'), 'the outage tool should exist');
    assert.ok(names.includes('restore_facility'), 'the restore tool should exist');
  });
});
