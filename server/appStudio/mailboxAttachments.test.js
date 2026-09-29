/**
 * Redeeming a mail attachment for real bytes.
 *
 * This is the first path where third-party bytes enter our storage, so the
 * properties under test are mostly refusals, and their ORDER matters as much as
 * their existence: a viewer who cannot read the ticket, a type we will not
 * accept, a size over the limit and a blown quota must each fail without ever
 * touching Gmail or Graph. A check that runs after the download still leaks the
 * fetch — provider quota, latency, and a copy of the file in memory.
 *
 * Run: cd server && node --test appStudio/mailboxAttachments.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const state = {
    rows: [],            // what the RLS-scoped read returns
    ledger: new Map(),
    uploads: [],
    deletedBlobs: [],
    updates: [],
    scanClean: true,
    attachmentTotals: [],
};

stub('../stores/studioAppDbStore', {
    query: async () => ({ rows: state.rows }),
    exec: async (_o, _a, sql, params) => { state.updates.push({ sql, params }); return { changes: 1 }; },
});

stub('../stores/studioAppDataStore', {
    getAttachment: async (id) => state.ledger.get(id) || null,
    listAttachments: async () => [...state.ledger.values()],
    countAttachments: async () => state.ledger.size,
    addAttachment: async (appId, ownerId, row) => {
        const rec = { id: `att_${state.ledger.size + 1}`, ...row, mimeType: row.mimeType, scanned: false, quarantined: false };
        state.ledger.set(rec.id, rec);
        return rec;
    },
    setAttachmentScan: async (id, _a, _o, patch) => {
        const rec = state.ledger.get(id);
        Object.assign(rec, patch);
        return rec;
    },
});

stub('../stores/storageStore', {
    uploadFile: async (key, buffer) => { state.uploads.push({ key, size: buffer.length }); },
    deleteFile: async (key) => { state.deletedBlobs.push(key); },
    buildStudioAppAttachmentKey: (owner, appId, sha) => `${owner}/${appId}/${sha}`,
});

const mailboxAttachments = require('./mailboxAttachments');

const APP = { id: 'app_1', userId: 'owner_1', organizationId: 'org_1' };

const TABLE = {
    id: 'tbl_att', key: 'atts', name: 'Attachments',
    fields: [
        { id: 'f1', key: 'filename', name: 'Filename', type: 'text' },
        { id: 'f2', key: 'file', name: 'File', type: 'file' },
    ],
    access: { default: 'app' },
};

const MODEL = {
    modelVersion: 1,
    tables: [TABLE],
    connectors: [{ id: 'conn_1', kind: 'mailbox', provider: 'gmail', runAs: 'viewer', sync: { tableId: 'tbl_att' } }],
    roles: [{ key: 'agent', label: 'Agent' }],
    roleMapping: { default: 'agent', byGroup: {} },
};

const PDF = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(64, 0x20)]);

function pending(extra = {}) {
    return JSON.stringify({
        kind: 'mailbox_attachment',
        connectorId: 'conn_1',
        messageId: 'm1',
        attachmentId: 'a1',
        name: 'invoice.pdf',
        mime: 'application/pdf',
        size: PDF.length,
        ...extra,
    });
}

/** Counts every provider call so "refused before the network" is checkable. */
function deps(over = {}) {
    const calls = { fetches: 0, identities: 0 };
    return {
        calls,
        deps: {
            resolveMailboxIdentity: async () => {
                calls.identities += 1;
                return { provider: 'gmail', tokens: {}, onRefresh: () => {}, mailbox: { address: 'me@acme.nl', mode: 'personal' } };
            },
            getAttachmentBytes: async () => {
                calls.fetches += 1;
                // A test that needs zip bytes sets calls.zipBytes; everything
                // else keeps getting the invoice it always got.
                return calls.zipBytes
                    ? { buffer: calls.zipBytes, mimeType: 'application/zip', filename: 'pakket.zip' }
                    : { buffer: PDF, mimeType: 'application/pdf', filename: 'invoice.pdf' };
            },
            scanBuffer: async () => ({ clean: state.scanClean }),
            ...over,
        },
    };
}

const VIEWER = { id: 'viewer_1', role: 'agent', organizationId: 'org_1' };

