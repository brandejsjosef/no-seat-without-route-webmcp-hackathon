/**
 * WebMCP tool surface for No Seat Without a Route.
 *
 * The definitions live here, apart from the page, for two reasons:
 *  - the browser registers them against `document.modelContext`;
 *  - Node can import the same objects and check them against the published
 *    tool-authoring limits without opening a browser (see evals/contract.mjs).
 *
 * Only `readOnlyHint` and `untrustedContentHint` are used. Other annotation
 * names discussed publicly are not in the live specification.
 */

/** Limits published in Chrome's WebMCP tool-authoring guidance. */
export const TOOL_LIMITS = Object.freeze({
  nameChars: 30,
  descriptionChars: 500,
  parameterDescriptionChars: 150,
  outputChars: 1536,
});

/** Every phase the visitor page can be in. Used to validate registration rules. */
export const PHASES = Object.freeze([
  'READY',
  'PLAN_READY',
  'AWAITING_HUMAN_CONFIRMATION',
  'PLAN_STALE',
  'REPLAN_READY',
  'NO_ALTERNATIVE',
  'CONFIRMED',
]);

const REQUIREMENT_PROPERTIES = Object.freeze({
  wheelchairWidthCm: { type: 'number', minimum: 45, maximum: 95, description: 'Width of the mobility aid in centimetres.' },
  maxDistanceM: { type: 'number', minimum: 20, maximum: 500, description: 'Longest acceptable street-to-seat route in metres.' },
  stepFree: { type: 'boolean', description: 'True when every segment must avoid steps.' },
  companionCount: { type: 'integer', enum: [0, 1], description: 'Adjacent companion seats needed, either 0 or 1.' },
  entranceAssistance: { type: 'boolean', description: 'True when a host must meet the visitor at the entrance.' },
  lowStimulus: { type: 'boolean', description: 'True to avoid the busiest foyer.' },
});

const REQUIREMENT_NAMES = Object.freeze(Object.keys(REQUIREMENT_PROPERTIES));
const ACCESS_ROUTE_IDS = Object.freeze(['east-lift-route', 'garden-lift-route']);
const FACILITY_IDS = Object.freeze(['east-lift', 'garden-lift']);

const NO_INPUT = Object.freeze({ type: 'object', properties: {}, additionalProperties: false });

function requirementSchema({ required = false } = {}) {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: structuredClone(REQUIREMENT_PROPERTIES),
  };
  if (required) schema.required = [...REQUIREMENT_NAMES];
  return schema;
}

/**
 * What an agent should do about a refusal, keyed by the server's error code.
 * The server already explains stale revisions itself; these cover the rest.
 */
// A fallback for refusals that carry no diagnosis of their own. NO_COMPLETE_BUNDLE
// is deliberately absent: the domain always computes whether a requirement change
// can reopen the venue, so a static entry here could only ever be right half the
// time - and it was the line that told an agent to change requirements in a venue
// where no requirement value helps.
const NEXT_ACTION_BY_CODE = Object.freeze({
  ACTIVE_PLAN_EXISTS: 'CLEAR_THE_CURRENT_PLAN_OR_LET_THE_VISITOR_CONFIRM_IT',
  BOOKING_ALREADY_EXISTS: 'READ_THE_BOOKING_INSTEAD',
  STALE_RESOURCE_VERSION: 'REPLAN',
  BUNDLE_NO_LONGER_FEASIBLE: 'REPLAN',
  PLAN_NOT_FOUND: 'READ_THE_CURRENT_BUNDLE_STATUS',
  PLAN_NOT_ACTIVE: 'READ_THE_CURRENT_BUNDLE_STATUS',
  PLAN_ALREADY_COMMITTED: 'READ_THE_BOOKING_INSTEAD',
  MISSING_REQUIREMENTS: 'ASK_THE_VISITOR_FOR_THE_MISSING_REQUIREMENTS',
  ROUTE_ID_REQUIRED: 'CALL_LIST_ACCESS_OPTIONS',
  ROUTE_NOT_FOUND: 'CALL_LIST_ACCESS_OPTIONS',
  MISSING_TOOL_ARGUMENTS: 'READ_THE_TOOL_SCHEMA_AND_RETRY',
  INVALID_TOOL_ARGUMENT: 'READ_THE_TOOL_SCHEMA_AND_RETRY',
  UNSUPPORTED_TOOL_ARGUMENT: 'READ_THE_TOOL_SCHEMA_AND_RETRY',
  ROLE_FORBIDDEN: 'USE_THE_OTHER_ROLE_SURFACE',
});

