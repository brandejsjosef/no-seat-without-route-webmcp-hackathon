import { createOperatorTools, toolCounts } from '/tools.mjs';
import {
  auditTitle, operatorEndpoint, raceIntroView, focusRefuge, bookingImpactView, operatorPhaseLabel,
} from '/views.mjs';

/**
 * Which lift the demo controls act on. Defaults to East Lift so every existing
 * scenario, including the browser suite, behaves exactly as before.
 */
function selectedFacility() {
  return document.querySelector('input[name="controlled-facility"]:checked')?.value ?? 'east-lift';
}

/**
 * The name the venue itself gives a facility. Every sentence this page shows
 * about a lift is built through here, because the buttons were parameterised
 * while the prose around them kept saying "East Lift" - measured on the
 * deployed page: arming Garden Lift raised "East Lift fault will land...",
 * taking Garden Lift out said "East Lift is now out of service", and the audit
 * row was titled "East Lift fault armed" above a detail line naming Garden.
 * A page whose only job is to be believed cannot name the wrong lift.
 */
/**
 * Disabling the control the operator is holding drops focus to <body>, exactly
 * as it did on the visitor page. That repair was applied there and not here, so
 * every control on this page still lost focus - measured on all four.
 */
function disableSafely(element, disabled) {
  if (!element) return;
  if (disabled && !element.disabled) {
    const target = focusRefuge({
      focusIsOnControl: document.activeElement === element,
      fallbackVisible: false,
    });
    if (target === 'MAIN') elements.main?.focus?.({ preventScroll: true });
  }
  element.disabled = disabled;
}

function facilityLabel(snapshot, facilityId) {
  return snapshot?.resources?.[facilityId]?.label ?? facilityId;
}

const elements = {
  version: document.querySelector('#operator-version'),
  restoreButton: document.querySelector('#restore-outage-button'),
  facilityPicker: document.querySelector('#facility-picker'),
  eastFacilityRadio: document.querySelector('#facility-east'),
  eastFacilityCard: document.querySelector('#east-lift-card'),
  eastFacilityName: document.querySelector('#east-lift-name'),
  eastFacilityDetail: document.querySelector('#east-lift-detail'),
  eastFacilityState: document.querySelector('#east-lift-state'),
  eastFacilityFault: document.querySelector('#east-lift-fault'),
  gardenFacilityRadio: document.querySelector('#facility-garden'),
  gardenFacilityCard: document.querySelector('#garden-lift-card'),
  gardenFacilityName: document.querySelector('#garden-lift-name'),
  gardenFacilityDetail: document.querySelector('#garden-lift-detail'),
  gardenFacilityState: document.querySelector('#garden-lift-state'),
  gardenFacilityFault: document.querySelector('#garden-lift-fault'),
  webmcpStatus: document.querySelector('#operator-webmcp-status'),
  webmcpStatusText: document.querySelector('#operator-webmcp-text'),
  visitorLink: document.querySelector('#visitor-link'),
  armButton: document.querySelector('#arm-outage-button'),
  outageNowButton: document.querySelector('#outage-now-button'),
  armedState: document.querySelector('#armed-state'),
  armedFacility: document.querySelector('#armed-facility'),
  main: document.querySelector('#operator-main'),
  raceIntro: document.querySelector('#race-intro'),
  proofBookings: document.querySelector('#proof-bookings'),
  proofResources: document.querySelector('#proof-resources'),
  proofPhase: document.querySelector('#proof-phase'),
  proofExplanation: document.querySelector('#proof-explanation'),
  bookingImpact: document.querySelector('#booking-impact'),
  bookingImpactHeading: document.querySelector('#booking-impact-heading'),
  bookingImpactMessage: document.querySelector('#booking-impact-message'),
  bookingImpactProof: document.querySelector('#booking-impact-proof'),
  manualControlHeading: document.querySelector('#manual-control-heading'),
  manualImpactNote: document.querySelector('#manual-impact-note'),
  manualImpactConfirmation: document.querySelector('#manual-impact-confirmation'),
  manualImpactConfirmationHeading: document.querySelector('#manual-impact-confirmation-heading'),
  manualImpactConfirmationMessage: document.querySelector('#manual-impact-confirmation-message'),
  confirmOutageButton: document.querySelector('#confirm-outage-button'),
  cancelOutageButton: document.querySelector('#cancel-outage-button'),
  log: document.querySelector('#operator-log'),
  liveStatus: document.querySelector('#operator-live-status'),
  liveText: document.querySelector('#operator-live-text'),
  venueNotice: document.querySelector('#operator-venue-notice'),
  resetButton: document.querySelector('#operator-reset-button'),
  actionFeedback: document.querySelector('#operator-action-feedback'),
};