test.beforeEach(() => {
    state.rows = [{ id: 'rec_1', file: pending() }];
    state.ledger = new Map();
    state.uploads = [];
    state.deletedBlobs = [];
    state.updates = [];
    state.scanClean = true;
});

function run(over = {}, viewer = VIEWER) {
    const d = deps(over);
    return {
        calls: d.calls,
        promise: mailboxAttachments.materializeAttachment(APP, MODEL, {
            attachmentId: 'a1', viewer, deps: d.deps,
        }),
    };
}

test('happy path: fetch → scan → store → ledger → descriptor written back', async () => {
    const { promise } = run();
    const descriptor = await promise;

    assert.strictEqual(descriptor.kind, 'studio_attachment');
    assert.strictEqual(descriptor.name, 'invoice.pdf');
    assert.strictEqual(descriptor.size, PDF.length);
    assert.strictEqual(state.uploads.length, 1);

    // Only CLEAN bytes ever get a ledger row that says so.
    const rec = state.ledger.get(descriptor.fileId);
    assert.strictEqual(rec.scanned, true);
    assert.strictEqual(rec.quarantined, false);

    // Written back in place, so the next reader short-circuits.
    assert.strictEqual(state.updates.length, 1);
    assert.ok(state.updates[0].params.some((p) => String(p).includes('studio_attachment')));
});

test('the second reader costs zero provider calls', async () => {
    const { promise } = run();
    const first = await promise;

    state.rows = [{ id: 'rec_1', file: JSON.stringify(first) }];
    const again = run();
    const second = await again.promise;

    assert.deepStrictEqual(second, first);
    assert.strictEqual(again.calls.fetches, 0, 'no second download');
    assert.strictEqual(again.calls.identities, 0, 'not even a token resolve');
});

test('a viewer who cannot read the row gets 404 and no fetch', async () => {
    // The RLS-scoped read comes back empty. Existence must not leak, and
    // nothing may be downloaded on behalf of someone who cannot see the ticket.
    state.rows = [];
    const { calls, promise } = run();
    await assert.rejects(promise, (e) => e.status === 404);
    assert.strictEqual(calls.fetches, 0);
});

test('a refused type never reaches the provider', async () => {
    for (const mime of ['image/svg+xml', 'text/html', 'application/x-msdownload']) {
        state.rows = [{ id: 'rec_1', file: pending({ mime }) }];
        const { calls, promise } = run();
        await assert.rejects(promise, (e) => e.status === 415, `${mime} should be refused`);
        assert.strictEqual(calls.fetches, 0, `${mime} must not be downloaded first`);
    }
});

test('an oversized attachment is refused on the declared size alone', async () => {
    state.rows = [{ id: 'rec_1', file: pending({ size: 50 * 1024 * 1024 }) }];
    const { calls, promise } = run();
    await assert.rejects(promise, (e) => e.status === 413);
    assert.strictEqual(calls.fetches, 0);
});

test('bytes that do not match the declared type are refused', async () => {
    // The content type is written by whoever sent the mail. Trusting it would
    // let an executable be stored and served as application/pdf.
    const { promise } = run({
        getAttachmentBytes: async () => ({ buffer: Buffer.from('MZ\x90\x00not a pdf'), mimeType: 'application/pdf', filename: 'x.pdf' }),
    });
    await assert.rejects(promise, (e) => e.status === 415);
    assert.strictEqual(state.ledger.size, 0);
});

test('a dirty scan stores nothing at all', async () => {
    // The upload route has to write the blob before it can scan it (multer
    // streams) and then delete it again. Here the bytes are already in memory,
    // so the scan comes first and malware never reaches storage in the first
    // place — a strictly better order, worth not regressing.
    state.scanClean = false;
    const { promise } = run();
    await assert.rejects(promise, (e) => e.status === 422);

    assert.strictEqual(state.uploads.length, 0, 'never written');
    assert.strictEqual(state.ledger.size, 0, 'nothing is linked');
    assert.strictEqual(state.updates.length, 0, 'the row still points at the mailbox');
});

test('an empty response is an error, not an empty file', async () => {
    const { promise } = run({ getAttachmentBytes: async () => ({ buffer: Buffer.alloc(0) }) });
    await assert.rejects(promise, (e) => e.status === 422);
});

