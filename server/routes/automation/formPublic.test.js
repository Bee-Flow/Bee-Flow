'use strict';

/**
 * The public form-trigger surface. Every test drives a route handler directly
 * with a mocked store/runner — the same harness family as
 * events.webhookPayload.test.js.
 *
 * Run: node --test routes/automation/formPublic.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

const TOKEN = 'a'.repeat(48);
const OTHER_TOKEN = 'b'.repeat(48);

const FORM = {
    title: 'Contact us',
    fields: [
        { name: 'email', type: 'email', label: 'Your email', required: true },
        { name: 'topic', type: 'select', label: 'Topic', options: ['Sales', 'Support'] },
        { name: 'attachment', type: 'file', label: 'Attachment', maxSizeMb: 5 },
    ],
};

/** The second page a paused run is waiting on, as the runner would render it. */
const PAGE_2 = {
    title: 'Nearly there',
    submitLabel: 'Finish',
    successMessage: 'Thanks!',
    theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'light' },
    fields: [
        { name: 'address', type: 'text', label: 'Your address', required: true, placeholder: '', help: '' },
        { name: 'proof', type: 'file', label: 'Proof', required: false, placeholder: '', help: '', accept: '', maxSizeMb: 5 },
    ],
};

let state;
function resetState() {
    state = {
        executions: [],
        resumes: [],
        nonces: new Set(),
        uploads: new Map(),
        sessions: new Map(),
        runs: new Map(),
        runSteps: new Map(),
        runUpdates: [],
        usage: { files: 0, bytes: 0 },
        touched: 0,
        active: true,
        triggerKind: 'form',
        // Who the form belongs to. The default caller is a colleague in the
        // same organisation, so the default request is allowed.
        audience: { userId: 'owner1', organizationId: 'org1' },
        groupsOf: {},
        groupReads: 0,
        notebooks: [],
        notebookWrites: [],
        parsed: [],
        parsedText: 'Eerste alinea.\n\nTweede alinea.',
        parseThrows: false,
        uploaded: [],
        deleted: [],
        streamed: [],
        storageMissing: false,
        scanClean: true,
        storageAvailable: true,
        resolveRun: null,
        // What executeAutomation/resumeFromStep should hand back, in order.
        runQueue: [],
        // Lets a test swap in a whole definition (flowlets and all) instead of
        // the single-page default.
        definitionOverride: null,
        // id → generated-document ledger row.
        generatedFiles: new Map(),
        // ── app_pick ──
        // Every search and every record read the route asked for, and what the
        // stubbed resolver hands back. The resolver's own rules (who may search
        // what) are pinned in automation/formPickRecord.test.js; here we are
        // only interested in what the ROUTE gives it and what it does with the
        // answer.
        pickSearches: [],
        pickReads: [],
        pickResults: [{ id: 'tr_1', title: 'Kickoff met Acme', subtitle: '2026-09-01' }],
        pickSearchError: null,
    };
}
resetState();

/**
 * Register a run row (+ its step rows) the poll endpoint can read back.
 *
 * `rootRunId` is the JOURNEY: a run that continues a paused one carries its
 * parent's root, and the poll reads the newest leg of that journey rather than
 * the row the session happens to point at. Default: the run is its own root,
 * which is every run that was never paused.
 */
let runSeq = 0;
function putRun(id, status, { awaitingStepId = null, steps = [], rootRunId = null } = {}) {
    runSeq += 1;
    state.runs.set(id, { id, status, awaitingStepId, automationId: 'auto1', rootRunId: rootRunId || id, seq: runSeq });
    state.runSteps.set(id, steps);
    return state.runs.get(id);
}
/** The newest leg of the journey `id` belongs to — the store's real ordering. */
function latestInChain(id) {
    const row = state.runs.get(id);
    if (!row) return null;
    const root = row.rootRunId || row.id;
    let best = null;
    for (const r of state.runs.values()) {
        if ((r.rootRunId || r.id) !== root) continue;
        if (!best || r.seq > best.seq) best = r;
    }
    return best;
}
const nextRun = () => (state.runQueue.length ? state.runQueue.shift() : { id: 'run1' });

// The caller's group memberships, read only when a restricted form names groups.
mock(path.join(SERVER, 'auth/audience'), {
    resolveUserGroups: async (userId) => { state.groupReads += 1; return state.groupsOf[userId] || []; },
});

mock(path.join(SERVER, 'stores/automationStore'), {
    getFormPage: async (id) => (id === TOKEN ? { id: TOKEN, automationId: 'auto1', triggerStepId: null, submissions: 0 } : null),
    getAutomation: async () => ({
        id: 'auto1',
        userId: 'owner1',
        isActive: state.active,
        isDraft: false,
        definition: state.definitionOverride || { trigger: { id: 'trg', type: 'trigger', kind: state.triggerKind, form: FORM } },
    }),
    checkAndStoreNonce: async (key) => {
        if (state.nonces.has(key)) return false;
        state.nonces.add(key);
        return true;
    },
    touchFormPage: async () => { state.touched += 1; },
    // Forms are signed-in only now; loadForm asks who the form belongs to.
    formPageAudience: async (id) => (id === TOKEN ? state.audience : null),
    formUploadUsage: async () => state.usage,
    recordFormUpload: async (pageId, row) => {
        const id = `up_${state.uploads.size + 1}`;
        state.uploads.set(id, { id, formPageId: pageId, ...row, claimedAt: null });
        return { id, ...row };
    },
    claimFormUpload: async (id, pageId) => {
        const row = state.uploads.get(id);
        if (!row || row.formPageId !== pageId || row.claimedAt) return null;
        row.claimedAt = new Date().toISOString();
        return row;
    },
    // ── multi-page sessions ──
    createFormSession: async (formPageId, automationId, opts = {}) => {
        const id = `${'c'.repeat(40)}${String(state.sessions.size + 1).padStart(8, '0')}`;
        const row = {
            id, formPageId, automationId, runId: null,
            rootStepId: opts.rootStepId ?? null, triggerHeaders: opts.triggerHeaders ?? null,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        };
        state.sessions.set(id, row);
        return row;
    },
    getFormSession: async (id, formPageId) => {
        const row = state.sessions.get(id);
        return (row && row.formPageId === formPageId) ? { ...row } : null;
    },
    attachFormSessionRun: async (id, runId) => {
        const row = state.sessions.get(id);
        if (row) row.runId = runId;
    },
    touchFormSession: async () => {},
    getRun: async (id) => (state.runs.get(id) ? { ...state.runs.get(id) } : null),
    getLatestRunInChain: async (id) => { const r = latestInChain(id); return r ? { ...r } : null; },
    getRunsInChain: async (id) => {
        const row = state.runs.get(id);
        if (!row) return [];
        const root = row.rootRunId || row.id;
        return [...state.runs.values()].filter(r => (r.rootRunId || r.id) === root).map(r => ({ ...r }));
    },
    // Same access rule as the real store: an id alone proves nothing; the file
    // must belong to one of the runs the caller already has access to.
    getGeneratedFileForRuns: async (id, runIds) => {
        const f = state.generatedFiles.get(id);
        return (f && runIds.includes(f.runId)) ? { ...f } : null;
    },
    getRunSteps: async (id) => (state.runSteps.get(id) || []).map(s => ({ ...s })),
    updateRun: async (id, updates) => {
        const row = state.runs.get(id);
        if (!row) return false;
        Object.assign(row, updates);
        state.runUpdates.push({ id, updates });
        return true;
    },
});
mock(path.join(SERVER, 'stores/storageStore'), {
    isAvailable: () => state.storageAvailable,
    uploadFile: async (key) => { state.uploaded.push(key); },
    deleteFile: async (key) => { state.deleted.push(key); },
    // Same shape as the real helper: uploads and generated documents share one
    // content-addressed prefix per automation.
    buildAutomationFileKey: (ownerId, automationId, sha) => `automation-forms/${ownerId}/${automationId}/${sha}`,
    streamFile: async (key) => {
        if (state.storageMissing) throw new Error('NoSuchKey');
        state.streamed.push(key);
        const { Readable } = require('stream');
        return { stream: Readable.from([Buffer.from('%PDF-1.7 fake')]), contentType: 'application/pdf', contentLength: 13 };
    },
});
// The closing page's "Open in Notebooks" button copies the document into a
// fresh notebook. Ingestion is deliberately fire-and-forget in the route, so
// the mock records the call rather than resolving into the response.
mock(path.join(SERVER, 'stores/notebookStore'), {
    createNotebook: async (opts) => {
        const nb = { id: `nb${state.notebooks.length + 1}`, ...opts };
        state.notebooks.push(nb);
        return nb;
    },
    updateNotebook: async (id, userId, updates) => {
        state.notebookWrites.push({ id, userId, ...updates });
        return true;
    },
});
// The document is parsed back out of the rendered file — nothing stores its
// text. The real parser is exercised in its own tests; here it stands in.
mock(path.join(SERVER, 'core/documents/documentParser'), {
    parseDocument: async (buffer, mimeType, filename) => {
        if (state.parseThrows) throw new Error('unreadable');
        state.parsed.push({ bytes: buffer.length, mimeType, filename });
        return state.parsedText;
    },
});
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => (req, res, next) => next() });
mock(path.join(SERVER, 'middleware/uploadGuard'), {
    uploadGuard: () => (req, res, next) => next(),
    scanBuffer: async () => ({ clean: state.scanClean, signature: state.scanClean ? null : 'EICAR-Test' }),
});
mock(path.join(SERVER, 'automation/formPickRecord'), {
    searchRecords: async (source, query, caller, opts) => {
        state.pickSearches.push({ source, query, caller, opts });
        return state.pickSearchError ? { error: state.pickSearchError } : { results: state.pickResults };
    },
    describePick: async (pick, opts) => {
        state.pickReads.push({ pick, withText: opts?.withText, callerId: opts?.caller?.userId || null });
        return { ...pick, text: `the text of ${pick.recordId}` };
    },
});
mock(path.join(SERVER, 'routes/transcriptions/shared'), {
    resolveAccessContext: async () => ({ orgIds: ['org1'], userGroupIds: ['g1'], isSuperAdmin: false }),
});
mock(path.join(SERVER, 'core/automationRunner'), {
    executeAutomation: async (automation, opts) => {
        state.executions.push({ automation, opts });
        if (state.resolveRun) await state.resolveRun();
        return nextRun();
    },
    resumeFromStep: async (runId, stepId, opts) => {
        state.resumes.push({ runId, stepId, opts });
        if (state.resolveRun) await state.resolveRun();
        return nextRun();
    },
});

