'use strict';

/**
 * Dynamic text and effects after a sequence (schema version 3): a toast, confirm, navigate or open_url
 * step whose text, screen or address is a formula, a switch case picked by a formula, the owner's list of
 * hosts a formula link may open, and the onSuccess / onError effects of a sequence.
 *
 * What these tests hold: a literal step is byte-for-byte what it was (and stays version 2), the new
 * fields are emitted only when present, and the validator accepts a step that has only the formula.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');
const { requiredSchemaVersion } = require('./schemaSince.mts');

function app(actions, extra = {}) {
    return {
        schemaVersion: 2,
        meta: { name: 'Dyn', description: '', icon: 'Zap' },
        theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        roles: [],
        homeScreenId: 'scr_home0001',
        screens: [
            { id: 'scr_home0001', name: 'Home', icon: null, showInNav: true, maxWidth: 'medium', sections: [{ id: 'sec_home0001', style: { padding: 4, gap: 3, background: 'none' }, children: [
                { id: 'cmp_btn00001', type: 'button', props: { label: 'Go' }, onClick: 'act_seq00001', style: { span: 4 }, visible: true },
            ] }] },
            { id: 'scr_other001', name: 'Other', icon: null, showInNav: false, maxWidth: 'medium', sections: [] },
        ],
        actions: { act_seq00001: { kind: 'sequence', steps: actions.steps, ...(actions.extra || {}) } },
        ...extra,
    };
}

const canon = (def) => canonicalizeAppDefinition(def).def;
const codes = (list) => list.map((f) => f.code);
const check = (def) => validateAppDefinition(canon(def));

test('a literal toast, confirm, navigate, open_url and switch canonicalize exactly as before, and stay version 2', () => {
    const steps = [
        { kind: 'confirm', message: 'Sure?', title: 'Hold on' },
        { kind: 'toast', message: 'Hi', tone: 'info' },
        { kind: 'open_url', url: 'https://example.com', newTab: true },
        { kind: 'navigate', screenId: 'scr_other001' },
        { kind: 'switch', expr: 'form.x', cases: [{ value: 'a', steps: [] }], default: [] },
    ];
    const def = canon(app({ steps }));
    assert.equal(def.schemaVersion, 2);
    const stored = def.actions.act_seq00001;
    assert.deepEqual(Object.keys(stored), ['kind', 'steps']);
    for (const step of stored.steps) {
        for (const key of ['messageExpr', 'titleExpr', 'confirmLabelExpr', 'cancelLabelExpr', 'screenExpr', 'urlExpr']) assert.equal(key in step, false, `${step.kind}.${key} is not written out`);
    }
    assert.deepEqual(Object.keys(stored.steps[4].cases[0]), ['value', 'steps']);
    assert.equal('allowedLinkHosts' in def, false);
});

test('a stray `when` on a switch case is still dropped, as it always was', () => {
    const def = canon(app({ steps: [{ kind: 'switch', expr: '1', cases: [{ when: '1', steps: [] }] }] }));
    assert.deepEqual(def.actions.act_seq00001.steps[0].cases, [{ steps: [] }]);
    assert.equal(def.schemaVersion, 2);
});

test('a formula text field is kept, needs no literal beside it, and moves the app to version 3', () => {
    const steps = [
        { kind: 'toast', messageExpr: "concat('Saved ', 3)" },
        { kind: 'confirm', messageExpr: "'Delete?'", titleExpr: "'Careful'", confirmLabelExpr: "'Delete'", cancelLabelExpr: "'Keep'" },
        { kind: 'navigate', screenExpr: "'scr_other001'" },
    ];
    const def = canon(app({ steps }));
    assert.equal(def.schemaVersion, 3);
    assert.deepEqual(def.actions.act_seq00001.steps[0], { kind: 'toast', tone: 'info', messageExpr: "concat('Saved ', 3)" });
    assert.equal(def.actions.act_seq00001.steps[2].screenExpr, "'scr_other001'");
    assert.equal(requiredSchemaVersion(def), 3);
    const res = validateAppDefinition(def);
    assert.deepEqual(res.errors, []);
});

test('a step with neither the literal nor the formula is still missing its text', () => {
    const res = check(app({ steps: [{ kind: 'toast' }, { kind: 'navigate' }, { kind: 'open_url' }] }));
    assert.deepEqual(codes(res.errors).sort(), ['action.step_field_required', 'action.step_field_required', 'action.step_navigate_unresolved'].sort());
});

test('an empty literal beside a formula does not count as missing either', () => {
    const res = check(app({ steps: [{ kind: 'navigate', screenId: '', screenExpr: 'form.go' }, { kind: 'toast', message: '', messageExpr: 'form.m' }] }));
    assert.deepEqual(res.errors, []);
});

test('a formula that does not parse is an error at its own path', () => {
    const res = check(app({ steps: [{ kind: 'toast', messageExpr: 'concat(' }] }));
    assert.deepEqual(codes(res.errors), ['formula.parse_error']);
    assert.equal(res.errors[0].path, 'actions.act_seq00001.steps[0].messageExpr');
});

test('open_url with a formula warns when the app lists no hosts, and does not once it does', () => {
    const steps = [{ kind: 'open_url', urlExpr: "concat('https://example.com/', form.id)" }];
    assert.deepEqual(codes(check(app({ steps })).warnings.filter((w) => w.code === 'action.url_expr_no_hosts')), ['action.url_expr_no_hosts']);
    const listed = check(app({ steps }, { allowedLinkHosts: ['example.com'] }));
    assert.deepEqual(listed.errors, []);
    assert.equal(listed.warnings.some((w) => w.code === 'action.url_expr_no_hosts'), false);
});

test('allowedLinkHosts keeps bare lowercase hosts, drops the rest, and an empty list leaves no key', () => {
    const def = canon(app({ steps: [] }, { allowedLinkHosts: [' Example.COM ', 'https://x.com/a', 'a.b-c.org', 'example.com', 'bad host', '*.x.com'] }));
    assert.deepEqual(def.allowedLinkHosts, ['example.com', 'a.b-c.org']);
    assert.equal(def.schemaVersion, 3);
    assert.equal('allowedLinkHosts' in canon(app({ steps: [] }, { allowedLinkHosts: [] })), false);
    assert.equal('allowedLinkHosts' in canon(app({ steps: [] }, { allowedLinkHosts: 'example.com' })), false);
});

test('allowedLinkHosts is never sent to an anonymous visitor', () => {
    const { buildPublicDefinition } = require('./publicAccess');
    const def = canon(app({ steps: [] }, { allowedLinkHosts: ['example.com'] }));
    const out = buildPublicDefinition(def, { title: 'Public', entryScreenId: 'scr_home0001', screens: def.screens, actionIds: [] });
    assert.equal('allowedLinkHosts' in out, false);
});

test('a switch case may carry whenExpr; it is kept in order and checked as a formula', () => {
    const steps = [{ kind: 'switch', expr: 'form.n', cases: [{ value: 1, steps: [] }, { whenExpr: 'form.n >= 10', steps: [] }], default: [] }];
    const def = canon(app({ steps }));
    assert.deepEqual(def.actions.act_seq00001.steps[0].cases, [{ value: 1, steps: [] }, { whenExpr: 'form.n >= 10', steps: [] }]);
    assert.equal(def.schemaVersion, 3);
    assert.deepEqual(validateAppDefinition(def).errors, []);
    const bad = canon(app({ steps: [{ kind: 'switch', expr: 'form.n', cases: [{ whenExpr: 'form.n >=', steps: [] }] }] }));
    assert.deepEqual(codes(validateAppDefinition(bad).errors), ['formula.parse_error']);
});

test('a sequence keeps its onSuccess and onError effects, and they are checked like a run_automation\'s', () => {
    const extra = { onSuccess: { toast: { message: 'Done', tone: 'success' }, navigateTo: 'scr_other001' }, onError: { toast: { message: 'No', tone: 'danger' } } };
    const def = canon(app({ steps: [{ kind: 'toast', message: 'x' }], extra }));
    assert.deepEqual(def.actions.act_seq00001.onSuccess, extra.onSuccess);
    assert.deepEqual(def.actions.act_seq00001.onError, extra.onError);
    assert.equal(def.schemaVersion, 3);
    assert.deepEqual(validateAppDefinition(def).errors, []);

    const dangling = canon(app({ steps: [], extra: { onSuccess: { navigateTo: 'scr_nowhere0' } } }));
    assert.deepEqual(codes(validateAppDefinition(dangling).errors), ['action.effects_navigate_unresolved']);
});

test('a sequence without effects canonicalizes without the keys', () => {
    const def = canon(app({ steps: [{ kind: 'toast', message: 'x' }] }));
    assert.equal('onSuccess' in def.actions.act_seq00001, false);
    assert.equal('onError' in def.actions.act_seq00001, false);
});
