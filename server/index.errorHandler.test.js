/**
 * Regression tests for the terminal error handler (core/http/terminalErrorHandler.js,
 * mounted last in index.js) and the CORS fail-closed path in index.js (pentest findings M-02 "stack traces returned to anonymous
 * callers" and L-03 "rejected preflight answers 500").
 *
 * index.js cannot be require()d from a test: it opens a listening socket, a
 * Postgres pool and two dozen schedulers. So instead of duplicating the logic
 * here — a copy would keep passing while the real code regressed — the test
 * lifts the two marked CORS regions straight out of index.js and evaluates them.
 * `new Function` (rather than a vm realm) keeps the code in this realm, so the
 * `err instanceof SyntaxError` branch behaves exactly as it does in the server.
 *
 * If someone moves this code out of the markers, the extraction throws and the
 * suite fails loudly rather than silently testing nothing.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, 'index.js');
const SRC = fs.readFileSync(INDEX_PATH, 'utf8');

/** Slice the source between `// ── <name>:begin ──` and `// ── <name>:end ──`. */
function region(name) {
    const beginAt = SRC.indexOf(`${name}:begin`);
    const endAt = SRC.indexOf(`${name}:end`);
    assert.ok(beginAt !== -1, `missing "${name}:begin" marker in index.js`);
    assert.ok(endAt > beginAt, `missing "${name}:end" marker in index.js`);
    const bodyStart = SRC.indexOf('\n', beginAt) + 1;
    const bodyEnd = SRC.lastIndexOf('\n', endAt);
    return SRC.slice(bodyStart, bodyEnd);
}

/**
 * Evaluate both regions with a captured console and a chosen CORS_ORIGIN.
 * ALLOWED_ORIGINS is read from process.env at evaluation time, so the env var is
 * set only for the duration of the build.
 */
function build({ corsOrigin = 'https://app.example.com,https://other.example.com/' } = {}) {
    const logs = { warn: [], error: [], log: [] };
    const fakeConsole = {
        warn: (...args) => logs.warn.push(args),
        error: (...args) => logs.error.push(args),
        log: (...args) => logs.log.push(args),
        info: (...args) => logs.log.push(args),
    };
    // The dispatch region ends in `app.use(...)`; capture what it registers so
    // the same middleware can be mounted on a throwaway express app below.
    const mounted = [];
    const appStub = { use: (fn) => mounted.push(fn) };
    const previous = process.env.CORS_ORIGIN;
    process.env.CORS_ORIGIN = corsOrigin;
    try {
        const body = `${region('cors-helpers')}\n${region('cors-dispatch')}\n`
            + 'return { ALLOWED_ORIGINS, isAllowedOrigin, safeForLog, warnRejectedOrigin };';
        const factory = new Function('require', 'console', 'log', 'cors', 'app', body);
        const api = factory(require, fakeConsole, fakeConsole, require('cors'), appStub);
        assert.equal(mounted.length, 1, 'the cors-dispatch region should register exactly one middleware');
        // The terminal handler is its own module; index.js mounts it last.
        const { createTerminalErrorHandler } = require('./core/http/terminalErrorHandler');
        const terminalErrorHandler = createTerminalErrorHandler({ log: fakeConsole });
        return { api: { ...api, corsDispatcher: mounted[0], terminalErrorHandler }, logs };
    } finally {
        if (previous === undefined) delete process.env.CORS_ORIGIN;
        else process.env.CORS_ORIGIN = previous;
    }
}

/**
 * A throwaway express app wired exactly like index.js's request path — the CORS
 * dispatcher, the same body parser, one route that throws, and the terminal
 * handler last. No DB, no session store, no listeners beyond an ephemeral port.
 */
