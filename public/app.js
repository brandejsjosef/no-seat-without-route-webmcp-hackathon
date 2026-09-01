import { createVisitorTools, toolsForPhase } from '/tools.mjs';
import {
  faultControlView, incidentView, replanOutcomeView, standingRefusalView,
  focusRefuge, bookedResourcesOutOfService, bookingBreakageAnnouncement, bookingImpactView,
  buildPlanButtonView,
} from '/views.mjs';

const elements = {
  venueVersion: document.querySelector('#venue-version'),
  demoControls: document.querySelector('#demo-controls'),
  demoControlsEyebrow: document.querySelector('#demo-controls-eyebrow'),
  demoControlsHeading: document.querySelector('#demo-controls-heading'),
  demoControlsCopy: document.querySelector('#demo-controls-copy'),
  faultButton: document.querySelector('#fault-button'),
  faultHint: document.querySelector('#fault-hint'),
  shareLinkButton: document.querySelector('#share-link-button'),
  operatorLink: document.querySelector('#operator-link'),
  footerOperatorLink: document.querySelector('#footer-operator-link'),
  venueLiveStatus: document.querySelector('#venue-live-status'),
  venueLiveText: document.querySelector('#venue-live-text'),
  main: document.querySelector('#main'),
  venueNotice: document.querySelector('#venue-notice'),
  webmcpStatus: document.querySelector('#webmcp-status'),
  webmcpStatusText: document.querySelector('#webmcp-status-text'),
  requirementsForm: document.querySelector('#requirements-form'),
  buildPlanButton: document.querySelector('#build-plan-button'),
  startOverButton: document.querySelector('#start-over-button'),
  assuranceEmpty: document.querySelector('#assurance-empty'),
  planFeedback: document.querySelector('#plan-feedback'),
  planFeedbackHeading: document.querySelector('#plan-feedback-heading'),
  planFeedbackMessage: document.querySelector('#plan-feedback-message'),
  assurancePlan: document.querySelector('#assurance-plan'),
  planEyebrow: document.querySelector('#plan-eyebrow'),
  planTitle: document.querySelector('#plan-title'),
  planState: document.querySelector('#plan-state'),
  planVerification: document.querySelector('#plan-verification'),
  planExplanation: document.querySelector('#plan-explanation'),
  resourceGrid: document.querySelector('#resource-grid'),
  routeSection: document.querySelector('#route-section'),
  routeSummary: document.querySelector('#route-summary'),
  routeSteps: document.querySelector('#route-steps'),
  routeStats: document.querySelector('#route-stats'),
  mapDescription: document.querySelector('#map-description'),
  routeEast: document.querySelector('#route-east'),
  routeGarden: document.querySelector('#route-garden'),
  eastLiftMap: document.querySelector('#east-lift-map'),
  eastOutageCross: document.querySelector('#east-outage-cross'),
  gardenLiftMap: document.querySelector('#garden-lift-map'),
  gardenOutageCross: document.querySelector('#garden-outage-cross'),
  companionSeatMap: document.querySelector('#companion-seat-map'),
  incident: document.querySelector('#incident'),
  incidentHeading: document.querySelector('#incident-heading'),
  incidentMessage: document.querySelector('#incident-message'),
  incidentDetail: document.querySelector('#incident-detail'),
  partialCount: document.querySelector('#partial-count'),
  replanButton: document.querySelector('#replan-button'),
  decisionSection: document.querySelector('#decision-section'),
  decisionHeading: document.querySelector('#decision-heading'),
  confirmButton: document.querySelector('#confirm-button'),
  receiptSection: document.querySelector('#receipt-section'),
  bookingImpactAlert: document.querySelector('#booking-impact-alert'),
  bookingImpactAlertHeading: document.querySelector('#booking-impact-alert-heading'),
  bookingImpactAlertMessage: document.querySelector('#booking-impact-alert-message'),
  bookingImpactAlertProof: document.querySelector('#booking-impact-alert-proof'),
  receiptHeading: document.querySelector('#receipt-heading'),
  receiptNumber: document.querySelector('#receipt-number'),
  receiptDetails: document.querySelector('#receipt-details'),
  receiptIntroText: document.querySelector('#receipt-intro-text'),
  atomicProofText: document.querySelector('#atomic-proof-text'),
  auditList: document.querySelector('#audit-list'),
  copyPromptButton: document.querySelector('#copy-prompt-button'),
  examplePrompt: document.querySelector('#example-prompt'),
  toolList: document.querySelector('#tool-list'),
  resetButton: document.querySelector('#reset-button'),
  toast: document.querySelector('#toast'),
  a11yStatus: document.querySelector('#a11y-status'),
  a11yAlert: document.querySelector('#a11y-alert'),
  protocolChannel: document.querySelector('#protocol-channel'),
  protocolTool: document.querySelector('#protocol-tool'),
  protocolResult: document.querySelector('#protocol-result'),
};

let currentState = null;
let lastPhase = null;
let toastTimer = null;
let registeredToolSignature = '';
let toolControllers = [];
let sessionToken = '';
let operatorToken = '';
let demoId = '';
let lastSuccessfulRefresh = 0;
let visitorTools = [];
let refreshQueue = Promise.resolve();
let pendingRefreshes = 0;

const auditLabels = {
  DEMO_RESET: 'Demo data reset',
  PLAN_CREATED: 'Complete plan found',
  PLAN_STAGED: 'Plan prepared for review',
  OUTAGE_SIGNAL_ARMED: 'Operator armed a live fault',
  FACILITY_OUTAGE_REPORTED: 'Venue reported a lift outage',
  FACILITY_RESTORED: 'Venue restored a lift',
  COMMIT_REJECTED_STALE: 'Old plan rejected safely',
  REPLACEMENT_PLAN_CREATED: 'Replacement route found',
  REPLACEMENT_PLAN_STAGED: 'Replacement plan prepared',
  PLAN_REPLANNED: 'Old route replaced',
  NO_ALTERNATIVE_FOUND: 'No complete alternative found',
  PLAN_CLEARED: 'Plan cleared for new requirements',
  HUMAN_CONFIRMATION_PREPARED: 'Full plan shown for confirmation',
  BUNDLE_COMMITTED: 'Whole bundle confirmed',
};

const visitorAuditActions = new Set([
  'PLAN_STAGED',
  'OUTAGE_SIGNAL_ARMED',
  'FACILITY_OUTAGE_REPORTED',
  'FACILITY_RESTORED',
  'COMMIT_REJECTED_STALE',
  'PLAN_REPLANNED',
  'NO_ALTERNATIVE_FOUND',
  'PLAN_CLEARED',
  'BUNDLE_COMMITTED',
]);

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/**
 * The page repaints once a second. Assigning textContent replaces the node
 * even when the string is identical, which re-fires a live region and resets a
 * screen reader's reading position. Only write when something actually changed.
 */
function setText(element, value) {
  const next = String(value);
  if (element.textContent !== next) element.textContent = next;
}

function setHtml(element, html) {
  if (element.innerHTML !== html) element.innerHTML = html;
}

/**
 * The venue's own phrasing for a resource status, the same wording the domain
 * puts in a refusal: OUT_OF_SERVICE reads back as "out of service".
 */
function humanStatus(status) {
  return String(status ?? 'UNKNOWN').toLowerCase().replaceAll('_', ' ');
}

/**
 * Regions that are always present in the accessibility tree. Filling a hidden
 * region and then revealing it is announced inconsistently across assistive
 * technology, so these stay rendered and empty until there is something to say.
 */
