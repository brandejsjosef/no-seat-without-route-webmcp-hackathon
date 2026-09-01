/**
 * The README is judge-facing: it tells someone which button to press and what
 * they will see. A rename in the interface that never reaches the walkthrough
 * sends a judge looking for a control that does not exist, and nothing else in
 * the suite would notice. These checks read the documents against the source.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('every control the walkthrough names exists in the interface', async () => {
  const [readme, html, app] = await Promise.all([
    read('README.md'),
    read('public/index.html'),
    read('public/app.js'),
  ]);

  const start = readme.indexOf('## Try it in 90 seconds');
  assert.ok(start > 0, 'the walkthrough section should exist');
  const walkthrough = readme.slice(start, readme.indexOf('\n## ', start + 10));

  // Only what the walkthrough actually instructs the reader to press. Bold is
  // used for headings too, and a heading is not a control.
  const quoted = [...walkthrough.matchAll(/[Pp]ress \*\*([^*]+)\*\*/g)]
    .map((match) => match[1].trim());
  assert.ok(quoted.length >= 2, 'the walkthrough should name at least two controls');

  const interfaceText = `${html}\n${app}`;
  for (const label of quoted) {
    assert.ok(
      interfaceText.includes(label),
      `the walkthrough tells a judge to press "${label}", which appears nowhere in the interface`,
    );
  }
});

test('the documents do not promise a requirement the app dropped', async () => {
  const [readme, html, tools] = await Promise.all([
    read('README.md'),
    read('public/index.html'),
    read('public/tools.mjs'),
  ]);
  // noTransfer was demanded of every caller and read by no rule, so it was
  // removed. Nothing user-facing may still ask for it.
  assert.equal(tools.includes('noTransfer'), false, 'the schema should not carry noTransfer');
  for (const [name, text] of [['README.md', readme], ['index.html', html]]) {
    assert.equal(
      /cannot transfer|noTransfer/i.test(text),
      false,
      `${name} still asks for a requirement the app no longer accepts`,
    );
  }
});

test('the regulation is cited under the part that actually applies', async () => {
  const readme = await read('README.md');
  // 28 CFR 35.138 is ADA Title II and covers public entities; a commercial
  // venue falls under Title III at 36.302(f). Citing only the first was wrong.
  if (readme.includes('35.138')) {
    assert.ok(
      readme.includes('36.302'),
      'citing 35.138 alone implies every venue is a public entity; name 36.302(f) too',
    );
  }
});

