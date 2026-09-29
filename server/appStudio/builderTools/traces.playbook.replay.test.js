'use strict';

/**
 * The refused app-builder calls of the first Playbook live runs (2026-09-13,
 * cases 01/02/03 — `traces/2026-09-13-playbook-refusals.json`), replayed
 * against today's tools. Every shape here cost the local model a round, and
 * three of them cost whole phases (7× navigate-with-params.screenId, 15×
 * parent-less nested add_components, 22× stage.approverUserIds). Each must
 * now LAND, with a note that says what was read — or, for the calls that
 * arrived corrupted, be refused as corrupted rather than for the wrong reason.
 *
 * The run's ids are mapped onto the replay's draft (one linked table, one
 * screen with a data_grid); the arguments are otherwise verbatim.
 *
 * Run: node --test --test-force-exit appStudio/builderTools/traces.playbook.replay.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { applyToolCall } = require('../builderTools');
const { emptyDefinition } = require('../componentSpecs');
const { mergeTableOp } = require('./dataTools');
const { canonicalizeDataModel, emptyDataModel } = require('../dataModel');

const TRACE = JSON.parse(fs.readFileSync(path.join(__dirname, 'traces', '2026-09-13-playbook-refusals.json'), 'utf8'));
const call = (n) => TRACE.calls.find((c) => c.n === n);
const RUN_SCREEN_IDS = ['scr_ewbjih', 'scr_881sul'];
const RUN_TABLE_IDS = ['tbl_4f645b', 'tbl_90c246'];
const RUN_GRID_IDS = ['cmp_zaae7t', 'cmp_ydib6r'];
const RUN_SECTION_IDS = ['sec_lxyxdu'];

/** The invoice table the runs linked, as an own table with the same keys. */
function invoiceModel() {
    const merged = mergeTableOp(emptyDataModel(), {
        name: 'Facturen',
        fields: [
            { key: 'datum', type: 'date' }, { key: 'leverancier', type: 'text' }, { key: 'factuurnummer', type: 'text' },
            { key: 'excl_btw', type: 'number' }, { key: 'btw', type: 'number' }, { key: 'totaal', type: 'number' },
            { key: 'status', type: 'select', options: ['open', 'goedgekeurd', 'afgewezen', 'betaald'] }, { key: 'bestand', type: 'text' },
        ],
    }, {});
    assert.ok(!merged.error, JSON.stringify(merged));
    return canonicalizeDataModel(merged.model).model;
}

async function draft() {
    const wrap = { userId: 'u1', orgId: null, appId: null, version: null, builderSessionId: 'bs_pb', def: emptyDefinition('Facturen'), dataModel: invoiceModel(), dataModelVersion: 0, rowCounts: {}, datasetIds: [] };
    const table = wrap.dataModel.tables[0];
    const scr = await applyToolCall('app_add_screen', { name: 'Overzicht' }, wrap);
    assert.ok(!scr.error, JSON.stringify(scr));
    const detail = await applyToolCall('app_add_screen', { name: 'Factuur' }, wrap);
    assert.ok(!detail.error, JSON.stringify(detail));
    const grid = await applyToolCall('app_add_components', { parentId: scr.sectionId, components: [{ type: 'data_grid', props: { tableId: table.id, columns: [{ key: 'datum' }, { key: 'totaal' }] } }] }, wrap);
    assert.ok(!grid.error, JSON.stringify(grid));
    const gridId = grid.added ? grid.added[0].id : (grid.ids ? Object.values(grid.ids)[0] : null);
    assert.ok(gridId, JSON.stringify(grid));
    return { wrap, table, screenId: detail.screenId, overviewSectionId: scr.sectionId, gridId };
}

/** The run's ids → this draft's ids, everywhere in the arguments. */
function mapped(args, { table, screenId, gridId, overviewSectionId }) {
    let text = JSON.stringify(args);
    for (const id of RUN_SECTION_IDS) text = text.split(id).join(overviewSectionId);
    for (const id of RUN_SCREEN_IDS) text = text.split(id).join(screenId);
    for (const id of RUN_TABLE_IDS) text = text.split(id).join(table.id);
    for (const id of RUN_GRID_IDS) text = text.split(id).join(gridId);
    return JSON.parse(text);
}

test(`${TRACE.name}: app_update_component with BOTH id and updates (5× in one turn) lands as the batch, with a note`, async () => {
    for (const n of [1, 13, 38, 39, 40]) {
        const d = await draft();
        const r = await applyToolCall('app_update_component', mapped(call(n).args, d), d.wrap);
        assert.ok(!r.error, `call ${n}: ${JSON.stringify(r).slice(0, 300)}`);
        assert.ok((r._hints || []).some((h) => /both given — read as the updates batch/.test(h)), `call ${n}: ${JSON.stringify(r._hints)}`);
    }
});