async function withServer(api, run) {
    const express = require('express');
    const bodyParser = require('body-parser');
    const app = express();
    app.use(api.corsDispatcher);
    app.use(bodyParser.json({ limit: '20mb' }));
    app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
    app.post('/api/health', (req, res) => res.json({ status: 'ok' }));
    app.get('/api/boom', () => { throw new Error('secret internals: postgres://beeflow@10.42.0.7/beeflow_core'); });
    app.use(api.terminalErrorHandler);

    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        await run(base);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function mockRes({ headersSent = false } = {}) {
    return {
        headersSent,
        statusCode: null,
        body: undefined,
        headers: {},
        setHeader(key, value) { this.headers[key] = value; },
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

const REQ = { method: 'POST', path: '/api/agents', originalUrl: '/api/agents?x=1' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── CORS origin allow-list ────────────────────────────────────────────────────

test('isAllowedOrigin matches the allow-list and tolerates trailing slashes', () => {
    const { api } = build();
    assert.equal(api.isAllowedOrigin('https://app.example.com'), true);
    assert.equal(api.isAllowedOrigin('https://app.example.com/'), true);
    assert.equal(api.isAllowedOrigin('https://other.example.com'), true);
    assert.equal(api.isAllowedOrigin('https://evil.com'), false);
    // Prefix/suffix confusion must not pass.
    assert.equal(api.isAllowedOrigin('https://app.example.com.evil.com'), false);
    assert.equal(api.isAllowedOrigin('https://evil.com/https://app.example.com'), false);
    assert.equal(api.isAllowedOrigin('null'), false);
});

test('rejected-origin warnings are deduped so they cannot be used as a log flood', () => {
    const { api, logs } = build();
    for (let i = 0; i < 25; i++) api.warnRejectedOrigin('https://evil.com');
    assert.equal(logs.warn.length, 1, 'the same origin must warn only once per window');
    api.warnRejectedOrigin('https://other-evil.com');
    assert.equal(logs.warn.length, 2, 'a different origin still warns');
});

// Per-origin deduplication bounds nothing on its own: 300 DISTINCT origins
// would produce 300 log lines from a per-origin rule, which is the flood it was
// supposed to prevent. The aggregate ceiling is what actually caps it.
test('spraying distinct origins is capped in aggregate, not just per origin', () => {
    const { api, logs } = build();
    // More distinct origins than CORS_WARN_MAX_TRACKED, to walk the eviction path.
    for (let i = 0; i < 300; i++) api.warnRejectedOrigin(`https://evil-${i}.com`);
    assert.ok(logs.warn.length <= 20,
        `300 distinct origins produced ${logs.warn.length} log lines — the aggregate cap is not holding`);
    assert.ok(logs.warn.length > 0, 'the operator must still learn that origins are being rejected');
});

// A preflight is the only thing standing between the browser and every
// cross-origin call, so the allow-list has to name every header the clients
// actually send. authFetch adds X-Beeflow-Client to all of them; omitting it
// from allowedHeaders bricked the whole split-origin app (dev server -> API)
// while same-origin production stayed green, because same-origin never
// pre-flights.
test('preflight allows every header the clients send', async () => {
    const { api } = build();
    await withServer(api, async (base) => {
        for (const header of ['content-type', 'authorization', 'x-session-token', 'x-beeflow-client']) {
            const res = await fetch(`${base}/api/health`, {
                method: 'OPTIONS',
                headers: {
                    Origin: 'https://app.example.com',
                    'Access-Control-Request-Method': 'POST',
                    'Access-Control-Request-Headers': header,
                },
            });
            const allowed = (res.headers.get('access-control-allow-headers') || '').toLowerCase();
            assert.ok(res.status >= 200 && res.status < 300,
                `preflight for ${header} answered ${res.status}`);
            assert.ok(allowed.split(',').map((h) => h.trim()).includes(header),
                `${header} missing from Access-Control-Allow-Headers ("${allowed}") — the browser will block every cross-origin request`);
        }
    });
});

test('safeForLog strips control characters and caps length', () => {
    const { api } = build();
    assert.equal(api.safeForLog('a\r\nFAKE LOG LINE'), 'a??FAKE LOG LINE');
    assert.equal(api.safeForLog('x'.repeat(500)).length, 120);
    assert.equal(api.safeForLog('x'.repeat(500), 10).length, 10);
    assert.equal(api.safeForLog(undefined), '');
});

// ── Terminal error handler ────────────────────────────────────────────────────

test('malformed JSON bodies get a 400 with no stack and no error-level log', () => {
    const { api, logs } = build();
    const err = new SyntaxError('Bad escaped character in JSON at position 15');
    err.status = 400;
    err.body = '{"a": "\\x"}';
    const res = mockRes();
    api.terminalErrorHandler(err, REQ, res, () => assert.fail('next() must not be called'));

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'Invalid JSON body' });
    assert.equal(logs.error.length, 0, 'attacker-triggerable parse failures must not hit the error channel');
});

test("body-parser's entity.parse.failed is handled by type as well", () => {
    const { api } = build();
    const err = Object.assign(new Error('Unexpected token'), { type: 'entity.parse.failed', status: 400 });
    const res = mockRes();
    api.terminalErrorHandler(err, REQ, res, () => assert.fail('next() must not be called'));
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'Invalid JSON body' });
});

