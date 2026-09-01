import { readFileSync } from 'node:fs';

const realNow = Date.now.bind(Date);
const offsetFile = process.env.NSWR_FAKE_TIME_OFFSET_FILE;

// `node --test` discovers support modules under test/ as well as `*.test.mjs`.
// In an ordinary run this module must therefore be inert; the one child process
// that opts into the clock supplies the file explicitly in its environment.
if (offsetFile) {
  Date.now = () => {
    const offset = Number(readFileSync(offsetFile, 'utf8').trim() || '0');
    if (!Number.isFinite(offset)) throw new Error('the fake-clock offset is not finite');
    return realNow() + offset;
  };
}
