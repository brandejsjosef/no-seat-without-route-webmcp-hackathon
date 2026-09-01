/**
 * Properties of the gate itself.
 *
 * Everything else in this repository rests on `npm run verify` being both green
 * and meaningful. An independent audit measured it failing 1 run in 6 on
 * unchanged source, and traced it to something worse than flakiness: several
 * suites bind a port written into the file, and the readiness poll accepts a
 * reply from whatever is listening there. If a spawned child dies of EADDRINUSE
 * because a peer process already holds the port, the poll succeeds against the
 * foreign server and every assertion afterwards runs against it.
 *
 * That is a false GREEN, which is the failure mode nothing else here can catch.
 *
 * One suite already fixed this for itself. test/hardening.test.mjs carries a
 * comment naming the exact bug class - two files hard-coding 43921, the runner
 * starting them in parallel, a green result depending on which won the race -
 * and then asks the OS for a free port. The fix was applied to that file and not
 * to the class, which is the same mistake this project has now made with PORT,
 * with the trust variables, and with the operator facility id.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../../${name}`, import.meta.url), 'utf8');

// Built from pieces so this file does not match its own search and report
// itself as a suite that spawns servers. It spawns nothing.
const SPAWN_MARKER = ['spawn(process', 'execPath'].join('.');
const HELPER = 'test/helpers/test-server.mjs';
const HELPER_SOURCE = await read(HELPER);

async function suiteFiles() {
  const files = [];
  const walk = async (dir, accept) => {
    for (const entry of await readdir(new URL(`../../${dir}/`, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(`${dir}/${entry.name}`, accept);
      else if (accept(entry.name)) files.push(`${dir}/${entry.name}`);
    }
  };
  await walk('test', (name) => name.endsWith('.test.mjs'));
  return files;
}

/**
 * Every file that starts a server or a browser, wherever it lives.
 *
 * suiteFiles() only ever matched `*.test.mjs`, so e2e/browser.mjs - the one file
 * that drives real Chrome and real Edge, and the only gate that caught the
 * hardcoded-label defect - sat outside every check in this file. It held four
 * written-in ports while the guard reported all clear.
 */
