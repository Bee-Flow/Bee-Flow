'use strict';

// Contrast warnings over schema 3 colour pairs (package W3-D): a token as fill or text, a
// styleWhen rule laid over the node's style, a column's cellStyle rule; in the light and the dark
// theme; never an error; an outlined card paints no fill. An app without them gets nothing new.

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeAppDefinition } = require('../canonicalize');
const { validateAppDefinition } = require('../validate');
const { emptyDefinition } = require('../componentSpecs');

const rule = (expr, style) => ({ when: { kind: 'formula', expr }, style });

function app(nodes, design) {
    const def = emptyDefinition('Contrast');
    def.screens[0].sections[0].children.push(...nodes);
    if (design) def.design = { ...(def.design || {}), ...design };
    return canonicalizeAppDefinition(def).def;
}
const text = (style, extra) => ({ id: 'cmp_ctr00001', type: 'text', props: { text: 'Hi' }, style: { span: 12, ...style }, ...extra });
const contrast = (def) => validateAppDefinition(def).warnings
    .filter((w) => w.code === 'style.low_contrast')
    .map((w) => w.path.replace('screens[0].sections[0].children[0]', '@'));

test('an app without tokens or rules gets the base warning only', () => {
    assert.deepEqual(contrast(app([text({ backgroundColor: '#ffff00', color: '#ffffff' })])), ['@.style.backgroundColor']);
    assert.deepEqual(contrast(app([text({ backgroundColor: '#0f172a', color: '#f8fafc' })])), []);
});

test('a token fill or a token text colour is measured with the token value', () => {
    const tokens = { tokens: { pale: '#fef9c3', ink: '#fefce8', deep: '#1e293b' } };
    assert.deepEqual(contrast(app([text({ backgroundColor: 'token:pale', color: 'token:ink' })], tokens)), ['@.style.backgroundColor']);
    assert.deepEqual(contrast(app([text({ backgroundColor: 'token:deep', color: 'token:ink' })], tokens)), []);
    // An unknown token is the token_unknown warning's, not a measured pair.
    assert.deepEqual(contrast(app([text({ backgroundColor: 'token:nope', color: '#ffffff' })], tokens)), []);
    // A token fill under the theme text is not an authored pair (stored apps carry them).
    assert.deepEqual(contrast(app([text({ backgroundColor: 'token:pale' })], tokens)), []);
});

test('a styleWhen rule that makes the pair unreadable warns at the rule; one that keeps it readable does not', () => {
    const bad = app([text({ backgroundColor: '#0f172a', color: '#f8fafc' }, { styleWhen: [rule('true', { backgroundColor: '#f1f5f9' })] })]);
    assert.deepEqual(contrast(bad), ['@.styleWhen[0].style']);
    const good = app([text({ backgroundColor: '#0f172a', color: '#f8fafc' }, { styleWhen: [rule('true', { backgroundColor: '#1e293b' })] })]);
    assert.deepEqual(contrast(good), []);
    // A rule that changes only the weight adds nothing to the base warning.
    const weight = app([text({ backgroundColor: '#ffff00', color: '#ffffff' }, { styleWhen: [rule('true', { weight: 'bold' })] })]);
    assert.deepEqual(contrast(weight), ['@.style.backgroundColor']);
});

test('a fill with the theme text is measured in both themes, and only in the one the app fixes', () => {
    const both = app([text({}, { styleWhen: [rule('true', { backgroundColor: '#777777' })] })]);
    const [warning] = validateAppDefinition(both).warnings.filter((w) => w.code === 'style.low_contrast');
    assert.equal(warning.severity, 'warning');
    assert.match(warning.message, /in the light theme and in the dark one/);
    const light = both;
    light.theme = { ...(light.theme || {}), appearance: 'light' };
    const [only] = validateAppDefinition(light).warnings.filter((w) => w.code === 'style.low_contrast');
    assert.match(only.message, /in the light theme;/);
});

test('a cellStyle rule with a fill is measured against its text colour or the theme text', () => {
    const table = (cellStyle) => ({
        id: 'cmp_ctr00002', type: 'table',
        props: { source: { kind: 'static', value: [] }, columns: [{ key: 'qty', cellStyle }] },
    });
    assert.deepEqual(contrast(app([table([rule('value == 0', { backgroundColor: '#fde047', color: '#ffffff' })])])), ['@.props.columns[0].cellStyle[0].style']);
    assert.deepEqual(contrast(app([table([rule('value == 0', { backgroundColor: '#7f1d1d', color: '#ffffff' })])])), []);
    assert.deepEqual(contrast(app([table([rule('value == 0', { color: '#ffffff' })])])), [], 'no fill, nothing measured');
});

test('an outlined card paints no fill, so its fill is not measured', () => {
    const card = (variant) => ({ id: 'cmp_ctr00003', type: 'card', props: { title: 'C', variant }, style: { span: 6, backgroundColor: '#ffff00' }, children: [] });
    assert.deepEqual(contrast(app([card('outlined')])), []);
    assert.deepEqual(contrast(app([card('elevated')])), ['@.style.backgroundColor']);
});