test('every suite is accounted for and the documented Node total is plausible', async () => {
  // This guard has now failed for two different reasons, and the second one
  // changed what it can honestly promise.
  //
  // First it went stale because the list of suites was typed out here by hand,
  // so adding test/uat/ left it counting six files while the runner ran sixteen.
  // The files are discovered now.
  //
  // Then the exact-equality check itself stopped being possible. It counted
  // `^test(` registrations and compared them to the documented figure, which
  // worked only while every test was a top-level literal call. The UAT suites
  // group with describe() and generate cases in loops - test/uat/phases has 13
  // literal registrations and runs 76 cases - so no static count can equal what
  // the runner reports. That is the same reason the browser figure has always
  // been a dated measurement rather than a computed one.
  //
  // So this asserts the two things that are still checkable, and the matrix
  // dates the Node figure the way it already dates the browser one:
  //   1. every .test.mjs under test/ is discovered, so a whole suite cannot be
  //      added or deleted without this test noticing;
  //   2. the documented total is not below the static lower bound, which catches
  //      a number left behind by a large addition.
  // What it cannot catch is a documented total that is too high. Only a real run
  // can, which is why the matrix says when it was measured.
  const suiteFiles = [];
  const walk = async (dir) => {
    for (const entry of await readdir(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(`${dir}/${entry.name}`);
      else if (entry.name.endsWith('.test.mjs')) suiteFiles.push(`${dir}/${entry.name}`);
    }
  };
  await walk('test');

  const matrix = await read('QA_TEST_MATRIX.md');
  const sources = await Promise.all(suiteFiles.map((name) => read(name)));
  const lowerBound = sources.reduce((total, source) => total + (source.match(/^\s*test\(/gm) ?? []).length, 0);

  // Every discovered suite must be named in the matrix, so a new file cannot be
  // added without a human writing down what it covers.
  const undocumented = suiteFiles.filter((name) => !matrix.includes(name));
  assert.deepEqual(undocumented, [], `these suites run but appear nowhere in the matrix: ${undocumented.join(', ')}`);

  const claimed = matrix.match(/\*\*(\d+)\/(\d+) Node tests\*\*/);
  assert.ok(claimed, 'the matrix should state a Node test result');
  assert.equal(claimed[1], claimed[2], 'a documented result should be all of them passing');
  assert.ok(
    Number(claimed[2]) >= lowerBound,
    `the matrix claims ${claimed[2]} Node tests but ${lowerBound} registrations are visible in ${suiteFiles.length} files, so the documented figure is stale`,
  );
  assert.ok(
    /Node tests\*\* and \*\*\d+\/\d+ Chrome checks\*\*/.test(matrix),
    'both measured totals should be stated together',
  );
});

test('the run record does not claim to prove the checkout or the backend', async () => {
  // The guard beside this record checks a hex token's shape. It never consults
  // git, so a fabricated sha passes it - which was measured. That is acceptable
  // only while the record does not pretend to be proof, so the pretence is what
  // is forbidden here.
  //
  // A file cannot carry the hash of the commit it is part of, so the honest
  // framing is a dated measurement plus a release report outside the commit.
  const matrix = await read('QA_TEST_MATRIX.md');

  const overclaims = [
    /proves? (?:the )?(?:current )?(?:checkout|backend|deployment)/i,
    /cryptographic(?:ally)? (?:proof|proves|verified)(?! that)/i,
    /guarantees? (?:the )?(?:running|deployed) (?:checkout|build|backend)/i,
    /this file proves/i,
  ];
  const offenders = [];
  matrix.split('\n').forEach((line, index) => {
    // No denial heuristic. The first version skipped any line containing a
    // negation, so the heading "What this record is, and what it is not."
    // silenced a claim injected into the same line - which is exactly how the
    // mutation written for this test survived the whole gate. Splitting into
    // sentences did not help either, because the bold marker glues them.
    //
    // The patterns are narrow enough instead: measured against the real
    // document they match nothing, and against the mutated one they match twice.
    for (const pattern of overclaims) {
      if (pattern.test(line)) offenders.push(`QA_TEST_MATRIX.md:${index + 1}`);
    }
  });
  assert.deepEqual(overclaims.length > 0 ? offenders : ['no patterns'], [],
    `the run record claims to prove something it cannot: ${offenders.join(', ')}`);

  // And it must keep saying what it is, so the disclaimer cannot be quietly cut.
  assert.match(
    matrix,
    /not cryptographic proof/i,
    'the run record no longer says that it is a dated measurement rather than proof',
  );
  assert.match(
    matrix,
    /frontend hashes prove those four files/i,
    'the record no longer states the limit of the deployment evidence',
  );
});

test('the documented Edge surface agrees with the tools the page really registers', async () => {
  // Changing "seven tools ... 5 read - 2 write" to nine and 7:5 survived the
  // whole gate: the README table for the page states was checked against the
  // declarations, and this sentence about Edge was not checked against
  // anything. A dated observation is still a claim about a measurable thing.
  const [readme, { createVisitorTools, toolsForPhase, toolCounts }] = await Promise.all([
    read('README.md'),
    import('../public/tools.mjs'),
  ]);
  const declared = createVisitorTools({ api: async () => ({}), refresh: async () => ({}) });
  const registered = toolsForPhase(declared, 'READY');
  const { read: reads, write } = toolCounts(registered);
  // The declarative form tool lives in the HTML and counts as one more write.
  const total = registered.length + 1;
  const writes = write + 1;

  const sentence = readme.match(/registers the same (\w+) tools, reports the same \*\*(\d+) read · (\d+) write\*\*/);
  assert.ok(sentence, 'the README no longer states the Edge surface in the shape this check reads');

  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  assert.equal(sentence[1], WORDS[total], `the README says ${sentence[1]} tools; READY registers ${total}`);
  assert.equal(Number(sentence[2]), reads, `the README says ${sentence[2]} read; READY has ${reads}`);
  assert.equal(Number(sentence[3]), writes, `the README says ${sentence[3]} write; READY has ${writes}`);
});

test('the run record is dated, names the build it measured, and agrees with itself', async () => {
  // The header said "Last full run: 30 August 2026" while reporting a total
  // that two commits authored on 31 August had each bumped by one. Both
  // commits edited the total and neither touched the date, because nothing
  // read it. A date with no build beside it is worse than no date: it reads as
  // covering whatever happens to be checked out.
  //
  // Everything here is a string check on the header, so it costs nothing and
  // needs no git, which a deployed build's checkout may not have.
  const matrix = await read('QA_TEST_MATRIX.md');
  const header = matrix.slice(0, matrix.indexOf('\n## '));

  const record = header.match(/Last full run: (\d{1,2} \w+ \d{4})[^\n]*/);
  assert.ok(record, 'the header must open with `Last full run: <d Month yyyy>`');

  // One build, named everywhere the header states a result. Updating the
  // record and forgetting the summary - or the reverse - leaves two.
  const commits = [...new Set([...header.matchAll(/`([0-9a-f]{7,40})`/g)].map((match) => match[1]))];
  assert.equal(
    commits.length,
    1,
    `the header must name exactly one measured build; found: ${commits.join(', ') || 'none'}`,
  );

  // A recorded result is a full pass or it is not a result.
  const figures = [...header.matchAll(/\*\*(\d+)\/(\d+)/g)];
  assert.ok(figures.length >= 3, 'the header should state a Node and a Chrome result');
  for (const [text, ran, total] of figures) {
    assert.equal(ran, total, `${text} in the header is not a full pass`);
  }

  // The number in the run record and the number in the summary are the same
  // measurement written twice. This is the drift that actually happened.
  const summary = header.match(/\*\*(\d+)\/\d+ Node tests\*\*/);
  assert.ok(summary, 'the header should summarise the Node result');
  const inRecord = [...header.matchAll(/`npm run verify`[^\n]*?\*\*(\d+)\/\d+\*\*/g)]
    .map((match) => match[1]);
  assert.deepEqual(
    [...new Set(inRecord)],
    [summary[1]],
    `the run record reports ${inRecord.join(', ') || 'no'} passing Node tests for `
    + `\`npm run verify\` but the summary above reports ${summary[1]}`,
  );
});

const claimPhaseOnce = (seen, phase) => {
  if (seen.has(phase)) return false;
  seen.add(phase);
  return true;
};

test('the README tool matrix matches the tools the page really registers', async () => {
  // This table is the first thing a judge reads about WebMCP leverage, and its
  // numbers are derivable, so nothing here is typed by hand for long. The counts
  // come from the same availableIn declarations the page registers from.
  const [readme, tools, contract] = await Promise.all([
    read('README.md'),
    import('../public/tools.mjs'),
    import('../evals/contract.mjs'),
  ]);
  const stub = {
    api: async () => ({ evaluation: { options: [], feasibleCount: 0, venueRevision: 1 }, state: { resources: {} } }),
    refresh: async () => ({ phase: 'READY', resourceVersion: 1, resources: {}, atomicity: { reservedResourceCount: 0 } }),
  };
  const live = new Map(
    contract.phaseMatrix(tools.createVisitorTools(stub)).map((row) => [row.phase, row]),
  );

  const compared = new Set();
  for (const line of readme.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    const phase = cells[1].split('`')[1];
    const row = live.get(phase);
    if (!row) continue;
    // The ChatGPT desktop row is a measurement of a host that has no declarative
    // form tool, not something these declarations can produce.
    if (cells[1].includes('ChatGPT desktop')) continue;
    assert.equal(
      claimPhaseOnce(compared, phase),
      true,
      `${phase} appears more than once in the generated-state portion of the README matrix`,
    );
    const declarative = phase === 'READY' ? 1 : 0;
    assert.equal(Number(cells[2].replaceAll('*', '')), row.read, `${phase} read count`);
    assert.equal(Number(cells[3].replaceAll('*', '')), row.write + declarative, `${phase} write count`);
  }
  // A documentation test that silently matches nothing is worse than no test:
  // it reports success for a table it never read.
  assert.deepEqual(
    [...compared].sort(),
    [...live.keys()].sort(),
    `README phases ${[...compared].join(', ')} do not equal the ${live.size} generated page states`,
  );
});

test('the README matrix guard rejects a duplicate phase instead of mistaking it for coverage', () => {
  const seen = new Set();
  assert.equal(claimPhaseOnce(seen, 'PLAN_READY'), true);
  assert.equal(claimPhaseOnce(seen, 'PLAN_READY'), false);
  assert.deepEqual([...seen], ['PLAN_READY']);
});

test('no spawned test server inherits an environment variable the host sets', async () => {
  // This has now cost two deploys, for two different variables, in the same way.
  //
  // First PORT. server.mjs lets it win over NSWR_PORT because a managed host sets
  // it and production must honour that; the same precedence silently redirects a
  // spawned test server wherever PORT already points, which is every build on
  // Render. One spawn omitted the deletion and the deploy failed twice with
  // "Test server did not start" while every local run was green.
  //
  // Then NSWR_TRUST_CF_CONNECTING_IP. It is set on the Render service, the build
  // runs in that environment, and a spawned server inherited it and began
  // trusting forwarded headers - so a test asserting that untrusted headers are
  // ignored failed only in the one environment nobody runs locally. The fix for
  // PORT had been applied to PORT alone rather than to the class.
  //
  // So the check is now the class: every variable the deployment sets that
  // server.mjs reads must be cleared before a spawn, in every suite that spawns,
  // discovered rather than listed. A scenario that wants one of them ON sets it
  // explicitly after the reset.
  const MANAGED = ['PORT', 'NSWR_TRUST_PROXY', 'NSWR_TRUST_CF_CONNECTING_IP'];

  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(`${dir}/${entry.name}`);
      else if (entry.name.endsWith('.test.mjs')) files.push(`${dir}/${entry.name}`);
    }
  };
  await walk('test');

  // This used to count `delete env.X` occurrences against direct server spawns,
  // file by file. That was the best available check while every
  // suite carried its own launcher, and it was still only a count of source
  // text: it could not tell a deletion that runs from one inside a branch that
  // never executes, and it silently reported zero for a whole file when its
  // pattern was built with an escape that turned into a control character.
  //
  // There is one launcher now. So the check splits in two: nothing outside it
  // may spawn a server (here), and the reset itself is proved by running it
  // (test/helpers/test-server.self.test.mjs, "Render-style variables are removed
  // unless a scenario asks for them", which sets all three in the real
  // environment and reads back what the child would get).
  const HELPER = 'test/helpers/test-server.mjs';
  const offenders = [];
  for (const name of [...files, 'e2e/browser.mjs']) {
    if (name === HELPER) continue;
    const source = await read(name);
    // Built from pieces so this file does not match its own search and report
    // itself, which is exactly what the first version did.
    const needle = ['spawn(process', 'execPath'].join('.');
    const spawns = source.split(needle).length - 1;
    if (spawns > 0) offenders.push(`${name} (${spawns})`);
  }
  assert.deepEqual(
    offenders,
    [],
    'these spawn a server outside the shared helper, so they build their own child environment: '
    + offenders.join(', '),
  );

  // And the helper really does name every managed variable, so the self-test
  // above is exercising all three rather than a subset someone trimmed.
  const helper = await read(HELPER);
  const unhandled = MANAGED.filter((variable) => !helper.includes(`delete env.${variable};`));
  assert.deepEqual(unhandled, [], `the shared helper does not clear: ${unhandled.join(', ')}`);
});