async function spawningFiles() {
  const files = await suiteFiles();
  await (async function walk(dir) {
    for (const entry of await readdir(new URL(`../../${dir}/`, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(`${dir}/${entry.name}`);
      else if (entry.name.endsWith('.mjs')) files.push(`${dir}/${entry.name}`);
    }
  })('e2e');
  return files;
}

/** Lines that are code rather than prose, so a port quoted in a comment is not a finding. */
function codeLines(source) {
  let inBlock = false;
  return source.split('\n').map((line, index) => {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      return null;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true;
      return null;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return null;
    return { line, number: index + 1 };
  }).filter(Boolean);
}

describe('the gate cannot pass against the wrong server', () => {
  test('no suite binds a port written into the file', async () => {
    // A literal in the 1024-65535 range next to a port-shaped name is a port
    // this file expects to own. Two copies of the repository, or two agents,
    // then contend for it - and the loser does not fail, it inspects the
    // winner's server.
    const files = await suiteFiles();
    assert.ok(files.length > 10, `expected to discover the suites, found ${files.length}`);

    const offenders = [];
    for (const name of files) {
      for (const { line, number } of codeLines(await read(name))) {
        // The first version anchored on a word boundary - \bport\b - so it saw
        // `port = 43917` and was blind to `branchPort = 43929`, which is the
        // name this repository actually used. A mutation restoring that exact
        // line survived the whole gate. Any identifier CONTAINING port, in any
        // case, counts now.
        const match = line.match(/[A-Za-z0-9_$]*[Pp][Oo][Rr][Tt][A-Za-z0-9_$]*\s*[=:]\s*(\d{4,5})\b/)
          ?? line.match(/createClient\(\s*(\d{4,5})\s*\)/);
        if (match && Number(match[1]) >= 1024) offenders.push(`${name}:${number} binds ${match[1]}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'a suite owns a fixed port, so two runs collide and the poll can answer from the other run\'s server: '
      + offenders.join('; '),
    );
  });

  test('no harness outside test/ binds a port written into the file', async () => {
    // The regex the sibling test uses cannot see `const PORT = Number(
    // process.env.X ?? 4199)`, because the literal is not what follows the `=`.
    // A port default is still a port the file expects to own, so this looks for
    // a bindable literal on any line that talks about a port at all.
    const offenders = [];
    for (const name of await spawningFiles()) {
      if (name.startsWith('test/')) continue;
      for (const { line, number } of codeLines(await read(name))) {
        if (!/port/i.test(line)) continue;
        for (const match of line.matchAll(/[0-9]{4,5}/g)) {
          const value = Number(match[0]);
          if (value >= 1024 && value <= 65535) offenders.push(`${name}:${number} defaults to ${value}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `a harness owns a fixed port, so two runs collide: ${offenders.join('; ')}`,
    );
  });

  test('nothing outside the shared helper spawns a server', async () => {
    // The two tests this replaces searched each spawning file for `listen(0` and
    // for a token comparison. That was the best available check while every
    // suite carried its own launcher, and it was still a spelling test: it
    // passed on a guard that referenced an undeclared binding, on one that
    // deleted the token it needed, and - when its own pattern was written with
    // an escape that became a control character - on four written-in ports it
    // was reading directly.
    //
    // One launcher now, so the architecture is what gets asserted here and the
    // behaviour is asserted by running it: test/helpers/test-server.self.test.mjs
    // stands up real impostor servers, kills real children, and requires the
    // readiness check to refuse each one.
    const offenders = [];
    for (const name of [...await spawningFiles(), 'e2e/browser.mjs']) {
      if (name === HELPER) continue;
      const source = await read(name);
      if (source.includes(SPAWN_MARKER)) offenders.push(name);
    }
    assert.deepEqual(
      offenders,
      [...new Set(offenders)].filter(() => false),
      `these spawn a server without the shared helper: ${[...new Set(offenders)].join(', ')}`,
    );
  });

  test('the shared helper asks the operating system for its port and proves ownership', async () => {
    // Properties of the one launcher, so a future edit that removes them is
    // caught here as well as by the self-tests it would also break.
    const helper = await read(HELPER);
    assert.match(helper, /listen\(0/, 'the helper no longer asks the OS for a port');
    assert.match(helper, /instanceToken/, 'the helper no longer carries a per-launch token');
    assert.match(helper, /health\.instanceToken === instanceToken/, 'readiness no longer compares the token');
    assert.match(helper, /health\.service === SERVICE/, 'readiness no longer checks which service answered');
    assert.match(
      helper,
      /child\.exitCode !== null \|\| child\.signalCode !== null/,
      'readiness no longer watches the child it started',
    );
  });

  test('the helper self-tests exist and are registered', async () => {
    // The architecture check above is only as good as the behaviour proof it
    // delegates to. If that file is deleted or emptied, this says so.
    const self = await read('test/helpers/test-server.self.test.mjs');
    const registered = [...self.matchAll(/^\s*test\(/gm)].length;
    assert.ok(registered >= 7, `the helper self-tests registered only ${registered} cases`);
    for (const needle of ['impostor', 'deadChild', 'waitForOwnedServer']) {
      assert.ok(self.includes(needle), `the helper self-tests no longer exercise ${needle}`);
    }
  });

  test('the shutdown wait does not treat the intended exit as a startup failure', () => {
    // The guard used to search each file for `waitUntilGone`, which no longer
    // exists: the shared helper calls it waitForOwnedServerGone. A mutation
    // putting a startup-exit throw back inside it survived the whole gate,
    // because nothing was looking at the function any more.
    //
    // Read the helper's own shutdown body instead, which is where that code now
    // lives and cannot be renamed out of scope.
    const body = HELPER_SOURCE.slice(
      HELPER_SOURCE.indexOf('export async function waitForOwnedServerGone'),
      HELPER_SOURCE.indexOf('export async function startTestServer'),
    );
    assert.ok(body.length > 100, 'the shutdown wait moved; this check no longer reads it');
    assert.doesNotMatch(
      body,
      /exited before startup|exited during startup/,
      'the shutdown wait throws on the very outcome it is waiting for',
    );
    assert.match(body, /child\.kill\(\)/, 'the shutdown wait no longer stops the child it owns');
  });

  test('a wait for a killed server is not treated as a startup failure', async () => {
    // The inverse mistake, and one that was actually made: a blanket insertion
    // put the startup-exit guard inside waitUntilGone(), whose entire purpose is
    // to wait for a child this test has just killed. It would have thrown on the
    // outcome it was waiting for.
    const files = await suiteFiles();
    const offenders = [];
    for (const name of files) {
      // Skipping the guard's own source: this file necessarily contains the
      // words it searches for, and a guard that reports itself is the same
      // self-match that once made the spawn marker useless.
      if (name === 'test/uat/suite-integrity.uat.test.mjs') continue;
      const source = await read(name);
      const at = source.indexOf('waitUntilGone');
      if (at < 0) continue;
      const body = source.slice(at, source.indexOf('\n  }', at));
      if (/exited before startup|exited during startup/.test(body)) {
        offenders.push(`${name} treats the intended exit as a startup failure`);
      }
    }
    assert.deepEqual(offenders, [], offenders.join('; '));
  });
});

describe('a demo control names the facility it will actually act on', () => {
  test('no operator sentence resolves its facility from a literal', async () => {
    // Measured, not reasoned. Freezing one call - facilityLabel(snapshot,
    // facilityId) to facilityLabel(snapshot, 'east-lift') - re-creates the exact
    // defect fixed in 309cbed: all three labels read "East Lift L2" for ever
    // while all three endpoints still follow the selector, so pressing "Take
    // East Lift L2 offline now" takes Garden offline.
    //
    // The Node gate passed that mutation 479/479. Only the browser scenario
    // caught it, with two failures - and `npm run verify`, which is what the
    // deployment actually runs as its build command, does not include the
    // browser suite. A guard that lives only in a gate CI never runs is a guard
    // for whoever remembers to run it.
    //
    // So: every call that resolves a facility name or reaches a facility
    // endpoint must take its id from a variable. A quoted id in that position is
    // the defect, whatever the surrounding code does.
    const source = await read('public/operator.js');
    const frozen = [
      ...source.matchAll(/facilityLabel\(\s*[\w.]+\s*,\s*'([^']+)'\s*\)/g),
      ...source.matchAll(/\/api\/operator\/facilities\/([a-z][a-z-]*)\//g),
    ].map((match) => match[0]);
    assert.deepEqual(
      frozen,
      [],
      `these resolve a facility from a literal instead of the selection: ${frozen.join(' | ')}`,
    );

    // And the default is allowed exactly once, where the selector falls back.
    const defaults = [...source.matchAll(/\?\?\s*'(east-lift|garden-lift)'/g)].map((m) => m[0]);
    assert.equal(
      defaults.length,
      1,
      `expected one selector fallback default, found ${defaults.length}: ${defaults.join(', ')}`,
    );
  });

  test('neither page decides armed state from a hardcoded lift', async () => {
    // The operator page was repaired for this and the visitor page was not.
    // With Garden armed, public/app.js read pendingOutageResourceId against the
    // literal 'east-lift', found no match, and left the fault button enabled -
    // so one click replaced the pending Garden fault with an East one, which is
    // the exact defect just removed from the other page.
    for (const name of ['public/app.js', 'public/operator.js']) {
      const source = await read(name);
      const decisions = [...source.matchAll(/pendingOutageResourceId\s*(?:===|!==)\s*'([^']+)'/g)]
        .map((match) => `${name} compares it with '${match[1]}'`);
      assert.deepEqual(
        decisions,
        [],
        `armed state is decided against a literal facility id: ${decisions.join('; ')}`,
      );
    }
  });
});
