/**
 * Page decisions that have to name the right facility, as pure functions.
 *
 * Three separate repairs in this project fixed one occurrence of a hardcoded
 * facility and left the class alive, because the decision lived inside a
 * DOM-writing function. That shape has two costs: the only automated check
 * available is a regex over the source, which already missed a double-quoted
 * literal; and the same logic gets re-derived on the other page.
 *
 * Production imports these. Tests import the same functions, so what is tested
 * is the shipped decision rather than a restatement of it.
 *
 * No DOM, no fetch, no module state - given a snapshot, each returns a value.
 */

/**
 * The one facility the visitor's demo control operates on.
 *
 * This is configuration, not a hidden assumption: the visitor page offers a
 * single lift-failure button and that button is about the East lift. Stated
 * once, here, so the pages never spell it again - and so a change is one edit
 * rather than a hunt through two files.
 */
export const VISITOR_CONTROL_FACILITY_ID = 'east-lift';

const OPERATOR_ACTIONS = Object.freeze(['arm', 'outage', 'restore']);

/** Titles for entries that are not about one facility. */
const ACTION_TITLES = Object.freeze({
  PLAN_CREATED: 'Access plan calculated',
  PLAN_STAGED: 'Access plan staged',
  OUTAGE_SIGNAL_ARMED: 'Facility fault armed',
  FACILITY_OUTAGE_REPORTED: 'Facility outage committed',
  FACILITY_RESTORED: 'Facility returned to service',
  PLAN_CLEARED: 'Plan cleared',
  NO_ALTERNATIVE_FOUND: 'No complete alternative',
  COMMIT_REJECTED_STALE: 'Stale booking rejected',
  REPLACEMENT_PLAN_CREATED: 'Replacement calculated',
  REPLACEMENT_PLAN_STAGED: 'Replacement staged',
  PLAN_REPLANNED: 'Plan replaced',
  HUMAN_CONFIRMATION_PREPARED: 'Customer confirmation prepared',
  BUNDLE_COMMITTED: 'Atomic bundle committed',
  DEMO_RESET: 'Demo reset',
  RESOURCE_UNAVAILABLE: 'Resource unavailable',
});

/** How each facility action reads once the facility is known. */
const FACILITY_TITLES = Object.freeze({
  OUTAGE_SIGNAL_ARMED: (label) => `${label} fault armed`,
  FACILITY_OUTAGE_REPORTED: (label) => `${label} outage reported`,
  FACILITY_RESTORED: (label) => `${label} returned to service`,
});

function facilityLabel(snapshot, facilityId) {
  if (!facilityId) return null;
  const resource = snapshot?.resources?.[facilityId];
  return resource?.kind === 'FACILITY' ? resource.label : null;
}

/**
 * What the visitor's fault control says, and what pressing it does.
 *
 * The mode is decided first and everything else follows from it, because the
 * defect this replaces was a control whose text and behaviour disagreed: it
 * read `eastOut` before `armed`, so with East already out and another lift
 * armed it offered "Put East Lift back in service" while setting
 * aria-disabled=true. It named an action it would then refuse to perform.
 *
 * A pending fault is venue state and takes precedence over any lift's status.
 */
export function faultControlView(state, { facilityId = VISITOR_CONTROL_FACILITY_ID } = {}) {
  const pendingId = state?.demo?.pendingOutageResourceId ?? null;
  const controlLabel = facilityLabel(state, facilityId) ?? 'the lift';

  if (pendingId) {
    const pendingLabel = facilityLabel(state, pendingId) ?? pendingId;
    return {
      mode: 'PENDING',
      text: `${pendingLabel} fault armed — now press confirm`,
      hint: `${pendingLabel} will fail during the next confirmation, after the plan looked complete.`,
      ariaDisabled: true,
      warning: true,
      quiet: false,
      request: null,
    };
  }

  if (state?.resources?.[facilityId]?.status === 'OUT_OF_SERVICE') {
    return {
      mode: 'RESTORE',
      text: `Put ${controlLabel} back in service`,
      hint: 'The lift is offline. Restore it here, or let the agent replan around it.',
      ariaDisabled: false,
      warning: false,
      quiet: true,
      request: { method: 'POST', path: operatorEndpoint(facilityId, 'restore') },
    };
  }

  return {
    mode: 'ARM',
    text: 'Take the lift out of service while I confirm',
    hint: 'Arms a lift failure that lands between your review and the server write.',
    ariaDisabled: false,
    warning: true,
    quiet: false,
    request: { method: 'POST', path: operatorEndpoint(facilityId, 'arm') },
  };
}

/**
 * The sentence above the operations arm button.
 *
 * It read "Arm a fault on X" in every state, including the two the venue
 * refuses: a lift already OUT_OF_SERVICE answers FACILITY_NOT_OPERATIONAL, and
 * a venue already holding a pending fault refuses a second one. The page
 * disabled the button and kept the instruction to press it, so the prose above
 * the control contradicted the control - the same defect as a mislabelled
 * button, one line higher up.
 *
 * The order matches faultControlView: a pending fault is venue state and takes
 * precedence over any single lift's status.
 */
