import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createDemoStore, DomainError, REFUSAL_LIMIT } from './lib/domain.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(rootDir, 'public');
const demoStores = new Map();
const demoLastSeen = new Map();
const sessions = new Map();
const instanceToken = process.env.NSWR_INSTANCE_TOKEN ?? null;

// An empty environment variable counts as absent: `??` alone would accept ""
// and Number("") is 0, which would bind an unpredictable port.
const fromEnv = (name) => {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
};

const DEMO_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_DEMOS = 500;
const MAX_SESSIONS_PER_DEMO = REFUSAL_LIMIT;

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/operator', ['operator.html', 'text/html; charset=utf-8']],
  ['/operator.html', ['operator.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/operator.js', ['operator.js', 'text/javascript; charset=utf-8']],
  ['/tools.mjs', ['tools.mjs', 'text/javascript; charset=utf-8']],
  ['/views.mjs', ['views.mjs', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

function securityHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    // WebMCP is only exposed in origin-isolated documents. Sending this
    // explicitly stops a proxy or platform default from silently disabling
    // document.modelContext in production.
    'Origin-Agent-Cluster': '?1',
    // The "tools" policy defaults to self; declaring it keeps that intent
    // visible and survives platforms that inject their own policy header.
    'Permissions-Policy': 'tools=(self), camera=(), microphone=(), geolocation=()',
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, securityHeaders('application/json; charset=utf-8'));
  response.end(JSON.stringify(payload));
}

function sendError(response, error) {
  if (error instanceof DomainError) {
    sendJson(response, error.status, {
      ok: false,
      error: { code: error.code, message: error.message, ...error.details },
    });
    return;
  }
  console.error(error);
  sendJson(response, 500, {
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: 'The demo server could not complete the request.' },
  });
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 32_768) throw new DomainError('BODY_TOO_LARGE', 'Request body exceeds 32 KB.', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DomainError('INVALID_JSON', 'Request body must be valid JSON.', 400);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DomainError('INVALID_JSON', 'Request body must be a JSON object.', 400);
  }
  return parsed;
}

/** decodeURIComponent throws on a malformed escape; that is a bad request. */
function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new DomainError('INVALID_PATH', 'A path segment is not valid percent-encoding.', 400);
  }
}

function assertSameOrigin(request) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
  const origin = request.headers.origin;
  const host = request.headers.host;
  const fetchSite = request.headers['sec-fetch-site'];
  if (!origin || !host) throw new DomainError('ORIGIN_REQUIRED', 'A same-origin request is required.', 403);
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new DomainError('INVALID_ORIGIN', 'The request origin is invalid.', 403);
  }
  if (originHost !== host || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
    throw new DomainError('CROSS_SITE_REQUEST_BLOCKED', 'Cross-site state changes are not allowed.', 403);
  }
}

function sessionFor(request, requiredRole = null) {
  const token = request.headers['x-demo-session'];
  const session = typeof token === 'string' ? sessions.get(token) : null;
  if (!session) throw new DomainError('SESSION_REQUIRED', 'Start a demo session before using the API.', 401);
  const now = Date.now();
  // The TTL is a validity rule, not merely a background-cleanup hint. Checking
  // before lastSeenAt is refreshed prevents a request arriving just after the
  // two-hour boundary from resurrecting its own expired session.
  if (now - (session.lastSeenAt ?? session.createdAt) > SESSION_TTL_MS) {
    demoStores.get(session.demoId)?.releaseSession?.(session.token);
    sessions.delete(token);
    throw new DomainError('SESSION_REQUIRED', 'Start a demo session before using the API.', 401);
  }
  if (requiredRole && session.role !== requiredRole) {
    throw new DomainError('ROLE_FORBIDDEN', `This action requires the ${requiredRole} demo role.`, 403);
  }
  const store = demoStores.get(session.demoId);
  if (!store) throw new DomainError('DEMO_NOT_FOUND', 'The demo session no longer exists.', 404);
  session.lastSeenAt = now;
  demoLastSeen.set(session.demoId, session.lastSeenAt);
  return { session, store };
}