function announce(message, assertive = false) {
  const region = assertive ? elements.a11yAlert : elements.a11yStatus;
  if (!region) return;
  if (region.textContent === message) region.textContent = '';
  region.textContent = message;
}

/**
 * An assertive message that outlives the transaction it was announced during.
 * The incident renderer owns the alert region while an incident is on screen
 * and empties it once recovery succeeds; a standing warning about the venue
 * itself must not be swept away by that, or it would be visible on the page
 * and inaudible to anyone using a screen reader.
 */
let standingAlert = '';
let lastBookingImpactSignature = 'NONE';

/**
 * Disabling the focused control silently drops focus to the document body.
 *
 * The fallback alone was not enough: #decision-heading lives inside
 * #decision-section, which is hidden in PLAN_READY, and focus() on a hidden
 * element is a no-op. So an agent creating a plan under a visitor who was
 * typing their requirements dropped focus to <body> in silence - measured, and
 * announced nowhere. #main is always present and always focusable, so it is the
 * refuge when the preferred landing place is not on screen.
 */
function disableSafely(element, disabled, fallback) {
  let moved = false;
  if (disabled && !element.disabled) {
    const target = focusRefuge({
      focusIsOnControl: document.activeElement === element,
      // A heading inside a hidden section cannot take focus, and asking it to
      // leaves focus on <body>.
      fallbackVisible: Boolean(fallback && !fallback.closest('[hidden]')),
    });
    if (target === 'FALLBACK') fallback.focus({ preventScroll: true });
    if (target === 'MAIN') elements.main?.focus?.({ preventScroll: true });
    moved = target !== 'NONE';
  }
  element.disabled = disabled;
  return moved;
}

/**
 * A control the visitor pressed is disabled for the length of its request.
 * Setting `.disabled = true` directly dropped focus to <body>, and on the
 * FAILURE paths nothing ever put it back - so a keyboard user who pressed
 * Confirm on a plan another session had cleared was left at the document root
 * with a polite toast that vanished after four seconds. The control comes back;
 * so does the focus that was on it.
 */
function releaseFocusTo(button, restore) {
  if (!restore || document.activeElement === button) return;
  // Only when focus was actually LOST. A successful confirmation moves focus to
  // the receipt heading on its way out, and an unconditional restore here stole
  // it back to #main - a repair for the failure path breaking the success path,
  // caught by the browser suite rather than by any of this file's own guards.
  //
  // Focus on <body> is the signal: it is where a disabled control leaves it and
  // nowhere a deliberate move ever lands.
  if (document.activeElement !== document.body) return;
  const target = focusRefuge({ focusIsOnControl: true, fallbackVisible: !button.closest('[hidden]') });
  if (target === 'FALLBACK') button.focus({ preventScroll: true });
  else elements.main?.focus?.({ preventScroll: true });
}

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
/** A behaviour passed in JavaScript overrides the reduced-motion CSS rule. */
const scrollBehavior = () => (reduceMotion.matches ? 'auto' : 'smooth');

function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  announce(message);
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 4200);
}

async function api(path, options = {}) {
  const { token, ...rest } = options;
  const response = await fetch(path, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(token ?? sessionToken ? { 'X-Demo-Session': token ?? sessionToken } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error?.message ?? 'Request failed.');
    error.code = payload.error?.code ?? 'REQUEST_FAILED';
    error.details = payload.error ?? {};
    error.status = response.status;
    throw error;
  }
  return payload;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readStoredDemoId() {
  try {
    return localStorage.getItem('nswr-demo-id');
  } catch {
    return null;
  }
}

/**
 * A demo identifier carried in the URL beats one kept in this browser.
 * The booking page and the operations page are often opened in two different
 * browsers - the agent's and the operator's - and only a shared link puts both
 * of them on the same venue.
 */
function preferredDemoId() {
  const fromUrl = new URL(window.location.href).searchParams.get('demo');
  if (fromUrl && UUID_PATTERN.test(fromUrl)) return fromUrl.toLowerCase();
  const stored = readStoredDemoId();
  return stored && UUID_PATTERN.test(stored) ? stored : null;
}

function rememberDemoId(id) {
  demoId = id;
  try {
    localStorage.setItem('nswr-demo-id', id);
  } catch {
    /* Private windows may refuse storage; the URL still carries the identifier. */
  }
  const url = new URL(window.location.href);
  if (url.searchParams.get('demo') !== id) {
    url.searchParams.set('demo', id);
    window.history.replaceState({}, '', url);
  }
  const operatorHref = `/operator?demo=${encodeURIComponent(id)}`;
  if (elements.operatorLink) elements.operatorLink.href = operatorHref;
  if (elements.footerOperatorLink) elements.footerOperatorLink.href = operatorHref;
}

/**
 * The venue store is in-process. A restart therefore loses every venue, and a
 * `?demo=` link that pointed at one is answered with a new empty venue built
 * under the same identifier. Presenting that as the venue the visitor was
 * looking at is the one failure this page must never produce: a confirmed
 * booking would silently become a fresh READY page reporting "Venue data live".
 *
 * The warning is raised only when this browser had itself been using that venue
 * - a remembered identifier that the server no longer has is a loss. Opening
 * someone else's fresh link, or a `?demo=` identifier chosen by hand, joins a
 * new venue without ever having had an older one to lose.
 */
/**
 * A refusal the visitor cannot act on must not disappear. showToast clears
 * itself after 4200ms, so typing a width the form permits but no route can
 * satisfy produced four seconds of text and then a page that looked brand new -
 * empty decision log, enabled build button, no trace that anything was refused.
 */
/** The venue revision the standing refusal was raised against. */
let standingRefusalRevision = null;

function showStandingRefusal(refusal, venueRevision) {
  standingRefusalRevision = venueRevision ?? null;
  // The whole refusal, not a message and an optional second argument: dropping
  // the diagnosis at the call site restored the old contradiction and no test
  // noticed, because the guard only looked for the function name.
  const view = standingRefusalView(refusal?.message, refusal?.details);
  elements.planFeedbackMessage.textContent = view.text;
  elements.planFeedback.hidden = false;
  elements.assuranceEmpty.hidden = true;
  elements.assurancePlan.hidden = true;
  elements.buildPlanButton.setAttribute('aria-describedby', 'plan-feedback-message');
}

function clearStandingRefusal() {
  standingRefusalRevision = null;
  elements.planFeedback.hidden = true;
  elements.planFeedbackMessage.textContent = '';
  elements.buildPlanButton.removeAttribute('aria-describedby');
}

function showVenueRebuiltNotice() {
  const message = 'The venue this browser was using no longer exists on the server, so this page opened a new, '
    + 'empty one. Any plan or booking made before now was not carried over. Nothing shown below is a record of it.';
  elements.venueNotice.textContent = message;
  elements.venueNotice.hidden = false;
  standingAlert = message;
  announce(message, true);
}

async function startVisitorSession() {
  const requestedDemoId = preferredDemoId();
  const rememberedDemoId = readStoredDemoId();
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'visitor', demoId: requestedDemoId }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? 'Could not start the visitor session.');
  sessionToken = payload.session.token;
  rememberDemoId(payload.session.demoId);
  const lostAVenueThisBrowserHad = Boolean(requestedDemoId)
    && String(rememberedDemoId ?? '').toLowerCase() === requestedDemoId
    && payload.session.venueExisted === false;
  if (lostAVenueThisBrowserHad) showVenueRebuiltNotice();
}

/**
 * The operations role is a separate server-side session. A visitor token is
 * refused by the operator endpoints, so the demo control below has to ask for
 * the other role explicitly rather than reusing the booking session.
 */
