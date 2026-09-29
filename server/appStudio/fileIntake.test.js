/**
 * App Studio — file_intake step (one press files a whole mailed order).
 *
 * Driven through executeDataStep with the REAL queryCompiler + rlsGateway +
 * stepDataSource, so the locate query and the per-pair upsert-match query are
 * genuinely compiled and the pair rows genuinely INSERT/UPDATE through
 * writeRecord. materializeAttachment is stubbed (per-file success/failure is
 * the thing under test, not the provider fetch); ./connectors is stubbed to a
 * shape-faithful findConnector because the real module drags the whole
 * integrations graph behind it.
 *
 * Run: cd server && node --test appStudio/fileIntake.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// ── connectors stub (dataModel top-requires it, so keep its constants) ───────
stub('./connectors', {
    findConnector: (model, id) => (model.connectors || []).find((c) => c && c.id === id) || null,
    CONNECTOR_KINDS: Object.freeze(['integration_tool', 'automation', 'rest', 'mailbox']),
    _MAX_CONNECTOR_ROWS: 500,
});

// ── Record/query plumbing stubs (mirror actionExecutor.ai.test.js) ───────────
// The query stub dispatches on the compiled SQL's table so the LOCATE query
// (attachments table) and the per-pair UPSERT-MATCH query (pairs table) are
// driven independently.
const execCalls = [];
const queryCalls = [];
let attachmentRows = [];
let pairMatchRows = [];
stub('../stores/studioAppDbStore', {
    query: async (ownerId, appId, sql, params) => {
        queryCalls.push({ sql, params });
        if (/FROM "att_rows"/.test(sql)) return { rows: attachmentRows };
        if (/FROM "pairs"/.test(sql)) return { rows: pairMatchRows };
        return { rows: [] };
    },
    exec: async (ownerId, appId, sql, params) => { execCalls.push({ ownerId, appId, sql, params }); return { changes: 1, lastInsertRowid: 0 }; },
    batch: async (ownerId, appId, statements) => statements.map(() => ({ changes: 1 })),
    sizeBytes: async () => 0,
});
stub('../stores/studioAppDataStore', {
    bumpDataVersion: async () => 1,
    bumpRowCount: async () => ({}),
    getRowCounts: async () => ({}),
    getMemberRole: async () => null,
    getAttachment: async () => null,
});
stub('./studioAppQuota', {
    assertRowQuota: async () => {},
    assertDbByteQuota: async () => {},
    assertAttachmentQuota: async () => {},
});
stub('../stores/storageStore', {
    isAvailable: () => true,
    buildStudioAppAttachmentKey: (o, a, s) => `studio-apps/${o}/${a}/attachments/${s}`,
});

// ── materializeAttachment stub — per-file success/failure by filename ────────
const materializeCalls = [];
const materializeFails = new Map(); // filename → Error to throw
// Zip plumbing: buffers the "stored blob" reader hands back, and the derived
// files the expansion stores (per-entry failures injectable by entry name).
const derivedCalls = [];
const derivedFails = new Map();     // entry name → Error to throw
let zipBuffers = new Map();         // fileId → Buffer with real zip bytes
// Byte sizes the redeemed descriptors report, for the rules that RANK files
// (which spreadsheet is the bill of materials). Default 10 when unset.
const descriptorSizes = new Map();  // fileId → bytes
stub('./mailboxAttachments', {
    assertAttachmentTotalBytes: async () => {},
    materializeAttachment: async (app, model, { attachmentId, tableId, recordId, viewer }) => {
        materializeCalls.push({ attachmentId, tableId, recordId, viewer });
        const row = attachmentRows.find((r) => r.provider_attachment_id === attachmentId || r.id === attachmentId);
        const name = row ? row.filename : 'unknown';
        if (materializeFails.has(name)) throw materializeFails.get(name);
        const fileId = `f_${name}`;
        return { kind: 'studio_attachment', fileId, name, mime: 'application/octet-stream', size: descriptorSizes.get(fileId) ?? 10 };
    },
    getStoredAttachmentBuffer: async (appArg, fileId) => zipBuffers.get(fileId) || null,
    storeDerivedFile: async (appArg, { buffer, name, recordId, fieldKey }) => {
        derivedCalls.push({ name, size: buffer.length, recordId, fieldKey });
        if (derivedFails.has(name)) throw derivedFails.get(name);
        const fileId = `d_${name}`;
        // Production stores it; so must the stub, or the rule that reads a
        // spreadsheet to find out what it is would be tested through its
        // could-not-read fallback and never through itself.
        zipBuffers.set(fileId, buffer);
        return { kind: 'studio_attachment', fileId, name, mime: 'application/octet-stream', size: buffer.length };
    },
});

const actionExecutor = require('./actionExecutor');
const fileIntake = require('./fileIntake');

const OWNER = 'owner-1';
const app = { id: 'app-1', userId: OWNER, organizationId: 'org-1', name: 'Quotes' };

const model = {
    modelVersion: 1,
    tables: [
        {
            id: 'tbl_thr', key: 'threads', name: 'Conversations',
            fields: [{ id: 'ft1', key: 'thread_key', type: 'text' }],
            access: { default: 'app', roles: {}, rowFilters: {} },
        },
        {
            id: 'tbl_msg', key: 'messages', name: 'Messages',
            fields: [{ id: 'fm1', key: 'thread_key', type: 'text' }],
            access: { default: 'app', roles: {}, rowFilters: {} },
        },
        {
            id: 'tbl_att', key: 'att_rows', name: 'Attachments',
            fields: [
                { id: 'fa1', key: 'thread_key', type: 'text' },
                { id: 'fa2', key: 'filename', type: 'text' },
                { id: 'fa3', key: 'is_inline', type: 'bool' },
                { id: 'fa4', key: 'provider_attachment_id', type: 'text' },
                { id: 'fa5', key: 'file', type: 'file' },
                { id: 'fa6', key: 'map', type: 'text' },
                { id: 'fa7', key: 'entries', type: 'number' },
            ],
            access: { default: 'app', roles: {}, rowFilters: {} },
        },
        {
            id: 'tbl_pairs', key: 'pairs', name: 'Project lines',
            fields: [
                { id: 'fp1', key: 'basisnaam', type: 'text' },
                { id: 'fp2', key: 'cad_bestand', type: 'text' },
                { id: 'fp3', key: 'cad_file', type: 'file' },
                { id: 'fp4', key: 'tekening_file', type: 'file' },
                { id: 'fp5', key: 'bron_bestand', type: 'text' },
                { id: 'fp6', key: 'thread_key', type: 'text' },
                { id: 'fp7', key: 'toegevoegd_op', type: 'datetime' },
                { id: 'fp8', key: 'part_key', type: 'text' },
                { id: 'fp9', key: 'bewerking', type: 'text' },
                { id: 'fp10', key: 'map', type: 'text' },
                { id: 'fp11', key: 'extra_cad', type: 'text' },
            ],
            access: { default: 'app', roles: {}, rowFilters: {} },
        },
    ],
    connectors: [
        {
            id: 'conn_m', kind: 'mailbox', provider: 'gmail', groupIntoThreads: true,
            sync: {
                tableId: 'tbl_thr', keyField: 'thread_key',
                children: [{ tableId: 'tbl_msg', level: 1 }, { tableId: 'tbl_att', level: 2 }],
            },
        },
        { id: 'conn_rest', kind: 'rest' },
    ],
    roles: [], roleMapping: { default: 'app', byGroup: {} },
};

function ctx(extra = {}) { return { viewerId: OWNER, role: 'owner', orgId: 'org-1', formValues: {}, vars: {}, viewer: { id: OWNER }, ...extra }; }
function step(extra = {}) {
    return { kind: 'file_intake', connectorId: 'conn_m', threadKey: { kind: 'static', value: 't-1' }, ...extra };
}
function attRow(i, filename) {
    return { id: `att_${i}`, thread_key: 't-1', filename, is_inline: false, provider_attachment_id: `p_${i}` };
}
const MAILED_ORDER = [
    attRow(1, 'TN-1.pdf'),
    attRow(2, 'TN-1.step'),
    attRow(3, 'TN-2.pdf'),
    attRow(4, 'Inkoopbestelbon_PO24118.pdf'),
    attRow(5, 'logo.png'),
];

const WRITE_TO = {
    tableId: 'tbl_pairs',
    mapping: {
        basisnaam: 'base_name',
        cad_bestand: 'cad_name',
        cad_file: 'cad_file',
        tekening_file: 'drawing_file',
        bron_bestand: 'file_name',
    },
    constants: {
        thread_key: { kind: 'static', value: 't-1' },
        toegevoegd_op: { kind: 'static', value: '2026-01-01T00:00:00Z' },
    },
};

test.beforeEach(() => {
    execCalls.length = 0;
    queryCalls.length = 0;
    attachmentRows = MAILED_ORDER.map((r) => ({ ...r }));
    pairMatchRows = [];
    materializeCalls.length = 0;
    materializeFails.clear();
    derivedCalls.length = 0;
    derivedFails.clear();
    zipBuffers = new Map();
    descriptorSizes.clear();
});

// ── locate → redeem → classify → pair ────────────────────────────────────────

test('file_intake: redeems every located attachment once and pairs by base name', async () => {
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(materializeCalls.length, 5, 'one redemption per located row');
    assert.strictEqual(materializeCalls[0].tableId, 'tbl_att');
    assert.strictEqual(materializeCalls[0].viewer.id, OWNER);

    const res = r.result;
    assert.strictEqual(res.filed, 5);
    assert.strictEqual(res.total, 5);
    assert.deepStrictEqual(res.refused, []);

    assert.strictEqual(res.pairs.length, 2);
    const tn1 = res.pairs.find((p) => p.baseName === 'tn-1');
    assert.strictEqual(tn1.role, 'paired');
    assert.strictEqual(tn1.cadName, 'TN-1.step');
    assert.strictEqual(tn1.drawingName, 'TN-1.pdf');
    assert.strictEqual(tn1.cadFile.fileId, 'f_TN-1.step');
    const tn2 = res.pairs.find((p) => p.baseName === 'tn-2');
    assert.strictEqual(tn2.role, 'drawing_only');
    assert.strictEqual(tn2.cadName, null);

    assert.strictEqual(res.poName, 'Inkoopbestelbon_PO24118.pdf');
    assert.strictEqual(res.poFile.fileId, 'f_Inkoopbestelbon_PO24118.pdf');
    assert.deepStrictEqual(res.others.map((o) => o.name), ['logo.png']);
    assert.deepStrictEqual(res.unpairedDrawings, ['TN-2.pdf']);
});

// ── writeTo (upsert one row per pair) ────────────────────────────────────────

test('file_intake writeTo: compiles an INSERT per pair with mapped outputs + constants', async () => {
    const r = await actionExecutor.executeDataStep(app, model, step({ writeTo: WRITE_TO }), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.written, 2, 'one row per pair');

    const inserts = execCalls.filter((c) => /INSERT INTO "pairs"/.test(c.sql));
    assert.strictEqual(inserts.length, 2);
    assert.ok(inserts[0].params.includes('tn-1'), 'basisnaam carries the base name');
    assert.ok(inserts[0].params.includes('TN-1.step'), 'cad_bestand carries the cad name');
    assert.ok(inserts[0].params.some((p) => typeof p === 'string' && p.includes('f_TN-1.step')), 'cad_file holds the descriptor JSON');
    assert.ok(inserts[0].params.some((p) => typeof p === 'string' && p.includes('f_TN-1.pdf')), 'tekening_file holds the drawing descriptor');
    assert.ok(inserts[0].params.includes('t-1'), 'constant thread_key is stamped');
    assert.ok(inserts[0].params.includes('2026-01-01T00:00:00Z'), 'constant toegevoegd_op is stamped');
    assert.ok(inserts[1].params.includes('tn-2'));

    // The upsert-match query ran per pair, narrowed by base name + constants.
    const matches = queryCalls.filter((c) => /FROM "pairs"/.test(c.sql));
    assert.strictEqual(matches.length, 2);
    assert.ok(matches[0].params.includes('tn-1'));
    assert.ok(matches[0].params.includes('t-1'), 'scalar constants narrow the match');
    // …but date/datetime constants do NOT: a template stamps `toegevoegd_op:
    // now`, which resolves fresh on every press — matching on it would never
    // find the first run's rows and the second press would duplicate every
    // pair. The stamp still lands on the WRITE (asserted above); it just never
    // participates in identity.
    assert.ok(!matches[0].params.includes('2026-01-01T00:00:00Z'), 'datetime constants are stamps, not identity');
});

test('file_intake writeTo: an existing row is UPDATEd, never duplicated', async () => {
    pairMatchRows = [{ id: 'rec_existing' }];
    const r = await actionExecutor.executeDataStep(app, model, step({ writeTo: WRITE_TO }), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.written, 2);

    const updates = execCalls.filter((c) => /UPDATE "pairs"/.test(c.sql));
    const inserts = execCalls.filter((c) => /INSERT INTO "pairs"/.test(c.sql));
    assert.strictEqual(updates.length, 2, 're-pressing the button refreshes the rows');
    assert.strictEqual(inserts.length, 0, '…and never adds duplicates');
    assert.ok(updates[0].params.includes('rec_existing'), 'the update targets the matched row');
});

test('file_intake writeTo: a mapping without base_name is refused by name', async () => {
    const r = await actionExecutor.executeDataStep(app, model, step({
        writeTo: { tableId: 'tbl_pairs', mapping: { cad_bestand: 'cad_name' } },
    }), ctx());
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /base_name/);
    assert.strictEqual(execCalls.length, 0);
});

// ── per-file failure isolation ───────────────────────────────────────────────

test('file_intake: one refused file is a named hole, the rest are filed', async () => {
    attachmentRows = [attRow(1, 'TN-1.pdf'), attRow(2, 'TN-1.step'), attRow(3, 'TN-2.pdf'), attRow(4, 'TN-2.step')];
    materializeFails.set('TN-1.step', Object.assign(new Error('unsupported type'), { status: 422 }));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.filed, 3);
    assert.strictEqual(materializeCalls.length, 4, 'the batch carried on past the failure');
    assert.deepStrictEqual(r.result.refused, [{ name: 'TN-1.step', reason: 'unsupported type' }]);
});

test('file_intake: quota on the FIRST file aborts with the quota code', async () => {
    materializeFails.set('TN-1.pdf', Object.assign(new Error('App storage is full'), { status: 409, code: 'quota_exceeded' }));
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'quota_exceeded');
    assert.strictEqual(materializeCalls.length, 1, 'no further provider calls are burned');
});

test('file_intake: quota part-way keeps what was filed and reports the remainder', async () => {
    attachmentRows = [attRow(1, 'A.pdf'), attRow(2, 'A.step'), attRow(3, 'B.pdf'), attRow(4, 'B.step'), attRow(5, 'C.pdf')];
    materializeFails.set('B.pdf', Object.assign(new Error('App storage is full'), { status: 409, code: 'quota_exceeded' }));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.filed, 2);
    assert.strictEqual(r.result.code, 'quota_exceeded');
    assert.strictEqual(r.result.remaining, 3, 'the files never attempted are counted');
    assert.strictEqual(materializeCalls.length, 3, 'the loop stopped at the 409');
});

// ── refusals + ceilings ──────────────────────────────────────────────────────

test('file_intake: a conversation with no attachments is refused loudly', async () => {
    attachmentRows = [];
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /no attachments/i);
    assert.strictEqual(materializeCalls.length, 0);
});

test('file_intake: allowEmpty turns "nothing attached" into a no-op, not a failure', async () => {
    // The loud refusal above is right for a BUTTON. The same step running
    // unattended — filing a conversation's files the moment someone opens it
    // — would abort the sequence and toast an error on every request that is
    // just a question, so the caller can opt out of the shout.
    attachmentRows = [];
    const r = await actionExecutor.executeDataStep(app, model, step({ allowEmpty: true }), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.filed, 0);
    assert.strictEqual(r.result.written, 0);
    // The shape stays whole: a formula reading .pairs must see [], not undefined.
    assert.deepStrictEqual(r.result.pairs, []);
    assert.deepStrictEqual(r.result.refused, []);
    assert.strictEqual(r.result.poName, null);
    assert.strictEqual(materializeCalls.length, 0, 'and it still costs no provider call');
});

test('file_intake: one row past the ceiling truncates, and says so', async () => {
    // Derived from the constant, never a literal: this ceiling has to be able
    // to move (it went 25 → 500 the day an order arrived as 154 zip entries)
    // and a test that hard-codes it turns a deliberate change into a red file.
    const ceiling = fileIntake.MAX_FILES_PER_INTAKE;
    attachmentRows = Array.from({ length: ceiling + 1 }, (_, i) => attRow(i + 1, `D${i + 1}.pdf`));
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.truncated, true);
    assert.strictEqual(r.result.limit, ceiling);
    assert.strictEqual(materializeCalls.length, ceiling, 'the one past the ceiling is never redeemed');
});

test('file_intake: the ceiling clears a real order package', async () => {
    // 77 article folders, each with a drawing and a cut file, plus the
    // paperwork — and then the SECOND press, which locates every entry the
    // first one filed. At the old ceiling of 25 that second press quietly
    // re-paired a fifth of the order and left the rest alone.
    assert.ok(fileIntake.MAX_FILES_PER_INTAKE >= 77 * 2 + 3,
        'one press must see a 77-part package and its paperwork');
    assert.ok(fileIntake.MAX_ZIP_ENTRIES >= 77 * 2, 'and the archive it came in');
    assert.ok(fileIntake.MAX_TOTAL_FILES >= 77 * 2 + 3);
});

test('file_intake: an unknown or non-mailbox connector is a clear error', async () => {
    for (const connectorId of ['conn_gone', 'conn_rest']) {
        const r = await actionExecutor.executeDataStep(app, model, step({ connectorId }), ctx());
        assert.strictEqual(r.ok, false, connectorId);
        assert.match(r.error, /mailbox/i);
    }
    assert.strictEqual(queryCalls.length, 0, 'refused before any locate query');
});

// ── deterministic classification (_internal) ─────────────────────────────────

test('classify: PO pattern, CAD extensions (case-insensitive), pdf→drawing, rest→other', () => {
    const { classify } = fileIntake._internal;
    const poRe = new RegExp(fileIntake.DEFAULT_PO_PATTERN, 'i');
    assert.strictEqual(classify('Inkoopbestelbon_PO24118.pdf', poRe), 'po');
    assert.strictEqual(classify('purchase_order_7.pdf', poRe), 'po');
    assert.strictEqual(classify('part.step', poRe), 'cad');
    assert.strictEqual(classify('PLAAT.DXF', poRe), 'cad', 'extension match is case-insensitive');
    assert.strictEqual(classify('TN-1.pdf', poRe), 'drawing');
    assert.strictEqual(classify('notes.txt', poRe), 'other');
});

test('baseNameOf: strips the extension and lowercases', () => {
    assert.strictEqual(fileIntake._internal.baseNameOf('MW2604-01-3021-001.STEP'), 'mw2604-01-3021-001');
});

// ── fuzzy pairing — safe normalisations ONLY, flagged, never guessed ─────────

test('canonicalBaseOf: case, copy suffix and separators — nothing else', () => {
    const { canonicalBaseOf } = fileIntake._internal;
    assert.strictEqual(canonicalBaseOf('TN2306-06-9100-001 (1).DXF'), 'tn2306-06-9100-001');
    assert.strictEqual(canonicalBaseOf('MW2604_01_3021_001.step'), 'mw2604-01-3021-001');
    assert.strictEqual(canonicalBaseOf('TN 2510 01.pdf'), 'tn-2510-01');
    // Digits are NEVER normalised: 3021 stays 3021.
    assert.notStrictEqual(canonicalBaseOf('TN-3021.pdf'), canonicalBaseOf('TN-3022.pdf'));
});

test('containsPrefix: rev suffixes match, short junk and mid-string diffs do not', () => {
    const { containsPrefix } = fileIntake._internal;
    assert.strictEqual(containsPrefix('tn2506-01-3166-001', 'tn2506-01-3166-001-rev2'), true);
    assert.strictEqual(containsPrefix('mw2604-01-3021-001', 'mw2604-01-3022-001'), false, 'one digit apart is a DIFFERENT plate');
    assert.strictEqual(containsPrefix('plaat', 'plaat-2'), false, 'too short to be a real part number');
    assert.strictEqual(containsPrefix('tn2506-01-3166-001', 'tn2506-01-3166-001'), false, 'identical is tier 1/2, not containment');
});

test('pairing: a copy-suffixed CAD still finds its drawing — flagged fuzzy', async () => {
    attachmentRows = [attRow(1, 'TN-7-1000.pdf'), attRow(2, 'TN-7-1000 (1).step')];
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.pairs.length, 1);
    assert.strictEqual(r.result.pairs[0].role, 'paired');
    assert.strictEqual(r.result.pairs[0].matchStatus, 'fuzzy');
    assert.strictEqual(r.result.fuzzy, 1, 'the result SAYS a fuzzy match happened');
    assert.deepStrictEqual(r.result.fuzzyPairs, [{ baseName: 'tn-7-1000', cadName: 'TN-7-1000 (1).step', drawingName: 'TN-7-1000.pdf' }]);
});

test('pairing: separator style differences pair as fuzzy; identical names as exact', async () => {
    attachmentRows = [
        attRow(1, 'TN_2510_01_3021_001.step'), attRow(2, 'TN-2510-01-3021-001.pdf'),
        attRow(3, 'TN-5.step'), attRow(4, 'TN-5.pdf'),
    ];
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    const fuzzy = r.result.pairs.find((p) => p.baseName === 'tn-2510-01-3021-001');
    assert.strictEqual(fuzzy.matchStatus, 'fuzzy');
    const exact = r.result.pairs.find((p) => p.baseName === 'tn-5');
    assert.strictEqual(exact.matchStatus, 'exact');
});

test('pairing: one digit apart NEVER matches — two unpaired entries, both "geen"', async () => {
    attachmentRows = [attRow(1, 'MW2604-01-3021-001.step'), attRow(2, 'MW2604-01-3022-001.pdf')];
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.pairs.length, 2);
    assert.ok(r.result.pairs.every((p) => p.matchStatus === 'geen'));
    assert.strictEqual(r.result.fuzzy, 0);
});

test('pairing: a unique containment (rev suffix) pairs as fuzzy', async () => {
    attachmentRows = [attRow(1, 'TN2506-01-3166-001.step'), attRow(2, 'TN2506-01-3166-001-rev2.pdf')];
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.pairs.length, 1);
    assert.strictEqual(r.result.pairs[0].role, 'paired');
    assert.strictEqual(r.result.pairs[0].matchStatus, 'fuzzy');
});

test('pairing: when .step and .DXF of the same part both arrive, the .step wins', async () => {
    attachmentRows = [attRow(1, 'TN2306-06-9100-001.DXF'), attRow(2, 'TN2306-06-9100-001.step'), attRow(3, 'TN2306-06-9100-001.pdf')];
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.pairs.length, 1);
    assert.strictEqual(r.result.pairs[0].cadName, 'TN2306-06-9100-001.step', 'the portal CSV names the .step (their real order does)');
    assert.strictEqual(r.result.pairs[0].matchStatus, 'exact');
});

test('writeTo: match_status is a mappable output', async () => {
    attachmentRows = [attRow(1, 'TN-1.pdf'), attRow(2, 'TN-1.step')];
    const r = await actionExecutor.executeDataStep(app, model, step({
        writeTo: {
            tableId: 'tbl_pairs',
            mapping: { basisnaam: 'base_name', bron_bestand: 'match_status' },
        },
    }), ctx());
    assert.strictEqual(r.ok, true, r.error);
    const inserts = execCalls.filter((c) => /INSERT INTO "pairs"/.test(c.sql));
    assert.strictEqual(inserts.length, 1);
    assert.ok(inserts[0].params.includes('exact'), 'match_status lands in the mapped column');
});

// ── zip packages ─────────────────────────────────────────────────────────────

const JSZip = require('jszip');
async function buildZip(entries) {
    const z = new JSZip();
    // `null` declares a FOLDER and no file — which is how a customer's archive
    // says "this article exists" and then forgets to put anything in it.
    for (const [name, content] of Object.entries(entries)) {
        if (content === null) z.folder(name);
        else z.file(name, content);
    }
    return z.generateAsync({ type: 'nodebuffer' });
}

/**
 * A ustar tarball, by hand — the other container customers actually send.
 * Built here rather than shelled out to `tar` so the suite stays a pure
 * node --test run on every platform it has to pass on.
 */
