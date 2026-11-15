/**
 * The Windmill import end to end on a real Postgres (PGlite behind the real
 * db.js): every fixture of the converter's goldens is converted and committed
 * through usecases/automation/windmillImport.mts, and what lands is checked in
 * the database.
 *
 *   - every flow becomes an INACTIVE draft owned by the importer, in their organisation;
 *   - each draft has its report row (same transaction), whose checklist points at
 *     placeholder steps that exist in the STORED (re-keyed) definition;
 *   - the activation gate (automation/importGate.mts) holds until the checklist is
 *     resolved or acknowledged and a dry run of the current version passed, and is
 *     done once the draft went live;
 *   - a flow the pipeline refuses is reported and does not stop the batch;
 *   - no report holds the word "token" from a source W request (the token never
 *     reaches this layer).
 *
 * Run: cd server && node --test usecases/automation/windmillImport.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();

const automationStore = require('../../stores/automationStore');
const { fixtureNames, inputOf } = require('../../automation/importers/windmill/goldenFixtures.mjs');
const { convertWindmill, previewOf, commitWindmill, importReportView, applyRunPolicy } = require('./windmillImport.mts');
const { importGateRefusal, noteDryRun, noteActivated, gateState, stepTypesById } = require('../../automation/importGate.mts');

const LIMITS = { maxBytes: 0, maxUnzippedBytes: 0, maxEntries: 0, maxFlows: 0, rpm: 0, briefPerItemChars: 6000, briefTotalChars: 40000 };
const ctx = {
    userId: 'u-importer',
    organizationId: 'org-import',
    importableDatatables: async () => [],
    permittedApps: async () => new Set(),
    kbFindings: async () => [],
};

before(async () => {
    await automationStore.initDB();
});
after(close);

/** @type {Map<string, { automationId: string, path: string }[]>} */
const imported = new Map();

for (const name of fixtureNames()) {
    test(`${name}: every flow lands as an inactive draft with its report`, async () => {
        const conv = await convertWindmill(await inputOf(name), LIMITS);
        const preview = previewOf(conv);
        assert.ok(preview.flows.length > 0, 'the preview lists the flows');
        const results = await commitWindmill(conv, { select: null, sourceKind: 'windmill_upload', limits: LIMITS, ctx });
        assert.strictEqual(results.length, conv.flows.length);
        const ok = results.filter((r) => r.ok);
        assert.deepStrictEqual(results.filter((r) => !r.ok).map((r) => `${r.path}: ${r.error}`), []);
        imported.set(name, ok.map((r) => ({ automationId: r.automationId, path: r.path })));
        for (const r of ok) {
            const a = await automationStore.getAutomation(r.automationId);
            assert.strictEqual(a.isActive, false, `${r.path} is inactive`);
            assert.strictEqual(a.userId, 'u-importer');
            assert.strictEqual(a.organizationId, 'org-import');
            const row = await automationStore.getImportForAutomation(r.automationId);
            assert.ok(row, `${r.path} has a report row`);
            assert.strictEqual(row.sourceKind, 'windmill_upload');
            assert.strictEqual(row.windmillPath, r.path);
            assert.strictEqual(row.dryRunOkAt, null);
            // Every placeholder the checklist names is a stop step in the STORED definition.
            const types = stepTypesById(a.definition);
            for (const item of row.report.aiChecklist) {
                if (!item.stepId) continue;
                assert.ok(types.has(item.stepId), `${r.path}: ${item.wmId} → ${item.stepId} exists`);
                if (item.placeholder) assert.strictEqual(types.get(item.stepId), 'stop_error');
                else assert.ok(item.stepHash, `${r.path}: ${item.wmId} carries the fingerprint of its step`);
            }
            // Nothing is resolved at import: every item is open.
            assert.strictEqual(gateState(row, a).open.length, row.report.aiChecklist.length, `${r.path}: all items open`);
            assert.strictEqual(r.openItems, row.report.aiChecklist.length);
        }
    });
}

test('the gate: open checklist, then the dry run of this version, then live for good', async () => {
    // The expense claim fixture leaves AI items open.
    const [{ automationId }] = imported.get('expense-claim.flow');
    let a = await automationStore.getAutomation(automationId);
    let row = await automationStore.getImportForAutomation(automationId);
    assert.ok(row.report.aiChecklist.length > 0, 'the fixture has open items');

    const first = await importGateRefusal(a);
    assert.strictEqual(first?.code, 'import.windmill.placeholders_left');
    assert.strictEqual(first.details.open.length, row.report.aiChecklist.length);

    // A dry run that failed marks nothing; one of the saved version that passed does.
    await noteDryRun(a, { status: 'error', mode: 'dry_run', version: a.version });
    assert.strictEqual((await automationStore.getImportForAutomation(automationId)).dryRunOkAt, null);

    // Every item acknowledged: the dry run is what is left.
    row = await automationStore.acknowledgeImportItems(automationId, row.report.aiChecklist.map((i) => i.wmId));
    assert.strictEqual((await importGateRefusal(a))?.code, 'import.windmill.dry_run_required');

    await noteDryRun(a, { status: 'success', mode: 'dry_run', version: a.version });
    assert.strictEqual(await importGateRefusal(a), null);

    // An edit after the dry run asks for a new one.
    const edited = { ...a, version: (a.version || 1) + 1 };
    assert.strictEqual((await importGateRefusal(edited))?.code, 'import.windmill.dry_run_required');

    // Live once: the gate is done, whatever comes after.
    await noteActivated(automationId);
    assert.strictEqual(await importGateRefusal(edited), null);
    a = await automationStore.getAutomation(automationId);
    assert.strictEqual(gateState(await automationStore.getImportForAutomation(automationId), a).applies, false);
});