async function ensureOperatorSession() {
  if (operatorToken) return operatorToken;
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'operator', demoId }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? 'Could not open the operations role.');
  operatorToken = payload.session.token;
  return operatorToken;
}

/**
 * The demo control arms the fault instead of applying it straight away, so the
 * lift fails in the gap between the visitor reviewing a plan and the server
 * committing it. That gap is the whole point: a plan that looked complete a
 * second ago has to be refused rather than half-booked.
 */
let faultRequestInFlight = false;

async function toggleLiftFault() {
  // Neither the armed state nor the in-flight state may use `disabled`: this
  // button is pressed and then changes state on its own, and disabling the
  // focused element drops focus to the document body without saying so.
  if (faultRequestInFlight || elements.faultButton.getAttribute('aria-disabled') === 'true') return;
  // The same view the button was rendered from decides what is sent, so the
  // request cannot be about a different facility - or a different action -
  // than the text the visitor just read. A PENDING view carries no request at
  // all, which is the second half of the guard above rather than a repeat.
  const view = faultControlView(currentState ?? {});
  if (!view.request) return;
  faultRequestInFlight = true;
  elements.faultButton.setAttribute('aria-busy', 'true');
  try {
    const token = await ensureOperatorSession();
    await api(view.request.path, { method: view.request.method, body: '{}', token });
    await refreshState();
    if (view.mode === 'RESTORE') {
      setProtocolTrace('Venue operations role', 'restore_facility', `venue revision ${currentState.resourceVersion}`);
      showToast('East Lift is back in service.');
      elements.buildPlanButton.focus({ preventScroll: true });
      elements.buildPlanButton.scrollIntoView({ behavior: 'instant', block: 'center' });
    } else {
      setProtocolTrace('Venue operations role', 'arm lift fault', 'lands on the next confirmation');
      showToast('Fault armed. Now press confirm and watch the server refuse the plan.');
    }
  } catch (error) {
    showToast(error.message);
  } finally {
    faultRequestInFlight = false;
    elements.faultButton.removeAttribute('aria-busy');
  }
}

async function copyJoinLink() {
  const url = new URL(window.location.href);
  url.searchParams.set('demo', demoId);
  try {
    await navigator.clipboard.writeText(url.toString());
    showToast('Link copied. Opening it in another browser joins this same venue.');
  } catch {
    showToast(url.toString());
  }
}

function setProtocolTrace(channel, tool, result) {
  elements.protocolChannel.textContent = channel;
  elements.protocolTool.textContent = tool;
  elements.protocolResult.textContent = result;
}

