/**
 * App Studio — appPortability (a whole app, with its data, as a file coming IN).
 *
 * There is no export half to test, and that absence is itself a rule: the
 * product reads app archives and never writes one. So every test here is a
 * question about a file somebody handed us, and the answers divide in two.
 *
 * WHAT THE FILE MAY NOT DECIDE. Not which records exist (the model decides),
 * not which columns they have, not who owns the app, and above all not what a
 * pointer means: a bare `rec_…` in a relation column and a stored
 * `{ kind:'studio_attachment', fileId }` in a file column are both identifiers
 * in the database the archive came out of, and honouring either would aim a
 * row at whatever happens to hold that id here.
 *
 * WHAT THE FILE MUST PROVE. That its bytes are its bytes. Base64 decoding is
 * forgiving — a truncated string decodes to a short buffer without complaint —
 * so the sha256 is the only thing standing between "the archive carries this
 * drawing" and "the archive carries most of this drawing". It is checked once,
 * here, before anything is created.
 *
 * Run: cd server && node --test appStudio/appPortability.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const {
    APP_FORMAT, APP_SCHEMA_VERSION, MAX_RECORDS_TOTAL, MAX_RECORDS_PER_TABLE, MAX_FILES,
    sanitizeAppImport, readSource, _claimFileName,
} = require('./appPortability');
const { EXPORT_FORMAT } = require('./templatePortability');
const { canonicalizeDataModel } = require('./dataModel');
const { emptyDefinition } = require('./componentSpecs');

// ── Fixtures ───────────────────────────────────────────────────────────────

const PDF = Buffer.from('%PDF-1.4 hello');
const PDF_SHA = crypto.createHash('sha256').update(PDF).digest('hex');

function baseModel() {
    return canonicalizeDataModel({
        tables: [
            {
                id: 'tbl_a', key: 'people', name: 'People',
                fields: [
                    { id: 'fld_1', key: 'name', type: 'text' },
                    { id: 'fld_2', key: 'avatar', type: 'file' },
                    { id: 'fld_3', key: 'label', type: 'computed', computed: { expr: "'x'", type: 'text' } },
                ],
            },
            {
                id: 'tbl_b', key: 'notes', name: 'Notes',
                fields: [
                    { id: 'fld_4', key: 'body', type: 'text' },
                    { id: 'fld_5', key: 'person', type: 'relation', relation: { table: 'tbl_a' } },
                ],
            },
        ],
    }).model;
}

function fileEntry(extra = {}) {
    return {
        ref: 'f1', name: 'drawing.pdf', mime: 'application/pdf',
        size: PDF.length, sha256: PDF_SHA, data: PDF.toString('base64'),
        ...extra,
    };
}

function envelope(extra = {}) {
    return {
        format: APP_FORMAT,
        schemaVersion: APP_SCHEMA_VERSION,
        exportedAt: '2026-09-22T10:00:00.000Z',
        source: { appId: 'app-there', orgId: 'org-there', orgName: 'Acme' },
        app: { name: 'Requests', description: 'A demo', icon: 'Inbox', accentColor: '#3366ff' },
        template: { definition: emptyDefinition('Requests'), dataModel: baseModel(), datasets: [] },
        content: {
            records: {
                tbl_a: [{ $id: 'people_1', name: 'Ada', avatar: { $file: 'f1' }, label: 'ignored' }],
                tbl_b: [{ $id: 'notes_1', body: 'hi', person: { $ref: 'people_1' } }],
            },
            files: [fileEntry()],
        },
        ...extra,
    };
}

// ── The format gate ────────────────────────────────────────────────────────

test('a file that is not an archive is refused before anything is read', () => {
    for (const bad of [null, 42, 'x', {}, { format: 'something-else' }]) {
        const out = sanitizeAppImport(bad);
        assert.equal(out.template, null);
        assert.ok(out.errors.length);
    }
});

test('a TEMPLATE file is named as one rather than called unreadable', () => {
    const out = sanitizeAppImport({ format: EXPORT_FORMAT, schemaVersion: 1, template: {} });
    assert.equal(out.template, null);
    assert.match(out.errors[0], /app TEMPLATE file/);
    assert.match(out.errors[0], /From a template file/);
});

test('an unsupported schema version says which versions this build reads', () => {
    const out = sanitizeAppImport(envelope({ schemaVersion: 99 }));
    assert.equal(out.template, null);
    assert.match(out.errors[0], /version 99 is not supported/);
});

// ── The happy path ─────────────────────────────────────────────────────────

test('a well-formed archive comes back with its app, its rows and its files', () => {
    const out = sanitizeAppImport(envelope());
    assert.deepEqual(out.errors, []);
    assert.equal(out.app.name, 'Requests');
    assert.equal(out.app.icon, 'Inbox');
    assert.equal(out.app.accentColor, '#3366ff');
    assert.ok(out.template.definition);
    assert.equal(out.report.rows, 2);
    assert.equal(out.report.files, 1);
    assert.equal(out.report.fileBytes, PDF.length);
    // The bytes are decoded once, here, and travel as a Buffer.
    assert.ok(Buffer.isBuffer(out.content.files[0].buffer));
    assert.equal(out.content.files[0].buffer.toString(), PDF.toString());
});

test('a file reference survives as { $file } and a relation as { $ref }', () => {
    const out = sanitizeAppImport(envelope());
    assert.deepEqual(out.content.records.tbl_a[0].avatar, { $file: 'f1' });
    assert.deepEqual(out.content.records.tbl_b[0].person, { $ref: 'people_1' });
});

test('a computed column never arrives: the engine writes it on this side', () => {
    const out = sanitizeAppImport(envelope());
    assert.equal('label' in out.content.records.tbl_a[0], false);
    assert.ok(out.warnings.some((w) => /computed/.test(w)));
});

test('the app card is cosmetic and every part of it is cleaned', () => {
    const out = sanitizeAppImport(envelope({
        app: { name: '  Padded  ', description: 'd'.repeat(900), icon: '', accentColor: 'javascript:alert(1)' },
    }));
    assert.equal(out.app.name, 'Padded');
    assert.equal(out.app.description.length, 400);
    assert.equal(out.app.icon, null);
    // Not a colour token, so it never reaches a style attribute.
    assert.equal(out.app.accentColor, null);
});

// ── Identity never travels ─────────────────────────────────────────────────

test('a stored attachment descriptor in a file column is emptied, never honoured', () => {
    const e = envelope();
    e.content.records.tbl_a[0].avatar = { kind: 'studio_attachment', fileId: 'att-over-there', name: 'x.pdf' };
    const out = sanitizeAppImport(e);
    assert.equal(out.content.records.tbl_a[0].avatar, null);
    assert.ok(out.warnings.some((w) => /file value\(s\) emptied/.test(w)));
});

test('a { $file } at a ref the archive does not carry is emptied', () => {
    const e = envelope();
    e.content.records.tbl_a[0].avatar = { $file: 'nope' };
    const out = sanitizeAppImport(e);
    assert.equal(out.content.records.tbl_a[0].avatar, null);
});

test('a bare rec_ id in a relation column is emptied', () => {
    const e = envelope();
    e.content.records.tbl_b[0].person = 'rec_from_their_database';
    const out = sanitizeAppImport(e);
    assert.equal(out.content.records.tbl_b[0].person, null);
    assert.ok(out.warnings.some((w) => /relation value\(s\) emptied/.test(w)));
});

test('the source block is a claim: normalised, capped, and granting nothing', () => {
    const s = readSource({ source: { appId: 'a'.repeat(200), orgName: { nope: 1 }, orgId: '   ' } });
    assert.equal(s.appId.length, 64);
    assert.equal(s.orgName, null);
    assert.equal(s.orgId, null);
});

// ── The bytes have to be the bytes ─────────────────────────────────────────

test('a blob whose sha256 does not match is dropped and named', () => {
    const e = envelope();
    e.content.files = [fileEntry({ sha256: 'a'.repeat(64) })];
    const out = sanitizeAppImport(e);
    assert.equal(out.content.files.length, 0);
    assert.ok(out.warnings.some((w) => /do not match the sha256/.test(w)));
    // …and the row that pointed at it empties rather than dangling.
    assert.equal(out.content.records.tbl_a[0].avatar, null);
});

test('a truncated blob is caught by the hash, not by the length', () => {
    const e = envelope();
    const half = PDF.toString('base64').slice(0, 8);
    e.content.files = [fileEntry({ data: half })];
    const out = sanitizeAppImport(e);
    assert.equal(out.content.files.length, 0);
});

test('an entry with no sha256 to check against is refused', () => {
    const e = envelope();
    e.content.files = [fileEntry({ sha256: undefined })];
    const out = sanitizeAppImport(e);
    assert.equal(out.content.files.length, 0);
    assert.ok(out.warnings.some((w) => /no sha256/.test(w)));
});

test('two entries claiming one ref: the second is dropped, not silently merged', () => {
    const e = envelope();
    e.content.files = [fileEntry(), fileEntry({ name: 'other.pdf' })];
    const out = sanitizeAppImport(e);
    assert.equal(out.content.files.length, 1);
    assert.ok(out.warnings.some((w) => /a second entry claims this ref/.test(w)));
});

test('a file name is a name, never a path', () => {
    assert.equal(_claimFileName('../../etc/passwd'), 'passwd');
    assert.equal(_claimFileName('C:\\Users\\bob\\x.pdf'), 'x.pdf');
    assert.equal(_claimFileName('a\u0000b.pdf'), 'ab.pdf');
    assert.equal(_claimFileName('..'), null);
    assert.equal(_claimFileName('   '), null);
    assert.equal(_claimFileName('x'.repeat(400)).length, 200);
});

test('an entry with no usable name is refused: the name proposes the type', () => {
    const e = envelope();
    e.content.files = [fileEntry({ name: '///' })];
    const out = sanitizeAppImport(e);
    assert.equal(out.content.files.length, 0);
});

// ── Ceilings ───────────────────────────────────────────────────────────────

test('more files than the ceiling: the excess is dropped and counted', () => {
    const e = envelope();
    e.content.files = Array.from({ length: MAX_FILES + 3 }, (_, i) => fileEntry({ ref: `f${i}` }));
    const out = sanitizeAppImport(e);
    assert.ok(out.content.files.length <= MAX_FILES);
    assert.ok(out.warnings.some((w) => /file ceiling/.test(w)));
});

test('one table over the per-table ceiling is cut, and the cut is reported', () => {
    const e = envelope();
    e.content.records.tbl_b = Array.from({ length: MAX_RECORDS_PER_TABLE + 5 }, () => ({ body: 'x' }));
    const out = sanitizeAppImport(e);
    assert.equal(out.content.records.tbl_b.length, MAX_RECORDS_PER_TABLE);
    assert.ok(out.warnings.some((w) => /per-table ceiling/.test(w)));
});

test('an archive over the TOTAL-row ceiling is refused whole, not truncated', () => {
    // The per-table cap bites first, so the total is only reachable across
    // several tables — which is exactly the shape it exists to catch.
    const tables = [];
    const records = {};
    const n = Math.ceil((MAX_RECORDS_TOTAL + 1) / MAX_RECORDS_PER_TABLE);
    for (let i = 0; i < n; i += 1) {
        tables.push({ id: `tbl_${i}`, key: `t${i}`, name: `T${i}`, fields: [{ id: `fld_${i}`, key: 'body', type: 'text' }] });
        records[`tbl_${i}`] = Array.from({ length: MAX_RECORDS_PER_TABLE }, () => ({ body: 'x' }));
    }
    const e = envelope();
    e.template.dataModel = canonicalizeDataModel({ tables }).model;
    e.content.records = records;
    e.content.files = [];
    const out = sanitizeAppImport(e);
    assert.equal(out.template, null);
    assert.match(out.errors[0], /over the .*-row ceiling/);
});

test('rows for a table the model does not have are dropped and reported', () => {
    const e = envelope();
    e.content.records.tbl_missing = [{ body: 'x' }];
    const out = sanitizeAppImport(e);
    assert.equal('tbl_missing' in out.content.records, false);
    assert.ok(out.warnings.some((w) => /its data model does not contain/.test(w)));
});

test('rows with no data model to put them in are reported, not silently lost', () => {
    const e = envelope();
    delete e.template.dataModel;
    const out = sanitizeAppImport(e);
    assert.ok(out.template);
    assert.deepEqual(out.content.records, {});
    assert.ok(out.warnings.some((w) => /no data model to put them in/.test(w)));
});

// ── The gate is the template gate ──────────────────────────────────────────

test('a definition the validator refuses takes the whole archive with it', () => {
    const e = envelope();
    e.template.definition = { ...emptyDefinition('Requests'), screens: [] };
    const out = sanitizeAppImport(e);
    assert.equal(out.template, null);
    assert.ok(out.errors.length);
});

test('an archive with no template at all is refused', () => {
    const out = sanitizeAppImport(envelope({ template: undefined }));
    assert.equal(out.template, null);
    assert.match(out.errors[0], /carries no app/);
});

test('a routine reference is scrubbed on the way in, like a template', () => {
    const e = envelope();
    e.template.definition.actions = { act_run: { kind: 'run_automation', automationId: 'auto-over-there' } };
    const out = sanitizeAppImport(e);
    assert.ok(out.template);
    assert.equal(JSON.stringify(out.template.definition).includes('auto-over-there'), false);
});

// ── The home of a file ─────────────────────────────────────────────────────

test('a home naming an alias and a file field is carried through', () => {
    const e = envelope();
    e.content.files = [fileEntry({ home: { record: 'people_1', field: 'avatar' } })];
    const out = sanitizeAppImport(e);
    assert.deepEqual(out.content.files[0].home, { record: 'people_1', field: 'avatar' });
});

test('a half-written home is dropped rather than half-believed', () => {
    const e = envelope();
    e.content.files = [fileEntry({ home: { record: 'people_1' } })];
    const out = sanitizeAppImport(e);
    assert.equal(out.content.files[0].home, null);
});
