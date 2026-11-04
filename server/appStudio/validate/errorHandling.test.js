/**
 * Step error handling in the validator and the canonicalizer: onError handlers,
 * retry, the transaction step, the `error` scope root, and backwards compatibility
 * (a definition without them validates and canonicalizes exactly as before).
 *
 * Run: cd server && node --test appStudio/validate/errorHandling.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateAppDefinition } = require('../validate');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { SECTION_STYLE_DEFAULTS } = require('../componentSpecs');

const codes = (recs, code) => recs.filter((r) => r.code === code);
const OPEN = { default: 'app', roles: {}, rowFilters: {} };
const model = {
    modelVersion: 1, roles: [], roleMapping: { default: 'app', byGroup: {} },
    tables: [
        { id: 'tbl_ord001', key: 'orders', name: 'Orders', icon: null, access: OPEN, fields: [{ id: 'fld_n00001', key: 'name', name: 'Name', type: 'text', required: false, unique: false }] },
        { id: 'tbl_lnk001', key: 'linked', name: 'Linked', icon: null, access: OPEN, fields: [{ id: 'fld_l00001', key: 'x', name: 'X', type: 'text', required: false, unique: false }], source: { kind: 'datatable', datatableId: 'tbl_dt0001', mode: 'write' } },
    ],
};

function app(steps) {
    return {
        schemaVersion: 2,
        meta: { name: 'Errors' },
        theme: {},
        homeScreenId: 'scr_main01',
        screens: [{
            id: 'scr_main01', name: 'Home',
            sections: [{ id: 'sec_main01', style: { ...SECTION_STYLE_DEFAULTS }, children: [
                { id: 'cmp_btn001', type: 'button', props: { label: 'Go' }, onClick: 'act_main01' },
            ] }],
        }],
        actions: { act_main01: { kind: 'sequence', steps } },
    };
}
const validate = (steps, opts = {}) => validateAppDefinition(app(steps), { dataModel: model, datatables: ['tbl_dt0001'], ...opts });
const gen = (extra = {}) => ({ kind: 'ai_generate', prompt: 'Summarise', resultVar: 'draft', ...extra });
const setVar = (name, expr) => ({ kind: 'set_variable', name, value: { kind: 'formula', expr } });
const create = (extra = {}) => ({ kind: 'create_record', tableId: 'tbl_ord001', values: { name: { kind: 'static', value: 'A' } }, ...extra });

test('onError { steps } and retry are valid on a server step; error.* reads inside the handler are fine', () => {
    const res = validate([
        gen({ retry: { times: 2, delayMs: 500 }, onError: { steps: [setVar('fallback', 'error.message'), create()] } }),
        setVar('after', 'vars.fallback'),
    ]);
    assert.deepEqual(res.errors, []);
    assert.deepEqual(codes(res.warnings, 'formula.error_outside_handler'), []);
    assert.deepEqual(codes(res.warnings, 'unknown_formula_root'), [], 'error is a known root');
});

test('reading error outside a handler is a warning', () => {
    const res = validate([setVar('x', 'error.message')]);
    assert.equal(codes(res.warnings, 'formula.error_outside_handler').length, 1);
});

test('bad onError / retry shapes are errors that name the limit', () => {
    const res = validate([
        gen({ onError: { toast: { message: 'x' } } }),
        gen({ retry: { times: 5 } }),
        gen({ retry: { times: 1, delayMs: 60000 } }),
        gen({ onError: { steps: [], stop: 'yes' } }),
    ]);
    assert.equal(codes(res.errors, 'action.on_error_invalid').length, 2);
    const retry = codes(res.errors, 'action.retry_invalid');
    assert.equal(retry.length, 2);
    assert.match(retry[0].message, /from 0 to 3/);
    assert.match(retry[1].message, /0 to 30000/);
});

test('retry on an outside-effect kind and onError on a client step are unknown fields', () => {
    const res = validate([
        { kind: 'send_email', connectorId: 'c', body: { kind: 'static', value: 'x' }, retry: { times: 1 } },
        { kind: 'toast', message: 'hi', onError: { steps: [] } },
        { kind: 'call_action', actionId: 'act_main01', retry: { times: 1 } },
    ]);
    const unknown = codes(res.errors, 'action.step_unknown_field').map((r) => r.path);
    assert.ok(unknown.some((p) => p.endsWith('[0].retry')), unknown.join());
    assert.ok(unknown.some((p) => p.endsWith('[1].onError')), unknown.join());
    assert.ok(unknown.some((p) => p.endsWith('[2].retry')), unknown.join());
});

test('a send_email inside a handler inside a loop is the loop refusal', () => {
    const res = validate([{ kind: 'loop', source: { kind: 'static', value: [1] }, steps: [
        gen({ onError: { steps: [{ kind: 'send_email', connectorId: 'c', body: { kind: 'static', value: 'x' } }] } }),
    ] }]);
    assert.equal(codes(res.errors, 'action.send_email_in_loop').length, 1);
});

test('transaction: record writes only, no own handler, no linked table, at most 50, empty warns', () => {
    const ok = validate([{ kind: 'transaction', resultVar: 'tx', steps: [create({ resultVar: 'order' }), { kind: 'delete_record', tableId: 'tbl_ord001', recordId: { kind: 'formula', expr: 'vars.order.id' } }] }]);
    assert.deepEqual(ok.errors, []);
    const bad = validate([{ kind: 'transaction', steps: [
        create({ onError: { steps: [] } }),
        gen(),
        { kind: 'call_action', actionId: 'act_main01' },
        { kind: 'create_record', tableId: 'tbl_lnk001', values: {} },
    ] }]);
    assert.equal(codes(bad.errors, 'action.transaction_child_handler').length, 1);
    assert.equal(codes(bad.errors, 'action.transaction_child_kind').length, 2, 'ai_generate and call_action');
    assert.equal(codes(bad.errors, 'action.transaction_linked_table').length, 1);
    const many = validate([{ kind: 'transaction', steps: Array.from({ length: 51 }, () => create()) }]);
    assert.equal(codes(many.errors, 'action.transaction_too_many').length, 1);
    const empty = validate([{ kind: 'transaction', steps: [] }]);
    assert.equal(codes(empty.warnings, 'action.transaction_empty').length, 1);
});

test('handler steps and transaction children count toward the step ceiling', () => {
    const handler = Array.from({ length: 60 }, () => setVar('a', '1'));
    const res = validate([gen({ onError: { steps: handler } }), { kind: 'transaction', steps: Array.from({ length: 50 }, () => create()) }, ...Array.from({ length: 10 }, () => setVar('b', '1'))]);
    // 1 + 60 + 1 + 50 + 10 = 122 steps, over the 120 ceiling only because handlers and children count.
    assert.equal(codes(res.errors, 'action.too_many_steps').length, 1, JSON.stringify(res.errors.map((e) => e.code)));
    const fewer = validate([gen({ onError: { steps: handler.slice(0, 58) } }), { kind: 'transaction', steps: Array.from({ length: 50 }, () => create()) }, ...Array.from({ length: 10 }, () => setVar('b', '1'))]);
    assert.equal(codes(fewer.errors, 'action.too_many_steps').length, 0, '120 is allowed');
});

// ── Canonicalizer ───────────────────────────────────────────────────────────

test('canonicalize: onError and retry are kept and cleaned; the legacy array becomes { steps, stop: true }', () => {
    const { def, repairs } = canonicalizeAppDefinition(app([
        gen({ retry: { times: '2', delayMs: '0' }, onError: { steps: [setVar('f', 'error.message')], stop: false, extra: 1 } }),
        gen({ retry: 1, onError: [{ kind: 'toast', message: 'oops', tone: 'danger' }] }),
        gen({ onError: { toast: { message: 'x' } } }),
    ]));
    const [a, b, c] = def.actions.act_main01.steps;
    assert.deepEqual(a.retry, { times: 2, delayMs: 0 });
    assert.deepEqual(a.onError, { steps: [{ kind: 'set_variable', name: 'f', value: { kind: 'formula', expr: 'error.message' } }] });
    assert.deepEqual(b.retry, { times: 1 });
    assert.deepEqual(b.onError, { steps: [{ kind: 'toast', message: 'oops', tone: 'danger' }], stop: true });
    assert.equal(c.onError, undefined, 'an effects object is not a step handler');
    assert.ok(repairs.some((r) => r.code === 'step.on_error_legacy'));
    assert.ok(repairs.some((r) => r.code === 'step.on_error_invalid' && /a message is a toast step inside it/.test(r.message)));
    const again = canonicalizeAppDefinition(def);
    assert.deepEqual(again.repairs, [], 'idempotent');
    assert.equal(JSON.stringify(again.def), JSON.stringify(def));
});

test('canonicalize: a transaction keeps its children, cleaned like steps', () => {
    const { def } = canonicalizeAppDefinition(app([{ kind: 'transaction', resultVar: 'tx', steps: [create({ junk: 1 })], retry: { times: 1 } }]));
    assert.deepEqual(def.actions.act_main01.steps[0], {
        kind: 'transaction', steps: [{ kind: 'create_record', tableId: 'tbl_ord001', values: { name: { kind: 'static', value: 'A' } } }], resultVar: 'tx', retry: { times: 1 },
    });
});

test('backwards compatibility: a definition without onError/retry canonicalizes byte-identically and its bare actions keep their effects', () => {
    const before = app([gen(), create(), { kind: 'condition', expr: 'vars.x', then: [{ kind: 'toast', message: 'a' }] }]);
    before.actions.act_auto01 = { kind: 'run_automation', automationId: null, onError: { toast: { message: 'Failed' } } };
    const once = canonicalizeAppDefinition(before).def;
    const steps = once.actions.act_main01.steps;
    for (const s of steps) {
        assert.equal(Object.hasOwn(s, 'onError'), false);
        assert.equal(Object.hasOwn(s, 'retry'), false);
    }
    assert.deepEqual(once.actions.act_auto01.onError, { toast: { message: 'Failed', tone: 'info' } }, 'a bare run_automation keeps its onError effects');
    assert.equal(JSON.stringify(canonicalizeAppDefinition(once).def), JSON.stringify(once));
});
