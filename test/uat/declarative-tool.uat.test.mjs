/**
 * Acceptance: the page never publishes half a declarative WebMCP tool.
 *
 * Chrome DevTools reported "Missing tool description for a WebMCP declarative
 * tool definition" against the live requirements form, while the description
 * was plainly there in `public/index.html` and plainly set by `public/app.js`.
 * Both were true. Chrome judges the form the instant an attribute changes, and
 * app.js changed two attributes in two statements:
 *
 *     form.setAttribute('toolname', declarativeTool.name);
 *     form.setAttribute('tooldescription', declarativeTool.description);
 *
 * Between those two lines the form carried a name and no description, which is
 * exactly the state the issue names. Reversing the order does not fix it, it
 * only swaps the reported error for its sibling, kFormModelContextMissingTool-
 * Name. The pair has to move as one.
 *
 * These tests therefore assert the property - a form is a whole declarative
 * tool or none at all, at rest in the markup and at every step of every
 * transition app.js can make - rather than the two lines that happened to
 * break it.
 *
 * WHAT THIS FILE DOES NOT PROVE
 *
 *  - It does not run Chrome, so it cannot prove Chrome files or withholds an
 *    issue. `blinkIssue()` below is a transcription of the Chromium source, and
 *    a transcription of a moving target can go stale; what the tests really
 *    assert is that the shipped code never reaches the state that source
 *    flags, for any observer that looks after each mutation.
 *  - It does not prove the detached swap is invisible to a user. Whether focus,
 *    caret position, scroll anchoring and CSS transitions all survive
 *    removeChild/insertBefore in one synchronous block is a browser question.
 *    Only the focus hand-off is checked here, and only against the stand-in DOM.
 *  - It does not prove the tool actually registers. `e2e/browser.mjs` does that.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_LIMITS } from '../../public/tools.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/**
 * Read a shipped file with one kind of line ending.
 *
 * This suite matches shapes in the source - `const offered = ...;` followed by a
 * newline, and a brace-matched function body - so a CRLF checkout broke every
 * one of those patterns and the whole file went red. It passed here and failed
 * from `git archive`, which is the same commit: measured at 0 carriage returns
 * in the working tree and 1242 in the archive.
 *
 * A test that depends on how the caller checked the repository out is not
 * testing the product, and on Windows with the default autocrlf it would have
 * failed for anyone cloning fresh.
 */
const source = (relative) => readFileSync(path.join(ROOT, relative), 'utf8')
  .split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));

const INDEX_HTML = source('public/index.html');
const OPERATOR_HTML = source('public/operator.html');
const APP_JS = source('public/app.js');

/* ------------------------------------------------------------------ *
 * Reading the markup. Regex rather than a parser, matching the house
 * style in dom-contract.uat.test.mjs: the repo has no dependencies and
 * "does this attribute exist on this tag" needs no tree.
 * ------------------------------------------------------------------ */

/** `data-tool-name` must not answer a question about `toolname`, hence the boundary. */
function attributeOf(tag, name) {
  const quoted = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  if (quoted) return quoted[1];
  // A valueless attribute is present with the empty string, which is how the
  // browser sees `<form toolname>`. Absent is null, and the two differ.
  if (new RegExp(`(?:^|\\s)${name}(?=[\\s>])`, 'i').test(tag)) return '';
  return null;
}

const formTags = (html) => html.match(/<form\b[^>]*>/gis) ?? [];

/**
 * Forms carrying exactly one of the pair. Neither is fine - that is a plain
 * form. Both is fine - that is a tool. One is the defect.
 */
function halfDeclaredForms(html) {
  return formTags(html)
    .filter((tag) => (attributeOf(tag, 'toolname') === null) !== (attributeOf(tag, 'tooldescription') === null))
    .map((tag) => tag.replaceAll(/\s+/g, ' ').slice(0, 90));
}

/**
 * Damage one exact place in a copy of the real source, asserting the count so a
 * mutation that matched nothing cannot "prove" a detector against an undamaged
 * file. Same contract as dom-contract.uat.test.mjs.
 */