function requirementsFromForm() {
  const data = new FormData(elements.requirementsForm);
  return {
    wheelchairWidthCm: Number(data.get('wheelchairWidthCm')),
    maxDistanceM: Number(data.get('maxDistanceM')),
    stepFree: data.has('stepFree'),
    companionCount: data.has('companion') ? 1 : 0,
    entranceAssistance: data.has('assistance'),
    lowStimulus: data.has('lowStimulus'),
  };
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function renderPlan(state) {
  const plan = state.activePlan;
  const refused = standingRefusalRevision !== null && !plan;
  elements.assuranceEmpty.hidden = Boolean(plan) || refused;
  elements.planFeedback.hidden = !refused;
  elements.assurancePlan.hidden = !plan;
  elements.routeSection.hidden = !plan;

  if (!plan) return;

  const isReplacement = plan.kind === 'REPLACEMENT';
  const isProposed = plan.status === 'PROPOSED';
  const isStale = ['PLAN_STALE', 'NO_ALTERNATIVE'].includes(state.phase) || ['STALE', 'NO_ALTERNATIVE'].includes(plan.status);
  const liftOut = state.resources[plan.route.liftId]?.status !== 'OPERATIONAL';
  // A replan around an outage on the OTHER route hands back the same route on
  // purpose. Calling that a replacement asked a disabled visitor to re-evaluate
  // an arrival route that had not changed.
  const outcome = replanOutcomeView(plan);
  elements.planEyebrow.textContent = isReplacement ? outcome.eyebrow : 'ONE COMPLETE PLAN';
  elements.planTitle.textContent = isReplacement
    ? outcome.title
    : isProposed ? 'A complete option was found' : 'Your route and seats are ready';
  elements.planState.textContent = state.phase === 'CONFIRMED'
    ? 'Confirmed'
    : state.phase === 'NO_ALTERNATIVE'
      ? 'Needs your input'
      : isStale
        ? 'Stopped safely'
        : isProposed
          ? 'Proposed'
          : 'Ready for review';
  elements.planState.classList.toggle('stale', isStale);
  elements.planVerification.textContent = isStale
    ? `Plan revision ${plan.basedOnResourceVersion} no longer matches venue revision ${state.resourceVersion}`
    : state.phase === 'CONFIRMED'
      // The booking's own number. This restated the CURRENT venue revision as
      // the one it was committed at, so after any later outage the line
      // contradicted the receipt directly beneath it.
      ? `Committed together · venue revision ${state.booking?.committedResourceVersion ?? plan.basedOnResourceVersion}`
      : `All resources checked · venue revision ${plan.basedOnResourceVersion}`;
  elements.planExplanation.textContent = isProposed
    ? 'The agent found a viable option. It must recheck and stage it before you can review or confirm anything.'
    : isStale
      ? 'This plan cannot be confirmed. No ticket or reservable resource has been issued.'
      : state.phase === 'CONFIRMED'
        ? 'The route facilities were revalidated and every reservable resource was written in one transaction.'
        : 'A ready plan is still not a booking. Only your visible confirmation can commit it.';

  const resourceItems = [
    { label: 'Wheelchair space W12', detail: 'No transfer required' },
    ...(plan.requirements.companionCount ? [{ label: 'Companion seat W13', detail: 'Adjacent to W12' }] : []),
    { label: plan.route.entrance, detail: plan.requirements.lowStimulus ? 'Lower-stimulus arrival' : 'Step-free arrival' },
    { label: plan.route.liftLabel, detail: liftOut ? 'Out of service' : 'Operational now' },
    ...(plan.requirements.entranceAssistance ? [{ label: plan.route.assistanceLabel, detail: 'Entrance assistance' }] : []),
  ];

  setHtml(elements.resourceGrid, resourceItems.map((item, index) => `
    <div class="resource-item" role="listitem">
      <span class="resource-number">${index + 1}</span>
      <span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></span>
    </div>
  `).join(''));

  elements.routeSummary.textContent = `${plan.route.path.join(' → ')}. ${plan.route.durationMinutes} minutes, ${plan.route.distanceM} metres, no steps.`;
  setHtml(elements.routeSteps, plan.route.path.map((step) => `<li>${escapeHtml(step)}</li>`).join(''));
  setHtml(elements.routeStats, [
    `${plan.route.durationMinutes} minutes`,
    `${plan.route.distanceM} metres`,
    `${plan.route.minWidthCm} cm minimum width`,
    'No steps',
  ].map((stat) => `<span>${escapeHtml(stat)}</span>`).join(''));
  elements.mapDescription.textContent = `${plan.route.path.join(' to ')}. ${liftOut ? `${plan.route.liftLabel} is out of service and this route is unavailable.` : 'Every route resource is currently operational.'}`;

  // Both lifts, read from the venue rather than one hardcoded id. The previous
  // version asked only about east-lift, so a Garden outage left the map drawing
  // a healthy green route while the resource card beside it read "out of
  // service" - the picture contradicting the text next to it.
  const lifts = [
    { id: 'east-lift', routeId: 'east-lift-route', className: 'route-east', line: elements.routeEast, tile: elements.eastLiftMap, cross: elements.eastOutageCross },
    { id: 'garden-lift', routeId: 'garden-lift-route', className: 'route-garden', line: elements.routeGarden, tile: elements.gardenLiftMap, cross: elements.gardenOutageCross },
  ];
  for (const lift of lifts) {
    const out = state.resources[lift.id]?.status === 'OUT_OF_SERVICE';
    const selected = plan.routeId === lift.routeId;
    lift.line.className.baseVal = `route-line ${lift.className}${selected ? ' active' : ''}${out ? ' unavailable' : ''}`;
    lift.tile.classList.toggle('out', out);
    // hidden is an IDL attribute of HTMLElement and SVGElement does not inherit
    // it, so assigning to it set an expando and left the content attribute in
    // place - the cross could never appear. toggleAttribute writes the attribute
    // the stylesheet actually matches on.
    lift.cross.toggleAttribute('hidden', !out);
  }
  elements.companionSeatMap.classList.toggle('map-hidden', plan.requirements.companionCount === 0);
}

function renderIncident(state) {
  const visible = ['PLAN_STALE', 'NO_ALTERNATIVE'].includes(state.phase);
  elements.incident.hidden = !visible;
  if (!visible) {
    // The assertive region belongs to this incident. Once recovery succeeds,
    // leaving the old failure there gives screen-reader users two contradictory
    // transaction states even though the visible incident is gone. Anything
    // still standing about the venue as a whole is put back, not discarded.
    setText(elements.a11yAlert, standingAlert);
    return;
  }

  const planVersion = state.activePlan?.basedOnResourceVersion ?? '—';
  // What broke is read from this plan's own claims against the venue as it
  // stands now, never from the audit log. The previous version asked whether a
  // COMMIT_REJECTED_STALE had ever been recorded and then named East Lift L2
  // whatever the answer was about, which was wrong twice over: a Garden Lift
  // outage was reported to the visitor as an East Lift one, and because
  // retained history never expires, the first rejection made every later stale
  // state - including one where nothing had failed and only the revision had
  // moved - repeat that same East Lift story.
  const brokenClaims = (state.activePlan?.claims ?? []).filter((claim) => (
    claim.consume ? claim.currentStatus !== 'AVAILABLE' : claim.currentStatus !== 'OPERATIONAL'
  ));
  // Both the copy and the control come from public/views.mjs, so the page
  // cannot advertise an action the refusal itself says is useless. Reverting
  // this to a literal "Change requirements" survived the entire gate once: the
  // only guard was against printing a literal next action, and the button was
  // not covered by it.
  const incident = incidentView(state);
  setText(elements.incidentHeading, incident.heading);
  if (state.phase === 'NO_ALTERNATIVE') {
    setText(elements.incidentMessage, incident.message);
    setText(
      elements.incidentDetail,
      `NO_COMPLETE_BUNDLE · venue revision ${state.resourceVersion} · next action ${incident.nextAction}`,
    );
    // The control stays: a visitor must always be able to get back to their
    // requirements. What it may not do is claim that editing them helps.
    setText(elements.replanButton, incident.buttonLabel);
  } else {
    setText(elements.incidentMessage, brokenClaims.length
      ? `${brokenClaims.map((claim) => `${claim.label} is ${humanStatus(claim.currentStatus)}`).join(' and ')}. This plan was stopped, so no ticket or reservable resource was issued.`
      : 'A venue update invalidated this route before confirmation. Nothing had been booked.');
    // REPLAN was a literal here too, and reachable while wrong: with every lift
    // out and no replan attempted yet the phase is still PLAN_STALE, and there
    // is nothing to replan onto.
    setText(elements.incidentDetail, `STALE_RESOURCE_VERSION · plan revision ${planVersion} · venue revision ${state.resourceVersion} · next action ${incident.nextAction}`);
    setText(elements.replanButton, incident.buttonLabel);
  }
  setText(elements.partialCount, String(state.atomicity.reservedResourceCount));

  if (lastPhase && !['PLAN_STALE', 'NO_ALTERNATIVE'].includes(lastPhase)) {
    announce(`${elements.incidentHeading.textContent}. ${elements.incidentMessage.textContent}`, true);
    window.setTimeout(() => elements.incidentHeading.focus(), 0);
  }
}

function renderDecision(state) {
  const plan = state.activePlan;
  const visible = Boolean(plan && plan.status === 'STAGED' && !plan.stale && !state.booking);
  // An agent can stage a plan with nobody clicking anything, so the arrival of
  // a decision is announced here rather than from a click handler.
  const becameVisible = visible && elements.decisionSection.hidden;
  // An agent can clear a staged plan with nobody clicking anything. The section
  // was hidden underneath whoever was holding the confirm button, focus fell to
  // <body>, and role=status went on saying a complete plan was ready for a plan
  // that no longer existed.
  const heldFocus = !visible && elements.decisionSection.contains(document.activeElement);
  const wasVisible = !elements.decisionSection.hidden;
  elements.decisionSection.hidden = !visible;
  if (!visible) {
    if (wasVisible && !state.booking) {
      announce('The plan is no longer open for confirmation. Your requirements are editable again.');
    }
    if (heldFocus) elements.main?.focus?.({ preventScroll: true });
    return;
  }

  const replacement = plan.kind === 'REPLACEMENT';
  const outcome = replanOutcomeView(plan);
  setText(elements.decisionHeading, replacement ? outcome.heading : 'Review the whole plan.');
  setText(elements.confirmButton, replacement ? outcome.confirmLabel : 'Confirm this accessible booking');

  if (becameVisible) {
    announce(`Complete plan ready: ${plan.route.path.join(', then ')}. ${plan.route.distanceM} metres, no steps. Nothing is booked until you confirm.`);
  }
}

function renderReceipt(state) {
  const booking = state.booking;
  elements.receiptSection.hidden = !booking;
  if (!booking) {
    elements.bookingImpactAlert.hidden = true;
    elements.bookingImpactAlert.removeAttribute('aria-label');
    lastBookingImpactSignature = 'NONE';
    return;
  }

  // A booking stands whatever happens next, but the page said "Your accessible
  // booking is complete." over a resource grid reading "East Lift L2 - Out of
  // service" and announced nothing at all. Someone using a screen reader was
  // never told the route they had been given had broken.
  const bookedResourcesOut = bookedResourcesOutOfService(booking, state.resources);
  const breakage = bookingBreakageAnnouncement(bookedResourcesOut);
  const impact = bookingImpactView(state);
  if (impact.visible) {
    if (impact.signature !== lastBookingImpactSignature) {
      elements.bookingImpactAlert.hidden = true;
      elements.bookingImpactAlertHeading.textContent = impact.variant === 'NO_LIFT_ROUTE'
        ? impact.heading
        : 'Your confirmed route has been disrupted';
      elements.bookingImpactAlertMessage.textContent = impact.message.replace(
        `Booking ${impact.receipt}`,
        `Your booking ${impact.receipt}`,
      );
      elements.bookingImpactAlertProof.textContent = `${state.atomicity.reservedResourceCount} reservable resources remain held. `
        + 'This demo sends no email, SMS or staff workflow and performs no cancellation or reroute. Venue staff must act before travel.';
      if (breakage) elements.bookingImpactAlert.setAttribute('aria-label', breakage);
      elements.bookingImpactAlert.hidden = false;
    } else {
      elements.bookingImpactAlert.hidden = false;
    }
  } else {
    elements.bookingImpactAlert.hidden = true;
    elements.bookingImpactAlert.removeAttribute('aria-label');
  }
  // The visible role=alert is the single assertive channel for booking impact.
  // #a11y-alert remains owned by pre-confirmation incidents and venue-loss
  // notices, so ordinary polls do not double-announce this warning.
  lastBookingImpactSignature = impact.visible ? impact.signature : 'NONE';

  elements.receiptNumber.textContent = booking.receipt;
  // What the server can actually vouch for is narrow: a valid visitor session
  // sent a valid confirmation identifier with accepted set, the revision was
  // revalidated, and the whole bundle committed at once. It cannot vouch for who
  // that session belonged to, or that anyone pressed a button - a venue is shared
  // through its ?demo= link, a plan belongs to the venue rather than to the
  // session that made it, and an HTTP client holding a session token reaches the
  // same endpoint the page does. The sentence claims only the provable part.
  // The same comparison replanOutcomeView was created for. Branching on `kind`
  // alone called a byte-identical route "the replacement route" in the one
  // sentence that is kept as a record.
  elements.receiptIntroText.textContent = replanOutcomeView(currentState?.activePlan).sameRoute === false
    ? 'The booking was issued only after the replacement route was rechecked and confirmation was received from a visitor session on this shared venue.'
    : 'The booking was issued only after the original route was rechecked and confirmation was received from a visitor session on this shared venue.';
  setHtml(elements.receiptDetails, `
    <div><dt>Seats</dt><dd>${booking.requirements.companionCount ? 'Wheelchair space W12 + companion W13' : 'Wheelchair space W12'}</dd></div>
    <div><dt>Route</dt><dd>${escapeHtml(booking.route.path.join(' → '))}</dd></div>
    <div><dt>Assistance</dt><dd>${booking.requirements.entranceAssistance ? escapeHtml(booking.route.assistanceLabel) : 'Not requested'}</dd></div>
    <div><dt>Committed venue revision</dt><dd>${booking.committedResourceVersion}</dd></div>
    <div><dt>Partial reservations</dt><dd>${booking.partialReservations}</dd></div>
  `);
  const reservedCount = booking.resourceIds.filter((id) => !id.endsWith('-lift')).length;
  elements.atomicProofText.innerHTML = `<strong>Venue revision ${booking.committedResourceVersion - 1}→${booking.committedResourceVersion} · booking 0→1 · reserved 0→${reservedCount}</strong><br>Route facilities were revalidated; reservable resources changed together.`;

  if (lastPhase && lastPhase !== 'CONFIRMED') {
    window.setTimeout(() => elements.receiptHeading.focus(), 0);
  }
}

function renderAudit(state) {
  const entries = state.audit.filter((entry) => visitorAuditActions.has(entry.action));
  if (!entries.length) {
    setHtml(elements.auditList, '<li class="audit-empty">No actions yet.</li>');
    return;
  }

  setHtml(elements.auditList, entries.slice().reverse().map((entry) => {
    const rejected = entry.outcome === 'REJECTED';
    const actor = entry.actor === 'webmcp-agent'
      ? `WebMCP · ${entry.toolName}`
      : entry.actor === 'venue-operator'
        ? 'Venue operator'
        : entry.actor === 'human-ui'
          ? 'Human UI'
          : 'Demo';
    return `
      <li class="audit-item">
        <time class="audit-time" datetime="${escapeHtml(entry.at)}">${escapeHtml(formatTime(entry.at))}</time>
        <span class="audit-marker${rejected ? ' rejected' : ''}" aria-hidden="true">${rejected ? '×' : '✓'}</span>
        <span class="audit-content">
          <span class="actor-badge${entry.actor === 'webmcp-agent' ? ' webmcp' : ''}">${escapeHtml(actor)}</span>
          <strong>${escapeHtml(auditLabels[entry.action] ?? entry.action)}</strong>
          <small>${escapeHtml(entry.message ?? '')}</small>
        </span>
        <span class="audit-version">Venue revision ${entry.resourceVersionBefore}→${entry.resourceVersionAfter}</span>
      </li>
    `;
  }).join(''));
}

function render(state) {
  const previousPhase = lastPhase;
  lastPhase = state.phase;
  elements.venueVersion.textContent = `Venue revision ${state.resourceVersion}`;
  // A standing refusal describes the venue at one revision. The venue moving is
  // exactly the event that can make it untrue, and nothing re-checked it: after
  // both lifts came back the banner still told the visitor to go and look at the
  // operations page for a lift that was not out, on a venue that would have
  // booked them a seat. The domain re-evaluates a stored refusal on every read
  // for this reason; the page did the opposite.
  if (standingRefusalRevision !== null && state.resourceVersion !== standingRefusalRevision) {
    clearStandingRefusal();
  }
  disableSafely(elements.buildPlanButton, state.phase !== 'READY', elements.decisionHeading);
  // Three of these phases used to share one label. It claimed a plan was still
  // being worked on, which after a confirmed booking is simply false, and in
  // PLAN_READY it told a visitor with no agent to wait for one. A disabled
  // control has to say what is true and where the way out is.
  //
  // The old wording is not quoted here on purpose: app.js is served verbatim,
  // and a regression test bans that string from the whole file rather than from
  // the rendered output alone. A phrase repeated in a comment is a phrase that
  // can be uncommented.
  elements.buildPlanButton.textContent = buildPlanButtonView(state.phase, {
    hasStandingRefusal: standingRefusalRevision !== null,
  }).label;
  elements.requirementsForm.querySelectorAll('input').forEach((input) => {
    disableSafely(input, state.phase !== 'READY', elements.decisionHeading);
  });

  // A visitor who builds a plan and then changes their mind had no way back:
  // every input was disabled, the build button was disabled, and the only tool
  // that clears a plan - clear_access_plan - was registered for an agent and
  // wired to no human control at all. On a page whose whole claim is that the
  // person stays in charge, the agent could back out and the person could not.
  // The only escape was "Reset demo", which destroys the decision log the demo
  // exists to show. This button calls the same endpoint the tool does.
  const clearable = Boolean(state.activePlan) && !state.booking;
  elements.startOverButton.hidden = !clearable;

  lastPhase = previousPhase;
  renderPlan(state);
  renderReceipt(state);
  renderIncident(state);
  renderDecision(state);
  renderAudit(state);
  renderFaultControl(state);
  syncDeclarativeTool(state);
  lastPhase = state.phase;
}

async function performRefreshState() {
  const payload = await api('/api/state', { method: 'GET', headers: {} });
  currentState = payload.state;
  lastSuccessfulRefresh = Date.now();
  elements.venueLiveStatus.classList.remove('stale');
  elements.venueLiveText.textContent = 'Venue data live';
  render(currentState);
  await syncWebMcpTools(currentState);
  return currentState;
}

/**
 * A poll and a tool/UI action can ask for state at the same time. Keep those
 * reads ordered: otherwise a slower response captured before a mutation can
 * arrive last and repaint the page (and its tools) with an older phase.
 */
function refreshState() {
  pendingRefreshes += 1;
  const queued = refreshQueue.then(performRefreshState);
  refreshQueue = queued.catch(() => {});
  return queued.finally(() => {
    pendingRefreshes = Math.max(0, pendingRefreshes - 1);
  });
}

async function buildPlanManually() {
  const hadFocus = disableSafely(elements.buildPlanButton, true, elements.main);
  elements.buildPlanButton.textContent = 'Checking the whole route…';
  try {
    const found = await api('/api/plans', {
      method: 'POST',
      body: JSON.stringify({ requirements: requirementsFromForm() }),
    });
    await api(`/api/plans/${encodeURIComponent(found.plan.id)}/stage`, {
      method: 'POST',
      body: JSON.stringify({ expectedResourceVersion: found.plan.basedOnResourceVersion }),
    });
    await refreshState();
    clearStandingRefusal();
    setProtocolTrace('Manual visitor UI', 'find + stage', `plan ready · venue revision ${currentState.resourceVersion}`);
    elements.decisionHeading.focus({ preventScroll: true });
    elements.decisionSection.scrollIntoView({ behavior: 'instant', block: 'center' });
    showToast('Complete route, seats and assistance prepared. Nothing is booked yet.');
    return {
      submittedByVisitor: true,
      phase: currentState.phase,
      venueRevision: currentState.resourceVersion,
      planId: found.plan.id,
      route: found.plan.route.path,
      requiresHumanConfirmation: true,
    };
  } catch (error) {
    // The toast alone was the entire report of a refusal the visitor cannot act
    // on. Wheelchair width 95 is inside the form's own max, and no route is
    // 95 cm wide, so a judge typing the largest value the page offers saw four
    // seconds of text and then a page with an empty decision log and a
    // re-enabled build button - a dead venue presented as a healthy one.
    if (error.code === 'NO_COMPLETE_BUNDLE') {
      // The diagnosis the venue shipped with this refusal, not a literal. With
      // every lift out the server answers requirementChangeCanHelp:false, and
      // the sentence here told the visitor to change a requirement anyway.
      showStandingRefusal(error, currentState?.resourceVersion ?? null);
      setProtocolTrace(
        'Manual visitor UI',
        'find + stage',
        `no complete plan · venue revision ${currentState?.resourceVersion ?? 'unknown'}`,
      );
    } else {
      showToast(error.message);
    }
    // A refresh that fails for the same reason must not replace the visible
    // failure with an unhandled rejection, nor leave the button reading
    // "Checking the whole route…" forever as though work were still going on.
    await refreshState().catch(() => {});
    if (currentState) render(currentState);
    if (error.code === 'NO_COMPLETE_BUNDLE') {
      elements.planFeedback.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
      elements.planFeedbackHeading.focus({ preventScroll: true });
    } else {
      elements.buildPlanButton.focus({ preventScroll: true });
    }
    return { submittedByVisitor: true, error: error.code ?? 'REQUEST_FAILED', message: error.message };
  }
}

async function replan() {
  if (!currentState?.activePlan) return;
  // The label and the action are one decision, taken in public/views.mjs. This
  // branched on the phase while the label came from the diagnosis, and the two
  // disagree in the state that matters: with every lift out and no replan
  // attempted yet the venue is still PLAN_STALE, so the button read "Back to my
  // requirements" and ran a replan the refusal had already called useless.
  const incident = incidentView(currentState);
  if (incident.action === 'CLEAR_PLAN') {
    await clearPlanForEditing();
    return;
  }
  const hadFocus = disableSafely(elements.replanButton, true, elements.incidentHeading);
  elements.replanButton.textContent = incident.busyLabel;
  try {
    await api(`/api/plans/${encodeURIComponent(currentState.activePlan.id)}/replan`, {
      method: 'POST',
      body: '{}',
    });
    await refreshState();
    setProtocolTrace('Manual visitor UI', 'replan', `replacement ready · venue revision ${currentState.resourceVersion}`);
    elements.decisionHeading.focus({ preventScroll: true });
    elements.decisionSection.scrollIntoView({ behavior: 'instant', block: 'center' });
    showToast(replanOutcomeView(currentState?.activePlan).toast);
  } catch (error) {
    // Never let a failing refresh swallow the message explaining the failure.
    await refreshState().catch(() => {});
    if (error.code === 'NO_COMPLETE_BUNDLE') {
      setProtocolTrace('Manual visitor UI', 'replan', 'no complete alternative');
    }
    showToast(error.message);
  } finally {
    elements.replanButton.disabled = false;
    // Same source as the incident card above, so a control restored after a
    // request cannot disagree with the one the card rendered.
    elements.replanButton.textContent = incidentView(currentState ?? {}).buttonLabel;
    releaseFocusTo(elements.replanButton, hadFocus);
  }
}

async function clearPlanForEditing() {
  const plan = currentState?.activePlan;
  if (!plan) return;
  // Two controls reach this now: the incident card's button when there is no
  // alternative, and the Start over button, which is the one a visitor in
  // PLAN_READY can actually see - the incident card is not rendered there.
  const pressed = [elements.replanButton, elements.startOverButton];
  const hadFocus = pressed.map((button) => disableSafely(button, true, elements.main));
  try {
    await api(`/api/plans/${encodeURIComponent(plan.id)}/clear`, { method: 'POST', body: '{}' });
    await refreshState();
    setProtocolTrace('Manual visitor UI', 'clear plan', 'requirements editable');
    elements.requirementsForm.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
    elements.requirementsForm.querySelector('input:not([disabled])')?.focus({ preventScroll: true });
    showToast('Change a requirement and build a new plan. Nothing was booked.');
  } catch (error) {
    showToast(error.message);
  } finally {
    pressed.forEach((button, index) => {
      button.disabled = false;
      releaseFocusTo(button, hadFocus[index]);
    });
  }
}

async function confirmPlan() {
  const plan = currentState?.activePlan;
  if (!plan) return;
  const hadFocus = disableSafely(elements.confirmButton, true, elements.decisionHeading);
  elements.confirmButton.textContent = 'Confirming the whole bundle…';

  try {
    const prepared = await api(`/api/plans/${encodeURIComponent(plan.id)}/prepare-confirmation`, {
      method: 'POST',
      body: '{}',
    });
    const requestId = globalThis.crypto?.randomUUID?.() ?? `request-${Date.now()}`;
    await api(`/api/plans/${encodeURIComponent(plan.id)}/commit`, {
      method: 'POST',
      body: JSON.stringify({
        confirmationId: prepared.confirmation.confirmationId,
        expectedResourceVersion: prepared.confirmation.expectedResourceVersion,
        accepted: true,
        requestId,
      }),
    });
    await refreshState();
    setProtocolTrace('Human confirmation', 'commit booking', `booking 0→1 · venue revision ${currentState.resourceVersion}`);
    elements.receiptSection.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    showToast('Every requested resource was confirmed in one transaction.');
  } catch (error) {
    // Same reason as replan: if the refresh fails too, the visitor must still
    // be told why their confirmation did not go through - and the button must
    // stop reading "Confirming the whole bundle…", which is what repaints it.
    await refreshState().catch(() => {});
    if (currentState) render(currentState);
    if (error.code === 'STALE_RESOURCE_VERSION') {
      // The incident region announces itself and takes focus; a toast on top of
      // that is a third simultaneous utterance for one event.
      elements.incident.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
    } else {
      showToast(error.message);
    }
  } finally {
    elements.confirmButton.disabled = false;
    releaseFocusTo(elements.confirmButton, hadFocus);
  }
}

async function resetDemo() {
  try {
    await api('/api/demo/reset', { method: 'POST', body: '{}' });
    elements.requirementsForm.reset();
    await refreshState();
    setProtocolTrace('Demo control', 'reset', 'synthetic state restored');
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
    showToast('Synthetic demo reset.');
  } catch (error) {
    showToast(error.message);
  }
}


/**
 * Counts tool calls that are still running. Before Chrome 153, unregistering a
 * tool cancels any execution of it that is still in flight. A tool that changes
 * the page state would therefore abort itself: the state change removes it from
 * the registered set, and the abort kills the very call that caused it. So no
 * re-registration happens while a call is running; it is deferred instead.
 */
let inFlightToolCalls = 0;
let resyncPending = false;
let toolSurfaceEpoch = 0;
let toolSurfaceTimer = 0;
let latestToolDefinitions = [];
let toolSyncQueue = Promise.resolve();

function beginToolCall() {
  inFlightToolCalls += 1;
}

function endToolCall() {
  inFlightToolCalls = Math.max(0, inFlightToolCalls - 1);
  if (inFlightToolCalls === 0 && resyncPending) {
    resyncPending = false;
    // A macrotask, so the browser observes this call's result before the tool
    // that produced it is unregistered.
    window.setTimeout(() => {
      if (!currentState) return;
      syncDeclarativeTool(currentState);
      syncWebMcpTools(currentState).catch(() => {});
    }, 0);
  }
}

function instrumentTool(definition) {
  return {
    ...definition,
    execute: async (input, options) => {
      beginToolCall();
      try {
        return await definition.execute(input, options);
      } finally {
        endToolCall();
      }
    },
  };
}

function renderToolSurface(definitions, exposedTools) {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const tools = exposedTools
    .map((tool) => typeof tool === 'string' ? { name: tool } : tool)
    .filter((tool) => typeof tool?.name === 'string')
    .sort((left, right) => left.name.localeCompare(right.name));
  let read = 0;
  let write = 0;

  for (const tool of tools) {
    if (tool.annotations?.readOnlyHint === true
      || byName.get(tool.name)?.annotations?.readOnlyHint === true) {
      read += 1;
    } else {
      write += 1;
    }
  }

  setHtml(elements.toolList, tools
    .map((tool) => `<span class="tool-chip" role="listitem">${escapeHtml(tool.name)}</span>`)
    .join(''));
  elements.webmcpStatus.classList.add('ready');
  elements.webmcpStatusText.textContent = `${read} read · ${write} write`;
  elements.webmcpStatus.title = `Browser-exposed tools: ${tools.map((tool) => tool.name).join(', ')}`;
}

async function refreshToolSurface(epoch, definitions) {
  const modelContext = document.modelContext;
  if (!modelContext?.registerTool || epoch !== toolSurfaceEpoch) return;

  try {
    let exposedTools;
    if (typeof modelContext.getTools === 'function') {
      exposedTools = await modelContext.getTools();
    } else {
      // Older implementations can register tools without exposing getTools().
      // In that case only successful registrations and the feature-gated form
      // are safe to report.
      exposedTools = definitions.map((definition) => ({
        name: definition.name,
        annotations: definition.annotations,
      }));
      if (currentState?.phase === 'READY' && declarativeSupported && declarativeToolDefined) {
        exposedTools.push({ name: declarativeTool.name });
      }
    }
    if (epoch !== toolSurfaceEpoch) return;
    renderToolSurface(definitions, exposedTools);
  } catch (error) {
    if (epoch !== toolSurfaceEpoch) return;
    elements.webmcpStatus.classList.remove('ready');
    elements.webmcpStatusText.textContent = 'WebMCP surface unavailable';
    elements.webmcpStatus.title = error.message;
    setHtml(elements.toolList, '');
  }
}

function scheduleToolSurfaceRefresh(definitions = latestToolDefinitions) {
  latestToolDefinitions = definitions;
  const epoch = ++toolSurfaceEpoch;
  window.clearTimeout(toolSurfaceTimer);
  toolSurfaceTimer = window.setTimeout(() => {
    refreshToolSurface(epoch, definitions).catch(() => {});
  }, 0);
}

/**
 * Which tools exist depends on what the page can currently do. A booking that
 * is already confirmed offers no way to stage one, so those tools are removed
 * rather than left registered and failing when called.
 */
async function performWebMcpToolSync(definitions, signature) {
  const modelContext = document.modelContext;

  if (!modelContext?.registerTool) {
    toolControllers.forEach((controller) => controller.abort());
    toolControllers = [];
    registeredToolSignature = '';
    ++toolSurfaceEpoch;
    window.clearTimeout(toolSurfaceTimer);
    elements.webmcpStatus.classList.remove('ready');
    elements.webmcpStatusText.textContent = 'Manual demo mode';
    elements.webmcpStatus.title = 'This browser does not expose document.modelContext. The standard UI remains fully functional.';
    setHtml(elements.toolList, '');
    return;
  }

  if (registeredToolSignature === signature) {
    scheduleToolSurfaceRefresh(definitions);
    return;
  }
  if (inFlightToolCalls > 0) {
    resyncPending = true;
    return;
  }

  // Withdraw the completed previous set before building the next one. Sync
  // loops are serialized, and controllers for this attempt stay local until
  // every registration succeeds, so a failed loop cannot corrupt its follower.
  ++toolSurfaceEpoch;
  window.clearTimeout(toolSurfaceTimer);
  toolControllers.forEach((controller) => controller.abort());
  toolControllers = [];
  registeredToolSignature = '';
  const nextControllers = [];

  try {
    for (const definition of definitions) {
      const controller = new AbortController();
      nextControllers.push(controller);
      await modelContext.registerTool(instrumentTool(definition), { signal: controller.signal });
    }
    toolControllers = nextControllers;
    registeredToolSignature = signature;
    scheduleToolSurfaceRefresh(definitions);
  } catch (error) {
    nextControllers.forEach((controller) => controller.abort());
    elements.webmcpStatus.classList.remove('ready');
    elements.webmcpStatusText.textContent = 'WebMCP unavailable';
    elements.webmcpStatus.title = error.message;
    setHtml(elements.toolList, '');
  }
}

function syncWebMcpTools(state) {
  const definitions = toolsForPhase(visitorTools, state.phase);
  const signature = definitions.map((definition) => definition.name).join('|');
  latestToolDefinitions = definitions;

  // Registration is intentionally serialized. A slower previous loop must
  // finish (or clean up) before another loop can touch the shared registry.
  const queued = toolSyncQueue.then(() => performWebMcpToolSync(definitions, signature));
  toolSyncQueue = queued.catch(() => {});
  return queued;
}

elements.requirementsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const finished = buildPlanManually();

  // The declarative tool deliberately has no toolautosubmit, so an agent can
  // fill this form but cannot send it. The submission stays with the visitor,
  // and the plan they produce is handed back as the tool's result at that
  // moment - the agent learns what happened without ever pressing the button.
  if (event.agentInvoked && typeof event.respondWith === 'function') {
    // The browser runs this execution itself, so it has to be counted the same
    // way an imperative call is; otherwise submitting changes the page state,
    // the tool set is rebuilt, and this very execution is cancelled.
    beginToolCall();
    event.respondWith(
      finished
        .then((result) => JSON.stringify(result))
        .finally(() => endToolCall()),
    );
  }
});