function buildTar(files) {
    const blocks = [];
    for (const [name, content] of Object.entries(files)) {
        const body = Buffer.from(content, 'utf8');
        const h = Buffer.alloc(512);
        h.write(name, 0, 'utf8');
        h.write('0000644 ', 100);
        h.write('0000000 ', 108);
        h.write('0000000 ', 116);
        h.write(`${body.length.toString(8).padStart(11, '0')} `, 124);
        h.write('00000000000 ', 136);
        h.write('        ', 148);                 // checksum is computed over spaces
        h.write('0', 156);                        // typeflag: a regular file
        h.write('ustar ', 257);
        h.write('00', 263);
        let sum = 0;
        for (const b of h) sum += b;
        h.write(`${sum.toString(8).padStart(6, '0')}  `, 148);
        blocks.push(h, body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length));
    }
    blocks.push(Buffer.alloc(1024));              // two zero blocks end it
    return Buffer.concat(blocks);
}

test('zip: entries are expanded, re-gated per file, paired, and reported', async () => {
    attachmentRows = [attRow(1, 'pakket.zip'), attRow(2, 'Inkoopbestelbon_PO24118.pdf')];
    zipBuffers.set('f_pakket.zip', await buildZip({
        'order/TN-9.pdf': 'tekening',
        'order/TN-9.step': 'cad',
        'binnenin.zip': 'nested',
        '__MACOSX/TN-9.pdf': 'resource fork junk',
    }));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);

    // Every entry went through the derived-file gate, hanging off the ZIP's row
    // — the inner archive included, because it is a file of this conversation
    // too and somebody has to be able to download it.
    assert.deepStrictEqual(derivedCalls.map((d) => d.name).sort(), ['TN-9.pdf', 'TN-9.step', 'binnenin.zip']);
    assert.ok(derivedCalls.every((d) => d.recordId === 'att_1' && d.fieldKey === 'file'));
    // …and it was FOLLOWED: a second report exists for it, saying why nothing
    // came out (its bytes here are the word "nested", not an archive).
    const inner = r.result.zips.find((z) => z.name === 'binnenin.zip');
    assert.ok(inner, 'the archive inside the archive was opened, not skipped');
    assert.match(inner.refusedEntries[0].reason, /damaged|not an archive/);

    assert.strictEqual(r.result.pairs.length, 1);
    assert.strictEqual(r.result.pairs[0].role, 'paired');
    assert.strictEqual(r.result.pairs[0].matchStatus, 'exact');
    assert.strictEqual(r.result.poName, 'Inkoopbestelbon_PO24118.pdf');
    assert.strictEqual(r.result.filed, 3, 'po + two entries; the zip container itself is not a filed file');

    // Two reports now: the archive that arrived, and the one inside it.
    assert.strictEqual(r.result.zips.length, 2);
    assert.strictEqual(r.result.zips[0].extracted, 3, 'both parts and the inner archive itself');
    assert.deepStrictEqual(r.result.zips[0].refusedEntries, [], 'nothing was refused on the way in');
});

