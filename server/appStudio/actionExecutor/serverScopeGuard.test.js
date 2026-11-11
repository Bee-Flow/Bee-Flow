'use strict';

/**
 * Schema version 3, server side: the wide server scope (definition.serverScope: 'wide'), the guard of a
 * server step and the formula kind of a run_automation input mapping.
 *
 * The rule under all of it: a definition that uses none of them gets the scope, the canonical bytes and
 * the answers it always had.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { _buildServerScope: buildServerScope, executeDataStep, resolveInputs, resolveAppTriggerInputs } = require('../actionExecutor');
const { wideScopeInput, isWideScope } = require('./wideScope.mts');
const { guardAllows, guardSkip, GUARD_SKIPPED_NOTE } = require('./stepGuard.mts');
const { formulaEvaluator } = require('./mappingFormula.mts');
const { stepNotes } = require('../actionSequence');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { validateAppDefinition } = require('../validate');
const { tryEvaluate } = require('../../shared/expr/index.mjs');

const WIDE = { serverScope: 'wide' };
const BODY = {
    screenParams: { id: 'rec_1' },
    forms: { cmp_form: { amount: 40 } },
    actionResults: { act_load: { status: 'success', result: { total: 7 }, error: null } },
};

// ── G5: the wide scope ──────────────────────────────────────────────

test('a definition without the flag gets no key at all, whatever the body carries', () => {
    assert.deepStrictEqual(wideScopeInput({ schemaVersion: 2 }, BODY), {});
    assert.deepStrictEqual(wideScopeInput({ schemaVersion: 3 }, BODY), {}, 'schema version 3 alone does not widen the scope');
    assert.deepStrictEqual(wideScopeInput({ serverScope: 'all' }, BODY), {});
    assert.deepStrictEqual(wideScopeInput(null, BODY), {});
    assert.equal(isWideScope(WIDE), true);
});

test('the scope of a definition without the flag is what it was: screen, forms and actions are empty', () => {
    const ctx = { formValues: { a: 1 }, vars: { v: 2 }, viewerId: 'u1', role: 'member', ...wideScopeInput({ schemaVersion: 2 }, BODY) };
    const scope = buildServerScope(ctx);
    assert.deepStrictEqual(scope.screen, {});
    assert.deepStrictEqual(scope.forms, {});
    assert.deepStrictEqual(scope.actions, {});
    assert.deepStrictEqual(Object.keys(scope), [
        'actions', 'form', 'forms', 'screen', 'vars', 'item', 'index', 'value', 'params', 'error',
        'currentUser', 'records', 'datasets', 'now', 'today',
    ]);
    assert.equal(tryEvaluate('screen.params.id', scope).value, undefined);
});

test('an app that opted in reads screen.params, forms and actions in a server formula', () => {
    const scope = buildServerScope({ viewerId: 'u1', role: 'member', ...wideScopeInput(WIDE, BODY) });
    assert.equal(tryEvaluate('screen.params.id', scope).value, 'rec_1');
    assert.equal(tryEvaluate('forms.cmp_form.amount + 2', scope).value, 42);
    assert.equal(tryEvaluate('actions.act_load.result.total', scope).value, 7);
    assert.equal(tryEvaluate('actions.act_load.status', scope).value, 'success');
    // Not sent: nothing, never an error.
    assert.equal(tryEvaluate('actions.act_other.result', scope).value, undefined);
    assert.deepStrictEqual(scope.records, {});
    assert.deepStrictEqual(scope.datasets, {});
});

test('what the browser sends never reaches the identity the scope is built with', () => {
    const body = { ...BODY, currentUser: { id: 'admin', roleKey: 'owner', isOwner: true }, viewerId: 'admin', role: 'owner', screenParams: { __proto__: { polluted: true }, id: 'x' } };
    const ctx = { viewerId: 'u1', role: 'member', ...wideScopeInput(WIDE, body) };
    assert.deepStrictEqual(Object.keys(ctx).sort(), ['role', 'viewerId', 'wideScope']);
    const scope = buildServerScope(ctx);
    assert.equal(scope.currentUser.id, 'u1');
    assert.equal(scope.currentUser.roleKey, 'member');
    assert.equal(scope.currentUser.isOwner, false);
    assert.equal(/** @type {Record<string, unknown>} */ ({}).polluted, undefined);
});

