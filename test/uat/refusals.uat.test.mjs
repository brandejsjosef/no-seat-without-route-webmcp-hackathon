/**
 * Acceptance suite: the refusal contract.
 *
 * A person using the deployed demo found real defects that no test had ever
 * looked at, and every one of them lives in a refusal - the moment the product
 * says no. This file is the gate for that moment. It answers three questions
 * for every way the product can refuse:
 *
 *   1. Which code, which HTTP status?
 *   2. Is the message a sentence a person can read, or a fragment for a log?
 *   3. What is the agent told to do next, and can that thing actually be done?
 *
 * Everything here runs against the real modules. Where the product's behaviour
 * disagrees with its own documented promise, the test asserts what the product
 * ACTUALLY does and says so in a comment beginning "DEFECT". Nothing here is
 * written to fail; a human decides whether to change the product.
 *
 * Determinism: a fixed clock and a counting id factory everywhere, no sleeps,
 * no wall-clock assertions, and any HTTP server binds an OS-allocated port.
 */

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createDemoStore, DomainError, demoDefaults } from '../../lib/domain.mjs';
import { createVisitorTools, createOperatorTools, TOOL_LIMITS } from '../../public/tools.mjs';
import { checkToolContract } from '../../evals/contract.mjs';
import { startTestServer } from '../helpers/test-server.mjs';

const REPO_ROOT = new URL('../../', import.meta.url);

/* ------------------------------------------------------------------ *
 * Deterministic fixtures
 * ------------------------------------------------------------------ */

const FIXED_CLOCK = () => Date.parse('2026-08-30T18:00:00.000Z');

function freshStore() {
  return createDemoStore({
    clock: FIXED_CLOCK,
    idFactory: ((n) => () => `id-${++n}`)(0),
  });
}

/** A store with one proposed plan on the default requirements. */
function storeWithProposedPlan() {
  const store = freshStore();
  const plan = store.findBundle(demoDefaults);
  return { store, plan };
}

/** A store with one staged plan, ready for a human to confirm. */
function storeWithStagedPlan() {
  const { store, plan } = storeWithProposedPlan();
  return { store, plan: store.stageBundle(plan.id, plan.basedOnResourceVersion) };
}

/** A store holding a confirmed booking for the default requirements. */
function storeWithBooking(requestId = 'confirmed-by-the-visitor') {
  const { store, plan } = storeWithStagedPlan();
  const confirmation = store.prepareConfirmation(plan.id);
  const result = store.commitBundle({
    planId: plan.id,
    confirmationId: confirmation.confirmationId,
    expectedResourceVersion: confirmation.expectedResourceVersion,
    accepted: true,
    requestId,
  });
  return { store, plan, confirmation, booking: result.booking };
}

/** Both lifts out of service: no route can be completed by anybody. */
function takeBothLiftsOutOfService(store) {
  store.setFacilityOutage('east-lift', 'POWER_FAULT');
  store.setFacilityOutage('garden-lift', 'SAFETY_INSPECTION');
  return store;
}

/* ------------------------------------------------------------------ *
 * Refusal assertions
 * ------------------------------------------------------------------ */

/** Runs `fn`, requires it to be refused, and hands back the refusal. */
function refusalFrom(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return assert.fail('the call was expected to be refused, but it succeeded');
}