test('oversized bodies get a generic 413', () => {
    const { api } = build();
    const err = Object.assign(new Error('request entity too large'), {
        type: 'entity.too.large', status: 413, limit: 20971520, length: 99999999,
    });
    const res = mockRes();
    api.terminalErrorHandler(err, REQ, res, () => assert.fail('next() must not be called'));
    assert.equal(res.statusCode, 413);
    assert.deepEqual(res.body, { error: 'Request body too large' });
    assert.ok(!JSON.stringify(res.body).includes('20971520'), 'do not disclose the configured limit');
});

test('an HttpError below 500 exposes its message, code and details', () => {
    const { api } = build();
    const { HttpError } = require('./core/http/errors');
    const res = mockRes();
    const err = new HttpError(422, 'plan_parse_failed', 'Could not parse the plan', { rawPreview: 'x' });
    api.terminalErrorHandler(err, REQ, res, () => assert.fail('next() must not be called'));
    assert.equal(res.statusCode, 422);
    assert.deepEqual(Object.keys(res.body).sort(), ['code', 'correlationId', 'details', 'error']);
    assert.equal(res.body.error, 'Could not parse the plan');
    assert.equal(res.body.code, 'plan_parse_failed');
    assert.deepEqual(res.body.details, { rawPreview: 'x' });
});

test('an HttpError at 5xx keeps the message the route wrote, and is logged in full', () => {
    const { api, logs } = build();
    const { HttpError } = require('./core/http/errors');
    const res = mockRes();
    api.terminalErrorHandler(new HttpError(502, 'fetch_failed', 'Fetch failed: HTTP 404'), REQ, res, () => {});
    assert.equal(res.statusCode, 502);
    assert.deepEqual(Object.keys(res.body).sort(), ['code', 'correlationId', 'error']);
    assert.equal(res.body.error, 'Fetch failed: HTTP 404');
    assert.equal(res.body.code, 'fetch_failed');
    assert.equal(logs.error.length, 1, 'a 5xx is logged at error level even when written for the caller');
});

test('a plain error with a 4xx status never gains a code from a Node errno', () => {
    const { api } = build();
    const res = mockRes();
    const err = Object.assign(new Error('nope'), { status: 400, code: 'ENOENT' });
    api.terminalErrorHandler(err, REQ, res, () => {});
    assert.equal(res.statusCode, 400);
    assert.deepEqual(Object.keys(res.body).sort(), ['correlationId', 'error']);
});

test('an unexpected 5xx never leaks the message or the stack to the client', () => {
    const { api, logs } = build();
    const err = new Error('connect ECONNREFUSED 10.42.0.7:5432 (beeflow_core)');
    const res = mockRes();
    api.terminalErrorHandler(err, REQ, res, () => assert.fail('next() must not be called'));

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Internal server error');
    assert.match(res.body.correlationId, UUID_RE);
    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes('ECONNREFUSED'), 'message must not reach the client');
    assert.ok(!serialized.includes('10.42.0.7'), 'internal host must not reach the client');
    assert.ok(!/\bat\s/.test(serialized), 'no stack frames in the body');
    assert.deepEqual(Object.keys(res.body).sort(), ['correlationId', 'error']);

    // …but the operator must be able to find it: full error object, same id.
    assert.equal(logs.error.length, 1);
    const [line, logged] = logs.error[0];
    assert.ok(line.includes(res.body.correlationId), 'log line carries the correlation id');
    assert.ok(line.includes('POST'), 'log line carries the method');
    assert.ok(line.includes('/api/agents'), 'log line carries the path');
    assert.strictEqual(logged, err, 'the full error (with stack) is logged server-side');
});

test('a 5xx that declares its own status still gets a generic body', () => {
    const { api } = build();
    const err = Object.assign(new Error('upstream vault said: token=abcd1234'), { status: 502 });
    const res = mockRes();
    api.terminalErrorHandler(err, REQ, res, () => assert.fail('next() must not be called'));
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.error, 'Internal server error');
    assert.ok(!JSON.stringify(res.body).includes('abcd1234'));
});

test('a deliberate 4xx keeps its status and message, plus a correlation id', () => {
    const { api, logs } = build();
    const err = Object.assign(new Error('Organization slug already in use'), { statusCode: 409 });
    const res = mockRes();
    api.terminalErrorHandler(err, REQ, res, () => assert.fail('next() must not be called'));
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'Organization slug already in use');
    assert.match(res.body.correlationId, UUID_RE);
    assert.equal(logs.error.length, 0, '4xx is a client problem, not an operator alert');
    assert.equal(logs.warn.length, 1);
});

