/**
 * COMMIT (design 6.4), with every store and engine injected and a recording
 * transaction client.
 *
 * Pinned:
 *   - the order: lock, CAS, knowledge, skills, templates, flips, retire,
 *     steering values, stamps, the stage pointer, `converging`, and the org
 *     datatable model LAST;
 *   - a new or revived automation goes live with is_active = new_parts_active; an
 *     existing one keeps its switch (no is_active in its columns, D22);
 *   - a stage that moved on (release or settings_version) is plan_stale and
 *     writes nothing after the CAS;
 *   - the stamp hash is hashPayload(canonicalOf(kind, bound entity));
 *   - buildStageTables rebuilds only the stage entries from the LOCKED model,
 *     retires a column with the constraints it relaxes, locks a reference
 *     table's rows, and a changed entry is plan_stale; the DDL never drops a
 *     column; reference rows are written after the DDL;
 *   - commitSettings is a CAS on settings_version plus the stage update.
 *
 * Run: cd server && node --test projects/stages/commit.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { commit, commitSettings, buildStageTables, stageMigrationPlan } = require('./commit');

const STAGE = { projectId: 'p_uat', solutionId: 'p_dev', stage: 'uat', organizationId: 'org1', runAsUserId: 'so', newPartsActive: true };
const DEPLOYMENT = { id: 'dep_1', kind: 'deploy', releaseId: 'rel_2', fromReleaseId: 'rel_1', stageSettingsVersion: 3 };

function harness({ casRow = { current_release_id: 'rel_1', settings_version: 3 }, model = { tables: [] } } = {}) {
    const log = [];
    const client = {
        query: async (sql, params) => {
            log.push(['sql', String(sql).trim().split(/\s+/).slice(0, 3).join(' ')]);
            if (/FROM solution_stages WHERE project_id/.test(sql)) return { rows: casRow ? [casRow] : [] };
            return { rows: [], rowCount: 0, params };
        },
    };
    const automations = {
        'u-new': { id: 'u-new', kind: 'automation', version: 1, isActive: false, definition: { trigger: { type: 'manual' }, steps: [] } },
        'u-old': { id: 'u-old', kind: 'automation', version: 7, isActive: true, definition: { trigger: { type: 'manual' }, steps: [] } },
        'u-gone': { id: 'u-gone', kind: 'automation', version: 2, isActive: true },
    };
    const deps = {
        withTransaction: async (fn) => fn(client),
        solutionStageStore: {
            appendStep: async (id, step) => { log.push(['journal', step.action, step.ref || null]); return { seq: log.length }; },
            updateStep: async () => null,
            applySteeringValues: async (c) => { log.push(['steering', c === client]); return 1; },
            setCurrentRelease: async (c, args) => { log.push(['pointer', args.releaseId, args.expectedReleaseId, args.expectedSettingsVersion]); return { projectId: 'p_uat' }; },
            transitionDeployment: async (id, from, to, patch, opts) => { log.push(['status', to, patch.committed === true, opts.client === client]); return { id, status: to }; },
            updateStageSettings: async (projectId, version, patch, opts) => { log.push(['settings', version, patch, opts.client === client]); return {}; },
        },
        blueprintStore: { upsertStamp: async (c, row) => { log.push(['stamp', row.ref, row.installHash, row.retired]); return row; } },
        automationStore: {
            getAutomation: async (id) => automations[id] || null,
            publishBlockVersionWith: async (c, id) => { log.push(['block', id]); return { id }; },
        },
        lifecycleFor: () => ({
            publishWorkingCopy: async (id, opts) => { log.push(['publish', id, opts.expectedVersion, opts.columns, opts.managedWrite]); return { id }; },
        }),
        applyKnowledge: async () => { log.push(['knowledge']); return { copied: 1, removed: 0, unchanged: 0 }; },
        skillStore: { writeManagedSkill: async (c, args) => { log.push(['skill', args.id, args.managedWrite]); } },
        solutionTemplates: { writeManagedTemplate: async (c, args) => { log.push(['template', args.id]); } },
        datatableStore: {
            orgScope: (id) => ({ kind: 'org', id }),
            tableFingerprint: (e) => JSON.stringify(e),
            updateDatatableMeta: async () => null,
            setReferenceFlag: async (id) => { log.push(['reference_flag', id]); },
            saveModel: async (scope, proposed, opts) => {
                log.push(['saveModel', opts.client === client, opts.managedWrite]);
                const before = JSON.parse(JSON.stringify(model));
                const next = await opts.buildNext(JSON.parse(JSON.stringify(model)));
                await opts.applyPhysical(client, { before, next, modelVersion: 9 });
                return { ok: true, model: next };
            },
        },
        datatableDbStore: { scopeKey: () => 'org:org1', applyMigration: async (k, k2, ddl) => { log.push(['ddl', ddl.length]); } },
        referenceRowsModule: {
            referenceApplyOrder: (descs) => descs.map(d => d.id),
            applyReferenceRows: async (c, args) => { log.push(['rows', args.phase, args.tableMeta.rowsLocked === true]); return { written: 1, deleted: 0, skippedFieldIds: [] }; },
        },
    };
    return { client, log, deps };
}

const part = (ref, kind, entityId, action, extra = {}) => ({
    ref, kind, installKind: kind, entityId, action, newOrRevived: action === 'create' || action === 'revive',
    hash: `sha256:${ref}`, sourceHash: `sha256:src-${ref}`, entity: {}, ...extra,
});

test('the commit runs in the design order, the table model last, and stamps the bound hash', async () => {
    const field = { id: 'fld_aaaa', key: 'label', name: 'Label', type: 'text' };
    const h = harness({ model: { tables: [{ id: 'tbl_1', key: 'prices__uat', name: 'Prices', fields: [field] }, { id: 'tbl_other', key: 'mine', fields: [] }] } });
    const prepared = {
        release: { id: 'rel_2', seq: 2 }, managedWrite: { deploymentId: 'dep_1' },
        parts: [part('aut_new', 'automation', 'u-new', 'create'), part('aut_old', 'automation', 'u-old', 'replace'),
            part('aut_same', 'automation', 'u-same', 'unchanged'), part('blk_1', 'automation', 'u-blk', 'replace', { installKind: 'block' })],
        retire: [{ ref: 'aut_gone', kind: 'automation', entityId: 'u-gone', installHash: 'h-gone' }],
        skills: [{ ref: 'skl_1', id: 'u-skl', fields: {} }], templates: [{ ref: 'doc_1', id: 'u-doc', fields: {} }],
        apps: new Map(), webpages: new Map(),
        knowledge: [{ ref: 'kb_1', sourceKbId: 'dev-kb', targetKbId: 'uat-kb', releaseDocs: [], previousDocs: null }],
        tables: [{ ref: 'dt_1', id: 'tbl_1', action: 'replace', entity: { name: 'Prices' },
            release: { columns: [field, { id: 'fld_dddd', key: 'vat', name: 'VAT', type: 'number' }] },
            fingerprint: JSON.stringify({ id: 'tbl_1', key: 'prices__uat', name: 'Prices', fields: [field] }) }],
        referenceRows: [{ ref: 'dt_1', tableId: 'tbl_1', rows: [{ id: 'r1', values: {} }] }],
    };
    await commit({ deployment: DEPLOYMENT, stage: STAGE, prepared }, h.deps);
    const kinds = h.log.filter(e => e[0] !== 'sql' && e[0] !== 'journal').map(e => e[0]);
    assert.deepStrictEqual(kinds, ['knowledge', 'skill', 'template', 'publish', 'publish', 'block', 'publish', 'stamp',
        'steering', 'stamp', 'stamp', 'stamp', 'stamp', 'pointer', 'status', 'saveModel', 'ddl', 'rows', 'rows', 'reference_flag']);
    const sql = h.log.filter(e => e[0] === 'sql').map(e => e[1]);
    assert.deepStrictEqual(sql.slice(0, 4), ['SET LOCAL lock_timeout', 'SET LOCAL statement_timeout', "SELECT pg_advisory_xact_lock(hashtext('solution_stage:' ||", 'SELECT current_release_id, settings_version']);

    const publishes = h.log.filter(e => e[0] === 'publish');
    assert.strictEqual(publishes[0][1], 'u-new');
    assert.strictEqual(publishes[0][3].isActive, true, 'a new automation takes new_parts_active');
    assert.strictEqual(publishes[1][1], 'u-old');
    assert.ok(!('isActive' in publishes[1][3]), 'an existing automation keeps its switch');
    assert.strictEqual(publishes[1][2], 7, 'exact on the working version');
    assert.deepStrictEqual(publishes[2].slice(1, 4), ['u-gone', 2, { isActive: false }], 'the retired automation goes off');
    assert.deepStrictEqual(h.log.find(e => e[0] === 'stamp' && e[1] === 'aut_gone'), ['stamp', 'aut_gone', 'h-gone', true]);
    assert.deepStrictEqual(h.log.find(e => e[0] === 'stamp' && e[1] === 'aut_new'), ['stamp', 'aut_new', 'sha256:aut_new', false]);
    assert.deepStrictEqual(h.log.find(e => e[0] === 'status'), ['status', 'converging', true, true]);
    assert.deepStrictEqual(h.log.find(e => e[0] === 'pointer'), ['pointer', 'rel_2', 'rel_1', 3]);
    assert.deepStrictEqual(h.log.filter(e => e[0] === 'rows').map(e => [e[1], e[2]]), [['upsert', true], ['delete', true]],
        'reference rows after the DDL, on a row-locked descriptor');
});

test('a stage that moved on is plan_stale, and nothing is written after the CAS', async () => {
    for (const casRow of [{ current_release_id: 'rel_9', settings_version: 3 }, { current_release_id: 'rel_1', settings_version: 4 }]) {
        const h = harness({ casRow });
        const prepared = { release: { id: 'rel_2', seq: 2 }, parts: [part('aut_old', 'automation', 'u-old', 'replace')], retire: [], apps: new Map(), webpages: new Map() };
        await assert.rejects(commit({ deployment: DEPLOYMENT, stage: STAGE, prepared }, h.deps), { status: 409, code: 'plan_stale' });
        assert.ok(!h.log.some(e => e[0] !== 'sql'), 'no write');
    }
});

test('a version that moved between prepare and the flip is plan_stale', async () => {
    const h = harness();
    h.deps.lifecycleFor = () => ({ publishWorkingCopy: async () => null });
    const prepared = { release: { id: 'rel_2', seq: 2 }, parts: [part('aut_old', 'automation', 'u-old', 'replace')], retire: [], apps: new Map(), webpages: new Map() };
    await assert.rejects(commit({ deployment: DEPLOYMENT, stage: STAGE, prepared }, h.deps), { code: 'plan_stale' });
});

test('buildStageTables rebuilds only stage entries, retires with the relaxed constraints, and locks reference rows', async () => {
    const label = { id: 'fld_aaaa', key: 'label', name: 'Label', type: 'text' };
    const region = { id: 'fld_bbbb', key: 'region', name: 'Region', type: 'text', required: true, unique: true };
    const stageEntry = { id: 'tbl_1', key: 'prices__prd', name: 'Prices', fields: [label, region] };
    const other = { id: 'tbl_other', key: 'mine', name: 'Mine', fields: [{ id: 'fld_cccc', key: 'x', type: 'text' }] };
    const client = { query: async (sql) => (/pg_attribute/.test(sql) ? { rows: [{ not_null: true, has_fk: false, has_unique: true }] } : { rows: [] }) };
    const locked = { tables: [stageEntry, other] };
    const tables = [{ ref: 'dt_1', id: 'tbl_1', entity: { name: 'Prices' }, release: { columns: [label] }, fingerprint: 'fp-planned' }];
    const deps = { datatableStore: { orgScope: (id) => ({ kind: 'org', id }), tableFingerprint: () => 'fp-planned' } };
    const built = await buildStageTables(client, JSON.parse(JSON.stringify(locked)), tables,
        { stage: { organizationId: 'org1' }, deps, referenceIds: new Set(['tbl_1']) });
    const entry = built.model.tables.find(t => t.id === 'tbl_1');
    assert.deepStrictEqual(entry.fields.map(f => f.key), ['label']);
    assert.strictEqual(entry.rowsLocked, true);
    assert.deepStrictEqual(entry.retired_fields.map(r => [r.id, r.fieldKey, r.notNull, r.unique, r.verified]), [['fld_bbbb', 'region', true, true, true]]);
    assert.deepStrictEqual(built.model.tables.find(t => t.id === 'tbl_other'), other, 'an unrelated org table is untouched');
    assert.deepStrictEqual(built.onlyTableIds, ['tbl_1']);

    const ddl = stageMigrationPlan(locked, built.model, built);
    assert.ok(ddl.length > 0);
    assert.ok(!ddl.some(stmt => /DROP COLUMN/i.test(stmt)), 'a retired column is never dropped');
    assert.ok(ddl.some(stmt => /DROP NOT NULL/i.test(stmt)), 'retiring relaxes NOT NULL');

    const changed = { datatableStore: { ...deps.datatableStore, tableFingerprint: () => 'fp-other' } };
    await assert.rejects(buildStageTables(client, JSON.parse(JSON.stringify(locked)), tables, { stage: { organizationId: 'org1' }, deps: changed }),
        { code: 'plan_stale' });
    await assert.rejects(buildStageTables(client, { tables: [other] }, tables, { stage: { organizationId: 'org1' }, deps }), { code: 'plan_stale' });
});

test('commitSettings is a CAS on settings_version plus the stage update, then converging', async () => {
    const h = harness();
    const deployment = { id: 'dep_s', kind: 'settings', stageSettingsVersion: 5, settingsPatch: { requiresApproval: false } };
    await commitSettings({ deployment, stage: STAGE }, h.deps);
    assert.deepStrictEqual(h.log.find(e => e[0] === 'settings'), ['settings', 5, { requiresApproval: false }, true]);
    assert.deepStrictEqual(h.log.find(e => e[0] === 'status'), ['status', 'converging', true, true]);

    const stale = harness();
    stale.deps.solutionStageStore.updateStageSettings = async () => { throw Object.assign(new Error('stale'), { code: 'settings_stale', status: 409 }); };
    await assert.rejects(commitSettings({ deployment, stage: STAGE }, stale.deps), { code: 'plan_stale' });
    assert.ok(!stale.log.some(e => e[0] === 'status'));
});
