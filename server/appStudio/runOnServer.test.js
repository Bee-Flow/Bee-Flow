'use strict';

/**
 * `runOn: 'server'` on a sequence (schema version 3), through the layers that read a
 * definition: the canonicalizer keeps it and writes it only when present, a definition with it is
 * version 3 and one without it keeps its bytes, the validator refuses the steps a server run
 * cannot hold with a finding of its own, a public page receives the action without it, and the
 * builder's app_set_action takes it.
 *
 * Run: cd server && node --test appStudio/runOnServer.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateAppDefinition } = require('./validate');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { SECTION_STYLE_DEFAULTS, ACTION_SPECS } = require('./componentSpecs');
const { _redactAction } = require('./publicAccess');
const { readRunOptions, runsOnServer, repairRunOptions } = require('./backgroundRunPolicy.mts');
const { extensionItems } = require('./catalogTiers.mts');

function app(actions, rootId = 'act_main01') {
    return {
        schemaVersion: 2, meta: { name: 'Server run' }, theme: {}, homeScreenId: 'scr_main01',
        screens: [{ id: 'scr_main01', name: 'Home', sections: [{ id: 'sec_main01', style: { ...SECTION_STYLE_DEFAULTS }, children: [
            { id: 'cmp_btn001', type: 'button', props: { label: 'Go' }, onClick: rootId },
        ] }] }],
        actions,
    };
}
const create = { kind: 'create_record', tableId: 'tbl_x', values: {} };
const canon = (actions) => canonicalizeAppDefinition(app(actions)).def;
const check = (actions) => validateAppDefinition(canon(actions));
const codes = (recs, code) => recs.filter((r) => r.code === code);

test('the field is declared on the sequence, marked since 3, with no default', () => {
    const field = ACTION_SPECS.sequence.fields.runOn;
    assert.equal(field.since, 3);
    assert.deepEqual(field.values, ['server']);
    assert.equal(Object.hasOwn(field, 'default'), false);
    assert.equal(Object.keys(ACTION_SPECS.sequence.fields).at(-1), 'runOn', 'appended after every other field');
    const item = extensionItems().find((i) => i.name === 'sequence.runOn');
    assert.ok(item, 'listed in the extension index the builder reads');
    assert.equal(item.family, 'actionFields');
});

test('canonicalize: kept when set, never written when absent; only a definition that uses it is version 3', () => {
    const plain = canon({ act_main01: { kind: 'sequence', steps: [create] } });
    assert.equal(plain.schemaVersion, 2);
    assert.equal(Object.hasOwn(plain.actions.act_main01, 'runOn'), false);
    const background = canon({ act_main01: { kind: 'sequence', background: true, steps: [create] } });
    assert.equal(background.schemaVersion, 2, 'a background action stays a version 2 definition');
    assert.equal(Object.hasOwn(background.actions.act_main01, 'runOn'), false);
    const onServer = canon({ act_main01: { kind: 'sequence', runOn: 'server', steps: [create] } });
    assert.equal(onServer.schemaVersion, 3);
    assert.equal(onServer.actions.act_main01.runOn, 'server');
    assert.deepEqual(canonicalizeAppDefinition(JSON.parse(JSON.stringify(onServer))).def, onServer, 'a second pass changes nothing');
});

test('validate: a server run takes server steps, toast, refresh and a leading confirm', () => {
    const out = check({ act_main01: { kind: 'sequence', runOn: 'server', lockKey: { kind: 'formula', expr: 'form.id' }, steps: [{ kind: 'confirm', message: 'Sure?' }, create, { kind: 'toast', message: 'Done' }, { kind: 'refresh' }] } });
    assert.deepEqual(out.errors, []);
    assert.deepEqual(codes(out.warnings, 'action.lock_without_background'), [], 'a lockKey locks a server run too');
});

test('validate: a step that needs the page is refused with a finding that names runOn and the way out', () => {
    const out = check({ act_main01: { kind: 'sequence', runOn: 'server', steps: [create, { kind: 'navigate', screenId: 'scr_main01' }, { kind: 'condition', expr: 'true', then: [{ kind: 'confirm', message: 'Sure?' }], else: [] }] } });
    const [step] = codes(out.errors, 'action.server_run_step_unsupported');
    assert.ok(step, JSON.stringify(out.errors));
    assert.equal(step.path, 'actions.act_main01.steps[1]');
    assert.match(step.message, /runs on the server \(runOn: "server"\), but steps\[1\] is a navigate step, which needs the visitor's page/);
    assert.match(step.hint, /leave runOn out so the page walks the steps/);
    const [confirm] = codes(out.errors, 'action.server_run_confirm_position');
    assert.equal(confirm.path, 'actions.act_main01.steps[2].then[0]');
    assert.deepEqual(codes(out.errors, 'action.background_step_unsupported'), [], 'not told it is a background action');
});

test('validate: a page step in an action a server run calls is refused too; an unknown value is refused', () => {
    const out = check({
        act_main01: { kind: 'sequence', runOn: 'server', steps: [{ kind: 'call_action', actionId: 'act_part01' }] },
        act_part01: { kind: 'sequence', steps: [{ kind: 'open_url', url: 'https://example.com' }] },
    });
    assert.equal(codes(out.errors, 'action.server_run_step_unsupported')[0].path, 'actions.act_main01.steps[0].call.steps[0]');
    const bad = validateAppDefinition({ ...canon({ act_main01: { kind: 'sequence', steps: [create] } }), actions: { act_main01: { kind: 'sequence', runOn: 'browser', steps: [create] } } });
    assert.equal(bad.errors.some((e) => e.path === 'actions.act_main01.runOn'), true, JSON.stringify(bad.errors));
});

test('validate: a background action keeps its own findings, word for word', () => {
    const out = check({ act_main01: { kind: 'sequence', background: true, runOn: 'server', steps: [create, { kind: 'navigate', screenId: 'scr_main01' }] } });
    const [step] = codes(out.errors, 'action.background_step_unsupported');
    assert.equal(step.message, 'Action "act_main01" runs in the background, but steps[1] is a navigate step, which needs the visitor\'s page.');
    assert.equal(step.hint, 'Put it in a second action on the same control (it runs right after the click), or bind the next screen to actions.<id>.result. toast and refresh are fine: they show when the job ends.');
    const confirm = check({ act_main01: { kind: 'sequence', background: true, steps: [create, { kind: 'confirm', message: 'x' }] } });
    assert.equal(codes(confirm.errors, 'action.background_confirm_position')[0].message, 'Action "act_main01" runs in the background; a confirm is only possible as its first step(s), before the job starts (steps[1] is not).');
});

test('validate: runOn on an action another action calls is a warning (it is ignored there)', () => {
    const out = check({
        act_main01: { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'act_part01' }] },
        act_part01: { kind: 'sequence', runOn: 'server', steps: [create] },
    });
    assert.deepEqual(out.errors, []);
    assert.equal(codes(out.warnings, 'action.run_on_in_called_action').length, 1);
});

test('the run options: runOn makes a server run, with or without background', () => {
    assert.equal(runsOnServer({ kind: 'sequence', runOn: 'server', steps: [] }), true);
    assert.equal(runsOnServer({ kind: 'sequence', background: true, steps: [] }), true);
    assert.equal(runsOnServer({ kind: 'sequence', steps: [] }), false);
    assert.equal(runsOnServer({ kind: 'sequence', runOn: 'browser', steps: [] }), false);
    assert.equal(runsOnServer({ kind: 'create_record', runOn: 'server' }), false, 'a bare action is not a sequence');
    assert.deepEqual(readRunOptions({ kind: 'sequence', steps: [] }), { background: false, lockKey: null, progressVar: null, server: false });
});

test('a public page receives the action without runOn: a visitor walks the steps, as before', () => {
    const redacted = _redactAction({ kind: 'sequence', runOn: 'server', lockKey: { kind: 'formula', expr: 'form.id' }, steps: [create] });
    assert.equal(Object.hasOwn(redacted, 'runOn'), false);
    assert.equal(Object.hasOwn(redacted, 'lockKey'), false);
    assert.equal(redacted.steps.length, 1);
});

test('the builder: app_set_action stores runOn, and a bare step that carries it becomes a one-step sequence', async () => {
    const { applyToolCall } = require('./builderTools');
    const wrap = { def: canon({ act_main01: { kind: 'sequence', steps: [create] } }) };
    const out = await applyToolCall('app_set_action', { actionId: 'act_main01', action: { kind: 'sequence', runOn: 'server', steps: [{ kind: 'toast', message: 'Done' }] } }, wrap);
    assert.equal(out.error, undefined, JSON.stringify(out));
    assert.equal(wrap.def.actions.act_main01.runOn, 'server');
    const notes = [];
    const wrapped = repairRunOptions({ kind: 'toast', message: 'Hi', runOn: 'server' }, notes);
    assert.deepEqual(wrapped, { kind: 'sequence', steps: [{ kind: 'toast', message: 'Hi' }], runOn: 'server' });
    assert.equal(notes.length, 1);
});