test('a 4xx without a usable message falls back to a generic sentence', () => {
    const { api } = build();
    const res = mockRes();
    api.terminalErrorHandler({ status: 400, message: '   ' }, REQ, res, () => assert.fail('next() must not be called'));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Request could not be processed');
});

test('a 4xx message is capped so it cannot become the payload', () => {
    const { api } = build();
    const err = Object.assign(new Error('x'.repeat(5000)), { status: 400 });
    const res = mockRes();
    api.terminalErrorHandler(err, REQ, res, () => assert.fail('next() must not be called'));
    assert.equal(res.body.error.length, 300);
});

test('an out-of-range or missing status collapses to 500', () => {
    const { api } = build();
    for (const status of [undefined, 0, 99, 700, 'nonsense']) {
        const res = mockRes();
        api.terminalErrorHandler(Object.assign(new Error('boom'), { status }), REQ, res, () => assert.fail('next() must not be called'));
        assert.equal(res.statusCode, 500, `status=${String(status)} must collapse to 500`);
        assert.equal(res.body.error, 'Internal server error');
    }
});

test('an already-started response is handed back to Express untouched', () => {
    const { api } = build();
    const err = new Error('stream died mid-flight');
    const res = mockRes({ headersSent: true });
    let passed = null;
    api.terminalErrorHandler(err, REQ, res, (e) => { passed = e; });
    assert.strictEqual(passed, err);
    assert.equal(res.statusCode, null, 'must not try to rewrite a half-sent response');
    assert.equal(res.body, undefined);
});

test('a missing req does not turn the error handler itself into a 500', () => {
    const { api } = build();
    const res = mockRes();
    api.terminalErrorHandler(new Error('boom'), undefined, res, () => assert.fail('next() must not be called'));
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Internal server error');
});

// ── End-to-end over the real middleware (no DB, ephemeral port) ───────────────

test('a preflight from a disallowed origin gets 403 and no CORS headers', async () => {
    const { api } = build();
    await withServer(api, async (base) => {
        const res = await fetch(`${base}/api/health`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://evil.com', 'Access-Control-Request-Method': 'POST' },
        });
        assert.equal(res.status, 403, 'a rejected preflight must not look like a 204 success (L-03)');
        assert.equal(res.headers.get('access-control-allow-origin'), null);
        assert.equal(res.headers.get('access-control-allow-credentials'), null);
        assert.equal(res.headers.get('vary'), 'Origin');
        assert.deepEqual(await res.json(), { error: 'Origin not allowed' });
    });
});

test('a preflight from an allowed origin still succeeds with credentials', async () => {
    const { api } = build();
    await withServer(api, async (base) => {
        const res = await fetch(`${base}/api/health`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://app.example.com', 'Access-Control-Request-Method': 'POST' },
        });
        assert.equal(res.status, 204);
        assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example.com');
        assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    });
});

test('a simple request from a disallowed origin gets no allow-origin header', async () => {
    const { api } = build();
    await withServer(api, async (base) => {
        const res = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.com' } });
        // The browser is what blocks the read, and it blocks on the ABSENCE of
        // this header — reflecting the origin here is what let any site issue
        // authenticated XHRs against the API.
        assert.equal(res.headers.get('access-control-allow-origin'), null);
    });
});

test('a malformed JSON body returns a JSON 400, not a Node stack trace (M-02)', async () => {
    const { api } = build();
    await withServer(api, async (base) => {
        const res = await fetch(`${base}/api/health`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"a": "\\x"}',
        });
        const text = await res.text();
        assert.equal(res.status, 400);
        assert.deepEqual(JSON.parse(text), { error: 'Invalid JSON body' });
        for (const leak of ['SyntaxError', 'body-parser', 'node_modules', 'JSON.parse', '    at ']) {
            assert.ok(!text.includes(leak), `response leaked "${leak}"`);
        }
    });
});

test('a thrown route error returns a generic 500 with a correlation id (M-02)', async () => {
    const { api, logs } = build();
    await withServer(api, async (base) => {
        const res = await fetch(`${base}/api/boom`);
        const text = await res.text();
        assert.equal(res.status, 500);
        const body = JSON.parse(text);
        assert.equal(body.error, 'Internal server error');
        assert.match(body.correlationId, UUID_RE);
        for (const leak of ['postgres://', '10.42.0.7', 'node_modules', 'index.errorHandler.test.js', '    at ']) {
            assert.ok(!text.includes(leak), `response leaked "${leak}"`);
        }
        // The detail the client did not get must exist in the operator's log.
        assert.equal(logs.error.length, 1);
        assert.ok(logs.error[0][1] instanceof Error);
        assert.ok(logs.error[0][1].stack.includes('index.errorHandler.test.js'));
    });
});