test('zip: every entry becomes an attachment ROW of the same conversation', async () => {
    // WHAT THIS ENCODES: "unpacked" used to be true only INSIDE the step. The
    // entries were stored, paired and written onto project lines, but nothing
    // was ever added to the attachments table — so a files view, which is
    // bound to that table, kept showing one .zip and none of its contents.
    attachmentRows = [attRow(1, 'pakket.zip')];
    zipBuffers.set('f_pakket.zip', await buildZip({ 'order/TN-9.pdf': 'tekening', 'order/TN-9.DXF': 'cad' }));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.zips[0].extracted, 2);
    assert.strictEqual(r.result.zips[0].filed, 2, 'both entries were filed as attachments');

    const inserts = execCalls.filter((c) => /INSERT INTO "att_rows"/.test(c.sql));
    assert.strictEqual(inserts.length, 2, 'one attachment row per entry');
    const names = inserts.map((i) => i.params.find((p) => p === 'TN-9.pdf' || p === 'TN-9.DXF'));
    assert.deepStrictEqual(names.sort(), ['TN-9.DXF', 'TN-9.pdf']);

    // Inherited from the ARCHIVE's row, so the entry belongs to the same
    // conversation…
    for (const ins of inserts) assert.ok(ins.params.includes('t-1'), 'thread_key inherited');
    // …and keyed so a second press collides instead of duplicating. The PATH,
    // not the bare name — see the duplicate-basename test below.
    assert.ok(inserts.some((i) => i.params.includes('p_1#order/TN-9.DXF')),
        'the unique provider id is derived from the archive plus the entry path');
});