test('no public artifact claims the reader approved the booking', async () => {
  // The receipt used to tell whoever was looking at the page that they had
  // approved the booking. A second visitor holding the same ?demo= link can
  // confirm a plan the first one prepared, and an HTTP client holding a session
  // token can do it without a page at all, so the claim was not the server's to
  // make. The phrase is banned outright rather than merely hidden from the
  // rendered UI, because /app.js is served to the public exactly as written.
  const banned = [/you approved it/i, /a person on this venue link confirmed it/i];
  for (const name of ['public/app.js', 'public/index.html', 'README.md']) {
    const source = await read(name);
    for (const pattern of banned) {
      assert.equal(
        pattern.test(source),
        false,
        `${name} still contains ${pattern} - it is served verbatim and claims more than the server can prove`,
      );
    }
  }

  // And the replacement really is in place, in both the script and the fallback.
  const app = await read('public/app.js');
  const html = await read('public/index.html');
  const proven = 'confirmation was received from a visitor session on this shared venue';
  assert.ok(app.includes(proven), 'public/app.js lost the provable receipt wording');
  assert.ok(html.includes(proven), 'the static receipt fallback lost the provable wording');
});


/**
 * The Chrome walkthrough table is the one part of the README a judge follows
 * literally, and the paragraph above it promises that every row "is asserted by
 * `npm run test:browser` rather than merely performed by it". The guard that
 * used to stand here required only one distinctive token from a row to appear
 * somewhere in e2e/browser.mjs, so a row edited into a falsehood - "revision
 * 999", "7 partial reservations" - still passed on the strength of its other
 * tokens, and a row too terse to fingerprint needed an escape hatch.
 *
 * This is the contract instead: the exact rows, in order, cell for cell, and
 * for each the exact browser checks that assert it. A row added, removed,
 * reordered or reworded fails here; so does renaming a check it points at.
 * Changing either side means changing this table in the same commit, which is
 * the review the README sentence needs and never had.
 */