function evictExpiredSessions(now = Date.now()) {
  for (const [token, session] of sessions) {
    if (now - (session.lastSeenAt ?? session.createdAt) > SESSION_TTL_MS || !demoStores.has(session.demoId)) {
      demoStores.get(session.demoId)?.releaseSession?.(session.token);
      sessions.delete(token);
    }
  }
}

/**
 * The invocation path a caller DECLARES, not an identity this server can prove.
 *
 * An authorised HTTP client can send any header it likes, so a match records
 * "this arrived through that tool" and nothing stronger. Proving an actor would
 * need a server-issued, unforgeable, scoped capability; this demo has none and
 * claims none. Anything that is not an exact match for the tool owning the
 * endpoint falls back to the human surface, which is the safe direction.
 *
 * `humanActor` differs by surface: a visitor write comes from the page, an
 * operator write comes from the person running the venue.
 */
function interactionContext(request, expectedToolName, humanActor = 'human-ui') {
  const toolName = request.headers['x-webmcp-tool'];
  if (toolName === expectedToolName) return { actor: 'webmcp-agent', toolName };
  return { actor: humanActor, toolName: null };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SESSION_RATE_LIMIT = 40;
const SESSION_RATE_WINDOW_MS = 60_000;
const sessionRates = new Map();

/**
 * Creating a session mints a demo, and minting demos evicts old ones. Without
 * a limit, a few hundred anonymous requests can evict every venue on the
 * process - including one holding a confirmed booking someone is looking at.
 */
/**
 * Behind a proxy, socket.remoteAddress is the proxy rather than the visitor, so
 * an unkeyed limiter stops being "40 per visitor" and becomes one bucket for the
 * whole site: 41 requests from anywhere would lock everyone else out.
 *
 * The obvious repair - read the first X-Forwarded-For element - is worse than
 * the problem it solves. That element is written by whoever sent the request,
 * so a caller mints a fresh bucket per request and the limit stops existing.
 * Measured against this server with forwarded-header trust enabled: sixty
 * requests from one caller, sixty accepted, none refused.
 *
 * So exactly one header is trusted, and only where the deployment declares that
 * the platform writes it. On a public Render web service Cloudflare sets
 * CF-Connecting-IP and overwrites whatever the caller sent; that overwrite is
 * the whole reason it can serve as an identity. The name is fixed here rather
 * than read from configuration, because a variable holding a header name is one
 * typo away from trusting X-Forwarded-For again.
 *
 * Anything else - absent, empty, a chain, or not an address - falls back to the
 * socket. Behind a proxy that is coarse, but coarse is the safe direction: it
 * groups callers together instead of letting one caller invent identities.
 */
const trustCloudflareClientIp = fromEnv('NSWR_TRUST_CF_CONNECTING_IP') === '1';

function callerKey(request) {
  if (trustCloudflareClientIp) {
    const candidate = request.headers['cf-connecting-ip'];
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      // isIP returns 0 for anything that is not exactly one IPv4 or IPv6
      // address, so '', '   ', 'not-an-ip' and 'a.b.c.d, e.f.g.h' are all
      // rejected by the same check. A repeated header arrives joined by a
      // comma, which fails here too rather than picking one of the values.
      if (isIP(trimmed) !== 0) return trimmed;
    }
  }
  return request.socket?.remoteAddress ?? 'unknown';
}

function assertSessionRate(request) {
  const caller = callerKey(request);
  const now = Date.now();
  const record = sessionRates.get(caller);
  if (!record || now - record.windowStart > SESSION_RATE_WINDOW_MS) {
    sessionRates.set(caller, { windowStart: now, count: 1 });
    if (sessionRates.size > 5_000) {
      for (const [key, value] of sessionRates) {
        if (now - value.windowStart > SESSION_RATE_WINDOW_MS) sessionRates.delete(key);
      }
    }
    return;
  }
  record.count += 1;
  if (record.count > SESSION_RATE_LIMIT) {
    throw new DomainError('TOO_MANY_SESSIONS', 'Too many demo sessions from this address. Wait a minute and retry.', 429);
  }
}

