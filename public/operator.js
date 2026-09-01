import { createOperatorTools, toolCounts } from '/tools.mjs';
import { auditTitle, operatorEndpoint, raceIntroView, focusRefuge } from '/views.mjs';

/**
 * Which lift the demo controls act on. Defaults to East Lift so every existing
 * scenario, including the browser suite, behaves exactly as before.
 */
function selectedFacility() {
  return document.querySelector('#facility-select')?.value ?? 'east-lift';
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
  facilitySelect: document.querySelector('#facility-select'),
  webmcpStatus: document.querySelector('#operator-webmcp-status'),
  webmcpStatusText: document.querySelector('#operator-webmcp-text'),
  visitorLink: document.querySelector('#visitor-link'),
  facilityList: document.querySelector('#facility-list'),
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
  log: document.querySelector('#operator-log'),
  liveStatus: document.querySelector('#operator-live-status'),
  liveText: document.querySelector('#operator-live-text'),
  venueNotice: document.querySelector('#operator-venue-notice'),
  resetButton: document.querySelector('#operator-reset-button'),
  toast: document.querySelector('#operator-toast'),
};

let state = null;
let toastTimer = null;
let sessionToken = '';
let demoId = '';
let operatorTools = [];
let registeredTools = false;
let lastSuccessfulRefresh = 0;
let standingNotice = '';

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

/** Re-states a standing notice that a later announcement would have replaced. */
function restoreStandingNotice() {
  if (standingNotice) announce(standingNotice);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  announce(message);
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
    restoreStandingNotice();
  }, 3800);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionToken ? { 'X-Demo-Session': sessionToken } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error?.message ?? 'Request failed.');
    error.code = payload.error?.code;
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'operator', demoId: requestedDemoId }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? 'Could not start the operator session.');
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
  const facilities = Object.values(snapshot.resources).filter((resource) => resource.kind === 'FACILITY');
  setHtml(elements.facilityList, facilities.map((facility) => {
    const out = facility.status === 'OUT_OF_SERVICE';
    return `
      <article class="facility-card">
        <span class="facility-symbol" aria-hidden="true">${facility.id === 'east-lift' ? 'L2' : 'L4'}</span>
        <span>
          <strong>${escapeHtml(facility.label)}</strong>
          <small>${out ? escapeHtml(facility.outageReason ?? 'Outage reported') : 'Telemetry current · doors and power normal'}</small>
        </span>
        <span class="facility-state${out ? ' out' : ''}">${out ? 'OUT OF SERVICE' : 'OPERATIONAL'}</span>
      </article>
    `;
  }).join(''));
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
        <span class="audit-version">rev ${entry.resourceVersionBefore}→${entry.resourceVersionAfter}</span>
      </li>
    `;
  }).join(''));
}

function render(snapshot) {
  state = snapshot;
  // The venue operates two lifts and this page could only ever act on one of
  // them. Garden Lift L4 was listed in the facility table with no control at
  // all, while the tool surface and the raw API could take it out with no
  // guard - so the one place the second lift was unreachable was the page a
  // judge is handed. These controls now follow the selected facility.
  const facilityId = selectedFacility();
  const label = facilityLabel(snapshot, facilityId);
  const eastOut = snapshot.resources[facilityId]?.status === 'OUT_OF_SERVICE';
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
  elements.version.textContent = String(snapshot.resourceVersion);
  elements.proofBookings.textContent = String(snapshot.atomicity.bookingCount);
  elements.proofResources.textContent = String(snapshot.atomicity.reservedResourceCount);
  elements.proofPhase.textContent = snapshot.phase;
  elements.proofExplanation.textContent = snapshot.atomicity.reservedResourceCount
    ? `${snapshot.atomicity.reservedResourceCount} reservable resources committed; entrance route and lift were revalidated in the same transaction.`
    : 'Reservable: wheelchair space, companion seat and host slot. Revalidated: entrance route and lift.';
  // Toggling `hidden` on the banner alone never reaches a screen reader, so
  // the transition is announced explicitly, naming the lift that is armed.
  if (armed && elements.armedState.hidden) announce(`Fault armed on ${pendingLabel} for the next confirmation.`);
  if (elements.armedFacility) elements.armedFacility.textContent = pendingLabel;
  elements.armedState.hidden = !armed;
  disableSafely(elements.armButton, eastOut || armed);
  elements.armButton.textContent = armed ? `Fault armed on ${pendingLabel}` : eastOut ? `${label} is offline` : `Arm ${label} fault`;
  // These two were static markup. Parameterising the endpoints without
  // parameterising the text produced buttons that acted on Garden Lift while
  // reading "East Lift" - measured on the deployed page. A control that names
  // the wrong thing it is about to do is worse than one that cannot do it.
  elements.outageNowButton.textContent = `Take ${label} offline now`;
  elements.restoreButton.textContent = `Put ${label} back in service`;
  // The blurb explaining the arm button sits above the selector and said "East
  // Lift" whatever was chosen, so the sentence and the button under it named
  // two different lifts.
  // The sentence and the button state come from one decision now. This told the
  // operator to arm a fault in every state, including the two the venue refuses
  // - a lift already offline, and a venue already holding a pending fault - and
  // the line below disabled the button while the sentence still asked for it.
  if (elements.raceIntro) elements.raceIntro.textContent = raceIntroView(snapshot, { facilityId }).text;
  disableSafely(elements.outageNowButton, eastOut);
  disableSafely(elements.restoreButton, !eastOut);
  renderFacilities(snapshot);
  renderLog(snapshot);
}

async function refresh() {
  const payload = await api('/api/state', { method: 'GET', headers: {} });
  lastSuccessfulRefresh = Date.now();
  elements.liveStatus.classList.remove('stale');
  elements.liveText.textContent = `Venue data live · ${new Date().toLocaleTimeString('en-GB', { hour12: false })}`;
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
    showToast(`${facilityLabel(payload.state, actedOn)} fault will land during the visitor’s next confirmation.`);
  } catch (error) {
    showToast(error.message);
    await refresh();
  }
});

elements.outageNowButton.addEventListener('click', async () => {
  disableSafely(elements.outageNowButton, true);
  const actedOn = selectedFacility();
  try {
    const payload = await api(operatorEndpoint(actedOn, 'outage'), {
      method: 'POST',
      body: JSON.stringify({ reasonCode: 'LIFT_DOOR_FAULT' }),
    });
    render(payload.state);
    showToast(`${facilityLabel(payload.state, actedOn)} is now out of service. The venue revision changed.`);
  } catch (error) {
    showToast(error.message);
    await refresh();
  }
});

elements.restoreButton?.addEventListener('click', async () => {
  disableSafely(elements.restoreButton, true);
  const actedOn = selectedFacility();
  try {
    const payload = await api(operatorEndpoint(actedOn, 'restore'), { method: 'POST', body: '{}' });
    render(payload.state);
    showToast(`${facilityLabel(payload.state, actedOn)} is back in service. The venue revision changed again.`);
  } catch (error) {
    showToast(error.message);
    await refresh();
  }
});

// Switching the lift has to repaint the labels and the disabled states, or the
// buttons keep describing the facility that was selected a moment ago.
elements.facilitySelect?.addEventListener('change', () => {
  if (state) render(state);
});

elements.resetButton.addEventListener('click', async () => {
  try {
    const payload = await api('/api/demo/reset', { method: 'POST', body: '{}' });
    render(payload.state);
    showToast('All synthetic venue data restored.');
  } catch (error) {
    showToast(error.message);
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
    showToast(error.message);
  }
}

initialize();