const WALKTHROUGH = [
  {
    step: 'Tools Chrome exposes on load',
    result: '6 imperative + `set_access_requirements` from the form',
    checks: [
      'READY registers exactly the declared imperative tools',
      'the declarative form is registered as a tool',
    ],
  },
  {
    step: 'Agent reads venue state',
    result: '`READY`, revision 1, both lifts operational',
    checks: [
      'an untouched venue reads back as READY at revision 1',
      'both lifts are in service before anything is planned',
    ],
  },
  {
    step: 'Agent compares routes for a 90 cm chair',
    result: '1 of 2 usable; the other blocked by `DOORWAY_WIDTH`',
    checks: [
      'one of two routes fits a 90 cm chair',
      'the blocked route names the failing rule',
    ],
  },
  {
    step: 'Declarative tool fills the form',
    result: 'width 72 → 68; call stays open, resolves only when the visitor submits, returning the staged plan; withdrawn once the form can no longer be used',
    checks: [
      'an agent can fill the visible form',
      'the call does not settle until a person submits',
      'submitting hands the result back to the agent',
      'the form tool is withdrawn once a plan exists',
    ],
  },
  {
    step: 'Declarative tool receives `0 / 0`',
    result: 'native validation rejects both fields, the call stops, values reset to 72 / 80, no HTTP request or plan',
    checks: [
      'Chrome reports both invalid zero-valued fields',
      'canceling invalid input restores the safe visible defaults',
      'invalid declarative input neither plans nor calls the server',
      'zero-valued declarative input produced no mutating request at all',
    ],
  },
  {
    step: 'After a plan exists',
    result: '`find_access_bundle` unregistered, `clear_access_plan` registered',
    checks: [
      'the search is withdrawn as soon as a plan exists',
      'a proposed plan: PLAN_READY registers exactly its declared tools',
    ],
  },
  {
    step: 'Any tool that can confirm?',
    result: 'none',
    checks: [
      'nothing that could confirm is registered while awaiting the visitor',
      'a staged plan awaiting the visitor: AWAITING_HUMAN_CONFIRMATION registers exactly its declared tools',
    ],
  },
  {
    step: 'Lift fails during confirmation',
    result: 'refused, `0 partial reservations`',
    checks: [
      'the refusal is shown to the visitor',
      'nothing was partially reserved',
    ],
  },
  {
    step: 'Agent asks why',
    result: '`STALE_RESOURCE_VERSION`, `LIFT_OPERATIONAL`, plan revision 1 against venue revision 2, `garden-lift-route` still valid, `REPLAN`',
    checks: [
      'the agent is told the plan was overtaken, not merely that a rule failed',
      'the agent is told which rule broke',
      'the explanation shows the plan exactly one revision behind the venue',
      'the agent is told which route still works',
      'the agent is told to replan',
    ],
  },
  {
    step: 'Agent replans, visitor confirms',
    result: 'Garden Entrance route booked, revision 3, 0 partial reservations',
    checks: [
      'the replacement route enters by the Garden Entrance',
      'the booking exists after the visitor confirms',
      'the booking commits exactly one revision past the refusal',
      'the booking reports zero partial reservations',
    ],
  },
  {
    step: 'Tools once the booking exists',
    result: 'write tools: **0**',
    checks: [
      'a confirmed booking: CONFIRMED registers exactly its declared tools',
      'a confirmed booking: CONFIRMED reports 4 read · 0 write',
    ],
  },
];

