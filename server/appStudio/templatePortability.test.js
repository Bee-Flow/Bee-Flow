/**
 * App Studio — templatePortability (a template as a file, out and back in).
 *
 * The rules worth pinning here are all versions of one question: what may a
 * file decide about the installation that reads it? The answer is meant to be
 * "almost nothing", and the tests below are the almost.
 *
 * On the way OUT: nothing that names this organisation travels — not an automation
 * id, not an approver seat, not a knowledge base, not the template's own row id
 * — and the allow-list is what decides that, so a column added to
 * studio_app_templates next year is absent here by default rather than by
 * somebody remembering.
 *
 * On the way IN: the file passes the SAME gate a capture from a live app
 * passes, and the seed is rebuilt value by value against the model. The
 * relation rules carry the weight: a `rec_…` string in a relation column is an
 * identifier in the database the file came from, and resolving it here would
 * point a row at whatever happens to hold that id in ours.
 *
 * Run: cd server && node --test appStudio/templatePortability.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    EXPORT_FORMAT, EXPORT_SCHEMA_VERSION,
    buildExport, sanitizeImport, exportFilename, readSource,
} = require('./templatePortability');
const { captureTemplate } = require('./templateCapture');
const { canonicalizeDataModel } = require('./dataModel');
const { emptyDefinition } = require('./componentSpecs');

// ── Fixtures ───────────────────────────────────────────────────────────────

function baseDefinition() {
    const def = emptyDefinition('Source app');
    def.actions = {
        act_run: { kind: 'run_automation', automationId: 'auto-live-123' },
    };
    return def;
}

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

/** A template of exactly the shape templateRegistry hands out. */
function storedTemplate(extra = {}) {
    const captured = captureTemplate({
        definition: baseDefinition(),
        dataModel: baseModel(),
        rowsByTable: {
            tbl_a: [{ id: 'rec_ada', org_id: 'org-1', created_by: 'user-1', name: 'Ada', avatar: 'att_9', label: 'derived' }],
            tbl_b: [{ id: 'rec_n1', body: 'linked', person: 'rec_ada' }],
        },
        meta: { title: 'Intake starter', description: 'A starting point', category: 'Van je team', tags: ['intake'] },
    });
    assert.equal(captured.ok, true, captured.errors && captured.errors.join('; '));
    return {
        ...captured.template,
        // What the STORE adds around the payload. None of it is the template.
        id: 'utpl_abc123', source: 'captured', createdBy: 'user-1', sourceAppId: 'app_1',
        organizationId: 'org-1', createdAt: '2026-01-01', updatedAt: '2026-01-02',
        ...extra,
    };
}

function roundTrip(template, opts = {}) {
    const { envelope } = buildExport(template, opts);
    return sanitizeImport(envelope);
}

// ── The envelope ───────────────────────────────────────────────────────────

test('an exported template is a versioned envelope, and it imports back', () => {
    const { envelope, warnings } = buildExport(storedTemplate(), { exportedAt: '2026-09-22T10:00:00.000Z' });

    assert.equal(envelope.format, EXPORT_FORMAT);
    assert.equal(envelope.schemaVersion, EXPORT_SCHEMA_VERSION);
    assert.equal(envelope.exportedAt, '2026-09-22T10:00:00.000Z');
    assert.deepEqual(warnings, [], 'an already-scrubbed template exports without complaint');

    const back = sanitizeImport(envelope);
    assert.deepEqual(back.errors, []);
    assert.equal(back.template.title, 'Intake starter');
    assert.equal(back.template.description, 'A starting point');
    assert.deepEqual(back.template.tags, ['intake']);
    assert.equal(back.template.dataModel.tables.length, 2);
    assert.deepEqual(Object.keys(back.template.seed).sort(), ['tbl_a', 'tbl_b']);
});

test('the instance-local half of a stored template never travels', () => {
    const { envelope } = buildExport(storedTemplate());
    const carried = Object.keys(envelope.template).sort();
    for (const local of ['id', 'source', 'createdBy', 'sourceAppId', 'organizationId', 'createdAt', 'updatedAt']) {
        assert.equal(carried.includes(local), false, `${local} is where the template lived, not what it is`);
    }
});