test('zip: a refused entry is a named hole, the rest of the zip continues', async () => {
    attachmentRows = [attRow(1, 'pakket.zip')];
    zipBuffers.set('f_pakket.zip', await buildZip({ 'TN-8.pdf': 'a', 'TN-8.step': 'b', 'virus.pdf': 'c' }));
    derivedFails.set('virus.pdf', Object.assign(new Error('That file did not pass the malware scan'), { status: 422 }));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.zips[0].extracted, 2);
    assert.strictEqual(r.result.zips[0].refusedEntries.length, 1);
    assert.match(r.result.zips[0].refusedEntries[0].reason, /malware/);
    assert.strictEqual(r.result.pairs.length, 1, 'TN-8 still paired');
});

test('zip: an unreadable archive refuses the zip, not the intake', async () => {
    attachmentRows = [attRow(1, 'kapot.zip'), attRow(2, 'TN-1.pdf'), attRow(3, 'TN-1.step')];
    zipBuffers.set('f_kapot.zip', Buffer.from('this is not a zip'));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.zips[0].extracted, 0);
    assert.match(r.result.zips[0].refusedEntries[0].reason, /damaged|not an archive/);
    assert.strictEqual(r.result.pairs.length, 1, 'the loose files still pair');
});

test('zip: a file arriving loose AND inside the zip is one file, not two', async () => {
    attachmentRows = [attRow(1, 'pakket.zip'), attRow(2, 'TN-1.step')];
    zipBuffers.set('f_pakket.zip', await buildZip({ 'TN-1.step': 'dupe', 'TN-1.pdf': 'tekening' }));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(derivedCalls.map((d) => d.name), ['TN-1.pdf'], 'the loose .step was not stored twice');
    assert.strictEqual(r.result.pairs.length, 1);
    assert.strictEqual(r.result.pairs[0].cadName, 'TN-1.step');
});

// ── Which id the redeem step hands to materializeAttachment ─────────────────
//
// A live regression: intake refused EVERY file with a flat 404 "Not found",
// which reads like an expired provider handle and sent the diagnosis down the
// wrong path entirely. The real cause was that a mailbox attachments row holds
// two different identifiers, and the redeem step passed the one that cannot be
// looked up. locateDescriptor matches `descriptor.attachmentId`; the row's
// `provider_attachment_id` is a composite uniqueness key of a different shape.
test('the redeem id comes from the stored descriptor, not the row key', () => {
    const { descriptorIdOf } = fileIntake._internal;
    const fileField = { key: 'file', type: 'file' };

    // The exact shape a Gmail mailbox connector writes.
    const row = {
        id: 'rec_1',
        provider_attachment_id: '19ffeb8bf864ef1b:TN2506-01-3166-001.pdf:197896',
        file: JSON.stringify({
            kind: 'mailbox_attachment',
            connectorId: 'conn_mail',
            messageId: '19ffeb8bf864ef1b',
            attachmentId: 'ANGjdJ88VRLqN8fDHbOYLr4x',
            name: 'TN2506-01-3166-001.pdf',
        }),
    };
    assert.equal(descriptorIdOf(row, fileField), 'ANGjdJ88VRLqN8fDHbOYLr4x');
    assert.notEqual(descriptorIdOf(row, fileField), row.provider_attachment_id);

    // Already-materialised descriptors are addressed by fileId instead.
    assert.equal(
        descriptorIdOf({ file: { kind: 'studio_attachment', fileId: 'att_9' } }, fileField),
        'att_9',
    );

    // Absent / unparseable / wrong-shaped columns fall through to the caller's
    // own fallbacks rather than throwing mid-batch.
    assert.equal(descriptorIdOf({}, fileField), null);
    assert.equal(descriptorIdOf({ file: 'not json' }, fileField), null);
    assert.equal(descriptorIdOf({ file: '{}' }, fileField), null);
    assert.equal(descriptorIdOf(null, fileField), null);
    assert.equal(descriptorIdOf(row, null), null);
});

// A second live regression, same shape as the id mix-up above: the lines were
// created and paired correctly, yet every AI-extracted column stayed empty.
// An action loops over `pairs` to read each drawing and write the result onto
// its line, so it guards on `paar.recordId` — and nothing ever set it. The
// guard was false on every iteration, so the loop ran zero times and the run
// still reported success.
test('writeTo: each pair carries back the row id it upserted into', async () => {
    const r = await actionExecutor.executeDataStep(app, model, step({ writeTo: WRITE_TO }), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.written, 2);

    for (const pair of r.result.pairs) {
        assert.ok(
            pair.recordId,
            `pair "${pair.baseName}" must carry the row id it wrote, or a per-document loop cannot address its line`,
        );
    }
    // Distinct rows, not the same id echoed onto every pair.
    const ids = r.result.pairs.map((p) => p.recordId);
    assert.strictEqual(new Set(ids).size, ids.length, 'each pair maps to its own row');
});

test('without writeTo there is no row to point at, and recordId stays absent', async () => {
    const r = await actionExecutor.executeDataStep(app, model, step({}), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.written, 0);
    // Undefined rather than a fabricated id: a guard on recordId must fail
    // closed when nothing was written.
    for (const pair of r.result.pairs) assert.ok(!pair.recordId);
});

// ── the order document that does not say so in its name ──────────────────────

test('po: a lone unpaired PDF beside real CAD files IS the order, and is not a part', async () => {
    // The live case: twenty .DXF cut files out of a zip plus "B263232.pdf".
    // Nothing in that name matches the PO pattern, so the order used to be
    // filed as a drawing — it became a project line of its own, and the step
    // that reads the quantities off it got handed null.
    attachmentRows = [
        attRow(1, '19.0592.136.01_alu_5mm.DXF'),
        attRow(2, '19.0592.136.02_alu_5mm.DXF'),
        attRow(3, '19.0592.136.03_alu_5mm.DXF'),
        attRow(4, 'B263232.pdf'),
    ];
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);

    const res = r.result;
    assert.strictEqual(res.poName, 'B263232.pdf');
    assert.strictEqual(res.poFile.fileId, 'f_B263232.pdf');
    assert.strictEqual(res.poSource, 'structure', 'recognised by where it sits, not by its name');

    assert.strictEqual(res.pairs.length, 3, 'three parts — the order document is not one of them');
    assert.ok(!res.pairs.some((p) => p.baseName === 'b263232'), 'the purchase order never becomes a project line');
    assert.deepStrictEqual(res.unpairedDrawings, []);
    for (const pair of res.pairs) assert.strictEqual(pair.role, 'cad_only');
});

test('po: the filename pattern still wins, and says so', async () => {
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.result.poName, 'Inkoopbestelbon_PO24118.pdf');
    assert.strictEqual(r.result.poSource, 'name');
    // TN-2.pdf is unpaired too, but tier 2 never ran — tier 1 answered.
    assert.deepStrictEqual(r.result.unpairedDrawings, ['TN-2.pdf']);
});

test('po: two unpaired PDFs is a customer who forgot a CAD file — nothing is guessed', async () => {
    attachmentRows = [
        attRow(1, 'TN-1.pdf'),
        attRow(2, 'TN-1.step'),
        attRow(3, 'TN-2.pdf'),      // the forgotten CAD file
        attRow(4, 'B263232.pdf'),   // the order
    ];
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.result.poFile, null, 'ambiguous → no order document at all');
    assert.strictEqual(r.result.poSource, null);
    assert.strictEqual(r.result.pairs.length, 3, 'both orphans stay visible as incomplete lines');
});

test('po: a package with no CAD file at all infers nothing', async () => {
    // Drawings only. There is no structure to read here, so a lone PDF is just
    // a drawing — which is exactly what a customer who mailed one plate sent.
    attachmentRows = [attRow(1, 'TN-1.pdf')];
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.result.poFile, null);
    assert.strictEqual(r.result.pairs.length, 1);
    assert.strictEqual(r.result.pairs[0].role, 'drawing_only');
});

test('po: an orphan drawing from the SAME number family is a part, never the order', async () => {
    // The trap this rule exists for. Promote this .pdf to "purchase order" and
    // plate 3022 silently stops being manufactured — the intake would have
    // deleted a part and called it paperwork.
    attachmentRows = [
        attRow(1, 'MW2604-01-3021-001.step'),
        attRow(2, 'MW2604-01-3022-001.pdf'),
    ];
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.result.poFile, null, 'a sibling number is not paperwork');
    assert.strictEqual(r.result.pairs.length, 2, 'both parts survive');
    assert.deepStrictEqual(r.result.unpairedDrawings, ['MW2604-01-3022-001.pdf']);
});