/**
 * Four of the suite's labels are built by one helper, verifySurface(observed,
 * phase, where), and are template literals rather than fixed strings. They are
 * also the only checks that assert a phase's exact registered set, which is
 * what three of the rows above are about, so they are reconstructed here from
 * the helper's literal call sites rather than left unmappable. The templates
 * are quoted verbatim and asserted to still be present: editing one in the
 * suite without editing it here fails, instead of quietly resolving to a label
 * nothing prints.
 */
const SURFACE_TEMPLATES = [
  '${where}: the page is in ${expectedPhase}',
  '${where}: ${expectedPhase} registers exactly its declared tools',
  '${where}: ${expectedPhase} reports ${expected?.read} read · ${expected?.write} write',
  '${where}: the visible chips match the browser registry',
];

test('the Chrome walkthrough table is exactly the contract the browser suite asserts', async () => {
  const [readme, suite, tools] = await Promise.all([
    read('README.md'),
    read('e2e/browser.mjs'),
    import('../public/tools.mjs'),
  ]);

  // The table is read as one contiguous block, not as "every line starting with
  // a pipe", so rows cannot arrive from some later table in the document.
  const start = readme.indexOf('| Step | Result |');
  assert.ok(start > 0, 'the Chrome walkthrough table should exist');
  const rows = [];
  for (const line of readme.slice(start).split('\n').slice(2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.split('|').slice(1, -1).map((cell) => cell.trim()));
  }

  assert.equal(
    rows.length,
    WALKTHROUGH.length,
    `the walkthrough table has ${rows.length} rows; this test holds a contract for ${WALKTHROUGH.length}. `
    + 'A row may only be added or removed together with the browser checks that assert it.',
  );
  for (const [index, expected] of WALKTHROUGH.entries()) {
    const [step, result] = rows[index];
    assert.equal(
      step,
      expected.step,
      `walkthrough row ${index + 1}: the README step reads "${step}", the contract says "${expected.step}"`,
    );
    assert.equal(
      result,
      expected.result,
      `walkthrough row ${index + 1} ("${expected.step}"): the README result reads "${result}", `
      + `but what the browser suite asserts, and what this contract records, is "${expected.result}"`,
    );
  }

  // Every label the suite can print, read from its check() calls. A label this
  // cannot read is reported rather than skipped: an unreadable label is one a
  // row could be mapped to without anything verifying the mapping.
  const invocations = [...suite.matchAll(/(?<!function\s)\bcheck\(/g)].length;
  const literals = [...suite.matchAll(/\bcheck\(\s*'((?:[^'\\]|\\.)*)'/g)]
    .map((match) => match[1].replace(/\\(['\\])/g, '$1'));
  const templated = [...suite.matchAll(/\bcheck\(\s*`/g)].length;
  assert.equal(
    literals.length + templated,
    invocations,
    `e2e/browser.mjs makes ${invocations} check() calls but only ${literals.length + templated} labels `
    + 'could be read from them; a check whose label this cannot read cannot back a walkthrough row',
  );

  for (const template of SURFACE_TEMPLATES) {
    assert.ok(
      suite.includes(`check(\`${template}\``),
      `e2e/browser.mjs no longer contains the surface check \`${template}\`, which walkthrough rows are mapped to`,
    );
  }
  const declared = tools.createVisitorTools({ api: async () => ({}), refresh: async () => ({}) });
  const counts = new Map(tools.PHASES.map((phase) => {
    const { read: reads, write } = tools.toolCounts(tools.toolsForPhase(declared, phase));
    // The declarative form lives in the HTML and READY is the one phase whose
    // form is usable; browser.mjs adds it to that phase's write count the same way.
    return [phase, { read: reads, write: write + (phase === 'READY' ? 1 : 0) }];
  }));

  const labels = new Set(literals);
  const callSites = [...suite.matchAll(/verifySurface\([^,]+,\s*'([A-Z_]+)'\s*,\s*'([^']+)'\s*\)/g)];
  assert.ok(callSites.length > 0, 'e2e/browser.mjs has no verifySurface call site to resolve surface labels from');
  for (const [, phase, where] of callSites) {
    const expected = counts.get(phase);
    assert.ok(expected, `e2e/browser.mjs verifies a surface for "${phase}", which public/tools.mjs does not declare`);
    for (const template of SURFACE_TEMPLATES) {
      labels.add(template
        .replaceAll('${where}', where)
        .replaceAll('${expectedPhase}', phase)
        .replaceAll('${expected?.read}', String(expected.read))
        .replaceAll('${expected?.write}', String(expected.write)));
    }
  }

  // Whole-label membership, never substring: a check name that appears only
  // inside a comment or inside another label does not count as covered.
  for (const row of WALKTHROUGH) {
    assert.ok(row.checks.length > 0, `the contract for the row "${row.step}" names no browser check`);
    for (const label of row.checks) {
      assert.ok(
        labels.has(label),
        `the walkthrough row "${row.step}" is recorded as asserted by the browser check "${label}", `
        + 'which e2e/browser.mjs does not register under that name - it was renamed or removed',
      );
    }
  }
});

test('the manual ChatGPT case does not present itself as an automated gate', async () => {
  // Every other row in the matrix is backed by a suite. This one is a manual
  // run, and the difference stopped being visible once it was written in the
  // same voice as the rest. The marker is what keeps it honest; a future edit
  // that tidies it away would restore exactly the ambiguity it was added for.
  //
  // The date was the other half of the problem, and it was not covered at all.
  // A run recorded as "29 August" sat here while the deployed build moved past
  // it, and nothing went red. The record now has to name the build it was taken
  // against, in the same breath as the date, must not present any later build
  // as covered, and must not name a model the host never exposed. Both
  // documents carry this claim, so both are checked: guarding only the matrix
  // leaves the judge-facing README free to rot back to what it said before.
  const RECORDED_DATE = '30 August 2026';
  const RECORDED_BUILD = 'cf376a1';
  const MONTHS = 'January|February|March|April|May|June|July|August'
    + '|September|October|November|December';
  // A sha other than the measured one may be named only while the sentence is
  // denying that it was covered. "with no console errors" is not such a denial,
  // which is why a bare negation word is not enough to earn the exemption.
  const DENIES_COVERAGE = /no recorded run|have no|nothing here|not (?:been )?(?:tested|run|measured|covered)/i;

  const qualify = (where, section) => {
    assert.ok(
      section.includes(RECORDED_DATE),
      `${where}: the recorded result must carry its measurement date (${RECORDED_DATE})`,
    );
    assert.ok(
      section.includes(RECORDED_BUILD),
      `${where}: the recorded result must name the build it was taken against (${RECORDED_BUILD})`,
    );
    // Split apart, neither half qualifies anything: a date with no build does
    // not say what was running, a build with no date does not say how old the
    // observation is.
    assert.ok(
      section.split(/\n[ \t]*\n/)
        .some((para) => para.includes(RECORDED_DATE) && para.includes(RECORDED_BUILD)),
      `${where}: ${RECORDED_DATE} and ${RECORDED_BUILD} must appear in one paragraph; `
      + 'split up, the date reads as covering whatever happens to be deployed',
    );

    // A second date left standing is how the stale record survived last time.
    const dates = [...new Set(
      [...section.matchAll(new RegExp(`\\b\\d{1,2} (?:${MONTHS}) \\d{4}\\b`, 'g'))]
        .map((match) => match[0]),
    )];
    assert.deepEqual(
      dates,
      [RECORDED_DATE],
      `${where}: expected exactly one measurement date; found: ${dates.join(', ') || 'none'}`,
    );

    // The host exposed a browser, not the thing driving it, so no model may be
    // named as having produced this result.
    const models = [...new Set(
      [...section.matchAll(/\b(?:GPT|Gemini|Llama)[\w.-]*/g)].map((match) => match[0]),
    )];
    assert.deepEqual(
      models,
      [],
      `${where}: names ${models.join(', ')} as driving this run; the host exposed a browser, `
      + 'not whatever was calling the tools',
    );

    assert.ok(
      /\bby hand\b|\bmanual(?:ly)?\b/i.test(section),
      `${where}: must describe itself as a run made by hand, not as a suite result`,
    );

    // Nothing may present a later build as covered.
    const claimed = [];
    for (const sentence of section.split(/(?<=\.)\s+/)) {
      for (const [, sha] of sentence.matchAll(/`([0-9a-f]{7,40})`/g)) {
        if (sha === RECORDED_BUILD) continue;
        if (DENIES_COVERAGE.test(sentence)) continue;
        claimed.push(sha);
      }
    }
    assert.deepEqual(
      claimed,
      [],
      `${where}: presents ${claimed.join(', ')} as covered; a build other than `
      + `${RECORDED_BUILD} may appear only in a sentence denying that it was measured`,
    );
  };

  const [matrix, readme] = await Promise.all([read('QA_TEST_MATRIX.md'), read('README.md')]);

  const matrixStart = matrix.indexOf('## Live ChatGPT desktop case');
  assert.ok(matrixStart > 0, 'the ChatGPT desktop section should exist');
  const section = matrix.slice(matrixStart, matrix.indexOf('\n## ', matrixStart + 10));

  assert.ok(
    /not automated and no gate reproduces it/i.test(section),
    'the ChatGPT desktop case must say plainly that no automated gate reproduces it',
  );
  assert.ok(
    /is a manual run/i.test(section),
    'the ChatGPT desktop case must describe itself as a manual run, not as a suite result',
  );
  assert.ok(
    /Chrome results are not a substitute/i.test(section),
    'the ChatGPT desktop case must say that Chrome does not stand in for that host',
  );
  assert.ok(
    new RegExp('covers `' + RECORDED_BUILD + '` and nothing later', 'i').test(section),
    'the section must scope the measurement to `' + RECORDED_BUILD + '` and nothing later',
  );
  qualify('QA_TEST_MATRIX.md', section);

  // The README repeats the claim to a judge who will never open the matrix.
  const readmeStart = readme.indexOf('The visitor flow was also exercised');
  assert.ok(readmeStart > 0, 'the README should record the ChatGPT desktop run');
  const paragraph = readme.slice(readmeStart, readme.indexOf('\n## ', readmeStart));
  assert.ok(
    /no automated\s+gate reproduces it|no automated gate reproduces it/i.test(paragraph),
    'the README must say the ChatGPT desktop run is not reproduced by any gate',
  );
  qualify('README.md', paragraph);
});

/**
 * Every documented tool count, not one sentence of them.
 *
 * A guard already tied the README's Edge sentence to the real counts, and
 * exactly the sentences it did not cover went stale: the quickstart - the first
 * thing a judge reads - offered "4 read, 2 write" for Chrome when the build
 * registers 5 read, 2 write, and the matrix claimed Edge registers "all six
 * tools ... 4 read - 2 write" while the README three sections away said seven
 * tools and 5 - 2 about the same browser on the same day. Guarding one phrasing
 * taught the documents to drift in the others.
 *
 * A figure is exempt only where the line names the build it was measured on.
 * Those are historical records; rewriting them to match today would be the lie
 * this guard exists to prevent.
 */
const CURRENT_COUNT = /(\d+) read\s*(?:·|,|\/)\s*(\d+) write/g;
const DATED = /`[0-9a-f]{7,40}`|cf376a1/;

function resolveCountPhase(lines, index, phases) {
  // Count prose commonly wraps after its heading. Two preceding lines are
  // enough to include that heading without treating a remote section title as
  // qualification for every figure below it.
  const context = lines.slice(Math.max(0, index - 2), index + 1).join(' ');
  const mentioned = phases.filter((phase) => {
    const escaped = phase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // READY is not a phase mention inside PLAN_READY or REPLAN_READY. A plain
    // substring search made whichever shorter token appeared first in PHASES
    // silently win.
    return new RegExp(`(?<![A-Z0-9_])${escaped}(?![A-Z0-9_])`).test(context);
  });
  if (mentioned.length > 1) return { phase: null, ambiguous: mentioned };
  return { phase: mentioned[0] ?? 'READY', ambiguous: [] };
}

test('every current-build tool count in the documents is the count this build has', async () => {
  const { createVisitorTools, toolsForPhase, toolCounts, PHASES } = await import('../public/tools.mjs');
  const declared = createVisitorTools({ api: async () => ({}), refresh: async () => ({}) });
  // A host with the declarative form exposes one extra write in READY; a host
  // without the SubmitEvent contract does not. Both are honest claims about the
  // same build - but only for the phase the sentence is actually about.
  const allowedFor = (phase) => {
    const { read: reads, write } = toolCounts(toolsForPhase(declared, phase));
    return phase === 'READY' ? [`${reads}/${write + 1}`, `${reads}/${write}`] : [`${reads}/${write}`];
  };

  const offenders = [];
  for (const name of ['README.md', 'QA_TEST_MATRIX.md']) {
    const lines = (await read(name)).split('\n');
    lines.forEach((line, index) => {
      if (DATED.test(line)) return;
      const figures = [...line.matchAll(CURRENT_COUNT)];
      if (figures.length === 0) return;
      const { phase, ambiguous } = resolveCountPhase(lines, index, PHASES);
      if (ambiguous.length > 0) {
        offenders.push(
          `${name}:${index + 1} has an ambiguous phase context (${ambiguous.join(', ')}) for `
          + figures.map(([text]) => `"${text}"`).join(', '),
        );
        return;
      }
      const allowed = allowedFor(phase);
      for (const [text, found, expected] of figures) {
        if (!allowed.includes(`${found}/${expected}`)) {
          offenders.push(`${name}:${index + 1} says "${text}" about ${phase}, which is ${allowed.join(' or ')}`);
        }
      }
    });
  }
  assert.deepEqual(offenders, [], `these state a surface this build does not have: ${offenders.join(' | ')}`);
});

test('that guard recognises a wrong count and lets a dated one through', () => {
  // A guard nothing checks can be emptied without anyone noticing: a mutation
  // that replaced a sibling guard's pattern with one matching nothing survived
  // the entire gate. Held to known examples instead, which is finite and real.
  const matches = (line) => [...line.matchAll(new RegExp(CURRENT_COUNT.source, 'g'))]
    .map(([, found, expected]) => `${found}/${expected}`);

  assert.deepEqual(matches('the badge shows **4 read, 2 write** today'), ['4/2']);
  assert.deepEqual(matches('reports the same **5 read · 2 write**, and completes'), ['5/2']);
  assert.deepEqual(matches('the host reports 4 read / 1 write'), ['4/1']);
  assert.deepEqual(matches('nothing numeric here at all'), []);
  assert.equal(DATED.test('the only figure measured there is `4 read · 1 write`, on build `cf376a1`'), true);
  assert.equal(DATED.test('Chrome 151 with declarative WebMCP support shows **4 read, 2 write**'), false);
});

test('the current-count guard resolves wrapped, exact, and ambiguous phases', async () => {
  const { PHASES } = await import('../public/tools.mjs');

  assert.deepEqual(
    resolveCountPhase([
      'Phase: PLAN_STALE',
      'The surface after an outage',
      'reports 4 read, 1 write',
    ], 2, PHASES),
    { phase: 'PLAN_STALE', ambiguous: [] },
    'a phase two lines above the count must qualify it',
  );

  assert.deepEqual(
    resolveCountPhase(['`PLAN_READY` reports 5 read, 1 write'], 0, PHASES),
    { phase: 'PLAN_READY', ambiguous: [] },
    'READY must not match inside PLAN_READY',
  );

  assert.deepEqual(
    resolveCountPhase(['READY and CONFIRMED report 5 read, 1 write'], 0, PHASES),
    { phase: null, ambiguous: ['READY', 'CONFIRMED'] },
    'a count attributed to multiple phases must be rejected as ambiguous',
  );
});
