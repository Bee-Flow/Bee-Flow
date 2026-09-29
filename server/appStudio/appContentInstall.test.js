/**
 * App Studio — appContentInstall (an archive's rows and documents into a live app).
 *
 * The thing under test is an ORDER. A record cannot be written before its
 * file's descriptor exists; a file cannot be stored before its record's id
 * exists, because the ledger's record_id is the permission an attachment is
 * later read WITH. Three passes cut that cycle, and the tests below are mostly
 * assertions about which pass did what, in which order, because every defect
 * this code can have looks like the passes having run in the wrong one.
 *
 * The second theme is BEST-EFFORT, NEVER SILENT. A row the engine refuses and
 * a file whose type is not allowed here are both survivable; the archive is
 * worth installing minus one drawing. What is not survivable is saying nothing
 * about it, so every skip is asserted to be named — and a quota refusal, which
 * will repeat identically for everything left, is asserted to STOP rather than
 * produce four hundred identical lines.
 *
 * Run: cd server && node --test appStudio/appContentInstall.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { installAppContent, _splitFileValues } = require('./appContentInstall');
const { canonicalizeDataModel } = require('./dataModel');

const APP = { id: 'app_1', userId: 'user_1', organizationId: 'org_1' };

function model() {
    return canonicalizeDataModel({
        tables: [
            {
                id: 'tbl_note', key: 'notes', name: 'Notes',
                fields: [
                    { id: 'fld_b', key: 'body', type: 'text' },
                    { id: 'fld_p', key: 'person', type: 'relation', relation: { table: 'tbl_person' } },
                ],
            },
            {
                id: 'tbl_person', key: 'people', name: 'People',
                fields: [
                    { id: 'fld_n', key: 'name', type: 'text' },
                    { id: 'fld_a', key: 'avatar', type: 'file' },
                ],
            },
        ],
    }).model;
}

/** A recorder standing in for the two edges this module writes through. */
function spy({ storeFails = null, writeFails = null } = {}) {
    const calls = [];
    let n = 0;
    return {
        calls,
        deps: {
            writeRecord: async (app, m, table, values, { viewer, recordId } = {}) => {
                calls.push({ op: recordId ? 'update' : 'create', table: table.key, values, recordId, viewer });
                if (writeFails) { const e = writeFails(table, values); if (e) throw e; }
                n += 1;
                return recordId ? { id: recordId, updated: true, changes: 1 } : { id: `rec_${n}`, created: true };
            },
            storeDerivedFile: async (app, { buffer, name, recordId, fieldKey }) => {
                calls.push({ op: 'store', name, recordId, fieldKey, bytes: buffer.length });
                if (storeFails) { const e = storeFails(name); if (e) throw e; }
                return { kind: 'studio_attachment', fileId: `att_${name}`, name, mime: 'application/pdf', size: buffer.length };
            },
        },
    };
}

function content(extra = {}) {
    return {
        records: {
            tbl_person: [{ $id: 'p1', name: 'Ada', avatar: { $file: 'f1' } }],
            tbl_note: [{ $id: 'n1', body: 'hi', person: { $ref: 'p1' } }],
        },
        files: [{ ref: 'f1', name: 'a.pdf', size: 3, sha256: 'x', buffer: Buffer.from('abc'), home: null }],
        ...extra,
    };
}

// ── The order ──────────────────────────────────────────────────────────────

test('rows first with the file column held back, then the file, then the column', async () => {
    const s = spy();
    const out = await installAppContent({ app: APP, model: model(), content: content(), deps: s.deps });
    assert.equal(out.ok, true);
    assert.equal(out.rows, 2);
    assert.equal(out.files, 1);

    const ops = s.calls.map((c) => `${c.op}:${c.table || c.name}`);
    assert.deepEqual(ops, ['create:people', 'create:notes', 'store:a.pdf', 'update:people']);

    // Pass 1 wrote the row WITHOUT the file column — the descriptor did not
    // exist yet, and writing a placeholder would have been writing a lie.
    assert.equal('avatar' in s.calls[0].values, false);
    // Pass 3 wrote it, and only it.
    assert.deepEqual(Object.keys(s.calls[3].values), ['avatar']);
    assert.equal(s.calls[3].values.avatar.fileId, 'att_a.pdf');
});

test('a parent is written before the child that points at it, and the $ref resolves', async () => {
    const s = spy();
    await installAppContent({ app: APP, model: model(), content: content(), deps: s.deps });
    const person = s.calls.find((c) => c.table === 'people');
    const note = s.calls.find((c) => c.table === 'notes');
    // The model declares notes first; dependency order puts people first anyway.
    assert.ok(s.calls.indexOf(person) < s.calls.indexOf(note));
    assert.equal(note.values.person, person ? 'rec_1' : null);
});

test('the file is homed on the record that referenced it, field and all', async () => {
    const s = spy();
    await installAppContent({ app: APP, model: model(), content: content(), deps: s.deps });
    const store = s.calls.find((c) => c.op === 'store');
    assert.equal(store.recordId, 'rec_1');
    assert.equal(store.fieldKey, 'avatar');
});

test('an explicit home wins over the first row that happened to mention the file', async () => {
    const s = spy();
    const c = content();
    // Two rows reference one file; the archive says the SECOND is its home.
    c.records.tbl_person.push({ $id: 'p2', name: 'Bob', avatar: { $file: 'f1' } });
    c.files[0].home = { record: 'p2', field: 'avatar' };
    await installAppContent({ app: APP, model: model(), content: c, deps: s.deps });
    const store = s.calls.find((c2) => c2.op === 'store');
    assert.equal(store.recordId, 'rec_2');
});

