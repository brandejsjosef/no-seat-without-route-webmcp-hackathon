/**
 * Properties of the shipped source files themselves.
 *
 * This exists because of a mistake made six times in one afternoon, always the
 * same way and never visible afterwards. Building a regex inside a template
 * literal turns a lone backslash-b into U+0008, an actual backspace. Every
 * editor renders it as nothing, reading the file back shows what you meant
 * rather than what is there, and the pattern silently matches nothing — so an
 * assertion built on it passes or fails for a reason nobody can see.
 *
 * One of those slipped into a test whose whole purpose was to count something,
 * and it counted zero in a file with two. A counter reading zero and staying
 * quiet is the exact failure the test existed to prevent.
 *
 * These checks are cheap, run with no browser and no server, and would have
 * caught every instance.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../../${name}`, import.meta.url), 'utf8');

/**
 * Every shipped source file, discovered from the repository root.
 *
 * The first version listed five directories, which left `server.mjs` - the
 * single largest thing this project ships - outside a check whose prose said
 * "every script parses". A file that is not walked cannot fail, so the claim
 * beside it was broader than the check underneath it.
 */
async function shippedFiles() {
  const files = [];
  const skip = new Set(['node_modules', 'coverage']);
  const walk = async (dir) => {
    const here = dir === '' ? '../../' : `../../${dir}/`;
    for (const entry of await readdir(new URL(here, import.meta.url), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
      const relative = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(relative);
      else if (/\.(mjs|js|html|css|json|md)$/.test(entry.name)) files.push(relative);
    }
  };
  await walk('');
  return files;
}

describe('the source says what it appears to say', () => {
  test('no file contains an invisible control character', async () => {
    // Tab, newline and carriage return are ordinary whitespace. Everything else
    // below U+0020 is a mistake that hides itself from every reader.
    const ALLOWED = new Set([9, 10, 13]);
    const files = await shippedFiles();
    assert.ok(files.length > 20, `expected to discover the sources, found ${files.length}`);

    const offenders = [];
    for (const name of files) {
      const source = await read(name);
      source.split('\n').forEach((line, index) => {
        for (const character of line) {
          const code = character.codePointAt(0);
          if (code < 32 && !ALLOWED.has(code)) {
            offenders.push(`${name}:${index + 1} contains U+${code.toString(16).padStart(4, '0').toUpperCase()}`);
          }
        }
      });
    }
    assert.deepEqual(offenders, [], `invisible control characters: ${offenders.join('; ')}`);
  });

  test('every source file parses', async () => {
    // A file can be syntactically broken in a way that only shows up when the
    // runner reaches it, which on a 400-test suite is not where you want to
    // find out. npm run check covers five files by name; this covers whatever
    // is actually there.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const files = (await shippedFiles()).filter((name) => name.endsWith('.mjs') || name.endsWith('.js'));
    assert.ok(files.length > 10, `expected to discover the scripts, found ${files.length}`);

    const broken = [];
    for (const name of files) {
      const path = new URL(`../../${name}`, import.meta.url);
      try {
        await run(process.execPath, ['--check', path.pathname.replace(/^\/([A-Za-z]:)/, '$1')]);
      } catch (error) {
        broken.push(`${name}: ${String(error.stderr ?? error.message).split('\n')[0]}`);
      }
    }
    assert.deepEqual(broken, [], `files that do not parse: ${broken.join('; ')}`);
  });

  test('no test file is empty of tests', async () => {
    // A suite that registers nothing is worse than a missing one: it is counted,
    // it is green, and it asserts nothing at all.
    const suites = (await shippedFiles()).filter((name) => name.endsWith('.test.mjs'));
    const empty = [];
    for (const name of suites) {
      const source = await read(name);
      if ((source.match(/^\s*test\(/gm) ?? []).length === 0) empty.push(name);
    }
    assert.deepEqual(empty, [], `test files registering nothing: ${empty.join(', ')}`);
  });
});