function mutate(text, target, replacement) {
  const pattern = new RegExp(target.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const hits = [...text.matchAll(pattern)].length;
  assert.equal(hits, 1, `expected exactly one \`${target}\` to damage, found ${hits}`);
  return text.replace(pattern, () => replacement);
}

/* ------------------------------------------------------------------ *
 * The rule Chrome applies, transcribed.
 * ------------------------------------------------------------------ */

/**
 * From third_party/blink/renderer/core/html/forms/html_form_element.cc.
 *
 * ScheduleDeclarativeWebMCPToolRegistration(), reached synchronously from
 * AttributeChanged(), InsertedInto() and RemovedFrom():
 *
 *   const bool is_valid_mcp_form = isConnected() && name && description;
 *   if (!is_valid_mcp_form && (name || description)) {
 *     ReportInvalidMCPFormIssueIfNeeded(name, description);
 *   }
 *
 * ReportInvalidMCPFormIssueIfNeeded():
 *
 *   if (!isConnected()) return;
 *   if (name.empty()) { ... kFormModelContextMissingToolName ... return; }
 *   CHECK(description.empty());
 *   ... kFormModelContextMissingToolDescription ...
 *
 * A WTF::String from FastGetAttribute is truthy when the attribute EXISTS and
 * empty() when it is absent or "", so presence and emptiness are not the same
 * test and are kept apart here.
 */
function blinkIssue(form) {
  const name = form.getAttribute('toolname');
  const description = form.getAttribute('tooldescription');
  const present = (value) => value !== null;
  if (form.isConnected && present(name) && present(description)) return null;
  if (!present(name) && !present(description)) return null;
  if (!form.isConnected) return null;
  if (!name) return 'kFormModelContextMissingToolName';
  return 'kFormModelContextMissingToolDescription';
}

/* ------------------------------------------------------------------ *
 * A DOM small enough to read, faithful in the one respect that matters:
 * it looks at the form after EVERY mutation, the way Blink does, instead
 * of after the statement or the task.
 * ------------------------------------------------------------------ */

function createPage() {
  const issues = [];
  let activeElement = null;
  // Set once the form exists. Building the page is not the subject, so nothing
  // is recorded until there is a form to record about.
  let watched = null;

  const observe = (node) => {
    if (node !== watched) return;
    const issue = blinkIssue(watched);
    if (issue) issues.push(issue);
  };

  const makeNode = (tagName) => {
    const node = {
      tagName,
      attributes: new Map(),
      childNodes: [],
      parentNode: null,
      get isConnected() {
        let cursor = node;
        while (cursor.parentNode) cursor = cursor.parentNode;
        return cursor === document;
      },
      get nextSibling() {
        const siblings = node.parentNode?.childNodes ?? [];
        return siblings[siblings.indexOf(node) + 1] ?? null;
      },
      getAttribute: (key) => (node.attributes.has(key) ? node.attributes.get(key) : null),
      hasAttribute: (key) => node.attributes.has(key),
      setAttribute(key, value) {
        const next = String(value);
        if (node.attributes.get(key) === next) return; // Blink: old_value != new_value
        node.attributes.set(key, next);
        observe(node);
      },
      removeAttribute(key) {
        if (!node.attributes.delete(key)) return;
        observe(node);
      },
      contains(other) {
        let cursor = other;
        while (cursor) {
          if (cursor === node) return true;
          cursor = cursor.parentNode;
        }
        return false;
      },
      append(child) {
        child.parentNode = node;
        node.childNodes.push(child);
        observe(child);
        return child;
      },
      removeChild(child) {
        const at = node.childNodes.indexOf(child);
        assert.notEqual(at, -1, 'removeChild was given a node that is not a child');
        node.childNodes.splice(at, 1);
        child.parentNode = null;
        observe(child);
        return child;
      },
      insertBefore(child, reference) {
        const at = reference === null ? node.childNodes.length : node.childNodes.indexOf(reference);
        assert.notEqual(at, -1, 'insertBefore was given a reference node that is not a child');
        node.childNodes.splice(at, 0, child);
        child.parentNode = node;
        observe(child);
        return child;
      },
      focus() {
        activeElement = node;
      },
    };
    return node;
  };

  const document = makeNode('#document');
  Object.defineProperty(document, 'activeElement', { get: () => activeElement });

  const grid = document.append(makeNode('div'));
  const before = grid.append(makeNode('p'));
  const form = grid.append(makeNode('form'));
  const after = grid.append(makeNode('section'));
  const input = form.append(makeNode('input'));
  watched = form;

  return { document, grid, form, before, after, input, issues };
}

/**
 * Run a function written for the browser against that DOM. The function is the
 * real one, lifted out of the shipped file rather than restated here, so this
 * cannot pass against source that no longer says what the test assumes.
 */
function runInPage(functionSource, page) {
  const context = vm.createContext({ document: page.document });
  vm.runInContext(`${functionSource}\nglobalThis.entry = ${functionName(functionSource)};`, context);
  return context.entry;
}

function functionName(functionSource) {
  const match = /^function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(functionSource);
  assert.ok(match, 'expected a named function declaration');
  return match[1];
}

/** The whole text of one top-level `function name(...) { ... }` in a file. */
function extractFunction(js, name) {
  const start = js.indexOf(`\nfunction ${name}(`);
  assert.notEqual(start, -1, `public/app.js should declare a top-level function ${name}`);
  const open = js.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < js.length; index += 1) {
    if (js[index] === '{') depth += 1;
    else if (js[index] === '}') {
      depth -= 1;
      if (depth === 0) return js.slice(start + 1, index + 1);
    }
  }
  assert.fail(`function ${name} in public/app.js has unbalanced braces`);
}