test('the bags are bounded: a wrong shape is empty, extra keys and long keys are left out', () => {
    const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i]));
    const { wideScope } = wideScopeInput(WIDE, { screenParams: many, forms: ['x'], actionResults: { a: 'not an entry', ['b'.repeat(200)]: { result: 1 }, c: { status: 'x'.repeat(100), result: 1, error: 5 } } });
    assert.ok(wideScope);
    assert.equal(Object.keys(wideScope.screen.params).length, 100);
    assert.deepStrictEqual(Object.keys(wideScope.forms), []);
    assert.deepStrictEqual(Object.keys(wideScope.actions), ['c']);
    assert.equal(wideScope.actions.c.status?.length, 20);
    assert.equal(wideScope.actions.c.error, null);
    const forms = wideScopeInput(WIDE, { forms: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`f${i}`, { x: i }])) }).wideScope?.forms;
    assert.equal(Object.keys(forms || {}).length, 50);
});

// ── G6: the guard ───────────────────────────────────────────────────

const APP = { id: 'app_1', userId: 'owner_1' };

test('no guard, or an emptied one, lets the step run', () => {
    assert.equal(guardAllows({ kind: 'create_record' }, {}), true);
    assert.equal(guardAllows({ kind: 'create_record', guard: '   ' }, {}), true);
    assert.equal(guardSkip(APP, { kind: 'create_record' }, {}, () => { throw new Error('the scope is not built for a step without a guard'); }), null);
});

test('a true guard lets the step run, a false one skips it', () => {
    const scope = buildServerScope({ viewerId: 'u1', role: 'manager', formValues: { amount: 600 } });
    assert.equal(guardAllows({ guard: 'currentUser.roleKey == "manager"' }, scope), true);
    assert.equal(guardAllows({ guard: 'form.amount <= 500' }, scope), false);
});

test('a guard that cannot be worked out, or is not a formula string, skips the step', () => {
    assert.equal(guardAllows({ guard: 'this is ((( not a formula' }, {}), false);
    assert.equal(guardAllows({ guard: 'vars.missing.deeper' }, { vars: {} }), false);
    assert.equal(guardAllows({ guard: true }, {}), false);
    assert.equal(guardAllows({ guard: { expr: 'true' } }, {}), false);
});

test('executeDataStep answers a skipped step with ok, a null result and a note, and runs nothing', async () => {
    // create_record on a table that does not exist: if the step ran, the answer would be a failure.
    const step = { kind: 'create_record', tableId: 'tbl_missing', values: {}, guard: 'currentUser.roleKey == "manager"' };
    const res = await executeDataStep(APP, { tables: [] }, step, { viewerId: 'u1', role: 'member' });
    assert.deepStrictEqual(res, { ok: true, result: null, skipped: true, notes: [GUARD_SKIPPED_NOTE] });
    const ran = await executeDataStep(APP, { tables: [] }, step, { viewerId: 'u1', role: 'manager' });
    assert.equal(ran.ok, false, 'with a true guard the step itself runs (and fails on the missing table)');
});

test('the guard reads the wide roots only for an app that opted in', async () => {
    const step = { kind: 'create_record', tableId: 'tbl_missing', values: {}, guard: 'screen.params.id == "rec_1"' };
    const narrow = await executeDataStep(APP, { tables: [] }, step, { viewerId: 'u1', ...wideScopeInput({}, BODY) });
    assert.equal(narrow.skipped, true);
    const wide = await executeDataStep(APP, { tables: [] }, step, { viewerId: 'u1', ...wideScopeInput(WIDE, BODY) });
    assert.equal(wide.skipped, undefined);
});

test('a guard on a step inside a transaction stops the transaction', async () => {
    const step = { kind: 'transaction', steps: [{ kind: 'create_record', tableId: 't', values: {}, guard: 'false' }] };
    const res = await executeDataStep(APP, { tables: [] }, step, {});
    assert.equal(res.ok, false);
    assert.equal(res.retryable, false);
    assert.match(res.error, /transaction/);
});

test('the /step answer says skipped only for a skipped step', () => {
    assert.deepStrictEqual(stepNotes({ ok: true, result: null, skipped: true, notes: [GUARD_SKIPPED_NOTE] }), { notes: [GUARD_SKIPPED_NOTE], skipped: true });
    assert.deepStrictEqual(stepNotes({ ok: true, result: 1 }), {});
    assert.deepStrictEqual(stepNotes({ ok: true, notes: ['a'] }), { notes: ['a'] });
});

// ── G14: a formula input mapping ────────────────────────────────────