test('po: the live 22-file order (20 .DXF from a zip + B263232.pdf) resolves the way it must', async () => {
    // The exact package that produced zero project lines: one zip that had
    // already been expanded into twenty cut files, and an order document whose
    // name matches nothing. Kept as a fixture because every part of the ladder
    // has to hold at once — classification, pairing, and which file is the bon.
    const parts = [];
    for (const nr of ['136.01', '136.02', '136.03', '236.01', '236.02', '236.03']) {
        for (const mm of ['5', '10', '20']) {
            const stof = nr.startsWith('136') ? 'alu' : 'hmpe500groen';
            parts.push(`19.0592.${nr}_${stof}_${mm}mm.DXF`);
        }
    }
    parts.push('19.0592.187.01_alu_5mm.DXF', '19.0592.254.01_alu_5mm.DXF');
    attachmentRows = [
        attRow(1, '19.0592 watersnijden_2630117.zip'),
        ...parts.map((name, i) => attRow(i + 2, name)),
        attRow(99, 'B263232.pdf'),
    ];
    zipBuffers = new Map();   // already expanded — the entries ARE the rows

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);

    assert.strictEqual(r.result.pairs.length, 20, 'twenty parts, not twenty-one');
    assert.strictEqual(r.result.poName, 'B263232.pdf');
    assert.strictEqual(r.result.poSource, 'structure');
    // Every part carries its cut file, so the per-part read has something to
    // look at even though not one separate drawing was sent.
    for (const pair of r.result.pairs) {
        assert.ok(pair.cadFile, `${pair.baseName} has a CAD file to read`);
        assert.strictEqual(pair.drawingFile, null);
    }
    // Thickness variants of one part number are DIFFERENT parts and must never
    // collapse into each other.
    const bases = r.result.pairs.map((p) => p.baseName);
    assert.strictEqual(new Set(bases).size, 20, 'no two parts share a base name');
    assert.ok(bases.includes('19.0592.136.01-alu-5mm'), bases.join(' '));
    assert.ok(bases.includes('19.0592.136.01-alu-20mm'));
});

// ── an order that arrives as folders, a spreadsheet and a quote request ──────

test('classify: a spreadsheet is paperwork, and a quote request is an order document', () => {
    const { classify } = fileIntake._internal;
    const poRe = new RegExp(fileIntake.DEFAULT_PO_PATTERN, 'i');

    // Nobody sends a plate as a .xlsx. The BOM is the one file in a mailed
    // order that can be read exactly rather than looked at.
    assert.strictEqual(classify('RFQ-20260001.xlsx', poRe), 'sheet');
    assert.strictEqual(classify('stuklijst.CSV', poRe), 'sheet');
    assert.strictEqual(classify('oud.xls', poRe), 'sheet');
    // BEFORE the PO pattern: this name matches /rfq/ too, and calling the
    // spreadsheet "the purchase order" would hand the wrong file to both the
    // classifier and the step that reads the order lines.
    assert.strictEqual(classify('RFQ-20260001.xlsx', poRe), 'sheet');

    // A request for quotation carries the same table of positions and
    // quantities as an order does; the step reading it does not care which.
    assert.strictEqual(classify('PurchaseQuote_RFQ-20260001_V1.pdf', poRe), 'po');
    assert.strictEqual(classify('Request for Quotation 88.pdf', poRe), 'po');
    assert.strictEqual(classify('Offerte-aanvraag 2026.pdf', poRe), 'po');
    // …and a part drawing that merely mentions a project is still a drawing.
    assert.strictEqual(classify('3010-005424-01.pdf', poRe), 'drawing');
});

test('zip: folders and subfolders flatten to the filename the pairing understands', async () => {
    attachmentRows = [attRow(1, 'RFQ-20260001.zip')];
    zipBuffers.set('f_RFQ-20260001.zip', await buildZip({
        'RFQ-20260001/3010-005424-01/3010-005424-01.dxf': 'cut',
        'RFQ-20260001/3010-005424-01/3010-005424-01.pdf': 'drawing',
        'RFQ-20260001/3010-007646-01/3010-007646-01.dxf': 'cut',
        'RFQ-20260001/3010-007646-01/3010-007646-01.pdf': 'drawing',
    }));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.zips[0].extracted, 4, 'two levels of folder are not two levels of problem');
    assert.strictEqual(r.result.pairs.length, 2, 'one part per article folder');
    for (const pair of r.result.pairs) {
        assert.strictEqual(pair.role, 'paired', `${pair.baseName} has both its files`);
        assert.strictEqual(pair.matchStatus, 'exact');
    }
    assert.deepStrictEqual(r.result.pairs.map((p) => p.baseName).sort(),
        ['3010-005424-01', '3010-007646-01']);
});

test('zip: two folders may hold the same filename without one of them vanishing', async () => {
    // THE TRAP: the synthetic attachment id used to be `<archive>#<filename>`
    // and that column is UNIQUE — so the second "tekening.pdf" came back as a
    // per-entry refusal. Folders exist precisely BECAUSE names repeat inside
    // them, so an archive with folders is the case that breaks it.
    attachmentRows = [attRow(1, 'pakket.zip')];
    zipBuffers.set('f_pakket.zip', await buildZip({
        'deel-a/tekening.pdf': 'a',
        'deel-b/tekening.pdf': 'b',
    }));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(r.result.zips[0].refusedEntries, [], 'neither entry is refused');
    assert.strictEqual(r.result.zips[0].extracted, 2);

    const ids = execCalls
        .filter((c) => /INSERT INTO "att_rows"/.test(c.sql))
        .flatMap((c) => c.params.filter((p) => typeof p === 'string' && p.startsWith('p_1#')));
    assert.deepStrictEqual(ids.sort(), ['p_1#deel-a/tekening.pdf', 'p_1#deel-b/tekening.pdf'],
        'the PATH is the identity; the bare name is only what it is called');
});

test('sheet: the bill of materials is reported beside the order document, not instead of it', async () => {
    // The live shape: a quote request, its BOM, and the parts in an archive.
    // Both documents matter and they are not the same thing — the PDF is the
    // letter, the sheet is the table.
    attachmentRows = [
        attRow(1, 'PurchaseQuote_RFQ-20260001_V1.pdf'),
        attRow(2, 'RFQ-20260001.xlsx'),
        attRow(3, 'RFQ-20260001.zip'),
    ];
    zipBuffers.set('f_RFQ-20260001.zip', await buildZip({
        'RFQ-20260001/3010-005424-01/3010-005424-01.dxf': 'cut',
        'RFQ-20260001/3010-005424-01/3010-005424-01.pdf': 'drawing',
    }));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.poName, 'PurchaseQuote_RFQ-20260001_V1.pdf');
    assert.strictEqual(r.result.poSource, 'name', 'the quote vocabulary is in the pattern now');
    assert.strictEqual(r.result.sheetName, 'RFQ-20260001.xlsx');
    assert.ok(r.result.sheetFile, 'and it is redeemed, not just named');
    // Neither document is a part.
    assert.strictEqual(r.result.pairs.length, 1);
    assert.strictEqual(r.result.pairs[0].baseName, '3010-005424-01');
    assert.deepStrictEqual(r.result.others, [], 'a sheet is paperwork, not leftovers');
});

test('sheet: with several spreadsheets the biggest one is the bill of materials', async () => {
    attachmentRows = [attRow(1, 'contactgegevens.csv'), attRow(2, 'stuklijst.xlsx')];
    descriptorSizes.set('f_contactgegevens.csv', 800);
    descriptorSizes.set('f_stuklijst.xlsx', 96_000);
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.result.sheetName, 'stuklijst.xlsx');
});

test('sheet: no spreadsheet is a null, never a guess', async () => {
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.result.sheetFile, null);
    assert.strictEqual(r.result.sheetName, null);
});

// ── the folder an entry came out of ─────────────────────────────────────────

test('zip: every entry records the folder it came out of', async () => {
    attachmentRows = [attRow(1, 'RFQ.zip')];
    zipBuffers.set('f_RFQ.zip', await buildZip({
        'RFQ-20260001/3010-005424-01/3010-005424-01.dxf': 'cut',
        'RFQ-20260001/3010-005424-01/3010-005424-01.pdf': 'drawing',
        'losbovenin.pdf': 'root entry',
    }));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);

    const inserts = execCalls.filter((c) => /INSERT INTO "att_rows"/.test(c.sql));
    const folders = inserts.map((i) => i.params.find((p) => typeof p === 'string' && p.startsWith('RFQ-20260001/')));
    assert.strictEqual(folders.filter(Boolean).length, 2, 'both files in the article folder carry it');
    assert.ok(folders.includes('RFQ-20260001/3010-005424-01'));
    // An entry at the archive root belongs to no folder, and null says that
    // better than an empty string pretending to be one.
    assert.strictEqual(folders.filter((f) => f === undefined).length, 1, 'the root entry has no folder');
});

test('zip: the entry COUNT lands on the archive row before the work starts', async () => {
    // The denominator for "142 of 243". Written first on purpose: a count of
    // what is done says nothing without the count of what there is.
    attachmentRows = [attRow(1, 'RFQ.zip')];
    zipBuffers.set('f_RFQ.zip', await buildZip({ 'a/one.dxf': '1', 'a/two.pdf': '2', 'b/three.dxf': '3' }));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.zips[0].entries, 3);
    const updates = execCalls.filter((c) => /UPDATE "att_rows"/.test(c.sql));
    assert.ok(updates.some((u) => u.params.includes(3)), 'the archive row carries how many are coming');
});

test('pairing: a folder with no CAD file describes no parts', async () => {
    // THE LIVE CASE: 78 article folders beside one "Labels" folder of label
    // sheets. Flattened, every label reads as a lone drawing and becomes a
    // project line — 77 parts nobody ordered, mixed in with the real ones.
    attachmentRows = [attRow(1, 'RFQ.zip')];
    zipBuffers.set('f_RFQ.zip', await buildZip({
        'RFQ/3010-005424-01/3010-005424-01.dxf': 'cut',
        'RFQ/3010-005424-01/3010-005424-01.pdf': 'drawing',
        'RFQ/3010-007646-01/3010-007646-01.dxf': 'cut',
        'RFQ/3010-007646-01/3010-007646-01.pdf': 'drawing',
        'RFQ/Labels/1509-000169_6_3010-009138.pdf': 'label',
        'RFQ/Labels/1321-000261_84_3010-013092.pdf': 'label',
    }));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.pairs.length, 2, 'two parts, not four');
    assert.deepStrictEqual(r.result.skippedFolders, [{ folder: 'RFQ/Labels', files: 2 }]);
    assert.strictEqual(r.result.skippedSummary, 'RFQ/Labels (2)', 'and as a sentence an action can print');
    // Skipped from the PAIRING, never from the conversation: the labels are
    // still files somebody can open.
    assert.strictEqual(r.result.zips[0].extracted, 6, 'all six are still filed');
    assert.strictEqual(r.result.filed, 6);
});