/** The nearest top-level `function name(` at or before an offset. */
function enclosingFunction(js, offset) {
  const before = js.slice(0, offset);
  const matches = [...before.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)];
  return matches.length ? matches[matches.length - 1][1] : '(top level)';
}

describe('the shipped markup is a whole declarative tool or none at all', () => {
  test('no form carries a tool name without a description, or the reverse', () => {
    for (const [name, html] of [['public/index.html', INDEX_HTML], ['public/operator.html', OPERATOR_HTML]]) {
      assert.deepEqual(
        halfDeclaredForms(html),
        [],
        `${name} ships a form Chrome will report as a half-declared tool`,
      );
    }
  });

  test('that check can actually see a half-declared form', () => {
    // The assertion above is shaped "this list is empty", which is also what a
    // detector reports once it has stopped working. Both halves of the defect
    // are shown to it, on the real file.
    const nameOnly = mutate(INDEX_HTML, 'data-tool-name="set_access_requirements"', 'toolname="set_access_requirements"');
    assert.equal(halfDeclaredForms(nameOnly).length, 1, 'a name without a description should be found');

    const descriptionOnly = mutate(INDEX_HTML, 'data-tool-description="Update', 'tooldescription="Update');
    assert.equal(halfDeclaredForms(descriptionOnly).length, 1, 'a description without a name should be found');

    // And a complete pair is not a finding, so the detector is not simply
    // counting tool attributes.
    const whole = halfDeclaredForms(mutate(nameOnly, 'data-tool-description="Update', 'tooldescription="Update'));
    assert.deepEqual(whole, [], 'a form carrying both attributes is a tool, not a defect');
  });

  test('the definition the page publishes is complete and inside the authoring limits', () => {
    const tag = formTags(INDEX_HTML).find((candidate) => candidate.includes('id="requirements-form"'));
    assert.ok(tag, 'public/index.html should still contain the requirements form');

    const name = attributeOf(tag, 'data-tool-name');
    const description = attributeOf(tag, 'data-tool-description');

    assert.ok(name, 'the form carries no tool name for app.js to publish');
    assert.match(name, /^[a-z][a-z0-9_]*$/, 'a tool name should read like the imperative ones');
    assert.ok(name.length <= TOOL_LIMITS.nameChars, `${name.length} characters, limit ${TOOL_LIMITS.nameChars}`);

    // The same floor evals/contract.mjs holds every imperative tool to. A
    // description an agent cannot act on is a description in name only, and the
    // declarative tool was never subject to that gate because it is markup.
    assert.ok(description, 'the form carries no tool description for app.js to publish');
    assert.ok(description.trim().length >= 40, `${description.trim().length} characters; say what it does and when to use it`);
    assert.ok(
      description.length <= TOOL_LIMITS.descriptionChars,
      `${description.length} characters, limit ${TOOL_LIMITS.descriptionChars}`,
    );
  });

  test('every parameter that claims a description has one, within the limit', () => {
    const problems = [];
    let seen = 0;
    for (const [file, html] of [['public/index.html', INDEX_HTML], ['public/operator.html', OPERATOR_HTML]]) {
      for (const match of html.matchAll(/toolparamdescription\s*=\s*"([^"]*)"/g)) {
        seen += 1;
        const value = match[1].trim();
        if (!value) problems.push(`${file}: an empty toolparamdescription`);
        else if (value.length > TOOL_LIMITS.parameterDescriptionChars) {
          problems.push(`${file}: ${value.length} characters, limit ${TOOL_LIMITS.parameterDescriptionChars}`);
        }
      }
      // A valueless `toolparamdescription` is present and empty, which reads to
      // an agent as a parameter nobody described.
      for (const match of html.matchAll(/\stoolparamdescription(?=[\s/>])/g)) {
        problems.push(`${file}: a valueless toolparamdescription at index ${match.index}`);
      }
    }
    assert.ok(seen >= 6, `expected the form's parameters to be described, found ${seen}`);
    assert.deepEqual(problems, [], problems.join('; '));
  });
});