/**
 * A thrown error reaches the agent as an opaque browser failure - Chrome
 * reports it as an unknown transient reason, which tells the agent nothing.
 * Refusals are returned as ordinary results instead, so the agent can read the
 * reason and correct itself rather than retrying a call that cannot succeed.
 */
function refusal(error) {
  const details = error?.details ?? {};
  return compactJson({
    ok: false,
    error: error?.code ?? 'REQUEST_FAILED',
    // `??` keeps an empty string, which is neither null nor undefined, so an
    // Error carrying no wording handed the agent an empty message. A refusal
    // with nothing in it is the one thing a refusal may not be.
    message: (typeof error?.message === 'string' && error.message.trim())
      ? error.message
      : 'The request could not be completed.',
    nextAction: details.nextAction ?? NEXT_ACTION_BY_CODE[error?.code] ?? 'READ_THE_CURRENT_BUNDLE_STATUS',
    ...(details.activePlanId ? { activePlanId: details.activePlanId } : {}),
    ...(details.currentResourceVersion ? { venueRevision: details.currentResourceVersion } : {}),
    ...(details.planResourceVersion ? { planRevision: details.planResourceVersion } : {}),
    ...(details.missing ? { missing: details.missing } : {}),
    ...(details.argument ? { argument: details.argument } : {}),
    ...(details.allowed ? { allowed: details.allowed } : {}),
    ...(details.knownRouteIds ? { knownRouteIds: details.knownRouteIds } : {}),
    // What the plan actually became, for the two refusals whose next action is
    // computed from it. Without it the agent is told to replan without being
    // told why replanning is the answer.
    ...(details.planStatus ? { planStatus: details.planStatus } : {}),
    // One name, because the venue produces one number. Staging refuses before
    // any confirmation exists, and at commit this code is raised only on the
    // branch where the venue has not moved - so the confirmation's revision and
    // the venue's are the same number, and calling it a "confirmation revision"
    // named something an agent could not obtain at staging time.
    ...(typeof details.venueResourceVersion === 'number'
      ? { venueRevision: details.venueResourceVersion }
      : {}),
    ...(typeof details.partialReservations === 'number' ? { partialReservations: details.partialReservations } : {}),
    ...pickDiagnosis(details),
  });
}

/**
 * The venue's diagnosis travels as a unit.
 *
 * Named once, read by every surface that forwards it. Listing the fields at
 * each surface meant a field added to the diagnosis had to be added in four
 * more places or it was silently dropped, which happened twice - most recently
 * to `shortestFeasibleDistanceM`, the only value that turns "no plan" into a
 * distance worth asking for.
 *
 * An empty array carries no information and is omitted, which is what the
 * hand-written version did for `blockedBy`.
 */
export const DIAGNOSIS_FIELDS = Object.freeze([
  'blockedBy',
  'requirementChangeCanHelp',
  'nextAction',
  'shortestFeasibleDistanceM',
]);

export function pickDiagnosis(source = {}) {
  return Object.fromEntries(
    DIAGNOSIS_FIELDS
      .filter((field) => source?.[field] !== undefined && !(Array.isArray(source[field]) && source[field].length === 0))
      .map((field) => [field, source[field]]),
  );
}

