/**
 * studioAppBrowse route — the SSE contract: step resolution, gating, event
 * order, heartbeat, and client-disconnect → cancelled. executeDataStep is
 * stubbed to drive frames through ctx.browse.send, so no real browser runs.
 *
 * Run: cd server && node --test routes/studioAppBrowse.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { Readable, Writable } = require('stream');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const apps = new Map();
const state = { role: 'member', stepBehaviour: null };

stub('../stores/studioAppStore', {
    getStudioApp: async (id) => apps.get(id) || null,
    canReadStudioApp: (app, userId, _groups = [], orgIds = []) => {
        if (!app) return false;
        if (app.userId === userId) return true;
        return app.isPublished && app.organizationId && (orgIds || []).includes(app.organizationId);
    },
    // No fixture here is filed into a Studio Project, so the project-widened
    // predicate answers exactly what the sync one does.
    canReadStudioAppAsync: async (app, userId, _groups = [], orgIds = []) => {
        if (!app) return false;
        if (app.userId === userId) return true;
        return app.isPublished && app.organizationId && (orgIds || []).includes(app.organizationId);
    },
});
stub('../stores/studioAppDataStore', { getDataModel: async () => ({ model: { tables: [] } }) });
stub('../appStudio/rlsGateway', { resolveViewerRole: async () => state.role });
stub('../auth/audience', {
    resolveAudienceContext: async (req) => ({ orgIds: new Set(req._testOrgIds || []), userGroups: req._testGroups || [] }),
});
// The executor: drive the browse SSE bridge, then return a result.
stub('../appStudio/actionExecutor', {
    executeDataStep: async (app, model, step, ctx) => {
        if (state.stepBehaviour === 'frames') {
            ctx.browse.send('browser_session_start', { sessionId: 's1', url: 'https://x', task: 't' });
            ctx.browse.send('browser_frame', { sessionId: 's1', b64: 'AAAA' });
            ctx.browse.send('browser_action', { sessionId: 's1', tool: 'pw_navigate', summary: 'open', step: 1 });
            ctx.browse.send('browser_session_end', { sessionId: 's1' });
            return { ok: true, result: { answer: 'done', visitedUrls: ['https://x'] } };
        }
        if (state.stepBehaviour === 'cancel-check') {
            // Report whether the client disconnect was observed.
            return { ok: !ctx.browse.isCancelled(), result: { cancelledSeen: ctx.browse.isCancelled() } };
        }
        return { ok: false, error: 'nope', code: 'browse_not_enabled' };
    },
});
// Rate limiters: pass-through (behaviour of the limiter is its own test).
stub('./studioAppRateLimits', {
    browseStepLimiter: (req, res, next) => next(),
    aiStepLimiter: (req, res, next) => next(),
});
// requireAuth: pass-through when a session user is present (the real one hits
// the DB to verify the user still exists — out of scope for a route test).
stub('../auth/permissions', {
    requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'unauth' })),
});

const router = require('./studioAppBrowse');

// ── Harness ─────────────────────────────────────────────────────────
const OWNER = 'owner-1';
let seq = 0;
function makeApp({ steps = [{ kind: 'ai_browse', task: { kind: 'static', value: 't' }, resultVar: 'r' }] } = {}) {
    const id = `app-${++seq}`;
    const def = { actions: { act1: { kind: 'sequence', steps } }, screens: [] };
    apps.set(id, { id, userId: OWNER, organizationId: 'org-1', isPublished: true, name: 'A', definition: def, publishedDefinition: def });
    return id;
}

class FakeRes extends Writable {
    constructor(resolve) {
        super();
        this.statusCode = 200; this.headers = {}; this.frames = []; this.body = undefined;
        this._resolve = resolve; this._settled = false; this.ended = false;
        this.on('finish', () => this._done());
    }
    status(c) { this.statusCode = c; return this; }
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }
    getHeader(k) { return this.headers[String(k).toLowerCase()]; }
    flushHeaders() {}
    json(b) { this.body = b; this._done(); return this; }
    write(chunk) {
        const s = chunk.toString();
        for (const line of s.split('\n\n')) {
            const d = line.split('\n').find((l) => l.startsWith('data:'));
            if (d) { try { this.frames.push(JSON.parse(d.slice(5).trim())); } catch { /* skip */ } }
        }
        return true;
    }
    end() { if (!this.ended) { this.ended = true; this.emit('finish'); } }
    _write(_c, _e, cb) { cb(); }
    _done() { if (this._settled) return; this._settled = true; this._resolve(this); }
}