// A form filled by an agent should say so, so the visitor knows to check it.
elements.requirementsForm.addEventListener('input', (event) => {
  if (event.isTrusted) return;
  showToast('Your agent filled this in. Check the values, then submit it yourself.');
}, { passive: true });
elements.replanButton.addEventListener('click', replan);
elements.confirmButton.addEventListener('click', confirmPlan);
elements.startOverButton.addEventListener('click', clearPlanForEditing);
elements.resetButton.addEventListener('click', resetDemo);
elements.faultButton?.addEventListener('click', toggleLiftFault);
elements.shareLinkButton?.addEventListener('click', copyJoinLink);
elements.copyPromptButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(elements.examplePrompt.textContent.trim());
    showToast('Example request copied.');
  } catch {
    showToast('Select and copy the example request manually.');
  }
});

async function pollState() {
  // A user action or tool read already queued a fresher snapshot. Skipping this
  // tick prevents a slow network from building an unbounded poll backlog.
  if (pendingRefreshes > 0) return;
  try {
    await refreshState();
  } catch (error) {
    elements.venueLiveStatus.classList.add('stale');
    const ageSeconds = lastSuccessfulRefresh ? Math.round((Date.now() - lastSuccessfulRefresh) / 1000) : 0;
    elements.venueLiveText.textContent = ageSeconds ? `Venue data stale · ${ageSeconds}s` : 'Venue data reconnecting';
  }
}

