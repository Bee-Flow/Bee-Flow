'use strict';

/**
 * The shared harness of the form surface's tests (formPublic/*.test.js):
 * every store, the runner and the rate limiter mocked through require.cache,
 * the real router loaded on top, and its handlers looked up by route. Every
 * test drives a route handler directly — the same harness family as
 * events.webhookPayload.test.js.
 *
 * Load it before anything else in a test file: the mocks must be in
 * require.cache before routes/automation/formPublic.js is required.
 */
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..', '..');
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

// One object for the whole process, refilled in place, so every test file
// that imports it sees the same state the mocks below write into.
const state = {};
function resetState() {
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, {
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
        renders: [],
        markingAsks: [],
        webpages: [],
        webpageSlots: [],
        webpageMeta: [],
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
    });
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
    // ── queued form work, persisted on the session (automation/formQueue.js) ──
    setFormSessionPending: async (id, work, leaseMs) => {
        const row = state.sessions.get(id);
        if (row) Object.assign(row, { pendingWork: JSON.parse(JSON.stringify(work)), pendingAttempts: 0, leaseUntil: Date.now() + leaseMs });
    },
    clearFormSessionPending: async (id) => {
        const row = state.sessions.get(id);
        if (row) Object.assign(row, { pendingWork: null, pendingAttempts: 0, leaseUntil: null });
    },
    renewFormSessionLeases: async () => {},
    releaseFormSessionLeases: async (ids, delayMs = 0) => {
        for (const id of ids) {
            const row = state.sessions.get(id);
            if (row?.pendingWork) row.leaseUntil = Date.now() + delayMs;
        }
    },
    claimStaleFormSessionWork: async () => [...state.sessions.values()]
        .filter(r => r.pendingWork && (r.leaseUntil == null || r.leaseUntil < Date.now()))
        .map(r => { r.pendingAttempts = (r.pendingAttempts || 0) + 1; r.leaseUntil = Date.now() + 120_000; return { ...r }; }),
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
// BFSF-419: a finished journey's result as a Word/PDF download and as a new
// webpage. The renderer and the webpage store have their own tests; here they
// record what the route asked of them.
mock(path.join(SERVER, 'core/documents/render/documentRenderer'), {
    FORMATS: ['pdf', 'docx'],
    renderDocument: async (opts) => {
        state.renders.push(opts);
        const contentType = opts.format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf';
        return { buffer: Buffer.from(`rendered ${opts.format}`), contentType, extension: opts.format, degraded: false };
    },
});
mock(path.join(SERVER, 'core/automationRunner/documentMarking'), {
    resolveMarking: async (orgId, info) => { state.markingAsks.push({ orgId, info }); return { enabled: true, org: 'Org' }; },
});
mock(path.join(SERVER, 'stores/webpageStore'), {
    createWebpage: async (opts) => {
        const wp = { id: `wp${state.webpages.length + 1}`, ...opts };
        state.webpages.push(wp);
        return wp;
    },
    writeSlot: async (userId, webpageId, slot, content) => {
        state.webpageSlots.push({ userId, webpageId, slot, content });
        return { sha: `sha-${slot}`, size: content.length };
    },
    updateWebpageMetadata: async (id, userId, updates) => { state.webpageMeta.push({ id, userId, ...updates }); return true; },
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

const router = require('../formPublic');
const { issueCsrf } = require(path.join(SERVER, 'auth/publicShareToken'));
const { MIN_FORM_AGE_MS, HONEYPOT_FIELD, MAX_SUBMISSION_BYTES, QUEUE_DEPTH, UPLOAD_QUOTA_FILES } = router._constants;

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
const getExport = findHandler('get', '/form/:token/s/:sid/export/:format');
const saveAsWebpage = findHandler('post', '/form/:token/s/:sid/webpage');
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

/** An upload request for the default form's file question. */
function uploadReq(overrides = {}) {
    return makeReq({
        body: { csrf: issueCsrf(TOKEN), field: 'attachment' },
        file: { buffer: Buffer.from('%PDF-1.4 hello'), size: 14, mimetype: 'application/pdf', originalname: 'note.pdf' },
        ...overrides,
    });
}

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

/** Register a generated file against a run, as the step's ledger write would. */
function putFile(id, runId, over = {}) {
    state.generatedFiles.set(id, {
        id, runId, automationId: 'auto1', storageKey: `automation-forms/owner1/auto1/${id}`,
        filename: 'offerte.pdf', mimeType: 'application/pdf', size: 13, ...over,
    });
    return state.generatedFiles.get(id);
}

/** A form whose second question is answered by picking a Fireflies transcript. */
const PICK_FORM = {
    title: 'Write the meeting up',
    fields: [
        { name: 'email', type: 'email', label: 'Your email', required: true },
        { name: 'call', type: 'app_pick', label: 'Which call?', source: 'fireflies_transcript' },
    ],
};

const withPickForm = () => { state.definitionOverride = { trigger: { id: 'trg', type: 'trigger', kind: 'form', form: PICK_FORM } }; };

module.exports = {
    SERVER,
    mock,
    TOKEN,
    OTHER_TOKEN,
    FORM,
    PAGE_2,
    state,
    resetState,
    putRun,
    latestInChain,
    nextRun,
    router,
    issueCsrf,
    MIN_FORM_AGE_MS,
    HONEYPOT_FIELD,
    MAX_SUBMISSION_BYTES,
    QUEUE_DEPTH,
    UPLOAD_QUOTA_FILES,
    findHandler,
    getForm,
    postUpload,
    postSubmit,
    postPick,
    getSession,
    getDownload,
    openInNotebooks,
    saveTextToNotebook,
    getExport,
    saveAsWebpage,
    postSession,
    makeRes,
    makeReq,
    flushAsync,
    submissionBody,
    uploadReq,
    startSession,
    awaitingRun,
    putFile,
    PICK_FORM,
    withPickForm,
};

/**
 * @typedef {{ id: string, status: string, awaitingStepId: string | null, automationId: string, rootRunId: string, seq: number }} KitRun
 * @typedef {{ id: string, formPageId: string, automationId: string, runId: string | null, rootStepId: string | null,
 *   triggerHeaders: Record<string, unknown> | null, expiresAt: string, pendingWork?: unknown, pendingAttempts?: number,
 *   leaseUntil?: number | null }} KitSession
 * @typedef {Record<string, unknown> & { id: string, formPageId: string, claimedAt: string | null }} KitUpload
 * @typedef {Record<string, unknown> & { id: string, runId: string }} KitFile
 * @typedef {{
 *   executions: Array<{ automation: unknown, opts: unknown }>,
 *   resumes: Array<{ runId: string, stepId: string, opts: unknown }>,
 *   nonces: Set<string>,
 *   uploads: Map<string, KitUpload>,
 *   sessions: Map<string, KitSession>,
 *   runs: Map<string, KitRun>,
 *   runSteps: Map<string, Array<Record<string, unknown>>>,
 *   runUpdates: Array<{ id: string, updates: Record<string, unknown> }>,
 *   usage: { files: number, bytes: number },
 *   touched: number,
 *   active: boolean,
 *   triggerKind: string,
 *   audience: { userId: string, organizationId: string } | null,
 *   groupsOf: Record<string, string[]>,
 *   groupReads: number,
 *   notebooks: Array<Record<string, unknown>>,
 *   notebookWrites: Array<Record<string, unknown>>,
 *   renders: Array<Record<string, unknown>>,
 *   markingAsks: Array<{ orgId: string, info: unknown }>,
 *   webpages: Array<Record<string, unknown>>,
 *   webpageSlots: Array<{ userId: string, webpageId: string, slot: string, content: string }>,
 *   webpageMeta: Array<Record<string, unknown>>,
 *   parsed: Array<{ bytes: number, mimeType: string, filename: string }>,
 *   parsedText: string,
 *   parseThrows: boolean,
 *   uploaded: string[],
 *   deleted: string[],
 *   streamed: string[],
 *   storageMissing: boolean,
 *   scanClean: boolean,
 *   storageAvailable: boolean,
 *   resolveRun: (() => Promise<unknown>) | null,
 *   runQueue: Array<{ id: string }>,
 *   definitionOverride: Record<string, unknown> | null,
 *   generatedFiles: Map<string, KitFile>,
 *   pickSearches: Array<{ source: string, query: string, caller: unknown, opts: unknown }>,
 *   pickReads: Array<{ pick: unknown, withText: unknown, callerId: string | null }>,
 *   pickResults: Array<{ id: string, title: string, subtitle: string }>,
 *   pickSearchError: string | null,
 * }} KitState
 */

/** @typedef {import('express').RequestHandler} KitHandler */

/**
 * @typedef {import('stream').Writable & {
 *   statusCode: number, body: { [key: string]: any } | null, headers: Record<string, any>,
 *   status: (c: number) => ResDouble, json: (b: object) => ResDouble,
 *   set: (k: string, v: unknown) => ResDouble, setHeader: (k: string, v: unknown) => ResDouble,
 *   bytes: () => Buffer,
 * }} ResDouble
 */