const router = require('./formPublic');
const { issueCsrf } = require(path.join(SERVER, 'auth/publicShareToken'));
const { MIN_FORM_AGE_MS, HONEYPOT_FIELD, MAX_SUBMISSION_BYTES, QUEUE_DEPTH, UPLOAD_QUOTA_FILES } = router._constants;
const { MAX_RENDERED_DESCRIPTION_LEN } = require(path.join(SERVER, 'automation/formTriggerContract'));

function findHandler(method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack[layer.route.stack.length - 1].handle;
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}
const getForm = findHandler('get', '/form/:token');
const postUpload = findHandler('post', '/form/:token/upload');
const postSubmit = findHandler('post', '/form/:token');
const postPick = findHandler('post', '/form/:token/pick');
const getSession = findHandler('get', '/form/:token/s/:sid');
const getDownload = findHandler('get', '/form/:token/s/:sid/file/:fileId');
const openInNotebooks = findHandler('post', '/form/:token/s/:sid/file/:fileId/notebook');
const saveTextToNotebook = findHandler('post', '/form/:token/s/:sid/notebook');
const postSession = findHandler('post', '/form/:token/s/:sid');

/**
 * A response double that is ALSO a real Writable, because the download route
 * pipes a stream into it — a plain object with a write() method is not enough
 * for stream.pipe(), which wires up 'drain'/'error'/'finish' itself.
 */
function makeRes() {
    const { Writable } = require('stream');
    const chunks = [];
    const res = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
    res.statusCode = 200;
    res.body = null;
    res.headers = {};
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.set = (k, v) => { res.headers[String(k).toLowerCase()] = v; return res; };
    res.setHeader = res.set;
    res.bytes = () => Buffer.concat(chunks);
    return res;
}
function makeReq({ token = TOKEN, sid = null, body = {}, headers = {}, file = null, params = {}, session } = {}) {
    const h = { 'content-type': 'application/json', 'user-agent': 'test', ...headers };
    // `params` carries the extra route parameters some endpoints take (the
    // download route's :fileId).
    return {
        params: { token, ...(sid ? { sid } : {}), ...params },
        body, file, headers: h, ip: '1.2.3.4',
        // A form is only openable by a signed-in member of the owning org, so
        // the default request is one. `session` overrides it per test.
        session: session === undefined ? { user: { id: 'colleague1', organizationId: 'org1' } } : session,
        get: (n) => h[String(n).toLowerCase()],
    };
}
const flushAsync = () => new Promise(r => setImmediate(() => setImmediate(r)));

function submissionBody(extra = {}) {
    return {
        csrf: issueCsrf(TOKEN),
        issuedAt: Date.now() - MIN_FORM_AGE_MS - 1000,
        email: 'a@b.nl',
        topic: 'Sales',
        ...extra,
    };
}

beforeEach(resetState);

// ── GET ───────────────────────────────────────────────

test('GET returns the render config, a CSRF token and no-store headers', async () => {
    const res = makeRes();
    await getForm(makeReq(), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.form.title, 'Contact us');
    assert.deepStrictEqual(res.body.form.fields.map(f => f.name), ['email', 'topic', 'attachment']);
    assert.ok(res.body.csrf);
    assert.match(res.headers['cache-control'], /no-store/);
    assert.match(res.headers['x-robots-tag'], /noindex/);
});

// ── signed-in only ────────────────────────────────────
//
// The form used to be open to whoever held the link. It is now reachable only
// from inside the workspace, by a signed-in member of the organisation that
// owns it (PUBLIC_FORMS_ENABLED in formPublic.js). Everything below answers
// 404 rather than 403 — the same answer an unknown token gets, so probing
// cannot tell "not yours" from "does not exist".

test('an anonymous visitor holding the link gets nothing', async () => {
    const res = makeRes();
    await getForm(makeReq({ session: null }), res);
    assert.strictEqual(res.statusCode, 404);
});

test('a signed-in user from another organisation gets nothing either', async () => {
    const res = makeRes();
    await getForm(makeReq({ session: { user: { id: 'outsider', organizationId: 'other-org' } } }), res);
    assert.strictEqual(res.statusCode, 404);
});

test('a colleague in the owning organisation may open it', async () => {
    // Org membership is the boundary: if you can see the form in the Forms
    // menu, you can open it — you need not be the one who built it.
    const res = makeRes();
    await getForm(makeReq({ session: { user: { id: 'colleague2', organizationId: 'org1' } } }), res);
    assert.strictEqual(res.statusCode, 200);
});

test('with no organisation on the owner, only the owner may open it', async () => {
    // Matching "no org" to "no org" would let every orgless account on a
    // shared install open each other's forms.
    state.audience = { userId: 'owner1', organizationId: null };
    const stranger = makeRes();
    await getForm(makeReq({ session: { user: { id: 'someone', organizationId: null } } }), stranger);
    assert.strictEqual(stranger.statusCode, 404);

    const owner = makeRes();
    await getForm(makeReq({ session: { user: { id: 'owner1', organizationId: null } } }), owner);
    assert.strictEqual(owner.statusCode, 200);
});

test('a RESTRICTED form opens for the owner, the people listed and the members of a listed group — and for nobody else in the organisation', async () => {
    state.audience = { userId: 'owner1', organizationId: 'org1', audience: 'restricted', sharedUserIds: ['pat'], sharedGroups: ['grp-finance'] };
    state.groupsOf = { sam: ['grp-finance'], colleague2: ['grp-sales'] };

    const listed = makeRes();
    await getForm(makeReq({ session: { user: { id: 'pat', organizationId: 'org1' } } }), listed);
    assert.strictEqual(listed.statusCode, 200);
    // a person listed by id never needs a group read
    assert.strictEqual(state.groupReads, 0);

    const member = makeRes();
    await getForm(makeReq({ session: { user: { id: 'sam', organizationId: 'org1' } } }), member);
    assert.strictEqual(member.statusCode, 200);
    assert.strictEqual(state.groupReads, 1);

    const other = makeRes();
    await getForm(makeReq({ session: { user: { id: 'colleague2', organizationId: 'org1' } } }), other);
    // same answer an unknown token gets — no "not yours" to probe for
    assert.strictEqual(other.statusCode, 404);

    const owner = makeRes();
    await getForm(makeReq({ session: { user: { id: 'owner1', organizationId: 'org1' } } }), owner);
    assert.strictEqual(owner.statusCode, 200);

    // outside the organisation the list does not matter
    state.groupsOf.outsider = ['grp-finance'];
    const outsider = makeRes();
    await getForm(makeReq({ session: { user: { id: 'outsider', organizationId: 'other-org' } } }), outsider);
    assert.strictEqual(outsider.statusCode, 404);
});

