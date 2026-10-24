// @typecheck
/**
 * The files a run produced: list, download, PDF page preview.
 *
 * The router takes its store, storage and renderer injected, so this mounts the
 * real router on a real Express app and talks to it over HTTP.
 *
 * The cast, all in org1 unless said otherwise:
 *   owner     owns a1 and started every run
 *   vic       share on a1, view
 *   ron       share on a1, run-only (reads only the runs they started)
 *   stranger  same organisation, no share
 *   outsider  another organisation
 *
 * Run: cd server && node --test routes/automation/runFiles.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');

const { serve } = require('../../testUtils/routeHarness');
const { makeRunFilesRouter } = require('./runFiles');

const USERS = {
    owner: { id: 'owner', organizationId: 'org1', groups: [] },
    vic: { id: 'vic', organizationId: 'org1', groups: [] },
    ron: { id: 'ron', organizationId: 'org1', groups: [] },
    stranger: { id: 'stranger', organizationId: 'org1', groups: [] },
    outsider: { id: 'outsider', organizationId: 'org2', groups: [] },
};
const AUTOMATIONS = {
    a1: { id: 'a1', userId: 'owner', organizationId: 'org1' },
    a2: { id: 'a2', userId: 'owner', organizationId: 'org1' },
    a3: { id: 'a3', userId: 'outsider', organizationId: 'org2' },
};
const SHARES = {
    a1: [
        { principalType: 'user', principalId: 'vic', role: 'view' },
        { principalType: 'user', principalId: 'ron', role: 'run' },
        { principalType: 'user', principalId: 'outsider', role: 'edit' },
    ],
};
const RUNS = {
    r1: { id: 'r1', automationId: 'a1', userId: 'owner', startedByUserId: 'owner', status: 'success' },
    // The continuation of r1 after a pause: same journey, a second leg.
    r1b: { id: 'r1b', automationId: 'a1', userId: 'owner', startedByUserId: 'owner', status: 'success', rootRunId: 'r1' },
};
RUNS.rRon = { id: 'rRon', automationId: 'a1', userId: 'owner', startedByUserId: 'ron', status: 'success' };
RUNS.rCaller = { id: 'rCaller', automationId: 'a1', userId: 'owner', startedByUserId: 'ron', status: 'success', connectionsMode: 'caller' };
RUNS.r2 = { id: 'r2', automationId: 'a2', userId: 'owner', startedByUserId: 'owner', status: 'success' };
RUNS.r3 = { id: 'r3', automationId: 'a3', userId: 'outsider', startedByUserId: 'outsider', status: 'success' };

const CHAINS = { r1: ['r1', 'r1b'], r1b: ['r1', 'r1b'] };

const PDF_BYTES = Buffer.from('%PDF-1.4 synthetic');
const HOUR = 3_600_000;
const future = new Date(Date.now() + 24 * HOUR).toISOString();
const created = '2026-10-01T10:00:00.000Z';

function fileRow(over) {
    return {
        id: 'f1', runId: 'r1', automationId: 'a1', stepId: 'doc_1', storageKey: 'k/f1',
        filename: 'report.pdf', mimeType: 'application/pdf', size: PDF_BYTES.length,
        createdAt: created, expiresAt: future, ...over,
    };
}

let FILES;
let BLOBS;
const renders = [];

const fakeStore = {
    getRun: async (id) => (RUNS[id] ? { ...RUNS[id] } : null),
    getAutomation: async (id) => (AUTOMATIONS[id] ? { ...AUTOMATIONS[id] } : null),
    getRunsInChain: async (id) => (CHAINS[id] || [id]).map(x => ({ ...RUNS[x] })),
    listSharesForAutomation: async (id) => SHARES[id] || [],
    // Same contract as the real store: expired reads as absent, scoped to the runs given.
    getGeneratedFileForRuns: async (id, runIds) => FILES.find(f => f.id === id
        && runIds.includes(f.runId) && new Date(f.expiresAt) > new Date()) || null,
    listGeneratedFilesForRuns: async (runIds) => FILES
        .filter(f => runIds.includes(f.runId) && new Date(f.expiresAt) > new Date())
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
};
const fakeStorage = {
    streamFile: async (key) => {
        if (!(key in BLOBS)) { const e = new Error('Object not found'); e.name = 'NoSuchKey'; throw e; }
        return { stream: Readable.from([BLOBS[key]]), contentLength: BLOBS[key].length };
    },
};

let api;
before(() => {
    api = serve('/', makeRunFilesRouter({
        store: fakeStore,
        storage: fakeStorage,
        getUser: async (id) => USERS[id] || null,
        hasPermission: async () => false,
        renderPdfPages: async (buf, opts) => {
            renders.push(opts);
            const total = 3;
            const images = [];
            for (let i = 1; i <= Math.min(total, opts.maxPages); i++) {
                images.push({ base64: Buffer.from(`png-page-${i}`).toString('base64'), mimeType: 'image/png' });
            }
            return { images, totalPages: total, truncated: total > opts.maxPages };
        },
    }));
});
after(async () => { await api.close(); });

beforeEach(() => {
    renders.length = 0;
    FILES = [
        fileRow({ id: 'f1' }),
        fileRow({ id: 'f2', runId: 'r1b', stepId: 'doc_2', filename: 'photo.png', mimeType: 'image/png', size: 4, createdAt: '2026-10-01T11:00:00.000Z' }),
        fileRow({ id: 'f3', filename: 'drawing.svg', mimeType: 'image/svg+xml', size: 5 }),
        fileRow({ id: 'f4', filename: 'notes.txt', mimeType: 'text/plain', size: 3 }),
        fileRow({ id: 'fOld', filename: 'old.pdf', expiresAt: '2020-01-01T00:00:00.000Z' }),
        fileRow({ id: 'fGone', filename: 'gone.pdf', storageKey: 'k/missing' }),
        fileRow({ id: 'fRon', runId: 'rRon', filename: 'ron.pdf' }),
        fileRow({ id: 'fCaller', runId: 'rCaller', filename: 'caller.pdf' }),
        fileRow({ id: 'fA2', runId: 'r2', automationId: 'a2', filename: 'other.pdf' }),
        fileRow({ id: 'fA3', runId: 'r3', automationId: 'a3', filename: 'foreign.pdf' }),
    ];
    BLOBS = {
        'k/f1': PDF_BYTES,
        'k/f2': Buffer.from('PNG!'),
        'k/f3': Buffer.from('<svg>'),
        'k/f4': Buffer.from('txt'),
    };
    for (const f of FILES) if (!(f.storageKey in BLOBS) && f.id !== 'fGone') BLOBS[f.storageKey] = PDF_BYTES;
});

const get = (path, as = 'owner') => api.call('GET', path, { user: USERS[as] });

// ── list ──────────────────────────────────────────────────────────────

test('the list covers the whole journey, newest first, with only the allow-listed fields', async () => {
    const res = await get('/runs/r1/files');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.files.map(f => f.fileId), ['f2', 'f1', 'f3', 'f4', 'fGone']);
    assert.deepStrictEqual(res.body.files.find(f => f.fileId === 'f1'), {
        fileId: 'f1', name: 'report.pdf', mime: 'application/pdf', size: PDF_BYTES.length,
        stepId: 'doc_1', createdAt: created, expiresAt: future, previewable: true,
    });
    assert.strictEqual(res.body.files.find(f => f.fileId === 'f2').previewable, false);
    for (const f of res.body.files) assert.ok(!('storageKey' in f) && !('runId' in f) && !('automationId' in f));
    assert.match(res.headers.get('cache-control'), /no-store/);
});

test('opening the second leg lists the same journey', async () => {
    const res = await get('/runs/r1b/files');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.files.some(f => f.fileId === 'f1'));
});

test('expired files are not listed', async () => {
    const res = await get('/runs/r1/files');
    assert.ok(!res.body.files.some(f => f.fileId === 'fOld'));
});

test('a viewer reads the list; a run-only caller reads only the runs they started', async () => {
    assert.strictEqual((await get('/runs/r1/files', 'vic')).status, 200);
    assert.strictEqual((await get('/runs/rRon/files', 'ron')).status, 200);
    const denied = await get('/runs/r1/files', 'ron');
    assert.strictEqual(denied.status, 403);
    assert.strictEqual(denied.body.code, 'automation_forbidden');
});

// ── access ────────────────────────────────────────────────────────────

test('a caller with no role on the automation gets a 404 (same org, or another one)', async () => {
    for (const who of ['stranger', 'outsider']) {
        for (const path of ['/runs/r1/files', '/runs/r1/files/f1', '/runs/r1/files/f1/preview']) {
            const res = await get(path, who);
            assert.strictEqual(res.status, 404, `${who} ${path}`);
        }
    }
});

test('a run that does not exist is a 404', async () => {
    assert.strictEqual((await get('/runs/nope/files')).status, 404);
    assert.strictEqual((await get('/runs/nope/files/f1')).status, 404);
});

test('a run-only caller cannot download a file of somebody else\'s run', async () => {
    assert.strictEqual((await get('/runs/r1/files/f1', 'ron')).status, 403);
    assert.strictEqual((await get('/runs/rRon/files/fRon', 'ron')).status, 200);
});

test('a run on the starter\'s own connections keeps its files from everybody else', async () => {
    const other = await get('/runs/rCaller/files', 'owner');
    assert.strictEqual(other.status, 403);
    assert.strictEqual(other.body.code, 'caller_run_private');
    assert.strictEqual((await get('/runs/rCaller/files/fCaller', 'owner')).status, 403);
    assert.strictEqual((await get('/runs/rCaller/files/fCaller', 'ron')).status, 200);
});

test('a file id never crosses runs, automations or organisations', async () => {
    // Another automation's file through this run's URL.
    assert.strictEqual((await get('/runs/r1/files/fA2')).status, 404);
    // A foreign organisation's file, even by an id that exists.
    assert.strictEqual((await get('/runs/r1/files/fA3')).status, 404);
    // And the other way: the owner has no role on the foreign automation.
    assert.strictEqual((await get('/runs/r3/files/fA3')).status, 404);
    assert.strictEqual((await get('/runs/r3/files')).status, 404);
    // A file of a different run of the same automation is not this journey's.
    assert.strictEqual((await get('/runs/r1/files/fRon')).status, 404);
});

// ── download ──────────────────────────────────────────────────────────

test('a download is an attachment with nosniff and the real bytes', async () => {
    const res = await get('/runs/r1/files/f1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="report\.pdf"/);
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.strictEqual(res.text, PDF_BYTES.toString());
});

test('a file of the journey\'s second leg downloads through the first', async () => {
    assert.strictEqual((await get('/runs/r1/files/f2')).status, 200);
});

test('the file name cannot break out of the header', async () => {
    FILES.push(fileRow({ id: 'fEvil', filename: 'a"; x=1\r\nSet-Cookie: s=1.pdf', storageKey: 'k/f1' }));
    const res = await get('/runs/r1/files/fEvil');
    assert.strictEqual(res.status, 200);
    const cd = res.headers.get('content-disposition');
    assert.ok(!/[\r\n]/.test(cd));
    assert.match(cd, /^attachment; filename="[^"]*"; filename\*=UTF-8''/);
    assert.strictEqual(res.headers.get('set-cookie'), null);
});

test('?inline=1 is honoured for a PDF and a raster image, still nosniff', async () => {
    const pdf = await get('/runs/r1/files/f1?inline=1');
    assert.match(pdf.headers.get('content-disposition'), /^inline; filename="report\.pdf"/);
    assert.strictEqual(pdf.headers.get('x-content-type-options'), 'nosniff');

    const img = await get('/runs/r1/files/f2?inline=1');
    assert.match(img.headers.get('content-disposition'), /^inline;/);
    assert.strictEqual(img.headers.get('x-content-type-options'), 'nosniff');
    assert.match(img.headers.get('content-security-policy'), /sandbox/);
});

test('?inline=1 is ignored for everything else, SVG included', async () => {
    for (const id of ['f3', 'f4']) {
        const res = await get(`/runs/r1/files/${id}?inline=1`);
        assert.strictEqual(res.status, 200);
        assert.match(res.headers.get('content-disposition'), /^attachment;/, id);
        assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    }
});

test('an expired file is a 404, and so is one whose bytes are gone', async () => {
    const expired = await get('/runs/r1/files/fOld');
    assert.strictEqual(expired.status, 404);
    assert.strictEqual(expired.body.code, 'run_file_not_found');
    const gone = await get('/runs/r1/files/fGone');
    assert.strictEqual(gone.status, 404);
    assert.strictEqual(gone.body.code, 'run_file_not_found');
    assert.strictEqual((await get('/runs/r1/files/never-existed')).status, 404);
});

// ── preview ───────────────────────────────────────────────────────────

test('a PDF page previews as a PNG', async () => {
    const res = await get('/runs/r1/files/f1/preview?page=2');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'image/png');
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('x-preview-total-pages'), '3');
    assert.strictEqual(res.headers.get('x-preview-max-pages'), '50', 'the default cap is told to the pager');
    assert.strictEqual(res.text, 'png-page-2');
    assert.strictEqual(renders[0].maxPages, 2);
});

test('the page defaults to 1; a bad or missing page is refused', async () => {
    assert.strictEqual((await get('/runs/r1/files/f1/preview')).text, 'png-page-1');
    for (const bad of ['0', '-1', 'x', '1.5', '']) {
        const res = await get(`/runs/r1/files/f1/preview?page=${bad}`);
        assert.strictEqual(res.status, 400, `page=${bad}`);
        assert.strictEqual(res.body.code, 'invalid_page');
    }
    const past = await get('/runs/r1/files/f1/preview?page=9');
    assert.strictEqual(past.status, 404);
    assert.strictEqual(past.body.code, 'preview_page_not_found');
});

test('only PDFs preview', async () => {
    const res = await get('/runs/r1/files/f2/preview');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.code, 'run_file_not_previewable');
    assert.strictEqual(renders.length, 0);
});

test('the page cap is an env var; 0 lifts it', async () => {
    process.env.AUTOMATION_RUN_FILE_PREVIEW_MAX_PAGES = '2';
    try {
        const over = await get('/runs/r1/files/f1/preview?page=3');
        assert.strictEqual(over.status, 400);
        assert.strictEqual(over.body.code, 'preview_page_out_of_range');
        assert.strictEqual(renders.length, 0);
        process.env.AUTOMATION_RUN_FILE_PREVIEW_MAX_PAGES = '0';
        const lifted = await get('/runs/r1/files/f1/preview?page=3');
        assert.strictEqual(lifted.status, 200);
        assert.strictEqual(lifted.headers.get('x-preview-max-pages'), null, 'no cap, no header');
    } finally {
        delete process.env.AUTOMATION_RUN_FILE_PREVIEW_MAX_PAGES;
    }
});

test('the size cap is an env var; a larger PDF is refused before rendering', async () => {
    process.env.AUTOMATION_RUN_FILE_PREVIEW_MAX_BYTES = '4';
    try {
        const res = await get('/runs/r1/files/f1/preview');
        assert.strictEqual(res.status, 413);
        assert.strictEqual(res.body.code, 'run_file_too_large_to_preview');
        assert.strictEqual(renders.length, 0);
    } finally {
        delete process.env.AUTOMATION_RUN_FILE_PREVIEW_MAX_BYTES;
    }
});

test('a preview obeys the same access as a download', async () => {
    assert.strictEqual((await get('/runs/r1/files/f1/preview', 'ron')).status, 403);
    assert.strictEqual((await get('/runs/r1/files/fOld/preview')).status, 404);
    assert.strictEqual((await get('/runs/r1/files/fA2/preview')).status, 404);
    assert.strictEqual(renders.length, 0);
});