let state = null;
let actionFeedbackRevision = null;

const BROWSER_API_HEADERS = Object.freeze({
  'Content-Type': 'application/json',
  'X-NSWR-Domain-Outcome': 'envelope-v1',
});
let sessionToken = '';
let demoId = '';
let operatorTools = [];
let registeredTools = false;
let lastSuccessfulRefresh = 0;
let standingNotice = '';
let lastBookingImpactSignature = 'NONE';
let pendingOutageConfirmationId = null;
let outageRequestInFlight = false;

function setHtml(element, html) {
  if (element.innerHTML !== html) element.innerHTML = html;
}

/** Always present in the accessibility tree, so a change is a real update. */
function announce(message) {
  const region = document.querySelector('#a11y-status');
  if (!region) return;
  if (region.textContent === message) region.textContent = '';
  region.textContent = message;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showActionFeedback(message) {
  elements.actionFeedback.textContent = message;
  elements.actionFeedback.hidden = false;
  actionFeedbackRevision = state?.resourceVersion ?? null;
  announce(message);
}

function clearActionFeedback() {
  actionFeedbackRevision = null;
  elements.actionFeedback.hidden = true;
  elements.actionFeedback.textContent = '';
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...BROWSER_API_HEADERS,
      ...(sessionToken ? { 'X-Demo-Session': sessionToken } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error?.message ?? 'Request failed.');
    error.code = payload.error?.code;
    error.status = payload.error?.status ?? response.status;
    error.details = payload.error ?? {};
    throw error;
  }
  return payload;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A `?demo=` link wins over this browser's own storage, so a link shared from
 *  the booking page lands both roles on one venue. */
function preferredDemoId() {
  const fromUrl = new URL(window.location.href).searchParams.get('demo');
  if (fromUrl && UUID_PATTERN.test(fromUrl)) return fromUrl.toLowerCase();
  try {
    const stored = localStorage.getItem('nswr-demo-id');
    return stored && UUID_PATTERN.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

/**
 * The venue lives in the server's memory. If the process restarts, the identifier
 * this page holds names a venue that no longer exists and the server builds a
 * fresh, empty one under it. Saying nothing would present that empty venue as the
 * one the operator was watching, so the loss is stated and kept on screen.
 */
function showVenueRebuiltNotice() {
  // Feedback belongs to the venue that produced it. A restarted server may
  // recreate a new venue at the same revision number, so revision comparison
  // alone cannot tell us that the old message is stale.
  clearActionFeedback();
  const message = 'The venue this page was watching no longer exists on the server, so a new, empty one was opened '
    + 'under the same identifier. Nothing shown below is a record of what came before.';
  elements.venueNotice.textContent = message;
  elements.venueNotice.hidden = false;
  standingNotice = message;
  announce(message);
}

async function startOperatorSession() {
  const requestedDemoId = preferredDemoId();
  const rememberedDemoId = (() => {
    try {
      return localStorage.getItem('nswr-demo-id');
    } catch {
      return null;
    }
  })();
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: BROWSER_API_HEADERS,
    body: JSON.stringify({ role: 'operator', demoId: requestedDemoId }),
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.error?.message ?? 'Could not start the operator session.');
  sessionToken = payload.session.token;
  demoId = payload.session.demoId;
  // Joining someone else's link, or an identifier typed by hand, is not a loss:
  // there was never an older venue here to lose.
  const lostAVenueThisBrowserHad = Boolean(requestedDemoId)
    && String(rememberedDemoId ?? '').toLowerCase() === requestedDemoId
    && payload.session.venueExisted === false;
  if (lostAVenueThisBrowserHad) showVenueRebuiltNotice();
  try {
    localStorage.setItem('nswr-demo-id', demoId);
  } catch {
    /* Storage may be unavailable; the URL still carries the identifier. */
  }
  const url = new URL(window.location.href);
  if (url.searchParams.get('demo') !== demoId) {
    url.searchParams.set('demo', demoId);
    window.history.replaceState({}, '', url);
  }
  if (elements.visitorLink) elements.visitorLink.href = `/?demo=${encodeURIComponent(demoId)}`;
}

async function syncOperatorTools() {
  const modelContext = document.modelContext;
  if (!modelContext?.registerTool) {
    elements.webmcpStatusText.textContent = 'Manual operations mode';
    elements.webmcpStatus.title = 'This browser does not expose document.modelContext. The operations UI works normally.';
    return;
  }
  if (registeredTools) return;
  try {
    for (const definition of operatorTools) {
      await modelContext.registerTool(definition);
    }
    registeredTools = true;
    const counts = toolCounts(operatorTools);
    elements.webmcpStatus.classList.add('ready');
    elements.webmcpStatusText.textContent = `${counts.read} read · ${counts.write} write`;
    elements.webmcpStatus.title = `Operations tools: ${operatorTools.map((tool) => tool.name).join(', ')}`;
  } catch (error) {
    elements.webmcpStatusText.textContent = 'WebMCP unavailable';
    elements.webmcpStatus.title = error.message;
  }
}

function formatTime(iso) {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function renderFacilities(snapshot) {
  const pendingId = snapshot.demo.pendingOutageResourceId;
  const views = [
    {
      id: 'east-lift',
      radio: elements.eastFacilityRadio,
      card: elements.eastFacilityCard,
      name: elements.eastFacilityName,
      detail: elements.eastFacilityDetail,
      status: elements.eastFacilityState,
      fault: elements.eastFacilityFault,
    },
    {
      id: 'garden-lift',
      radio: elements.gardenFacilityRadio,
      card: elements.gardenFacilityCard,
      name: elements.gardenFacilityName,
      detail: elements.gardenFacilityDetail,
      status: elements.gardenFacilityState,
      fault: elements.gardenFacilityFault,
    },
  ];

  for (const view of views) {
    const facility = snapshot.resources[view.id];
    if (!facility) continue;
    const out = facility.status === 'OUT_OF_SERVICE';
    const armed = pendingId === view.id;
    view.name.textContent = facility.label;
    view.detail.textContent = out
      ? facility.outageReason ?? 'Outage reported'
      : 'Synthetic demo · doors and power normal';
    view.status.textContent = out ? 'OUT OF SERVICE' : 'OPERATIONAL';
    view.status.classList.toggle('out', out);
    view.card.classList.toggle('out', out);
    view.card.classList.toggle('armed', armed);
    view.fault.hidden = !armed;
    view.radio.setAttribute(
      'aria-describedby',
      `${view.detail.id} ${view.status.id}${armed ? ` ${view.fault.id}` : ''}`,
    );
  }
}

function renderBookingImpact(snapshot) {
  const impact = bookingImpactView(snapshot);
  if (!impact.visible) {
    elements.bookingImpact.hidden = true;
    lastBookingImpactSignature = 'NONE';
    return impact;
  }

  if (impact.signature !== lastBookingImpactSignature) {
    // Populate while hidden so role=alert announces one complete statement, not
    // the old heading followed by three descendant rewrites. Do not move focus:
    // this can arrive through the one-second poll while an operator is using a
    // different control.
    elements.bookingImpact.hidden = true;
    elements.bookingImpactHeading.textContent = impact.heading;
    elements.bookingImpactMessage.textContent = impact.message;
    elements.bookingImpactProof.textContent = impact.proof;
    elements.bookingImpact.hidden = false;
  } else {
    elements.bookingImpact.hidden = false;
  }
  lastBookingImpactSignature = impact.signature;
  return impact;
}

function renderLog(snapshot) {
  if (!snapshot.audit.length) {
    setHtml(elements.log, '<li class="audit-empty">Waiting for server events.</li>');
    return;
  }
  setHtml(elements.log, snapshot.audit.slice().reverse().map((entry) => {
    const rejected = entry.outcome === 'REJECTED';
    return `
      <li class="audit-item">
        <time class="audit-time" datetime="${escapeHtml(entry.at)}">${escapeHtml(formatTime(entry.at))}</time>
        <span class="audit-marker${rejected ? ' rejected' : ''}" aria-hidden="true">${rejected ? '×' : '✓'}</span>
        <span class="audit-content">
          <strong>${escapeHtml(auditTitle(entry, snapshot))}</strong>
          <small>${escapeHtml(entry.message ?? '')}</small>
        </span>
        <span class="audit-version">Venue revision ${entry.resourceVersionBefore}→${entry.resourceVersionAfter}</span>
      </li>
    `;
  }).join(''));
}

function render(snapshot) {
  if (actionFeedbackRevision !== null && actionFeedbackRevision !== snapshot.resourceVersion) clearActionFeedback();
  state = snapshot;
  // The venue operates two lifts and this page could only ever act on one of
  // them. Garden Lift L4 was listed in the facility table with no control at
  // all, while the tool surface and the raw API could take it out with no
  // guard - so the one place the second lift was unreachable was the page a
  // judge is handed. These controls now follow the selected facility.
  const facilityId = selectedFacility();
  const label = facilityLabel(snapshot, facilityId);
  const selectedOut = snapshot.resources[facilityId]?.status === 'OUT_OF_SERVICE';
  const selectedUsesBooking = Boolean(snapshot.booking?.resourceIds?.includes(facilityId));
  const confirmationOpen = pendingOutageConfirmationId === facilityId
    && selectedUsesBooking
    && !selectedOut;
  if (pendingOutageConfirmationId && !confirmationOpen) pendingOutageConfirmationId = null;
  // A pending fault belongs to the venue, not to whichever lift the selector
  // happens to be showing. Keying the banner to the selection meant an armed
  // Garden fault vanished the moment the selector moved to East, the page then
  // offered to arm the other lift as though nothing were pending, and that
  // second arm silently replaced the first - switching back showed the first
  // lift as unarmed. The banner now follows the venue-wide pending fault and
  // names the lift holding it, and arming stays closed until it is spent.
  const pendingId = snapshot.demo.pendingOutageResourceId;
  const pendingLabel = pendingId ? snapshot.resources[pendingId]?.label ?? pendingId : '';
  const armed = Boolean(pendingId);
  const raceIntro = raceIntroView(snapshot, { facilityId });
  elements.version.textContent = String(snapshot.resourceVersion);
  elements.proofBookings.textContent = String(snapshot.atomicity.bookingCount);
  elements.proofResources.textContent = String(snapshot.atomicity.reservedResourceCount);
  elements.proofPhase.textContent = operatorPhaseLabel(snapshot.phase);
  const bookingImpact = renderBookingImpact(snapshot);
  elements.proofExplanation.textContent = bookingImpact.visible
    ? `${snapshot.atomicity.reservedResourceCount} reservable resources remain held, but ${bookingImpact.affectedLabels.join(' and ')} is now out of service. The confirmed route is disrupted.`
    : snapshot.atomicity.reservedResourceCount
      ? `${snapshot.atomicity.reservedResourceCount} resources committed together; route and lift were rechecked.`
      : 'Space, seat and host commit together; route and lift are rechecked.';
  // Toggling `hidden` on the banner alone never reaches a screen reader, so
  // the transition is announced explicitly, naming the lift that is armed.
  if (armed && elements.armedState.hidden) announce(`Fault armed on ${pendingLabel} for the next confirmation.`);
  if (elements.armedFacility) elements.armedFacility.textContent = pendingLabel;
  elements.armedState.hidden = !armed;
  disableSafely(elements.armButton, !raceIntro.canArm);
  elements.armButton.textContent = snapshot.phase === 'CONFIRMED'
    ? 'Safe-failure test complete — reset demo to run again'
    : armed
    ? `Fault armed on ${pendingLabel}`
    : selectedOut
      ? `${label} is out of service`
      : `Arm a confirmation fault on ${label}`;
  // These two were static markup. Parameterising the endpoints without
  // parameterising the text produced buttons that acted on Garden Lift while
  // reading "East Lift" - measured on the deployed page. A control that names
  // the wrong thing it is about to do is worse than one that cannot do it.
  elements.manualControlHeading.textContent = `Manual controls · ${label}`;
  elements.manualImpactNote.hidden = !selectedUsesBooking;
  if (selectedUsesBooking) {
    elements.manualImpactNote.textContent = selectedOut
      ? `Booking ${snapshot.booking.receipt} still uses this offline lift. The route is disrupted; the booking stays active.`
      : `Booking ${snapshot.booking.receipt} uses this lift. Taking it offline will disrupt the route; the booking stays active.`;
  }
  elements.outageNowButton.textContent = selectedUsesBooking && !selectedOut
    ? `Review impact before taking ${label} offline`
    : `Take ${label} offline`;
  elements.outageNowButton.classList.toggle('booking-risk', selectedUsesBooking && !selectedOut);
  elements.outageNowButton.setAttribute('aria-expanded', String(confirmationOpen));
  elements.manualImpactConfirmation.hidden = !confirmationOpen;
  elements.confirmOutageButton.disabled = outageRequestInFlight;
  elements.cancelOutageButton.disabled = outageRequestInFlight;
  if (confirmationOpen) {
    elements.manualImpactConfirmationMessage.textContent = `Booking ${snapshot.booking.receipt} uses ${label}. `
      + 'Taking it offline will break the confirmed route. The booking and held resources will stay active. '
      + 'This demo only shows an on-page warning—no email, SMS, cancellation or reroute.';
    elements.confirmOutageButton.textContent = `Take ${label} offline anyway`;
    elements.cancelOutageButton.textContent = `Keep ${label} in service`;
  }
  elements.restoreButton.textContent = `Restore ${label}`;
  // The blurb explaining the arm button sits above the selector and said "East
  // Lift" whatever was chosen, so the sentence and the button under it named
  // two different lifts.
  // The sentence and the button state come from one decision now. This told the
  // operator to arm a fault in every state, including the two the venue refuses
  // - a lift already offline, and a venue already holding a pending fault - and
  // the line below disabled the button while the sentence still asked for it.
  if (elements.raceIntro) elements.raceIntro.textContent = raceIntro.text;
  disableSafely(elements.outageNowButton, selectedOut || outageRequestInFlight);
  disableSafely(elements.restoreButton, !selectedOut);
  renderFacilities(snapshot);
  renderLog(snapshot);
}

async function refresh() {
  const payload = await api('/api/state', { method: 'GET', headers: {} });
  lastSuccessfulRefresh = Date.now();
  elements.liveStatus.classList.remove('stale');
  elements.liveText.textContent = 'Venue data live';
  render(payload.state);
  return payload.state;
}

/**
 * A poll that swallows its failure leaves the last snapshot on screen and lets
 * the operator act on data the server no longer has. A dropped session is
 * re-established; anything else is shown as stale rather than hidden.
 */
async function pollState() {
  try {
    await refresh();
  } catch (error) {
    elements.liveStatus.classList.add('stale');
    const ageSeconds = lastSuccessfulRefresh ? Math.round((Date.now() - lastSuccessfulRefresh) / 1000) : 0;
    elements.liveText.textContent = ageSeconds ? `Venue data stale · ${ageSeconds}s` : 'Venue data unavailable';
    if (['SESSION_REQUIRED', 'DEMO_NOT_FOUND'].includes(error.code)) {
      try {
        await startOperatorSession();
        await refresh();
      } catch {
        /* Still down; the stale marker above already says so. */
      }
    }
  }
}

elements.armButton.addEventListener('click', async () => {
  disableSafely(elements.armButton, true);
  // Read in the same synchronous tick as the URL below, so the toast can only
  // name the lift the request actually carried. The selector can move while
  // the request is in flight; reading it again afterwards would reintroduce
  // the same lie in a smaller window.
  const actedOn = selectedFacility();
  try {
    const payload = await api(operatorEndpoint(actedOn, 'arm'), { method: 'POST', body: '{}' });
    render(payload.state);
    showActionFeedback(`${facilityLabel(payload.state, actedOn)} fault will land during the visitor’s next confirmation.`);
  } catch (error) {
    showActionFeedback(error.message);
    await refresh();
  }
});

async function takeFacilityOffline(actedOn, { acknowledgedBookingReference = null } = {}) {
  if (outageRequestInFlight) return;
  outageRequestInFlight = true;
  disableSafely(elements.outageNowButton, true);
  disableSafely(elements.confirmOutageButton, true);
  try {
    // Quote the exact venue snapshot the operator reviewed. The server compares
    // this revision and, where relevant, the acknowledged booking reference in
    // the same synchronous step that takes the lift out of service. That closes
    // the race where a visitor confirms after our refresh but before this POST.
    const expectedVenueRevision = state?.resourceVersion;
    const payload = await api(operatorEndpoint(actedOn, 'outage'), {
      method: 'POST',
      body: JSON.stringify({
        reasonCode: 'LIFT_DOOR_FAULT',
        requireFreshOperatorReview: true,
        expectedVenueRevision,
        acknowledgedBookingReference,
      }),
    });
    pendingOutageConfirmationId = null;
    render(payload.state);
    showActionFeedback(`${facilityLabel(payload.state, actedOn)} is now out of service. The venue revision changed.`);
  } catch (error) {
    if (['OPERATOR_REVIEW_STALE', 'BOOKING_IMPACT_CONFIRMATION_REQUIRED'].includes(error.code)) {
      try {
        await refresh();
      } catch (refreshError) {
        showActionFeedback(refreshError.message);
        return;
      }

      const stillOperational = state?.resources?.[actedOn]?.status === 'OPERATIONAL';
      const nowAffectsBooking = Boolean(
        stillOperational && state?.booking?.resourceIds?.includes(actedOn),
      );
      if (nowAffectsBooking) {
        pendingOutageConfirmationId = actedOn;
        render(state);
        elements.manualImpactConfirmationHeading.focus({ preventScroll: true });
      } else {
        pendingOutageConfirmationId = null;
        render(state);
        showActionFeedback('The venue changed. Review the selected lift before reporting an outage.');
      }
      return;
    }

    showActionFeedback(error.message);
    await refresh();
  } finally {
    outageRequestInFlight = false;
    if (state) render(state);
  }
}

elements.outageNowButton.addEventListener('click', async () => {
  const actedOn = selectedFacility();
  // The visitor can confirm between two one-second operator polls. Re-read the
  // shared venue before deciding whether this is an ordinary outage or one
  // that needs the inline booking-impact acknowledgement. Otherwise a stale
  // READY snapshot lets the first click bypass the warning entirely.
  disableSafely(elements.outageNowButton, true);
  try {
    await refresh();
  } catch (error) {
    showActionFeedback(error.message);
    if (state) render(state);
    return;
  }
  // Do not act on a lift the operator changed away from while the fresh read
  // was in flight. They must review the newly selected control explicitly.
  if (selectedFacility() !== actedOn) {
    showActionFeedback('The selected lift changed. Review its controls before reporting an outage.');
    render(state);
    return;
  }
  if (state?.resources?.[actedOn]?.status !== 'OPERATIONAL') {
    showActionFeedback(`${facilityLabel(state, actedOn)} is already out of service.`);
    render(state);
    return;
  }
  const affectsConfirmedBooking = Boolean(
    state?.booking?.resourceIds?.includes(actedOn)
      && state?.resources?.[actedOn]?.status !== 'OUT_OF_SERVICE',
  );
  if (affectsConfirmedBooking) {
    pendingOutageConfirmationId = actedOn;
    render(state);
    elements.manualImpactConfirmationHeading.focus({ preventScroll: true });
    return;
  }
  await takeFacilityOffline(actedOn);
});

elements.confirmOutageButton?.addEventListener('click', async () => {
  const actedOn = pendingOutageConfirmationId;
  if (!actedOn || actedOn !== selectedFacility()) return;
  await takeFacilityOffline(actedOn, {
    acknowledgedBookingReference: state?.booking?.receipt ?? null,
  });
});

elements.cancelOutageButton?.addEventListener('click', () => {
  pendingOutageConfirmationId = null;
  if (state) render(state);
  elements.outageNowButton.focus({ preventScroll: true });
});

elements.restoreButton?.addEventListener('click', async () => {
  disableSafely(elements.restoreButton, true);
  const actedOn = selectedFacility();
  try {
    const payload = await api(operatorEndpoint(actedOn, 'restore'), { method: 'POST', body: '{}' });
    render(payload.state);
    showActionFeedback(`${facilityLabel(payload.state, actedOn)} is back in service. The venue revision changed again.`);
  } catch (error) {
    showActionFeedback(error.message);
    await refresh();
  }
});

// Switching the directly visible lift card repaints the labels and disabled
// states without replacing the radio DOM. The one-second poll therefore cannot
// steal keyboard focus from the operator.
elements.facilityPicker?.addEventListener('change', (event) => {
  pendingOutageConfirmationId = null;
  if (state) render(state);
  const radio = event.target;
  if (radio instanceof HTMLInputElement) {
    window.requestAnimationFrame(() => {
      radio.nextElementSibling?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    });
  }
});

elements.resetButton.addEventListener('click', async () => {
  try {
    pendingOutageConfirmationId = null;
    const payload = await api('/api/demo/reset', { method: 'POST', body: '{}' });
    render(payload.state);
    showActionFeedback('All synthetic venue data restored.');
  } catch (error) {
    showActionFeedback(error.message);
  }
});

async function initialize() {
  try {
    operatorTools = createOperatorTools({ api, refresh });
    await startOperatorSession();
    await refresh();
    await syncOperatorTools();
    window.setInterval(pollState, 1_000);
  } catch (error) {
    showActionFeedback(error.message);
  }
}

initialize();