test('a restricted form with nobody on it is the owner\'s alone', async () => {
    state.audience = { userId: 'owner1', organizationId: 'org1', audience: 'restricted', sharedUserIds: [], sharedGroups: [] };
    const res = makeRes();
    await getForm(makeReq({ session: { user: { id: 'colleague2', organizationId: 'org1' } } }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.groupReads, 0);
});

test('submitting is gated too, not just rendering', async () => {
    // The gate lives in loadForm, so every endpoint inherits it — a caller who
    // cannot render the form cannot post to it either.
    const res = makeRes();
    await postSubmit(makeReq({ body: submissionBody(), session: { user: { id: 'outsider', organizationId: 'other-org' } } }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.executions.length, 0, 'no run started');
});

test('an unknown token, a paused routine and a non-form trigger are all the SAME 404', async () => {
    // Distinguishing them would turn the endpoint into an oracle for "does this
    // token exist".
    const unknown = makeRes();
    await getForm(makeReq({ token: OTHER_TOKEN }), unknown);
    assert.strictEqual(unknown.statusCode, 404);

    state.active = false;
    const paused = makeRes();
    await getForm(makeReq(), paused);
    assert.strictEqual(paused.statusCode, 404);
    assert.deepStrictEqual(paused.body, unknown.body);

    state.active = true;
    state.triggerKind = 'webhook';
    const wrongKind = makeRes();
    await getForm(makeReq(), wrongKind);
    assert.strictEqual(wrongKind.statusCode, 404);
    assert.deepStrictEqual(wrongKind.body, unknown.body);
});

test('a malformed token never reaches the database', async () => {
    const res = makeRes();
    await getForm(makeReq({ token: '../../etc/passwd' }), res);
    assert.strictEqual(res.statusCode, 404);
});

// ── BFSF-437: multiPage must see a form_page inside a flowlet ────────────────
//
// A form_page can live inside definition.layers[key].steps (an inline flowlet
// reached from the trigger via call_layer), and the runtime dispatcher walks
// into layers and pauses there correctly. This route's multiPage flag used to
// scan only the top-level definition.steps, so a visitor never saw the flag
// flip — they got the single-page thank-you card while the run sat paused on
// the flowlet's form_page forever, with no way to resume it.

test('multiPage is true when the only form_page step lives inside a flowlet', async () => {
    state.definitionOverride = {
        trigger: { id: 'trg', type: 'trigger', kind: 'form', form: FORM },
        steps: [
            { id: 'cl1', type: 'call_layer', layerKey: 'followup' },
        ],
        layers: {
            followup: {
                steps: [
                    { id: 'fp1', type: 'form_page', form: PAGE_2 },
                ],
            },
        },
    };
    const res = makeRes();
    await getForm(makeReq(), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.form.multiPage, true,
        'a form_page nested in a call_layer flowlet must still flip the flag');
});

test('multiPage is false for a single-page form with no form_page step anywhere', async () => {
    // The default fixture definition (trigger only, no steps/layers) is the
    // baseline: nothing here is a form_page, on the trigger or off it.
    const res = makeRes();
    await getForm(makeReq(), res);
    assert.strictEqual(res.body.form.multiPage, false);
});

test('multiPage does not false-positive on the trigger itself', async () => {
    // walkAllSteps also visits triggers (isTrigger=true), but a trigger carries
    // `type: 'trigger'` with a separate `kind` field (e.g. 'form') — never
    // `type: 'form_page'` — so a form whose ONLY node is its trigger must read
    // as single-page.
    state.definitionOverride = { trigger: { id: 'trg', type: 'trigger', kind: 'form', form: FORM } };
    const res = makeRes();
    await getForm(makeReq(), res);
    assert.strictEqual(res.body.form.multiPage, false);
});

// ── submit ────────────────────────────────────────────

test('a valid submission starts exactly one run with the answers on trigger.output', async () => {
    const res = makeRes();
    await postSubmit(makeReq({ body: submissionBody() }), res);
    await flushAsync();
    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(state.executions.length, 1);
    const { opts } = state.executions[0];
    assert.strictEqual(opts.triggerKind, 'form');
    assert.strictEqual(opts.triggerPayload.email, 'a@b.nl');
    assert.strictEqual(opts.triggerPayload.topic, 'Sales');
    assert.strictEqual(state.touched, 1);
});

test('submission metadata rides on trigger.headers, never inside trigger.output', async () => {
    // A form with a field called `submitted_at` must not be shadowed by ours.
    await postSubmit(makeReq({ body: submissionBody() }), makeRes());
    await flushAsync();
    const { opts } = state.executions[0];
    assert.strictEqual(opts.triggerHeaders.form_page_id, TOKEN);
    assert.ok(opts.triggerHeaders.submitted_at);
    assert.strictEqual(opts.triggerPayload.submitted_at, undefined);
    assert.strictEqual(opts.triggerPayload.form_page_id, undefined);
});

test('a bad or missing CSRF token is refused', async () => {
    const missing = makeRes();
    await postSubmit(makeReq({ body: { email: 'a@b.nl' } }), missing);
    assert.strictEqual(missing.statusCode, 403);

    const wrongForm = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ csrf: issueCsrf(OTHER_TOKEN) }) }), wrongForm);
    assert.strictEqual(wrongForm.statusCode, 403);
    assert.strictEqual(state.executions.length, 0);
});

test('the honeypot answers 200 and runs nothing — the bot learns no difference', async () => {
    const res = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ [HONEYPOT_FIELD]: 'http://spam' }) }), res);
    await flushAsync();
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { accepted: true });
    assert.strictEqual(state.executions.length, 0);
});

test('a submission posted faster than a human could type is silently dropped', async () => {
    const res = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ issuedAt: Date.now() }) }), res);
    await flushAsync();
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.executions.length, 0);
});

test('every missing/invalid answer comes back per field, with no run', async () => {
    const res = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ email: '', topic: 'Billing' }) }), res);
    await flushAsync();
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body.fields.map(f => f.field).sort(), ['email', 'topic']);
    assert.strictEqual(state.executions.length, 0);
});

test('a replayed nonce is accepted but does NOT run a second time', async () => {
    const body = submissionBody({ nonce: 'abcd1234' });
    const first = makeRes();
    await postSubmit(makeReq({ body }), first);
    await flushAsync();
    assert.strictEqual(first.statusCode, 202);

    const second = makeRes();
    await postSubmit(makeReq({ body: { ...body, issuedAt: body.issuedAt } }), second);
    await flushAsync();
    assert.strictEqual(second.statusCode, 200);
    assert.strictEqual(second.body.duplicate, true);
    assert.strictEqual(state.executions.length, 1);
});

test('an oversized body is refused before it is looked at', async () => {
    const guard = router.stack
        .find(l => l.route?.path === '/form/:token' && l.route.methods.post)
        .route.stack.map(s => s.handle)
        .find(h => h.name === 'contentLengthGuard');
    const res = makeRes();
    let nexted = false;
    guard(makeReq({ headers: { 'content-length': String(MAX_SUBMISSION_BYTES + 1) } }), res, () => { nexted = true; });
    assert.strictEqual(res.statusCode, 413);
    assert.strictEqual(nexted, false);
});

test('concurrent submissions all run — the runner would have cancelled the second', async () => {
    // automationRunner single-flights live runs, so without the FIFO the second
    // visitor's answer is silently thrown away.
    let release;
    const gate = new Promise(r => { release = r; });
    state.resolveRun = () => gate;

    const r1 = makeRes(); const r2 = makeRes(); const r3 = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'n1', email: 'one@b.nl' }) }), r1);
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'n2', email: 'two@b.nl' }) }), r2);
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'n3', email: 'three@b.nl' }) }), r3);
    assert.deepStrictEqual([r1.statusCode, r2.statusCode, r3.statusCode], [202, 202, 202]);
    // Serialised: only the first is in flight while the gate is shut.
    await flushAsync();
    assert.strictEqual(state.executions.length, 1);

    state.resolveRun = null;
    release();
    await flushAsync();
    await flushAsync();
    assert.strictEqual(state.executions.length, 3);
    assert.deepStrictEqual(
        state.executions.map(e => e.opts.triggerPayload.email),
        ['one@b.nl', 'two@b.nl', 'three@b.nl'],
    );
});

test('a full queue answers 503 rather than dropping the submission silently', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    state.resolveRun = () => gate;
    for (let i = 0; i < QUEUE_DEPTH + 1; i += 1) {
        await postSubmit(makeReq({ body: submissionBody({ nonce: `q${i}` }) }), makeRes());
    }
    const overflow = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'overflow' }) }), overflow);
    assert.strictEqual(overflow.statusCode, 503);
    state.resolveRun = null;
    release();
    await flushAsync();
});

// ── uploads ───────────────────────────────────────────

function uploadReq(overrides = {}) {
    return makeReq({
        body: { csrf: issueCsrf(TOKEN), field: 'attachment' },
        file: { buffer: Buffer.from('%PDF-1.4 hello'), size: 14, mimetype: 'application/pdf', originalname: 'note.pdf' },
        ...overrides,
    });
}

test('a clean upload is stored and ledgered, and returns a fileId', async () => {
    const res = makeRes();
    await postUpload(uploadReq(), res);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.fileId);
    assert.strictEqual(res.body.filename, 'note.pdf');
    assert.strictEqual(state.uploaded.length, 1);
    // Owner-prefixed so anonymous bytes are attributed to the routine's owner.
    assert.match(state.uploaded[0], /^automation-forms\/owner1\/auto1\//);
});

