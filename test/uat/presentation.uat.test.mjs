/**
 * Presentation contracts for the judge-facing walkthrough.
 *
 * These checks pin hierarchy and truthful control copy, not decorative pixel
 * values. A redesign may change the styling, but it must keep the three-step
 * story, the proof above the fold, and the safe-failure control honest.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const INDEX = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
const OPERATOR = readFileSync(new URL('../../public/operator.html', import.meta.url), 'utf8');
const STYLES = readFileSync(new URL('../../public/styles.css', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
const OPERATOR_JS = readFileSync(new URL('../../public/operator.js', import.meta.url), 'utf8');

function at(source, needle) {
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, `missing ${needle}`);
  return index;
}

function luminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map((part) => Number.parseInt(part, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground, background) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('the visitor page tells the demo in the order a judge performs it', () => {
  test('agent prompt, activity, requirements and safe failure form one three-step story', () => {
    const hero = at(INDEX, 'class="hero shell"');
    const agent = at(INDEX, 'class="agent-callout quick-start shell"');
    const activity = at(INDEX, 'class="protocol-strip"');
    const requirements = at(INDEX, 'class="shell booking-section"');
    const failure = at(INDEX, 'class="demo-controls"');
    const route = at(INDEX, 'id="route-section"');

    assert.ok(hero < agent && agent < activity && activity < requirements);
    assert.ok(requirements < failure && failure < route);
    assert.match(INDEX, /STEP 1 · USE YOUR AGENT/);
    assert.match(INDEX, /STEP 2 · YOUR VISIT/);
    assert.match(INDEX, /STEP 3 · TEST THE SAFE FAILURE/);
  });

  test('the prompt is compact, the internal tool list is disclosed on demand, and defaults are named', () => {
    assert.match(INDEX, /<details class="tool-disclosure">\s*<summary>View browser tools<\/summary>/);
    assert.match(INDEX, /<strong>Demo defaults\.<\/strong>/);
    assert.match(INDEX, /<span class="webmcp-label">WebMCP ·<\/span>/);
    assert.match(INDEX, /id="venue-version">Venue revision —<\/span>/);
    assert.doesNotMatch(INDEX + OPERATOR, /◇/);
    assert.match(INDEX, /<small>Agent<\/small>/);
    assert.match(INDEX, /<small>Tool<\/small>/);
    assert.match(INDEX, /<small>Page<\/small>/);
    assert.match(INDEX, /aria-label="N\/R No Seat Without a Route, home"/);
  });

  test('the safe-failure step begins out of the READY walkthrough and the shared link is secondary', () => {
    assert.match(INDEX, /class="demo-controls" id="demo-controls" hidden/);
    assert.match(INDEX, /id="fault-button"[^>]*aria-disabled="true">Build a plan to unlock this test<\/button>/);
    assert.match(INDEX, /Fails on the next confirmation; the lift stays online until then\./);
    const footer = at(INDEX, '<footer');
    const share = at(INDEX, 'id="share-link-button"');
    assert.ok(share > footer, 'shared venue control moved back into the main walkthrough');
  });

  test('a refused search becomes a persistent result inside the access-plan card', () => {
    const build = at(INDEX, 'id="build-plan-button"');
    const card = at(INDEX, 'id="assurance-card"');
    const feedback = at(INDEX, 'id="plan-feedback"');
    assert.ok(build < card && card < feedback, 'refusal feedback is not adjacent to the form result');
    assert.match(INDEX, /id="plan-feedback" role="alert" hidden/);
    assert.match(INDEX, /NO COMPLETE PLAN RIGHT NOW/);
    assert.match(INDEX, /<strong>Nothing was booked or reserved\.<\/strong>/);
    assert.match(APP, /elements\.planFeedbackMessage\.textContent = view\.text/);
    assert.match(APP, /elements\.planFeedbackHeading\.focus/);
    assert.doesNotMatch(APP, /Plan in progress/);
  });

  test('the footer reports a dated Lighthouse measurement without presenting a certification badge', () => {
    const footer = INDEX.slice(at(INDEX, '<footer'));
    const share = at(footer, 'id="share-link-button"');
    const evidenceStart = at(footer, '<details class="footer-evidence"');
    const evidence = footer.slice(evidenceStart);
    const opening = evidence.match(/<details\b[^>]*>/)?.[0] ?? '';

    assert.ok(share < evidenceStart, 'quality evidence displaced the primary footer actions');
    assert.doesNotMatch(opening, /\sopen(?:\s|=|>)/);
    assert.match(evidence, /<details[^>]*>\s*<summary>Automated Lighthouse snapshot · <time datetime="2026-09-02">2 Sep 2026<\/time><\/summary>/);
    assert.match(evidence, /Lighthouse 13\.4\.0 · Chrome 152 · mobile preset · median of 3 runs/);
    assert.match(evidence, /<tr><th scope="row">Visitor<\/th><td>98<\/td><td>100<\/td><td>100<\/td><td>100<\/td><\/tr>/);
    assert.match(evidence, /<tr><th scope="row">Operator<\/th><td>100<\/td><td>100<\/td><td>100<\/td><td>100<\/td><\/tr>/);
    assert.match(evidence, /not a manual accessibility audit or certification/);
    assert.doesNotMatch(evidence, /class="[^"]*(?:badge|certified)|Lighthouse certified|Lighthouse 100/i);
    assert.match(STYLES, /\.footer-evidence summary\s*\{[^}]*min-height:\s*44px;[^}]*cursor:\s*pointer;/s);
  });
});

describe('the operator page foregrounds state and uses operational language', () => {
  test('the standalone operations page has search metadata and a readable WebMCP badge', () => {
    assert.match(OPERATOR, /<meta name="description" content="[^"]+">/);
    assert.match(
      STYLES,
      /\.operator-header \.webmcp-status,[\s\S]*?background:\s*#dcefea;[\s\S]*?color:\s*#183b33;/,
    );
    assert.ok(contrast('183b33', 'dcefea') >= 4.5);
  });

  test('venue revision and the no-half-bookings proof precede the controls', () => {
    const overview = at(OPERATOR, 'class="operator-overview"');
    const proof = at(OPERATOR, 'id="proof-bookings"');
    const controls = at(OPERATOR, 'class="operator-grid"');
    assert.ok(overview < proof && proof < controls);
    assert.match(OPERATOR, />Venue revision<\/span>/);
    assert.match(OPERATOR, /Keep every route honest\./);
    assert.match(OPERATOR, /SYNTHETIC VENUE STATE/);
    assert.doesNotMatch(OPERATOR + OPERATOR_JS, /live telemetry|Telemetry current/i);
    assert.doesNotMatch(OPERATOR, /Inject a review-to-commit race/);
  });

  test('both lift states are directly selectable cards, never hidden behind a dropdown', () => {
    assert.doesNotMatch(OPERATOR, /id="facility-select"|<select\b/);
    assert.match(OPERATOR, /<fieldset class="facility-list facility-picker" id="facility-picker"/);
    assert.match(OPERATOR, /type="radio" name="controlled-facility" value="east-lift"[^>]*checked/);
    assert.match(OPERATOR, /type="radio" name="controlled-facility" value="garden-lift"/);
    assert.match(OPERATOR, /Both live states stay visible/);
    assert.match(STYLES, /\.facility-radio:focus-visible \+ \.facility-card\s*\{[^}]*outline:\s*3px solid white;/s);
    assert.match(STYLES, /\.facility-radio:checked \+ \.facility-card \.facility-selected/);
    assert.match(OPERATOR, /class="facility-select-hint"[^>]*>Select to control</);
    assert.match(STYLES, /\.facility-radio:checked \+ \.facility-card \.facility-select-hint\s*\{[^}]*display:\s*none;/s);
    assert.match(OPERATOR_JS, /requestAnimationFrame\(\(\) => \{\s*radio\.nextElementSibling\?\.scrollIntoView\(\{ block: 'nearest', behavior: 'auto' \}\)/s);
  });

  test('selected state never paints an offline lift green', () => {
    const selectedOperational = STYLES.indexOf('.facility-radio:checked + .facility-card {');
    const selectedOffline = STYLES.indexOf('.facility-radio:checked + .facility-card.out {');
    assert.ok(selectedOperational >= 0 && selectedOffline > selectedOperational,
      'the more specific offline override must follow the generic selected style');
    assert.match(STYLES, /\.facility-radio:checked \+ \.facility-card\.out\s*\{[^}]*background:\s*#4b1b20;[^}]*border:\s*2px solid #ff8a7f;/s);
    assert.match(STYLES, /\.facility-radio:checked \+ \.facility-card\.out \.facility-selected\s*\{[^}]*border-color:\s*#ff8a7f;/s);
    assert.match(STYLES, /\.facility-option:hover \.facility-card\.out\s*\{[^}]*border-color:\s*#ff8a7f;/s);
  });

  test('action results are persistent in-page content, never timed overlays', () => {
    assert.match(INDEX, /id="action-feedback" hidden/);
    assert.match(OPERATOR, /id="operator-action-feedback" hidden/);
    assert.doesNotMatch(INDEX, /id="action-feedback"[^>]*role="status"/);
    assert.doesNotMatch(OPERATOR, /id="operator-action-feedback"[^>]*role="status"/);
    assert.match(INDEX, /id="a11y-status" role="status"/);
    assert.match(OPERATOR, /id="a11y-status" role="status"/);
    assert.match(STYLES, /\.action-feedback\s*\{[^}]*width:\s*100%;/s);
    assert.doesNotMatch(STYLES, /\.toast\s*\{|position:\s*fixed[^}]*action-feedback/s);
    assert.doesNotMatch(INDEX + OPERATOR, /class="toast"|id="(?:operator-)?toast"/);
    assert.doesNotMatch(APP + OPERATOR_JS, /showToast|toastTimer|setTimeout\([^)]*actionFeedback/s);
    assert.ok(INDEX.indexOf('id="action-feedback"') > INDEX.indexOf('id="assurance-card"'));
    assert.ok(OPERATOR.indexOf('id="operator-action-feedback"') > OPERATOR.indexOf('class="race-card"'));
  });

  test('a confirmed route disruption has persistent operator and visitor warnings', () => {
    assert.match(OPERATOR, /id="booking-impact" role="alert"/);
    assert.match(OPERATOR, /id="manual-impact-confirmation" role="group"/);
    assert.match(OPERATOR, /id="confirm-outage-button"/);
    assert.match(OPERATOR, /id="cancel-outage-button"/);
    assert.match(OPERATOR_JS, /Review impact before taking \$\{label\} offline/);
    assert.match(OPERATOR_JS, /The booking and held resources will stay active/);
    assert.match(OPERATOR, /A confirmed booking has lost its working route/);
    assert.match(INDEX, /id="booking-impact-alert" role="alert"/);
    assert.match(INDEX, /Your confirmed route has been disrupted/);
    assert.match(OPERATOR, /id="manual-impact-note" hidden/);
  });

  test('the operator mark keeps its two letters centred inside the circle', () => {
    assert.match(
      STYLES,
      /\.operator-brand \.wordmark-mark\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;/s,
    );
  });

  test('the empty event log text has WCAG AA normal-text contrast', () => {
    assert.match(STYLES, /\.operator-log \.audit-empty\s*\{[^}]*color:\s*#b8c9c5;/s);
    assert.ok(contrast('b8c9c5', '101f1b') >= 4.5);
  });
});
