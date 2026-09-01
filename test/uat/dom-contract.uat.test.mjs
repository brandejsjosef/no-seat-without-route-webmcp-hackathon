/**
 * Acceptance: the DOM contract between the two HTML pages and the two scripts
 * that drive them - checked as text, without a browser.
 *
 * `public/app.js` and `public/operator.js` resolve every element once, at
 * module scope, into an `elements` object and then use those references
 * unguarded inside `render()`. That shape has a single failure mode and it is
 * silent: rename or drop one id in the HTML and `document.querySelector`
 * returns null, the first property access inside `render()` throws, and every
 * later render step - the incident card, the receipt, the decision log - never
 * runs. The page keeps polling and keeps looking alive. Nothing in the Node
 * suite opens the HTML, so nothing notices.
 *
 * These tests read the four files as text and assert the joins between them:
 * ids the scripts look up, ids ARIA attributes point at, the elements event
 * listeners are attached to, the ids the browser suite drives, the accessible
 * name of every button, and the one case where `.hidden` is assigned to an
 * element that does not implement it.
 *
 * Nearly every check here is shaped "this list of problems is empty", and a
 * list is empty both when the product is healthy and when the detector has
 * quietly stopped working - a regex that no longer matches the file it reads
 * reports a clean page forever. So each detector is also run against a
 * deliberately damaged copy of the real source: `mutate()` refuses to alter
 * text it cannot find exactly once, so if the shape it anchors on ever leaves
 * the product, the proof fails loudly instead of the check going blind.
 *
 * Two findings below are recorded as the product's actual behaviour rather
 * than fixed here - see the comments on
 * "the outage cross on the map is toggled through a property SVG does not have"
 * and "the operations page can only switch one of the venue's two lifts".
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { operatorEndpoint } from '../../public/views.mjs';

import { PHASES } from '../../public/tools.mjs';
import { createDemoStore, demoDefaults } from '../../lib/domain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');

const INDEX_HTML = source('public/index.html');
const OPERATOR_HTML = source('public/operator.html');
const APP_JS = source('public/app.js');
const OPERATOR_JS = source('public/operator.js');
const E2E_JS = source('e2e/browser.mjs');

/* ------------------------------------------------------------------ *
 * Text helpers. Deliberately small and regex based: the repo has zero
 * dependencies and a parser is not needed to answer "does this id exist".
 * ------------------------------------------------------------------ */

const withoutComments = (html) => html.replaceAll(/<!--[\s\S]*?-->/g, '');

/**
 * Prose is not code. Several listeners in app.js sit directly under a comment
 * whose last sentence ends in a word and a full stop ("…knows to check it."),
 * and a text scan would happily read that word, the stop and the next line as
 * one property chain. Protocol-relative `//` inside a string is left alone.
 */
const withoutJsComments = (js) => js
  .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
  .replaceAll(/(^|[^:\w])\/\/[^\n]*/gm, '$1');

/**
 * Damage one exact place in a copy of the real source. The occurrence count is
 * asserted, never assumed: a mutation that silently matched nothing would leave
 * the copy identical to the original and the detector would then be "proved" by
 * a file with nothing wrong in it. Accepts a literal string or a RegExp.
 */