test('a dirty scan deletes the blob, writes no ledger row and answers 422', async () => {
    state.scanClean = false;
    const res = makeRes();
    await postUpload(uploadReq(), res);
    assert.strictEqual(res.statusCode, 422);
    assert.strictEqual(state.uploads.size, 0);
    assert.strictEqual(state.deleted.length, 1);
    assert.strictEqual(state.deleted[0], state.uploaded[0]);
});

test('a file bigger than the field allows is refused', async () => {
    const res = makeRes();
    await postUpload(uploadReq({ file: { buffer: Buffer.alloc(8), size: 6 * 1024 * 1024, mimetype: 'application/pdf', originalname: 'big.pdf' } }), res);
    assert.strictEqual(res.statusCode, 413);
    assert.strictEqual(state.uploaded.length, 0);
});

test('the per-form quota stops an anonymous flood', async () => {
    state.usage = { files: UPLOAD_QUOTA_FILES, bytes: 0 };
    const res = makeRes();
    await postUpload(uploadReq(), res);
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(state.uploaded.length, 0);
});

test('uploads need a valid CSRF token too', async () => {
    const res = makeRes();
    await postUpload(uploadReq({ body: { csrf: 'nope', field: 'attachment' } }), res);
    assert.strictEqual(res.statusCode, 403);
});

test('a submission claims its upload exactly once and carries a descriptor, never bytes', async () => {
    const up = makeRes();
    await postUpload(uploadReq(), up);
    const { fileId } = up.body;

    const res = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'f1', attachment: { kind: 'form_upload', fileId } }) }), res);
    await flushAsync();
    assert.strictEqual(res.statusCode, 202);
    const value = state.executions[0].opts.triggerPayload.attachment;
    assert.strictEqual(value.kind, 'form_upload');
    assert.strictEqual(value.filename, 'note.pdf');
    assert.strictEqual(value.buffer, undefined);

    // A second submission cannot re-claim the same file.
    const again = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'f2', attachment: { kind: 'form_upload', fileId } }) }), again);
    await flushAsync();
    assert.strictEqual(again.statusCode, 400);
    assert.strictEqual(again.body.fields[0].field, 'attachment');
    assert.strictEqual(state.executions.length, 1);
});

test('a file id from another form cannot be attached here', async () => {
    state.uploads.set('foreign', { id: 'foreign', formPageId: OTHER_TOKEN, filename: 'x', claimedAt: null });
    const res = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'x1', attachment: { kind: 'form_upload', fileId: 'foreign' } }) }), res);
    await flushAsync();
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(state.executions.length, 0);
});

// ── Multi-page: session poll + resume ─────────────────────────────────────
//
// After the first submission the browser stays on the same /f/<token> URL and
// polls its session. The session carries no status of its own — everything is
// derived from the run row, so these tests drive the run state directly.

/** Submit page one and return the session id the visitor got back. */
async function startSession(body = {}) {
    const res = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ nonce: `s${state.sessions.size}`, ...body }) }), res);
    await flushAsync();
    assert.strictEqual(res.statusCode, 202, JSON.stringify(res.body));
    return res.body.sessionId;
}

const awaitingRun = (id, stepId, form) => putRun(id, 'awaiting_form', {
    awaitingStepId: stepId,
    steps: [{ stepId, status: 'awaiting_form', output: { form } }],
});

test('a submission hands back a session id the browser can poll', async () => {
    const sid = await startSession();
    assert.match(sid, /^[a-f0-9]{24,64}$/, 'the session id is a credential, not a counter');
    // …and it is pointed at the run the queue produced.
    assert.strictEqual(state.sessions.get(sid).runId, 'run1');
});

test('polling reports working, then the next page, then done', async () => {
    state.runQueue = [{ id: 'runA' }];
    const sid = await startSession();

    // Still executing.
    putRun('runA', 'running');
    let res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'working');

    // Paused on page two.
    awaitingRun('runA', 'fp1', PAGE_2);
    res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'form');
    assert.strictEqual(res.body.stepId, 'fp1');
    assert.strictEqual(res.body.form.title, 'Nearly there');
    assert.ok(res.body.csrf, 'a fresh CSRF for this page');
    assert.ok(res.body.issuedAt);

    // Finished, with a closing summary.
    putRun('runA', 'success', {
        steps: [
            { stepId: 'fp1', status: 'success', output: { address: 'Main St 1' } },
            { stepId: 'bye', status: 'success', output: { mode: 'ending', form: { title: 'All done', description: 'Ticket T-9' } } },
        ],
    });
    res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'done');
    assert.strictEqual(res.body.ending.title, 'All done');
    assert.strictEqual(res.body.ending.description, 'Ticket T-9');
});

test('a finished run with no closing page still reports done, with no ending', async () => {
    state.runQueue = [{ id: 'runB' }];
    const sid = await startSession();
    putRun('runB', 'success', { steps: [{ stepId: 's1', status: 'success', output: { ok: true } }] });
    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'done');
    assert.strictEqual(res.body.ending, null);
});

test('a failed run never leaks the internal error to the visitor', async () => {
    state.runQueue = [{ id: 'runC' }];
    const sid = await startSession();
    state.runs.set('runC', {
        id: 'runC', status: 'error', automationId: 'auto1',
        error: 'ECONNREFUSED 10.0.0.5:5432 while calling internal-billing',
    });
    state.runSteps.set('runC', []);
    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'error');
    const json = JSON.stringify(res.body);
    assert.strictEqual(json.includes('10.0.0.5'), false);
    assert.strictEqual(json.includes('billing'), false);
});

test('an approval gate reads as "still working" — the visitor cannot act on it', async () => {
    state.runQueue = [{ id: 'runD' }];
    const sid = await startSession();
    putRun('runD', 'awaiting_approval', { awaitingStepId: 'gate' });
    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'working');
});

test('an unknown session, and one minted on another form, are both a plain 404', async () => {
    const sid = await startSession();
    let res = makeRes();
    await getSession(makeReq({ sid: 'd'.repeat(48) }), res);
    assert.strictEqual(res.statusCode, 404);
    // Real id, wrong form token — getFormSession is scoped to the page.
    state.sessions.get(sid).formPageId = OTHER_TOKEN;
    res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.statusCode, 404);
});

test('an expired session says so instead of pretending to work', async () => {
    const sid = await startSession();
    state.sessions.get(sid).expiresAt = new Date(Date.now() - 1000).toISOString();
    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'expired');
});

test('answering page two resumes the paused run with the coerced answers', async () => {
    state.runQueue = [{ id: 'runE' }];
    const sid = await startSession();
    awaitingRun('runE', 'fp1', PAGE_2);

    state.runQueue = [{ id: 'runE2' }];
    const res = makeRes();
    await postSession(makeReq({
        sid,
        body: { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'p2a', address: 'Main Street 1', ignored: 'nope' },
    }), res);
    await flushAsync();

    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(state.resumes.length, 1);
    const [resume] = state.resumes;
    assert.strictEqual(resume.runId, 'runE');
    assert.strictEqual(resume.stepId, 'fp1');
    assert.deepEqual({ ...resume.opts.decision }, { address: 'Main Street 1', proof: null });
    // Undeclared keys never reach the flow.
    assert.strictEqual('ignored' in resume.opts.decision, false);
    // The session follows the CHILD run, so the next poll watches the right one.
    assert.strictEqual(state.sessions.get(sid).runId, 'runE2');
});

test('the resume carries rootStepId and triggerHeaders back into the run', async () => {
    // Neither survives on the run row; without them a form on a secondary
    // trigger resumes from the wrong node and trigger.headers.* goes blank.
    state.runQueue = [{ id: 'runF' }];
    const sid = await startSession();
    awaitingRun('runF', 'fp1', PAGE_2);

    const res = makeRes();
    await postSession(makeReq({ sid, body: { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'p2b', address: 'x' } }), res);
    await flushAsync();

    const { opts } = state.resumes[0];
    assert.strictEqual(opts.rootStepId, null);
    assert.strictEqual(opts.triggerHeaders.form_page_id, TOKEN);
    assert.ok(opts.triggerHeaders.submitted_at);
});

test('a missing required answer is rejected per field and the run stays paused', async () => {
    state.runQueue = [{ id: 'runG' }];
    const sid = await startSession();
    awaitingRun('runG', 'fp1', PAGE_2);

    const res = makeRes();
    await postSession(makeReq({ sid, body: { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'p2c', address: '' } }), res);
    await flushAsync();

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.fields[0].field, 'address');
    assert.strictEqual(state.resumes.length, 0, 'the run is still waiting for a real answer');
});