function assertDomainRefusal(error, { code, status }) {
  assert.ok(error instanceof DomainError, `expected a DomainError, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code, 'refusal code');
  assert.equal(error.status, status, `HTTP status carried by ${code}`);
  assert.equal(typeof error.details, 'object', `${code} must carry a details object`);
}

/**
 * A refusal a person reads. Not a log line: it starts a sentence, ends a
 * sentence, has enough words to say something, and never leaks a raw
 * SCREAMING_SNAKE identifier into the customer's face.
 */
function assertHumanSentence(message, label) {
  assert.equal(typeof message, 'string', `${label}: message must be a string`);
  assert.equal(message, message.trim(), `${label}: message has stray whitespace`);
  assert.ok(message.length >= 20, `${label}: "${message}" is too short to explain anything`);
  assert.ok(message.split(/\s+/).length >= 4, `${label}: "${message}" is not a sentence`);
  assert.match(message, /^[A-Z]/, `${label}: "${message}" does not start a sentence`);
  assert.match(message, /[.!?]$/, `${label}: "${message}" does not finish a sentence`);
  assert.doesNotMatch(message, /[A-Z][A-Z0-9]*_[A-Z0-9_]+/, `${label}: "${message}" shows a raw error identifier`);
  assert.doesNotMatch(message, /undefined|\[object |NaN/, `${label}: "${message}" leaks an interpolation failure`);
}

/* ------------------------------------------------------------------ *
 * The tool surface, wired to a real store (mirrors server.mjs routing)
 * ------------------------------------------------------------------ */

function createToolHarness(store = freshStore()) {
  async function api(path, options = {}) {
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : {};

    if (method === 'GET' && path === '/api/state') return { ok: true, state: store.snapshot() };
    if (method === 'GET' && path === '/api/explain') return { ok: true, explanation: store.explainRefusal() };
    if (method === 'POST' && path === '/api/access-options') {
      return { ok: true, evaluation: store.listAccessOptions(body.requirements ?? {}) };
    }

    const check = path.match(/^\/api\/access-routes\/([^/]+)\/check$/);
    if (method === 'POST' && check) {
      return { ok: true, evaluation: store.checkAccessRoute(decodeURIComponent(check[1]), body.requirements ?? {}) };
    }
    if (method === 'POST' && path === '/api/plans') {
      const plan = store.findBundle(body.requirements ?? {}, { actor: 'webmcp-agent', toolName: 'find_access_bundle' });
      return { ok: true, plan, state: store.snapshot() };
    }
    const stage = path.match(/^\/api\/plans\/([^/]+)\/stage$/);
    if (method === 'POST' && stage) {
      const plan = store.stageBundle(decodeURIComponent(stage[1]), body.expectedResourceVersion, {
        actor: 'webmcp-agent',
        toolName: 'stage_access_bundle',
      });
      return { ok: true, plan, state: store.snapshot() };
    }
    const replan = path.match(/^\/api\/plans\/([^/]+)\/replan$/);
    if (method === 'POST' && replan) {
      const plan = store.replanBundle(decodeURIComponent(replan[1]), { actor: 'webmcp-agent', toolName: 'replan_access_bundle' });
      return { ok: true, plan, state: store.snapshot() };
    }
    const clear = path.match(/^\/api\/plans\/([^/]+)\/clear$/);
    if (method === 'POST' && clear) {
      return { ok: true, state: store.clearPlan(decodeURIComponent(clear[1]), { actor: 'webmcp-agent', toolName: 'clear_access_plan' }) };
    }
    const outage = path.match(/^\/api\/operator\/facilities\/([^/]+)\/outage$/);
    if (method === 'POST' && outage) {
      return { ok: true, state: store.setFacilityOutage(decodeURIComponent(outage[1]), body.reasonCode) };
    }
    const restore = path.match(/^\/api\/operator\/facilities\/([^/]+)\/restore$/);
    if (method === 'POST' && restore) {
      return { ok: true, state: store.restoreFacility(decodeURIComponent(restore[1])) };
    }
    throw new Error(`Unrouted call: ${method} ${path}`);
  }

  const refresh = async () => store.snapshot();
  return {
    store,
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
  assert.ok(tool, `the surface should expose ${name}`);
  return tool;
}

/** Calls a tool and requires the result to be a refusal an agent can read. */
async function refusalFromTool(tools, name, input) {
  const raw = await toolNamed(tools, name).execute(input);
  assert.equal(typeof raw, 'string', `${name} must answer with a serialised result, not a thrown error`);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.ok, false, `${name} was expected to refuse but returned ${raw}`);
  assert.equal(typeof parsed.nextAction, 'string', `${name} refused without telling the agent what to do next`);
  return parsed;
}

const GENERIC_NEXT_ACTION = 'READ_THE_CURRENT_BUNDLE_STATUS';

/**
 * NEXT_ACTION_BY_CODE is module-private, so membership is read from the source
 * of the file that owns it. Two codes can share the generic string while only
 * one of them is actually mapped, and only membership tells them apart.
 */
async function readMappedCodes() {
  const source = await readFile(new URL('public/tools.mjs', REPO_ROOT), 'utf8');
  const block = source.match(/const NEXT_ACTION_BY_CODE = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
  assert.ok(block, 'NEXT_ACTION_BY_CODE is no longer declared the way this check reads it');
  const codes = [...block[1].matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1]);
  // Canary that the parse produced real entries. It used to be
  // NO_COMPLETE_BUNDLE, which is now deliberately absent from the map: the
  // domain computes that one from venue state, so a static entry could only
  // ever be right half the time.
  assert.ok(codes.includes('STALE_RESOURCE_VERSION'), 'the map parsed but produced nothing recognisable');
  return new Set(codes);
}

/** Every quoted refusal code a source file can produce. */
function refusalCodesIn(source) {
  const codes = [
    ...[...source.matchAll(/new DomainError\(\s*'([A-Z][A-Z0-9_]*)'/g)].map((match) => match[1]),
    ...[...source.matchAll(/[^A-Za-z]code:\s*'([A-Z][A-Z0-9_]*)'/g)].map((match) => match[1]),
  ];
  return [...new Set(codes)].sort();
}

/* ================================================================== *
 * 1. The inventory is closed
 * ================================================================== */

describe('the set of refusals this product can produce', () => {
  const DOMAIN_CODES = [
  'ACTIVE_PLAN_EXISTS',
  'BOOKING_ALREADY_EXISTS',
  'BUNDLE_NO_LONGER_FEASIBLE',
  'EXPECTED_RESOURCE_VERSION_MISMATCH',
  'FACILITY_NOT_FOUND',
  'FACILITY_NOT_OPERATIONAL',
  'HUMAN_CONFIRMATION_REQUIRED',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_COMPANION_COUNT',
  'INVALID_CONFIRMATION',
  'INVALID_MAX_DISTANCE',
  'INVALID_OUTAGE_REASON',
  'INVALID_REQUIREMENT_TYPE',
  'INVALID_WHEELCHAIR_WIDTH',
  'MISSING_REQUIREMENTS',
  'NO_COMPLETE_BUNDLE',
  'OUTAGE_ALREADY_ARMED',
  'PLAN_ALREADY_COMMITTED',
  'PLAN_NOT_ACTIVE',
  'PLAN_NOT_FOUND',
  'PLAN_NOT_READY',
  'PLAN_NOT_STAGEABLE',
  'PLAN_NOT_STALE',
  'REQUEST_ID_REQUIRED',
  'RESOURCE_CONFLICT',
  'RESOURCE_NOT_FOUND',
  'ROUTE_NOT_FOUND',
  'STALE_RESOURCE_VERSION',
  'UNSUPPORTED_REQUIREMENT',
];

  const SERVER_CODES = [
    'BODY_TOO_LARGE',
    'CROSS_SITE_REQUEST_BLOCKED',
    'DEMO_NOT_FOUND',
    'INTERNAL_ERROR',
    'INVALID_DEMO_ID',
    'INVALID_JSON',
    'INVALID_ORIGIN',
    'INVALID_PATH',
    'INVALID_ROLE',
    'NOT_FOUND',
    'ORIGIN_REQUIRED',
    'ROLE_FORBIDDEN',
    'SESSION_REQUIRED',
    'TOO_MANY_SESSIONS',
  ];

  test('the access domain refuses in exactly the twenty-nine ways this suite covers', async () => {
    const source = await readFile(new URL('lib/domain.mjs', REPO_ROOT), 'utf8');
    assert.deepEqual(
      refusalCodesIn(source),
      DOMAIN_CODES,
      'a refusal was added to or removed from lib/domain.mjs without a test for how it reaches a person',
    );
  });

  test('the server refuses in exactly the fourteen ways this suite covers', async () => {
    const source = await readFile(new URL('server.mjs', REPO_ROOT), 'utf8');
    assert.deepEqual(
      refusalCodesIn(source),
      SERVER_CODES,
      'a refusal was added to or removed from server.mjs without a test for how it reaches a person',
    );
  });
});

/* ================================================================== *
 * 2. Every refusal the access domain can produce
 * ================================================================== */

describe('a visitor who asks for something the venue cannot do', () => {
  test('naming a requirement the venue has never heard of is refused in a sentence', () => {
    const error = refusalFrom(() => freshStore().listAccessOptions({ teleport: true }));
    assertDomainRefusal(error, { code: 'UNSUPPORTED_REQUIREMENT', status: 422 });
    assert.equal(error.details.key, 'teleport', 'the refusal must name the requirement it did not understand');
    // Was the fragment "Unsupported requirement: teleport" - no full stop, so a
    // page printing it verbatim showed a half-finished line to the customer.
    // The name is quoted, so an unusual one reads as a quotation rather than as
    // broken grammar, and the machine-readable key is still beside it.
    assertHumanSentence(error.message, 'UNSUPPORTED_REQUIREMENT');
    assert.match(error.message, /"teleport"/, 'the refusal no longer names the requirement');
  });

  test('booking without stating every requirement is refused and the missing ones are named', () => {
    const error = refusalFrom(() => freshStore().findBundle({ stepFree: true }));
    assertDomainRefusal(error, { code: 'MISSING_REQUIREMENTS', status: 422 });
    assertHumanSentence(error.message, 'MISSING_REQUIREMENTS');
    assert.deepEqual(error.details.missing, [
      'wheelchairWidthCm',
      'maxDistanceM',
      'companionCount',
      'entranceAssistance',
      'lowStimulus',
    ]);
  });

  test('a mobility aid wider than any doorway is refused with the range that would work', () => {
    const error = refusalFrom(() => freshStore().listAccessOptions({ wheelchairWidthCm: 120 }));
    assertDomainRefusal(error, { code: 'INVALID_WHEELCHAIR_WIDTH', status: 422 });
    assertHumanSentence(error.message, 'INVALID_WHEELCHAIR_WIDTH');
    assert.match(error.message, /45 and 95 cm/, 'the customer must be told which widths are acceptable');
  });

  test('an impossible walking distance is refused with the range that would work', () => {
    const error = refusalFrom(() => freshStore().listAccessOptions({ maxDistanceM: 3 }));
    assertDomainRefusal(error, { code: 'INVALID_MAX_DISTANCE', status: 422 });
    assertHumanSentence(error.message, 'INVALID_MAX_DISTANCE');
    assert.match(error.message, /20 and 500 metres/, 'the customer must be told which distances are acceptable');
  });

  test('asking for more companions than the demo seats is refused in plain words', () => {
    const error = refusalFrom(() => freshStore().listAccessOptions({ companionCount: 2 }));
    assertDomainRefusal(error, { code: 'INVALID_COMPANION_COUNT', status: 422 });
    assertHumanSentence(error.message, 'INVALID_COMPANION_COUNT');
  });

  test('a yes-or-no requirement sent as text is refused in a sentence that still names the field', () => {
    const error = refusalFrom(() => freshStore().listAccessOptions({ stepFree: 'yes' }));
    assertDomainRefusal(error, { code: 'INVALID_REQUIREMENT_TYPE', status: 422 });
    assert.equal(error.details.key, 'stepFree');
    // Was "stepFree must be true or false." - it opened with the raw field
    // name, so it read as developer output. It still has to identify the
    // parameter, which is what an agent needs to correct the call, and it still
    // has to say which type was expected.
    assertHumanSentence(error.message, 'INVALID_REQUIREMENT_TYPE');
    assert.match(error.message, /"stepFree"/, 'the refusal no longer names the field');
    assert.match(error.message, /true or false/, 'the refusal no longer says which type was expected');
  });

  test('checking a route the venue does not have is refused with the routes it does have', () => {
    const error = refusalFrom(() => freshStore().checkAccessRoute('service-tunnel'));
    assertDomainRefusal(error, { code: 'ROUTE_NOT_FOUND', status: 404 });
    assertHumanSentence(error.message, 'ROUTE_NOT_FOUND');
    assert.deepEqual(error.details.knownRouteIds, ['east-lift-route', 'garden-lift-route']);
  });
});

describe('an agent that asks for a plan the venue will not give', () => {
  test('a second search while a plan is on the page is refused and names the plan in the way', () => {
    const { store } = storeWithProposedPlan();
    const error = refusalFrom(() => store.findBundle(demoDefaults));
    assertDomainRefusal(error, { code: 'ACTIVE_PLAN_EXISTS', status: 409 });
    assertHumanSentence(error.message, 'ACTIVE_PLAN_EXISTS');
    assert.equal(error.details.activePlanId, 'plan-id-1', 'the refusal must name the plan that is in the way');
  });

  test('searching again after the visitor has booked is refused and points at the booking', () => {
    const { store } = storeWithBooking();
    const error = refusalFrom(() => store.findBundle(demoDefaults));
    assertDomainRefusal(error, { code: 'BOOKING_ALREADY_EXISTS', status: 409 });
    assertHumanSentence(error.message, 'BOOKING_ALREADY_EXISTS');
  });

  test('acting on a plan identifier the venue never issued is refused as missing', () => {
    const store = freshStore();
    for (const [label, call] of [
      ['stage', () => store.stageBundle('plan-never-issued', 1)],
      ['replan', () => store.replanBundle('plan-never-issued')],
      ['prepare confirmation', () => store.prepareConfirmation('plan-never-issued')],
      ['clear', () => store.clearPlan('plan-never-issued')],
      ['commit', () => store.commitBundle({
        planId: 'plan-never-issued',
        confirmationId: 'confirm-never-issued',
        expectedResourceVersion: 1,
        accepted: true,
        requestId: 'unknown-plan',
      })],
    ]) {
      const error = refusalFrom(call);
      assertDomainRefusal(error, { code: 'PLAN_NOT_FOUND', status: 404 });
      assertHumanSentence(error.message, `PLAN_NOT_FOUND via ${label}`);
    }
  });

  test('staging a plan the venue has already invalidated is refused without saying the venue changed', () => {
    const { store, plan } = storeWithProposedPlan();
    store.setFacilityOutage('garden-lift', 'POWER_FAULT');
    const error = refusalFrom(() => store.stageBundle(plan.id, plan.basedOnResourceVersion));
    // The outage marks every open plan STALE, so the status guard fires before
    // the revision guard: the person is told the plan is not stageable and
    // never that a lift went out of service.
    assertDomainRefusal(error, { code: 'PLAN_NOT_STAGEABLE', status: 409 });
    assertHumanSentence(error.message, 'PLAN_NOT_STAGEABLE');
    assert.equal(store.snapshot().atomicity.reservedResourceCount, 0, 'a refused stage must reserve nothing');
  });

  test('staging against a wrong revision is a mismatch, and the plan stays stageable', () => {
    // This pinned the defect. It was the only way to reach STALE_RESOURCE_VERSION
    // from stageBundle and the one case where nothing had moved: the details
    // said plan revision 1 against venue revision 1 while the message said
    // "Venue resources changed", and the advertised REPLAN was itself refused
    // with PLAN_NOT_STALE. The repair applied to commitBundle had not been
    // applied here, which the audit asked for in the same breath.
    const { store, plan } = storeWithProposedPlan();
    const error = refusalFrom(() => store.stageBundle(plan.id, 99));
    assertDomainRefusal(error, { code: 'EXPECTED_RESOURCE_VERSION_MISMATCH', status: 409 });
    assertHumanSentence(error.message, 'EXPECTED_RESOURCE_VERSION_MISMATCH on stage');
    assert.equal(error.details.nextAction, 'RETRY_WITH_THE_VENUE_REVISION');
    assert.equal(error.details.venueResourceVersion, store.snapshot().resourceVersion);

    // And the advice works, which the old one did not.
    const staged = store.stageBundle(plan.id, store.snapshot().resourceVersion);
    assert.equal(staged.status, 'STAGED');
  });

  test('staging a plan twice is refused because it is no longer merely proposed', () => {
    const { store, plan } = storeWithStagedPlan();
    const error = refusalFrom(() => store.stageBundle(plan.id, plan.basedOnResourceVersion));
    assertDomainRefusal(error, { code: 'PLAN_NOT_STAGEABLE', status: 409 });
    assertHumanSentence(error.message, 'PLAN_NOT_STAGEABLE on a staged plan');
  });

  test('replanning a plan the venue has not invalidated is refused', () => {
    const { store, plan } = storeWithProposedPlan();
    const error = refusalFrom(() => store.replanBundle(plan.id));
    assertDomainRefusal(error, { code: 'PLAN_NOT_STALE', status: 409 });
    assertHumanSentence(error.message, 'PLAN_NOT_STALE');
  });

  test('offering a plan for confirmation before it is staged is refused', () => {
    const { store, plan } = storeWithProposedPlan();
    const error = refusalFrom(() => store.prepareConfirmation(plan.id));
    assertDomainRefusal(error, { code: 'PLAN_NOT_READY', status: 409 });
    assertHumanSentence(error.message, 'PLAN_NOT_READY');
  });
});

describe('the guards around the moment a booking is committed', () => {
  test('confirming without an idempotency key is refused, rejecting unsafe keys too', () => {
    const { store, plan } = storeWithStagedPlan();
    const confirmation = store.prepareConfirmation(plan.id);
    const command = {
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
    };
    for (const requestId of [undefined, '', '__proto__', 'constructor', 'has spaces']) {
      const error = refusalFrom(() => store.commitBundle({ ...command, requestId }));
      assertDomainRefusal(error, { code: 'REQUEST_ID_REQUIRED', status: 422 });
      assertHumanSentence(error.message, `REQUEST_ID_REQUIRED for ${String(requestId)}`);
    }
    assert.equal(store.snapshot().atomicity.bookingCount, 0, 'a keyless confirmation must not book anything');
  });

  test('confirming without an explicit human yes is refused with the precondition status', () => {
    const { store, plan } = storeWithStagedPlan();
    const confirmation = store.prepareConfirmation(plan.id);
    const error = refusalFrom(() => store.commitBundle({
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: false,
      requestId: 'no-human-yes',
    }));
    assertDomainRefusal(error, { code: 'HUMAN_CONFIRMATION_REQUIRED', status: 428 });
    assertHumanSentence(error.message, 'HUMAN_CONFIRMATION_REQUIRED');
    assert.equal(store.snapshot().atomicity.reservedResourceCount, 0);
  });

  test('confirming with a review token the venue did not issue is refused', () => {
    const { store, plan } = storeWithStagedPlan();
    const confirmation = store.prepareConfirmation(plan.id);
    const error = refusalFrom(() => store.commitBundle({
      planId: plan.id,
      confirmationId: 'confirm-forged',
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
      requestId: 'forged-confirmation',
    }));
    assertDomainRefusal(error, { code: 'INVALID_CONFIRMATION', status: 428 });
    assertHumanSentence(error.message, 'INVALID_CONFIRMATION');
    assert.equal(store.snapshot().atomicity.bookingCount, 0);
  });

  test('reusing an idempotency key for a different command is refused rather than replayed', () => {
    const { store, plan, confirmation } = storeWithBooking('one-click');
    const error = refusalFrom(() => store.commitBundle({
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: 999,
      accepted: true,
      requestId: 'one-click',
    }));
    assertDomainRefusal(error, { code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    assertHumanSentence(error.message, 'IDEMPOTENCY_CONFLICT');
    assert.equal(store.snapshot().atomicity.bookingCount, 1, 'the original booking must survive the conflict');
  });

  test('a confirmed booking can be neither confirmed again nor cleared away', () => {
    const { store, plan, confirmation } = storeWithBooking();
    const committedAgain = refusalFrom(() => store.commitBundle({
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: store.snapshot().resourceVersion,
      accepted: true,
      requestId: 'second-click',
    }));
    assertDomainRefusal(committedAgain, { code: 'PLAN_ALREADY_COMMITTED', status: 409 });
    assertHumanSentence(committedAgain.message, 'PLAN_ALREADY_COMMITTED on commit');

    const cleared = refusalFrom(() => store.clearPlan(plan.id));
    assertDomainRefusal(cleared, { code: 'PLAN_ALREADY_COMMITTED', status: 409 });
    assertHumanSentence(cleared.message, 'PLAN_ALREADY_COMMITTED on clear');
    assert.equal(store.snapshot().booking.id, 'booking-id-3', 'the booking must still be there after both refusals');
  });

  test('a lift failing mid-confirmation refuses the commit and counts the partial writes at zero', () => {
    const { store, plan } = storeWithStagedPlan();
    store.armOutage('east-lift');
    const confirmation = store.prepareConfirmation(plan.id);
    const error = refusalFrom(() => store.commitBundle({
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
      requestId: 'outage-during-confirmation',
    }));
    assertDomainRefusal(error, { code: 'STALE_RESOURCE_VERSION', status: 409 });
    assertHumanSentence(error.message, 'STALE_RESOURCE_VERSION on commit');
    assert.equal(error.details.nextAction, 'REPLAN');
    assert.equal(error.details.partialReservations, 0, 'a refused confirmation must leave nothing half-booked');
    assert.ok(
      error.details.currentResourceVersion > error.details.planResourceVersion,
      'this refusal must report a revision that genuinely moved',
    );
    assert.equal(store.snapshot().phase, 'PLAN_STALE');
  });
});

describe('the operator refusals on the venue side', () => {
  test('an outage reported against something that is not a lift is refused as missing', () => {
    const store = freshStore();
    for (const [label, call] of [
      ['outage on a seat', () => store.setFacilityOutage('space-w12', 'POWER_FAULT')],
      ['arming an unknown lift', () => store.armOutage('roof-lift')],
      ['restoring an unknown lift', () => store.restoreFacility('roof-lift')],
    ]) {
      const error = refusalFrom(call);
      assertDomainRefusal(error, { code: 'FACILITY_NOT_FOUND', status: 404 });
      assertHumanSentence(error.message, `FACILITY_NOT_FOUND via ${label}`);
    }
  });

  test('a free-text outage reason is refused with the reasons the venue accepts', () => {
    const store = freshStore();
    for (const reasonCode of [undefined, 'BECAUSE_I_SAID_SO', 'toString', 'constructor']) {
      const error = refusalFrom(() => store.setFacilityOutage('east-lift', reasonCode));
      assertDomainRefusal(error, { code: 'INVALID_OUTAGE_REASON', status: 422 });
      assertHumanSentence(error.message, `INVALID_OUTAGE_REASON for ${String(reasonCode)}`);
      assert.deepEqual(error.details.allowedReasonCodes, ['LIFT_DOOR_FAULT', 'POWER_FAULT', 'SAFETY_INSPECTION']);
    }
    assert.equal(store.snapshot().resources['east-lift'].status, 'OPERATIONAL', 'a refused outage must change nothing');
  });

  test('arming the demo fault on a lift that is already down is refused', () => {
    const store = freshStore();
    store.setFacilityOutage('east-lift', 'POWER_FAULT');
    const error = refusalFrom(() => store.armOutage('east-lift'));
    assertDomainRefusal(error, { code: 'FACILITY_NOT_OPERATIONAL', status: 409 });
    assertHumanSentence(error.message, 'FACILITY_NOT_OPERATIONAL');
  });

  test('withdrawing something that cannot be reserved is refused as not reservable', () => {
    const store = freshStore();
    for (const resourceId of ['east-lift', 'nothing-by-this-name']) {
      const error = refusalFrom(() => store.setResourceUnavailable(resourceId));
      assertDomainRefusal(error, { code: 'RESOURCE_NOT_FOUND', status: 404 });
      assertHumanSentence(error.message, `RESOURCE_NOT_FOUND for ${resourceId}`);
    }
  });
});

describe('the refusals no sequence of calls can actually reach', () => {
  test('a plan that is no longer the one on the page is deleted, so it reads as missing rather than inactive', () => {
    // PLAN_NOT_ACTIVE guards commit and clear, but a plan stops being active
    // only by being cleared or superseded, and both delete it. Every attempt to
    // reach the guard produces PLAN_NOT_FOUND instead.
    const { store, plan } = storeWithStagedPlan();
    const confirmation = store.prepareConfirmation(plan.id);
    store.setFacilityOutage('east-lift', 'POWER_FAULT');
    const replacement = store.replanBundle(plan.id);
    assert.notEqual(replacement.id, plan.id, 'the replacement must be a different plan');

    const committed = refusalFrom(() => store.commitBundle({
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: store.snapshot().resourceVersion,
      accepted: true,
      requestId: 'superseded-plan',
    }));
    assertDomainRefusal(committed, { code: 'PLAN_NOT_FOUND', status: 404 });
    assertDomainRefusal(refusalFrom(() => store.clearPlan(plan.id)), { code: 'PLAN_NOT_FOUND', status: 404 });
  });

  test('a resource withdrawn under a staged plan reads as not stageable, never as no longer feasible', () => {
    // BUNDLE_NO_LONGER_FEASIBLE can only fire when the venue revision matches
    // and the route fails anyway. Every mutation that can break a route also
    // advances the revision, so the earlier guards always win.
    const { store, plan } = storeWithProposedPlan();
    store.setResourceUnavailable('seat-w13');
    // The unreachable guard's own precondition is genuinely met: the plan's
    // route no longer satisfies the plan's own requirements. Only the order of
    // the guards decides which refusal the caller is given.
    const recheck = store.checkAccessRoute(plan.routeId, plan.requirements);
    assert.equal(recheck.feasible, false, 'the withdrawal must really break the planned route');
    assert.deepEqual(recheck.blockedBy, ['COMPANION_SEAT']);

    const error = refusalFrom(() => store.stageBundle(plan.id, plan.basedOnResourceVersion));
    assertDomainRefusal(error, { code: 'PLAN_NOT_STAGEABLE', status: 409 });
  });

  test('a seat taken away before confirmation reads as a changed venue, never as a resource conflict', () => {
    // RESOURCE_CONFLICT is the last guard before the write. Reaching it needs a
    // consumable resource to be unavailable at a revision the plan still
    // matches, which the revision counter makes impossible.
    const { store, plan } = storeWithStagedPlan();
    const confirmation = store.prepareConfirmation(plan.id);
    store.setResourceUnavailable('space-w12');
    // Half of that guard's precondition holds - the wheelchair space really is
    // gone - and the single revision the withdrawal advanced is the only thing
    // keeping the guard out of reach.
    assert.equal(store.snapshot().resources['space-w12'].status, 'UNAVAILABLE');
    assert.equal(
      store.snapshot().resourceVersion,
      confirmation.expectedResourceVersion + 1,
      'withdrawing a seat must move the venue revision exactly once',
    );

    const error = refusalFrom(() => store.commitBundle({
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
      requestId: 'seat-taken-away',
    }));
    assertDomainRefusal(error, { code: 'STALE_RESOURCE_VERSION', status: 409 });
    assert.equal(error.details.partialReservations, 0);
  });
});

/* ================================================================== *
 * 3. Refusals the page raises before a request is ever sent
 * ================================================================== */

describe('a tool call an agent gets wrong before it reaches the venue', () => {
  test('the tool surface itself still satisfies the published authoring contract', () => {
    const { visitor, operator } = createToolHarness();
    assert.deepEqual(checkToolContract(visitor, 'visitor'), []);
    assert.deepEqual(checkToolContract(operator, 'operator'), []);
  });

  test('a call missing required arguments is refused and the arguments are named', async () => {
    const { visitor } = createToolHarness();
    const refused = await refusalFromTool(visitor, 'stage_access_bundle', {});
    assert.equal(refused.error, 'MISSING_TOOL_ARGUMENTS');
    assert.equal(refused.nextAction, 'READ_THE_TOOL_SCHEMA_AND_RETRY');
    assert.deepEqual(refused.missing, ['planId', 'expectedVenueRevision']);
    assertHumanSentence(refused.message, 'MISSING_TOOL_ARGUMENTS');
  });

  test('a booking search that leaves requirements unstated is refused as missing requirements, not as a schema slip', async () => {
    const { visitor } = createToolHarness();
    const refused = await refusalFromTool(visitor, 'find_access_bundle', { stepFree: true, maxDistanceM: 80 });
    assert.equal(refused.error, 'MISSING_REQUIREMENTS');
    assert.equal(refused.nextAction, 'ASK_THE_VISITOR_FOR_THE_MISSING_REQUIREMENTS');
    assert.deepEqual(refused.missing, ['wheelchairWidthCm', 'companionCount', 'entranceAssistance', 'lowStimulus']);
    assertHumanSentence(refused.message, 'MISSING_REQUIREMENTS from the tool surface');
  });

  test('an argument the schema does not declare is refused with the arguments that are allowed', async () => {
    const { visitor } = createToolHarness();
    const refused = await refusalFromTool(visitor, 'list_access_options', { teleport: true });
    assert.equal(refused.error, 'UNSUPPORTED_TOOL_ARGUMENT');
    assert.equal(refused.nextAction, 'READ_THE_TOOL_SCHEMA_AND_RETRY');
    assert.equal(refused.argument, 'teleport');
    assert.deepEqual(
      refused.allowed,
      ['wheelchairWidthCm', 'maxDistanceM', 'stepFree', 'companionCount', 'entranceAssistance', 'lowStimulus'],
      'a refusal that names no alternative leaves the agent guessing; every accepted argument must be listed',
    );
    assertHumanSentence(refused.message, 'UNSUPPORTED_TOOL_ARGUMENT');
  });

  test('checking a route without naming one is refused by pointing at the tool that lists them', async () => {
    const { visitor } = createToolHarness();
    const refused = await refusalFromTool(visitor, 'check_access_route', {});
    assert.equal(refused.error, 'ROUTE_ID_REQUIRED');
    assert.equal(refused.nextAction, 'CALL_LIST_ACCESS_OPTIONS');
    assertHumanSentence(refused.message, 'ROUTE_ID_REQUIRED');
  });

  test('a route identifier outside the schema is refused with the identifiers that exist', async () => {
    const { visitor } = createToolHarness();
    const refused = await refusalFromTool(visitor, 'check_access_route', { routeId: 'service-tunnel' });
    assert.equal(refused.error, 'ROUTE_NOT_FOUND');
    assert.equal(refused.nextAction, 'CALL_LIST_ACCESS_OPTIONS');
    assert.deepEqual(refused.knownRouteIds, ['east-lift-route', 'garden-lift-route']);
    assertHumanSentence(refused.message, 'ROUTE_NOT_FOUND from the tool surface');
  });

  test('a badly typed, out-of-range or unlisted value is refused in a sentence that names the parameter', async () => {
    const { visitor, operator } = createToolHarness();
    // Each case: the parameter that must be named, and what the wording must say
    // about it. These used to open with the raw parameter name - developer
    // output, rendered verbatim by the visitor page - and the expectation was
    // the exact old string, which would have accepted any other fragment too.
    const cases = [
      [visitor, 'list_access_options', { wheelchairWidthCm: 'wide' }, 'wheelchairWidthCm', /a number/],
      [visitor, 'list_access_options', { wheelchairWidthCm: 400 }, 'wheelchairWidthCm', /between 45 and 95/],
      [visitor, 'list_access_options', { companionCount: 0.5 }, 'companionCount', /an integer/],
      [visitor, 'list_access_options', { companionCount: 7 }, 'companionCount', /allowed values/],
      [operator, 'report_facility_outage', { facilityId: 'roof-lift', reasonCode: 'POWER_FAULT' }, 'facilityId', /allowed values/],
    ];
    for (const [tools, name, input, parameter, says] of cases) {
      const refused = await refusalFromTool(tools, name, input);
      assert.equal(refused.error, 'INVALID_TOOL_ARGUMENT');
      assert.equal(refused.nextAction, 'READ_THE_TOOL_SCHEMA_AND_RETRY');
      assertHumanSentence(refused.message, `INVALID_TOOL_ARGUMENT for ${parameter}`);
      assert.match(refused.message, new RegExp(`"${parameter}"`), `the refusal no longer names ${parameter}`);
      assert.match(refused.message, says, `the refusal no longer says what ${parameter} should be`);
      assert.equal(refused.argument, parameter, 'the machine-readable parameter must survive the rewording');
    }
    // The one input error that is phrased as a sentence: a non-object call.
    const notAnObject = await refusalFromTool(visitor, 'list_access_options', [1, 2]);
    assert.equal(notAnObject.error, 'INVALID_TOOL_ARGUMENT');
    assertHumanSentence(notAnObject.message, 'INVALID_TOOL_ARGUMENT for a non-object');
  });

  test('a failure with no code at all reaches the agent labelled, and carries whatever wording it had', async () => {
    const failing = (thrown) => createVisitorTools({
      api: async () => { throw thrown; },
      refresh: async () => freshStore().snapshot(),
    });

    // What a blocked, offline or cross-origin fetch actually throws in a browser.
    const network = await refusalFromTool(failing(new TypeError('Failed to fetch')), 'list_access_options', {});
    assert.equal(network.error, 'REQUEST_FAILED', 'a codeless failure must still be labelled for the agent');
    assert.equal(network.nextAction, GENERIC_NEXT_ACTION);
    assert.equal(network.message, 'Failed to fetch', 'the browser wording is handed on unchanged');

    // Something thrown that is not an Error at all: the written fallback shows.
    const opaque = await refusalFromTool(failing('a bare string'), 'list_access_options', {});
    assert.equal(opaque.error, 'REQUEST_FAILED');
    assert.equal(opaque.nextAction, GENERIC_NEXT_ACTION);
    assert.equal(opaque.message, 'The request could not be completed.');
    assertHumanSentence(opaque.message, 'REQUEST_FAILED fallback');

    // The fallback used `??`, and an empty string is neither null nor
    // undefined, so an Error carrying no wording handed the agent an empty
    // message. A refusal with nothing in it is the one thing a refusal may not
    // be. Whitespace-only counts as nothing too.
    for (const blankError of [new Error(''), new Error('   ')]) {
      const blank = await refusalFromTool(failing(blankError), 'list_access_options', {});
      assert.equal(blank.error, 'REQUEST_FAILED');
      assertHumanSentence(blank.message, 'REQUEST_FAILED with no wording');
      assert.equal(blank.message, 'The request could not be completed.');
    }
  });
});

/* ================================================================== *
 * 4. Every refusal the HTTP server can produce
 * ================================================================== */

describe('the refusals the server sends over HTTP', () => {
  let child = null;
let instanceToken = null;
  let origin = '';
  let visitor = null;
  let operator = null;


  async function post(path, { body, raw, headers = {}, token, sameOrigin = true } = {}) {
    const requestHeaders = { 'Content-Type': 'application/json', ...headers };
    if (sameOrigin && !('Origin' in requestHeaders)) requestHeaders.Origin = origin;
    if (token) requestHeaders['X-Demo-Session'] = token;
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: requestHeaders,
      body: raw ?? JSON.stringify(body ?? {}),
    });
    return { status: response.status, body: await response.json() };
  }

  async function get(path, token) {
    const headers = {};
    if (token) headers['X-Demo-Session'] = token;
    const response = await fetch(`${origin}${path}`, { headers });
    return { status: response.status, body: await response.json() };
  }

  function assertHttpRefusal({ status, body }, { code, expectedStatus }) {
    assert.equal(status, expectedStatus, `HTTP status for ${code}`);
    assert.equal(body.ok, false, `${code} must be reported as a refusal`);
    assert.equal(body.error.code, code, `refusal code (got ${JSON.stringify(body.error)})`);
    assertHumanSentence(body.error.message, code);
  }

  // Forty lines of launch used to live here, and every other suite that spawned
  // a server had its own copy. The copies drifted: this one's readiness guard
  // named a `child` its scope never declared, so it never fired. One
  // implementation now, proved against real impostor servers in
  // test/helpers/test-server.self.test.mjs.
  const cleanups = [];

  before(async () => {
    const handle = await startTestServer({ after: (cleanup) => cleanups.push(cleanup) });
    child = handle.child;
    origin = handle.origin;
    instanceToken = handle.instanceToken;

    visitor = (await post('/api/session', { body: { role: 'visitor' } })).body.session;
    operator = (await post('/api/session', { body: { role: 'operator', demoId: visitor.demoId } })).body.session;
    assert.ok(visitor?.token && operator?.token, 'the test server issued no demo sessions');
  });

  after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    child = null;
  });

  test('a state change with no origin header is refused before anything is read', async () => {
    const response = await post('/api/session', { body: { role: 'visitor' }, sameOrigin: false });
    assertHttpRefusal(response, { code: 'ORIGIN_REQUIRED', expectedStatus: 403 });
  });

  test('a state change whose origin is not a URL is refused', async () => {
    const response = await post('/api/session', { headers: { Origin: 'http://[' }, body: { role: 'visitor' } });
    assertHttpRefusal(response, { code: 'INVALID_ORIGIN', expectedStatus: 403 });
  });

  test('a state change from another site is refused, by origin and by fetch metadata alike', async () => {
    const byOrigin = await post('/api/session', { headers: { Origin: 'https://evil.example' }, body: { role: 'visitor' } });
    assertHttpRefusal(byOrigin, { code: 'CROSS_SITE_REQUEST_BLOCKED', expectedStatus: 403 });
    const byMetadata = await post('/api/session', { headers: { 'Sec-Fetch-Site': 'cross-site' }, body: { role: 'visitor' } });
    assertHttpRefusal(byMetadata, { code: 'CROSS_SITE_REQUEST_BLOCKED', expectedStatus: 403 });
  });

  test('a demo role the product does not have is refused with the roles it does have', async () => {
    const response = await post('/api/session', { body: { role: 'administrator' } });
    assertHttpRefusal(response, { code: 'INVALID_ROLE', expectedStatus: 422 });
    assert.match(response.body.error.message, /visitor or operator/);
  });

  test('a shared demo link carrying a malformed identifier is refused', async () => {
    const response = await post('/api/session', { body: { role: 'visitor', demoId: 'not-a-uuid' } });
    assertHttpRefusal(response, { code: 'INVALID_DEMO_ID', expectedStatus: 422 });
  });

  test('a body that is not a JSON object is refused as invalid JSON', async () => {
    assertHttpRefusal(await post('/api/session', { raw: '{' }), { code: 'INVALID_JSON', expectedStatus: 400 });
    assertHttpRefusal(await post('/api/session', { raw: '[]' }), { code: 'INVALID_JSON', expectedStatus: 400 });
    assertHttpRefusal(await post('/api/session', { raw: 'null' }), { code: 'INVALID_JSON', expectedStatus: 400 });
  });

  test('an oversized body is refused with the size limit named', async () => {
    const response = await post('/api/session', {
      raw: JSON.stringify({ role: 'visitor', padding: 'x'.repeat(40_000) }),
    });
    assertHttpRefusal(response, { code: 'BODY_TOO_LARGE', expectedStatus: 413 });
    assert.match(response.body.error.message, /32 KB/);
  });

  test('an API call with no demo session is refused and told to start one', async () => {
    assertHttpRefusal(await get('/api/state'), { code: 'SESSION_REQUIRED', expectedStatus: 401 });
    assertHttpRefusal(await get('/api/state', 'not-a-real-token'), { code: 'SESSION_REQUIRED', expectedStatus: 401 });
  });

  test('an unknown session is refused before the venue behind it is ever looked up', async () => {
    // DEMO_NOT_FOUND exists for a session whose venue disappeared, but the
    // eviction sweep deletes such sessions in the same pass, so every route to
    // it answers SESSION_REQUIRED instead.
    const response = await get('/api/state', '00000000-0000-4000-8000-000000000000');
    assertHttpRefusal(response, { code: 'SESSION_REQUIRED', expectedStatus: 401 });
    // Positive control: the same endpoint answers a real token, so the refusal
    // above is about this session and not a blanket 401 on every read.
    assert.equal((await get('/api/state', visitor.token)).status, 200);
  });

  test('each role is refused on the other role endpoints and told which role is needed', async () => {
    const visitorOnOperator = await post('/api/operator/facilities/east-lift/arm', { token: visitor.token });
    assertHttpRefusal(visitorOnOperator, { code: 'ROLE_FORBIDDEN', expectedStatus: 403 });
    assert.match(visitorOnOperator.body.error.message, /operator/);

    const operatorOnVisitor = await post('/api/plans', { token: operator.token, body: { requirements: FULL_REQUIREMENTS } });
    assertHttpRefusal(operatorOnVisitor, { code: 'ROLE_FORBIDDEN', expectedStatus: 403 });
    assert.match(operatorOnVisitor.body.error.message, /visitor/);
  });

  test('a path segment that is not valid percent-encoding is refused as a bad request', async () => {
    assertHttpRefusal(
      await post('/api/access-routes/%E0%A4%A/check', { token: visitor.token }),
      { code: 'INVALID_PATH', expectedStatus: 400 },
    );
    assertHttpRefusal(
      await post('/api/plans/%E0%A4%A/clear', { token: visitor.token }),
      { code: 'INVALID_PATH', expectedStatus: 400 },
    );
  });

  test('an API path the product does not serve is refused as not found', async () => {
    assertHttpRefusal(await get('/api/nope'), { code: 'NOT_FOUND', expectedStatus: 404 });
    assertHttpRefusal(await post('/api/plans/x/teleport', { token: visitor.token }), { code: 'NOT_FOUND', expectedStatus: 404 });
  });

  test('a domain refusal keeps its own code and status when it travels over HTTP', async () => {
    const missing = await post('/api/plans', { token: visitor.token, body: { requirements: { stepFree: true } } });
    assertHttpRefusal(missing, { code: 'MISSING_REQUIREMENTS', expectedStatus: 422 });
    assert.deepEqual(
      missing.body.error.missing,
      ['wheelchairWidthCm', 'maxDistanceM', 'companionCount', 'entranceAssistance', 'lowStimulus'],
      'the details must survive serialisation intact, not merely arrive as some array',
    );

    const badRoute = await post('/api/access-routes/service-tunnel/check', { token: visitor.token });
    assertHttpRefusal(badRoute, { code: 'ROUTE_NOT_FOUND', expectedStatus: 404 });
    assert.deepEqual(badRoute.body.error.knownRouteIds, ['east-lift-route', 'garden-lift-route']);

    const badReason = await post('/api/operator/facilities/east-lift/outage', {
      token: operator.token,
      body: { reasonCode: 'BECAUSE_I_SAID_SO' },
    });
    assertHttpRefusal(badReason, { code: 'INVALID_OUTAGE_REASON', expectedStatus: 422 });
  });

  test('hostile but well-formed requests are refused with a code, never with a bare server error', async () => {
    // INTERNAL_ERROR is the handler of last resort. Nothing a caller can send
    // should reach it, so each probe is pinned to the named refusal it must get
    // instead: a bare "some code came back" check would pass on a 500 renamed.
    const probes = [
      ['a requirements field holding a string', 422, 'UNSUPPORTED_REQUIREMENT',
        await post('/api/access-options', { token: visitor.token, body: { requirements: 'not-an-object' } })],
      ['a requirement explicitly set to null', 422, 'INVALID_WHEELCHAIR_WIDTH',
        await post('/api/access-options', { token: visitor.token, body: { requirements: { wheelchairWidthCm: null } } })],
      ['a prototype key as a route id', 404, 'ROUTE_NOT_FOUND',
        await post('/api/access-routes/__proto__/check', { token: visitor.token })],
      ['a prototype key as a plan id on stage', 404, 'PLAN_NOT_FOUND',
        await post('/api/plans/__proto__/stage', { token: visitor.token, body: { expectedResourceVersion: 1 } })],
      ['a prototype key as a plan id on prepare', 404, 'PLAN_NOT_FOUND',
        await post('/api/plans/constructor/prepare-confirmation', { token: visitor.token })],
      ['a prototype key as an idempotency key', 422, 'REQUEST_ID_REQUIRED',
        await post('/api/plans/prototype/commit', { token: visitor.token, body: { accepted: true, requestId: '__proto__' } })],
      ['a prototype key as a facility id', 404, 'FACILITY_NOT_FOUND',
        await post('/api/operator/facilities/__proto__/outage', { token: operator.token, body: { reasonCode: 'toString' } })],
    ];
    for (const [label, expectedStatus, expectedCode, probe] of probes) {
      assert.equal(probe.status, expectedStatus, `${label}: ${JSON.stringify(probe.body)}`);
      assert.equal(probe.body.ok, false, label);
      assert.equal(probe.body.error.code, expectedCode, label);
      // UNSUPPORTED_REQUIREMENT is the one refusal that is a fragment rather
      // than a sentence; that defect is asserted and reported on its own above.
      if (expectedCode === 'UNSUPPORTED_REQUIREMENT') {
        assert.equal(probe.body.error.message, `This venue has no access requirement called "0".`, 'a string is indexed like an object');
      } else {
        assertHumanSentence(probe.body.error.message, `${expectedCode} via ${label}`);
      }
    }
  });

  test('too many demo sessions from one address are refused with a wait, not a lockout of the API', async () => {
    // Deliberately last: the limiter is per address and this exhausts it for
    // the rest of the minute.
    let limited = null;
    for (let attempt = 0; attempt < 80 && !limited; attempt += 1) {
      const response = await post('/api/session', { body: { role: 'visitor', demoId: visitor.demoId } });
      if (response.status === 429) limited = response;
    }
    assert.ok(limited, 'the session limiter never engaged');
    assertHttpRefusal(limited, { code: 'TOO_MANY_SESSIONS', expectedStatus: 429 });
    assert.match(limited.body.error.message, /[Ww]ait a minute/);
    // Reads must keep working while session creation is throttled, or the
    // visitor looking at a booking loses the page they were reading.
    const stillReadable = await get('/api/state', visitor.token);
    assert.equal(stillReadable.status, 200, 'an exhausted session limiter must not block reads');
  });
});

/* ================================================================== *
 * 5. An explanation can never disagree with an actual refusal
 * ================================================================== */

describe('what the product says about a refusal it has just made', () => {
  test('a plan invalidated by an outage is explained with the same rule the planner would fail on', () => {
    const { store, plan } = storeWithStagedPlan();
    store.setFacilityOutage('east-lift', 'POWER_FAULT');

    const explanation = store.explainRefusal();
    assert.equal(explanation.blocked, true);
    assert.equal(explanation.phase, 'PLAN_STALE');
    assert.equal(explanation.errorCode, 'STALE_RESOURCE_VERSION');
    assert.deepEqual(explanation.brokenRules.map((rule) => rule.rule), ['LIFT_OPERATIONAL']);
    assert.deepEqual(explanation.validOptionsNow.map((option) => option.routeId), ['garden-lift-route']);
    assert.equal(explanation.nextAction, 'REPLAN');
    assert.equal(explanation.partialReservations, 0);

    // The promised agreement: the route the explanation offers is the route the
    // planner actually produces.
    const replacement = store.replanBundle(plan.id);
    assert.equal(replacement.routeId, 'garden-lift-route');
  });

  test('a failed replan leaves an explanation that agrees the venue has nothing left', () => {
    const { store, plan } = storeWithStagedPlan();
    takeBothLiftsOutOfService(store);
    const refused = refusalFrom(() => store.replanBundle(plan.id));
    assertDomainRefusal(refused, { code: 'NO_COMPLETE_BUNDLE', status: 422 });
    assertHumanSentence(refused.message, 'NO_COMPLETE_BUNDLE from replan');

    const explanation = store.explainRefusal();
    assert.equal(explanation.blocked, true);
    assert.equal(explanation.phase, 'NO_ALTERNATIVE');
    assert.equal(explanation.errorCode, refused.code, 'the explanation must name the code that was refused');
    assert.deepEqual(explanation.validOptionsNow, [], 'no route may be offered while every lift is out');
    assert.equal(explanation.nextAction, refused.details.nextAction);
    assert.equal(explanation.rejectedAction.reason, 'NO_COMPLETE_BUNDLE');
  });

  test('with every lift out and no plan open, the explanation agrees with the search that refused', () => {
    // This pinned the defect: lib/domain.mjs states that "an explanation can
    // never disagree with an actual refusal", and it could. explainRefusal only
    // reported the two phases carrying an open plan, so on a fresh visit to a
    // venue where both lifts are down the visitor was refused and then told
    // there was nothing to explain.
    //
    // Registering explain_access_refusal in READY without repairing this made it
    // worse rather than better - the tool named for the question was then
    // present and answered "Nothing is blocked" one call after the refusal.
    const store = takeBothLiftsOutOfService(freshStore());
    assert.equal(store.snapshot().phase, 'READY');

    const refused = refusalFrom(() => store.findBundle(demoDefaults));
    assertDomainRefusal(refused, { code: 'NO_COMPLETE_BUNDLE', status: 422 });
    assertHumanSentence(refused.message, 'NO_COMPLETE_BUNDLE from find');

    const explanation = store.explainRefusal();
    assert.equal(explanation.blocked, true, 'the refusal is still invisible to the explain tool');
    assert.equal(explanation.errorCode, 'NO_COMPLETE_BUNDLE');
    assert.deepEqual(explanation.blockedBy, refused.details.blockedBy);
    assert.equal(explanation.nextAction, refused.details.nextAction);
    // The read-only evaluation the explanation is built from agrees.
    assert.equal(store.listAccessOptions(demoDefaults).feasibleCount, 0);
  });

  test('clearing the dead-end plan leaves a still-closed venue explicable', () => {
    // Continued: this is the sequence a person actually performs. The dead end
    // is explained, the visitor clears it to change requirements, and the
    // explanation used to go quiet even though every search still failed.
    const { store, plan } = storeWithStagedPlan();
    takeBothLiftsOutOfService(store);
    refusalFrom(() => store.replanBundle(plan.id));
    assert.equal(store.explainRefusal().blocked, true, 'the dead end is explained while the plan is open');

    store.clearPlan(plan.id);
    assert.equal(store.snapshot().phase, 'READY');
    assert.equal(store.explainRefusal().blocked, true, 'clearing the plan silenced a venue that is still shut');
    assert.equal(store.explainRefusal().requirementChangeCanHelp, false);
    assertDomainRefusal(
      refusalFrom(() => store.findBundle(demoDefaults)),
      { code: 'NO_COMPLETE_BUNDLE', status: 422 },
    );
  });

  test('an explanation never claims a partial booking that the venue does not hold', () => {
    const { store, plan } = storeWithStagedPlan();
    store.armOutage('east-lift');
    const confirmation = store.prepareConfirmation(plan.id);
    refusalFrom(() => store.commitBundle({
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
      requestId: 'outage-mid-confirmation',
    }));
    const explanation = store.explainRefusal();
    const snapshot = store.snapshot();
    assert.equal(
      explanation.partialReservations,
      snapshot.atomicity.reservedResourceCount,
      'the explanation must count the venue, not repeat a claim',
    );
    assert.equal(explanation.partialReservations, 0);
    assert.equal(explanation.rejectedAction.action, 'COMMIT_REJECTED_STALE');
  });
});

/* ================================================================== *
 * 6. The next action an agent is given
 * ================================================================== */

describe('the next action a refused agent is handed', () => {
  test('every refusal an agent can actually receive carries the next action recorded here', async () => {
    const received = new Map();
    const record = async (tools, name, input) => {
      const refused = await refusalFromTool(tools, name, input);
      const previous = received.get(refused.error);
      assert.ok(
        previous === undefined || previous === refused.nextAction,
        `${refused.error} gave two different next actions: ${previous} and ${refused.nextAction}`,
      );
      received.set(refused.error, refused.nextAction);
      return refused;
    };

    // Schema refusals, raised on the page before any request is sent.
    const schema = createToolHarness();
    await record(schema.visitor, 'stage_access_bundle', {});
    await record(schema.visitor, 'list_access_options', { teleport: true });
    await record(schema.visitor, 'list_access_options', { wheelchairWidthCm: 'wide' });
    await record(schema.visitor, 'find_access_bundle', { stepFree: true });
    await record(schema.visitor, 'check_access_route', {});
    await record(schema.visitor, 'check_access_route', { routeId: 'service-tunnel' });

    // Domain refusals, raised by the venue.
    const busy = createToolHarness();
    const found = JSON.parse(await toolNamed(busy.visitor, 'find_access_bundle').execute(FULL_REQUIREMENTS));
    await record(busy.visitor, 'find_access_bundle', FULL_REQUIREMENTS);
    await record(busy.visitor, 'stage_access_bundle', { planId: 'plan-never-issued', expectedVenueRevision: 1 });
    await record(busy.visitor, 'stage_access_bundle', { planId: found.plan.id, expectedVenueRevision: 99 });
    await record(busy.visitor, 'replan_access_bundle', { stalePlanId: found.plan.id });

    const invalidated = createToolHarness();
    const open = JSON.parse(await toolNamed(invalidated.visitor, 'find_access_bundle').execute(FULL_REQUIREMENTS));
    await toolNamed(invalidated.operator, 'report_facility_outage').execute({ facilityId: 'garden-lift', reasonCode: 'POWER_FAULT' });
    await record(invalidated.visitor, 'stage_access_bundle', {
      planId: open.plan.id,
      expectedVenueRevision: open.plan.basedOnRevision,
    });

    const deadEnd = createToolHarness();
    const doomed = JSON.parse(await toolNamed(deadEnd.visitor, 'find_access_bundle').execute(FULL_REQUIREMENTS));
    await toolNamed(deadEnd.visitor, 'stage_access_bundle').execute({
      planId: doomed.plan.id,
      expectedVenueRevision: doomed.plan.basedOnRevision,
    });
    takeBothLiftsOutOfService(deadEnd.store);
    await record(deadEnd.visitor, 'replan_access_bundle', { stalePlanId: doomed.plan.id });

    const booked = createToolHarness(storeWithBooking('agent-flow').store);
    await record(booked.visitor, 'find_access_bundle', FULL_REQUIREMENTS);
    await record(booked.visitor, 'clear_access_plan', { planId: 'plan-id-1' });

    assert.deepEqual(Object.fromEntries([...received].sort()), {
      ACTIVE_PLAN_EXISTS: 'CLEAR_THE_CURRENT_PLAN_OR_LET_THE_VISITOR_CONFIRM_IT',
      BOOKING_ALREADY_EXISTS: 'READ_THE_BOOKING_INSTEAD',
      INVALID_TOOL_ARGUMENT: 'READ_THE_TOOL_SCHEMA_AND_RETRY',
      MISSING_REQUIREMENTS: 'ASK_THE_VISITOR_FOR_THE_MISSING_REQUIREMENTS',
      MISSING_TOOL_ARGUMENTS: 'READ_THE_TOOL_SCHEMA_AND_RETRY',
      // Both NO_COMPLETE_BUNDLE refusals recorded above come from a venue with
      // every lift out, where no requirement value reopens anything. This code
      // is deliberately state-dependent now - the distance-only case still
      // answers CHANGE_REQUIREMENTS, and test/uat/dead-end-advice covers both.
      EXPECTED_RESOURCE_VERSION_MISMATCH: 'RETRY_WITH_THE_VENUE_REVISION',
      NO_COMPLETE_BUNDLE: 'CONTACT_VENUE_STAFF',
      PLAN_ALREADY_COMMITTED: 'READ_THE_BOOKING_INSTEAD',
      PLAN_NOT_FOUND: GENERIC_NEXT_ACTION,
      // Both carry a context-dependent action now, computed from what the plan
      // actually became. These two are the values the sequences above produce:
      // a plan already staged is replanned-into, and a committed one is not.
      PLAN_NOT_STAGEABLE: 'REPLAN',
      PLAN_NOT_STALE: 'STAGE_THE_PLAN_FOR_REVIEW',
      ROUTE_ID_REQUIRED: 'CALL_LIST_ACCESS_OPTIONS',
      ROUTE_NOT_FOUND: 'CALL_LIST_ACCESS_OPTIONS',
      // STALE_RESOURCE_VERSION is deliberately absent. It used to arrive here
      // from a revision number the AGENT invented, which was the defect: that
      // is the caller's arithmetic, not a venue change. The code is still
      // reachable - a venue that really moves under a prepared confirmation
      // produces it - but only through commitBundle, and no WebMCP tool can
      // confirm, so an agent cannot receive it any more. Measured: staging onto
      // a moved venue answers PLAN_NOT_STAGEABLE, because the outage has
      // already marked the plan stale. The human path is covered in
      // test/uat/booking.uat.test.mjs and test/uat/client-revision.uat.test.mjs.
      UNSUPPORTED_TOOL_ARGUMENT: 'READ_THE_TOOL_SCHEMA_AND_RETRY',
    });
  });

  test('every unmapped reachable refusal is one the domain computes for itself', async () => {
    // DEFECT. Both are reachable from the demo's own happy path. Staging a plan
    // the venue has just invalidated is the central scenario of this product,
    // and replanning something that is not stale is the obvious retry after it.
    // Neither is mapped, so both arrive as "read the current bundle status",
    // which tells the agent nothing it did not already know and does not
    // mention REPLAN or CLEAR.
    const mapped = await readMappedCodes();
    const reachable = [
      'ACTIVE_PLAN_EXISTS',
      'BOOKING_ALREADY_EXISTS',
      'EXPECTED_RESOURCE_VERSION_MISMATCH',
      'INVALID_TOOL_ARGUMENT',
      'MISSING_REQUIREMENTS',
      'MISSING_TOOL_ARGUMENTS',
      'NO_COMPLETE_BUNDLE',
      'PLAN_ALREADY_COMMITTED',
      'PLAN_NOT_FOUND',
      'PLAN_NOT_STAGEABLE',
      'PLAN_NOT_STALE',
      'ROUTE_ID_REQUIRED',
      'ROUTE_NOT_FOUND',
      'STALE_RESOURCE_VERSION',
      'UNSUPPORTED_TOOL_ARGUMENT',
    ];
    assert.deepEqual(
      reachable.filter((code) => !mapped.has(code)),
      // Every code left here is unmapped DELIBERATELY: the domain computes a
      // next action for each and ships it in the refusal, so a static entry
      // could only ever be right in some of its cases. The two that used to sit
      // here by neglect - PLAN_NOT_STAGEABLE and PLAN_NOT_STALE - now carry an
      // action derived from what the plan actually became, so they are gone.
      ['EXPECTED_RESOURCE_VERSION_MISMATCH', 'NO_COMPLETE_BUNDLE', 'PLAN_NOT_STAGEABLE', 'PLAN_NOT_STALE'],
      'the set of unmapped reachable refusals changed',
    );
    // Codes carried by a page that never receives them are the other half of
    // the same drift; PLAN_NOT_ACTIVE is unreachable, as asserted above.
    assert.equal(mapped.has('PLAN_NOT_ACTIVE'), true);
  });

  test('with both lifts out, the advertised next action cannot be carried out by any requirement change', () => {
    // The sweep behind the fix at the end of this block. NO_COMPLETE_BUNDLE
    // still tells the agent to CHANGE_REQUIREMENTS. When every lift is out of
    // service, LIFT_OPERATIONAL fails for both routes and no requirement in the
    // schema can waive it, so the whole legal requirement space is a dead end.
    // What changed is that the refusal now says so, in requirementChangeCanHelp.
    const store = takeBothLiftsOutOfService(freshStore());
    let combinations = 0;
    let feasible = 0;
    for (const wheelchairWidthCm of [45, 72, 95]) {
      for (const maxDistanceM of [20, 80, 500]) {
        for (const stepFree of [true, false]) {
          for (const companionCount of [0, 1]) {
            for (const entranceAssistance of [true, false]) {
              for (const lowStimulus of [true, false]) {
                combinations += 1;
                const evaluation = store.listAccessOptions({
                  wheelchairWidthCm,
                  maxDistanceM,
                  stepFree,
                  companionCount,
                  entranceAssistance,
                  lowStimulus,
                });
                feasible += evaluation.feasibleCount;
                for (const option of evaluation.options) {
                  assert.ok(
                    option.blockedBy.includes('LIFT_OPERATIONAL'),
                    `${option.routeId} was blocked by something a requirement could change`,
                  );
                }
              }
            }
          }
        }
      }
    }
    assert.equal(combinations, 144, 'the requirement space this test sweeps');
    assert.equal(feasible, 0, 'actual behaviour: no requirement change reaches a bookable bundle');
  });

  test('only the venue can reopen the dead end, and when it does the same advice starts working', () => {
    // The positive control for the defect above: CHANGE_REQUIREMENTS is not
    // wrong in general, it is wrong when LIFT_OPERATIONAL is the blocking rule.
    const store = takeBothLiftsOutOfService(freshStore());
    assert.equal(store.listAccessOptions(demoDefaults).feasibleCount, 0);

    store.restoreFacility('garden-lift');
    const relaxed = store.listAccessOptions({ ...demoDefaults, maxDistanceM: 80 });
    assert.equal(relaxed.feasibleCount, 1, 'restoring a lift is what actually reopens the venue');
    assert.equal(relaxed.options.find((option) => option.feasible).routeId, 'garden-lift-route');

    const plan = store.findBundle(demoDefaults);
    assert.equal(plan.routeId, 'garden-lift-route', 'the planner agrees with the read-only evaluation');
  });

  test('a dead-end refusal names the rule that closed the venue and says a requirement change cannot reach it', () => {
    // The fix for the defect swept above. nextAction stays CHANGE_REQUIREMENTS -
    // it is the right advice in the ordinary case, and the domain suite, the
    // browser suite and the incident line in the page are all built on it - but
    // the refusal now carries the diagnosis the planner already had, so an agent
    // can tell "relax a requirement" apart from "wait for the venue".
    const store = takeBothLiftsOutOfService(freshStore());
    const refused = refusalFrom(() => store.findBundle(demoDefaults));
    assertDomainRefusal(refused, { code: 'NO_COMPLETE_BUNDLE', status: 422 });
    assert.deepEqual(refused.details.blockedBy, ['LIFT_OPERATIONAL']);
    assert.equal(refused.details.requirementChangeCanHelp, false, 'no requirement value reaches a lift outage');
    assert.equal(store.snapshot().phase, 'READY', 'the refused search still opens no plan');
  });

  test('a refusal a requirement change really can fix says so, including while one lift is out', () => {
    // The control that stops the flag degenerating into a constant. The middle
    // case is the one a bare list of blocked rules gets wrong: East is out AND
    // too far, so LIFT_OPERATIONAL is among the blockers, yet relaxing the
    // distance still opens Garden and the advice is worth following. The third
    // case has the identical blocked rules and no way out.
    const tooFar = refusalFrom(() => freshStore().findBundle({ ...demoDefaults, maxDistanceM: 20 }));
    assert.deepEqual(tooFar.details.blockedBy, ['ROUTE_DISTANCE']);
    assert.equal(tooFar.details.requirementChangeCanHelp, true);

    const oneLiftOut = freshStore();
    oneLiftOut.setFacilityOutage('east-lift', 'POWER_FAULT');
    const partial = refusalFrom(() => oneLiftOut.findBundle({ ...demoDefaults, maxDistanceM: 20 }));
    assert.deepEqual(partial.details.blockedBy, ['LIFT_OPERATIONAL', 'ROUTE_DISTANCE']);
    assert.equal(partial.details.requirementChangeCanHelp, true, 'Garden is only too far, and distance is a requirement');

    const dead = refusalFrom(() => takeBothLiftsOutOfService(freshStore())
      .findBundle({ ...demoDefaults, maxDistanceM: 20 }));
    assert.deepEqual(dead.details.blockedBy, ['LIFT_OPERATIONAL', 'ROUTE_DISTANCE']);
    assert.equal(dead.details.requirementChangeCanHelp, false, 'the same blocked rules, and now nothing to relax');
  });

  test('replanning into the dead end carries the same diagnosis without moving the next action', () => {
    const { store, plan } = storeWithStagedPlan();
    takeBothLiftsOutOfService(store);
    const refused = refusalFrom(() => store.replanBundle(plan.id));
    assertDomainRefusal(refused, { code: 'NO_COMPLETE_BUNDLE', status: 422 });
    // This used to assert CHANGE_REQUIREMENTS and call it "deliberately
    // unchanged". It was deliberate and it was wrong: the same refusal carried
    // requirementChangeCanHelp: false one field away, so the advice contradicted
    // its own diagnosis and an agent following it would loop. The replan path
    // also overwrote the diagnosis it had just caught.
    assert.equal(refused.details.requirementChangeCanHelp, false);
    assert.equal(refused.details.nextAction, 'CONTACT_VENUE_STAFF', 'the advice must follow the diagnosis');
    assert.deepEqual(refused.details.blockedBy, ['LIFT_OPERATIONAL']);
    assert.equal(store.snapshot().phase, 'NO_ALTERNATIVE');
  });

  test('the explain tool passes on the two fields an agent decides with', async () => {
    // Dropping blockedBy and requirementChangeCanHelp from the tool's output
    // survived the whole gate. Both are computed and both were being discarded
    // at the last step, which leaves an agent unable to tell a dead end it can
    // act on from one only the venue can open - the reason to call this tool.
    const harness = createToolHarness();
    takeBothLiftsOutOfService(harness.store);
    await refusalFromTool(harness.visitor, 'find_access_bundle', FULL_REQUIREMENTS);

    const raw = await toolNamed(harness.visitor, 'explain_access_refusal').execute({});
    const explained = JSON.parse(raw);
    assert.equal(explained.blocked, true);
    assert.deepEqual(explained.blockedBy, ['LIFT_OPERATIONAL'], 'the tool dropped the blocked rules');
    assert.equal(explained.requirementChangeCanHelp, false, 'the tool dropped whether a requirement change helps');
    assert.equal(explained.nextAction, 'CONTACT_VENUE_STAFF');
    assert.ok(raw.length <= TOOL_LIMITS.outputChars, `the explanation outgrew the output budget at ${raw.length}`);
  });

  test('the tool named for a refusal is registered where the first refusal happens', async () => {
    // This test used to pin the defect. It asserted that explain_access_refusal
    // is NOT available in READY and called that "the gap this test exists for",
    // which is a true description of the behaviour and a poor contract: from a
    // fresh visit with both lifts down, the first search refuses without opening
    // a plan, the phase stays READY, and the one tool named for that exact
    // question was not on the surface. An agent had to already hold a plan to be
    // allowed to ask why it had been refused.
    //
    // It is registered in READY now. The refusal must still carry the answer on
    // its own and still fit the output budget - a tool being available is not a
    // reason for the refusal to get vaguer.
    const harness = createToolHarness();
    takeBothLiftsOutOfService(harness.store);
    assert.equal(harness.store.snapshot().phase, 'READY');

    const explain = toolNamed(harness.visitor, 'explain_access_refusal');
    assert.equal(explain.availableIn.includes('READY'), true, 'the refusal tool is missing where refusals start');
    assert.equal(explain.availableIn.includes('PLAN_STALE'), true, 'the tool is not absent from every both-lifts-down state');

    const raw = await toolNamed(harness.visitor, 'find_access_bundle').execute(FULL_REQUIREMENTS);
    assert.ok(raw.length <= TOOL_LIMITS.outputChars, `the refusal outgrew the output budget at ${raw.length} characters`);

    const refused = await refusalFromTool(harness.visitor, 'find_access_bundle', FULL_REQUIREMENTS);
    assert.equal(refused.error, 'NO_COMPLETE_BUNDLE');
    assert.deepEqual(refused.blockedBy, ['LIFT_OPERATIONAL']);
    assert.equal(refused.requirementChangeCanHelp, false);
    assert.equal(
      refused.nextAction,
      'CONTACT_VENUE_STAFF',
      'no requirement value restores a lift, so the tool must not advise changing them',
    );
    assert.equal(harness.store.snapshot().phase, 'READY', 'a refused search still opens no plan');
  });
});