test(`${TRACE.name}: navigate with a fields wrapper / params.screenId / a static binding (7× in case 02) lands with the screen on the action`, async () => {
    for (const n of [2, 5, 6, 7]) {
        const d = await draft();
        const r = await applyToolCall('app_set_action', mapped(call(n).args, d), d.wrap);
        assert.ok(!r.error, `call ${n}: ${JSON.stringify(r).slice(0, 400)}`);
        const ids = Array.isArray(r.actionId) ? r.actionId : [r.actionId];
        const action = d.wrap.def.actions[ids[0]];
        assert.strictEqual(action.kind, 'navigate', `call ${n}`);
        assert.strictEqual(action.screenId, d.screenId, `call ${n}: ${JSON.stringify(action)}`);
        assert.ok(!action.fields && !(action.params && action.params.screenId), `call ${n}: wrapper gone`);
        const hints = r._hints || [];
        assert.ok(hints.some((h) => /read as action\.screenId|unwrapped|dropped/.test(h)), `call ${n}: ${JSON.stringify(hints)}`);
    }
});

test(`${TRACE.name}: every approval-flow shape (24 refusals across two turns) lands as a valid request_approval sequence`, async () => {
    const approvalCalls = TRACE.calls.filter((c) => !c.recordedAt && c.tool === 'app_set_action' && JSON.stringify(c.args).includes('request_approval'));
    assert.ok(approvalCalls.length >= 20, `fixture has ${approvalCalls.length} approval calls`);
    for (const c of approvalCalls) {
        const d = await draft();
        const r = await applyToolCall('app_set_action', mapped(c.args, d), d.wrap);
        assert.ok(!r.error, `call ${c.n}: ${JSON.stringify(r).slice(0, 500)}`);
        const ids = Array.isArray(r.actionId) ? r.actionId : [r.actionId];
        const action = d.wrap.def.actions[ids[0]];
        assert.strictEqual(action.kind, 'sequence', `call ${c.n}`);
        const step = action.steps.find((s) => s.kind === 'request_approval');
        assert.ok(step, `call ${c.n}: no request_approval step`);
        assert.ok(step.prompt && step.prompt.kind, `call ${c.n}: prompt`);
        assert.ok(!('tableId' in step), `call ${c.n}: tableId moved off the step`);
        if (step.onDecided) {
            assert.strictEqual(step.onDecided.tableId, d.table.id, `call ${c.n}: onDecided.tableId`);
            assert.ok(step.onDecided.recordId && typeof step.onDecided.recordId === 'object', `call ${c.n}: recordId is a binding`);
        }
        if (Array.isArray(step.stages)) for (const st of step.stages) assert.ok(Array.isArray(st.approvers) && st.approvers.length, `call ${c.n}: stage seats`);
        assert.ok(!('actionId' in action) && !('resultVar' in action), `call ${c.n}: envelope clean`);
    }
});