test('page two CSRF is bound to the session, so page one\'s token is not enough', async () => {
    state.runQueue = [{ id: 'runH' }];
    const sid = await startSession();
    awaitingRun('runH', 'fp1', PAGE_2);

    const res = makeRes();
    await postSession(makeReq({ sid, body: { csrf: issueCsrf(TOKEN), nonce: 'p2d', address: 'x' } }), res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(state.resumes.length, 0);
});

test('a double-clicked page two resumes exactly once', async () => {
    state.runQueue = [{ id: 'runI' }];
    const sid = await startSession();
    awaitingRun('runI', 'fp1', PAGE_2);

    const body = { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'samenonce', address: 'x' };
    const first = makeRes();
    await postSession(makeReq({ sid, body }), first);
    await flushAsync();
    const second = makeRes();
    await postSession(makeReq({ sid, body }), second);
    await flushAsync();

    assert.strictEqual(first.statusCode, 202);
    assert.strictEqual(second.body.duplicate, true);
    assert.strictEqual(state.resumes.length, 1);
});

test('answering a run that is not paused is a 404, not a crash', async () => {
    state.runQueue = [{ id: 'runJ' }];
    const sid = await startSession();
    putRun('runJ', 'success');
    const res = makeRes();
    await postSession(makeReq({ sid, body: { csrf: issueCsrf(`${TOKEN}:${sid}`), address: 'x' } }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.resumes.length, 0);
});

test('an upload on page two is checked against the PAGE fields, not the trigger fields', async () => {
    state.runQueue = [{ id: 'runK' }];
    const sid = await startSession();
    awaitingRun('runK', 'fp1', PAGE_2);

    const res = makeRes();
    await postUpload(makeReq({
        body: { csrf: issueCsrf(`${TOKEN}:${sid}`), sessionId: sid, field: 'proof' },
        file: { buffer: Buffer.from('pdf'), size: 3, mimetype: 'application/pdf', originalname: 'p.pdf' },
    }), res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(res.body.fileId);

    // A session upload must carry the session-bound CSRF, not page one's.
    const wrong = makeRes();
    await postUpload(makeReq({
        body: { csrf: issueCsrf(TOKEN), sessionId: sid, field: 'proof' },
        file: { buffer: Buffer.from('pdf'), size: 3, mimetype: 'application/pdf', originalname: 'p.pdf' },
    }), wrong);
    assert.strictEqual(wrong.statusCode, 403);
});

test('resumes go through the SAME queue as first submissions — two visitors, no lost answers', async () => {
    // Without this the second unit of work races the first, the runner replies
    // "Skipped: automation already running", and a real person's answer is gone.
    let release;
    const gate = new Promise(r => { release = r; });
    state.resolveRun = () => gate;

    state.runQueue = [{ id: 'runL' }, { id: 'runM' }];
    const a = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'q1' }) }), a);
    const b = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'q2' }) }), b);
    await flushAsync();

    assert.strictEqual(a.statusCode, 202);
    assert.strictEqual(b.statusCode, 202);
    assert.strictEqual(state.executions.length, 1, 'the second waits its turn rather than racing');

    release();
    state.resolveRun = null;
    await flushAsync();
    await flushAsync();
    assert.strictEqual(state.executions.length, 2, 'and then it runs');
});

test('a run cancelled by another pod is retried instead of losing the answers', async () => {
    // Cross-pod: our in-memory queue cannot see theirs, so the runner hands
    // back a cancelled run. Backing off and retrying is the difference between
    // a slow form and a silently dropped submission.
    const { RETRY_DELAYS_MS } = router._constants;
    assert.ok(RETRY_DELAYS_MS.length >= 3, 'there is a real backoff ladder');

    state.runQueue = [
        { id: 'lost1', status: 'cancelled', error: 'Skipped: automation already running' },
        { id: 'won', status: 'success' },
    ];
    const sid = await startSession();

    // The first attempt lost the race; the queue keeps going in the background.
    await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[0] + 200));
    assert.strictEqual(state.executions.length, 2, 'it tried again');
    assert.strictEqual(state.sessions.get(sid).runId, 'won', 'and the session follows the run that stuck');
});

// ── W5-15: the PARENT run has to be closed out when a resume lands ──────────
//
// resumeFromStep starts a CHILD run and nothing finalised the parent, so it sat
// in 'awaiting_form' forever — until reapExpiredFormWaits flipped a form the
// visitor had actually COMPLETED to a "FormExpired" error and the owner's run
// history recorded a failure for a submission that worked. The approve-step
// endpoint has always closed its parent out this way.

test('completing a page finalises the parent run instead of leaving it awaiting_form', async () => {
    state.runQueue = [{ id: 'parent1' }, { id: 'child1' }];
    const sid = await startSession();
    awaitingRun('parent1', 'fp1', PAGE_2);

    const res = makeRes();
    await postSession(makeReq({
        sid,
        body: { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'p2', address: 'Main Street 1' },
    }), res);
    assert.strictEqual(res.statusCode, 202, JSON.stringify(res.body));
    await flushAsync();
    await flushAsync();

    assert.strictEqual(state.resumes.length, 1, 'the resume ran');
    const parent = state.runs.get('parent1');
    assert.strictEqual(parent.status, 'success',
        'the parent must not stay awaiting_form — the reaper would later call this a FormExpired failure');
    assert.strictEqual(parent.awaitingStepId, null, 'and it no longer advertises a step to resume from');
    assert.match(parent.summary, /child run child1/, 'the summary points at the run carrying the continuation');
});

test('the session follows the CHILD run before the parent is closed out', async () => {
    // Ordering matters: the poll reads session.runId. A parent flipped to
    // 'success' while the session still pointed at it would answer
    // `state: 'done'` and end the visitor's journey before the child had a
    // chance to serve the next page.
    state.runQueue = [{ id: 'parent2' }, { id: 'child2' }];
    const sid = await startSession();
    awaitingRun('parent2', 'fp1', PAGE_2);

    const res = makeRes();
    await postSession(makeReq({
        sid,
        body: { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'p3', address: 'Main Street 2' },
    }), res);
    await flushAsync();
    await flushAsync();

    assert.strictEqual(state.sessions.get(sid).runId, 'child2', 'the session now points at the child run');
    assert.strictEqual(state.runs.get('parent2').status, 'success');
});

test('a resume that LOST a cross-pod race leaves the parent paused for the retry', async () => {
    state.runQueue = [
        { id: 'parent3' },
        { id: 'lostChild', status: 'cancelled', error: 'Skipped: automation already running' },
        { id: 'child3' },
    ];
    const sid = await startSession();
    awaitingRun('parent3', 'fp1', PAGE_2);

    const res = makeRes();
    await postSession(makeReq({
        sid,
        body: { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'p4', address: 'Main Street 3' },
    }), res);
    assert.strictEqual(res.statusCode, 202);
    await flushAsync();

    assert.strictEqual(state.runs.get('parent3').status, 'awaiting_form',
        'finalising on a lost race would strand the answers the retry is about to deliver');

    const { RETRY_DELAYS_MS } = router._constants;
    await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[0] + 200));
    assert.strictEqual(state.resumes.length, 2, 'it tried again');
    assert.strictEqual(state.runs.get('parent3').status, 'success', 'and closed the parent out once it stuck');
});

// ── An ANSWERED page must not be served back while the resume is in flight ──
//
// The POST acks immediately and resumes in the background. Until the child run
// lands, the session still points at the parent — still `awaiting_form` on the
// step just answered — so the poll handed the same page straight back. The
// visitor answered it again, and every resubmission started ANOTHER child from
// the same parent: a two-question routine re-ran question one, and everything
// between the two questions, once per impatient click. On a slow step that
// window is tens of seconds wide, which is exactly when someone tries again.

test('the page just answered is not served again while the resume is still running', async () => {
    state.runQueue = [{ id: 'parentR' }, { id: 'childR' }];
    const sid = await startSession();
    awaitingRun('parentR', 'fp1', PAGE_2);

    // Hold the resume open, the way a 30-second research step would.
    let release;
    state.resolveRun = () => new Promise(r => { release = r; });

    const res = makeRes();
    await postSession(makeReq({
        sid,
        body: { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'race1', address: 'Main Street 9' },
    }), res);
    assert.strictEqual(res.statusCode, 202, JSON.stringify(res.body));
    await flushAsync();

    // Mid-flight: the run is still 'awaiting_form' and the session still points
    // at it. The visitor must be told to wait, not asked the same thing twice.
    const poll = makeRes();
    await getSession(makeReq({ sid }), poll);
    assert.strictEqual(poll.body.state, 'working',
        'the answered page must not come back — that is what made the visitor resubmit');

    release();
    state.resolveRun = null;
    await flushAsync();
    await flushAsync();
    assert.strictEqual(state.resumes.length, 1, 'exactly one resume, not one per poll');
});