function validationError(code, message, details = {}) {
  return { code, message, details };
}

/**
 * JSON Schema helps the model form a call, but Chrome deliberately does not
 * promise to reject a malformed call. Validate the small schema subset used by
 * this page before a doomed request can create a noisy 4xx in DevTools.
 */
function validateToolInput(tool, input) {
  const value = input === undefined ? {} : input;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return validationError('INVALID_TOOL_ARGUMENT', 'Tool input must be a JSON object.');
  }

  const schema = tool.inputSchema ?? NO_INPUT;
  const properties = schema.properties ?? {};
  const unknown = Object.keys(value).filter((name) => !Object.hasOwn(properties, name));
  if (schema.additionalProperties === false && unknown.length) {
    return validationError(
      'UNSUPPORTED_TOOL_ARGUMENT',
      `Unsupported tool argument: ${unknown[0]}.`,
      { argument: unknown[0], allowed: Object.keys(properties) },
    );
  }

  const missing = (schema.required ?? []).filter((name) => {
    const candidate = value[name];
    return candidate === undefined || candidate === null || (typeof candidate === 'string' && candidate.trim() === '');
  });
  if (missing.length) {
    if (tool.name === 'find_access_bundle') {
      return validationError(
        'MISSING_REQUIREMENTS',
        `State every requirement explicitly. Missing: ${missing.join(', ')}.`,
        { missing },
      );
    }
    if (tool.name === 'check_access_route' && missing.includes('routeId')) {
      return validationError(
        'ROUTE_ID_REQUIRED',
        'Choose a routeId returned by list_access_options before checking one route.',
        { missing: ['routeId'] },
      );
    }
    return validationError(
      'MISSING_TOOL_ARGUMENTS',
      `Required tool arguments are missing: ${missing.join(', ')}.`,
      { missing },
    );
  }

  for (const [name, candidate] of Object.entries(value)) {
    const definition = properties[name];
    const typeMatches = definition.type === 'number'
      ? typeof candidate === 'number' && Number.isFinite(candidate)
      : definition.type === 'integer'
        ? Number.isInteger(candidate)
        : definition.type === 'boolean'
          ? typeof candidate === 'boolean'
          : definition.type === 'string'
            ? typeof candidate === 'string'
            : true;
    if (!typeMatches) {
      return validationError(
        'INVALID_TOOL_ARGUMENT',
        `Send "${name}" as ${definition.type === 'integer' ? 'an integer' : `a ${definition.type}`}.`,
        { argument: name },
      );
    }
    if (typeof candidate === 'number'
      && ((definition.minimum !== undefined && candidate < definition.minimum)
        || (definition.maximum !== undefined && candidate > definition.maximum))) {
      return validationError(
        'INVALID_TOOL_ARGUMENT',
        `Send "${name}" as a value between ${definition.minimum} and ${definition.maximum}.`,
        { argument: name },
      );
    }
    if (definition.enum && !definition.enum.includes(candidate)) {
      if (name === 'routeId') {
        return validationError(
          'ROUTE_NOT_FOUND',
          'Choose a routeId returned by list_access_options.',
          { argument: name, knownRouteIds: definition.enum },
        );
      }
      return validationError(
        'INVALID_TOOL_ARGUMENT',
        `Send "${name}" as one of the allowed values.`,
        { argument: name, allowed: definition.enum },
      );
    }
  }
  return null;
}

/** Applies the refusal contract to every tool on a surface. */
function withRefusalContract(tools) {
  return tools.map((tool) => ({
    ...tool,
    execute: async (input, options) => {
      try {
        const invalid = validateToolInput(tool, input);
        if (invalid) return refusal(invalid);
        return await tool.execute(input, options);
      } catch (error) {
        return refusal(error);
      }
    },
  }));
}