function mutate(text, target, replacement) {
  const pattern = typeof target === 'string'
    ? new RegExp(target.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    : new RegExp(target.source, target.flags.includes('g') ? target.flags : `${target.flags}g`);
  const hits = [...text.matchAll(pattern)].length;
  assert.equal(hits, 1, `expected exactly one \`${target}\` in the real source to damage, found ${hits}`);
  const damaged = text.replace(pattern, () => replacement);
  assert.notEqual(damaged, text, 'the mutation must actually change the source');
  return damaged;
}

/** Attribute list of one start tag, as a map. Values are consumed whole, so a
 *  word inside a value is never mistaken for an attribute name. */
function parseAttributes(attributeText) {
  const attributes = new Map();
  for (const match of attributeText.matchAll(/([a-zA-Z_:][-\w:.]*)(?:\s*=\s*"([^"]*)")?/g)) {
    if (match[1]) attributes.set(match[1].toLowerCase(), match[2] ?? '');
  }
  return attributes;
}

function declaredIds(html) {
  return [...withoutComments(html).matchAll(/\sid="([^"]*)"/g)].map((match) => match[1]);
}

const idSet = (html) => new Set(declaredIds(html));

/** `key: document.querySelector('#id')` pairs from the module-scope map. */
function elementMap(source) {
  const js = withoutJsComments(source);
  const block = js.match(/const elements = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'expected a module-scope `const elements = { ... };` map');
  const map = new Map();
  for (const match of block[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*document\.querySelector\(\s*'([^']+)'\s*\)/g)) {
    map.set(match[1], match[2]);
  }
  return map;
}

/** Every `document.querySelector('#…')` in the file, map or not. */
function documentIdSelectors(source) {
  const selectors = new Set();
  for (const match of withoutJsComments(source).matchAll(/document\.querySelector(?:All)?\(\s*'([^']+)'\s*\)/g)) {
    if (match[1].startsWith('#')) selectors.add(match[1]);
  }
  return selectors;
}

/** Selectors resolved somewhere other than the module-scope map. */
function selectorsResolvedOutsideTheMap(js) {
  const mapped = new Set(elementMap(js).values());
  return [...documentIdSelectors(js)].filter((selector) => !mapped.has(selector)).sort();
}

const leadingId = (selector) => selector.match(/^#([A-Za-z][\w-]*)/)?.[1] ?? null;

/**
 * Ids the script asks the document for that the page never declares. Reported
 * as `key -> #id` so a failure names the offending selector, not a count.
 */
function missingIdSelectors(js, html) {
  const present = idSet(html);
  const map = elementMap(js);
  const missing = [];
  for (const [key, selector] of map) {
    const id = leadingId(selector);
    if (!id || !present.has(id)) missing.push(`${key} -> ${selector}`);
  }
  const mapped = new Set(map.values());
  for (const selector of documentIdSelectors(js)) {
    if (mapped.has(selector)) continue;
    const id = leadingId(selector);
    if (!id || !present.has(id)) missing.push(`document.querySelector('${selector}')`);
  }
  return missing;
}

/** `elements.foo` reads anywhere in the file, including `elements?.foo`. */
function referencedElementKeys(js) {
  return new Set([...withoutJsComments(js).matchAll(/\belements\s*\??\.\s*([A-Za-z_$][\w$]*)/g)].map((match) => match[1]));
}

/** The receiver of every `addEventListener`, normalised without `?.`. */
function listenerTargets(js) {
  const pattern = /(?<![\w$.])((?:[A-Za-z_$][\w$]*)(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*\??\.\s*addEventListener\s*(?:\?\.)?\s*\(/g;
  return [...withoutJsComments(js).matchAll(pattern)].map((match) => match[1].replaceAll(/[\s?]/g, ''));
}

const KNOWN_GLOBAL_LISTENER_TARGETS = new Set(['window', 'document', 'document.modelContext']);

/** Listener receivers that are neither a declared element nor a known global. */
function unknownListenerTargets(js) {
  const keys = elementMap(js);
  return listenerTargets(js).filter((target) => {
    if (KNOWN_GLOBAL_LISTENER_TARGETS.has(target)) return false;
    if (!target.startsWith('elements.')) return true;
    return !keys.has(target.slice('elements.'.length));
  });
}

/** aria-describedby / aria-labelledby / <label for> targets that do not exist. */
function danglingIdReferences(html) {
  const clean = withoutComments(html);
  const present = idSet(html);
  const dangling = [];
  for (const match of clean.matchAll(/\s(aria-describedby|aria-labelledby)="([^"]*)"/g)) {
    for (const token of match[2].trim().split(/\s+/).filter(Boolean)) {
      if (!present.has(token)) dangling.push(`${match[1]}="${token}"`);
    }
  }
  for (const match of clean.matchAll(/<label\b([^>]*)>/g)) {
    const target = parseAttributes(match[1]).get('for');
    if (target && !present.has(target)) dangling.push(`<label for="${target}">`);
  }
  return dangling;
}

const fragmentLinks = (html) => [...withoutComments(html).matchAll(/\shref="#([^"]+)"/g)].map((match) => match[1]);

/** In-page `href="#…"` targets that do not exist. */
function danglingFragmentLinks(html) {
  const present = idSet(html);
  return fragmentLinks(html).filter((id) => !present.has(id)).map((id) => `href="#${id}"`);
}

function buttons(html) {
  return [...withoutComments(html).matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => ({
    attributes: parseAttributes(match[1]),
    inner: match[2],
  }));
}

/**
 * What a screen reader would read out. Subtrees marked `aria-hidden="true"`
 * contribute nothing, which is why the decorative glyphs on this page do not
 * count as a name.
 */
function accessibleName(button) {
  const label = button.attributes.get('aria-label')?.trim();
  if (label) return label;
  const labelledBy = button.attributes.get('aria-labelledby')?.trim();
  if (labelledBy) return labelledBy;
  const text = button.inner
    .replaceAll(/<([a-zA-Z][\w-]*)\b[^>]*\saria-hidden="true"[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replaceAll(/<[^>]*>/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  if (text) return text;
  return button.attributes.get('title')?.trim() ?? '';
}

function namelessButtons(html) {
  return buttons(html)
    .filter((button) => accessibleName(button) === '')
    .map((button) => `<button id="${button.attributes.get('id') ?? '(no id)'}">`);
}

/** Ids declared more than once on one page; querySelector silently takes the first. */
function duplicateIds(html) {
  const seen = new Map();
  for (const id of declaredIds(html)) seen.set(id, (seen.get(id) ?? 0) + 1);
  return [...seen].filter(([, count]) => count > 1).map(([id, count]) => `${id} x${count}`);
}

const svgRegions = (html) => [...withoutComments(html).matchAll(/<svg\b[\s\S]*?<\/svg>/gi)].map((match) => match[0]);

/** Ids of elements inside an `<svg>`, and of those, the ones with a `hidden` attribute. */
function svgIds(html) {
  const all = new Set();
  const withHiddenAttribute = new Set();
  for (const region of svgRegions(html)) {
    for (const tag of region.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
      const attributes = parseAttributes(tag[2]);
      const id = attributes.get('id');
      if (!id) continue;
      all.add(id);
      if (attributes.has('hidden')) withHiddenAttribute.add(id);
    }
  }
  return { all, withHiddenAttribute };
}

/** Element keys the script reveals or conceals with `elements.key.hidden = …`. */
function keysToggledThroughHidden(js) {
  return [...new Set(
    [...withoutJsComments(js).matchAll(/\belements\s*\??\.\s*([A-Za-z_$][\w$]*)\s*\.hidden\s*=/g)].map((match) => match[1]),
  )];
}

/**
 * `hidden` is an IDL attribute of HTMLElement. SVGElement does not implement
 * it, so `svgNode.hidden = false` writes an ordinary JavaScript property and
 * leaves the `hidden` content attribute exactly where it was. An SVG element
 * that starts hidden in the markup and is only ever revealed this way stays
 * hidden for the life of the page.
 */
function svgElementsToggledThroughHidden(js, html) {
  const map = elementMap(js);
  const { all, withHiddenAttribute } = svgIds(html);
  const ids = keysToggledThroughHidden(js)
    .map((key) => leadingId(map.get(key) ?? ''))
    .filter((id) => id && all.has(id));
  return {
    inSvg: [...new Set(ids)].sort(),
    startsHidden: [...new Set(ids.filter((id) => withHiddenAttribute.has(id)))].sort(),
  };
}

/** Every `'#id'`-shaped selector the browser suite drives. */
function e2eSelectorIds(js) {
  return [...new Set([...js.matchAll(/['"`]#([A-Za-z][\w-]*)/g)].map((match) => match[1]))].sort();
}

/** Action names `auditLabels` can turn into a sentence for the decision log. */
function labelledAuditActions(js) {
  const block = withoutJsComments(js).match(/const auditLabels = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'expected a module-scope `const auditLabels = { ... };` map');
  return new Set([...block[1].matchAll(/^\s*([A-Z][A-Z_]*)\s*:/gm)].map((match) => match[1]));
}

/** Action names `renderAudit` lets through to the visitor's decision log. */
function visitorAuditActions(js) {
  const block = withoutJsComments(js).match(/const visitorAuditActions = new Set\(\[([\s\S]*?)\n\]\);/);
  assert.ok(block, 'expected a module-scope `const visitorAuditActions = new Set([ ... ]);`');
  return new Set([...block[1].matchAll(/'([A-Z][A-Z_]*)'/g)].map((match) => match[1]));
}

/** Phase names the visitor script branches on. */
function phaseLiteralsUsedBy(source) {
  const js = withoutJsComments(source);
  const literals = new Set();
  for (const match of js.matchAll(/\b(?:phase|lastPhase|previousPhase)\b\s*(?:===|!==)\s*'([A-Z_]+)'/g)) {
    literals.add(match[1]);
  }
  for (const match of js.matchAll(/\[([^\]]+)\]\.includes\(\s*[\w.?]*\bphase\b[\w.?]*\s*\)/gi)) {
    for (const literal of match[1].matchAll(/'([A-Z_]+)'/g)) literals.add(literal[1]);
  }
  return [...literals].sort();
}

/* ------------------------------------------------------------------ *
 * The contract itself.
 * ------------------------------------------------------------------ */

describe('every id a page script looks up is declared by the page it runs on', () => {
  test('the booking script finds every element it resolves at module scope', () => {
    const map = elementMap(APP_JS);
    assert.ok(map.size >= 50, `expected the booking page to resolve many elements, saw ${map.size}`);
    assert.deepEqual(
      selectorsResolvedOutsideTheMap(APP_JS),
      [],
      'public/app.js must resolve every element once, in the module-scope map, or the map check below misses it',
    );
    const missing = missingIdSelectors(APP_JS, INDEX_HTML);
    assert.deepEqual(
      missing,
      [],
      `public/app.js queries ids that public/index.html does not declare: ${missing.join(', ')}`,
    );
  });

  test('the operations script finds every element it resolves at module scope', () => {
    const map = elementMap(OPERATOR_JS);
    assert.ok(map.size >= 15, `expected the operations page to resolve many elements, saw ${map.size}`);
    assert.deepEqual(
      selectorsResolvedOutsideTheMap(OPERATOR_JS),
      ['#a11y-status'],
      'the live region is looked up on demand by announce(); any other late lookup needs its own null guard',
    );
    const missing = missingIdSelectors(OPERATOR_JS, OPERATOR_HTML);
    assert.deepEqual(
      missing,
      [],
      `public/operator.js queries ids that public/operator.html does not declare: ${missing.join(', ')}`,
    );
  });

  test('renaming an id the scripts look up is reported against the code that looks it up', () => {
    const renamedInMap = mutate(INDEX_HTML, ' id="venue-version"', ' id="venue-version-renamed"');
    assert.deepEqual(missingIdSelectors(APP_JS, renamedInMap), ['venueVersion -> #venue-version']);

    const renamedLiveRegion = mutate(OPERATOR_HTML, ' id="a11y-status"', ' id="a11y-status-renamed"');
    assert.deepEqual(missingIdSelectors(OPERATOR_JS, renamedLiveRegion), ["document.querySelector('#a11y-status')"]);
  });

  test('the booking script never reads an element key it did not declare', () => {
    const declared = elementMap(APP_JS);
    const referenced = referencedElementKeys(APP_JS);
    assert.ok(referenced.size >= 40, `expected many element reads, saw ${referenced.size}`);
    const undeclared = [...referenced].filter((key) => !declared.has(key)).sort();
    assert.deepEqual(
      undeclared,
      [],
      `public/app.js reads elements.${undeclared.join(', elements.')} which the map never defines`,
    );
  });

  test('the operations script never reads an element key it did not declare', () => {
    const declared = elementMap(OPERATOR_JS);
    const referenced = referencedElementKeys(OPERATOR_JS);
    assert.ok(referenced.size >= 15, `expected many element reads, saw ${referenced.size}`);
    const undeclared = [...referenced].filter((key) => !declared.has(key)).sort();
    assert.deepEqual(
      undeclared,
      [],
      `public/operator.js reads elements.${undeclared.join(', elements.')} which the map never defines`,
    );
  });

  test('no page declares the same id twice', () => {
    assert.ok(declaredIds(INDEX_HTML).length > 30, 'expected the booking page to declare many ids');
    assert.ok(declaredIds(OPERATOR_HTML).length > 15, 'expected the operations page to declare many ids');
    assert.deepEqual(duplicateIds(INDEX_HTML), [], 'public/index.html declares an id more than once');
    assert.deepEqual(duplicateIds(OPERATOR_HTML), [], 'public/operator.html declares an id more than once');
    // A duplicate is invisible to querySelector, which takes the first match.
    assert.deepEqual(duplicateIds(mutate(INDEX_HTML, ' id="toast"', ' id="incident"')), ['incident x2']);
  });
});

describe('every listener is attached to an element the page really has', () => {
  test('the booking script only listens on declared elements and known globals', () => {
    const targets = listenerTargets(APP_JS);
    assert.ok(targets.length >= 8, `expected several listeners in app.js, saw ${targets.length}`);
    assert.ok(targets.includes('elements.confirmButton'), 'the confirm button must carry a listener');
    const unknown = unknownListenerTargets(APP_JS);
    assert.deepEqual(unknown, [], `public/app.js attaches a listener to ${unknown.join(', ')}`);
  });

  test('the operations script only listens on declared elements and known globals', () => {
    const targets = listenerTargets(OPERATOR_JS);
    assert.ok(targets.length >= 4, `expected several listeners in operator.js, saw ${targets.length}`);
    assert.ok(targets.includes('elements.armButton'), 'the arm button must carry a listener');
    const unknown = unknownListenerTargets(OPERATOR_JS);
    assert.deepEqual(unknown, [], `public/operator.js attaches a listener to ${unknown.join(', ')}`);
  });

  test('a listener bound to a key the map never declares is reported', () => {
    const typo = mutate(APP_JS, 'elements.confirmButton.addEventListener', 'elements.confirmButtn.addEventListener');
    assert.deepEqual(unknownListenerTargets(typo), ['elements.confirmButtn']);
  });
});

describe('every id an accessibility attribute points at exists', () => {
  test('the booking page resolves every aria-describedby, aria-labelledby and label target', () => {
    const references = [...withoutComments(INDEX_HTML).matchAll(/\saria-(?:describedby|labelledby)="/g)];
    assert.ok(references.length >= 10, `expected many ARIA references, saw ${references.length}`);
    const dangling = danglingIdReferences(INDEX_HTML);
    assert.deepEqual(dangling, [], `public/index.html points at ids that do not exist: ${dangling.join(', ')}`);
  });

  test('the operations page resolves every aria-describedby, aria-labelledby and label target', () => {
    const references = [...withoutComments(OPERATOR_HTML).matchAll(/\saria-(?:describedby|labelledby)="/g)];
    assert.ok(references.length >= 4, `expected several ARIA references, saw ${references.length}`);
    const dangling = danglingIdReferences(OPERATOR_HTML);
    assert.deepEqual(dangling, [], `public/operator.html points at ids that do not exist: ${dangling.join(', ')}`);
  });

  test('a description that points nowhere and a label that names no field are both reported', () => {
    const orphanedHint = mutate(INDEX_HTML, ' id="fault-hint"', ' id="fault-hint-renamed"');
    const alsoOrphanedLabel = mutate(
      orphanedHint,
      /<label(?=[^>]*>\s*<input type="checkbox" name="stepFree")/,
      '<label for="no-such-field"',
    );
    assert.deepEqual(danglingIdReferences(alsoOrphanedLabel), [
      'aria-describedby="fault-hint"',
      '<label for="no-such-field">',
    ]);
  });

  test('both pages let a keyboard user skip to a landmark that exists', () => {
    assert.match(INDEX_HTML, /class="skip-link" href="#main"/);
    assert.match(OPERATOR_HTML, /class="skip-link" href="#operator-main"/);
    assert.ok(fragmentLinks(INDEX_HTML).length >= 1, 'expected the booking page to link to a fragment');
    assert.ok(fragmentLinks(OPERATOR_HTML).length >= 1, 'expected the operations page to link to a fragment');
    assert.deepEqual(danglingFragmentLinks(INDEX_HTML), [], 'public/index.html links to a fragment that does not exist');
    assert.deepEqual(danglingFragmentLinks(OPERATOR_HTML), [], 'public/operator.html links to a fragment that does not exist');
    // The skip link is only useful while the landmark it names is still there.
    assert.deepEqual(danglingFragmentLinks(mutate(INDEX_HTML, ' id="main"', ' id="main-content"')), ['href="#main"']);
  });
});

describe('every button can be announced', () => {
  test('every button on the booking page has a non-empty accessible name', () => {
    const found = buttons(INDEX_HTML);
    assert.ok(found.length >= 6, `expected several buttons on the booking page, saw ${found.length}`);
    const nameless = namelessButtons(INDEX_HTML);
    assert.deepEqual(nameless, [], `public/index.html has unnamed buttons: ${nameless.join(', ')}`);
  });

  test('every button on the operations page has a non-empty accessible name', () => {
    const found = buttons(OPERATOR_HTML);
    assert.ok(found.length >= 4, `expected several buttons on the operations page, saw ${found.length}`);
    const nameless = namelessButtons(OPERATOR_HTML);
    assert.deepEqual(nameless, [], `public/operator.html has unnamed buttons: ${nameless.join(', ')}`);
  });

  test('a button left holding only a decorative glyph counts as unnamed', () => {
    const glyphOnly = mutate(
      INDEX_HTML,
      'id="share-link-button">Copy shared venue link<',
      'id="share-link-button"><span aria-hidden="true">&#9744;</span><',
    );
    assert.deepEqual(namelessButtons(glyphOnly), ['<button id="share-link-button">']);
  });
});

describe('the ids the browser suite drives are all present', () => {
  test('the seven ids the acceptance run reads by name exist on the booking page', () => {
    const required = [
      'plan-state',
      'route-summary',
      'atomic-proof-text',
      'receipt-number',
      'incident-message',
      'tool-list',
      'partial-count',
    ];
    const unread = required.filter((id) => !new RegExp(`#${id}(?![\\w-])`).test(E2E_JS));
    assert.deepEqual(unread, [], `e2e/browser.mjs no longer reads: #${unread.join(', #')}`);
    const present = idSet(INDEX_HTML);
    const missing = required.filter((id) => !present.has(id));
    assert.deepEqual(missing, [], `public/index.html is missing ids the browser suite reads: #${missing.join(', #')}`);
  });

  test('every id selector in the browser suite resolves on one of the two pages', () => {
    const ids = e2eSelectorIds(E2E_JS);
    assert.ok(ids.length >= 30, `expected the browser suite to drive many ids, saw ${ids.length}`);
    const known = new Set([...idSet(INDEX_HTML), ...idSet(OPERATOR_HTML)]);
    const missing = ids.filter((id) => !known.has(id));
    assert.deepEqual(missing, [], `e2e/browser.mjs drives ids no page declares: #${missing.join(', #')}`);
  });
});

describe('elements toggled through the hidden property', () => {
  /**
   * This recorded the defect instead of forbidding it. `#east-outage-cross` is
   * an SVG `<g>` carrying `hidden` in the markup, and `renderPlan()` revealed it
   * with `elements.eastOutageCross.hidden = !eastOut`. SVGElement has no
   * `hidden` IDL attribute, so that assignment created a plain JavaScript
   * property and never removed the content attribute: the cross the map uses to
   * draw a lift failure could not be drawn, and had never been drawn. Nothing in
   * e2e/browser.mjs looked at the element, which is why nothing said so.
   *
   * The cross is now toggled through the attribute and both lifts have one, so
   * the list must be empty rather than merely short.
   */
  test('no SVG element is revealed through a property SVG does not implement', () => {
    const found = svgElementsToggledThroughHidden(APP_JS, INDEX_HTML);
    assert.deepEqual(
      found.inSvg,
      [],
      'an SVG element is revealed by assigning .hidden, which SVGElement does not implement',
    );
    assert.deepEqual(
      found.startsHidden,
      [],
      'an SVG element starts hidden in the markup and is only ever revealed by a property that does not reflect',
    );
    assert.match(APP_JS, /cross\.toggleAttribute\('hidden'/);
    assert.match(INDEX_HTML, /id="east-outage-cross" hidden>/);
    assert.match(INDEX_HTML, /id="garden-outage-cross" hidden>/);
  });

  test('an SVG element revealed the wrong way would still be reported', () => {
    // The detector has to keep working now that nothing in the real source
    // trips it. #companion-seat-map is a real <g> inside the map, today toggled
    // by class; switching it to a .hidden assignment must show up.
    const alsoToggled = mutate(APP_JS, 'elements.toast.hidden = false;', 'elements.companionSeatMap.hidden = false;');
    assert.deepEqual(svgElementsToggledThroughHidden(alsoToggled, INDEX_HTML), {
      inSvg: ['companion-seat-map'],
      startsHidden: [],
    });
  });

  test('the operations page shows and hides only elements it declared, none of them in an SVG', () => {
    const map = elementMap(OPERATOR_JS);
    const present = idSet(OPERATOR_HTML);
    const ids = keysToggledThroughHidden(OPERATOR_JS).map((key) => leadingId(map.get(key) ?? ''));
    assert.deepEqual(
      [...ids].sort(),
      [
        'armed-state',
        'booking-impact',
        'manual-impact-confirmation',
        'manual-impact-note',
        'operator-toast',
        'operator-venue-notice',
      ],
      'public/operator.js hides an element the module-scope map does not resolve',
    );
    assert.deepEqual(ids.filter((id) => !present.has(id)), [], 'a hidden toggle names an id the page never declares');
    assert.deepEqual(svgElementsToggledThroughHidden(OPERATOR_JS, OPERATOR_HTML), { inSvg: [], startsHidden: [] });
  });

  test('elements the booking script hides are HTML elements, which do reflect hidden', () => {
    const map = elementMap(APP_JS);
    const present = idSet(INDEX_HTML);
    const inSvg = svgIds(INDEX_HTML).all;
    const toggled = keysToggledThroughHidden(APP_JS);
    assert.ok(toggled.length >= 8, `expected several hidden toggles, saw ${toggled.length}`);
    const ids = toggled.map((key) => leadingId(map.get(key) ?? ''));
    assert.deepEqual(ids.filter((id) => !id || !present.has(id)), [], 'a hidden toggle names an id the page never declares');
    assert.deepEqual(ids.filter((id) => !inSvg.has(id)).sort(), [
      'assurance-empty',
      'assurance-plan',
      'booking-impact-alert',
      'decision-section',
      'demo-controls',
      'incident',
      'plan-feedback',
      'receipt-section',
      'route-section',
      'start-over-button',
      'toast',
      'venue-notice',
    ]);
  });
});

describe('the state shape the render path assumes', () => {
  const freshStore = () => createDemoStore({
    clock: () => Date.parse('2026-08-30T18:00:00.000Z'),
    idFactory: ((n) => () => `id-${++n}`)(0),
  });

  test('every snapshot carries the fields both render functions read unguarded', () => {
    const store = freshStore();
    const snapshots = [store.snapshot()];
    const plan = store.findBundle(demoDefaults);
    snapshots.push(store.snapshot());
    store.stageBundle(plan.id, plan.basedOnResourceVersion);
    snapshots.push(store.snapshot());
    store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');
    snapshots.push(store.snapshot());

    // The four snapshots must really be four different states, or the loop
    // below checks one shape four times.
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.phase),
      ['READY', 'PLAN_READY', 'AWAITING_HUMAN_CONFIRMATION', 'PLAN_STALE'],
    );
    assert.equal(
      snapshots.at(-1).resourceVersion,
      snapshots[0].resourceVersion + 1,
      'taking the lift out of service must bump the version the page prints',
    );

    for (const snapshot of snapshots) {
      // app.js render(): state.resourceVersion, state.audit, state.atomicity,
      // state.resources['east-lift'].status, state.demo.
      // operator.js render() reads the same five without any optional chaining.
      assert.equal(typeof snapshot.resourceVersion, 'number', 'resourceVersion is printed into #venue-version');
      assert.ok(Array.isArray(snapshot.audit), 'audit is filtered into #audit-list');
      assert.equal(typeof snapshot.atomicity.reservedResourceCount, 'number', 'read into #partial-count');
      assert.equal(typeof snapshot.atomicity.bookingCount, 'number', 'read into #proof-bookings');
      assert.equal(typeof snapshot.resources['east-lift'].status, 'string', "renderPlan indexes resources['east-lift']");
      assert.ok(snapshot.demo && 'pendingOutageResourceId' in snapshot.demo, 'renderFaultControl reads demo');
      assert.ok(PHASES.includes(snapshot.phase), `phase ${snapshot.phase} is outside the published phase list`);
    }
  });

  test('a staged plan carries every route field the plan card prints', () => {
    const store = freshStore();
    const plan = store.findBundle(demoDefaults);
    store.stageBundle(plan.id, plan.basedOnResourceVersion);
    const { activePlan } = store.snapshot();
    assert.ok(activePlan, 'a staged plan must reach the page');
    const printed = {
      entrance: 'string',
      liftId: 'string',
      liftLabel: 'string',
      assistanceLabel: 'string',
      durationMinutes: 'number',
      distanceM: 'number',
      minWidthCm: 'number',
    };
    for (const [field, expected] of Object.entries(printed)) {
      assert.equal(typeof activePlan.route[field], expected, `renderPlan prints route.${field}`);
      assert.match(APP_JS, new RegExp(`route\\.${field}\\b`), `public/app.js never reads route.${field}`);
    }
    assert.ok(Array.isArray(activePlan.route.path) && activePlan.route.path.length > 0, 'route.path fills #route-summary');
    assert.equal(typeof activePlan.requirements.companionCount, 'number');
    assert.equal(typeof activePlan.basedOnResourceVersion, 'number');
  });

  test('a committed booking carries every field the receipt prints', () => {
    const store = freshStore();
    const plan = store.findBundle(demoDefaults);
    store.stageBundle(plan.id, plan.basedOnResourceVersion);
    const confirmation = store.prepareConfirmation(plan.id);
    store.commitBundle({
      planId: plan.id,
      confirmationId: confirmation.confirmationId,
      expectedResourceVersion: confirmation.expectedResourceVersion,
      accepted: true,
      requestId: 'uat-dom-contract',
    });
    const { booking, phase } = store.snapshot();
    assert.equal(phase, 'CONFIRMED');
    assert.match(booking.receipt, /^NSWR-\d+$/, 'booking.receipt fills #receipt-number');
    assert.ok(Array.isArray(booking.route.path), 'booking.route.path fills the receipt details');
    assert.equal(typeof booking.route.assistanceLabel, 'string');
    assert.equal(typeof booking.committedResourceVersion, 'number', 'read into #atomic-proof-text');
    assert.equal(booking.partialReservations, 0);
    assert.ok(Array.isArray(booking.resourceIds) && booking.resourceIds.length > 0, '#atomic-proof-text counts these');
  });

  test('every phase name the booking script branches on is a published phase', () => {
    const used = phaseLiteralsUsedBy(APP_JS);
    assert.ok(used.length >= 4, `expected the page to branch on several phases, saw ${used.join(', ')}`);
    const unknown = used.filter((phase) => !PHASES.includes(phase));
    assert.deepEqual(unknown, [], `public/app.js compares state.phase with names the domain never emits: ${unknown.join(', ')}`);
  });

  /**
   * `renderAudit` filters state.audit through `visitorAuditActions` and names
   * each survivor through `auditLabels`. Both are plain objects keyed by an
   * action string the domain invents, so renaming an action in lib/domain.mjs
   * breaks nothing loudly: the entry either drops out of the visitor's decision
   * log without a trace or is printed to them as a raw enum.
   */
  test('every audit action the venue emits is one the decision log can name', () => {
    const store = freshStore();
    const plan = store.findBundle(demoDefaults);
    store.stageBundle(plan.id, plan.basedOnResourceVersion);
    store.setFacilityOutage('east-lift', 'LIFT_DOOR_FAULT');
    const emitted = [...new Set(store.snapshot().audit.map((entry) => entry.action))];
    assert.ok(emitted.length >= 3, `expected the demo walk to record several actions, saw ${emitted.join(', ')}`);

    const labelled = labelledAuditActions(APP_JS);
    const unlabelled = emitted.filter((action) => !labelled.has(action)).sort();
    assert.deepEqual(unlabelled, [], `#audit-list would print the raw enum for: ${unlabelled.join(', ')}`);

    const admitted = visitorAuditActions(APP_JS);
    assert.deepEqual(
      emitted.filter((action) => admitted.has(action)).sort(),
      ['FACILITY_OUTAGE_REPORTED', 'PLAN_STAGED'],
      'the decision log must still tell the visitor that a plan was prepared and that the lift then failed',
    );
    const admittedButUnnamed = [...admitted].filter((action) => !labelled.has(action)).sort();
    assert.deepEqual(
      admittedButUnnamed,
      [],
      `public/app.js shows actions it has no wording for: ${admittedButUnnamed.join(', ')}`,
    );
  });

  /**
   * This recorded a defect rather than forbidding it: the operations page
   * rendered a card for every facility the venue has, while arm, take-offline
   * and restore were all wired to the literal `east-lift`. Garden Lift L4 was
   * shown as a live facility the operator could not switch, on the one page a
   * judge is handed - and the tool surface could switch it all along.
   *
   * The controls now follow a facility selector, so the assertion is about the
   * property instead: whatever the venue operates must be reachable from here.
   */
  test('the operations page can switch every lift the venue reports', () => {
    const facilities = Object.values(freshStore().snapshot().resources)
      .filter((resource) => resource.kind === 'FACILITY')
      .map((resource) => resource.id)
      .sort();
    assert.deepEqual(facilities, ['east-lift', 'garden-lift']);

    const surface = `${OPERATOR_HTML}\n${OPERATOR_JS}`;
    const unreachable = facilities.filter((id) => !surface.includes(id));
    assert.deepEqual(
      unreachable,
      [],
      `the operations page offers no way to act on: ${unreachable.join(', ')}`,
    );

    // The endpoints must be parameterised rather than naming one lift, or a
    // third facility would be listed and still unreachable.
    //
    // This used to assert the literal source text `${selectedFacility()}` inside
    // the URL. That check was the wrong shape twice over: it passed on any page
    // that merely mentioned the call, and it pinned the exact second read of the
    // selector that has since been removed - the URL now uses the id captured in
    // the same tick as the toast, so all three cannot name different lifts.
    //
    // The property is asserted through the function the page actually calls.
    for (const id of facilities) {
      for (const action of ['arm', 'outage', 'restore']) {
        assert.equal(
          operatorEndpoint(id, action),
          `/api/operator/facilities/${id}/${action}`,
          `${action} does not follow the facility it was asked about`,
        );
      }
    }
    assert.doesNotMatch(OPERATOR_JS, /["'`]\/api\/operator\/facilities\/[a-z-]+\//,
      'the operations page builds a facility URL from a literal id');
  });
});