test('a resume that never ran leaves the page answerable again', async () => {
    // The mirror image: clearing the pointer must not strand an answer on a run
    // nobody can reach. If resumeFromStep throws, the page goes back up.
    state.runQueue = [{ id: 'parentT' }];
    const sid = await startSession();
    awaitingRun('parentT', 'fp1', PAGE_2);

    state.resolveRun = async () => { throw new Error('runner exploded'); };

    const res = makeRes();
    await postSession(makeReq({
        sid,
        body: { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'race2', address: 'Main Street 10' },
    }), res);
    assert.strictEqual(res.statusCode, 202, JSON.stringify(res.body));
    await flushAsync();
    await flushAsync();
    state.resolveRun = null;

    assert.strictEqual(state.runs.get('parentT').awaitingStepId, 'fp1',
        'the visitor can answer again instead of being stuck on a silent failure');
});

// ── "Just a moment…" should say WHICH moment ─────────────────────────────────
//
// A visitor who answered a question waits out whatever comes next — a web
// search, a model call, a document being written. A bare spinner for ninety
// seconds reads as broken. The poll now names the step, including the flowlet
// it stepped into, and nothing else: labels on the path, no ids, no step
// types, no tool names, no outputs.

const PROGRESS_DEF = {
    trigger: { id: 'trg', type: 'trigger', kind: 'form' },
    steps: [
        { id: 'set1', type: 'set', label: '1. Merkprofiel laden' },
        { id: 'cl1', type: 'call_layer', layerKey: 'research', label: '7. Wat scoort er al' },
        { id: 'cl2', type: 'call_layer', layerKey: 'plain', label: '8. Iets anders' },
        { id: 'nolabel', type: 'set' },
    ],
    layers: {
        research: {
            title: 'Wat scoort er al',
            description: 'Searches Google for a given term and lets AI analyse top-ranking pages.',
            steps: [
                { id: 'a1', type: 'integration_action', label: 'Google-resultaten ophalen' },
                { id: 'out', type: 'layer_output', label: 'Return' },
            ],
        },
        plain: {
            title: 'Iets anders',
            steps: [{ id: 'b1', type: 'set', label: 'Een stap' }],
        },
    },
};

function runningRun(id, stepId) {
    state.definitionOverride = PROGRESS_DEF;
    putRun(id, 'running', {
        steps: [
            { stepId: 'set1', status: 'success', output: {} },
            { stepId, status: 'running', output: null },
        ],
    });
}

test('while working, the poll names the step — flowlet first, then the node inside it', async () => {
    const sid = await startSession();
    runningRun('run1', 'cl1/a1');

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'working');
    assert.deepStrictEqual(res.body.progress, ['7. Wat scoort er al', 'Google-resultaten ophalen'],
        'the trail is the flowlet the run stepped into, then the node it is on');
});

// A step's NAME says where the routine is; the flowlet's DESCRIPTION says what
// it is doing. That is the difference between a wait that reads as work and one
// that reads as a hang, so it rides along with the trail.

test('the running flowlet sends its description along with the trail', async () => {
    const sid = await startSession();
    runningRun('run1', 'cl1/a1');

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(
        res.body.progressNote,
        'Searches Google for a given term and lets AI analyse top-ranking pages.',
    );
});

test('a flowlet without a description sends no note rather than an empty one', async () => {
    const sid = await startSession();
    runningRun('run1', 'cl2/b1');

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.deepStrictEqual(res.body.progress, ['8. Iets anders', 'Een stap']);
    assert.strictEqual(res.body.progressNote, undefined);
});

test('a step outside any flowlet has no description to send', async () => {
    const sid = await startSession();
    runningRun('run1', 'set1');

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.progressNote, undefined);
});

test('the description is capped — this is a public endpoint and nothing upstream caps it', async () => {
    const sid = await startSession();
    state.definitionOverride = {
        ...PROGRESS_DEF,
        layers: { ...PROGRESS_DEF.layers, research: { ...PROGRESS_DEF.layers.research, description: 'x'.repeat(5000) } },
    };
    putRun('run1', 'running', {
        steps: [{ stepId: 'cl1/a1', status: 'running', output: null }],
    });

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.progressNote.length, 400);
});

test('a top-level step is its own one-line trail', async () => {
    const sid = await startSession();
    runningRun('run1', 'set1');

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.deepStrictEqual(res.body.progress, ['1. Merkprofiel laden']);
});

test('the trail carries titles only — never ids, types or tool names', async () => {
    const sid = await startSession();
    runningRun('run1', 'cl1/a1');

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    const flat = JSON.stringify(res.body);
    for (const leak of ['cl1', 'a1', 'call_layer', 'integration_action', 'research']) {
        assert.ok(!flat.includes(leak), `the visitor must not see "${leak}"`);
    }
});

test('an unnamed step reports no progress rather than leaking what it is', async () => {
    const sid = await startSession();
    runningRun('run1', 'nolabel');

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'working');
    assert.strictEqual(res.body.progress, undefined, 'no label, nothing to say');
});

test('a paused or queued run reports no step at all', async () => {
    // awaiting_approval is a gate the visitor cannot act on; naming the step
    // would tell them the routine is waiting on someone. Queued has not
    // started. Neither should describe itself.
    const sid = await startSession();
    state.definitionOverride = PROGRESS_DEF;
    putRun('run1', 'awaiting_approval', { steps: [{ stepId: 'set1', status: 'running', output: null }] });

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'working');
    assert.strictEqual(res.body.progress, undefined);
});

// The bug the trail tests above could NOT see: they put the running run under
// the session's own pointer, which is a state production never reaches.
//
// A resume starts a CHILD run and the parent is only closed out — and the
// session only re-pointed — once that child has finished. So for the whole
// stretch a visitor is actually waiting, the session pointed at a parent that
// was `awaiting_form` with its step pointer cleared, and the poll answered a
// bare `{state:'working'}`. Every branch that can carry a trail was
// unreachable, and the feature never once appeared on screen.
//
// The poll therefore reads the newest leg of the JOURNEY, not the row the
// session happens to name.

test('the trail comes from the leg that is running, not the parent the session names', async () => {
    const sid = await startSession();
    state.definitionOverride = PROGRESS_DEF;
    // Exactly the mid-resume shape: parent answered (pointer cleared, status
    // untouched), child running one level inside a flowlet, session still on
    // the parent because resumeFromStep has not returned.
    putRun('parentJ', 'awaiting_form', { awaitingStepId: null, steps: [{ stepId: 'fp1', status: 'awaiting_form', output: {} }] });
    putRun('childJ', 'running', {
        rootRunId: 'parentJ',
        steps: [{ stepId: 'cl1/a1', status: 'running', output: null }],
    });
    state.sessions.get(sid).runId = 'parentJ';

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'working');
    assert.deepStrictEqual(res.body.progress, ['7. Wat scoort er al', 'Google-resultaten ophalen'],
        'the visitor sees where the routine actually is');
});

test('the next page is served from the leg that paused, not from the stale parent', async () => {
    const sid = await startSession();
    putRun('parentJ2', 'awaiting_form', { awaitingStepId: null, steps: [] });
    putRun('childJ2', 'awaiting_form', {
        rootRunId: 'parentJ2',
        awaitingStepId: 'fp2',
        steps: [{ stepId: 'fp2', status: 'awaiting_form', output: { form: { ...FORM, title: 'Page two' } } }],
    });
    state.sessions.get(sid).runId = 'parentJ2';

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'form');
    assert.strictEqual(res.body.form.title, 'Page two');
});

test('a journey continued outside the form does not report done early', async () => {
    // An owner approving a paused step from the run history spawns a child and
    // finalises the parent to 'success'. The session never hears about it, so
    // reading its own run would end the visitor's journey mid-routine.
    const sid = await startSession();
    state.definitionOverride = PROGRESS_DEF;
    putRun('parentJ3', 'success', { steps: [] });
    putRun('childJ3', 'running', { rootRunId: 'parentJ3', steps: [{ stepId: 'set1', status: 'running', output: null }] });
    state.sessions.get(sid).runId = 'parentJ3';

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'working', 'still going — the visitor keeps waiting');
});

test('a run that lost the race reads as working, not as a failure', async () => {
    // runQueued backs off and tries again. Telling the visitor "something went
    // wrong" would end a journey over a collision they never caused.
    const sid = await startSession();
    const row = putRun('run1', 'cancelled', { steps: [] });
    row.error = 'Skipped: automation already running';
    state.sessions.get(sid).runId = 'run1';

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'working');
});

// ── Downloading a document the run produced ──────────────────────────────────
//
// A `generate_document` step returns a bare fileId, never a URL. The ONLY way
// to the bytes is through a session that owns the journey which made them, so
// these tests are mostly about who is refused.

/** Register a generated file against a run, as the step's ledger write would. */
function putFile(id, runId, over = {}) {
    state.generatedFiles.set(id, {
        id, runId, automationId: 'auto1', storageKey: `automation-forms/owner1/auto1/${id}`,
        filename: 'offerte.pdf', mimeType: 'application/pdf', size: 13, ...over,
    });
    return state.generatedFiles.get(id);
}