const declarativeTool = {
  name: elements.requirementsForm.dataset.toolName,
  description: elements.requirementsForm.dataset.toolDescription,
};

// A tool with half a definition is worse than no tool: an agent cannot tell
// when to call it, and Chrome reports the form as a page error. If either half
// is missing from the markup - dropped, renamed, emptied - the form is simply
// never offered, rather than offered as `undefined`.
const declarativeToolDefined = Boolean(declarativeTool.name) && Boolean(declarativeTool.description);

// A declarative form call is useful only when the browser can identify an
// agent submission and let the page resolve it after the visitor submits.
// Attribute presence alone is not support: ChatGPT's current built-in browser
// implements imperative WebMCP but does not expose this SubmitEvent contract.
const declarativeSupported = typeof SubmitEvent !== 'undefined'
  && typeof SubmitEvent.prototype.respondWith === 'function'
  && 'agentInvoked' in SubmitEvent.prototype;

// Chrome derives min/max constraints from the form, but its current
// executeTool implementation can still fill values outside those constraints.
// Without toolautosubmit that invocation would then wait forever: native form
// validation prevents the submit event, so respondWith() is never reached.
// requestSubmit() makes Chrome finish the active invocation with its native
// validation failure. Resetting afterwards removes the unusable values while
// preserving the human confirmation gate for valid calls.
window.addEventListener('toolactivated', (event) => {
  if (event.toolName !== declarativeTool.name) return;
  queueMicrotask(() => {
    const form = elements.requirementsForm;
    if (form.checkValidity()) {
      showToast('Your agent filled this in. Check the values, then submit it yourself.');
      return;
    }
    // These names reach a human, and showToast also speaks them to a screen
    // reader, so the raw schema keys are translated. Collected before reset(),
    // which would otherwise make every field valid again.
    const FIELD_WORDS = {
      wheelchairWidthCm: 'wheelchair width',
      maxDistanceM: 'maximum walking distance',
      companionCount: 'companion seat',
    };
    const invalidNames = [...form.elements]
      .filter((control) => typeof control.checkValidity === 'function' && !control.checkValidity())
      .map((control) => FIELD_WORDS[control.name] ?? control.name)
      .filter(Boolean);
    form.requestSubmit(elements.buildPlanButton);
    form.reset();
    showToast(`Your agent supplied an invalid ${invalidNames.join(' and ') || 'form'} value. Nothing was changed.`);
  });
});