describe('app.js can never publish half a declarative tool', () => {
  test('both attributes are written in one place, in both directions', () => {
    const writes = [...APP_JS.matchAll(/\.(set|remove)Attribute\(\s*'(toolname|tooldescription)'/g)]
      .map((match) => ({
        verb: match[1],
        attribute: match[2],
        where: enclosingFunction(APP_JS, match.index),
      }));

    assert.ok(writes.length > 0, 'app.js no longer writes either attribute; this test is measuring nothing');

    const places = [...new Set(writes.map((write) => write.where))];
    assert.equal(
      places.length,
      1,
      `the pair is written from ${places.length} places (${places.join(', ')}), so keeping them together is a convention rather than a structure`,
    );

    // Same verb, same count, both attributes: a helper that sets one and
    // removes the other would satisfy "one place" and still be wrong.
    for (const verb of ['set', 'remove']) {
      const names = writes.filter((write) => write.verb === verb && write.attribute === 'toolname').length;
      const descriptions = writes.filter((write) => write.verb === verb && write.attribute === 'tooldescription').length;
      assert.equal(names, 1, `expected exactly one ${verb}Attribute('toolname'), found ${names}`);
      assert.equal(descriptions, 1, `expected exactly one ${verb}Attribute('tooldescription'), found ${descriptions}`);
    }
  });

  test('offering the tool never leaves the form half declared', () => {
    const page = createPage();
    const apply = runInPage(extractFunction(APP_JS, 'setDeclarativeToolAttributes'), page);

    apply(page.form, { name: 'set_access_requirements', description: 'What the tool does.' });

    assert.deepEqual(page.issues, [], `Chrome would report: ${page.issues.join(', ')}`);
    assert.equal(page.form.getAttribute('toolname'), 'set_access_requirements');
    assert.equal(page.form.getAttribute('tooldescription'), 'What the tool does.');
    assert.equal(page.form.isConnected, true, 'the form must be back in the document');
    assert.deepEqual(
      page.grid.childNodes,
      [page.before, page.form, page.after],
      'the form must return to the position it left',
    );
  });

  test('withdrawing the tool never leaves the form half declared', () => {
    const page = createPage();
    const apply = runInPage(extractFunction(APP_JS, 'setDeclarativeToolAttributes'), page);

    apply(page.form, { name: 'set_access_requirements', description: 'What the tool does.' });
    page.issues.length = 0;
    apply(page.form, null);

    assert.deepEqual(page.issues, [], `Chrome would report: ${page.issues.join(', ')}`);
    assert.equal(page.form.hasAttribute('toolname'), false);
    assert.equal(page.form.hasAttribute('tooldescription'), false);
    assert.equal(page.form.isConnected, true, 'the form must be back in the document');
    assert.deepEqual(page.grid.childNodes, [page.before, page.form, page.after]);
  });

  test('a visitor typing in the form keeps the focus the swap takes away', () => {
    // The cost of moving the form out of the document and back. Anything inside
    // it that had focus loses it, and a phase change can arrive from a poll
    // while somebody is filling the width field.
    const page = createPage();
    const apply = runInPage(extractFunction(APP_JS, 'setDeclarativeToolAttributes'), page);

    page.input.focus();
    apply(page.form, { name: 'set_access_requirements', description: 'What the tool does.' });

    assert.equal(page.document.activeElement, page.input, 'focus inside the form was not carried across the swap');
  });

  test('the same harness reports the defect the live page was filed for', () => {
    // Without this the four tests above pass just as happily against a harness
    // that never looks. This is the code as it shipped: two setAttribute calls,
    // form connected throughout.
    const page = createPage();
    const naive = [
      "function naive(form, tool) {",
      "  if (tool) {",
      "    form.setAttribute('toolname', tool.name);",
      "    form.setAttribute('tooldescription', tool.description);",
      "  } else {",
      "    form.removeAttribute('toolname');",
      "    form.removeAttribute('tooldescription');",
      "  }",
      "}",
    ].join('\n');
    const apply = runInPage(naive, page);

    apply(page.form, { name: 'set_access_requirements', description: 'What the tool does.' });
    assert.deepEqual(
      page.issues,
      ['kFormModelContextMissingToolDescription'],
      'the harness no longer detects a name set before its description',
    );

    page.issues.length = 0;
    apply(page.form, null);
    assert.deepEqual(
      page.issues,
      ['kFormModelContextMissingToolName'],
      'the harness no longer detects a description outliving its name',
    );
  });

  test('an incomplete definition in the markup is never offered at all', () => {
    // The pair can only travel together if there is a pair. Renaming or dropping
    // `data-tool-description` used to publish the string "undefined" as the
    // description of a live tool.
    const gate = /const declarativeToolDefined = ([^;]+);/.exec(APP_JS);
    assert.ok(gate, 'app.js should decide once whether the markup defines a whole tool');
    assert.match(gate[1], /declarativeTool\.name/, 'the name is half of the definition');
    assert.match(gate[1], /declarativeTool\.description/, 'the description is the other half');

    const offered = /const offered = ([\s\S]*?);\n/.exec(APP_JS);
    assert.ok(offered, 'syncDeclarativeTool should still decide whether to offer the tool');
    assert.match(
      offered[1],
      /declarativeToolDefined/,
      'the tool can be offered without a complete definition behind it',
    );
  });
});