/** Drops the least recently used demos so a public URL cannot grow without bound. */
function evictColdDemos(now = Date.now()) {
  for (const [demoId, lastSeenAt] of demoLastSeen) {
    if (now - lastSeenAt > DEMO_TTL_MS) {
      demoStores.delete(demoId);
      demoLastSeen.delete(demoId);
    }
  }
  // A venue holding a confirmed booking is given up only when nothing else is
  // left to drop: losing one silently is worse than refusing a new demo.
  while (demoStores.size >= MAX_DEMOS) {
    let victim = null;
    let victimAt = Infinity;
    let fallback = null;
    let fallbackAt = Infinity;
    for (const [demoId, lastSeenAt] of demoLastSeen) {
      const booked = demoStores.get(demoId)?.hasBooking?.() ?? false;
      if (!booked && lastSeenAt < victimAt) {
        victimAt = lastSeenAt;
        victim = demoId;
      }
      if (lastSeenAt < fallbackAt) {
        fallbackAt = lastSeenAt;
        fallback = demoId;
      }
    }
    const evicted = victim ?? fallback;
    if (!evicted) break;
    demoStores.delete(evicted);
    demoLastSeen.delete(evicted);
  }
  evictExpiredSessions(now);
}

/**
 * A demo identifier may be supplied by a shared `?demo=` link. A well-formed
 * identifier is honoured even when this process has never seen it, so a link
 * shared between two browsers - or reopened after a restart - still lands both
 * roles on one shared venue instead of silently splitting them apart.
 */
function createSession(role, requestedDemoId) {
  if (!['visitor', 'operator'].includes(role)) {
    throw new DomainError('INVALID_ROLE', 'Demo role must be visitor or operator.', 422);
  }
  let demoId = null;
  if (requestedDemoId !== undefined && requestedDemoId !== null && requestedDemoId !== '') {
    if (typeof requestedDemoId !== 'string' || !UUID_PATTERN.test(requestedDemoId)) {
      throw new DomainError('INVALID_DEMO_ID', 'Demo identifier must be a UUID.', 422);
    }
    demoId = requestedDemoId.toLowerCase();
  }
  if (!demoId) demoId = randomUUID();
  const now = Date.now();
  evictExpiredSessions(now);
  // Whether the venue behind this identifier already existed is reported back.
  // Minting a replacement is right for a shared link, but a caller that named a
  // venue and silently received an empty new one would otherwise have no way to
  // tell a live venue from one this process rebuilt after losing the original.
  const venueExisted = demoStores.has(demoId);
  if (!venueExisted) {
    evictColdDemos(now);
    demoStores.set(demoId, createDemoStore());
  }
  // A venue can remember one refusal per live HTTP session. Refusing a new
  // session at the same bound is honest; silently deleting an older active
  // visitor's explanation to make room was not.
  const liveSessionsForDemo = [...sessions.values()].filter((session) => session.demoId === demoId).length;
  if (liveSessionsForDemo >= MAX_SESSIONS_PER_DEMO) {
    throw new DomainError(
      'TOO_MANY_SESSIONS',
      'This demo already has the maximum number of live sessions. Wait for an inactive session to expire and retry.',
      429,
    );
  }
  demoLastSeen.set(demoId, now);
  const token = randomUUID();
  // The token is stored on the session as well as being its key, because the
  // venue is told which visitor is asking (`sessionKey: session.token`) and a
  // session without one made every caller `undefined` - one shared bucket, and
  // the per-visitor refusal repair silently did nothing over HTTP.
  sessions.set(token, { token, role, demoId, createdAt: now, lastSeenAt: now });
  return { token, demoId, role, venueExisted };
}