// ── Wiring invariants in index.js ─────────────────────────────────────────────

test('the CORS origin callback never constructs an Error (L-03)', () => {
    // Comment lines are dropped first — the fix is documented in a comment that
    // quotes the very pattern being banned.
    const code = SRC.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/cb\(new Error\(/.test(code), 'cb(new Error(...)) throws into Express and returns a 500 + stack');
    assert.ok(code.includes('return cb(null, false);'), 'the origin callback must fail closed without throwing');
});

test('a preflight from a disallowed origin is refused with 403 and Vary: Origin', async () => {
    const { api } = build();
    await withServer(api, async (base) => {
        const res = await fetch(`${base}/api/health`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://evil.com', 'Access-Control-Request-Method': 'POST' },
        });
        assert.equal(res.status, 403);
        assert.equal(res.headers.get('access-control-allow-origin'), null);
        assert.match(res.headers.get('vary') || '', /Origin/);
        assert.deepEqual(await res.json(), { error: 'Origin not allowed' });
    });
});

// The bug this pins is the reason the refusal is not OPTIONS-only. A
// CORS-*simple* request is never preflighted, so an OPTIONS-only check leaves
// the route executing with the victim's cookies attached and only the RESPONSE
// unreadable — which is not a defence for an upload, a CMS write, or anything
// that spends model budget. Production also runs COOKIE_SAMESITE=none.
test('a simple cross-origin POST from a disallowed origin never reaches the route', async () => {
    const { api } = build();
    await withServer(api, async (base) => {
        const res = await fetch(`${base}/api/health`, {
            method: 'POST',
            headers: { Origin: 'https://evil.com', 'Content-Type': 'text/plain' },
            body: 'side-effect',
        });
        assert.equal(res.status, 403, 'the request itself must be refused, not merely made unreadable');
        assert.equal(res.headers.get('access-control-allow-origin'), null);
        const body = await res.json();
        assert.deepEqual(body, { error: 'Origin not allowed' });
        assert.ok(body.status !== 'ok', 'the route handler must not have run');
    });
});

test('an allow-listed origin and a no-Origin caller both still work', async () => {
    const { api } = build();
    await withServer(api, async (base) => {
        const allowed = await fetch(`${base}/api/health`, {
            method: 'POST',
            headers: { Origin: 'https://app.example.com', 'Content-Type': 'application/json' },
            body: '{}',
        });
        assert.equal(allowed.status, 200);
        assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example.com');

        // curl / the Nextcloud connector / Stripe send no Origin at all.
        const noOrigin = await fetch(`${base}/api/health`);
        assert.equal(noOrigin.status, 200);
    });
});

test('previewCors keeps reflecting any origin (bearer-token authed paths)', () => {
    assert.ok(/const previewCors = cors\(\{\s*\n\s*origin: true,/.test(SRC),
        'the sandboxed-iframe / public-share path must stay permissive');
});

test('the terminal error handler is the last top-level app.use', () => {
    // The filter stays on the UNTRIMMED line — a leading space is what
    // distinguishes a top-level mount from an app.use nested inside a function
    // (mountFullTierProxy re-registers the handler and must not count here).
    // Only the comparison is normalised: git's autocrlf rewrites this file with
    // CRLF on a Windows checkout, and an exact compare then fails on a trailing
    // \r while the ordering it polices is perfectly fine. It is about ORDER.
    const topLevel = SRC.split('\n').filter(l => l.startsWith('app.use('));
    assert.equal(topLevel[topLevel.length - 1].trim(), 'app.use(terminalErrorHandler);',
        'Express only routes errors to handlers registered after the failing layer');
});

test('the JSON 404 is mounted above the marketing renderer and the SPA fallback', () => {
    const notFoundAt = SRC.indexOf("return res.status(404).json({ error: 'Not found' });");
    const publicRenderAt = SRC.indexOf("app.use(require('./routes/publicRender'));");
    const spaFallbackAt = SRC.indexOf('res.sendFile(indexPath);');
    assert.ok(notFoundAt !== -1 && publicRenderAt !== -1 && spaFallbackAt !== -1);
    assert.ok(notFoundAt < publicRenderAt, 'otherwise unmatched /auth/* still costs a CMS lookup');
    assert.ok(notFoundAt < spaFallbackAt, 'otherwise unmatched /api/* answers 200 text/html in production');
});