test('pairing: a loose drawing without its CAD file still becomes a line', async () => {
    // The folder rule must not swallow the case it was never about. A file
    // mailed on its own has no folder, and a customer who forgot the model
    // still deserves a visibly incomplete line.
    // Real part numbers: short stand-ins would trip the unrelated tier-2 rule
    // that promotes a lone unpaired PDF from ANOTHER number family to the order
    // document, and the failure would look like the folder rule's fault.
    attachmentRows = [
        attRow(1, 'MW2604-01-3021-001.pdf'),
        attRow(2, 'MW2604-01-3021-001.step'),
        attRow(3, 'MW2604-01-3022-001.pdf'),
    ];
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.result.pairs.length, 2);
    assert.deepStrictEqual(r.result.skippedFolders, []);
    assert.deepStrictEqual(r.result.unpairedDrawings, ['MW2604-01-3022-001.pdf']);
});

test('pairing: the folder rule still holds on the SECOND press', async () => {
    // A re-run locates the unpacked entries as ordinary attachment rows, so the
    // folder has to be read back off the row. Without that, press one skipped
    // the labels and press two happily created all 77.
    attachmentRows = [
        { ...attRow(1, '3010-005424-01.dxf'), map: 'RFQ/3010-005424-01' },
        { ...attRow(2, '3010-005424-01.pdf'), map: 'RFQ/3010-005424-01' },
        { ...attRow(3, '1509-000169_6_3010-009138.pdf'), map: 'RFQ/Labels' },
    ];
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.pairs.length, 1, 'the label is not a part on any press');
    assert.deepStrictEqual(r.result.skippedFolders, [{ folder: 'RFQ/Labels', files: 1 }]);
});

test('folder: an archive unpacked before the column existed heals itself', async () => {
    // The rows are already there — filed by a run that had nowhere to put the
    // folder. It was never lost: the synthetic id carries the entry path. A
    // rule that only applied to future unpackings would treat one conversation
    // two different ways depending on when its zip happened to arrive.
    attachmentRows = [
        { id: 'att_1', thread_key: 't-1', filename: '3010-005424-01.dxf', is_inline: false, provider_attachment_id: 'p_9#RFQ/3010-005424-01/3010-005424-01.dxf' },
        { id: 'att_2', thread_key: 't-1', filename: '3010-005424-01.pdf', is_inline: false, provider_attachment_id: 'p_9#RFQ/3010-005424-01/3010-005424-01.pdf' },
        { id: 'att_3', thread_key: 't-1', filename: '1509-000169_6.pdf', is_inline: false, provider_attachment_id: 'p_9#RFQ/Labels/1509-000169_6.pdf' },
    ];

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.pairs.length, 1, 'the label is not a part here either');
    assert.deepStrictEqual(r.result.skippedFolders, [{ folder: 'RFQ/Labels', files: 1 }]);

    // …and the column is filled in passing, so the files view can group them.
    const updates = execCalls.filter((c) => /UPDATE "att_rows"/.test(c.sql));
    const written = updates.flatMap((u) => u.params.filter((p) => typeof p === 'string' && p.startsWith('RFQ/')));
    assert.deepStrictEqual(written.sort(), ['RFQ/3010-005424-01', 'RFQ/3010-005424-01', 'RFQ/Labels']);
});

test('folder: a row that already has one is not written again', async () => {
    attachmentRows = [
        { ...attRow(1, 'a.dxf'), map: 'RFQ/deel-1', provider_attachment_id: 'p_9#RFQ/deel-1/a.dxf' },
    ];
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    const updates = execCalls.filter((c) => /UPDATE "att_rows"/.test(c.sql));
    assert.strictEqual(updates.length, 0, 'the backfill is a one-off, not a write per press');
});

// ── what the result variable costs to carry ─────────────────────────────────

test('resultDetail summary: the report keeps its counts and drops its cargo', async () => {
    // THE BUG: a step's result rides back to the browser and then returns in the
    // BODY of every later step of the same action. Two file descriptors per part
    // put ~110 kB in that bag for a 243-file order, and every step after the
    // intake answered 413 — the button stopped working on exactly the orders
    // this whole feature exists for.
    const r = await actionExecutor.executeDataStep(app, model, step({ resultDetail: 'summary' }), ctx());
    assert.strictEqual(r.ok, true, r.error);

    assert.strictEqual(r.result.parts, 2, 'the COUNT survives — a gate never walks the array');
    assert.deepStrictEqual(r.result.pairs, []);
    assert.deepStrictEqual(r.result.unpairedDrawings, []);
    assert.deepStrictEqual(r.result.others, []);
    // The singular facts an action actually reads are untouched.
    assert.strictEqual(r.result.poName, 'Inkoopbestelbon_PO24118.pdf');
    assert.strictEqual(r.result.filed, 5);

    const bytes = Buffer.byteLength(JSON.stringify(r.result), 'utf8');
    assert.ok(bytes < 2000, `a summary is small whatever the order size (${bytes} bytes)`);
});

test('resultDetail: full is the default, and still carries every pair', async () => {
    const r = await actionExecutor.executeDataStep(app, model, step({ writeTo: WRITE_TO }), ctx());
    assert.strictEqual(r.result.parts, 2);
    assert.strictEqual(r.result.pairs.length, 2, 'nothing that loops over pairs changes behaviour');
    assert.ok(r.result.pairs[0].recordId, 'including the row id the loop guards on');
});

test('resultDetail summary: refusals are bounded but never silent', async () => {
    attachmentRows = Array.from({ length: 15 }, (_, i) => attRow(i + 1, `stuk-${i + 1}.pdf`));
    for (let i = 0; i < 15; i += 1) {
        materializeFails.set(`stuk-${i + 1}.pdf`, new Error('scan failed'));
    }
    const r = await actionExecutor.executeDataStep(app, model, step({ resultDetail: 'summary' }), ctx());
    assert.strictEqual(r.result.refusedCount, 15, 'the count is the whole truth');
    assert.strictEqual(r.result.refused.length, 10, 'and the first names say which');
});

// ── how a customer packs an order ───────────────────────────────────────────
//
// One scenario per shape. Read together they are the matrix: what varies is the
// PACKAGING (loose, flat, folder-per-article) and the NAMING (same base name, a
// machining suffix, a drawing filed under its own number), and every row of it
// has to land on the right number of project lines.

test('folder: an article folder is ONE part, even when it holds two cutting files', async () => {
    // NINE FOLDERS IN ONE REAL ORDER LOOK LIKE THIS. Read as names, "X.dxf" and
    // "X (afschuining).dxf" are two parts and the shop cuts the plate twice;
    // read as a folder they are one plate with a chamfer on it. Measured against
    // that customer's own line list, names gave 85 lines where 77 were ordered.
    attachmentRows = [attRow(1, 'RFQ.zip')];
    zipBuffers.set('f_RFQ.zip', await buildZip({
        'RFQ/3010-010857-01 (Afschuining)/3010-010857-01.dxf': 'plain',
        'RFQ/3010-010857-01 (Afschuining)/3010-010857-01 (afschuining).dxf': 'chamfered',
        'RFQ/3010-010857-01 (Afschuining)/3010-010857-01.pdf': 'drawing',
    }));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.pairs.length, 1, 'one plate, one line');

    const line = r.result.pairs[0];
    assert.strictEqual(line.baseName, '3010-010857-01', 'named for the part, not for the machining');
    assert.strictEqual(line.partKey, '3010-010857-01');
    assert.strictEqual(line.operation, 'afschuining', 'the machining is work to do, not identity');
    assert.strictEqual(line.role, 'paired');
    assert.strictEqual(line.matchStatus, 'exact');
    // Their own line list names the chamfered file ten times out of ten: the
    // bewerkte plaat is what actually gets cut, and the folder says so itself.
    assert.strictEqual(line.cadName, '3010-010857-01 (afschuining).dxf');
    assert.deepStrictEqual(line.extraCad, ['3010-010857-01.dxf'], 'and the other one is still named');
});

test('folder: the folder decides, so a drawing may be filed under its own number', async () => {
    // A drawing named for the ASSEMBLY drawing rather than the article shares no
    // base name with the cutting file. Inside a folder that is not ambiguity —
    // the customer already said these belong together by putting them together.
    attachmentRows = [attRow(1, 'RFQ.zip')];
    zipBuffers.set('f_RFQ.zip', await buildZip({
        'RFQ/3010-005424-01/3010-005424-01.dxf': 'cut',
        'RFQ/3010-005424-01/3060-000435.pdf': 'assembly drawing',
    }));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.pairs.length, 1);
    assert.strictEqual(r.result.pairs[0].baseName, '3010-005424-01');
    assert.strictEqual(r.result.pairs[0].role, 'paired');
    assert.strictEqual(r.result.pairs[0].drawingName, '3060-000435.pdf');
    // Paired, but not on a name — the human is told which of these was a match
    // and which was a folder's word for it.
    assert.strictEqual(r.result.pairs[0].matchStatus, 'fuzzy');
});

