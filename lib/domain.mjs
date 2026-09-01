import { randomUUID } from 'node:crypto';

const ROUTES = Object.freeze([
  {
    id: 'east-lift-route',
    label: 'East Entrance route',
    entrance: 'East Entrance',
    entranceCode: 'EAST',
    liftId: 'east-lift',
    liftLabel: 'East Lift L2',
    assistanceId: 'assist-east-1905',
    assistanceLabel: 'Host at East Entrance · 7:05 PM',
    distanceM: 64,
    durationMinutes: 6,
    minWidthCm: 94,
    stepFree: true,
    lowStimulus: true,
    path: ['East Entrance', 'Quiet lobby', 'East Lift L2', 'Level 2', 'W12 + W13'],
  },
  {
    id: 'garden-lift-route',
    label: 'Garden Entrance route',
    entrance: 'Garden Entrance',
    entranceCode: 'GARDEN',
    liftId: 'garden-lift',
    liftLabel: 'Garden Lift L4',
    assistanceId: 'assist-garden-1903',
    assistanceLabel: 'Host at Garden Entrance · 7:03 PM',
    distanceM: 78,
    durationMinutes: 8,
    minWidthCm: 86,
    stepFree: true,
    lowStimulus: true,
    path: ['Garden Entrance', 'Covered ramp', 'Garden Lift L4', 'Level 2', 'W12 + W13'],
  },
]);

const BASE_RESOURCES = Object.freeze({
  'east-lift': { id: 'east-lift', kind: 'FACILITY', label: 'East Lift L2', status: 'OPERATIONAL', reservable: false },
  'garden-lift': { id: 'garden-lift', kind: 'FACILITY', label: 'Garden Lift L4', status: 'OPERATIONAL', reservable: false },
  'space-w12': { id: 'space-w12', kind: 'WHEELCHAIR_SPACE', label: 'Wheelchair space W12', status: 'AVAILABLE', reservable: true },
  'seat-w13': { id: 'seat-w13', kind: 'COMPANION_SEAT', label: 'Companion seat W13', status: 'AVAILABLE', reservable: true, adjacentTo: 'space-w12' },
  'assist-east-1905': { id: 'assist-east-1905', kind: 'ASSISTANCE', label: 'Host at East Entrance · 7:05 PM', status: 'AVAILABLE', reservable: true },
  'assist-garden-1903': { id: 'assist-garden-1903', kind: 'ASSISTANCE', label: 'Host at Garden Entrance · 7:03 PM', status: 'AVAILABLE', reservable: true },
});

const DEFAULT_REQUIREMENTS = Object.freeze({
  wheelchairWidthCm: 72,
  maxDistanceM: 80,
  stepFree: true,
  companionCount: 1,
  entranceAssistance: true,
  lowStimulus: true,
});

const OUTAGE_REASONS = Object.freeze({
  LIFT_DOOR_FAULT: 'Lift door fault reported by venue operations.',
  POWER_FAULT: 'Lift power fault reported by venue operations.',
  SAFETY_INSPECTION: 'Lift removed from service for a safety inspection.',
});

export class DomainError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function clone(value) {
  return structuredClone(value);
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function normalizeRequirements(input = {}, { requireAll = false } = {}) {
  const allowedKeys = new Set(Object.keys(DEFAULT_REQUIREMENTS));
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      // A fragment with no full stop, rendered verbatim by the page, showed a
      // half-finished line to the customer. The name is quoted so an unusual
      // one reads as a quotation rather than as broken grammar.
      throw new DomainError(
        'UNSUPPORTED_REQUIREMENT',
        `This venue has no access requirement called "${key}".`,
        422,
        { key },
      );
    }
  }
  // Browsing routes may leave gaps; booking one may not. Filling in an access
  // requirement nobody asked for is the failure this whole page exists to
  // prevent, so it is refused here, on the server, for every channel.
  if (requireAll) {
    const missing = [...allowedKeys].filter((key) => input[key] === undefined || input[key] === null);
    if (missing.length) {
      throw new DomainError(
        'MISSING_REQUIREMENTS',
        `State every requirement explicitly. Missing: ${missing.join(', ')}.`,
        422,
        { missing },
      );
    }
  }

  const requirements = { ...DEFAULT_REQUIREMENTS, ...input };
  const width = Number(requirements.wheelchairWidthCm);
  const distance = Number(requirements.maxDistanceM);
  const companionCount = Number(requirements.companionCount);

  if (!Number.isFinite(width) || width < 45 || width > 95) {
    throw new DomainError('INVALID_WHEELCHAIR_WIDTH', 'Wheelchair width must be between 45 and 95 cm.', 422);
  }
  if (!Number.isFinite(distance) || distance < 20 || distance > 500) {
    throw new DomainError('INVALID_MAX_DISTANCE', 'Maximum route distance must be between 20 and 500 metres.', 422);
  }
  if (!Number.isInteger(companionCount) || companionCount < 0 || companionCount > 1) {
    throw new DomainError('INVALID_COMPANION_COUNT', 'This demo supports zero or one companion.', 422);
  }

  for (const key of ['stepFree', 'entranceAssistance', 'lowStimulus']) {
    if (typeof requirements[key] !== 'boolean') {
      // Opened with the raw field name, so it read as developer output rather
      // than something said to a person. It still names the parameter, which
      // is what an agent needs to correct the call.
      throw new DomainError(
        'INVALID_REQUIREMENT_TYPE',
        `Send "${key}" as true or false.`,
        422,
        { key },
      );
    }
  }

  return {
    wheelchairWidthCm: width,
    maxDistanceM: distance,
    stepFree: requirements.stepFree,
    companionCount,
    entranceAssistance: requirements.entranceAssistance,
    lowStimulus: requirements.lowStimulus,
  };
}

function routeClaims(route, requirements) {
  const claims = [
    { resourceId: route.liftId, role: 'ROUTE_FACILITY', consume: false },
    { resourceId: 'space-w12', role: 'WHEELCHAIR_SPACE', consume: true },
  ];

  if (requirements.companionCount === 1) {
    claims.push({ resourceId: 'seat-w13', role: 'COMPANION_SEAT', consume: true });
  }
  if (requirements.entranceAssistance) {
    claims.push({ resourceId: route.assistanceId, role: 'ENTRANCE_ASSISTANCE', consume: true });
  }
  return claims;
}

function routeView(route, requirements) {
  const view = clone(route);
  view.path = view.path.slice(0, -1).concat(requirements.companionCount === 1 ? 'W12 + W13' : 'W12');
  return view;
}