test('a descriptor naming a connector that no longer exists fails cleanly', async () => {
    state.rows = [{ id: 'rec_1', file: pending({ connectorId: 'conn_gone' }) }];
    const { calls, promise } = run();
    await assert.rejects(promise, (e) => e.status === 404);
    assert.strictEqual(calls.identities, 0);
});

test('an inline image is not an attachment', async () => {
    state.rows = [{ id: 'rec_1', file: pending({ isInline: true }) }];
    const { calls, promise } = run();
    await assert.rejects(promise, (e) => e.status === 415);
    assert.strictEqual(calls.fetches, 0);
});

test('a quarantined stored file is refused rather than served', async () => {
    const { promise } = run();
    const first = await promise;
    state.ledger.get(first.fileId).quarantined = true;
    state.rows = [{ id: 'rec_1', file: JSON.stringify(first) }];

    await assert.rejects(run().promise, (e) => e.status === 422);
});

test('the cache is written with OWNER authority', async () => {
    // The reader may only have read access; caching what they just fetched must
    // not depend on them being allowed to write.
    const { promise } = run();
    await promise;
    assert.strictEqual(state.updates.length, 1);
    // compileUpdate's access filter for role 'owner' is unconditional, so the
    // statement carries no viewer-scoped predicate parameters beyond the id.
    assert.ok(/UPDATE/i.test(state.updates[0].sql));
});

// ── CAD attachments: the mailbox is the ingestion route that matters ─────────

const DXF_BYTES = Buffer.from('  0\r\nSECTION\r\n  2\r\nHEADER\r\n  9\r\n$ACADVER\r\n  1\r\nAC1027\r\n  0\r\nENDSEC\r\n  0\r\nEOF\r\n');
const STEP_BYTES = Buffer.from("ISO-10303-21;\nHEADER;\nFILE_NAME('BRK-1','',(''),(''),'','','');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n");

test('a mailed .dxf declared image/vnd.dxf redeems like any allowed type', async () => {
    state.rows = [{ id: 'rec_1', file: pending({ mime: 'image/vnd.dxf', name: 'plate.dxf', size: DXF_BYTES.length }) }];
    const { promise } = run({
        getAttachmentBytes: async () => ({ buffer: DXF_BYTES, mimeType: 'image/vnd.dxf', filename: 'plate.dxf' }),
    });
    const descriptor = await promise;
    assert.strictEqual(descriptor.kind, 'studio_attachment');
    assert.strictEqual(descriptor.mime, 'image/vnd.dxf');
});

test('octet-stream + a .step name: the name proposes, the ledger stores the canonical mime', async () => {
    // Mail providers say octet-stream for CAD more often than the real thing.
    // The name only PROPOSES — the post-download sniff still confirmed the
    // bytes — and what lands in the ledger is the canonical mime, so the
    // extractor can route on it later.
    state.rows = [{ id: 'rec_1', file: pending({ mime: 'application/octet-stream', name: 'part.step', size: STEP_BYTES.length }) }];
    const { promise } = run({
        getAttachmentBytes: async () => ({ buffer: STEP_BYTES, mimeType: 'application/octet-stream', filename: 'part.step' }),
    });
    const descriptor = await promise;
    assert.strictEqual(descriptor.mime, 'model/step', 'redeemed descriptor carries the canonical mime');
    assert.strictEqual(state.ledger.get(descriptor.fileId).mimeType, 'model/step', 'ledger row stores the canonical mime');
});

test('octet-stream with a non-CAD name is still refused before the provider', async () => {
    state.rows = [{ id: 'rec_1', file: pending({ mime: 'application/octet-stream', name: 'part.bin' }) }];
    const { calls, promise } = run();
    await assert.rejects(promise, (e) => e.status === 415);
    assert.strictEqual(calls.fetches, 0, 'octet-stream alone is never fetched');
});

test('CAD bytes that do not match the declared CAD type are refused after download', async () => {
    state.rows = [{ id: 'rec_1', file: pending({ mime: 'image/vnd.dxf', name: 'plate.dxf' }) }];
    const { promise } = run({
        getAttachmentBytes: async () => ({ buffer: Buffer.from('MZ\x90\x00not a dxf'), mimeType: 'image/vnd.dxf', filename: 'plate.dxf' }),
    });
    await assert.rejects(promise, (e) => e.status === 415);
    assert.strictEqual(state.ledger.size, 0, 'nothing stored, nothing linked');
});