function makeReq(url, { body = {}, user = OWNER, orgIds = [], method = 'POST' } = {}) {
    const req = new Readable({ read() {} });
    req.method = method; req.url = url;
    req.headers = { 'content-type': 'application/json' };
    req.session = user ? { user: { id: user, name: 'U' } } : null;
    req.body = body; // stub jsonBody by pre-setting; the route reads req.body
    req._testOrgIds = orgIds;
    req._handlers = {};
    req.on = (ev, fn) => { (req._handlers[ev] ||= []).push(fn); return req; };
    req.off = () => req;
    req.emitClose = () => (req._handlers.close || []).forEach((fn) => fn());
    return req;
}

function dispatch(req) {
    return new Promise((resolve, reject) => {
        const res = new FakeRes(resolve);
        // The route uses express.json() middleware — but req.body is pre-set,
        // so the middleware is a no-op passthrough. Invoke the LAST layer.
        router.handle
            ? router.handle(req, res, (err) => (err ? reject(err) : reject(new Error('fell through'))))
            : router(req, res, (err) => (err ? reject(err) : reject(new Error('fell through'))));
    });
}

test.beforeEach(() => { state.role = 'member'; state.stepBehaviour = 'frames'; });

test('happy path: frames stream in order, ending result then done', async () => {
    const id = makeApp();
    const res = await dispatch(makeReq(`/${id}/actions/act1/step/stream`, { body: { stepIndex: 0 } }));
    assert.strictEqual(res.headers['content-type'], 'text/event-stream');
    assert.strictEqual(res.headers['x-accel-buffering'], 'no');
    const types = res.frames.map((f) => f.type);
    assert.deepStrictEqual(types, ['start', 'frame', 'action', 'end', 'result', 'done']);
    const frame = res.frames.find((f) => f.type === 'frame');
    assert.strictEqual(frame.b64, 'AAAA', 'frame payload is byte-identical to the chat shape');
    const result = res.frames.find((f) => f.type === 'result');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.result.visitedUrls, ['https://x']);
});

test('the step must resolve to ai_browse — anything else is a 400 (JSON, not SSE)', async () => {
    const id = makeApp({ steps: [{ kind: 'create_record', tableId: 't', values: {} }] });
    const res = await dispatch(makeReq(`/${id}/actions/act1/step/stream`, { body: { stepIndex: 0 } }));
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /only runs ai_browse/);
});

test('an out-of-range step index is 404', async () => {
    const id = makeApp();
    const res = await dispatch(makeReq(`/${id}/actions/act1/step/stream`, { body: { stepIndex: 9 } }));
    assert.strictEqual(res.statusCode, 404);
});

test('a role-less viewer is 403 before the stream opens', async () => {
    const id = makeApp();
    state.role = null;
    const res = await dispatch(makeReq(`/${id}/actions/act1/step/stream`, { body: { stepIndex: 0 }, user: 'viewer-x', orgIds: ['org-1'] }));
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.headers['content-type'], undefined, 'no SSE headers on a refusal');
});

test('an invisible app is a uniform 404', async () => {
    const id = makeApp();
    apps.get(id).isPublished = false;
    const res = await dispatch(makeReq(`/${id}/actions/act1/step/stream`, { body: { stepIndex: 0 }, user: 'stranger', orgIds: [] }));
    assert.strictEqual(res.statusCode, 404);
});

test('client disconnect is surfaced to the step as isCancelled()', async () => {
    const id = makeApp();
    state.stepBehaviour = 'cancel-check';
    const req = makeReq(`/${id}/actions/act1/step/stream`, { body: { stepIndex: 0 } });
    // Fire the close handler as soon as the route registers it.
    const origOn = req.on;
    req.on = (ev, fn) => { origOn(ev, fn); if (ev === 'close') fn(); return req; };
    const res = await dispatch(req);
    const result = res.frames.find((f) => f.type === 'result');
    assert.strictEqual(result.result.cancelledSeen, true, 'the step saw the disconnect');
});