/** Keeps a tool result inside the published output budget. */
export function compactJson(value) {
  const text = JSON.stringify(value);
  if (text.length <= TOOL_LIMITS.outputChars) return text;
  return JSON.stringify({
    truncated: true,
    reason: 'RESULT_TOO_LARGE',
    hint: 'Call a narrower tool, such as check_access_route for one route.',
  });
}

function planDigest(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    status: plan.status,
    kind: plan.kind,
    basedOnRevision: plan.basedOnResourceVersion,
    route: plan.route.path,
    distanceM: plan.route.distanceM,
    durationMinutes: plan.route.durationMinutes,
    resources: plan.claims.map((claim) => claim.label),
    requiresHumanConfirmation: true,
  };
}

function stateDigest(state, plan = state.activePlan) {
  return {
    phase: state.phase,
    venueRevision: state.resourceVersion,
    plan: planDigest(plan),
    booking: state.booking
      ? {
          reference: state.booking.receipt,
          committedRevision: state.booking.committedResourceVersion,
          partialReservations: state.booking.partialReservations,
        }
      : null,
  };
}

function optionDigest(option) {
  const digest = {
    routeId: option.routeId,
    label: option.label,
    feasible: option.feasible,
    distanceM: option.distanceM,
    durationMinutes: option.durationMinutes,
  };
  if (!option.feasible) {
    digest.blockedBy = option.blockedBy;
    digest.reasons = option.checks.filter((check) => !check.ok).map((check) => check.detail);
  }
  return digest;
}

/** Every tool call carries its own name, so the server can record who acted. */
function taggedCall(api) {
  return (toolName, path, options = {}) =>
    api(path, { ...options, headers: { ...options.headers, 'X-WebMCP-Tool': toolName } });
}

/**
 * Visitor booking surface.
 *
 * `deps` keeps this module free of DOM and network specifics so the same
 * definitions can be checked in Node:
 *   api(path, options)  -> parsed JSON, throws on a non-2xx response
 *   refresh()           -> latest state snapshot, also repaints the page
 *   trace(channel, tool, result) -> optional activity line for the UI
 */