// ── parseDescriptor: the read side of the encoding contract ──────────────────

test('parseDescriptor unwraps a DOUBLE-encoded descriptor (legacy rows)', () => {
    // Rows written while the connector pre-stringified descriptors are JSON
    // text whose first parse yields ANOTHER string. Returning that string made
    // every caller read `.kind` off it — undefined — so a plainly-pending PDF
    // was "not an attachment" and /materialize was never called.
    const descriptor = { kind: 'mailbox_attachment', attachmentId: 'a1', messageId: 'm1' };
    const { parseDescriptor } = mailboxAttachments;

    assert.deepStrictEqual(parseDescriptor(descriptor), descriptor, 'object passthrough');
    assert.deepStrictEqual(parseDescriptor(JSON.stringify(descriptor)), descriptor, 'single-encoded');
    assert.deepStrictEqual(parseDescriptor(JSON.stringify(JSON.stringify(descriptor))), descriptor, 'double-encoded');
    assert.deepStrictEqual(parseDescriptor(JSON.stringify([descriptor])), descriptor, 'array takes the first');
});

test('parseDescriptor answers null for garbage, never a string', () => {
    const { parseDescriptor } = mailboxAttachments;
    assert.strictEqual(parseDescriptor(null), null);
    assert.strictEqual(parseDescriptor(''), null);
    assert.strictEqual(parseDescriptor('not json'), null);
    // A parse that terminates in a bare string is NOT a descriptor — handing it
    // back would put callers right back on `.kind === undefined`.
    assert.strictEqual(parseDescriptor(JSON.stringify('just text')), null);
    // Unwrap is bounded: absurd nesting gives up rather than looping.
    const deep = JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify({ kind: 'x' }))));
    assert.strictEqual(parseDescriptor(deep), null);
});

// ── how big may a container be? ─────────────────────────────────────────────

test('an 18 MB order archive is redeemed; an 18 MB document is not', async () => {
    // THE CASE: 77 article folders, every file inside perfectly ordinary, one
    // 18 MB zip. Measured against the ten-megabyte DOCUMENT cap it came back as
    // "too large to open here" and the whole order produced nothing — while the
    // intake that unpacks it bounds itself on entry count and uncompressed
    // total, and re-runs this entire ladder on every entry.
    const ZIP = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(64)]);
    const eighteenMb = 18 * 1024 * 1024;

    state.rows = [{ id: 'rec_1', file: pending({ name: 'RFQ-20260001.zip', mime: 'application/zip', size: eighteenMb }) }];
    const archive = run();
    archive.calls.zipBytes = ZIP;
    await archive.promise;
    assert.strictEqual(archive.calls.fetches, 1, 'the archive is fetched');

    // A document of the same size stays refused, before the provider is called.
    state.rows = [{ id: 'rec_1', file: pending({ size: eighteenMb }) }];
    const doc = run();
    await assert.rejects(doc.promise, (e) => e.status === 413);
    assert.strictEqual(doc.calls.fetches, 0, 'and it costs no download to say so');
});

test('a provider alias for zip gets the container ceiling too', async () => {
    // Gmail says application/x-zip-compressed. The aliases are folded before
    // the type gate, so the ceiling has to be read AFTER that folding.
    const ZIP = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(64)]);
    state.rows = [{ id: 'rec_1', file: pending({ name: 'pakket.zip', mime: 'application/x-zip-compressed', size: 18 * 1024 * 1024 }) }];
    const { calls, promise } = run();
    calls.zipBytes = ZIP;
    await promise;
    assert.strictEqual(calls.fetches, 1);
});

test('an archive past the platform ceiling is still refused', async () => {
    state.rows = [{ id: 'rec_1', file: pending({ name: 'enorm.zip', mime: 'application/zip', size: 200 * 1024 * 1024 }) }];
    const { calls, promise } = run();
    await assert.rejects(promise, (e) => e.status === 413);
    assert.strictEqual(calls.fetches, 0);
});
