'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateAppDefinition } = require('./validate');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { LIMITS, SECTION_STYLE_DEFAULTS } = require('./componentSpecs');

const has = (recs, code) => recs.some((r) => r.code === code);
const codes = (recs) => recs.map((r) => r.code);

/**
 * A canonical app with one button whose action can be swapped per test, and a
 * text component whose `computed.text` holds a formula — that formula is the
 * read site every `vars.<name>` case below goes through.
 */
function app({ variables, action, expr } = {}) {
    const def = {
        schemaVersion: 2,
        meta: { name: 'T', description: '', icon: 'LayoutGrid' },
        theme: {},
        homeScreenId: 'scr_home01',
        roles: [],
        ...(variables ? { variables } : {}),
        screens: [{
            id: 'scr_home01',
            name: 'Home',
            icon: 'Home',
            showInNav: true,
            maxWidth: 'medium',
            sections: [{
                id: 'sec_a00001',
                style: { ...SECTION_STYLE_DEFAULTS },
                children: [
                    {
                        id: 'cmp_txt0001',
                        type: 'text',
                        props: { text: 'x' },
                        ...(expr ? { computed: { text: { kind: 'formula', expr } } } : {}),
                    },
                    { id: 'cmp_btn0001', type: 'button', props: { label: 'Go' }, onClick: 'act_a00001' },
                ],
            }],
        }],
        actions: { act_a00001: action || { kind: 'toast', message: 'hi', tone: 'info' } },
    };
    return canonicalizeAppDefinition(def).def;
}

const check = (opts) => validateAppDefinition(app(opts));

// ── the regression that matters most ────────────────────────────────────────
// Every existing app has no `variables` key. Not one of them may gain a single
// new warning from this feature, or an upgrade turns thousands of working apps
// into apps that "have issues".

test('an app that declares nothing gains no unknown-variable warning', () => {
    const res = check({
        expr: 'vars.anything',
        action: { kind: 'sequence', steps: [{ kind: 'set_variable', name: 'other', value: { kind: 'static', value: 1 } }] },
    });
    assert.equal(has(res.warnings, 'formula.unknown_variable'), false, codes(res.warnings).join(','));
    assert.equal(res.ok, true);
});

test('declaring one variable does not indict names that are only WRITTEN', () => {
    // Adopting the feature must not punish the author for every set_variable
    // the AI had already introduced.
    const res = check({
        variables: [{ name: 'declared', label: 'D', type: 'text', default: '', description: '' }],
        expr: 'vars.declared + vars.written',
        action: { kind: 'sequence', steps: [{ kind: 'set_variable', name: 'written', value: { kind: 'static', value: 1 } }] },
    });
    assert.equal(has(res.warnings, 'formula.unknown_variable'), false, codes(res.warnings).join(','));
});

test('a typo against a declared set warns, and still saves', () => {
    const res = check({
        variables: [{ name: 'statusFilter', label: 'Status', type: 'text', default: 'new', description: '' }],
        expr: 'vars.statusfilter',
    });
    const warn = res.warnings.find((w) => w.code === 'formula.unknown_variable');
    assert.ok(warn, codes(res.warnings).join(','));
    assert.equal(warn.severity, 'warning');
    assert.match(warn.message, /statusfilter/);
    assert.match(warn.hint, /statusFilter/);
    // A warning must never fail a save or block a publish.
    assert.equal(res.ok, true);
});

test('vars.filters never warns — it belongs to the filter bar', () => {
    const res = check({
        variables: [{ name: 'statusFilter', label: 'S', type: 'text', default: '', description: '' }],
        expr: 'vars.filters.q == null ? vars.statusFilter : vars.filters.q',
    });
    assert.equal(has(res.warnings, 'formula.unknown_variable'), false, codes(res.warnings).join(','));
});