test('a home naming an alias the archive does not carry falls back, it does not null out', async () => {
    const s = spy();
    const c = content();
    c.files[0].home = { record: 'nobody', field: 'avatar' };
    await installAppContent({ app: APP, model: model(), content: c, deps: s.deps });
    const store = s.calls.find((c2) => c2.op === 'store');
    assert.equal(store.recordId, 'rec_1');
});

test('a home naming a column that is not a file column is not believed', async () => {
    const s = spy();
    const c = content();
    c.files[0].home = { record: 'p1', field: 'name' };
    await installAppContent({ app: APP, model: model(), content: c, deps: s.deps });
    const store = s.calls.find((c2) => c2.op === 'store');
    assert.equal(store.fieldKey, 'avatar');
});

test('one file referenced from two rows is stored once and written into both', async () => {
    const s = spy();
    const c = content();
    c.records.tbl_person.push({ $id: 'p2', name: 'Bob', avatar: { $file: 'f1' } });
    const out = await installAppContent({ app: APP, model: model(), content: c, deps: s.deps });
    assert.equal(out.files, 1);
    assert.equal(s.calls.filter((x) => x.op === 'store').length, 1);
    assert.equal(s.calls.filter((x) => x.op === 'update').length, 2);
});

test('an archive with no files never touches a row twice', async () => {
    const s = spy();
    const c = content({ files: [] });
    c.records.tbl_person[0] = { $id: 'p1', name: 'Ada' };
    const out = await installAppContent({ app: APP, model: model(), content: c, deps: s.deps });
    assert.equal(out.rows, 2);
    assert.equal(s.calls.filter((x) => x.op === 'update').length, 0);
});

// ── Best-effort, never silent ──────────────────────────────────────────────

test('a refused file leaves its column NULL rather than a descriptor to nothing', async () => {
    const s = spy({ storeFails: () => Object.assign(new Error('That file type is not supported'), { status: 415 }) });
    const out = await installAppContent({ app: APP, model: model(), content: content(), deps: s.deps });
    assert.equal(out.ok, true);
    assert.equal(out.files, 0);
    assert.ok(out.skipped.some((w) => /a\.pdf/.test(w) && /not supported/.test(w)));
    // No third pass for a column with nothing to put in it.
    assert.equal(s.calls.filter((x) => x.op === 'update').length, 0);
});

test('a row the engine refuses is skipped and named, and the rest still land', async () => {
    const s = spy({ writeFails: (t) => (t.key === 'notes' ? new Error('unique constraint') : null) });
    const out = await installAppContent({ app: APP, model: model(), content: content(), deps: s.deps });
    assert.equal(out.ok, true);
    assert.equal(out.rows, 1);
    assert.ok(out.skipped.some((w) => /row in notes/.test(w) && /unique constraint/.test(w)));
});

test('a quota refusal on rows stops at once instead of repeating itself', async () => {
    const s = spy({ writeFails: () => Object.assign(new Error('row limit reached'), { status: 409, code: 'quota_exceeded' }) });
    const c = content();
    c.records.tbl_person = Array.from({ length: 50 }, (_, i) => ({ $id: `p${i}`, name: 'x' }));
    const out = await installAppContent({ app: APP, model: model(), content: c, deps: s.deps });
    assert.equal(out.ok, false);
    assert.match(out.error, /stopped while writing rows/);
    assert.equal(s.calls.length, 1);
});

test('a quota refusal on files keeps what already landed and says where it stopped', async () => {
    let n = 0;
    const s = spy({ storeFails: () => (++n > 1 ? Object.assign(new Error('storage full'), { status: 413 }) : null) });
    const c = content();
    c.records.tbl_person = [
        { $id: 'p1', name: 'A', avatar: { $file: 'f1' } },
        { $id: 'p2', name: 'B', avatar: { $file: 'f2' } },
        { $id: 'p3', name: 'C', avatar: { $file: 'f3' } },
    ];
    c.files = ['f1', 'f2', 'f3'].map((ref) => ({ ref, name: `${ref}.pdf`, buffer: Buffer.from('abc') }));
    const out = await installAppContent({ app: APP, model: model(), content: c, deps: s.deps });
    assert.equal(out.ok, true);
    assert.equal(out.files, 1);
    assert.ok(out.skipped.some((w) => /stopped storing files after 1/.test(w)));
    assert.equal(s.calls.filter((x) => x.op === 'store').length, 2);
});

test('no model is a refusal, not an empty success', async () => {
    const out = await installAppContent({ app: APP, model: null, content: content() });
    assert.equal(out.ok, false);
    assert.match(out.error, /No data model/);
});

// ── The splitter ───────────────────────────────────────────────────────────

test('splitFileValues separates the file refs and leaves everything else alone', () => {
    const { plain, fileRefs } = _splitFileValues({
        name: 'Ada', n: 3, nothing: null, avatar: { $file: 'f1' }, shape: { a: 1 },
    });
    assert.deepEqual(plain, { name: 'Ada', n: 3, nothing: null, shape: { a: 1 } });
    assert.deepEqual(fileRefs, { avatar: 'f1' });
});