export function raceIntroView(state, { facilityId = VISITOR_CONTROL_FACILITY_ID } = {}) {
  const pendingId = state?.demo?.pendingOutageResourceId ?? null;
  const label = facilityLabel(state, facilityId) ?? 'the lift';

  if (pendingId) {
    const pendingLabel = facilityLabel(state, pendingId) ?? pendingId;
    return {
      canArm: false,
      text: `A fault is already armed on ${pendingLabel}. It fires during the visitor's next confirmation, `
        + 'after the plan looked complete. Arming a second one is refused while this one is pending.',
    };
  }

  if (state?.resources?.[facilityId]?.status !== 'OPERATIONAL') {
    return {
      canArm: false,
      text: `${label} is already out of service, so there is no confirmation to lose it during. `
        + 'Put it back in service first, then arm the fault.',
    };
  }

  return {
    canArm: true,
    text: `Arm a fault on ${label}. The venue will report it after the visitor `
      + 'starts confirming the old plan but before the server commits it.',
  };
}

/**
 * What the incident card says when a plan cannot go ahead.
 *
 * The page used to print `next action CHANGE_REQUIREMENTS` and offer a "Change
 * requirements" button in a venue nothing the visitor can type will reopen. It
 * had no choice - the state payload carried no diagnosis - so it held a literal.
 * The venue ships `state.diagnosis` now and this turns it into copy.
 *
 * The control itself always stays: a visitor must be able to get back to their
 * requirements from any dead end. What it may not do is claim that editing them
 * reaches a plan.
 */
export function incidentView(state) {
  const diagnosis = state?.diagnosis ?? null;
  const venueOnly = diagnosis?.requirementChangeCanHelp === false && diagnosis?.nextAction !== 'REPLAN';
  const noAlternative = state?.phase === 'NO_ALTERNATIVE';
  // Whether THIS plan's own resources still hold. The heading was static markup
  // reading "Route changed - booking stopped", announced assertively, over a
  // map on the same screen saying every route resource is operational: a plan
  // is invalidated by any venue change, including one on the other route, and
  // in that case nothing about this route changed at all.
  const routeBroken = (state?.activePlan?.claims ?? []).some((claim) => (
    claim.consume ? claim.currentStatus !== 'AVAILABLE' : claim.currentStatus !== 'OPERATIONAL'
  ));

  if (noAlternative) {
    return {
      heading: 'No complete route — booking stopped',
      venueOnly,
      nextAction: diagnosis?.nextAction ?? 'CONTACT_VENUE_STAFF',
      message: venueOnly
        ? 'No route is open at all: the venue itself has to restore a lift. Nothing was booked, and no requirement you change can reach a plan while this lasts.'
        : 'No alternative stays within every current limit. Nothing was booked. Change a requirement or ask venue staff for a manual review.',
      buttonLabel: venueOnly ? 'Back to my requirements' : 'Change requirements',
      action: 'CLEAR_PLAN',
      busyLabel: 'Opening your requirements…',
    };
  }

  // A venue with every lift out and no replan attempted yet is still
  // PLAN_STALE, so choosing the action by phase ran a replan under a button
  // reading "Back to my requirements". The label and the action come from one
  // decision now, because a control that does something other than what it says
  // is the exact failure this product exists to argue against.
  const clear = venueOnly;
  return {
    heading: routeBroken ? 'Route changed — booking stopped' : 'Venue updated — booking stopped',
    venueOnly,
    nextAction: diagnosis?.nextAction ?? 'REPLAN',
    message: null,
    buttonLabel: clear ? 'Back to my requirements' : 'Find another complete plan',
    action: clear ? 'CLEAR_PLAN' : 'REPLAN',
    busyLabel: clear ? 'Opening your requirements…' : 'Checking another complete route…',
  };
}

/**
 * The banner shown when a search refuses before any plan exists.
 *
 * This was a hardcoded sentence telling the visitor to change a requirement.
 * With every lift out, the server's answer to that very call is
 * `requirementChangeCanHelp: false, nextAction: CONTACT_VENUE_STAFF` - so the
 * page contradicted the refusal it was printing, in the exact state where
 * following the advice loops for ever.
 *
 * incidentView already did this correctly, but the incident card renders only
 * in PLAN_STALE and NO_ALTERNATIVE. A READY-phase refusal opens no plan, so the
 * honest copy was unreachable and the literal was all a visitor ever saw: the
 * same defect the project documents as fixed, alive in the path the fix missed.
 */
export function standingRefusalView(message, diagnosis = {}) {
  const canHelp = diagnosis?.requirementChangeCanHelp ?? null;
  const shortest = diagnosis?.shortestFeasibleDistanceM ?? null;

  if (canHelp === false) {
    return {
      requirementChangeCanHelp: false,
      text: `${message} No requirement you change can reach a plan while this lasts: a lift is out of `
        + 'service. The venue operations page shows which one.',
    };
  }

  if (canHelp === true) {
    return {
      requirementChangeCanHelp: true,
      text: shortest === null
        ? `${message} Change a requirement and try again.`
        : `${message} Change a requirement and try again - the shortest route the venue has is ${shortest} m.`,
    };
  }

  // No diagnosis travelled with this refusal. Say what the venue said and add
  // nothing, rather than guessing which of the two answers applies.
  return { requirementChangeCanHelp: null, text: message };
}