export function createVisitorTools({ api, refresh, trace = () => {} }) {
  const call = taggedCall(api);

  return withRefusalContract([
    {
      name: 'get_event_access_state',
      description:
        'Read the live venue revision, the status of every lift, how many resources are currently reserved, and which phase the access plan is in. Call this first to learn what can be planned right now.',
      inputSchema: NO_INPUT,
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      availableIn: PHASES,
      execute: async () => {
        const state = await refresh();
        trace('WebMCP browser agent', 'get_event_access_state', `read rev ${state.resourceVersion}`);
        // This snapshot counts resources that are currently reserved. It must
        // not be labelled as a partial write: a successful atomic bundle has
        // three reserved resources and zero partial reservations. The latter is
        // reported with the booking/refusal where that invariant is meaningful.
        return compactJson({
          phase: state.phase,
          venueRevision: state.resourceVersion,
          facilities: Object.values(state.resources)
            .filter((resource) => resource.kind === 'FACILITY')
            .map(({ id, label, status }) => ({ id, label, status })),
          reservedResourceCount: state.atomicity.reservedResourceCount,
        });
      },
    },
    {
      name: 'get_access_bundle_status',
      description:
        'Read the plan or booking that is currently on the page, including the venue revision it was built against and whether every part was committed together.',
      inputSchema: NO_INPUT,
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      availableIn: PHASES,
      execute: async () => {
        const state = await refresh();
        trace('WebMCP browser agent', 'get_access_bundle_status', `read ${state.phase.toLowerCase()}`);
        return compactJson(stateDigest(state));
      },
    },
    {
      name: 'list_access_options',
      description:
        'Compare every arrival route against access requirements and return which ones currently work, and for the others exactly which rule fails. Changes nothing, so it is safe to call before deciding.',
      inputSchema: requirementSchema(),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      availableIn: PHASES,
      execute: async (requirements = {}, { signal } = {}) => {
        const payload = await call('list_access_options', '/api/access-options', {
          method: 'POST',
          body: JSON.stringify({ requirements }),
          signal,
        });
        trace('WebMCP browser agent', 'list_access_options', `${payload.evaluation.feasibleCount} of ${payload.evaluation.options.length} routes work`);
        return compactJson({
          venueRevision: payload.evaluation.venueRevision,
          // The venue fills in every requirement the caller left out, so an
          // answer computed against six limits was returned as if it were about
          // the one that was asked. A feasible route means nothing without the
          // set it is feasible against.
          requirements: payload.evaluation.requirements,
          feasibleCount: payload.evaluation.feasibleCount,
          options: payload.evaluation.options.map(optionDigest),
        });
      },
    },
    {
      name: 'check_access_route',
      description:
        'Check one named arrival route against access requirements and return a pass or fail for each rule, such as step-free travel, doorway width, lift status and companion seat availability.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          routeId: { type: 'string', enum: [...ACCESS_ROUTE_IDS], description: 'Route identifier returned by list_access_options.' },
          ...structuredClone(REQUIREMENT_PROPERTIES),
        },
        required: ['routeId'],
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      availableIn: PHASES,
      execute: async ({ routeId, ...requirements } = {}, { signal } = {}) => {
        const payload = await call('check_access_route', `/api/access-routes/${encodeURIComponent(routeId)}/check`, {
          method: 'POST',
          body: JSON.stringify({ requirements }),
          signal,
        });
        const { evaluation } = payload;
        trace('WebMCP browser agent', 'check_access_route', evaluation.feasible ? `${evaluation.label} works` : `${evaluation.label} blocked`);
        return compactJson({
          routeId: evaluation.routeId,
          label: evaluation.label,
          feasible: evaluation.feasible,
          venueRevision: evaluation.venueRevision,
          // The same reason as list_access_options, which was fixed and left its
          // sibling behind: routeId is the only required property, so the venue
          // fills in five limits the caller never stated - and stepFree and
          // lowStimulus cannot be read back out of the checks, because those are
          // emitted ok:true whether or not they were required.
          requirements: evaluation.requirements,
          checks: evaluation.checks.map((check) => ({ rule: check.rule, ok: check.ok, detail: check.detail })),
        });
      },
    },
    {
      name: 'explain_access_refusal',
      description:
        'Explain why the current plan was refused: the revision mismatch, any rules that failed, how many resources were reserved, which routes still work and what to do next. A refusal caused only by a revision change has no failed rule to report. Use it instead of retrying a rejected call.',
      inputSchema: NO_INPUT,
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      // READY is where the first refusal actually happens. With both lifts out,
      // find_access_bundle refuses without opening a plan and the phase never
      // moves, so the tool named for that question used to require already
      // holding a plan before an agent was allowed to ask it.
      availableIn: ['READY', 'PLAN_STALE', 'NO_ALTERNATIVE'],
      execute: async () => {
        const payload = await call('explain_access_refusal', '/api/explain', { method: 'GET' });
        const { explanation } = payload;
        trace('WebMCP browser agent', 'explain_access_refusal', explanation.errorCode ?? 'nothing blocked');
        return compactJson({
          blocked: explanation.blocked,
          errorCode: explanation.errorCode ?? null,
          planRevision: explanation.planRevision ?? null,
          venueRevision: explanation.venueRevision,
          brokenRules: (explanation.brokenRules ?? []).map((rule) => ({ rule: rule.rule, detail: rule.detail })),
          partialReservations: explanation.partialReservations ?? 0,
          validOptionsNow: explanation.validOptionsNow ?? [],
          nextAction: explanation.nextAction ?? null,
          // The whole diagnosis, not a hand-picked subset. Two of these fields
          // were computed and dropped here once; the third, the shortest route
          // the venue actually has, was dropped the same way after they were
          // fixed - because the fix listed field names instead of removing the
          // list. An agent asking this tool how to correct itself is now told
          // everything the venue worked out about the refusal.
          ...pickDiagnosis(explanation),
        });
      },
    },
    {
      name: 'find_access_bundle',
      description:
        'Search for one complete plan that satisfies every stated requirement at once: arrival route, working lift, wheelchair space, companion seat and entrance assistance. Every requirement must be stated explicitly. Reserves nothing.',
      inputSchema: requirementSchema({ required: true }),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      availableIn: ['READY'],
      execute: async (requirements = {}, { signal } = {}) => {
        const payload = await call('find_access_bundle', '/api/plans', {
          method: 'POST',
          body: JSON.stringify({ requirements }),
          signal,
        });
        const state = await refresh();
        trace('WebMCP browser agent', 'find_access_bundle', `option found · rev ${payload.state.resourceVersion}`);
        return compactJson(stateDigest(state, payload.plan));
      },
    },
    {
      name: 'stage_access_bundle',
      description:
        'Recheck a proposed plan against the live venue and prepare it for the visitor to review. Fails when the venue revision moved on. This never issues a ticket and never reserves a seat.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          planId: { type: 'string', description: 'Plan identifier returned by find_access_bundle.' },
          expectedVenueRevision: { type: 'integer', description: 'Venue revision the plan was built against.' },
        },
        required: ['planId', 'expectedVenueRevision'],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      availableIn: ['PLAN_READY'],
      execute: async ({ planId, expectedVenueRevision }, { signal } = {}) => {
        const payload = await call('stage_access_bundle', `/api/plans/${encodeURIComponent(planId)}/stage`, {
          method: 'POST',
          body: JSON.stringify({ expectedResourceVersion: expectedVenueRevision }),
          signal,
        });
        const state = await refresh();
        trace('WebMCP browser agent', 'stage_access_bundle', 'ready for the visitor to review');
        return compactJson(stateDigest(state, payload.plan));
      },
    },
    {
      name: 'replan_access_bundle',
      description:
        'Build a replacement plan for a refused one, keeping the same requirements and using the venue as it is now. Prepares the alternative for the visitor to review.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stalePlanId: { type: 'string', description: 'Identifier of the plan the venue invalidated.' },
        },
        required: ['stalePlanId'],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      availableIn: ['PLAN_STALE'],
      execute: async ({ stalePlanId }, { signal } = {}) => {
        try {
          const payload = await call('replan_access_bundle', `/api/plans/${encodeURIComponent(stalePlanId)}/replan`, {
            method: 'POST',
            body: '{}',
            signal,
          });
          const state = await refresh();
          trace('WebMCP browser agent', 'replan_access_bundle', `replacement ready · rev ${payload.state.resourceVersion}`);
          return compactJson(stateDigest(state, payload.plan));
        } catch (error) {
          await refresh();
          trace('WebMCP browser agent', 'replan_access_bundle', 'no complete alternative');
          throw error;
        }
      },
    },
    {
      name: 'clear_access_plan',
      description:
        'Discard the plan on the page so the visitor can change their requirements. Works only before confirmation and never affects an existing booking.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          planId: { type: 'string', description: 'Identifier of the plan currently on the page.' },
        },
        required: ['planId'],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      availableIn: ['PLAN_READY', 'AWAITING_HUMAN_CONFIRMATION', 'REPLAN_READY', 'NO_ALTERNATIVE'],
      execute: async ({ planId }, { signal } = {}) => {
        await call('clear_access_plan', `/api/plans/${encodeURIComponent(planId)}/clear`, {
          method: 'POST',
          body: '{}',
          signal,
        });
        const state = await refresh();
        trace('WebMCP browser agent', 'clear_access_plan', 'requirements editable again');
        return compactJson({
          phase: state.phase,
          venueRevision: state.resourceVersion,
          bookingCreated: false,
          nextAction: 'ASK_VISITOR_FOR_NEW_REQUIREMENTS',
        });
      },
    },
  ]);
}