test('a column added to the store tomorrow does not start travelling today', () => {
    // The allow-list, stated as the behaviour that makes it worth having.
    const { envelope } = buildExport(storedTemplate({ internalBillingRef: 'INV-2026-0042' }));
    assert.equal('internalBillingRef' in envelope.template, false);
});

test('a template with no id or version still produces a usable file', () => {
    const bare = storedTemplate();
    delete bare.version;
    const { envelope } = buildExport(bare);
    assert.equal(envelope.template.version, 1);
    assert.deepEqual(sanitizeImport(envelope).errors, []);
});

// ── The format gate ────────────────────────────────────────────────────────

test('anything that is not this format is refused before it is read', () => {
    for (const input of [null, undefined, 'a string', 42, [], { hello: 'world' }]) {
        const out = sanitizeImport(input);
        assert.equal(out.template, null);
        assert.equal(out.errors.length > 0, true);
    }
});

test('a future schema version is named, not guessed at', () => {
    const { envelope } = buildExport(storedTemplate());
    const out = sanitizeImport({ ...envelope, schemaVersion: 99 });
    assert.equal(out.template, null);
    assert.match(out.errors[0], /version 99 is not supported here/);
});

test('the right format with nothing in it says so', () => {
    const out = sanitizeImport({ format: EXPORT_FORMAT, schemaVersion: 1 });
    assert.equal(out.template, null);
    assert.match(out.errors[0], /carries no template/);
});

test('a definition that does not validate is refused, not stored broken', () => {
    const { envelope } = buildExport(storedTemplate());
    envelope.template.definition = { meta: { name: 'Broken' }, screens: [] };
    const out = sanitizeImport(envelope);
    assert.equal(out.template, null);
    assert.deepEqual(out.errors, ['screens.missing @ screens'],
        'the import gate is templateCapture\'s gate — the same bar every built-in template clears');
});

test('a file with no title at all is refused with the reason, not a stack trace', () => {
    const { envelope } = buildExport(storedTemplate());
    delete envelope.template.title;
    const out = sanitizeImport(envelope);
    assert.equal(out.template, null);
    assert.match(out.errors[0], /title is required/);
});

// ── What the way out removes ───────────────────────────────────────────────

test('an automation id picked up after capture is cleared on the way out, and said so', () => {
    const tpl = storedTemplate();
    // Canonicalize re-keys action ids, so the action is found rather than named.
    const actionId = Object.keys(tpl.definition.actions)[0];
    tpl.definition.actions[actionId].automationId = 'auto-somebody-elses';
    const { envelope, warnings } = buildExport(tpl);

    assert.equal(envelope.template.definition.actions[actionId].automationId, null);
    assert.equal(warnings.some((w) => /automation reference/.test(w)), true);
    assert.equal(JSON.stringify(envelope).includes('auto-somebody-elses'), false);
});

test('approver seats and knowledge bases are organisation facts and stay home', () => {
    const tpl = storedTemplate();
    tpl.definition.actions.act_appr = {
        kind: 'request_approval', approverUserIds: ['user-7'], knowledgeBaseIds: ['kb_9'],
    };
    const { envelope, warnings } = buildExport(tpl);

    const action = envelope.template.definition.actions.act_appr;
    assert.equal(action.approverUserIds, undefined, 'a seat names a real person here');
    assert.deepEqual(action.knowledgeBaseIds, []);
    assert.equal(warnings.some((w) => /approver seat/.test(w)), true);
    assert.equal(warnings.some((w) => /knowledge-base/.test(w)), true);
});