test('a visitor can download the document their own journey produced', async () => {
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('f1', 'run1');

    const res = makeRes();
    await getDownload(makeReq({ sid, params: { fileId: 'f1' } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'application/pdf');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.headers['content-disposition'], /^attachment; filename="offerte\.pdf"/);
    assert.deepStrictEqual(state.streamed, ['automation-forms/owner1/auto1/f1']);
    // pipe() finishes after the handler returns, so wait for the write to land.
    await new Promise(r => res.on('finish', r));
    assert.strictEqual(res.bytes().toString(), '%PDF-1.7 fake', 'the bytes really reach the visitor');
});

// ── Open in Notebooks ─────────────────────────────────
//
// The closing page's other button. It is the download's twin: same token →
// session → journey-runs → generated-file chain, so everything that makes a
// file unreachable there makes it unreachable here.

test('puts the document IN the notebook, as its content', async () => {
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('f1', 'run1');

    const res = makeRes();
    await openInNotebooks(makeReq({ sid, params: { fileId: 'f1' } }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.notebookId, 'nb1');
    // Named after the document, without its extension, and owned by the caller
    // — not by the routine's author.
    assert.strictEqual(state.notebooks[0].name, 'offerte');
    assert.strictEqual(state.notebooks[0].userId, 'colleague1');
    // The text is the notebook's own content. It is NOT an attached source:
    // a source is something you ask questions about, and this is the thing the
    // routine just wrote, sent here to be worked on.
    assert.strictEqual(state.notebookWrites.length, 1);
    assert.strictEqual(state.notebookWrites[0].id, 'nb1');
    assert.strictEqual(
        state.notebookWrites[0].documentContent,
        '<p>Eerste alinea.</p><p>Tweede alinea.</p>',
    );
});

test('parses the real bytes, without a round trip through the browser', async () => {
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('f1', 'run1');

    await openInNotebooks(makeReq({ sid, params: { fileId: 'f1' } }), makeRes());
    assert.deepStrictEqual(state.parsed, [{ bytes: '%PDF-1.7 fake'.length, mimeType: 'application/pdf', filename: 'offerte.pdf' }]);
});

test('keeps HTML a Word document already carries, rather than escaping it', async () => {
    // mammoth returns real markup for a .docx; re-escaping it would show the
    // visitor their own tags.
    state.parsedText = '<h1>Offerte</h1><p>Beste klant</p>';
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('f1', 'run1');

    await openInNotebooks(makeReq({ sid, params: { fileId: 'f1' } }), makeRes());
    assert.strictEqual(state.notebookWrites[0].documentContent, '<h1>Offerte</h1><p>Beste klant</p>');
});

test('escapes plain text so a generated document cannot inject markup', async () => {
    // This text came out of a document a routine wrote, which routinely carries
    // model output, and the notebook editor renders what it is given.
    state.parsedText = 'Hallo <script>alert(1)</script>';
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('f1', 'run1');

    await openInNotebooks(makeReq({ sid, params: { fileId: 'f1' } }), makeRes());
    const html = state.notebookWrites[0].documentContent;
    assert.ok(!html.includes('<script>'), html);
    assert.ok(html.includes('&lt;script&gt;'), html);
});

test('pressing it twice gives two notebooks', async () => {
    // The chosen behaviour: a fresh notebook every time. Writing into an
    // existing one would mean guessing which of the caller's was meant.
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('f1', 'run1');

    await openInNotebooks(makeReq({ sid, params: { fileId: 'f1' } }), makeRes());
    await openInNotebooks(makeReq({ sid, params: { fileId: 'f1' } }), makeRes());
    assert.strictEqual(state.notebooks.length, 2);
});

test('a file from another journey cannot be opened into your notebook', async () => {
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('other', 'someone-elses-run');

    const res = makeRes();
    await openInNotebooks(makeReq({ sid, params: { fileId: 'other' } }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.notebooks.length, 0, 'nothing was created');
});

test('a file whose bytes are already reaped makes no empty notebook', async () => {
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('f1', 'run1');
    state.storageMissing = true;

    const res = makeRes();
    await openInNotebooks(makeReq({ sid, params: { fileId: 'f1' } }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.notebooks.length, 0, 'the notebook is made only after the bytes are in hand');
});

test('an unreadable document says so instead of leaving an empty notebook', async () => {
    state.parseThrows = true;
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('f1', 'run1');

    const res = makeRes();
    await openInNotebooks(makeReq({ sid, params: { fileId: 'f1' } }), res);
    assert.strictEqual(res.statusCode, 422);
    assert.strictEqual(state.notebooks.length, 0);
});

test('a file made by a LATER leg of the same journey is still reachable', async () => {
    // The document is usually produced after a form pause, i.e. on a child run.
    const sid = await startSession();
    putRun('parentD', 'success', { steps: [] });
    putRun('childD', 'success', { rootRunId: 'parentD', steps: [] });
    state.sessions.get(sid).runId = 'parentD';
    putFile('f2', 'childD');

    const res = makeRes();
    await getDownload(makeReq({ sid, params: { fileId: 'f2' } }), res);
    assert.strictEqual(res.statusCode, 200);
});

test("someone else's file is a 404 — holding the id proves nothing", async () => {
    const sid = await startSession();
    putRun('mine', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'mine';
    putFile('theirs', 'a-run-from-another-visitor');

    const res = makeRes();
    await getDownload(makeReq({ sid, params: { fileId: 'theirs' } }), res);
    // 404 and not 403: a wrong id and someone else's file must be
    // indistinguishable, or the endpoint confirms which ids exist.
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(state.streamed, [], 'nothing was read from storage');
});

test('an unknown file id is a 404', async () => {
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';

    const res = makeRes();
    await getDownload(makeReq({ sid, params: { fileId: 'nope' } }), res);
    assert.strictEqual(res.statusCode, 404);
});

test('a ledger row whose bytes are already reaped is a 404, not a 500', async () => {
    // The reaper deletes the blob first and the row second, so this window is
    // normal rather than a fault.
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('gone', 'run1');
    state.storageMissing = true;

    const res = makeRes();
    await getDownload(makeReq({ sid, params: { fileId: 'gone' } }), res);
    state.storageMissing = false;
    assert.strictEqual(res.statusCode, 404);
});

test('a filename with accents or quotes cannot break the header', async () => {
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('f3', 'run1', { filename: 'Beoordeling "café" — señor.pdf' });

    const res = makeRes();
    await getDownload(makeReq({ sid, params: { fileId: 'f3' } }), res);
    const cd = res.headers['content-disposition'];
    // The quoted ASCII part must contain no quote or backslash that could end
    // it early; the real name rides in filename* instead.
    const ascii = /filename="([^"]*)"/.exec(cd)[1];
    assert.ok(!ascii.includes('"') && !ascii.includes(String.fromCharCode(92)), `unsafe ascii fallback: ${ascii}`);
    assert.match(cd, /filename\*=UTF-8''/);
    assert.ok(cd.includes(encodeURIComponent('Beoordeling "café" — señor.pdf')));
});

test('a download field on the served page carries the real file details', async () => {
    const sid = await startSession();
    putRun('run1', 'awaiting_form', {
        awaitingStepId: 'fp1',
        steps: [{
            stepId: 'fp1',
            status: 'awaiting_form',
            output: { form: { ...FORM, fields: [{ name: 'doc', type: 'download', label: 'Je offerte', fileId: 'f9' }] } },
        }],
    });
    state.sessions.get(sid).runId = 'run1';
    putFile('f9', 'run1', { filename: 'offerte-2026.pdf', size: 4242 });

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'form');
    const field = res.body.form.fields.find(f => f.type === 'download');
    assert.strictEqual(field.filename, 'offerte-2026.pdf');
    assert.strictEqual(field.size, 4242);
    assert.strictEqual(field.required, false, 'a display field can never block a submit');
    assert.strictEqual(field.storageKey, undefined, 'the visitor never sees where it is stored');
});

test('a download whose file is gone is dropped, not rendered as a dead button', async () => {
    const sid = await startSession();
    putRun('run1', 'awaiting_form', {
        awaitingStepId: 'fp1',
        steps: [{
            stepId: 'fp1',
            status: 'awaiting_form',
            output: { form: { ...FORM, fields: [{ name: 'doc', type: 'download', label: 'Weg', fileId: 'expired' }] } },
        }],
    });
    state.sessions.get(sid).runId = 'run1';

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'form');
    assert.strictEqual(res.body.form.fields.length, 0, 'the page renders without it');
});

// ── Save to Notebook — the closing page's own TEXT (BFSF-419, Track 1) ────
//
// The common case: no generate_document step at all, so the "result" is just
// the ending page's rendered markdown. There is no file to fetch and
// reparse, so the text rides in the request body — this route's whole job is
// scoping (own session, not someone else's) and a length cap, nothing else.

test('saves the closing page\'s own text into a new notebook', async () => {
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';

    const res = makeRes();
    await saveTextToNotebook(makeReq({ sid, body: { text: '## Waterstralen\n\nEen alinea.', title: 'Mijn SEO-blog' } }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.notebookId, 'nb1');
    // Named after the closing page, and owned by the caller — not by the
    // routine's author.
    assert.strictEqual(state.notebooks[0].name, 'Mijn SEO-blog');
    assert.strictEqual(state.notebooks[0].userId, 'colleague1');
    // Raw markdown, not stripped — same "ship it as-is" choice the .txt
    // download makes, wrapped through the same paragraph/escape pass every
    // notebook write in this file gets.
    assert.strictEqual(state.notebookWrites.length, 1);
    assert.strictEqual(state.notebookWrites[0].id, 'nb1');
    assert.strictEqual(
        state.notebookWrites[0].documentContent,
        '<p>## Waterstralen</p><p>Een alinea.</p>',
    );
});

test('falls back to the form\'s own title when the page sends none', async () => {
    const sid = await startSession();
    const res = makeRes();
    await saveTextToNotebook(makeReq({ sid, body: { text: 'Hallo daar.' } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.notebooks[0].name, 'Contact us');
});

test('escapes plain text so a generated result cannot inject markup', async () => {
    const sid = await startSession();
    const res = makeRes();
    await saveTextToNotebook(makeReq({ sid, body: { text: 'Hallo <script>alert(1)</script>' } }), res);
    assert.strictEqual(res.statusCode, 200);
    const html = state.notebookWrites[0].documentContent;
    assert.ok(!html.includes('<script>'), html);
    assert.ok(html.includes('&lt;script&gt;'), html);
});

test('an unknown or foreign session id is a 404 — the same answer everywhere else in this file', async () => {
    // Never created by startSession(): this is what holding someone ELSE's
    // (or a made-up) session id looks like from here.
    const res = makeRes();
    await saveTextToNotebook(makeReq({ sid: 'f'.repeat(48), body: { text: 'Hallo' } }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.notebooks.length, 0, 'nothing was created');
});

test('an expired session is rejected the same way', async () => {
    const sid = await startSession();
    state.sessions.get(sid).expiresAt = new Date(Date.now() - 1000).toISOString();

    const res = makeRes();
    await saveTextToNotebook(makeReq({ sid, body: { text: 'Hallo' } }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.notebooks.length, 0);
});

test('a session from a DIFFERENT automation is refused, even with a shape-valid id', async () => {
    // getFormSession only matches rows whose formPageId is THIS token, but the
    // route also cross-checks automationId directly — belt and braces against
    // a page ever being re-pointed at another automation.
    const sid = await startSession();
    state.sessions.get(sid).automationId = 'someone-elses-automation';

    const res = makeRes();
    await saveTextToNotebook(makeReq({ sid, body: { text: 'Hallo' } }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.notebooks.length, 0);
});

test('an unauthenticated caller is refused before anything is read or written', async () => {
    const sid = await startSession();
    const res = makeRes();
    await saveTextToNotebook(makeReq({ sid, body: { text: 'Hallo' }, session: null }), res);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(state.notebooks.length, 0);
});

test('empty (or whitespace-only) text is rejected rather than making a blank notebook', async () => {
    const sid = await startSession();
    const res = makeRes();
    await saveTextToNotebook(makeReq({ sid, body: { text: '   ' } }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(state.notebooks.length, 0);
});

test('text past the rendered-description cap is truncated, not rejected outright', async () => {
    const sid = await startSession();
    const res = makeRes();
    await saveTextToNotebook(makeReq({ sid, body: { text: 'x'.repeat(MAX_RENDERED_DESCRIPTION_LEN + 5000) } }), res);
    assert.strictEqual(res.statusCode, 200);
    const inner = state.notebookWrites[0].documentContent.replace(/^<p>|<\/p>$/g, '');
    assert.strictEqual(inner.length, MAX_RENDERED_DESCRIPTION_LEN);
});

// ── POST /pick — an app_pick question's search box ────

/** A form whose second question is answered by picking a Fireflies transcript. */
const PICK_FORM = {
    title: 'Write the meeting up',
    fields: [
        { name: 'email', type: 'email', label: 'Your email', required: true },
        { name: 'call', type: 'app_pick', label: 'Which call?', source: 'fireflies_transcript' },
    ],
};
const withPickForm = () => { state.definitionOverride = { trigger: { id: 'trg', type: 'trigger', kind: 'form', form: PICK_FORM } }; };

test('the browser names a QUESTION; which app that is comes from the declaration', async () => {
    // This is the difference between a picker and "run any integration tool as
    // me": nothing in the request body can steer the search at another app.
    withPickForm();
    const res = makeRes();
    await postPick(makeReq({ body: { csrf: issueCsrf(TOKEN), field: 'call', query: 'kickoff', source: 'gmail_message', tool: 'gmail_send_email' } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.results.map(r => r.id), ['tr_1']);
    assert.strictEqual(state.pickSearches.length, 1);
    assert.strictEqual(state.pickSearches[0].source, 'fireflies_transcript', 'the declared source, not the body\'s');
    assert.strictEqual(state.pickSearches[0].query, 'kickoff');
});

test('the search runs as the signed-in FILLER, with their own org and groups', async () => {
    withPickForm();
    const res = makeRes();
    await postPick(makeReq({ body: { csrf: issueCsrf(TOKEN), field: 'call', query: '' } }), res);
    const { caller } = state.pickSearches[0];
    assert.strictEqual(caller.userId, 'colleague1', 'never the automation owner');
    assert.deepStrictEqual(caller.orgIds, ['org1']);
    assert.deepStrictEqual(caller.userGroupIds, ['g1']);
});

test('a question this page does not ask cannot be searched', async () => {
    withPickForm();
    for (const field of ['email', 'nope', '', undefined]) {
        const res = makeRes();
        await postPick(makeReq({ body: { csrf: issueCsrf(TOKEN), field, query: 'x' } }), res);
        assert.strictEqual(res.statusCode, 400, `field ${JSON.stringify(field)} should be refused`);
    }
    assert.strictEqual(state.pickSearches.length, 0);
});

test('a bad CSRF is refused, and a token that is not a form 404s', async () => {
    withPickForm();
    const bad = makeRes();
    await postPick(makeReq({ body: { csrf: 'nope', field: 'call' } }), bad);
    assert.strictEqual(bad.statusCode, 403);

    const missing = makeRes();
    await postPick(makeReq({ token: OTHER_TOKEN, body: { csrf: issueCsrf(OTHER_TOKEN), field: 'call' } }), missing);
    assert.strictEqual(missing.statusCode, 404);
    assert.strictEqual(state.pickSearches.length, 0);
});

test('someone who may not open the form may not search from it either', async () => {
    withPickForm();
    const res = makeRes();
    await postPick(makeReq({ body: { csrf: issueCsrf(TOKEN), field: 'call' }, session: { user: { id: 'outsider', organizationId: 'org2' } } }), res);
    // 404, like every other refusal on this surface: probing must not tell
    // "not yours" from "does not exist".
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.pickSearches.length, 0);
});

test('"that app is not connected for you" comes back as a reason, not a failure', async () => {
    // It is something the picker prints beside the search box; a 4xx would make
    // the client guess whether the form itself was broken.
    withPickForm();
    state.pickSearchError = 'Fireflies is not connected for your account.';
    const res = makeRes();
    await postPick(makeReq({ body: { csrf: issueCsrf(TOKEN), field: 'call' } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.results, []);
    assert.match(res.body.error, /not connected/);
});

// ── A picked record reaching the run ──────────────────

test('a submitted pick is re-read on the server, and the run gets the record', async () => {
    withPickForm();
    const res = makeRes();
    await postPick(makeReq({ body: { csrf: issueCsrf(TOKEN), field: 'call' } }), res);   // warm, not required

    const submit = makeRes();
    await postSubmit(makeReq({
        body: {
            csrf: issueCsrf(TOKEN),
            issuedAt: Date.now() - MIN_FORM_AGE_MS - 1000,
            email: 'a@b.nl',
            // The browser sends a reference. Any `text` it invented is dropped
            // by the contract before this point.
            call: { kind: 'app_pick', recordId: 'tr_1', title: 'Kickoff met Acme', text: 'I typed this myself' },
        },
    }), submit);
    assert.strictEqual(submit.statusCode, 202);
    await flushAsync();

    assert.strictEqual(state.pickReads.length, 1);
    assert.strictEqual(state.pickReads[0].pick.recordId, 'tr_1');
    assert.strictEqual(state.pickReads[0].withText, true);
    assert.strictEqual(state.pickReads[0].callerId, 'colleague1', 'read as the person submitting');

    const payload = state.executions[0].opts.triggerPayload;
    assert.strictEqual(payload.call.text, 'the text of tr_1', 'the run gets what the SERVER read');
    assert.strictEqual(payload.call.source, 'fireflies_transcript');
});

test('a form with no pick on it reads nothing', async () => {
    const res = makeRes();
    await postSubmit(makeReq({ body: submissionBody() }), res);
    await flushAsync();
    assert.strictEqual(state.pickReads.length, 0);
});
