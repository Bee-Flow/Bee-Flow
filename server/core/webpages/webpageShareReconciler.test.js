// @typecheck
/**
 * The reconciler, reversed: a table changes, a public page must follow.
 *
 * This is a GDPR path, not a refresh button. The tests below therefore do not pin
 * "it works", but the three things that can go wrong in it:
 *
 *   1. a WITHDRAWN share may never be rewritten — that would put bytes back under a
 *      link that was just killed;
 *   2. an unreadable LIST of bound pages may not quietly end in
 *      "nothing to do": unknown narrows to 0 rewrites and a
 *      loud warning;
 *   3. one page that fails may not take the rest of the loop along.
 *
 * Run: node --test --test-force-exit core/webpages/webpageShareReconciler.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const reconciler = require('./webpageShareReconciler');

function silentLog() {
    const lines = { warn: [], log: [] };
    return { warn: (m) => lines.warn.push(String(m)), log: (m) => lines.log.push(String(m)), lines };
}

function shareStore(byPage) {
    return {
        listSharesForWebpage: async (webpageId) => {
            const v = byPage[webpageId];
            if (typeof v === 'function') return v();
            return v || [];
        },
    };
}

function snapshotter() {
    const written = [];
    return {
        written,
        writeSnapshot: async ({ shareId, webpageId, ownerId }) => {
            written.push(`${webpageId}:${shareId}:${ownerId}`);
        },
    };
}

// ── één pagina ───────────────────────────────────────────────────────

test('elke levende share van de pagina wordt herschreven', async () => {
    const snap = snapshotter();
    const n = await reconciler.reSnapshotWebpageShares('wp1', 'u1', {
        publicShareStore: shareStore({ wp1: [{ id: 'sh1' }, { id: 'sh2' }] }),
        webpageSnapshot: snap,
        log: silentLog(),
    });
    assert.strictEqual(n, 2);
    assert.deepStrictEqual(snap.written, ['wp1:sh1:u1', 'wp1:sh2:u1']);
});

test('een INGETROKKEN share wordt overgeslagen', async () => {
    const snap = snapshotter();
    const n = await reconciler.reSnapshotWebpageShares('wp1', 'u1', {
        publicShareStore: shareStore({ wp1: [{ id: 'dood', revokedAt: '2026-01-01T00:00:00Z' }, { id: 'sh2' }] }),
        webpageSnapshot: snap,
        log: silentLog(),
    });
    assert.strictEqual(n, 1);
    assert.deepStrictEqual(snap.written, ['wp1:sh2:u1'],
        'bytes terugzetten onder een ingetrokken link is het tegenovergestelde van intrekken');
});

test('één mislukte snapshot kost de rest van de lus niet', async () => {
    const written = [];
    const log = silentLog();
    const n = await reconciler.reSnapshotWebpageShares('wp1', 'u1', {
        publicShareStore: shareStore({ wp1: [{ id: 'sh1' }, { id: 'sh2' }] }),
        webpageSnapshot: {
            writeSnapshot: async ({ shareId }) => {
                if (shareId === 'sh1') throw new Error('rustfs weg');
                written.push(shareId);
            },
        },
        log,
    });
    assert.strictEqual(n, 1);
    assert.deepStrictEqual(written, ['sh2']);
    assert.match(log.lines.warn.join('\n'), /sh1/);
});

test('een onleesbare share-lijst is 0 herschrijvingen én een waarschuwing', async () => {
    const log = silentLog();
    const snap = snapshotter();
    const n = await reconciler.reSnapshotWebpageShares('wp1', 'u1', {
        publicShareStore: { listSharesForWebpage: async () => { throw new Error('pool leeg'); } },
        webpageSnapshot: snap,
        log,
    });
    assert.strictEqual(n, 0);
    assert.deepStrictEqual(snap.written, []);
    assert.match(log.lines.warn.join('\n'), /enumeration failed/);
});

// ── de tap: een tabel verandert ──────────────────────────────────────

test('elke openbare pagina aan de tabel wordt vernieuwd', async () => {
    const snap = snapshotter();
    const pages = await reconciler.onDatatableChanged('dt1', {
        bridgeGrants: {
            listPublicWebpagesBoundToDatatable: async (id) => {
                assert.strictEqual(id, 'dt1');
                return [
                    { webpageId: 'wpA', ownerId: 'uA', publicShareId: 'shA' },
                    { webpageId: 'wpB', ownerId: 'uB', publicShareId: 'shB' },
                ];
            },
        },
        publicShareStore: shareStore({ wpA: [{ id: 'shA' }], wpB: [{ id: 'shB' }] }),
        webpageSnapshot: snap,
        log: silentLog(),
    });
    assert.strictEqual(pages, 2);
    assert.deepStrictEqual(snap.written, ['wpA:shA:uA', 'wpB:shB:uB']);
});

test('geen tabel-id is geen werk', async () => {
    let asked = false;
    const n = await reconciler.onDatatableChanged('', {
        bridgeGrants: { listPublicWebpagesBoundToDatatable: async () => { asked = true; return []; } },
        log: silentLog(),
    });
    assert.strictEqual(n, 0);
    assert.strictEqual(asked, false);
});

test('een onleesbare lijst gebonden pagina\'s versmalt naar 0 — luid', async () => {
    const log = silentLog();
    const snap = snapshotter();
    const n = await reconciler.onDatatableChanged('dt1', {
        bridgeGrants: { listPublicWebpagesBoundToDatatable: async () => { throw new Error('jsonb kapot'); } },
        publicShareStore: shareStore({}),
        webpageSnapshot: snap,
        log,
    });
    assert.strictEqual(n, 0);
    assert.deepStrictEqual(snap.written, [], 'bij twijfel niets herschrijven');
    assert.match(log.lines.warn.join('\n'), /could not list pages bound to datatable dt1/,
        'stil doorlopen zou betekenen dat een gewiste rij blijft staan zonder spoor');
});

test('een pagina die omvalt kost de andere pagina niet', async () => {
    const log = silentLog();
    const written = [];
    const pages = await reconciler.onDatatableChanged('dt1', {
        bridgeGrants: {
            listPublicWebpagesBoundToDatatable: async () => ([
                { webpageId: 'wpA', ownerId: 'uA' },
                { webpageId: 'wpB', ownerId: 'uB' },
            ]),
        },
        publicShareStore: {
            listSharesForWebpage: async (id) => {
                if (id === 'wpA') throw new Error('rij weg');
                return [{ id: 'shB' }];
            },
        },
        webpageSnapshot: { writeSnapshot: async ({ shareId }) => { written.push(shareId); } },
        log,
    });
    assert.strictEqual(pages, 1);
    assert.deepStrictEqual(written, ['shB']);
});

// ── de bedrading ─────────────────────────────────────────────────────

test('de datatable-tap roept deze reconciler écht aan', () => {
    // The tap lives in stores/datatableStore/liveChanges.js and knows no
    // consumer; boot/featureRegistrations.js registers both. Loading it must
    // leave the snapshot reconciler and the knowledge-source arm registered as
    // separate listeners (each caught on its own).
    require('../../boot/featureRegistrations');
    const { liveListenerLabels } = require('../../stores/datatableStore/liveChanges');
    const labels = liveListenerLabels();
    assert.ok(labels.includes('public webpage snapshots'), 'de tap moet de publieke snapshots vernieuwen');
    assert.ok(labels.includes('knowledge-source arm'), 'en de kennisbron-arm');
});

test('routes/webpages gebruikt DEZELFDE implementatie, geen tweede kopie', () => {
    // routes/webpages is a FOLDER (index.js plus one module per source group),
    // so the whole folder is "the file" about which this claim is made — otherwise
    // moving the call to a sibling module would silently turn it green.
    const fs = require('node:fs');
    const nodePath = require('node:path');
    const dir = nodePath.dirname(require.resolve('../../routes/webpages'));
    const src = fs.readdirSync(dir)
        .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
        .map(f => fs.readFileSync(nodePath.join(dir, f), 'utf8'))
        .join('\n');
    assert.match(src, /shareReconciler\.reSnapshotWebpageSharesDetached/);
    assert.ok(!/listSharesForWebpage\(webpageId, ownerId\)/.test(src),
        'de oude inline-lus mag niet naast de gedeelde implementatie blijven bestaan');
});

// ── de verdeling over luisteraars ────────────────────────────────────

test('een luisteraar die omvalt houdt de volgende niet tegen', async () => {
    const liveChanges = require('../../stores/datatableStore/liveChanges');
    const seen = [];
    liveChanges.onDatatableChanged(async () => { throw new Error('arm failed'); }, 'test: failing');
    liveChanges.onDatatableChanged(async (id) => { seen.push(id); }, 'test: recording');
    liveChanges.notifyDatatableChanged('dt-listener-isolation', { delayMs: 0 });
    for (let i = 0; i < 50 && !seen.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepStrictEqual(seen, ['dt-listener-isolation']);
});