test('folder: a folder holding two part numbers says nothing, so the names decide', async () => {
    // The rule is not "trust folders", it is "trust a folder that means one
    // thing". A "diversen" folder with four files is a pile in a box.
    attachmentRows = [attRow(1, 'RFQ.zip')];
    zipBuffers.set('f_RFQ.zip', await buildZip({
        'RFQ/diversen/3010-005424-01.dxf': 'cut',
        'RFQ/diversen/3010-005424-01.pdf': 'drawing',
        'RFQ/diversen/3010-007646-01.dxf': 'cut',
        'RFQ/diversen/3010-007646-01.pdf': 'drawing',
    }));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.pairs.length, 2, 'two parts, found by their names');
    assert.deepStrictEqual(r.result.pairs.map((p) => p.baseName).sort(),
        ['3010-005424-01', '3010-007646-01']);
});

test('folder: an article folder with nothing in it is a part somebody forgot', async () => {
    // It produces NO line — the files decide which lines exist — but the plate
    // is on the order, so the only thing standing between it and silence is
    // saying its name out loud.
    attachmentRows = [attRow(1, 'RFQ.zip')];
    zipBuffers.set('f_RFQ.zip', await buildZip({
        'RFQ/3010-005424-01/3010-005424-01.dxf': 'cut',
        'RFQ/3010-005424-01/3010-005424-01.pdf': 'drawing',
        'RFQ/3010-007033-01 (tappen)': null,
    }));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.pairs.length, 1);
    assert.deepStrictEqual(r.result.emptyFolders, ['RFQ/3010-007033-01 (tappen)']);
    assert.strictEqual(r.result.emptySummary, 'RFQ/3010-007033-01 (tappen)');
});

test('folder: a folder we simply did not read is not a folder the customer left empty', async () => {
    // The emptiness test runs against the FULL entry list, never the truncated
    // one — otherwise hitting the entry ceiling would invent missing articles.
    attachmentRows = [attRow(1, 'RFQ.zip')];
    const entries = {};
    for (let i = 0; i < 3; i += 1) {
        entries[`RFQ/3010-00${5000 + i}-01/3010-00${5000 + i}-01.dxf`] = 'cut';
        entries[`RFQ/3010-00${5000 + i}-01/3010-00${5000 + i}-01.pdf`] = 'drawing';
    }
    zipBuffers.set('f_RFQ.zip', await buildZip(entries));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(r.result.emptyFolders, [], 'every declared folder holds something');
});

test('cad format: which one is the cutting file is the customer\'s choice, not ours', async () => {
    attachmentRows = [attRow(1, 'RFQ.zip')];
    const pkg = {
        'RFQ/3010-014188-01/3010-014188-01.dxf': 'flat',
        'RFQ/3010-014188-01/3010-014188-01.STP': 'solid',
        'RFQ/3010-014188-01/3010-014188-01.pdf': 'drawing',
    };
    zipBuffers.set('f_RFQ.zip', await buildZip(pkg));

    // The default ranking came from a portal whose line list names the .step.
    const asIs = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(asIs.result.pairs[0].cadName, '3010-014188-01.STP');

    // A waterjet shop's names the .dxf on all 77 of its lines: for them the flat
    // file IS the cutting file and the solid is reference. Only the head of the
    // ranking moves — the solid is still on the line, just not chosen.
    zipBuffers.set('f_RFQ.zip', await buildZip(pkg));
    attachmentRows = [attRow(1, 'RFQ.zip')];
    const preferred = await actionExecutor.executeDataStep(app, model, step({ cadPreferred: 'dxf' }), ctx());
    assert.strictEqual(preferred.result.pairs[0].cadName, '3010-014188-01.dxf');
    assert.deepStrictEqual(preferred.result.pairs[0].extraCad, ['3010-014188-01.STP']);
});

test('flat archive: two names that differ only by an operation are a QUESTION', async () => {
    // Without a folder there is nothing to arbitrate: "(afschuining)" may be one
    // plate cut once, and "(links)"/"(rechts)" are two. Merging cuts one plate
    // too few and splitting cuts one too many, so both lines stand and both are
    // flagged rather than one of them being guessed away.
    attachmentRows = [attRow(1, 'pakket.zip')];
    zipBuffers.set('f_pakket.zip', await buildZip({
        '3010-010857-01.dxf': 'plain',
        '3010-010857-01 (afschuining).dxf': 'chamfered',
        '3010-010857-01.pdf': 'drawing',
    }));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.pairs.length, 2, 'neither is thrown away');
    assert.deepStrictEqual([...new Set(r.result.pairs.map((p) => p.matchStatus))], ['controleren'],
        'and neither is presented as settled');
});

test('loose mail: a plain order grows no folder, no operation and no extra file', async () => {
    // The regression that matters most: every rule above keys off a folder, and
    // a mailed pair has none. Nothing about the old shape may move.
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    const tn1 = r.result.pairs.find((p) => p.baseName === 'tn-1');
    assert.strictEqual(tn1.folder, '');
    assert.strictEqual(tn1.operation, '');
    assert.deepStrictEqual(tn1.extraCad, []);
    assert.strictEqual(tn1.partKey, 'tn-1');
    assert.strictEqual(tn1.matchStatus, 'exact');
    assert.deepStrictEqual(r.result.emptyFolders, []);
});

test('writeTo: the part key, the machining and the folder land in their columns', async () => {
    attachmentRows = [attRow(1, 'RFQ.zip')];
    zipBuffers.set('f_RFQ.zip', await buildZip({
        'RFQ/3010-010857-01 (Afschuining)/3010-010857-01.dxf': 'plain',
        'RFQ/3010-010857-01 (Afschuining)/3010-010857-01 (afschuining).dxf': 'chamfered',
        'RFQ/3010-010857-01 (Afschuining)/3010-010857-01.pdf': 'drawing',
    }));
    const writeTo = {
        tableId: 'tbl_pairs',
        mapping: {
            basisnaam: 'base_name',
            part_key: 'part_key',
            bewerking: 'operation',
            map: 'folder',
            extra_cad: 'extra_cad',
        },
        constants: { thread_key: { kind: 'static', value: 't-1' } },
    };

    const r = await actionExecutor.executeDataStep(app, model, step({ writeTo }), ctx());
    assert.strictEqual(r.ok, true, r.error);
    const insert = execCalls.find((c) => /INSERT INTO "pairs"/.test(c.sql));
    assert.ok(insert.params.includes('3010-010857-01'), 'part_key is the join key an order sheet can be matched on');
    assert.ok(insert.params.includes('afschuining'));
    assert.ok(insert.params.includes('RFQ/3010-010857-01 (Afschuining)'));
    assert.ok(insert.params.includes('3010-010857-01.dxf'), 'the cutting file this line did not take');
});

// ── which spreadsheet is the bill of materials ──────────────────────────────

test('sheet: the one that NAMES the parts wins over the one that is merely bigger', async () => {
    // The live failure: three sheets, and "biggest wins" picked a stripped
    // export by two kilobytes — three populated columns instead of twelve, and
    // no thickness anywhere in it.
    attachmentRows = [
        attRow(1, '3010-005424-01.dxf'),
        attRow(2, '3010-005424-01.pdf'),
        attRow(3, 'contacten.csv'),
        attRow(4, 'stuklijst.csv'),
    ];
    descriptorSizes.set('f_contacten.csv', 96_000);
    descriptorSizes.set('f_stuklijst.csv', 900);
    zipBuffers.set('f_contacten.csv', Buffer.from(`naam,telefoon\n${'Jan,0612345678\n'.repeat(300)}`, 'utf8'));
    zipBuffers.set('f_stuklijst.csv', Buffer.from(
        'Item No.;Variant;Quantity;Material;Height\n3010-005424;01;6;EN AW-6082 T6;8\n', 'utf8',
    ));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.sheetName, 'stuklijst.csv');
    // …and the choice is not hidden: every candidate is reported with what it
    // looked like, so a screen can offer the other one.
    const contacts = r.result.sheets.find((c) => c.name === 'contacten.csv');
    assert.strictEqual(contacts.hits, 0);
    assert.ok(r.result.sheets.find((c) => c.name === 'stuklijst.csv').hits >= 1);
});

test('sheet: a ready-made line list is reported apart from the bill of materials', async () => {
    // A file whose headers already ARE the target columns is not a table to
    // interpret — it is an answer. Naming it separately is what lets an app skip
    // a model call rather than pay one to read what it was handed.
    attachmentRows = [
        attRow(1, '3010-005424-01.dxf'),
        attRow(2, '3010-005424-01.pdf'),
        attRow(3, 'stuklijst.csv'),
        attRow(4, 'projectlines_output.csv'),
    ];
    zipBuffers.set('f_stuklijst.csv', Buffer.from(
        'Item No.;Variant;Quantity;Material;Height\n3010-005424;01;6;EN AW-6082 T6;8\n', 'utf8',
    ));
    zipBuffers.set('f_projectlines_output.csv', Buffer.from(
        'cadfile;Material;Thickness;Quantity;Orientation\n3010-005424-01.dxf;Aluminium 6082;10;6;8\n', 'utf8',
    ));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.sheetName, 'stuklijst.csv', 'the table to interpret');
    assert.strictEqual(r.result.lineListName, 'projectlines_output.csv', 'and the list to import');
    assert.ok(r.result.lineListFile, 'redeemed, not just named');
});

test('sheet: a spreadsheet nobody can open still ranks, by size, exactly as before', async () => {
    // The scan is an improvement on the old rule, not a replacement for having
    // one: bytes we cannot read teach us nothing, and falling back beats
    // guessing.
    attachmentRows = [attRow(1, 'contactgegevens.csv'), attRow(2, 'stuklijst.xlsx')];
    descriptorSizes.set('f_contactgegevens.csv', 800);
    descriptorSizes.set('f_stuklijst.xlsx', 96_000);
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.result.sheetName, 'stuklijst.xlsx');
    assert.deepStrictEqual(r.result.sheets.map((c) => c.hits), [null, null], 'and says it could not look');
});

