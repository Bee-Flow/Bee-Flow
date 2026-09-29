/**
 * De reconciler, omgekeerd: een tabel verandert, een openbare pagina moet mee.
 *
 * Dit is een AVG-pad, geen verversknopje. De tests hieronder pinnen daarom
 * niet "hij werkt", maar de drie dingen die er fout aan kunnen gaan:
 *
 *   1. een INGETROKKEN share mag nooit opnieuw geschreven worden — dat zou
 *      bytes terugzetten onder een link die net dood is gemaakt;
 *   2. een onleesbare LIJST van gebonden pagina's mag niet stil eindigen in
 *      "niets te doen": onbekend versmalt naar 0 herschrijvingen én een
 *      luide waarschuwing;
 *   3. één pagina die omvalt mag de rest van de lus niet meenemen.
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
    // Een bewering OVER de aanroeper: notifyDatatableChanged is de enige plek
    // waar dit pad ontstaat, en het moet los staan van de kennisbron-arm —
    // valt de een om, dan moet de ander toch draaien.
    // De store is een FACADE met zijn onderdelen in stores/datatableStore/;
    // de tap zelf woont in liveChanges.js. Lees de hele module als één tekst,
    // anders is de slice hieronder leeg en zegt deze test niets meer.
    const nodeFs = require('node:fs');
    const nodePath = require('node:path');
    const facade = require.resolve('../../stores/datatableStore');
    const partDir = facade.replace(/\.js$/, '');
    const src = [
        ...nodeFs.readdirSync(partDir)
            .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
            .map(f => nodeFs.readFileSync(nodePath.join(partDir, f), 'utf8')),
        nodeFs.readFileSync(facade, 'utf8'),
    ].join('\n');
    const start = src.indexOf('function notifyDatatableChanged');
    const fn = src.slice(start, src.indexOf('\n}', start));
    assert.match(fn, /webpageShareReconciler/, 'de tap moet de publieke snapshots vernieuwen');
    assert.strictEqual((fn.match(/\.catch\(/g) || []).length, 2,
        'twee luisteraars, twee eigen catches — anders neemt de een de ander mee');
});

test('routes/webpages gebruikt DEZELFDE implementatie, geen tweede kopie', () => {
    // routes/webpages is een MAP (index.js plus één module per bronnengroep),
    // dus de hele map is "het bestand" waarover deze bewering gaat — anders
    // zou het verhuizen van de aanroep naar een zustermodule hem stil groen
    // laten worden.
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