/**
 * Venue operations surface. A different page, a different role and a
 * different set of tools over the same live venue state.
 */
export function createOperatorTools({ api, refresh, trace = () => {} }) {
  const call = taggedCall(api);

  return withRefusalContract([
    {
      name: 'get_facility_status',
      description:
        'Read every lift the venue operates, with its current service status and the venue revision that status belongs to.',
      inputSchema: NO_INPUT,
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      availableIn: PHASES,
      execute: async () => {
        const state = await refresh();
        trace('WebMCP operator agent', 'get_facility_status', `read rev ${state.resourceVersion}`);
        return compactJson({
          venueRevision: state.resourceVersion,
          facilities: Object.values(state.resources)
            .filter((resource) => resource.kind === 'FACILITY')
            .map(({ id, label, status }) => ({ id, label, status })),
        });
      },
    },
    {
      name: 'report_facility_outage',
      description:
        'Report a lift out of service. If its status changes, the venue revision advances and every open plan goes stale, including plans routed over a different lift. Reporting an outage that is already in force changes nothing and leaves the revision where it was. An existing booking record is neither cancelled nor rewritten. If that booking uses the reported lift, its stored route then names a facility that is unavailable; a booking routed over another lift is unchanged.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          facilityId: { type: 'string', enum: [...FACILITY_IDS], description: 'Facility identifier, for example east-lift.' },
          reasonCode: {
            type: 'string',
            enum: ['LIFT_DOOR_FAULT', 'POWER_FAULT', 'SAFETY_INSPECTION'],
            description: 'Operational reason the lift left service.',
          },
        },
        required: ['facilityId', 'reasonCode'],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      availableIn: PHASES,
      execute: async ({ facilityId, reasonCode }, { signal } = {}) => {
        const payload = await call('report_facility_outage', `/api/operator/facilities/${encodeURIComponent(facilityId)}/outage`, {
          method: 'POST',
          body: JSON.stringify({ reasonCode }),
          signal,
        });
        trace('WebMCP operator agent', 'report_facility_outage', `rev ${payload.state.resourceVersion}`);
        return compactJson({
          venueRevision: payload.state.resourceVersion,
          facility: facilityId,
          status: payload.state.resources[facilityId]?.status ?? 'UNKNOWN',
        });
      },
    },
    {
      name: 'restore_facility',
      description:
        'Return a lift to service after an outage. If the lift really was out, the venue revision advances and every open plan goes stale, so the page and any agent both re-read on their next call. A lift that is in service but ARMED for the demo fault is a third case: the fault is disarmed and recorded, the lift never left service, and the revision does NOT move - so open plans stay valid. A lift that is in service and not armed is left alone and nothing is recorded.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          facilityId: { type: 'string', enum: [...FACILITY_IDS], description: 'Facility identifier, for example east-lift.' },
        },
        required: ['facilityId'],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      availableIn: PHASES,
      execute: async ({ facilityId }, { signal } = {}) => {
        const payload = await call('restore_facility', `/api/operator/facilities/${encodeURIComponent(facilityId)}/restore`, {
          method: 'POST',
          body: '{}',
          signal,
        });
        trace('WebMCP operator agent', 'restore_facility', `rev ${payload.state.resourceVersion}`);
        return compactJson({
          venueRevision: payload.state.resourceVersion,
          facility: facilityId,
          status: payload.state.resources[facilityId]?.status ?? 'UNKNOWN',
        });
      },
    },
  ]);
}

/** Tools a surface exposes in one page state. */
export function toolsForPhase(tools, phase) {
  return tools.filter((tool) => tool.availableIn.includes(phase));
}

/** Read and write counts, matching what a browser shows in its site-tools panel. */
export function toolCounts(tools) {
  const read = tools.filter((tool) => tool.annotations.readOnlyHint).length;
  return { total: tools.length, read, write: tools.length - read };
}