// ── the container itself ────────────────────────────────────────────────────

test('archive: a zip inside a zip is opened, one level deep', async () => {
    // A FORWARDED ORDER LOOKS EXACTLY LIKE THIS, and so does "I zipped the
    // project folder" when that folder already had a zip in it. Refusing it
    // outright cost a real customer their package.
    attachmentRows = [attRow(1, 'doorgestuurd.zip')];
    const inner = await buildZip({
        'order/3010-005424-01.dxf': 'cut',
        'order/3010-005424-01.pdf': 'drawing',
    });
    zipBuffers.set('f_doorgestuurd.zip', await buildZip({
        'bijlagen/order.zip': inner,
        'bijlagen/leesmij.txt': 'stuur maar door',
    }));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.pairs.length, 1, 'the part inside the inner archive is a line');
    assert.strictEqual(r.result.pairs[0].baseName, '3010-005424-01');
    assert.strictEqual(r.result.pairs[0].role, 'paired');

    // The inner archive's entries keep their own path UNDER it, so two nested
    // packages that each carry an "order/" folder stay two packages.
    assert.strictEqual(r.result.pairs[0].folder, 'bijlagen/order.zip/order');
});

test('archive: nesting stops at the budget, and says that is why', async () => {
    attachmentRows = [attRow(1, 'buiten.zip')];
    const deepest = await buildZip({ 'a/3010-005424-01.dxf': 'cut' });
    const middle = await buildZip({ 'binnen.zip': deepest });
    zipBuffers.set('f_buiten.zip', await buildZip({ 'midden.zip': middle }));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    const refusals = r.result.zips.flatMap((z) => z.refusedEntries).map((e) => e.reason);
    assert.ok(refusals.some((x) => /nested more than/.test(x)), 'the third level is named, not silently dropped');
    assert.strictEqual(r.result.pairs.length, 0, 'and nothing from it pretends to be a part');
});

test('archive: a password-protected zip is not a broken one', async () => {
    // "Could not open the zip" sends somebody hunting a corrupt file. The
    // general-purpose flag says plainly what is actually wrong, and that is a
    // sentence they can forward to the customer.
    attachmentRows = [attRow(1, 'beveiligd.zip'), attRow(2, 'TN-1.pdf'), attRow(3, 'TN-1.step')];
    const plain = await buildZip({ 'order/TN-9.pdf': 'tekening' });
    const locked = Buffer.from(plain);
    locked.writeUInt16LE(locked.readUInt16LE(6) | 0x01, 6);      // encryption bit
    zipBuffers.set('f_beveiligd.zip', locked);

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.match(r.result.zips[0].refusedEntries[0].reason, /password/i);
    assert.strictEqual(r.result.pairs.length, 1, 'and the rest of the conversation still works');
});

test('archive: a .7z is named as a .7z, not stored and forgotten', async () => {
    // We do not run a third-party archiver over mailed bytes, so this one
    // genuinely cannot be opened. What must not happen is silence: the file
    // holding the whole order sitting in the list with nothing said about it.
    attachmentRows = [attRow(1, 'order.7z')];
    zipBuffers.set('f_order.7z', Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]));

    const r = await actionExecutor.executeDataStep(app, model, step({ allowEmpty: true }), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.zips[0].format, '7z', 'the format is identified');
    assert.match(r.result.zips[0].refusedEntries[0].reason, /\.7z/);
    assert.match(r.result.zips[0].refusedEntries[0].reason, /zip/, 'and it says what to ask for instead');
});

test('archive: a .tar.gz unpacks like any other package', async () => {
    attachmentRows = [attRow(1, 'order.tar.gz')];
    zipBuffers.set('f_order.tar.gz', require('zlib').gzipSync(buildTar({
        'RFQ/3010-005424-01/3010-005424-01.dxf': 'cut',
        'RFQ/3010-005424-01/3010-005424-01.pdf': 'drawing',
    })));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.zips[0].format, 'gzip');
    assert.strictEqual(r.result.zips[0].extracted, 2);
    assert.strictEqual(r.result.pairs.length, 1);
    assert.strictEqual(r.result.pairs[0].baseName, '3010-005424-01');
    assert.strictEqual(r.result.pairs[0].folder, 'RFQ/3010-005424-01', 'folders survive the other container too');
});

test('sample: one document to look at when no order and no sheet arrived', async () => {
    // An app asking a model "what kind of request is this?" has to show it
    // SOMETHING. The obvious fallback was pairs[0].drawingFile, which reads an
    // array that is empty exactly when nothing paired — and that 'summary'
    // empties on purpose. One descriptor of its own survives both.
    attachmentRows = [attRow(1, '3010-005424-01.dxf'), attRow(2, '3010-005424-01.pdf')];
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.poFile, null, 'no order document');
    assert.strictEqual(r.result.sheetFile, null, 'and no bill of materials');
    assert.strictEqual(r.result.sampleName, '3010-005424-01.pdf', 'the drawing is what a model should be shown');
    assert.ok(r.result.sampleFile.fileId);
});

test('sample: a CAD file stands in when no drawing came at all', async () => {
    attachmentRows = [attRow(1, '3010-005424-01.dxf')];
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.result.sampleName, '3010-005424-01.dxf');
});

test('sample: nothing to look at is a null, and summary keeps it', async () => {
    attachmentRows = [attRow(1, 'logo.png')];
    const full = await actionExecutor.executeDataStep(app, model, step({ allowEmpty: true }), ctx());
    assert.strictEqual(full.result.sampleFile, null);

    attachmentRows = [attRow(1, '3010-005424-01.dxf'), attRow(2, '3010-005424-01.pdf')];
    const trimmed = await actionExecutor.executeDataStep(app, model, step({ resultDetail: 'summary' }), ctx());
    assert.deepStrictEqual(trimmed.result.pairs, [], 'the cargo is gone');
    assert.strictEqual(trimmed.result.parts, 1, 'the count is not');
    assert.strictEqual(trimmed.result.sampleName, '3010-005424-01.pdf', 'and neither is the one document');
});

test('summary: an empty article folder is still NAMED, just bounded', async () => {
    // A count with no names is a rumour. The whole reason this channel exists is
    // that somebody has to be able to write "3010-007033-01 is missing" back to
    // the customer.
    attachmentRows = [attRow(1, 'RFQ.zip')];
    const entries = { 'RFQ/3010-005424-01/3010-005424-01.dxf': 'cut', 'RFQ/3010-005424-01/3010-005424-01.pdf': 'drawing' };
    for (let i = 0; i < 14; i += 1) entries[`RFQ/3010-0070${33 + i}-01 (tappen)`] = null;
    zipBuffers.set('f_RFQ.zip', await buildZip(entries));

    const r = await actionExecutor.executeDataStep(app, model, step({ resultDetail: 'summary' }), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.emptyFolderCount, 14, 'all of them are counted');
    assert.strictEqual(r.result.emptyFolders.length, 10, 'and ten of them are named');
    assert.match(r.result.emptyFolders[0], /3010-0070/);
});

test('sheet: a part on the order that no file arrived for is NAMED, not dropped', async () => {
    // The mirror of an empty article folder, and the general case of it: mailed
    // loose, nothing in the package hints that a plate is missing. The files
    // still decide which lines exist — this only refuses to let one go quietly.
    attachmentRows = [
        attRow(1, '3010-005424-01.dxf'),
        attRow(2, '3010-005424-01.pdf'),
        attRow(3, 'stuklijst.csv'),
    ];
    zipBuffers.set('f_stuklijst.csv', Buffer.from(
        'Item No.;Variant;Quantity;Material;Height\n'
        + '3010-005424;01;6;EN AW-6082 T6;8\n'
        + '3010-007033;01;1;EN AW-6082 T6;10\n', 'utf8',
    ));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.parts, 1, 'one line, because one part had files');
    assert.deepStrictEqual(r.result.sheetOnly, ['3010-007033-01']);
    assert.strictEqual(r.result.sheetOnlySummary, '3010-007033-01', 'and as a sentence an action can print');
});

test('sheet: a spreadsheet that recognised nothing gets no say in what is missing', async () => {
    // Standing has to be earned. A stray export that names none of our parts
    // must not be allowed to declare the whole order absent.
    attachmentRows = [
        attRow(1, '3010-005424-01.dxf'),
        attRow(2, '3010-005424-01.pdf'),
        attRow(3, 'prijslijst.csv'),
    ];
    zipBuffers.set('f_prijslijst.csv', Buffer.from(
        'Artikel;Prijs\n7788-000001;12,50\n7788-000002;9,95\n', 'utf8',
    ));

    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(r.result.sheetOnly, []);
});

test('summary: the missing parts stay named there too, bounded', async () => {
    attachmentRows = [
        attRow(1, '3010-005424-01.dxf'),
        attRow(2, '3010-005424-01.pdf'),
        attRow(3, 'stuklijst.csv'),
    ];
    const rows = ['Item No.;Variant;Quantity', '3010-005424;01;6'];
    for (let i = 0; i < 14; i += 1) rows.push(`3010-0070${33 + i};01;1`);
    zipBuffers.set('f_stuklijst.csv', Buffer.from(`${rows.join('\n')}\n`, 'utf8'));

    const r = await actionExecutor.executeDataStep(app, model, step({ resultDetail: 'summary' }), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.sheetOnlyCount, 14);
    assert.strictEqual(r.result.sheetOnly.length, 10);
});