test('the legacy bridge works a formula out on the server; static and field are unchanged', () => {
    const evalFormula = formulaEvaluator({ formValues: { first: 'Ada' }, vars: { n: 3 }, item: { id: 'r9' } });
    const mapping = {
        a: { kind: 'static', value: 'lit' },
        b: { kind: 'field', name: 'first' },
        c: { kind: 'formula', expr: 'concat(form.first, "-", vars.n)' },
        d: { kind: 'formula', expr: 'item.id' },
        e: { kind: 'formula', expr: 'vars.nothing' },
    };
    assert.deepStrictEqual(resolveInputs(mapping, { first: 'Ada' }, evalFormula), { a: 'lit', b: 'Ada', c: 'Ada-3', d: 'r9' });
    // Without an evaluator (a caller that has no server scope) a formula gives nothing; the rest is as before.
    assert.deepStrictEqual(resolveInputs(mapping, { first: 'Ada' }), { a: 'lit', b: 'Ada' });
    assert.deepStrictEqual(resolveInputs({ a: mapping.a, b: mapping.b }, { first: 'Ada' }), { a: 'lit', b: 'Ada' });
});

test('the legacy bridge refuses a formula that gives a list or an object', () => {
    const evalFormula = formulaEvaluator({ item: { id: 'r9' } });
    assert.throws(() => resolveInputs({ x: { kind: 'formula', expr: 'item' } }, {}, evalFormula), (/** @type {any} */ e) => e.status === 400 && /formula for "x"/.test(e.message));
});

test('the typed bridge takes a formula value and checks it against the declared param', async () => {
    const automation = { definition: { trigger: { kind: 'app_trigger', params: [
        { name: 'customer', type: 'string', required: true },
        { name: 'count', type: 'number' },
        { name: 'note', type: 'string' },
    ] } } };
    const evalFormula = formulaEvaluator({ vars: { customer: 'c_7', count: 4 } });
    const mapping = { customer: { kind: 'formula', expr: 'vars.customer' }, count: { kind: 'formula', expr: 'vars.count * 2' }, note: { kind: 'static', value: 'hi' } };
    assert.deepStrictEqual(await resolveAppTriggerInputs(automation, mapping, {}, { app: APP, evalFormula }), { customer: 'c_7', count: 8, note: 'hi' });
    // A required input whose formula gives nothing is missing, like an empty field.
    await assert.rejects(resolveAppTriggerInputs(automation, { customer: { kind: 'formula', expr: 'vars.none' } }, {}, { app: APP, evalFormula }), /Missing required input: customer/);
    // A wrong type is refused by the contract, as for a field.
    await assert.rejects(resolveAppTriggerInputs(automation, { customer: { kind: 'static', value: 'x' }, count: { kind: 'formula', expr: '"abc"' } }, {}, { app: APP, evalFormula }), (/** @type {any} */ e) => e.status === 400);
});

// ── definition: canonical form, version, validation ─────────────────

const definition = (/** @type {unknown[]} */ steps, /** @type {Record<string, unknown>} */ extra = {}) => ({
    schemaVersion: 2, meta: { name: 'T' }, screens: [{ id: 'scr_aaaa', title: 'A', sections: [] }],
    actions: { act_aaaa: { kind: 'sequence', steps } }, ...extra,
});
const check = (/** @type {unknown[]} */ steps, /** @type {Record<string, unknown>} */ extra = {}) => {
    const { def } = canonicalizeAppDefinition(definition(steps, extra));
    const verdict = validateAppDefinition(def, {});
    const codes = (/** @type {{ code: string, path: string }[]} */ list) => list.map((f) => `${f.code} @ ${f.path}`);
    return { def, errors: codes(verdict.errors), warnings: codes(verdict.warnings) };
};
const WRITE = { kind: 'create_record', tableId: 'tbl_x', values: { a: { kind: 'formula', expr: 'form.a' } } };

test('a definition that uses none of it keeps version 2 and gains no key', () => {
    const { def } = check([WRITE]);
    assert.equal(def.schemaVersion, 2);
    assert.equal('serverScope' in def, false);
    assert.equal('guard' in def.actions.act_aaaa.steps[0], false);
});

test('each addition alone makes the definition version 3', () => {
    assert.equal(check([{ ...WRITE, guard: 'form.a > 1' }]).def.schemaVersion, 3);
    assert.equal(check([WRITE], WIDE).def.schemaVersion, 3);
    assert.equal(check([{ kind: 'run_automation', automationId: null, inputMapping: { q: { kind: 'formula', expr: 'vars.q' } } }]).def.schemaVersion, 3);
    assert.equal(check([{ kind: 'run_automation', automationId: null, inputMapping: { q: { kind: 'field', name: 'q' } } }]).def.schemaVersion, 2);
});

test('serverScope takes only "wide": anything else is dropped', () => {
    assert.equal(check([WRITE], WIDE).def.serverScope, 'wide');
    const dropped = check([WRITE], { serverScope: true }).def;
    assert.equal('serverScope' in dropped, false);
    assert.equal(dropped.schemaVersion, 2);
});