/**
 * The only place either declarative attribute is written, in either direction.
 *
 * Chrome judges a form the instant an attribute changes, not at the end of the
 * statement that changed it. HTMLFormElement::AttributeChanged calls
 * ScheduleDeclarativeWebMCPToolRegistration() synchronously, and that function
 * reports a DevTools page error for any CONNECTED form carrying exactly one of
 * `toolname` and `tooldescription`: kFormModelContextMissingToolDescription for
 * a name without a description, kFormModelContextMissingToolName for the
 * reverse. Only the registration itself is deferred to a task.
 *
 * So two setAttribute calls in a row always publish a half-declared form for
 * the length of one statement, and swapping their order only swaps which of
 * the two errors is reported - it does not remove one. Removing the pair has
 * the same problem in reverse. The DevTools issue raised against the live page
 * was this window, not a missing description: the description was set one
 * statement too late.
 *
 * The same Chrome code path returns early for a form that is not connected, so
 * the pair is swapped off-document and the form is put back whole. Detach and
 * reattach happen inside one synchronous block, before style or layout runs
 * again, so nothing is ever painted without the form. Focus does not survive a
 * detach, so it is carried across by hand.
 */
function setDeclarativeToolAttributes(form, tool) {
  const parent = form.parentNode;
  const nextSibling = form.nextSibling;
  const focused = form.contains(document.activeElement) ? document.activeElement : null;
  if (parent) parent.removeChild(form);
  if (tool) {
    form.setAttribute('toolname', tool.name);
    form.setAttribute('tooldescription', tool.description);
  } else {
    form.removeAttribute('toolname');
    form.removeAttribute('tooldescription');
  }
  if (parent) parent.insertBefore(form, nextSibling);
  if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
}