test('the never-installable key classes are dropped by the shared rule, both ways', () => {
    const tpl = storedTemplate();
    tpl.definition.actions.act_tool = { kind: 'run_automation', automationId: null, fixedArgs: { token: 'secret' } };
    tpl.definition.meta.ai = { publicEnabled: true, publicDailyCapUsd: 50 };

    const { envelope } = buildExport(tpl);
    assert.equal('fixedArgs' in envelope.template.definition.actions.act_tool, false);
    assert.equal('publicEnabled' in (envelope.template.definition.meta.ai || {}), false);

    // And again on the way in, because a file can be hand-written.
    const hostile = {
        format: EXPORT_FORMAT, schemaVersion: 1,
        template: { ...envelope.template },
    };
    hostile.template.definition = JSON.parse(JSON.stringify(envelope.template.definition));
    hostile.template.definition.actions.act_tool.fixedArgs = { token: 'secret' };
    const back = sanitizeImport(hostile);
    assert.deepEqual(back.errors, []);
    assert.equal(JSON.stringify(back.template.definition).includes('fixedArgs'), false);
});

// ── What the way in refuses to believe ─────────────────────────────────────

test('the file does not get to choose its id or its version here', () => {
    const { envelope } = buildExport(storedTemplate());
    envelope.template.id = 'utpl_pick_me';
    envelope.template.version = 47;

    const out = sanitizeImport(envelope);
    assert.equal(out.template.id, null, 'the store mints the id — importing twice makes two templates');
    assert.equal(out.template.version, 1, 'version is a statement about a line of edits, and this is its first here');
});

test('the provenance block is normalised into a claim and never believed', () => {
    const { envelope } = buildExport(storedTemplate(), {
        source: { templateId: 'utpl_abc123', orgId: 'org-1', orgName: 'Acme BV', version: 3 },
    });
    assert.deepEqual(envelope.source, { templateId: 'utpl_abc123', orgId: 'org-1', orgName: 'Acme BV', version: 3 });

    const wild = readSource({ source: { orgName: { nested: 'object' }, orgId: 'x'.repeat(500), version: -4 } });
    assert.equal(wild.orgName, null);
    assert.equal(wild.orgId.length, 64);
    assert.equal(wild.version, null);

    const out = sanitizeImport({ ...envelope, source: { orgName: 'Totally Trustworthy', version: 999 } });
    assert.equal(out.report.source.orgName, 'Totally Trustworthy');
    assert.equal(out.template.version, 1, 'a claim in the file decides nothing about what is stored');
});

// ── The seed, rebuilt value by value ───────────────────────────────────────

function importWithSeed(seed, extra = {}) {
    const { envelope } = buildExport(storedTemplate());
    envelope.template.seed = seed;
    Object.assign(envelope.template, extra);
    return sanitizeImport(envelope);
}

test('a relation pointing at a row id from the source database is emptied', () => {
    const out = importWithSeed({
        tbl_a: [{ $id: 'people_1', name: 'Ada' }],
        tbl_b: [{ body: 'linked', person: 'rec_ada' }],
    });
    assert.equal(out.template.seed.tbl_b[0].person, null,
        'a rec_ id names a row in the database the file came from');
    assert.equal(out.warnings.some((w) => /relation value/.test(w)), true);
});

test('a $ref at an alias the file does not carry is emptied', () => {
    const out = importWithSeed({
        tbl_b: [{ body: 'orphan', person: { $ref: 'people_9' } }],
    });
    assert.equal(out.template.seed.tbl_b[0].person, null);
});

test('a $ref resolves across tables, in either authoring order', () => {
    const out = importWithSeed({
        tbl_b: [{ body: 'linked', person: { $ref: 'people_1' } }],
        tbl_a: [{ $id: 'people_1', name: 'Ada' }],
    });
    assert.deepEqual(out.template.seed.tbl_b[0].person, { $ref: 'people_1' },
        'templateInstall resolves aliases from ONE global map, so order cannot matter');
});

test('a $ref smuggled onto a text column is refused rather than resolved', () => {
    const out = importWithSeed({
        tbl_a: [{ $id: 'people_1', name: 'Ada' }],
        tbl_b: [{ body: { $ref: 'people_1' }, person: null }],
    });
    assert.equal(out.template.seed.tbl_b[0].body, null,
        'templateInstall resolves $ref on ANY key — a record id is not a sentence');
});