test('a guard is a formula on a server step: kept as written, refused on a client step', () => {
    const kept = check([{ ...WRITE, guard: 'currentUser.roleKey == "manager"' }]);
    assert.equal(kept.def.actions.act_aaaa.steps[0].guard, 'currentUser.roleKey == "manager"');
    assert.deepStrictEqual(kept.errors, []);
    assert.equal('guard' in check([{ kind: 'toast', message: 'x', guard: 'true' }]).def.actions.act_aaaa.steps[0], false);
    assert.ok(check([{ ...WRITE, guard: 'not ((( a formula' }]).errors.some((e) => e.startsWith('formula.parse_error @ actions.act_aaaa.steps[0].guard')));
    assert.deepStrictEqual(
        check([{ kind: 'transaction', guard: 'true', steps: [{ ...WRITE, guard: 'true' }] }]).errors,
        ['action.transaction_child_guard @ actions.act_aaaa.steps[0].steps[0].guard'],
    );
});

test('every version: a server formula that reads a root the server cannot fill is a warning', () => {
    const EMPTY = 'formula.server_scope_empty';
    const reads = (/** @type {string} */ expr, /** @type {Record<string, unknown>} */ extra = {}) => check([{ kind: 'create_record', tableId: 'tbl_x', values: { a: { kind: 'formula', expr } } }], extra).warnings.filter((w) => w.startsWith(EMPTY));
    for (const expr of ['screen.params.id', 'forms.f.x', 'actions.act_aaaa.result', 'records.tbl_x', 'datasets.ds_1', 'connectors.c']) {
        assert.deepStrictEqual(reads(expr), [`${EMPTY} @ actions.act_aaaa.steps[0].values.a`], expr);
    }
    for (const expr of ['form.a', 'vars.v', 'item.id', 'index + 1', 'value', 'params.p', 'currentUser.id', 'now', 'today']) {
        assert.deepStrictEqual(reads(expr), [], expr);
    }
    // The wide scope fills three of them; the rows stay in the browser.
    for (const expr of ['screen.params.id', 'forms.f.x', 'actions.act_aaaa.result']) assert.deepStrictEqual(reads(expr, WIDE), [], expr);
    assert.equal(reads('records.tbl_x', WIDE).length, 1);
    // A guard is such a formula; a client step's formula is not.
    assert.ok(check([{ ...WRITE, guard: 'screen.params.ok' }]).warnings.includes(`${EMPTY} @ actions.act_aaaa.steps[0].guard`));
    assert.deepStrictEqual(check([{ kind: 'condition', expr: 'screen.params.ok', then: [], else: [] }]).warnings.filter((w) => w.startsWith(EMPTY)), []);
});

test('a formula mapping needs a formula, and only a step works one out', () => {
    const step = (/** @type {unknown} */ entry) => check([{ kind: 'run_automation', automationId: null, inputMapping: { q: entry } }]);
    assert.deepStrictEqual(step({ kind: 'formula', expr: 'vars.q' }).errors, []);
    assert.deepStrictEqual(step({ kind: 'formula' }).errors, ['action.mapping_formula_missing @ actions.act_aaaa.steps[0].inputMapping.q']);
    assert.ok(step({ kind: 'formula', expr: 'screen.params.q' }).warnings.includes('formula.server_scope_empty @ actions.act_aaaa.steps[0].inputMapping.q'));
    assert.deepStrictEqual(step({ kind: 'lookup', expr: 'x' }).errors, ['action.mapping_kind_invalid @ actions.act_aaaa.steps[0].inputMapping.q']);
    const bare = canonicalizeAppDefinition({ ...definition([]), actions: { act_bbbb: { kind: 'run_automation', automationId: null, inputMapping: { q: { kind: 'formula', expr: 'form.q' } } } } }).def;
    assert.ok(validateAppDefinition(bare, {}).errors.some((/** @type {{ code: string }} */ e) => e.code === 'action.mapping_formula_bare_action'));
});

test('the wide scope with a public page says that visitors do not send it', () => {
    const { def } = canonicalizeAppDefinition(definition([WRITE], { ...WIDE, publicAccess: { entryScreenId: 'scr_aaaa', screenIds: ['scr_aaaa'] } }));
    assert.ok(def.publicAccess, 'the fixture has a public page');
    assert.ok(validateAppDefinition(def, {}).warnings.some((/** @type {{ code: string }} */ w) => w.code === 'server_scope.public_page'));
    assert.equal(check([WRITE], WIDE).warnings.some((w) => w.startsWith('server_scope.public_page')), false);
});