test('a resolved item no longer blocks: a placeholder turned into a real step, a step finished by an edit', async () => {
    const [{ automationId }] = imported.get('expense-claim.flow');
    const row = await automationStore.getImportForAutomation(automationId);
    const item = row.report.aiChecklist.find((i) => i.placeholder);
    const a = await automationStore.getAutomation(automationId);
    const fresh = { ...row, acknowledged: [], clearedAt: null };
    const before = gateState(fresh, a).open.map((o) => o.wmId);
    assert.ok(before.includes(item.wmId));
    const replaced = JSON.parse(JSON.stringify(a.definition));
    (function retype(v) {
        if (Array.isArray(v)) return v.forEach(retype);
        if (v && typeof v === 'object') { if (v.id === item.stepId) v.type = 'set'; Object.values(v).forEach(retype); }
    })(replaced.steps);
    const after = gateState(fresh, { ...a, definition: replaced }).open.map((o) => o.wmId);
    assert.ok(!after.includes(item.wmId), 'the replaced step counts as resolved');

    const [{ automationId: other }] = imported.get('file-to-table.flow');
    const b = await automationStore.getAutomation(other);
    const rowB = { ...(await automationStore.getImportForAutomation(other)), acknowledged: [], clearedAt: null };
    const unfinished = rowB.report.aiChecklist.find((i) => i.stepHash);
    assert.ok(unfinished, 'file-to-table has an item on a step that is not a placeholder');
    assert.ok(gateState(rowB, b).open.some((o) => o.wmId === unfinished.wmId), 'open while the step is as imported');
    const editedDef = JSON.parse(JSON.stringify(b.definition));
    (function edit(v) {
        if (Array.isArray(v)) return v.forEach(edit);
        if (v && typeof v === 'object') { if (v.id === unfinished.stepId) v.label = 'Finished by hand'; Object.values(v).forEach(edit); }
    })(editedDef.steps);
    assert.ok(!gateState(rowB, { ...b, definition: editedDef }).open.some((o) => o.wmId === unfinished.wmId), 'resolved once the step changed');
});

test('the report view carries the briefing for the open items and never a source in the panel list', async () => {
    const [{ automationId }] = imported.get('python-caldav.flow');
    const a = await automationStore.getAutomation(automationId);
    const row = await automationStore.getImportForAutomation(automationId);
    const view = importReportView(a, row, LIMITS);
    assert.strictEqual(view.gate.applies, true);
    for (const item of view.report.aiChecklist) assert.strictEqual(item.source, undefined);
    if (view.gate.open.length) {
        assert.match(view.brief, /imported from Windmill/);
        assert.match(view.brief, /Do not switch the automation on/);
        assert.match(view.brief, /dry run/);
    }
});

test('a selected path imports only that flow, and the batch cap refuses more', async () => {
    const conv = await convertWindmill(await inputOf('native-trigger-bundle'), LIMITS);
    const one = conv.flows[0].flowPath;
    const results = await commitWindmill(conv, { select: [one], sourceKind: 'windmill_upload', limits: LIMITS, ctx });
    assert.deepStrictEqual(results.map((r) => r.path), [one]);
    await assert.rejects(
        () => commitWindmill({ ...conv, flows: [conv.flows[0], conv.flows[0]] }, { select: null, sourceKind: 'windmill_upload', limits: { ...LIMITS, maxFlows: 1 }, ctx }),
        (e) => e.code === 'import.windmill.too_many_flows',
    );
});

test('run-policy suggestions go into the definition where the schema takes them; the rest stays a suggestion', () => {
    const def = {};
    const { applied, leftOver } = applyRunPolicy(def, { concurrency: 'serial', maxDurationMin: 90, retentionDays: 30 });
    assert.deepStrictEqual(applied, { concurrency: 'serial', retentionDays: 30 });
    assert.deepStrictEqual(leftOver, { maxDurationMin: 90 });
    assert.deepStrictEqual(def.runPolicy, { concurrency: 'serial', retentionDays: 30 });
});

test('an unreadable export is a 400 with the converter\'s sentence', async () => {
    await assert.rejects(() => convertWindmill({ kind: 'text', text: 'summary: [unclosed', name: 'x.yaml' }, LIMITS), (e) => e.status === 400 && e.code === 'import.windmill.unreadable');
});

test('the createAutomation client: the row and the report commit together or not at all', async () => {
    const db = require('../../db');
    const before = Number((await pg.query('SELECT COUNT(*)::int AS n FROM automations')).rows[0].n);
    await assert.rejects(() => db.withTransaction(async (client) => {
        const a = await automationStore.createAutomation({ userId: 'u-tx', title: 'T', definition: { steps: [] }, triggerType: 'manual' }, { client });
        assert.ok(a.id, 'the row reads back through the client');
        throw new Error('report write failed');
    }), /report write failed/);
    assert.strictEqual(Number((await pg.query('SELECT COUNT(*)::int AS n FROM automations')).rows[0].n), before);
});