async function handleApi(request, response, url) {
  if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/api/health') {
    // HEAD answers exactly as GET does, without a body. The static router was
    // already taught that "HEAD is GET without a body" precisely so an uptime
    // monitor is not told the site is missing - and then /api/health, the one
    // URL a monitor actually probes, was left out of that rule and answered 404.
    const payload = {
      ok: true,
      service: 'no-seat-without-route',
      ...(instanceToken ? { instanceToken } : {}),
    };
    if (request.method === 'HEAD') {
      response.writeHead(200, securityHeaders('application/json; charset=utf-8'));
      return response.end();
    }
    return sendJson(response, 200, payload);
  }

  if (request.method === 'POST' && url.pathname === '/api/session') {
    assertSameOrigin(request);
    assertSessionRate(request);
    const body = await readJson(request);
    return sendJson(response, 201, { ok: true, session: createSession(body.role, body.demoId) });
  }

  if (request.method === 'GET' && url.pathname === '/api/state') {
    const { store } = sessionFor(request);
    return sendJson(response, 200, { ok: true, state: store.snapshot() });
  }

  if (request.method === 'POST' && url.pathname === '/api/access-options') {
    assertSameOrigin(request);
    const { store } = sessionFor(request);
    const body = await readJson(request);
    return sendJson(response, 200, { ok: true, evaluation: store.listAccessOptions(body.requirements ?? body) });
  }

  const checkRouteMatch = url.pathname.match(/^\/api\/access-routes\/([^/]+)\/check$/);
  if (request.method === 'POST' && checkRouteMatch) {
    assertSameOrigin(request);
    const { store } = sessionFor(request);
    const body = await readJson(request);
    const evaluation = store.checkAccessRoute(decodePathSegment(checkRouteMatch[1]), body.requirements ?? body);
    return sendJson(response, 200, { ok: true, evaluation });
  }

  if (request.method === 'GET' && url.pathname === '/api/explain') {
    // Keyed by session: a refused search belongs to the visitor who made it.
    // Sharing one venue is the demo's point; sharing one visitor's refusal is
    // not, and it told a second visitor that a call of theirs had been rejected
    // while handing them the first visitor's access requirements.
    const { session, store } = sessionFor(request);
    return sendJson(response, 200, {
      ok: true,
      explanation: store.explainRefusal({ sessionKey: session.token }),
    });
  }

  if (request.method === 'POST' && url.pathname === '/api/plans') {
    assertSameOrigin(request);
    const { session, store } = sessionFor(request, 'visitor');
    const body = await readJson(request);
    const plan = store.findBundle(body.requirements ?? body, {
      ...interactionContext(request, 'find_access_bundle'),
      sessionKey: session.token,
    });
    return sendJson(response, 201, { ok: true, plan, state: store.snapshot() });
  }

  const stageMatch = url.pathname.match(/^\/api\/plans\/([^/]+)\/stage$/);
  if (request.method === 'POST' && stageMatch) {
    assertSameOrigin(request);
    const { store } = sessionFor(request, 'visitor');
    const body = await readJson(request);
    const plan = store.stageBundle(
      decodePathSegment(stageMatch[1]),
      body.expectedResourceVersion,
      interactionContext(request, 'stage_access_bundle'),
    );
    return sendJson(response, 200, { ok: true, plan, state: store.snapshot() });
  }

  const replanMatch = url.pathname.match(/^\/api\/plans\/([^/]+)\/replan$/);
  if (request.method === 'POST' && replanMatch) {
    assertSameOrigin(request);
    const { session, store } = sessionFor(request, 'visitor');
    const plan = store.replanBundle(
      decodePathSegment(replanMatch[1]),
      { ...interactionContext(request, 'replan_access_bundle'), sessionKey: session.token },
    );
    return sendJson(response, 200, { ok: true, plan, state: store.snapshot() });
  }

  const clearMatch = url.pathname.match(/^\/api\/plans\/([^/]+)\/clear$/);
  if (request.method === 'POST' && clearMatch) {
    assertSameOrigin(request);
    const { store } = sessionFor(request, 'visitor');
    const state = store.clearPlan(
      decodePathSegment(clearMatch[1]),
      interactionContext(request, 'clear_access_plan'),
    );
    return sendJson(response, 200, { ok: true, state });
  }

  const prepareMatch = url.pathname.match(/^\/api\/plans\/([^/]+)\/prepare-confirmation$/);
  if (request.method === 'POST' && prepareMatch) {
    assertSameOrigin(request);
    const { store } = sessionFor(request, 'visitor');
    const confirmation = store.prepareConfirmation(decodePathSegment(prepareMatch[1]));
    return sendJson(response, 200, { ok: true, confirmation, state: store.snapshot() });
  }

  const commitMatch = url.pathname.match(/^\/api\/plans\/([^/]+)\/commit$/);
  if (request.method === 'POST' && commitMatch) {
    assertSameOrigin(request);
    const { store } = sessionFor(request, 'visitor');
    const body = await readJson(request);
    const result = store.commitBundle({ ...body, planId: decodePathSegment(commitMatch[1]) });
    return sendJson(response, 200, { ok: true, result, state: store.snapshot() });
  }

  const outageMatch = url.pathname.match(/^\/api\/operator\/facilities\/([^/]+)\/outage$/);
  if (request.method === 'POST' && outageMatch) {
    assertSameOrigin(request);
    const { store } = sessionFor(request, 'operator');
    const body = await readJson(request);
    const state = store.setFacilityOutage(
      decodePathSegment(outageMatch[1]),
      body.reasonCode,
      interactionContext(request, 'report_facility_outage', 'venue-operator'),
    );
    return sendJson(response, 200, { ok: true, state });
  }

  const restoreMatch = url.pathname.match(/^\/api\/operator\/facilities\/([^/]+)\/restore$/);
  if (request.method === 'POST' && restoreMatch) {
    assertSameOrigin(request);
    const { store } = sessionFor(request, 'operator');
    const state = store.restoreFacility(
      decodePathSegment(restoreMatch[1]),
      interactionContext(request, 'restore_facility', 'venue-operator'),
    );
    return sendJson(response, 200, { ok: true, state });
  }

  const armMatch = url.pathname.match(/^\/api\/operator\/facilities\/([^/]+)\/arm$/);
  if (request.method === 'POST' && armMatch) {
    assertSameOrigin(request);
    const { store } = sessionFor(request, 'operator');
    const state = store.armOutage(decodePathSegment(armMatch[1]));
    return sendJson(response, 200, { ok: true, state });
  }

  if (request.method === 'POST' && url.pathname === '/api/demo/reset') {
    assertSameOrigin(request);
    const { store } = sessionFor(request);
    return sendJson(response, 200, { ok: true, state: store.reset() });
  }

  return sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'API route not found.' } });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }

    // HEAD is GET without a body. Answering it with 404 made the home page look
    // dead to anything that probes that way - a link checker, an uptime monitor,
    // or a person running `curl -I` before opening the site.
    const file = staticFiles.get(url.pathname);
    const readMethod = request.method === 'GET' || request.method === 'HEAD';
    if (!file || !readMethod) {
      response.writeHead(404, securityHeaders('text/plain; charset=utf-8'));
      response.end('Not found');
      return;
    }
    const [filename, contentType] = file;
    const contents = await readFile(path.join(publicDir, filename));
    response.writeHead(200, securityHeaders(contentType));
    // Same status and same headers as GET, no body. That is what HEAD means.
    response.end(request.method === 'HEAD' ? undefined : contents);
  } catch (error) {
    sendError(response, error);
  }
});

// Managed hosts inject PORT and require a 0.0.0.0 bind; local runs stay on
// loopback. NSWR_* keeps the original local override working.
const port = Number(fromEnv('PORT') ?? fromEnv('NSWR_PORT') ?? 4173);
const host = fromEnv('NSWR_HOST') ?? (fromEnv('PORT') ? '0.0.0.0' : '127.0.0.1');

const sweepTimer = setInterval(() => evictColdDemos(), 5 * 60 * 1000);
sweepTimer.unref();

server.listen(port, host, () => {
  console.log(`No Seat Without a Route: http://${host}:${port}`);
  console.log(`Venue operator:             http://${host}:${port}/operator`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