/** Own-property lookup: these maps are indexed by identifiers from a request. */
function own(map, key) {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function humanStatus(status) {
  return String(status ?? 'UNKNOWN').toLowerCase().replaceAll('_', ' ');
}

/**
 * Single source of truth for feasibility. Every caller - the planner, the
 * commit guard and the read-only explain tools - derives its answer from this
 * one list, so an explanation can never disagree with an actual refusal.
 */
function evaluateRoute(route, requirements, resources) {
  const checks = [];
  const add = (rule, ok, detail) => checks.push({ rule, ok, detail });

  add(
    'STEP_FREE',
    !requirements.stepFree || route.stepFree,
    route.stepFree ? 'Every segment is step-free.' : 'This route includes steps.',
  );
  add(
    'LOW_STIMULUS',
    !requirements.lowStimulus || route.lowStimulus,
    route.lowStimulus ? 'Avoids the busiest foyer.' : 'Passes through the busiest foyer.',
  );
  add(
    'ROUTE_DISTANCE',
    route.distanceM <= requirements.maxDistanceM,
    `${route.distanceM} m of travel against a ${requirements.maxDistanceM} m limit.`,
  );
  add(
    'DOORWAY_WIDTH',
    route.minWidthCm >= requirements.wheelchairWidthCm,
    `Narrowest point ${route.minWidthCm} cm against a ${requirements.wheelchairWidthCm} cm mobility aid.`,
  );

  const lift = resources[route.liftId];
  add(
    'LIFT_OPERATIONAL',
    lift?.status === 'OPERATIONAL',
    lift?.status === 'OPERATIONAL'
      ? `${lift.label} is operational.`
      : `${lift?.label ?? route.liftLabel} is ${humanStatus(lift?.status)}.`,
  );

  for (const claim of routeClaims(route, requirements)) {
    if (!claim.consume) continue;
    const resource = resources[claim.resourceId];
    const ok = resource?.status === 'AVAILABLE';
    add(
      claim.role,
      ok,
      ok
        ? `${resource.label} is available.`
        : `${resource?.label ?? claim.resourceId} is ${humanStatus(resource?.status)}.`,
    );
  }

  return {
    routeId: route.id,
    label: route.label,
    entrance: route.entrance,
    liftLabel: route.liftLabel,
    distanceM: route.distanceM,
    durationMinutes: route.durationMinutes,
    path: routeView(route, requirements).path,
    feasible: checks.every((check) => check.ok),
    checks,
    blockedBy: checks.filter((check) => !check.ok).map((check) => check.rule),
  };
}

function routeMeetsRequirements(route, requirements, resources) {
  return evaluateRoute(route, requirements, resources).feasible;
}

/**
 * What to do about a plan that is not in the state a command needed.
 *
 * PLAN_NOT_STAGEABLE and PLAN_NOT_STALE are both reachable from the demo's own
 * happy path, and both used to fall through to a generic "read the current
 * bundle status". The useful answer depends on what the plan actually is, so
 * one mapping per code would have been wrong in most of its cases.
 */
function nextActionForPlanStatus(status) {
  switch (status) {
    case 'PROPOSED': return 'STAGE_THE_PLAN_FOR_REVIEW';
    case 'STAGED': return 'LET_THE_VISITOR_CONFIRM_IT_OR_CLEAR_IT';
    case 'STALE': return 'REPLAN';
    case 'COMMITTED': return 'READ_THE_BOOKING_INSTEAD';
    case 'NO_ALTERNATIVE': return 'CONTACT_VENUE_STAFF';
    case 'CLEARED': return 'SEARCH_FOR_A_NEW_PLAN';
    default: return 'READ_THE_CURRENT_BUNDLE_STATUS';
  }
}

/**
 * Rules a requirement in the published schema can actually waive. Every other
 * rule evaluateRoute can fail is venue state that no legal requirement value
 * reaches: LIFT_OPERATIONAL and the shared wheelchair space. Keeping the list
 * here, next to the checks it names, is what stops the advice below drifting
 * away from the rules it is advice about.
 */
const REQUIREMENT_WAIVABLE_RULES = Object.freeze([
  'STEP_FREE',
  'LOW_STIMULUS',
  'ROUTE_DISTANCE',
  'DOORWAY_WIDTH',
  'COMPANION_SEAT',
  'ENTRANCE_ASSISTANCE',
]);

/**
 * The diagnosis carried by every NO_COMPLETE_BUNDLE refusal, derived from the
 * same evaluateRoute output the planner just rejected, so it cannot disagree
 * with the refusal it explains.
 *
 * `requirementChangeCanHelp` is false when not one candidate route could be
 * reopened by any requirement value at all. The advertised next action stays
 * CHANGE_REQUIREMENTS - it is the right advice in the ordinary case, and other
 * surfaces are built on it - but the agent is now told when following it can
 * only loop, and which rule is holding the venue shut.
 */
function diagnoseNoBundle(evaluations) {
  // The shortest limit that would reopen the venue, for the one rule where a
  // number is the answer. Only routes held up by distance alone count: a route
  // that also fails on a dead lift would still fail at any distance, so
  // reporting its length would be advice that cannot be followed.
  //
  // Derived from the evaluations that produced this refusal, never written
  // down. maxDistanceM accepts values from 20 m while no route is shorter than
  // 64 m, and every value in that band used to be refused with the same
  // sentence as an ordinary near-miss - so an agent was told no, and not told
  // what would be yes. Raising the published minimum instead would have frozen
  // today's route data into the contract.
  const distanceOnly = evaluations
    .filter((option) => option.blockedBy.length === 1 && option.blockedBy[0] === 'ROUTE_DISTANCE')
    .map((option) => option.distanceM);

  const requirementChangeCanHelp = evaluations.some((option) => (
    option.blockedBy.length > 0
    && option.blockedBy.every((rule) => REQUIREMENT_WAIVABLE_RULES.includes(rule))
  ));

  return {
    blockedBy: [...new Set(evaluations.flatMap((option) => option.blockedBy))].sort(),
    requirementChangeCanHelp,
    // The advice has to follow the diagnosis shipped beside it. This used to be
    // CHANGE_REQUIREMENTS for every NO_COMPLETE_BUNDLE, so with both lifts out
    // the venue said "no requirement change can help" and then advised changing
    // requirements - an agent following the advertised action loops, and the one
    // field that would have stopped it was already there and ignored.
    //
    // It follows reachability, not the blocker list: both lifts out AND a
    // distance blocker still cannot be reopened by any legal requirement value,
    // even though ROUTE_DISTANCE appears in the aggregate.
    nextAction: requirementChangeCanHelp ? 'CHANGE_REQUIREMENTS' : 'CONTACT_VENUE_STAFF',
    ...(distanceOnly.length > 0 ? { shortestFeasibleDistanceM: Math.min(...distanceOnly) } : {}),
  };
}

function publicPlan(plan, state) {
  if (!plan) return null;
  const route = ROUTES.find((candidate) => candidate.id === plan.routeId);
  return {
    id: plan.id,
    routeId: plan.routeId,
    status: plan.status,
    kind: plan.kind,
    basedOnResourceVersion: plan.basedOnResourceVersion,
    supersedesPlanId: plan.supersedesPlanId,
    // The route the superseded plan held. A replan around an outage on the
    // OTHER route hands back the same route on purpose, and every visible
    // string called it a replacement anyway: "the route changed", "accept the
    // replacement plan", "old route replaced" - about a byte-identical route.
    // The comparison the page needs was one field away.
    supersedesRouteId: plan.supersedesRouteId ?? null,
    createdAt: plan.createdAt,
    stagedAt: plan.stagedAt ?? null,
    requirements: clone(plan.requirements),
    route: routeView(route, plan.requirements),
    claims: plan.claims.map((claim) => ({
      ...claim,
      label: state.resources[claim.resourceId]?.label ?? claim.resourceId,
      currentStatus: state.resources[claim.resourceId]?.status ?? 'UNKNOWN',
    })),
    stale: plan.status !== 'COMMITTED' && (
      plan.basedOnResourceVersion !== state.resourceVersion ||
      !routeMeetsRequirements(route, plan.requirements, state.resources)
    ),
    requiresHumanConfirmation: true,
  };
}

/**
 * Every prepared plan is bound to the venue's global resource revision. An
 * operator change therefore invalidates every open plan, even when it touched
 * a resource on a different route. Keeping the stored status in sync with the
 * derived `publicPlan.stale` flag prevents the UI and the tool surface from
 * disagreeing about whether recovery is available.
 */
function invalidateOpenPlans(draft) {
  for (const plan of Object.values(draft.plans)) {
    // NO_ALTERNATIVE is also a conclusion about one venue revision. If the
    // venue changes, that conclusion must become re-checkable; otherwise the
    // explanation can say REPLAN while the state machine rejects replanning.
    if (['PROPOSED', 'STAGED', 'NO_ALTERNATIVE'].includes(plan.status)) plan.status = 'STALE';
  }
}

/**
 * The log is copied on every mutation and returned in every snapshot, so an
 * unbounded one turns each request into O(n) work for every demo on the
 * process. Only the recent tail is kept; the sequence number stays monotonic.
 */
const AUDIT_LIMIT = 120;

function addAudit(draft, entry, clock) {
  draft.auditSeq = (draft.auditSeq ?? draft.audit.length) + 1;
  draft.audit.push({
    seq: draft.auditSeq,
    at: nowIso(clock),
    resourceVersionBefore: draft.resourceVersion,
    resourceVersionAfter: draft.resourceVersion,
    ...entry,
  });
  if (draft.audit.length > AUDIT_LIMIT) {
    draft.audit.splice(0, draft.audit.length - AUDIT_LIMIT);
  }
}

function assertInvariants(state) {
  for (const booking of Object.values(state.bookings)) {
    const route = ROUTES.find((candidate) => candidate.id === booking.routeId);
    if (!route) throw new Error('Invariant failed: booking route is missing.');
    if (!booking.resourceIds.includes(route.liftId)) throw new Error('Invariant failed: booking has no route facility.');
    if (!booking.resourceIds.includes('space-w12')) throw new Error('Invariant failed: booking has no wheelchair space.');
    if (booking.requirements.companionCount === 1 && !booking.resourceIds.includes('seat-w13')) {
      throw new Error('Invariant failed: booking has no companion seat.');
    }
    if (booking.requirements.entranceAssistance && !booking.resourceIds.includes(route.assistanceId)) {
      throw new Error('Invariant failed: booking has no matching assistance.');
    }
  }

  for (const resource of Object.values(state.resources)) {
    if (resource.reservedBy && resource.status !== 'RESERVED') {
      throw new Error(`Invariant failed: ${resource.id} has an owner but is not reserved.`);
    }
  }
}

function initialState(runNumber = 1, version = 1) {
  return {
    runId: `run-${String(runNumber).padStart(3, '0')}`,
    runNumber,
    resourceVersion: version,
    auditSeq: 0,
    resources: clone(BASE_RESOURCES),
    plans: {},
    activePlanId: null,
    confirmations: {},
    bookings: {},
    activeBookingId: null,
    idempotency: {},
    audit: [],
    demo: { pendingOutageResourceId: null },
  };
}

/**
 * Receipt numbers, unique for the life of this process.
 *
 * It was private per venue, so four demos in one server each issued NSWR-00244:
 * on a public deployment every visitor's first booking carried the same
 * reference. Module scope is the smallest thing that is actually unique where
 * the collision happened.
 */
let receiptCounter = 243;

/** How many request ids one venue remembers. Bounded like the audit log. */
const IDEMPOTENCY_LIMIT = 200;

/**
 * How many per-caller refusal questions one venue can retain. The HTTP layer
 * uses the same value as its per-demo session ceiling, so a live session is
 * never made inexplicable merely because a newer session was opened.
 */
export const REFUSAL_LIMIT = 200;

export function createDemoStore({ clock = Date.now, idFactory = randomUUID } = {}) {
  let state = initialState();

  /**
   * What the last refused search asked for, when it opened no plan.
   *
   * Deliberately outside `state`: a snapshot is sent to every page on every
   * poll, and one visitor's refused search is not venue state. It holds the
   * question, never the answer - `explainRefusal()` re-evaluates it against
   * current resources, so a venue that has been repaired, or has got worse
   * since, is described as it is now.
   */
  const refusals = new Map();
  /** Callers that name no session are one anonymous visitor, as they were. */
  const ANONYMOUS = Symbol.for('nswr.anonymous-visitor');

  const rememberRefusal = (sessionKey, refusal) => {
    const key = sessionKey ?? ANONYMOUS;
    refusals.delete(key);
    // Sessions are evicted by the server, not by the venue, so without a bound
    // a caller minting session keys grows this for as long as the venue lives.
    while (refusals.size >= REFUSAL_LIMIT) refusals.delete(refusals.keys().next().value);
    refusals.set(key, refusal);
  };
  const forgetRefusal = (sessionKey) => refusals.delete(sessionKey ?? ANONYMOUS);
  const readRefusal = (sessionKey) => refusals.get(sessionKey ?? ANONYMOUS) ?? null;
  /**
   * A route exclusion belongs to the plan it was computed for, and dies with
   * it. The QUESTION does not: a venue that is still shut after the plan is
   * cleared has to stay explicable, so only the exclusion is dropped and the
   * requirements are kept. Deleting the whole refusal here made a still-closed
   * venue answer "nothing is blocked", which is the same defect pointing the
   * other way.
   */
  const unscopeRefusalsForPlan = (planId) => {
    for (const [key, refusal] of refusals) {
      if (refusal.planId && refusal.planId === planId) {
        refusals.set(key, { ...refusal, excludeRouteIds: [], planId: null });
      }
    }
  };

  /**
   * Receipt numbers, monotonic for the life of this venue object.
   *
   * Private on purpose: it must not restart when the demo resets, and it must
   * not be reachable from a snapshot, where a page could render it as venue
   * state. The starting offset keeps the walkthrough's first receipt looking
   * the way the documentation shows it.
   */
  const nextReceipt = () => `NSWR-${String((receiptCounter += 1)).padStart(5, '0')}`;

  function getPhase() {
    if (state.activeBookingId) return 'CONFIRMED';
    const activePlan = state.activePlanId ? own(state.plans, state.activePlanId) : null;
    if (!activePlan) return 'READY';
    if (activePlan.status === 'PROPOSED') return 'PLAN_READY';
    if (activePlan.status === 'STALE') return 'PLAN_STALE';
    if (activePlan.status === 'NO_ALTERNATIVE') return 'NO_ALTERNATIVE';
    if (activePlan.status === 'STAGED' && activePlan.kind === 'REPLACEMENT') return 'REPLAN_READY';
    if (activePlan.status === 'STAGED') return 'AWAITING_HUMAN_CONFIRMATION';
    return 'READY';
  }

  function snapshot() {
    const activePlan = state.activePlanId ? own(state.plans, state.activePlanId) : null;
    const booking = state.activeBookingId ? own(state.bookings, state.activeBookingId) : null;
    return {
      runId: state.runId,
      resourceVersion: state.resourceVersion,
      phase: getPhase(),
      event: {
        title: 'Evening at Riverside Hall',
        date: 'Tonight · 7:30 PM',
        location: 'Main auditorium',
      },
      resources: clone(state.resources),
      routes: clone(ROUTES),
      activePlan: publicPlan(activePlan, state),
      booking: booking ? clone(booking) : null,
      audit: clone(state.audit),
      demo: clone(state.demo),
      atomicity: {
        bookingCount: Object.keys(state.bookings).length,
        reservedResourceCount: Object.values(state.resources).filter((resource) => resource.status === 'RESERVED').length,
      },
      // The visitor page printed "next action CHANGE_REQUIREMENTS" and offered a
      // "Change requirements" button in a venue nothing the visitor can type
      // will reopen. It had no choice: the state payload carried no diagnosis,
      // so the page held a literal. Recomputing the rule on the page would be
      // the same lie in a second place, so the venue ships its own answer.
      //
      // Present only where a dead end is actually current. Everywhere else there
      // is nothing to diagnose and the field would be noise on every poll.
      ...(['NO_ALTERNATIVE', 'PLAN_STALE'].includes(getPhase()) && activePlan
        ? {
          diagnosis: (() => {
            const evaluations = ROUTES.map((route) => evaluateRoute(route, activePlan.requirements, state.resources));
            // Spread, not copied field by field. Three surfaces listed the
            // fields by hand, so each field added later had to be added in
            // every one of them or it was dropped in silence - which is what
            // happened to shortestFeasibleDistanceM, the one number that tells
            // a visitor which distance to ask for instead.
            const diagnosis = diagnoseNoBundle(evaluations);
            // A route that still works means replanning really is the answer,
            // which is the same rule explainRefusal applies. Where nothing
            // works, the page must not print REPLAN either - that literal was
            // the second copy of this defect, and it was reachable before any
            // replan had been attempted.
            const replannable = evaluations.some((option) => option.feasible);
            return {
              ...diagnosis,
              nextAction: replannable ? 'REPLAN' : diagnosis.nextAction,
            };
          })(),
        }
        : {}),
    };
  }

  function findBundle(input = {}, {
    kind = 'INITIAL',
    supersedesPlanId = null,
    excludeRouteIds = [],
    supersedesRouteId = null,
    actor = 'browser-agent',
    toolName = null,
    sessionKey = null,
  } = {}) {
    const existingPlan = state.activePlanId ? own(state.plans, state.activePlanId) : null;
    if (kind === 'INITIAL' && state.activeBookingId) {
      throw new DomainError('BOOKING_ALREADY_EXISTS', 'This demo session already has a confirmed booking.', 409);
    }
    if (kind === 'INITIAL' && existingPlan && !['CANCELLED', 'SUPERSEDED'].includes(existingPlan.status)) {
      throw new DomainError('ACTIVE_PLAN_EXISTS', 'Finish or clear the current access plan before starting another.', 409, {
        activePlanId: existingPlan.id,
      });
    }
    const requirements = normalizeRequirements(input, { requireAll: kind === 'INITIAL' });
    const route = ROUTES
      .filter((candidate) => !excludeRouteIds.includes(candidate.id))
      .filter((candidate) => routeMeetsRequirements(candidate, requirements, state.resources))
      .sort((a, b) => a.durationMinutes - b.durationMinutes || a.id.localeCompare(b.id))[0];

    if (!route) {
      const considered = ROUTES
        .filter((candidate) => !excludeRouteIds.includes(candidate.id))
        .map((candidate) => evaluateRoute(candidate, requirements, state.resources));
      // A search that refuses in READY opens no plan, so without this the one
      // tool named for the question had nothing to answer from and reported
      // "Nothing is blocked" straight after a refusal.
      //
      // Only what was asked and which routes were in scope. No plan, no
      // reservation, no revision - and deliberately not the answer, which is
      // recomputed on read so a repaired venue can never be described with the
      // blockers it had a minute ago.
      rememberRefusal(sessionKey, {
        requirements,
        excludeRouteIds: [...excludeRouteIds],
        code: 'NO_COMPLETE_BUNDLE',
        rejectedAction: kind === 'REPLACEMENT' ? 'NO_ALTERNATIVE_FOUND' : 'FIND_ACCESS_BUNDLE',
        // The plan whose route this refusal was told to avoid. A replan
        // excludes the route it is replacing, and that exclusion outlived the
        // plan: after the lift came back and the visitor cleared the plan, the
        // explanation still evaluated one route out of two and answered
        // "blocked, contact venue staff" for a venue where the next search
        // booked a seat.
        planId: supersedesPlanId ?? null,
      });
      throw new DomainError(
        'NO_COMPLETE_BUNDLE',
        'No complete route, seat and assistance bundle meets every requirement.',
        422,
        diagnoseNoBundle(considered),
      );
    }
    // A search that succeeds answers the question the refusal was about.
    forgetRefusal(sessionKey);

    const id = `plan-${idFactory()}`;
    const plan = {
      id,
      status: 'PROPOSED',
      kind,
      basedOnResourceVersion: state.resourceVersion,
      supersedesPlanId,
      supersedesRouteId,
      requirements,
      routeId: route.id,
      claims: routeClaims(route, requirements),
      createdAt: nowIso(clock),
      stagedAt: null,
    };

    const draft = clone(state);
    draft.plans[id] = plan;
    draft.activePlanId = id;
    addAudit(draft, {
      actor,
      toolName,
      action: kind === 'REPLACEMENT' ? 'REPLACEMENT_PLAN_CREATED' : 'PLAN_CREATED',
      outcome: 'SUCCESS',
      refs: [id, route.id],
      message: `${route.label} satisfies every operational requirement.`,
    }, clock);
    state = draft;
    return publicPlan(own(state.plans, id), state);
  }

  function stageBundle(planId, expectedResourceVersion, { actor = 'browser-agent', toolName = null } = {}) {
    const plan = own(state.plans, planId);
    if (!plan) throw new DomainError('PLAN_NOT_FOUND', 'The requested access plan does not exist.', 404);
    if (plan.status !== 'PROPOSED') {
      // Both of these are reachable from the demo's own happy path - staging a
      // plan twice is the obvious retry - and both used to fall through to a
      // generic "read the current bundle status", which tells an agent nothing
      // it did not already know. What to do instead depends on what the plan
      // has become, so the answer is computed from that rather than mapped once.
      throw new DomainError(
        'PLAN_NOT_STAGEABLE',
        `Only a proposed plan can be staged; this one is ${humanStatus(plan.status)}.`,
        409,
        { planStatus: plan.status, nextAction: nextActionForPlanStatus(plan.status) },
      );
    }
    // The venue first, the caller's arithmetic second - the same order the
    // confirmation path uses. Folding both into one condition told an agent
    // that remembered a stale number that the venue had changed when it had
    // not: the refusal carried two identical revisions and sent it to REPLAN,
    // which then answered PLAN_NOT_STALE. The number is agent-supplied through
    // stage_access_bundle's expectedVenueRevision, so this is reachable.
    if (plan.basedOnResourceVersion !== state.resourceVersion) {
      throw new DomainError('STALE_RESOURCE_VERSION', 'Venue resources changed before the plan could be staged.', 409, {
        planResourceVersion: plan.basedOnResourceVersion,
        currentResourceVersion: state.resourceVersion,
        nextAction: 'REPLAN',
      });
    }
    if (Number(expectedResourceVersion) !== state.resourceVersion) {
      throw new DomainError(
        'EXPECTED_RESOURCE_VERSION_MISMATCH',
        'That venue revision does not match the one this plan was built on. Nothing was staged.',
        409,
        {
          // No confirmation exists at staging time - it is minted later by
          // prepareConfirmation - so asking for a "confirmation revision" here
          // named a number the agent could not have and could not obtain.
          nextAction: 'RETRY_WITH_THE_VENUE_REVISION',
          venueResourceVersion: state.resourceVersion,
          receivedResourceVersion: Number.isFinite(Number(expectedResourceVersion))
            ? Number(expectedResourceVersion)
            : null,
          partialReservations: 0,
        },
      );
    }
    const route = ROUTES.find((candidate) => candidate.id === plan.routeId);
    if (!routeMeetsRequirements(route, plan.requirements, state.resources)) {
      throw new DomainError('BUNDLE_NO_LONGER_FEASIBLE', 'One or more required resources are no longer available.', 409);
    }

    const draft = clone(state);
    own(draft.plans, planId).status = 'STAGED';
    own(draft.plans, planId).stagedAt = nowIso(clock);
    draft.activePlanId = planId;
    addAudit(draft, {
      actor,
      toolName,
      action: plan.kind === 'REPLACEMENT' ? 'REPLACEMENT_PLAN_STAGED' : 'PLAN_STAGED',
      outcome: 'SUCCESS',
      refs: [planId],
      message: 'The complete bundle is ready for human review; nothing is booked yet.',
    }, clock);
    state = draft;
    return publicPlan(own(state.plans, planId), state);
  }

  // The interaction context travels with the write, exactly as it does for the
  // visitor tools. Without it the decision log recorded every outage and every
  // restore as the venue operator, whether it arrived from the operations page
  // or from report_facility_outage - so the artefact this product asks to be
  // believed was silent about half of what it records.
  //
  // What it records is a DECLARED invocation path, not an authenticated actor:
  // an authorised client can send any header it likes.
  function setFacilityOutage(resourceId, reasonCode, { actor = 'venue-operator', toolName = null } = {}) {
    const resource = state.resources[resourceId];
    if (!resource || resource.kind !== 'FACILITY') {
      throw new DomainError('FACILITY_NOT_FOUND', 'The requested facility does not exist.', 404);
    }
    // Object.hasOwn converts its key to a string, so ['POWER_FAULT'] and
    // { toString: () => 'POWER_FAULT' } both resolved to a real reason code and
    // took the lift out of service. The raw array then went into the decision
    // log as `reason`. A reason code is a string or it is not a reason code.
    const reason = typeof reasonCode === 'string' && Object.hasOwn(OUTAGE_REASONS, reasonCode)
      ? OUTAGE_REASONS[reasonCode]
      : null;
    if (!reason) {
      throw new DomainError('INVALID_OUTAGE_REASON', 'Use one of the supported operational outage reason codes.', 422, {
        allowedReasonCodes: Object.keys(OUTAGE_REASONS),
      });
    }
    if (resource.status === 'OUT_OF_SERVICE') return snapshot();

    const draft = clone(state);
    const before = draft.resourceVersion;
    draft.resources[resourceId].status = 'OUT_OF_SERVICE';
    draft.resources[resourceId].outageReason = reason;
    draft.resourceVersion += 1;
    // Only the armed facility's own outage spends the armed fault. This used to
    // clear unconditionally, so arming Garden and then reporting East out
    // erased the Garden fault with nothing recording that it was dropped - the
    // same silent loss the arm endpoint was taught to refuse, reachable through
    // a different door.
    if (draft.demo.pendingOutageResourceId === resourceId) {
      draft.demo.pendingOutageResourceId = null;
    }
    invalidateOpenPlans(draft);

    addAudit(draft, {
      actor,
      toolName,
      action: 'FACILITY_OUTAGE_REPORTED',
      outcome: 'SUCCESS',
      refs: [resourceId],
      reason: reasonCode,
      message: `${resource.label} is out of service.`,
      resourceVersionBefore: before,
      resourceVersionAfter: draft.resourceVersion,
    }, clock);
    state = draft;
    return snapshot();
  }

  function armOutage(resourceId = 'east-lift') {
    const resource = state.resources[resourceId];
    if (!resource || resource.kind !== 'FACILITY') {
      throw new DomainError('FACILITY_NOT_FOUND', 'The requested facility does not exist.', 404);
    }
    if (resource.status !== 'OPERATIONAL') {
      throw new DomainError('FACILITY_NOT_OPERATIONAL', 'Only an operational facility can be armed for the confirmation demo.', 409);
    }

    // A pending fault is venue state, and the venue is what has to defend it.
    // This used to assign unconditionally, so a second arm replaced the first
    // and nothing recorded that anything was dropped. Both pages were taught not
    // to offer that, which is not the same as preventing it: the WebMCP tool
    // surface, a second tab and curl all reach this through the same endpoint.
    const pending = state.demo.pendingOutageResourceId;
    if (pending && pending !== resourceId) {
      const held = state.resources[pending];
      throw new DomainError(
        'OUTAGE_ALREADY_ARMED',
        `${held?.label ?? pending} is already armed for the next confirmation. Report or clear that fault before arming another.`,
        409,
        { pendingOutageResourceId: pending, pendingFacilityLabel: held?.label ?? pending },
      );
    }
    // Arming what is already armed is not an error - a control pressed twice is
    // not a mistake - but it must not write a second identical audit line
    // either, or a loop could inflate the decision log with nothing happening.
    if (pending === resourceId) return snapshot();

    const draft = clone(state);
    draft.demo.pendingOutageResourceId = resourceId;
    addAudit(draft, {
      actor: 'venue-operator',
      action: 'OUTAGE_SIGNAL_ARMED',
      outcome: 'SUCCESS',
      refs: [resourceId],
      message: `${resource.label} will be reported out of service during the next confirmation.`,
    }, clock);
    state = draft;
    return snapshot();
  }

  function replanBundle(stalePlanId, { actor = 'browser-agent', toolName = null, sessionKey = null } = {}) {
    const stalePlan = own(state.plans, stalePlanId);
    if (!stalePlan) throw new DomainError('PLAN_NOT_FOUND', 'The stale access plan does not exist.', 404);
    if (stalePlan.status !== 'STALE') {
      throw new DomainError(
        'PLAN_NOT_STALE',
        `Replanning is available only after the venue has invalidated a plan; this one is ${humanStatus(stalePlan.status)}.`,
        409,
        { planStatus: stalePlan.status, nextAction: nextActionForPlanStatus(stalePlan.status) },
      );
    }

    // Only rule out the route that failed. A plan can go stale because the
    // venue revision moved for an unrelated reason, and in that case the same
    // route is still the right answer - it just has to be rechecked.
    const staleRoute = ROUTES.find((candidate) => candidate.id === stalePlan.routeId);
    const staleRouteStillWorks = routeMeetsRequirements(staleRoute, stalePlan.requirements, state.resources);

    let replacement;
    try {
      replacement = findBundle(stalePlan.requirements, {
        kind: 'REPLACEMENT',
        supersedesPlanId: stalePlanId,
        excludeRouteIds: staleRouteStillWorks ? [] : [stalePlan.routeId],
        supersedesRouteId: stalePlan.routeId,
        actor,
        toolName,
        sessionKey,
      });
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'NO_COMPLETE_BUNDLE') throw error;
      const draft = clone(state);
      own(draft.plans, stalePlanId).status = 'NO_ALTERNATIVE';
      addAudit(draft, {
        actor,
        toolName,
        action: 'NO_ALTERNATIVE_FOUND',
        outcome: 'REJECTED',
        refs: [stalePlanId],
        reason: 'NO_COMPLETE_BUNDLE',
        message: 'No alternative satisfies every current requirement. Nothing was booked.',
      }, clock);
      state = draft;
      // The caught diagnosis is the answer. This used to spread it and then
      // overwrite nextAction with CHANGE_REQUIREMENTS, so a replan into a venue
      // with both lifts out advised changing requirements while carrying
      // requirementChangeCanHelp: false one field away.
      throw new DomainError(
        'NO_COMPLETE_BUNDLE',
        'No alternative route satisfies every current requirement.',
        422,
        { ...error.details },
      );
    }
    const staged = stageBundle(replacement.id, state.resourceVersion, { actor, toolName });

    const draft = clone(state);
    // The audit record and the replacement's supersedesPlanId preserve the
    // history. Keeping the full superseded object would make repeated
    // invalidate/replan cycles grow every later structuredClone without bound.
    delete draft.plans[stalePlanId];
    for (const [confirmationId, confirmation] of Object.entries(draft.confirmations)) {
      if (confirmation.planId === stalePlanId) delete draft.confirmations[confirmationId];
    }
    addAudit(draft, {
      actor,
      toolName,
      action: 'PLAN_REPLANNED',
      outcome: 'SUCCESS',
      refs: [stalePlanId, staged.id],
      message: 'A complete replacement bundle is ready for human review.',
    }, clock);
    state = draft;
    // A successful replacement kills the plan-scoped route exclusion for
    // every visitor, not only for the visitor whose replan won. Without this,
    // another session could keep excluding East after the superseded plan was
    // deleted and explain a venue as shut immediately before search served it.
    unscopeRefusalsForPlan(stalePlanId);
    return publicPlan(own(state.plans, staged.id), state);
  }

  function prepareConfirmation(planId) {
    const plan = own(state.plans, planId);
    if (!plan) throw new DomainError('PLAN_NOT_FOUND', 'The requested access plan does not exist.', 404);
    if (plan.status !== 'STAGED') {
      throw new DomainError('PLAN_NOT_READY', 'The complete bundle must be staged before confirmation.', 409);
    }
    // Preparing the same still-valid review twice must be idempotent. Without
    // this reuse, a caller can grow the private confirmation map forever and
    // make every later structuredClone progressively more expensive.
    const existing = Object.values(state.confirmations).find((confirmation) => (
      confirmation.planId === planId
      && confirmation.resourceVersion === plan.basedOnResourceVersion
      && confirmation.used === false
    ));
    if (existing) {
      return {
        confirmationId: existing.id,
        planId,
        expectedResourceVersion: existing.resourceVersion,
      };
    }
    const confirmationId = `confirm-${idFactory()}`;
    const draft = clone(state);
    draft.confirmations[confirmationId] = {
      id: confirmationId,
      planId,
      resourceVersion: plan.basedOnResourceVersion,
      used: false,
      createdAt: nowIso(clock),
    };
    addAudit(draft, {
      actor: 'human-ui',
      action: 'HUMAN_CONFIRMATION_PREPARED',
      outcome: 'SUCCESS',
      refs: [planId],
      // What the server can know, and no more. This read "The customer was
      // shown the complete route, seats and assistance plan." for a call that
      // is an ordinary authenticated endpoint: reproduced with curl alone, with
      // no page ever opened. The receipt copy was weakened for exactly this
      // reason - a venue is shared through its ?demo= link, so the server
      // cannot vouch for who held the session or that anyone pressed anything -
      // and this line was left claiming it.
      message: 'A single-use confirmation identifier was issued for this plan. '
        + 'It must be presented, with the venue revision, to commit the booking.',
    }, clock);
    state = draft;
    return { confirmationId, planId, expectedResourceVersion: plan.basedOnResourceVersion };
  }

  function commitBundle({ planId, confirmationId, expectedResourceVersion, accepted, requestId }) {
    const unsafeRequestIds = new Set(['__proto__', 'constructor', 'prototype']);
    if (
      !requestId ||
      typeof requestId !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,100}$/.test(requestId) ||
      unsafeRequestIds.has(requestId)
    ) {
      throw new DomainError('REQUEST_ID_REQUIRED', 'A request ID is required for idempotent confirmation.', 422);
    }
    const fingerprint = JSON.stringify({ planId, confirmationId, expectedResourceVersion: Number(expectedResourceVersion), accepted });
    if (Object.hasOwn(state.idempotency, requestId)) {
      const saved = state.idempotency[requestId];
      if (saved.fingerprint !== fingerprint) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'This request ID was already used for a different confirmation command.', 409);
      }
      // A refusal binds the id exactly as a success does. Without this the id
      // was recorded only when the command worked, so replaying an identical
      // refused command re-ran it and wrote another decision-log entry every
      // time - and a failed attempt could later become a DIFFERENT successful
      // command under the same id, because nothing remembered the first one.
      if (saved.refusal) {
        const { code, message, status, details } = saved.refusal;
        throw new DomainError(code, message, status, clone(details ?? {}));
      }
      return { ...clone(saved.result), idempotent: true };
    }

    /**
     * Bind this id to what the command did, refusal included, and re-raise.
     *
     * Only DomainError is remembered. An unexpected internal error is a bug in
     * this module, not an outcome the caller should be handed again on every
     * retry for the life of the venue.
     */
    const remember = (error) => {
      if (error instanceof DomainError) {
        // Capped, and oldest-first. Nothing pruned this map, so a caller could
        // grow it without limit: each refusal rebuilt the whole object, so
        // every later one cost more than the last, and the process held it all.
        // The audit log is bounded for exactly this reason; this was the one
        // map left open.
        const kept = Object.entries(state.idempotency).slice(-(IDEMPOTENCY_LIMIT - 1));
        state = {
          ...state,
          idempotency: {
            ...Object.fromEntries(kept),
            [requestId]: {
              fingerprint,
              refusal: { code: error.code, message: error.message, status: error.status, details: clone(error.details ?? {}) },
            },
          },
        };
      }
      throw error;
    };

    if (accepted !== true) {
      remember(new DomainError('HUMAN_CONFIRMATION_REQUIRED', 'The customer must explicitly accept the complete plan.', 428));
    }

    // Everything from here binds its outcome to the request id, so a replay of
    // the identical command returns the identical answer without re-running it.
    try {

    const plan = own(state.plans, planId);
    const confirmation = own(state.confirmations, confirmationId);
    if (!plan) throw new DomainError('PLAN_NOT_FOUND', 'The requested access plan does not exist.', 404);
    if (state.activePlanId !== planId) {
      throw new DomainError('PLAN_NOT_ACTIVE', 'Only the currently displayed access plan can be confirmed.', 409);
    }
    if (plan.status === 'COMMITTED') {
      throw new DomainError('PLAN_ALREADY_COMMITTED', 'This access plan has already been confirmed.', 409);
    }
    if (!confirmation || confirmation.planId !== planId || confirmation.used) {
      throw new DomainError('INVALID_CONFIRMATION', 'The human confirmation is missing, invalid or already used.', 428);
    }

    // A number the caller got wrong is not a venue change.
    //
    // This used to be folded into the staleness condition below, so a stale
    // browser tab, a retry with a remembered number or a typo produced
    // STALE_RESOURCE_VERSION and pushed a plan nothing had invalidated to
    // STALE. The refusal then reported two identical revisions, an empty
    // broken-rule list, and offered back the route the plan was already
    // holding - because the venue had not moved at all.
    //
    // It also has to come BEFORE the demo fault below, or a bad number spends a
    // fault the venue was holding for a real confirmation, and the venue then
    // really has moved - caused by the very command being refused.
    // A venue that has really moved outranks a number the caller got wrong.
    // This check used to run first and unconditionally, so a stale venue was
    // reported as a caller mistake - with a message saying "the plan is still
    // valid" while the plan was STALE, and advice which, followed exactly, then
    // returned STALE_RESOURCE_VERSION. A refusal that states something false
    // about the venue is the defect this product exists to remove.
    const venueMoved = plan.basedOnResourceVersion !== state.resourceVersion
      || confirmation.resourceVersion !== state.resourceVersion;
    if (!venueMoved && Number(expectedResourceVersion) !== confirmation.resourceVersion) {
      throw new DomainError(
        'EXPECTED_RESOURCE_VERSION_MISMATCH',
        'That revision number does not match the one this confirmation was prepared with. '
        + 'Nothing was booked and the plan is still valid.',
        409,
        {
          // One error code, one next action. This branch runs only when
          // venueMoved is false, which means the venue revision, the plan's
          // revision and the confirmation's revision are all the same number -
          // so naming the venue revision here is not a compromise between two
          // truths, it is the same truth said once. Staging raises this code
          // too, before any confirmation exists, and an agent that learned two
          // different actions for one code would be learning a contradiction.
          nextAction: 'RETRY_WITH_THE_VENUE_REVISION',
          venueResourceVersion: confirmation.resourceVersion,
          receivedResourceVersion: Number.isFinite(Number(expectedResourceVersion))
            ? Number(expectedResourceVersion)
            : null,
          partialReservations: 0,
        },
      );
    }

    // The synthetic mid-confirmation fault is itself a mutation. Trigger it
    // only after the command has proved that it targets the active plan with a
    // valid human confirmation and carries the revision it was handed;
    // malformed commands must leave the venue byte-for-byte unchanged.
    if (state.demo.pendingOutageResourceId) {
      setFacilityOutage(state.demo.pendingOutageResourceId, 'LIFT_DOOR_FAULT');
    }

    if (
      Number(expectedResourceVersion) !== state.resourceVersion ||
      plan.basedOnResourceVersion !== state.resourceVersion ||
      confirmation.resourceVersion !== state.resourceVersion
    ) {
      const draft = clone(state);
      if (own(draft.plans, planId)) own(draft.plans, planId).status = 'STALE';
      addAudit(draft, {
        actor: 'human-ui',
        action: 'COMMIT_REJECTED_STALE',
        outcome: 'REJECTED',
        refs: [planId],
        reason: 'STALE_RESOURCE_VERSION',
        message: 'The venue changed, so no seats, assistance or route were booked.',
      }, clock);
      state = draft;
      throw new DomainError('STALE_RESOURCE_VERSION', 'The venue changed before confirmation. Nothing was booked.', 409, {
        planResourceVersion: plan.basedOnResourceVersion,
        currentResourceVersion: state.resourceVersion,
        // Counted, not asserted: this number is the claim being made.
        partialReservations: partialReservationCount(),
        nextAction: 'REPLAN',
      });
    }

    const route = ROUTES.find((candidate) => candidate.id === plan.routeId);
    if (!routeMeetsRequirements(route, plan.requirements, state.resources)) {
      throw new DomainError('BUNDLE_NO_LONGER_FEASIBLE', 'The complete bundle no longer satisfies the requirements.', 409);
    }

    const draft = clone(state);
    const bookingId = `booking-${idFactory()}`;
    const consumableIds = plan.claims.filter((claim) => claim.consume).map((claim) => claim.resourceId);
    const allResourceIds = plan.claims.map((claim) => claim.resourceId);

    for (const resourceId of consumableIds) {
      const resource = draft.resources[resourceId];
      if (resource.status !== 'AVAILABLE') {
        throw new DomainError('RESOURCE_CONFLICT', `${resource.label} is no longer available.`, 409, { resourceId });
      }
    }

    for (const resourceId of consumableIds) {
      draft.resources[resourceId].status = 'RESERVED';
      draft.resources[resourceId].reservedBy = bookingId;
    }

    own(draft.confirmations, confirmationId).used = true;
    own(draft.plans, planId).status = 'COMMITTED';
    draft.resourceVersion += 1;
    const booking = {
      id: bookingId,
      // Allocated from a counter that lives outside `state`, so it survives a
      // reset. It used to be derived from draft.auditSeq, which restarts with
      // the venue: three booking cycles in one process produced NSWR-00244,
      // NSWR-00245, NSWR-00245 - two different bookings carrying one number.
      receipt: nextReceipt(),
      planId,
      routeId: plan.routeId,
      route: routeView(route, plan.requirements),
      requirements: clone(plan.requirements),
      resourceIds: allResourceIds,
      resourceLabels: allResourceIds.map((id) => draft.resources[id].label),
      confirmedAt: nowIso(clock),
      committedResourceVersion: draft.resourceVersion,
      partialReservations: 0,
    };
    draft.bookings[bookingId] = booking;
    draft.activeBookingId = bookingId;
    const result = { ok: true, idempotent: false, booking: clone(booking) };
    draft.idempotency[requestId] = { fingerprint, result };
    const committedParts = ['route', 'wheelchair space'];
    if (plan.requirements.companionCount === 1) committedParts.push('companion seat');
    if (plan.requirements.entranceAssistance) committedParts.push('entrance assistance');
    addAudit(draft, {
      actor: 'human-ui',
      action: 'BUNDLE_COMMITTED',
      outcome: 'SUCCESS',
      refs: [bookingId, planId, ...allResourceIds],
      message: `${committedParts.join(', ')} confirmed together.`,
      resourceVersionBefore: draft.resourceVersion - 1,
      resourceVersionAfter: draft.resourceVersion,
    }, clock);
    assertInvariants(draft);
    state = draft;
    return result;
    } catch (error) {
      return remember(error);
    }
  }

  function reset() {
    const nextRun = state.runNumber + 1;
    const nextVersion = state.resourceVersion + 1;
    state = initialState(nextRun, nextVersion);
    // The refusals belonged to the venue that was just discarded.
    refusals.clear();
    addAudit(state, {
      actor: 'demo-control',
      action: 'DEMO_RESET',
      outcome: 'SUCCESS',
      refs: [state.runId],
      message: 'All synthetic demo resources were restored.',
    }, clock);
    return snapshot();
  }

  function clearPlan(planId, { actor = 'human-ui', toolName = null } = {}) {
    const plan = own(state.plans, planId);
    if (!plan) throw new DomainError('PLAN_NOT_FOUND', 'The requested access plan does not exist.', 404);
    if (plan.status === 'COMMITTED') throw new DomainError('PLAN_ALREADY_COMMITTED', 'A confirmed booking cannot be cleared as a plan.', 409);
    if (state.activePlanId !== planId) throw new DomainError('PLAN_NOT_ACTIVE', 'Only the current plan can be cleared.', 409);
    const draft = clone(state);
    // Cleared and superseded plan history already lives in the bounded audit
    // log. Removing the objects prevents find/clear loops from turning the
    // private state into an unbounded clone-on-every-request structure.
    draft.plans = {};
    draft.activePlanId = null;
    draft.confirmations = {};
    unscopeRefusalsForPlan(planId);
    addAudit(draft, {
      actor,
      toolName,
      action: 'PLAN_CLEARED',
      outcome: 'SUCCESS',
      refs: [planId],
      message: 'The unbooked plan was cleared so the visitor can change requirements.',
    }, clock);
    state = draft;
    return snapshot();
  }

  function setResourceUnavailable(resourceId, reasonCode = 'OPERATOR_UNAVAILABLE') {
    const resource = state.resources[resourceId];
    if (!resource || !resource.reservable) throw new DomainError('RESOURCE_NOT_FOUND', 'Reservable resource not found.', 404);
    const draft = clone(state);
    const before = draft.resourceVersion;
    draft.resources[resourceId].status = 'UNAVAILABLE';
    draft.resources[resourceId].unavailableReason = reasonCode;
    draft.resourceVersion += 1;
    invalidateOpenPlans(draft);
    addAudit(draft, {
      actor: 'venue-operator',
      action: 'RESOURCE_UNAVAILABLE',
      outcome: 'SUCCESS',
      refs: [resourceId],
      reason: reasonCode,
      message: `${resource.label} is unavailable.`,
      resourceVersionBefore: before,
      resourceVersionAfter: draft.resourceVersion,
    }, clock);
    state = draft;
    return snapshot();
  }

  /** Read-only. Evaluates every route against requirements without touching state. */
  function listAccessOptions(input = {}) {
    const requirements = normalizeRequirements(input);
    const options = ROUTES.map((route) => evaluateRoute(route, requirements, state.resources));
    return {
      venueRevision: state.resourceVersion,
      requirements,
      feasibleCount: options.filter((option) => option.feasible).length,
      options,
    };
  }

  /** Read-only. Evaluates one named route and says exactly which rules fail. */
  function checkAccessRoute(routeId, input = {}) {
    const route = ROUTES.find((candidate) => candidate.id === routeId);
    if (!route) {
      throw new DomainError('ROUTE_NOT_FOUND', 'The requested route does not exist.', 404, {
        knownRouteIds: ROUTES.map((candidate) => candidate.id),
      });
    }
    const requirements = normalizeRequirements(input);
    return { venueRevision: state.resourceVersion, requirements, ...evaluateRoute(route, requirements, state.resources) };
  }

  /**
   * Read-only. Turns the current blocked state into the rule that was broken
   * plus the options that still pass, so an agent can self-correct instead of
   * retrying the same rejected call.
   */
  /**
   * Reserved resources that no committed booking accounts for.
   *
   * A completed atomic booking holds three RESERVED resources, and that three is
   * the proof the page displays. Reporting the same number as
   * `partialReservations` said the successful case had three dangling
   * reservations - the exact claim this product exists to disprove, and the one
   * the README pins at zero because "the bundle commits as one write or not at
   * all".
   */
  const partialReservationCount = () => {
    const booked = new Set(state.activeBookingId
      ? (own(state.bookings, state.activeBookingId)?.resourceIds ?? [])
      : []);
    return Object.entries(state.resources)
      .filter(([id, resource]) => resource.status === 'RESERVED' && !booked.has(id))
      .length;
  };

  function explainRefusal({ sessionKey = null } = {}) {
    const lastRefusal = readRefusal(sessionKey);
    const plan = state.activePlanId ? own(state.plans, state.activePlanId) : null;
    const phase = getPhase();
    if (!plan || !['PLAN_STALE', 'NO_ALTERNATIVE'].includes(phase)) {
      // A search can refuse without opening a plan - a fresh visit to a venue
      // with every lift out, or the state a person lands in after clearing a
      // dead end. Answering "nothing is blocked" there is the disagreement this
      // module promises cannot happen, and registering the tool in READY without
      // this made it reachable rather than fixing it.
      //
      // The stored question is re-evaluated against the venue as it stands, so
      // a repaired venue answers blocked:false and a venue that closed further
      // is described by what blocks it now.
      if (lastRefusal) {
        const considered = ROUTES
          .filter((candidate) => !lastRefusal.excludeRouteIds.includes(candidate.id))
          .map((candidate) => evaluateRoute(candidate, lastRefusal.requirements, state.resources));
        if (!considered.some((option) => option.feasible)) {
          const diagnosis = diagnoseNoBundle(considered);
          return {
            blocked: true,
            phase,
            errorCode: lastRefusal.code,
            planId: null,
            venueRevision: state.resourceVersion,
            requirements: lastRefusal.requirements,
            brokenRules: considered.flatMap((option) => option.checks.filter((check) => !check.ok)),
            partialReservations: partialReservationCount(),
            rejectedAction: { action: lastRefusal.rejectedAction, reason: lastRefusal.code },
            validOptionsNow: [],
            ...diagnosis,
          };
        }
      }
      return {
        blocked: false,
        phase,
        venueRevision: state.resourceVersion,
        message: 'Nothing is blocked. No refusal to explain.',
      };
    }

    const route = ROUTES.find((candidate) => candidate.id === plan.routeId);
    const evaluation = evaluateRoute(route, plan.requirements, state.resources);
    // Every route is evaluated, the plan's own included: if it still passes,
    // it is a valid option and saying otherwise would contradict the planner.
    const alternatives = ROUTES
      .map((candidate) => evaluateRoute(candidate, plan.requirements, state.resources));
    // Scoped to the plan being explained. It used to take the last REJECTED
    // entry ever written, so a refusal from a previous, fully recovered episode
    // was still reported as the action that had been rejected.
    // Scoped to the plan being explained, and only while the refusal is still
    // the last thing that happened to it. This took the last REJECTED entry
    // ever written, so a refusal from a previous, fully recovered episode was
    // reported as the action that had been rejected - and scoping alone was not
    // enough, because a replacement plan carries its predecessor's refusals
    // with it. A success on the same episode after the refusal means the caller
    // recovered from it, and a recovered refusal is history, not the answer to
    // "what was rejected".
    const episode = new Set([plan.id, plan.supersedesPlanId].filter(Boolean));
    const latest = state.audit
      .filter((entry) => (entry.refs ?? []).some((ref) => episode.has(ref)))
      .at(-1) ?? null;
    const rejection = latest?.outcome === 'REJECTED' ? latest : null;
    const usable = alternatives.filter((option) => option.feasible);

    return {
      blocked: true,
      phase,
      errorCode: phase === 'NO_ALTERNATIVE' ? 'NO_COMPLETE_BUNDLE' : 'STALE_RESOURCE_VERSION',
      planId: plan.id,
      planRevision: plan.basedOnResourceVersion,
      venueRevision: state.resourceVersion,
      // Scoped to what is actually in the way of THIS refusal.
      //
      // A plan invalidated by a change somewhere else in the venue has nothing
      // broken about it: its own route still passes every rule and only the
      // revision moved. Reporting a failed rule there claims a failure that did
      // not happen, which is the one thing this product may never do.
      //
      // Once the plan's own route IS broken, every route's failing rules are
      // reported rather than the plan's alone: with both lifts out an agent was
      // told about one of the two, and the second lift is what decides whether
      // replanning could help at all.
      brokenRules: evaluation.feasible
        ? []
        : alternatives.flatMap((option) => option.checks.filter((check) => !check.ok)),
      partialReservations: partialReservationCount(),
      rejectedAction: rejection ? { action: rejection.action, reason: rejection.reason ?? null } : null,
      validOptionsNow: usable.map((option) => ({ routeId: option.routeId, label: option.label, path: option.path })),
      // A route still works, so replanning is the answer. Otherwise the same
      // canonical diagnosis the refusal carried decides, rather than a second
      // literal computed here: an explanation that advertised a different next
      // action from the refusal it explains is exactly the disagreement this
      // module's own comment promises cannot happen.
      // The same three fields the READY branch carries. They were produced only
      // there, so in PLAN_STALE and NO_ALTERNATIVE - the two states this tool
      // exists for - an agent could not tell a dead end it can act on from one
      // only the venue can open.
      ...(() => {
        const diagnosis = diagnoseNoBundle(alternatives);
        return {
          ...diagnosis,
          nextAction: usable.length ? 'REPLAN' : diagnosis.nextAction,
        };
      })(),
    };
  }

  function restoreFacility(resourceId, { actor = 'venue-operator', toolName = null } = {}) {
    const resource = state.resources[resourceId];
    if (!resource || resource.kind !== 'FACILITY') {
      throw new DomainError('FACILITY_NOT_FOUND', 'The requested facility does not exist.', 404);
    }
    if (resource.status === 'OPERATIONAL' && state.demo.pendingOutageResourceId !== resourceId) {
      return snapshot();
    }

    // A lift that is armed but still running has not gone anywhere, so putting
    // it "back in service" is a sentence about something that did not happen -
    // and it moved the venue revision and invalidated a valid staged plan for a
    // facility change that never occurred. Disarming is its own event.
    if (resource.status === 'OPERATIONAL') {
      const cleared = clone(state);
      cleared.demo.pendingOutageResourceId = null;
      addAudit(cleared, {
        actor,
        toolName,
        action: 'OUTAGE_SIGNAL_CLEARED',
        outcome: 'SUCCESS',
        refs: [resourceId],
        message: `${resource.label} is no longer armed to fail; it never left service.`,
        resourceVersionBefore: cleared.resourceVersion,
        resourceVersionAfter: cleared.resourceVersion,
      }, clock);
      state = cleared;
      return snapshot();
    }

    const draft = clone(state);
    const before = draft.resourceVersion;
    draft.resources[resourceId].status = 'OPERATIONAL';
    delete draft.resources[resourceId].outageReason;
    if (draft.demo.pendingOutageResourceId === resourceId) draft.demo.pendingOutageResourceId = null;
    draft.resourceVersion += 1;
    invalidateOpenPlans(draft);
    addAudit(draft, {
      actor,
      toolName,
      action: 'FACILITY_RESTORED',
      outcome: 'SUCCESS',
      refs: [resourceId],
      message: `${resource.label} is back in service.`,
      resourceVersionBefore: before,
      resourceVersionAfter: draft.resourceVersion,
    }, clock);
    state = draft;
    return snapshot();
  }

  return {
    snapshot,
    hasBooking: () => Boolean(state.activeBookingId),
    idempotencyRecordCount: () => Object.keys(state.idempotency).length,
    rememberedRefusalCount: () => refusals.size,
    releaseSession: (sessionKey) => forgetRefusal(sessionKey),
    findBundle,
    stageBundle,
    armOutage,
    setFacilityOutage,
    restoreFacility,
    replanBundle,
    prepareConfirmation,
    commitBundle,
    clearPlan,
    listAccessOptions,
    checkAccessRoute,
    explainRefusal,
    setResourceUnavailable,
    reset,
  };
}

export const demoDefaults = clone(DEFAULT_REQUIREMENTS);