/**
 * The declarative tool follows the page state like the imperative ones do.
 * Removing the attributes withdraws it, so a confirmed booking really does
 * expose no way to change anything. Like the imperative surface, it must not
 * be withdrawn while its own call is still running: submitting the form is
 * what changes the state, and that call is the one that would be cancelled.
 */
function syncDeclarativeTool(state) {
  if (inFlightToolCalls > 0) {
    resyncPending = true;
    return;
  }
  const form = elements.requirementsForm;
  const offered = declarativeToolDefined
    && declarativeSupported
    && Boolean(document.modelContext?.registerTool)
    && state.phase === 'READY';
  if (offered === form.hasAttribute('toolname')) return;
  setDeclarativeToolAttributes(form, offered ? declarativeTool : null);
  scheduleToolSurfaceRefresh(toolsForPhase(visitorTools, state.phase));
}

function renderFaultControl(state) {
  if (!elements.faultButton) return;
  // A pending fault belongs to the venue, not to one lift. Comparing it with a
  // literal meant an armed Garden fault left this button enabled: one click
  // then armed East and silently replaced the pending Garden fault. That is the
  // same defect that was removed from the operations page - and repairing it
  // there and not here is how a class of defect survives being fixed.
  // One decision, made in public/views.mjs and shared with the tests, because
  // this control read `eastOut` before `armed`: with East already out and
  // another lift armed it offered "Put East Lift back in service" while
  // setting aria-disabled=true, naming an action it would then refuse.
  const view = faultControlView(state);

  // Step 3 only belongs in the walkthrough once there is a complete plan to
  // test. A real pending fault or outage still reveals the control so the
  // visitor can see or restore the venue state that now affects the plan.
  if (elements.demoControls) elements.demoControls.hidden = view.mode === 'LOCKED';
  const restoring = view.mode === 'RESTORE';
  elements.demoControlsEyebrow.textContent = restoring ? 'ROUTE UNAVAILABLE' : 'STEP 3 · TEST THE SAFE FAILURE';
  elements.demoControlsHeading.textContent = restoring ? 'Restore a route to continue' : 'Break the plan during confirmation';
  elements.demoControlsCopy.textContent = restoring
    ? 'Restore the lift, then build the complete plan again.'
    : 'Arm a lift failure, then confirm. The server must reject the stale plan.';

  // Set asynchronously by a poll: a real `disabled` here would take focus off
  // the button the visitor just pressed, a second later, with no warning.
  elements.faultButton.setAttribute('aria-disabled', String(view.ariaDisabled));
  elements.faultButton.textContent = view.text;
  elements.faultButton.classList.toggle('button-warning', view.warning);
  elements.faultButton.classList.toggle('button-quiet', view.quiet);
  elements.faultHint.textContent = view.hint;
}

async function initialize() {
  try {
    visitorTools = createVisitorTools({ api, refresh: refreshState, trace: setProtocolTrace });
    document.modelContext?.addEventListener?.('toolchange', () => {
      scheduleToolSurfaceRefresh();
    });
    await startVisitorSession();
    await refreshState();
    window.setInterval(pollState, 1_000);
  } catch (error) {
    showToast(error.message);
    elements.venueLiveStatus.classList.add('stale');
    elements.venueLiveText.textContent = 'Venue data unavailable';
  }
}

initialize();