test(`${TRACE.name}: nested add_components without parentId (15× in case 03) is never refused for the missing parent — the last-added screen's section is taken; corrupted calls are called corrupted`, async () => {
    for (const n of [8, 9, 10, 11, 12]) {
        const d = await draft();
        const r = await applyToolCall('app_add_components', mapped(call(n).args, d), d.wrap);
        if (r.error) {
            assert.doesNotMatch(r.error, /parentId is required|Unknown parentId/, `call ${n}: ${r.error}`);
            assert.match(String(r.error) + String(r._fixHint || ''), /corrupt|garbled|punctuation|broke|unknown component type|Legal types/i, `call ${n}: a refusal must be about the content, got ${r.error}`);
        } else {
            // What landed must say WHAT was repaired — the envelope lifted, a
            // type read as another, the parent inferred. Since 2026-09-16 the
            // grouping names (`section`, `group`, `row`) are aliases of
            // `container`, so calls that used to be refused for "unknown
            // component type" now land with that note instead; the rule is
            // still that nothing lands silently.
            assert.ok(r.added && r.added.length, `call ${n}: something landed`);
            assert.ok((r._hints || []).some((h) => /read as the batch itself|read as "|parentId was missing|lifted in place/.test(h)),
                `call ${n}: the repair is named — ${JSON.stringify(r._hints)}`);
        }
    }
    // And the plain case: no parentId anywhere, one screen just added → its first section.
    {
        const d = await draft();
        const r = await applyToolCall('app_add_components', { components: [{ type: 'heading', props: { text: 'Hoi' } }] }, d.wrap);
        assert.ok(!r.error, JSON.stringify(r));
        assert.ok((r._hints || []).some((h) => /parentId was missing — read as sec_/.test(h)), JSON.stringify(r._hints));
    }
});

// ── 2026-09-14: the rebuilt container's second set (cases 07b/09b/10b) ────────

const RUN2_SECTION_IDS = ['sec_stjbmu', 'sec_xe3rx9', 'sec_5vssf4', 'sec_dg1pdk', 'sec_0ap94x', 'sec_5ujdch', 'sec_yt6bzo'];
const RUN2_TABLE_IDS = ['tbl_52aad5', 'tbl_e815d7', 'tbl_0e9fc4', 'tbl_109a724e2ea2'];

function mapped2(args, d) {
    let text = JSON.stringify(mapped(args, d));
    for (const id of RUN2_SECTION_IDS) text = text.split(id).join(d.overviewSectionId);
    for (const id of RUN2_TABLE_IDS) text = text.split(id).join(d.table.id);
    return JSON.parse(text);
}

test(`${TRACE.name} (14 Sep): parent-less batches on a RETRY (several screens, none added this turn) land on the last screen; a screen id as parent is its first section`, async () => {
    for (const n of [47, 48, 49, 50, 55, 56, 57, 60]) {
        const d = await draft();
        const r = await applyToolCall('app_add_components', mapped2(call(n).args, d), d.wrap);
        if (r.error) {
            assert.doesNotMatch(r.error, /parentId is required|Unknown parentId/, `call ${n}: ${r.error}`);
            assert.match(String(r.error), /broken|corrupt|no "type"|JSON punctuation/i, `call ${n}: only a corrupted call may still refuse — got ${r.error}`);
        } else {
            // Which section was chosen is said either way ("the last screen",
            // "added just before"); the rule is that the parent was INFERRED
            // and reported, never demanded back from the model. Since
            // 2026-09-16 some of these calls land where they used to be
            // refused — a node field nested inside props is lifted out — so
            // the hint that proves it may also be that lift.
            assert.ok((r._hints || []).some((h) => /parentId was missing — read as sec_|read as the batch itself/.test(h)), `call ${n}: ${JSON.stringify(r._hints)}`);
        }
    }
    const d = await draft();
    const r = await applyToolCall('app_add_components', { parentId: d.screenId, components: [{ type: 'heading', props: { text: 'Hoi' } }] }, d.wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.ok(r._hints.some((h) => /is a screen — read as its first section sec_/.test(h)), JSON.stringify(r._hints));
});

test(`${TRACE.name} (14 Sep): a typeless entry (a JSON tail that closed early) is named as broken JSON with the practical fix, never "unknown component type undefined"`, async () => {
    for (const n of [43, 44, 45, 58, 59]) {
        const d = await draft();
        const r = await applyToolCall('app_add_components', mapped2(call(n).args, d), d.wrap);
        if (!r.error) continue; // a kind→type alias or the envelope unwrap may have rescued it — fine
        assert.doesNotMatch(r.error, /unknown component type undefined/, `call ${n}: ${r.error}`);
        // Since the partial apply (2026-09-17) the refusal names the entry
        // and the corruption — a typeless tail, or debris keys inside a typed
        // entry — and asks for THAT entry alone, with well-formed JSON.
        assert.match(r.error, /has no "type" .*the call's JSON is broken at that entry|arrived corrupted — its JSON broke inside it/, `call ${n}: ${r.error}`);
        assert.match(r.error, /Resend (this entry alone|it as its own call)/, `call ${n}: the fix is actionable — ${r.error}`);
    }
    // "kind" for "type" (the design's word) is read as the type.
    const d = await draft();
    const r = await applyToolCall('app_add_components', { parentId: d.overviewSectionId, components: [{ kind: 'heading', props: { text: 'Kop' } }] }, d.wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.ok(r._hints.some((h) => /"kind" read as "type"/.test(h)), JSON.stringify(r._hints));
});

test(`${TRACE.name} (14 Sep): removing an id that is not there is a soft answer that lists what is — six such refusals fed one loop`, async () => {
    const d = await draft();
    for (const n of [61, 62, 63, 64, 65, 66]) {
        const r = await applyToolCall('app_remove_node', call(n).args, d.wrap);
        assert.ok(!r.error, `call ${n}: ${JSON.stringify(r)}`);
        assert.strictEqual(r.alreadyAbsent, call(n).args.id);
        assert.match(r.note, new RegExp(`Components that exist: .*${d.gridId}`));
    }
});

test(`${TRACE.name} (14 Sep): update_record with recordId null is refused with the binding to use; a recordId that arrived as a binding string is read back`, async () => {
    const d = await draft();
    const r = await applyToolCall('app_set_action', mapped2(call(41).args, d), d.wrap);
    assert.ok(r.error, 'two update_record actions without a row are refused');
    assert.match(r._fixHint, /\[0\] Reject reason: action\.recordId missing\. On a detail screen use \{kind:"formula", expr:"screen\.params\.recordId"\}/);
    // The approvals sequences whose second step carried recordId as a TRUNCATED
    // string (`"{kind:"`, calls 52/53): unparseable, so refused — but for the
    // right reason, with the binding to use, never as "corrupted JSON, resend".
    for (const n of [52, 53]) {
        const r2 = await applyToolCall('app_set_action', mapped2(call(n).args, d), d.wrap);
        assert.ok(r2.error, `call ${n}`);
        assert.match(r2.error, /action\.steps\[1\]\.recordId is a corrupted string — an update_record needs the row it changes/, `call ${n}: ${r2.error}`);
        assert.match(r2._fixHint, /screen\.params\.recordId/, `call ${n}`);
    }
});