/**
 * What a replan actually produced, in the visitor's words.
 *
 * A plan can go stale because the venue revision moved for a reason on the
 * OTHER route, and the domain deliberately hands back the same route then - it
 * clears the exclusion list to say so. Every visible string said otherwise:
 * "ALTERNATIVE FOUND", "The route changed. You decide.", "Accept the
 * replacement plan", "A complete replacement route is ready". The route was
 * byte-identical. Asking a disabled visitor to re-evaluate an arrival route
 * that did not change is the opposite of what this product promises.
 */
export function replanOutcomeView(plan) {
  const supersededRoute = plan?.supersedesRouteId ?? null;
  if (!supersededRoute) {
    return {
      sameRoute: null,
      eyebrow: 'ONE COMPLETE PLAN',
      title: 'A complete option was found',
      heading: 'Review the whole plan.',
      confirmLabel: 'Confirm this accessible booking',
      toast: 'A complete plan is ready for your decision.',
    };
  }

  if (plan.routeId === supersededRoute) {
    return {
      sameRoute: true,
      eyebrow: 'ROUTE RECHECKED',
      title: 'The same route still works',
      heading: 'Your route is unchanged. It was rechecked.',
      confirmLabel: 'Confirm this accessible booking',
      toast: 'The venue changed elsewhere. Your route was rechecked and still works.',
    };
  }

  return {
    sameRoute: false,
    eyebrow: 'ALTERNATIVE FOUND',
    title: 'A working arrival route is ready',
    heading: 'The route changed. You decide.',
    confirmLabel: 'Accept the replacement plan',
    toast: 'A complete replacement route is ready for your decision.',
  };
}

/**
 * Where focus goes when a control the visitor is holding is about to be
 * disabled.
 *
 * The page passed a preferred landing place and stopped there. But
 * #decision-heading lives inside a section that is hidden in PLAN_READY, and
 * focus() on a hidden element is a no-op - so an agent creating a plan under a
 * visitor who was typing dropped focus to <body> in silence.
 *
 * This lives here rather than in the page because a decision inside app.js
 * cannot be driven by a Node test, and the source-shape guard that stood in for
 * one passed while a mutation removed the refuge entirely.
 */
export function focusRefuge({ focusIsOnControl = false, fallbackVisible = false } = {}) {
  if (!focusIsOnControl) return 'NONE';
  return fallbackVisible ? 'FALLBACK' : 'MAIN';
}

/**
 * Which of a booking's own resources have left service since it was confirmed.
 *
 * The booking stands - nothing is refunded or cancelled - but the page said
 * "Your accessible booking is complete." over a resource grid reading "East
 * Lift L2 - Out of service", and announced nothing at all. Someone using a
 * screen reader was never told the route they had been given had broken.
 */
export function bookedResourcesOutOfService(booking, resources = {}) {
  return (booking?.resourceIds ?? [])
    .filter((id) => ['OUT_OF_SERVICE', 'UNAVAILABLE'].includes(resources[id]?.status))
    .map((id) => resources[id]?.label ?? id);
}

/** What to say about that, or null when there is nothing to say. */
export function bookingBreakageAnnouncement(labels = []) {
  if (labels.length === 0) return null;
  return `${labels.join(' and ')} left service after your booking was confirmed. `
    + 'The booking still stands; ask venue staff before you travel.';
}

/**
 * The decision log title for one entry.
 *
 * Every arm used to read "Facility fault armed" whatever it armed, in a product
 * whose entire argument is that a refusal names the thing that actually failed.
 * The facility comes from the entry's own refs and the snapshot's resources, so
 * a title cannot disagree with the row it sits above. An entry whose facility
 * cannot be resolved keeps the generic wording rather than guessing.
 */
export function auditTitle(entry, snapshot) {
  const generic = ACTION_TITLES[entry?.action] ?? 'Venue event';
  const specific = FACILITY_TITLES[entry?.action];
  if (!specific) return generic;
  const label = facilityLabel(snapshot, entry?.refs?.[0]);
  return label ? specific(label) : generic;
}

/**
 * The endpoint for one operator action on one facility.
 *
 * Built from the facility that was asked about, so the URL, the visible label
 * and the resulting state cannot name three different lifts. Refuses rather
 * than defaults: a missing facility silently becoming East is exactly the
 * defect this project has repaired three times.
 */
export function operatorEndpoint(facilityId, action) {
  if (typeof facilityId !== 'string' || facilityId.length === 0) {
    throw new Error(`operatorEndpoint needs a facility id, received ${JSON.stringify(facilityId)}`);
  }
  if (!OPERATOR_ACTIONS.includes(action)) {
    throw new Error(`operatorEndpoint does not know the action ${JSON.stringify(action)}`);
  }
  return `/api/operator/facilities/${facilityId}/${action}`;
}

export { OPERATOR_ACTIONS, ACTION_TITLES };