test('unknown tables, unknown columns, system columns and untravelled types are dropped', () => {
    const out = importWithSeed({
        tbl_nope: [{ anything: 1 }],
        tbl_a: [{
            $id: 'people_1', name: 'Ada',
            id: 'rec_ada', created_by: 'user-1', org_id: 'org-1',   // system
            avatar: 'att_9',                                        // file
            label: 'derived',                                       // computed
            nosuchcolumn: 'x',
        }],
    });
    assert.deepEqual(out.template.seed.tbl_a[0], { $id: 'people_1', name: 'Ada' });
    assert.equal('tbl_nope' in out.template.seed, false);
    assert.equal(out.warnings.some((w) => /seed table\(s\) dropped/.test(w)), true);
    assert.equal(out.warnings.some((w) => /seed value\(s\) dropped/.test(w)), true);
});

test('the per-table row ceiling holds against a file that ignores it', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ name: `Person ${i}` }));
    const out = importWithSeed({ tbl_a: many });
    assert.equal(out.template.seed.tbl_a.length, 100);
    assert.equal(out.warnings.some((w) => /seed row\(s\) dropped/.test(w)), true);
});

test('rows that are not rows are dropped rather than carried', () => {
    const out = importWithSeed({ tbl_a: ['a string', 42, null, { name: 'Ada' }] });
    assert.equal(out.template.seed.tbl_a.length, 1);
});

// ── seedPeople ─────────────────────────────────────────────────────────────

test('a demo-people declaration travels when it matches the model', () => {
    const out = importWithSeed(
        { tbl_a: [{ $id: 'people_1', name: 'Ada' }] },
        { seedPeople: { roster: { tableId: 'tbl_a', nameField: 'name' } } },
    );
    assert.deepEqual(out.template.seedPeople, { roster: { tableId: 'tbl_a', nameField: 'name' } });
});

test('a demo-people declaration naming a column that is not there is dropped and said so', () => {
    const out = importWithSeed(
        { tbl_a: [{ name: 'Ada' }] },
        { seedPeople: { roster: { tableId: 'tbl_a', nameField: 'nosuchfield' } } },
    );
    assert.equal(out.template.seedPeople, undefined);
    assert.equal(out.warnings.some((w) => /demo-people declaration was dropped/.test(w)), true);
});

// ── The report ─────────────────────────────────────────────────────────────

test('the import report says what is in the file and what has to be connected', () => {
    const tpl = storedTemplate();
    tpl.definition.actions.act_mail = {
        kind: 'send_email', connectorId: 'conn_qimail', to: 'a@b.nl', subject: 's', body: 'b',
    };
    const out = roundTrip(tpl);

    assert.deepEqual(out.errors, []);
    assert.equal(typeof out.report.bytes, 'number');
    assert.equal(out.report.tables, 2);
    const connector = out.report.requires.find((r) => r.kind === 'connector');
    assert.deepEqual(connector.ids, ['conn_qimail'],
        'a connectorId is a stable NAME the installer supplies credentials for');
});

// ── The filename ───────────────────────────────────────────────────────────

test('the download is named after the template, safely', () => {
    assert.equal(exportFilename({ title: 'Intake starter' }), 'intake-starter.beeflow-app.json');
    assert.equal(exportFilename({ title: '../../etc/passwd' }), 'etc-passwd.beeflow-app.json');
    assert.equal(exportFilename({ title: '   ' }), 'app-template.beeflow-app.json');
    assert.equal(exportFilename({}), 'app-template.beeflow-app.json');
});

test('rows with no data model to hold them are dropped, and the loss is named', () => {
    const { envelope } = buildExport(storedTemplate());
    delete envelope.template.dataModel;
    const out = sanitizeImport(envelope);

    assert.deepEqual(out.errors, []);
    assert.equal(out.template.seed, undefined);
    assert.equal(out.warnings.some((w) => /no data model to put them in/.test(w)), true,
        'silence here reads as "the template never had examples"');
});