test('the warning fires from a binding filter too, not just computed', () => {
    const def = app({ variables: [{ name: 'known', label: 'K', type: 'text', default: '', description: '' }] });
    def.screens[0].sections[0].children[0] = {
        id: 'cmp_lst0001',
        type: 'list',
        props: {
            source: { kind: 'records', tableId: 'tbl_a', filter: [{ field: 'status', op: 'eq', value: { kind: 'formula', expr: 'vars.nope' } }] },
            titleKey: 'title',
        },
    };
    const res = validateAppDefinition(canonicalizeAppDefinition(def).def);
    assert.ok(has(res.warnings, 'formula.unknown_variable'), codes(res.warnings).join(','));
});

// ── declared-but-idle ───────────────────────────────────────────────────────

test('a declared variable nothing touches is flagged as unused', () => {
    const res = check({ variables: [{ name: 'idle', label: 'Idle', type: 'text', default: '', description: '' }] });
    assert.ok(has(res.warnings, 'variable.unused'), codes(res.warnings).join(','));
});

test('a declared variable that is read is not flagged', () => {
    const res = check({
        variables: [{ name: 'used', label: 'U', type: 'text', default: '', description: '' }],
        expr: 'vars.used',
    });
    assert.equal(has(res.warnings, 'variable.unused'), false);
});

// ── a write no formula can read ─────────────────────────────────────────────
// The latent bug: set_variable.name accepts any string up to 60 chars, and the
// runtime stores it as a FLAT key, so `vars.my var` is a parse error and the
// value never arrives.

test('a set_variable name no formula can read warns, and still publishes', () => {
    const def = app();
    def.actions.act_a00001 = { kind: 'sequence', steps: [{ kind: 'set_variable', name: 'my var', value: { kind: 'static', value: 1 } }] };
    const res = validateAppDefinition(def);
    const warn = res.warnings.find((w) => w.code === 'variable.write_unreferenceable');
    assert.ok(warn, codes(res.warnings).join(','));
    assert.match(warn.message, /my var/);
    assert.equal(res.ok, true);
});

// ── structural gate (canonical bytes handed in directly) ────────────────────

test('every structural rule fires on malformed canonical input', () => {
    const cases = [
        [{ variables: 'nope' }, 'variables.invalid'],
        [{ variables: [{ name: '2fast', type: 'text', default: '', label: '', description: '' }] }, 'variable.name_invalid'],
        [{ variables: [{ name: 'filters', type: 'text', default: '', label: '', description: '' }] }, 'variable.name_reserved'],
        [{ variables: [{ name: 'a', type: 'text', default: '', label: '', description: '' }, { name: 'a', type: 'text', default: '', label: '', description: '' }] }, 'variable.duplicate'],
        [{ variables: [{ name: 'a', type: 'colour', default: '', label: '', description: '' }] }, 'variable.type_invalid'],
        [{ variables: [{ name: 'a', type: 'number', default: 'nope', label: '', description: '' }] }, 'variable.default_invalid'],
    ];
    for (const [patch, code] of cases) {
        const def = { ...app(), ...patch };
        const res = validateAppDefinition(def);
        assert.ok(has(res.errors, code), `${code} not raised; got ${codes(res.errors).join(',')}`);
    }
});

test('more variables than the ceiling is an error', () => {
    const def = { ...app(), variables: Array.from({ length: LIMITS.MAX_VARIABLES + 1 }, (_, i) => ({ name: `v${i}`, label: '', type: 'text', default: '', description: '' })) };
    const res = validateAppDefinition(def);
    assert.ok(has(res.errors, 'variables.too_many'));
});

test('a well-formed declaration validates clean', () => {
    const res = check({
        variables: [{ name: 'statusFilter', label: 'Status', type: 'text', default: 'new', description: 'Which status the list shows' }],
        expr: 'vars.statusFilter',
    });
    assert.equal(res.ok, true, codes(res.errors).join(','));
    assert.equal(has(res.warnings, 'formula.unknown_variable'), false);
    assert.equal(has(res.warnings, 'variable.unused'), false);
});
