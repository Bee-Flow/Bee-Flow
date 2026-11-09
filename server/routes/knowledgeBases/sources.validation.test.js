/**
 * What a KB source route accepts, and what it says when it refuses
 * (routes/knowledgeBases/sources.js).
 *
 * The routes used to normalise a malformed body instead of refusing it:
 * `typeof cfg.url === 'string' ? … : ''` turned a numeric address into a
 * blank one, a config key nobody reads was answered with 201, and a meeting
 * field the source cannot answer was dropped in silence — so a person watched
 * a setting they had typed fail to stick with nothing on screen to explain
 * it. The schemas state the contract now, and what this file pins is the part
 * a caller can act on:
 *
 *   - the 400 NAMES the field (`body.config.url`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test --test-force-exit routes/knowledgeBases/sources.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Fixtures ────────────────────────────────────────────────────────
// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];
// Adoption of source-less (pre-source-model) documents, see the tests at the end.
const adopt = { orphans: 0, calls: [], fails: false, system: false, kb: null, sources: [], counts: {} };

const KB = { id: 'kb1', tenant_id: 'owner1', organization_id: 'org1' };
const SOURCE = { id: 's1', knowledgeBaseId: 'kb1', kind: 'webpage', name: 'Docs', config: { url: 'https://example.com' }, refreshMode: 'manual', createdBy: 'u1' };

const pass = (req, res, next) => next();

const MOCKS = {
    '../../stores/knowledgeBases': {
        // Real vocabularies — a schema that validated against an empty
        // fallback here would refuse every status, which is not what the
        // store actually accepts.
        DOC_STATUSES: ['processed', 'redacted', 'skipped', 'error', 'duplicate'],
        PII_STATUSES: ['none', 'found', 'redacted', 'unscanned'],
        getKB: async (id) => { touched.push({ what: 'getKB', args: [id] }); return { ...KB, ...(adopt.kb || {}) }; },
        isSystemKB: () => adopt.system,
        countsBySource: async (ids) => Object.fromEntries(ids.filter((i) => adopt.counts[i]).map((i) => [i, adopt.counts[i]])),
        listDocuments: async (...a) => { touched.push({ what: 'listDocuments', args: a }); return []; },
        countDocuments: async () => 0,
    },
    '../../stores/kbSources': {
        SOURCE_KINDS: ['upload', 'text', 'webpage', 'nextcloud_folder', 'datatable', 'meeting_tag', 'automation', 'legacy'],
        get: async (id) => { touched.push({ what: 'getSource', args: [id] }); return { ...SOURCE }; },
        listByKb: async () => adopt.sources,
        create: async (p) => { touched.push({ what: 'create', args: [p] }); return { ...SOURCE, ...p, id: 's9' }; },
        update: async (id, patch) => { touched.push({ what: 'update', args: [id, patch] }); return { ...SOURCE, ...patch }; },
        setSyncCursor: async (id, cursor) => { touched.push({ what: 'setSyncCursor', args: [id, cursor] }); return { ...SOURCE }; },
        requestRefresh: async (id) => { touched.push({ what: 'requestRefresh', args: [id] }); return { ...SOURCE }; },
    },
    '../../stores/kb/adoptOrphanDocuments': () => ({
        adoptOrphanDocuments: async (kbId) => {
            adopt.calls.push(kbId);
            if (adopt.fails) throw new Error('db down');
            const n = adopt.orphans;
            if (n > 0) {
                adopt.sources = [{ ...SOURCE, id: 'adopted', kind: 'upload', name: 'Uploaded files', config: {} }];
                adopt.counts.adopted = { documentCount: n, processedCount: n, redactedCount: 0, skippedCount: 0, errorCount: 0, duplicateCount: 0, piiFoundCount: 0, totalChunks: 0 };
                adopt.orphans = 0;
            }
            return n;
        },
    }),
    '../../stores/userStore': {
        getUser: async (id) => ({ id, name: 'Tom' }),
        getOrganization: async (id) => ({ id, nc_instance_id: 'nc-instance-1' }),
    },
    '../../auth': { requireAuth: pass, requirePermission: () => pass },
    './shared': {
        getUserId: (req) => req.session?.user?.id || null,
        canAccessKB: async () => true,
        canManageKB: async () => true,
        blockIfSystemKB: () => false,
        guardedFetch: async () => { throw new Error('the network is not part of this test'); },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-sources-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /knowledgeBases[\\/](sources|sourcePolicy|sourceSchemas|sourceCreate|sourceUploads)\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./sources');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {}, session = { user: { id: 'u1' } } }) {
    const [pathname, search = ''] = String(url).split('?');
    const query = {};
    for (const [k, v] of new URLSearchParams(search)) query[k] = v;
    return new Promise((resolve, reject) => {
        const req = { method, url, originalUrl: url, path: pathname, body, query, headers: {}, session, get() { return undefined; } };
        const res = {
            statusCode: 200,
            headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => {
    touched.length = 0;
    Object.assign(adopt, { orphans: 0, calls: [], fails: false, system: false, kb: null, sources: [], counts: {} });
});

/** Assert: refused with 400, the named field is in `details`, nothing touched. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

// ═══ POST /:id/sources ══════════════════════════════════════════════

test('a source with no kind is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A source needs a kind — one of: text, upload, webpage, meeting_tag, datatable, cloud_folder.',
        'the caller reads this sentence');
    assert.ok(res.body.details.some((d) => d.path === 'body.kind'));
    assert.deepStrictEqual(touched, []);
});

test('a key the route does not read is refused rather than answered with 201', async () => {
    // Silently ignoring it is how a source created without the schedule
    // somebody typed looks like a success to the person who typed it.
    await refuses({ method: 'POST', url: '/kb1/sources', body: { kind: 'upload', refreshMode: 'schedule' } }, 'body');
});

test('a config key the kind does not have is refused, and named under config', async () => {
    await refuses({ method: 'POST', url: '/kb1/sources', body: { kind: 'webpage', config: { url: 'https://x.test', crawlPages: 9 } } },
        'body.config');
});

test('a numeric web address is refused by name instead of becoming a blank one', async () => {
    // `typeof cfg.url === 'string' ? … : ''` made this a 400 saying the url
    // was missing — for a request that had one.
    await refuses({ method: 'POST', url: '/kb1/sources', body: { kind: 'webpage', config: { url: 42 } } }, 'body.config.url');
});

test('a text source needs text, and the same sentence answers absent and blank', async () => {
    const missing = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'text', config: {} } });
    const blank = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'text', config: { text: ' ' } } });
    for (const res of [missing, blank]) {
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.error, 'A text source needs at least three characters of text.');
        assert.ok(res.body.details.some((d) => d.path === 'body.config.text'));
    }
    assert.deepStrictEqual(touched, []);
});

test('a meeting field this source cannot answer is refused, and the entry is named by index', async () => {
    await refuses({ method: 'POST', url: '/kb1/sources', body: { kind: 'meeting_tag', config: { tag: 'sales', fields: ['summary', 'transcript'] } } },
        'body.config.fields.1');
});

test('a refresh rule that is not an object is refused by name', async () => {
    await refuses({ method: 'POST', url: '/kb1/sources', body: { kind: 'upload', refresh: 'daily' } }, 'body.refresh');
});

test('a cron that is not a cron is refused before anything is created', async () => {
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'webpage', config: { url: 'https://x.test' }, refresh: { cron: 'daily' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A refresh schedule is a cron expression of 5 or 6 fields, like "0 7 * * *".');
    assert.ok(res.body.details.some((d) => d.path === 'body.refresh.cron'));
    assert.deepStrictEqual(touched, []);
});

test('an unknown time zone is named in the refusal', async () => {
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'upload', refresh: { tz: 'Mars/Olympus' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Unknown time zone: Mars/Olympus');
    assert.deepStrictEqual(touched, []);
});

test('a kind the product cannot create yet keeps its own answer, with the list a client may offer', async () => {
    // Not a malformed request: the Studio draws every kind and reads this
    // code to disable the button it cannot use yet.
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'telepathy' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'kind_not_available');
    assert.deepStrictEqual(res.body.availableKinds, ['text', 'upload', 'webpage', 'meeting_tag', 'datatable', 'cloud_folder']);
});

test('a name the schema accepts reaches the store trimmed, and the source is created', async () => {
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'upload', name: '  Files  ' } });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(touched.find((t) => t.what === 'create').args[0].name, 'Files');
});

// ═══ PATCH /:id/sources/:sid ════════════════════════════════════════

test('a blank rename is refused rather than stored as an empty name', async () => {
    await refuses({ method: 'PATCH', url: '/kb1/sources/s1', body: { name: '   ' } }, 'body.name');
});

test('a numeric title is refused instead of reaching the store as a number', async () => {
    await refuses({ method: 'PATCH', url: '/kb1/sources/s1', body: { name: 42 } }, 'body.name');
});

test('a patch key the route does not read is refused rather than answered with 200', async () => {
    await refuses({ method: 'PATCH', url: '/kb1/sources/s1', body: { kind: 'text' } }, 'body');
});

test('a rename is trimmed by the schema, and only the name is patched', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { name: '  Contracts  ' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'update').args[1], { name: 'Contracts' });
});

// ═══ GET /:id/sources/:sid/documents ════════════════════════════════

test('a page size out of range is clamped, because a bad page is still a page', async () => {
    const res = await dispatch({ method: 'GET', url: '/kb1/sources/s1/documents?limit=9999&offset=-4' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.limit, 200);
    assert.strictEqual(res.body.offset, 0);
});

test('a query key the route does not read is refused rather than silently ignored', async () => {
    await refuses({ method: 'GET', url: '/kb1/sources/s1/documents?sort=name' }, 'query');
});

test('an unknown status is refused instead of silently matching every document', async () => {
    // The store drops any status it does not recognise from its filter list;
    // with none left, it adds no status clause at all, so `?status=eror`
    // used to come back with the WHOLE source's documents under a 200.
    await refuses({ method: 'GET', url: '/kb1/sources/s1/documents?status=eror' }, 'query.status');
});

test('a real, comma-separated status list is accepted', async () => {
    const res = await dispatch({ method: 'GET', url: '/kb1/sources/s1/documents?status=error,duplicate' });
    assert.strictEqual(res.statusCode, 200);
});

test('an unknown pii value is refused the same way', async () => {
    await refuses({ method: 'GET', url: '/kb1/sources/s1/documents?pii=nope' }, 'query.pii');
});

// ═══ GET /:id/sources adopts documents from before the source model ═══

test('GET /:id/sources adopts source-less documents first, so the detail agrees with the overview', async () => {
    adopt.orphans = 1;
    const res = await dispatch({ method: 'GET', url: '/kb1/sources' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(adopt.calls, ['kb1'], 'only the requested KB is adopted');
    assert.strictEqual(res.body.totals.sourceCount, 1);
    assert.strictEqual(res.body.totals.documentCount, 1);
});

test('GET /:id/sources still answers when the adoption fails', async () => {
    adopt.fails = true;
    const res = await dispatch({ method: 'GET', url: '/kb1/sources' });
    assert.strictEqual(res.statusCode, 200);
});

test('a system KB is listed but never adopted into (read-only)', async () => {
    adopt.system = true;
    const res = await dispatch({ method: 'GET', url: '/kb1/sources' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(adopt.calls, []);
});

test("a project's files KB is listed but never adopted into", async () => {
    adopt.kb = { source_kind: 'project_files' };
    const res = await dispatch({ method: 'GET', url: '/kb1/sources' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(adopt.calls, []);
});

// ═══ cloud_folder ═══════════════════════════════════════════════════
// Creating a cloud-folder source and what a client may read back of it. The storage probe
// (cloudAccess.openCloudFolder) is a recording double; the schema, the policy and the creator are
// the real ones. What a wrong answer costs: a source created for a folder its creator cannot read
// fails every five minutes with nobody watching; a public config that carries the change cursor or
// the Nextcloud instance id hands a client what only the engine needs; a first import that is never
// queued is a source that sits empty until somebody presses the button.

const cloudAccess = require('./cloudAccess');
const { HttpError } = require('../../core/http/errors');
const realProbe = cloudAccess.openCloudFolder;
const probes = [];
test.after(() => { cloudAccess.openCloudFolder = realProbe; });
test.beforeEach(() => {
    probes.length = 0;
    cloudAccess.openCloudFolder = async (req, cfg, kb) => { probes.push({ cfg, kb: kb.id }); return { orgId: 'org1' }; };
});

const post = (body) => dispatch({ method: 'POST', url: '/kb1/sources', body });
const NC = { kind: 'cloud_folder', config: { provider: 'nextcloud_files', path: '/Docs', folderName: 'Docs' } };

test('a Nextcloud folder is created for its creator, with its first import queued and a config from an explicit list', async () => {
    const before = Date.now();
    const res = await post({ ...NC, refresh: { mode: 'on_change' } });
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    const created = touched.find((t) => t.what === 'create').args[0];
    assert.strictEqual(created.kind, 'cloud_folder');
    assert.strictEqual(created.name, 'Docs');
    assert.strictEqual(created.createdBy, 'u1');
    assert.strictEqual(created.refreshMode, 'on_change');
    assert.deepStrictEqual(created.config, { provider: 'nextcloud_files', folderName: 'Docs', recursive: true, path: '/Docs', ncInstanceId: 'nc-instance-1' });
    const due = Date.parse(created.nextRefreshAt);
    assert.ok(due >= before - 1000 && due <= Date.now() + 1000, 'the first import is due now');
    assert.deepStrictEqual(probes, [{ cfg: { provider: 'nextcloud_files', path: '/Docs', folderName: 'Docs', recursive: true }, kb: 'kb1' }]);
    // What a client reads back: no instance id, no cursor, no ids.
    assert.deepStrictEqual(res.body.source.config, { provider: 'nextcloud_files', folderName: 'Docs', path: '/Docs', recursive: true });
    assert.deepStrictEqual(res.body.source.supportsModes, ['manual', 'schedule', 'on_change']);
});

test('OneDrive and Google Drive keep the folder id (and drive), not a path; recursive:false is kept', async () => {
    await post({ kind: 'cloud_folder', name: ' Contracts ', config: { provider: 'onedrive', folderId: 'F1', driveId: 'D1', folderName: 'Contracts', recursive: false } });
    const od = touched.find((t) => t.what === 'create').args[0];
    assert.strictEqual(od.name, 'Contracts');
    assert.deepStrictEqual(od.config, { provider: 'onedrive', folderName: 'Contracts', recursive: false, folderId: 'F1', driveId: 'D1' });
    assert.strictEqual(od.refreshMode, undefined, 'manual unless a refresh rule says otherwise');
    touched.length = 0;
    await post({ kind: 'cloud_folder', config: { provider: 'google_drive', folderName: 'My Drive' }, refresh: { mode: 'schedule', cron: '0 6 * * *' } });
    const gd = touched.find((t) => t.what === 'create').args[0];
    assert.deepStrictEqual(gd.config, { provider: 'google_drive', folderName: 'My Drive', recursive: true });
    assert.deepStrictEqual([gd.refreshMode, gd.refreshCron], ['schedule', '0 6 * * *']);
});

test('the refusals name the field, and nothing is probed or created', async () => {
    const cases = [
        [{ kind: 'cloud_folder', config: { provider: 'dropbox', folderName: 'x' } }, 'body.config.provider'],
        [{ kind: 'cloud_folder', config: { folderName: 'x' } }, 'body.config.provider'],
        [{ kind: 'cloud_folder', config: { provider: 'nextcloud_files', folderName: 'x' } }, 'body.config.path'],
        [{ kind: 'cloud_folder', config: { provider: 'onedrive', path: '/x', folderName: 'x' } }, 'body.config.path'],
        [{ kind: 'cloud_folder', config: { provider: 'nextcloud_files', path: '/x', driveId: 'd', folderName: 'x' } }, 'body.config.driveId'],
        [{ kind: 'cloud_folder', config: { provider: 'onedrive', folderId: 'F' } }, 'body.config.folderName'],
        [{ kind: 'cloud_folder', config: { provider: 'onedrive', folderId: 'F', folderName: 'x', recursive: 'yes' } }, 'body.config.recursive'],
        [{ kind: 'cloud_folder', config: { provider: 'onedrive', folderId: 'F', folderName: 'x', syncCursor: 'abc' } }, 'body.config'],
        [{ kind: 'cloud_folder', config: { provider: 'onedrive', folderId: 'F', folderName: 'x', token: 'abc' } }, 'body.config'],
    ];
    for (const [body, field] of cases) {
        const res = await post(body);
        assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
        assert.strictEqual(res.body.code, 'invalid_request', JSON.stringify(body));
        assert.ok(res.body.details.some((d) => d.path === field), `${JSON.stringify(body)} must name ${field}: ${JSON.stringify(res.body.details)}`);
    }
    assert.deepStrictEqual(probes, []);
    assert.deepStrictEqual(touched.filter((t) => t.what === 'create'), []);
});

test('a folder the creator cannot use is refused with the probe\'s own code, and no source is created', async () => {
    for (const [status, code] of [[400, 'cloud_not_connected'], [400, 'cloud_folder_unreadable'], [403, 'cloud_folder_out_of_scope']]) {
        cloudAccess.openCloudFolder = async () => { throw new HttpError(status, code, `because ${code}`); };
        const res = await post(NC);
        assert.strictEqual(res.statusCode, status, code);
        assert.strictEqual(res.body.code, code);
        assert.match(res.body.error, new RegExp(`because ${code}`));
    }
    assert.deepStrictEqual(touched.filter((t) => t.what === 'create'), []);
});

test('the refresh modes of a cloud folder: manual, schedule, on_change — not "live" and not "after a meeting"', async () => {
    for (const mode of ['live', 'after_meeting']) {
        const res = await post({ ...NC, refresh: { mode } });
        assert.strictEqual(res.statusCode, 400, mode);
        assert.strictEqual(res.body.code, 'refresh_mode_not_available', mode);
    }
    for (const mode of ['manual', 'schedule', 'on_change']) {
        assert.strictEqual((await post({ ...NC, refresh: { mode } })).statusCode, 201, mode);
    }
});

test('publicSourceConfig of a stored cloud folder never carries the cursor, the instance id or the ids', () => {
    const { publicSourceConfig, REFRESH_MODES_BY_KIND, CREATABLE_KINDS } = require('./sourcePolicy');
    const stored = { provider: 'google_drive', folderId: 'F', driveId: 'D', folderName: 'Plans', recursive: false, syncCursor: 'https://graph/delta?token=SECRET', ncInstanceId: 'nc-1', path: null, accessToken: 'AT' };
    assert.deepStrictEqual(publicSourceConfig('cloud_folder', stored), { provider: 'google_drive', folderName: 'Plans', path: null, recursive: false });
    assert.deepStrictEqual(publicSourceConfig('cloud_folder', {}), { provider: null, folderName: null, path: null, recursive: true });
    assert.deepStrictEqual(REFRESH_MODES_BY_KIND.cloud_folder, ['manual', 'schedule', 'on_change']);
    assert.ok(CREATABLE_KINDS.includes('cloud_folder'));
    assert.ok(!CREATABLE_KINDS.includes('nextcloud_folder'), 'the reserved kind is still not creatable');
});

test('"Refresh now" on a cloud folder drops its change cursor so the pass reads everything; other kinds keep theirs', async () => {
    const kind = SOURCE.kind;
    try {
        SOURCE.kind = 'cloud_folder';
        touched.length = 0;
        const cloud = await dispatch({ method: 'POST', url: '/kb1/sources/s1/refresh' });
        assert.strictEqual(cloud.statusCode, 202);
        const writes = touched.filter((t) => t.what === 'setSyncCursor' || t.what === 'requestRefresh').map((t) => [t.what, ...t.args]);
        assert.deepStrictEqual(writes, [['setSyncCursor', 's1', null], ['requestRefresh', 's1']]);

        SOURCE.kind = 'webpage';
        touched.length = 0;
        const web = await dispatch({ method: 'POST', url: '/kb1/sources/s1/refresh' });
        assert.strictEqual(web.statusCode, 202);
        assert.ok(!touched.some((t) => t.what === 'setSyncCursor'));
    } finally {
        SOURCE.kind = kind;
    }
});
