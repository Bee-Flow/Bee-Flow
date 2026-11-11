'use strict';

/**
 * The edit tools of builderTools/tools/: app_update_step (stepPathEdit.mts), app_remove_section,
 * app_move_section, app_reorder_screens (structureTools.mts) and app_remove_dataset
 * (removeDatasetTool.mts), through the builder's own dispatch where the store is not needed.
 * The byte test runs app_update_step over every action of the compatibility corpus: whatever
 * step it changes, every other step and the rest of the app keep their bytes.
 *
 * Run: cd server && node --test appStudio/builderTools/editTools.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyToolCall, MUTATING_TOOLS, DATA_MODEL_TOOLS } = require('../builderTools');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { stepAt } = require('./stepPathEdit.mts');
const { applyRemoveDataset, findDatasetRefs } = require('./removeDatasetTool.mts');
const { stepPaths } = require('../sequencePaths.mts');

const TOAST = (message) => ({ kind: 'toast', message });

function draft(over = {}) {
    const def = canonicalizeAppDefinition({
        schemaVersion: 2,
        meta: { name: 'Edit tools' },
        screens: [
            { id: 'scr_aaa111', name: 'A', sections: [
                { id: 'sec_one111', children: [{ id: 'cmp_btn111', type: 'button', props: { label: 'Go' }, onClick: 'act_one111' }] },
                { id: 'sec_two111', children: [{ id: 'cmp_txt111', type: 'text', props: { text: 'hi' } }] },
                { id: 'sec_thr111', children: [] },
            ] },
            { id: 'scr_bbb111', name: 'B', sections: [{ id: 'sec_fou111', children: [] }] },
            { id: 'scr_ccc111', name: 'C', sections: [{ id: 'sec_fiv111', children: [] }] },
        ],
        actions: {
            act_one111: { kind: 'sequence', steps: [
                TOAST('Saved'),
                { kind: 'condition', expr: 'vars.x > 1', then: [TOAST('Big')], else: [{ kind: 'navigate', screenId: 'scr_bbb111' }] },
                { kind: 'focus', nodeId: 'cmp_txt111' },
            ] },
            act_two111: { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'act_one111' }] },
            act_thr111: TOAST('Bare'),
        },
        variables: [{ name: 'x', type: 'number', default: 0 }],
        ...over,
    }).def;
    return { userId: 'usr_owner', appId: 'app_1', def };
}

const json = (v) => JSON.stringify(v);

// ── app_update_step ─────────────────────────────────────────────────────────

test('update_step: a patch changes one nested step; null removes a field; the others keep their bytes', async () => {
    const wrap = draft();
    const before = structuredClone(wrap.def.actions.act_one111);
    const out = await applyToolCall('app_update_step', { actionId: 'act_one111', path: 'steps[1].then[0]', patch: { message: 'Huge', tone: null } }, wrap);
    assert.equal(out.error, undefined, out.error);
    assert.equal(out.path, 'steps[1].then[0]');
    assert.equal(out.step.message, 'Huge');
    assert.equal(out.action, undefined, 'the answer carries the step, not the whole action');
    const after = wrap.def.actions.act_one111;
    for (const p of ['steps[0]', 'steps[1].else[0]', 'steps[2]']) assert.equal(json(stepAt(after, p)), json(stepAt(before, p)), p);
    assert.ok(MUTATING_TOOLS.has('app_update_step'));
});

test('update_step: a whole step replaces it; a bare action is action[0]', async () => {
    const wrap = draft();
    const out = await applyToolCall('app_update_step', { actionId: 'act_one111', path: 'steps[2]', step: { kind: 'scroll_to', nodeId: 'top' } }, wrap);
    assert.equal(out.error, undefined, out.error);
    assert.equal(wrap.def.actions.act_one111.steps[2].kind, 'scroll_to');
    const bare = await applyToolCall('app_update_step', { actionId: 'act_thr111', path: 'action[0]', patch: { message: 'Still bare' } }, wrap);
    assert.equal(bare.error, undefined, bare.error);
    assert.equal(wrap.def.actions.act_thr111.message, 'Still bare');
});

test('update_step: refusals name the fix and change nothing', async () => {
    const wrap = draft();
    const before = json(wrap.def);
    const unknownPath = await applyToolCall('app_update_step', { actionId: 'act_one111', path: 'steps[9]', patch: { message: 'x' } }, wrap);
    assert.match(unknownPath.error, /no step at "steps\[9\]"/);
    assert.match(unknownPath._fixHint, /steps\[1\]\.then\[0\] \(toast\)/);
    const called = await applyToolCall('app_update_step', { actionId: 'act_two111', path: 'steps[0].call.steps[1]', patch: { expr: 'true' } }, wrap);
    assert.match(called._fixHint, /actionId: "act_one111", path: "steps\[1\]"/);
    assert.match((await applyToolCall('app_update_step', { actionId: 'act_one111', path: 'steps[0]' }, wrap)).error, /exactly one of patch/);
    assert.match((await applyToolCall('app_update_step', { actionId: 'act_nope', path: 'steps[0]', patch: {} }, wrap)).error, /Unknown actionId/);
    const invalid = await applyToolCall('app_update_step', { actionId: 'act_one111', path: 'steps[1].else[0]', patch: { screenId: 'scr_gone11' } }, wrap);
    assert.match(invalid.error, /would fail validation/);
    assert.equal(json(wrap.def), before);
    assert.match((await applyToolCall('app_update_step', { actionId: 'act_one111', path: 'steps[0]', patch: { message: 'Saved' } }, wrap)).note, /No change/);
});

test('update_step over the compatibility corpus: every other step and the rest of the app keep their bytes', async () => {
    const { corpusNames, readCorpus } = await import('../compat/corpus.mts');
    let edits = 0;
    for (const name of corpusNames()) {
        const entry = readCorpus(name);
        const { def, refused } = canonicalizeAppDefinition(entry.definition);
        if (refused) continue;
        for (const [actionId, action] of Object.entries(def.actions || {})) {
            // One step per action with neighbours to keep: the most deeply nested one, or the middle of a flat list.
            const paths = stepPaths(action);
            const deepest = [...paths].sort((a, b) => b.path.split('.').length - a.path.split('.').length)[0];
            const pick = deepest?.path.includes('.') ? deepest : (paths.length >= 3 ? paths[1] : null);
            for (const { path } of pick ? [pick] : []) {
                const wrap = { userId: 'usr_owner', def: structuredClone(def), dataModel: entry.dataModel || null };
                const out = await applyToolCall('app_update_step', { actionId, path, step: TOAST(`Probe ${path}`) }, wrap);
                if (out.error) continue; // the validator refused a toast there (a server-only action): nothing changed
                edits += 1;
                const after = wrap.def.actions[actionId];
                for (const q of stepPaths(action)) {
                    // The step itself, its children and the steps that contain it changed; nothing else did.
                    if (q.path === path || q.path.startsWith(`${path}.`) || path.startsWith(`${q.path}.`)) continue;
                    assert.equal(json(stepAt(after, q.path)), json(stepAt(action, q.path)), `${name} ${actionId} ${path} → ${q.path}`);
                }
                // schemaVersion may drop: replacing the one since-3 step leaves a definition that needs only 2.
                const rest = (d) => json({ ...d, schemaVersion: null, actions: { ...d.actions, [actionId]: null } });
                assert.equal(rest(wrap.def), rest(def), `${name} ${actionId} ${path}: the rest of the app`);
            }
        }
    }
    assert.ok(edits > 60, `${edits} edits`);
});

// ── sections and screens ────────────────────────────────────────────────────

test('remove_section: removes it with its components and reports what still names one', async () => {
    const wrap = draft();
    const out = await applyToolCall('app_remove_section', { sectionId: 'sec_two111' }, wrap);
    assert.equal(out.error, undefined, out.error);
    assert.equal(out.removedComponents, 1);
    assert.deepEqual(out.stillReferenced, ['action act_one111']);
    assert.match(out._hints.at(-1), /still name a component/);
    assert.deepEqual(wrap.def.screens[0].sections.map((s) => s.id), ['sec_one111', 'sec_thr111']);
    assert.match((await applyToolCall('app_remove_section', { sectionId: 'sec_fou111' }, wrap)).error, /only section/);
    assert.match((await applyToolCall('app_remove_section', { sectionId: 'sec_on1111' }, wrap)).error, /Unknown sectionId/);
});

test('move_section: a new place on its own screen; the same place is no change', async () => {
    const wrap = draft();
    const out = await applyToolCall('app_move_section', { sectionId: 'sec_thr111', index: 0 }, wrap);
    assert.deepEqual(out.order, ['sec_thr111', 'sec_one111', 'sec_two111']);
    assert.match((await applyToolCall('app_move_section', { sectionId: 'sec_thr111', index: 0 }, wrap)).note, /No change/);
    assert.match((await applyToolCall('app_move_section', { sectionId: 'sec_thr111', index: -1 }, wrap)).error, /whole number/);
});

test('reorder_screens: every screen once; home stays home; a grouped menu is pointed out', async () => {
    const wrap = draft({ nav: { style: 'sidebar', groups: [{ id: 'grp_one111', label: 'All', screens: ['scr_aaa111', 'scr_bbb111', 'scr_ccc111'] }] } });
    const home = wrap.def.homeScreenId;
    const bad = await applyToolCall('app_reorder_screens', { screenIds: ['scr_ccc111', 'scr_aaa111'] }, wrap);
    assert.match(bad._fixHint, /current order: scr_aaa111, scr_bbb111, scr_ccc111/);
    const out = await applyToolCall('app_reorder_screens', { screenIds: ['scr_ccc111', 'scr_aaa111', 'scr_bbb111'] }, wrap);
    assert.deepEqual(wrap.def.screens.map((s) => s.id), ['scr_ccc111', 'scr_aaa111', 'scr_bbb111']);
    assert.equal(out.homeScreenId, home);
    assert.match(out._hints.at(-1), /nav\.groups/);
});

// ── app_remove_dataset ──────────────────────────────────────────────────────

test('remove_dataset: refused while used, removed through the store when not', async () => {
    const used = draft();
    used.def.actions.act_one111.steps.push({ kind: 'dataset_query', datasetId: 'ds_used', resultVar: 'rows' });
    assert.deepEqual(findDatasetRefs(used.def, 'ds_used'), ['action act_one111']);
    const deleted = [];
    const deps = { deleteDataset: async (...a) => { deleted.push(a); return a[0] !== 'ds_other'; } };
    const wrap = { ...used, datasetIds: [{ id: 'ds_used', name: 'Used' }, { id: 'ds_free', name: 'Free' }, { id: 'ds_other' }] };
    assert.match((await applyRemoveDataset(wrap, { datasetId: 'ds_used' }, deps)).error, /still uses it: action act_one111/);
    assert.match((await applyRemoveDataset(wrap, { datasetId: 'ds_fre' }, deps))._fixHint, /ds_used, ds_free, ds_other/);
    const out = await applyRemoveDataset(wrap, { datasetId: 'ds_free' }, deps);
    assert.deepEqual(out, { removed: 'ds_free', name: 'Free', datasets: 2 });
    assert.deepEqual(deleted, [['ds_free', 'app_1', 'usr_owner']]);
    assert.match((await applyRemoveDataset(wrap, { datasetId: 'ds_other' }, deps)).error, /could not be removed/);
    assert.ok(DATA_MODEL_TOOLS.has('app_remove_dataset'));
});

test('the edit tools are offered over MCP with appId and a write annotation', () => {
    const listed = require('../mcpBuilder').buildToolList();
    for (const name of ['app_update_step', 'app_remove_section', 'app_move_section', 'app_reorder_screens', 'app_remove_dataset']) {
        const tool = listed.find((t) => t.name === name);
        assert.ok(tool, name);
        assert.equal(tool.inputSchema.required[0], 'appId');
        assert.equal(tool.annotations.readOnlyHint, false);
    }
});
