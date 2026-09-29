/**
 * App Studio attachment router — upload quarantine flow + access-checked stream.
 *
 * Real Express router + real uploadGuard (multer) driven by a multipart Readable
 * for uploads and a Writable res so the GET route's stream can actually pipe.
 * Stores / rls / query compiler / quota / storage / audience are stubbed via the
 * require cache before the router loads (same trick as studioAppsRun.test.js).
 *
 * Run: cd server && node --test routes/studioAppFiles.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { Readable, Writable } = require('stream');
const { EICAR } = require('../middleware/uploadGuard');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// ── Mutable stubbed state ───────────────────────────────────────────
const apps = new Map();
const attachments = new Map();       // fileId → attachment row
const storage = { objects: new Map(), uploads: [], deletes: [], available: true };
const compilerCalls = [];            // which probe the read path compiled
const state = { model: null, recordRows: [], addAttachmentThrows: null, quotaThrows: null, canWrite: true };

// A small total-bytes ceiling so the app-wide attachment quota is reachable in
// a test — the router reads this at load time.
const TOTAL_BYTES_CAP = 4096;
process.env.STUDIO_APP_ATTACHMENT_TOTAL_BYTES = String(TOTAL_BYTES_CAP);

function canReadStudioApp(app, userId, _groups = [], orgIds = []) {
    if (!app) return false;
    if (app.userId === userId) return true;
    if (!app.isPublished || !app.organizationId) return false;
    return (Array.isArray(orgIds) ? orgIds : []).includes(app.organizationId);
}

// requireAuth confirms the session's user still exists; without this stub the
// real store reaches for Postgres, and the suite only passed because that
// check used to fail open on an error.
stub('../stores/userStore', { getUser: async (id) => ({ id }), touchLastSeen: async () => {} });

stub('../stores/studioAppStore', {
    getStudioApp: async (id) => apps.get(id) || null,
    canReadStudioApp,
    // Project widening (canReadStudioAppAsync): no fixture here is filed into
    // a Studio Project, so the async predicate is the sync one — which is
    // exactly what the real store answers for project_id NULL.
    canReadStudioAppAsync: async (...a) => canReadStudioApp(...a),
    canWriteStudioApp: (app, userId) => !!app && app.userId === userId,
});
stub('../stores/studioAppDataStore', {
    getDataModel: async () => (state.model ? { model: state.model, modelVersion: 1 } : null),
    addAttachment: async (appId, ownerId, rec) => {
        if (state.addAttachmentThrows) throw state.addAttachmentThrows;
        const id = `att-${attachments.size + 1}`;
        const row = { id, appId, ownerUserId: ownerId, recordId: rec.recordId || null, fieldKey: rec.fieldKey || null, mimeType: rec.mimeType, sha256: rec.sha256, size: rec.size, scanned: false, quarantined: false };
        attachments.set(id, row);
        return row;
    },
    getAttachment: async (id, appId, ownerId) => {
        const row = attachments.get(id);
        if (!row || row.appId !== appId || row.ownerUserId !== ownerId) return null; // owner-scoped
        return row;
    },
    setAttachmentScan: async (id, _appId, _ownerId, patch) => { const r = attachments.get(id); if (r) Object.assign(r, patch); return r; },
    deleteAttachment: async (id, appId, ownerId) => {
        const row = attachments.get(id);
        if (!row || row.appId !== appId || row.ownerUserId !== ownerId) return false;
        attachments.delete(id);
        return true;
    },
    countAttachmentsBySha: async (appId, ownerId, sha256) => [...attachments.values()]
        .filter((a) => a.appId === appId && a.ownerUserId === ownerId && a.sha256 === sha256).length,
    countAttachments: async () => attachments.size,
    listAttachments: async (appId, ownerId) => [...attachments.values()].filter((a) => a.appId === appId && a.ownerUserId === ownerId),
});
stub('../stores/studioAppDbStore', {
    query: async () => ({ rows: state.recordRows }),
});
stub('../stores/storageStore', {
    isAvailable: () => storage.available,
    // Same key shape as the real builder — the route delegates to this.
    buildStudioAppAttachmentKey: (ownerId, appId, sha256) => `studio-apps/${ownerId}/${appId}/attachments/${sha256}`,
    uploadFile: async (key, buffer, mime, meta) => { storage.uploads.push({ key, size: buffer.length, mime, meta }); storage.objects.set(key, { buffer, mime }); return { key }; },
    deleteFile: async (key) => { storage.deletes.push(key); storage.objects.delete(key); },
    streamFile: async (key) => {
        const obj = storage.objects.get(key);
        if (!obj) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; }
        return { stream: Readable.from([obj.buffer]), contentType: obj.mime, contentLength: obj.buffer.length };
    },
});
stub('../appStudio/rlsGateway', {
    resolveViewerRole: async () => 'member',
    canRead: () => true,
    resolveScope: (_t, _role, action) => (state.canWrite
        ? (action === 'create' ? true : 'all')
        : (action === 'create' ? false : 'none')),
    compileAccessFilter: () => ({ where: '', params: [] }),
});
stub('../appStudio/queryCompiler', {
    compileGetById: (table, id) => { compilerCalls.push({ fn: 'getById', tableKey: table.key, id }); return { sql: 'SELECT 1', params: [] }; },
    compileRecordList: (table, opts) => { compilerCalls.push({ fn: 'recordList', tableKey: table.key, filters: opts.filters }); return { sql: 'SELECT 1', params: [] }; },
});
stub('../appStudio/studioAppQuota', {
    assertAttachmentQuota: async () => { if (state.quotaThrows) throw state.quotaThrows; },
    quotaError: (code, { limit, used, message } = {}) => Object.assign(new Error(message), { status: 409, code, limit, used }),
});
stub('../auth/audience', {
    resolveAudienceContext: async (req) => ({ userId: req.session?.user?.id || null, orgIds: new Set(req._testOrgIds || []), userGroups: req._testGroups || [] }),
});

const router = require('./studioAppFiles');

// ── Fixtures ────────────────────────────────────────────────────────
const OWNER = 'owner-1';
const ORG = 'org-1';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let seq = 0;
function makeApp({ owner = OWNER, org = ORG, published = true } = {}) {
    const id = `app-${++seq}`;
    const app = { id, userId: owner, organizationId: org, isPublished: published, name: 'App' };
    apps.set(id, app);
    return app;
}

// ── Harness ─────────────────────────────────────────────────────────
function multipartReq(url, { field = 'file', filename = 'f.png', mime = 'image/png', buffer = PNG, fields = {}, user = OWNER, orgIds = [], groups = [] } = {}) {
    const boundary = '----b' + Math.random().toString(16).slice(2);
    const chunks = [];
    for (const [k, v] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`));
    chunks.push(buffer);
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(chunks);
    const req = new Readable({ read() { this.push(body); this.push(null); } });
    req.method = 'POST';
    req.url = url;
    req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) };
    req.session = user ? { isAuthenticated: true, user: { id: user } } : null;
    req._testOrgIds = orgIds;
    req._testGroups = groups;
    return req;
}

class FakeRes extends Writable {
    constructor(resolve) {
        super();
        this.statusCode = 200; this.headers = {}; this.body = undefined; this.chunks = [];
        this.headersSent = false; this._resolve = resolve; this._settled = false;
        this.on('finish', () => this._done());
    }
    status(c) { this.statusCode = c; return this; }
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; this.headersSent = true; }
    getHeader(k) { return this.headers[String(k).toLowerCase()]; }
    json(b) { this.body = b; this._done(); return this; }
    _write(chunk, _enc, cb) { this.chunks.push(Buffer.from(chunk)); cb(); }
    _done() { if (this._settled) return; this._settled = true; this._resolve(this); }
}

function dispatch(req) {
    return new Promise((resolve, reject) => {
        const res = new FakeRes(resolve);
        router(req, res, (err) => reject(err || new Error(`fell through: ${req.method} ${req.url}`)));
    });
}

function getReq(url, { user = OWNER, orgIds = [], groups = [], method = 'GET' } = {}) {
    return {
        method, url, headers: {},
        session: user ? { isAuthenticated: true, user: { id: user } } : null,
        _testOrgIds: orgIds, _testGroups: groups,
    };
}

const deleteReq = (url, opts = {}) => getReq(url, { ...opts, method: 'DELETE' });

// A model with one readable table carrying a `file` field.
const FILE_MODEL = { tables: [{ id: 'tbl_1', key: 'docs', fields: [{ id: 'fld_1', key: 'file', type: 'file' }], access: { default: 'app' } }] };

test.beforeEach(() => {
    attachments.clear();
    storage.objects.clear(); storage.uploads.length = 0; storage.deletes.length = 0; storage.available = true;
    compilerCalls.length = 0;
    state.model = null; state.recordRows = []; state.addAttachmentThrows = null; state.quotaThrows = null; state.canWrite = true;
});

// ── Upload ──────────────────────────────────────────────────────────

test('upload happy path: blob stored, scanned clean, ledger row created', async () => {
    const app = makeApp();
    const r = await dispatch(multipartReq(`/${app.id}/data/attachments`, { fields: { recordId: 'rec_1', fieldKey: 'file' } }));
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(r.body.attachment.scanned, true);
    assert.strictEqual(r.body.attachment.recordId, 'rec_1');
    assert.strictEqual(storage.uploads.length, 1);
    assert.strictEqual(storage.deletes.length, 0);
    assert.strictEqual(attachments.size, 1);
    // Content-addressed key under the owner's prefix.
    assert.match(storage.uploads[0].key, new RegExp(`^studio-apps/${OWNER}/${app.id}/attachments/[0-9a-f]{64}$`));
});

test('upload quarantine: a dirty scan deletes the blob and 422s with NO ledger row', async () => {
    const app = makeApp();
    const dirty = Buffer.from(`col1,col2\n${EICAR}\n`);
    const r = await dispatch(multipartReq(`/${app.id}/data/attachments`, { filename: 'x.csv', mime: 'text/csv', buffer: dirty }));
    assert.strictEqual(r.statusCode, 422);
    assert.strictEqual(storage.uploads.length, 1, 'blob was written (then removed)');
    assert.strictEqual(storage.deletes.length, 1, 'dirty blob deleted');
    assert.strictEqual(attachments.size, 0, 'no ledger row on a dirty scan');
});

test('upload: over-quota answers 409 before any blob is written', async () => {
    const app = makeApp();
    const err = new Error('too many'); err.status = 409; err.code = 'quota_exceeded'; err.limit = 5000; err.used = 5000;
    state.quotaThrows = err;
    const r = await dispatch(multipartReq(`/${app.id}/data/attachments`));
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(r.body.code, 'quota_exceeded');
    assert.strictEqual(storage.uploads.length, 0);
});

test('upload: over the app-wide TOTAL byte ceiling answers 409 before any blob is written', async () => {
    const app = makeApp();
    // The count and per-file checks pass; only the summed ledger trips.
    attachments.set('att-old', {
        id: 'att-old', appId: app.id, ownerUserId: app.userId, recordId: null, fieldKey: null,
        mimeType: 'image/png', sha256: 'a'.repeat(64), size: TOTAL_BYTES_CAP, scanned: true, quarantined: false,
    });
    const r = await dispatch(multipartReq(`/${app.id}/data/attachments`));
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(r.body.code, 'quota_exceeded');
    assert.strictEqual(r.body.limit, TOTAL_BYTES_CAP);
    assert.strictEqual(r.body.used, TOTAL_BYTES_CAP);
    assert.strictEqual(storage.uploads.length, 0);
});

test('upload: a read-only viewer may not attach (403), nothing written', async () => {
    const app = makeApp();
    state.model = FILE_MODEL;
    state.canWrite = false;
    const r = await dispatch(multipartReq(`/${app.id}/data/attachments`, { user: 'viewer-2', orgIds: [ORG] }));
    assert.strictEqual(r.statusCode, 403);
    assert.strictEqual(storage.uploads.length, 0);
    assert.strictEqual(attachments.size, 0, 'no ledger row for a read-only viewer');
});

test('upload: a viewer whose role may write the app is allowed', async () => {
    const app = makeApp();
    state.model = FILE_MODEL;
    const r = await dispatch(multipartReq(`/${app.id}/data/attachments`, { user: 'viewer-2', orgIds: [ORG] }));
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(storage.uploads.length, 1);
});

test('upload: a non-owner cannot attach to an app with no data model', async () => {
    const app = makeApp();
    const r = await dispatch(multipartReq(`/${app.id}/data/attachments`, { user: 'viewer-2', orgIds: [ORG] }));
    assert.strictEqual(r.statusCode, 403);
    assert.strictEqual(storage.uploads.length, 0);
});

test('upload: a magic-byte mismatch is rejected by the guard (415)', async () => {
    const app = makeApp();
    // Declared png, but the bytes are a PDF → guard 415 before quota/storage.
    const r = await dispatch(multipartReq(`/${app.id}/data/attachments`, { mime: 'image/png', buffer: Buffer.from('%PDF-1.7\n') }));
    assert.strictEqual(r.statusCode, 415);
    assert.strictEqual(storage.uploads.length, 0);
});

test('upload: a non-visible app answers 404 (no existence leak)', async () => {
    const app = makeApp({ published: false });
    const r = await dispatch(multipartReq(`/${app.id}/data/attachments`, { user: 'stranger', orgIds: ['other'] }));
    assert.strictEqual(r.statusCode, 404);
    assert.strictEqual(storage.uploads.length, 0);
});

test('upload: unauthenticated answers 401', async () => {
    const app = makeApp();
    const r = await dispatch(multipartReq(`/${app.id}/data/attachments`, { user: null }));
    assert.strictEqual(r.statusCode, 401);
});

// ── Stream ──────────────────────────────────────────────────────────

async function seedAttachment(app, { recordId = 'rec_1', fieldKey = 'file', mime = 'image/png', buffer = PNG } = {}) {
    const crypto = require('crypto');
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    const id = `att-${attachments.size + 1}`;
    const row = { id, appId: app.id, ownerUserId: app.userId, recordId, fieldKey, mimeType: mime, sha256: sha, size: buffer.length, scanned: true, quarantined: false };
    attachments.set(id, row);
    storage.objects.set(`studio-apps/${app.userId}/${app.id}/attachments/${sha}`, { buffer, mime });
    return row;
}

test('stream: the owner gets the bytes with a nosniff header', async () => {
    const app = makeApp();
    const att = await seedAttachment(app);
    const r = await dispatch(getReq(`/${app.id}/data/attachments/${att.id}`, { user: OWNER }));
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(r.headers['content-type'], 'image/png');
    assert.deepStrictEqual(Buffer.concat(r.chunks), PNG);
});

test('stream: a non-owner who CAN read the owning record gets the file', async () => {
    const app = makeApp();
    state.model = { tables: [{ id: 'tbl_1', key: 'docs', fields: [{ id: 'fld_1', key: 'file', type: 'file' }], access: { default: 'app' } }] };
    const att = await seedAttachment(app);
    state.recordRows = [{ id: 'rec_1' }]; // RLS lets the row through
    const r = await dispatch(getReq(`/${app.id}/data/attachments/${att.id}`, { user: 'viewer-2', orgIds: [ORG] }));
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(Buffer.concat(r.chunks), PNG);
});

test('stream: a non-owner who CANNOT read the owning record gets 404', async () => {
    const app = makeApp();
    state.model = { tables: [{ id: 'tbl_1', key: 'docs', fields: [{ id: 'fld_1', key: 'file', type: 'file' }], access: { default: 'app' } }] };
    const att = await seedAttachment(app);
    state.recordRows = []; // RLS filtered the record out
    const r = await dispatch(getReq(`/${app.id}/data/attachments/${att.id}`, { user: 'viewer-2', orgIds: [ORG] }));
    assert.strictEqual(r.statusCode, 404);
});

test('stream: an UNLINKED attachment (no recordId) is readable when a readable record references it', async () => {
    // The runtime uploads BEFORE the record exists, so recordId is null on the
    // ledger row — the link is found from the record side instead.
    const app = makeApp();
    state.model = FILE_MODEL;
    const att = await seedAttachment(app, { recordId: null });
    state.recordRows = [{ id: 'rec_1' }];
    const r = await dispatch(getReq(`/${app.id}/data/attachments/${att.id}`, { user: 'viewer-2', orgIds: [ORG] }));
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(Buffer.concat(r.chunks), PNG);
    assert.deepStrictEqual(compilerCalls, [{
        fn: 'recordList', tableKey: 'docs',
        filters: [{ field: 'file', op: 'contains', value: att.id }],
    }], 'the file column is probed for the attachment id, access-scoped');
});

test('stream: an UNLINKED attachment no readable record references answers 404', async () => {
    const app = makeApp();
    state.model = FILE_MODEL;
    const att = await seedAttachment(app, { recordId: null });
    state.recordRows = []; // RLS filtered every referencing row out
    const r = await dispatch(getReq(`/${app.id}/data/attachments/${att.id}`, { user: 'viewer-2', orgIds: [ORG] }));
    assert.strictEqual(r.statusCode, 404);
});

test('stream: a fileId belonging to another app answers 404 (owner-scoped ledger / IDOR)', async () => {
    const appA = makeApp();
    const appB = makeApp();
    const att = await seedAttachment(appB); // attachment lives on app B
    // Ask for it through app A (which the caller owns) — foreign fileId.
    const r = await dispatch(getReq(`/${appA.id}/data/attachments/${att.id}`, { user: OWNER }));
    assert.strictEqual(r.statusCode, 404);
});

test('stream: a quarantined attachment answers 404', async () => {
    const app = makeApp();
    const att = await seedAttachment(app);
    att.quarantined = true;
    const r = await dispatch(getReq(`/${app.id}/data/attachments/${att.id}`, { user: OWNER }));
    assert.strictEqual(r.statusCode, 404);
});

test('stream: a missing attachment answers 404', async () => {
    const app = makeApp();
    const r = await dispatch(getReq(`/${app.id}/data/attachments/nope`, { user: OWNER }));
    assert.strictEqual(r.statusCode, 404);
});

// ── Delete (discard an unlinked upload) ─────────────────────────────
//
// The X on a file input only dropped the descriptor from the field value: there
// was no route that could ever remove the bytes, so every discarded pick kept
// charging against the app's storage quota forever.

test('delete: an unlinked upload takes its blob with it', async () => {
    const app = makeApp();
    const att = await seedAttachment(app, { recordId: null, fieldKey: null });
    const key = `studio-apps/${app.userId}/${app.id}/attachments/${att.sha256}`;

    const r = await dispatch(deleteReq(`/${app.id}/data/attachments/${att.id}`, { user: OWNER }));
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(attachments.size, 0, 'ledger row gone');
    assert.deepStrictEqual(storage.deletes, [key], 'blob gone');
});

test('delete: an attachment that hangs off a record is refused', async () => {
    const app = makeApp();
    const att = await seedAttachment(app, { recordId: 'rec_1' });
    const r = await dispatch(deleteReq(`/${app.id}/data/attachments/${att.id}`, { user: OWNER }));
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(r.body.code, 'attachment_linked');
    assert.strictEqual(attachments.size, 1, 'the record keeps its file');
    assert.strictEqual(storage.deletes.length, 0);
});

// Storage is content-addressed on sha256, so two ledger rows for identical
// bytes share ONE object — deleting the duplicate must not take the other's
// file with it.
test('delete: the blob survives while another row still points at the same bytes', async () => {
    const app = makeApp();
    const kept = await seedAttachment(app, { recordId: 'rec_1' });
    const discarded = await seedAttachment(app, { recordId: null, fieldKey: null });
    assert.strictEqual(kept.sha256, discarded.sha256, 'same bytes, same key');

    const r = await dispatch(deleteReq(`/${app.id}/data/attachments/${discarded.id}`, { user: OWNER }));
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(attachments.size, 1);
    assert.strictEqual(storage.deletes.length, 0, 'the surviving row still needs the object');
});

test('delete: a read-only viewer may not remove anything', async () => {
    const app = makeApp();
    state.model = FILE_MODEL;
    state.canWrite = false;
    const att = await seedAttachment(app, { recordId: null, fieldKey: null });
    const r = await dispatch(deleteReq(`/${app.id}/data/attachments/${att.id}`, { user: 'viewer-1', orgIds: [ORG] }));
    assert.strictEqual(r.statusCode, 403);
    assert.strictEqual(attachments.size, 1);
});

test('delete: a fileId from another app answers 404 (owner-scoped)', async () => {
    const appA = makeApp();
    const appB = makeApp();
    const att = await seedAttachment(appB, { recordId: null, fieldKey: null });
    const r = await dispatch(deleteReq(`/${appA.id}/data/attachments/${att.id}`, { user: OWNER }));
    assert.strictEqual(r.statusCode, 404);
    assert.strictEqual(attachments.size, 1);
});
