// @typecheck
/**
 * form.validateOn: optional, emitted only when the author set it, checked against
 * the spec enum like any other prop.
 *
 * Run: node --test appStudio/formValidateOn.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');

function defWith(props) {
    return {
        schemaVersion: 2,
        meta: { name: 'T' },
        homeScreenId: 'scr_aaaaaa',
        screens: [{
            id: 'scr_aaaaaa',
            name: 'A',
            sections: [{ id: 'sec_aaaaaa', children: [{ id: 'cmp_ffffff', type: 'form', props, children: [] }] }],
        }],
    };
}

const formProps = (def) => canonicalizeAppDefinition(def).def.screens[0].sections[0].children[0].props;

test('a form without validateOn does not gain the key', () => {
    assert.ok(!('validateOn' in formProps(defWith({ name: 'frm_a' }))));
});

test('validateOn survives canonicalisation and a second pass', () => {
    const once = canonicalizeAppDefinition(defWith({ name: 'frm_a', validateOn: 'blur' })).def;
    assert.strictEqual(once.screens[0].sections[0].children[0].props.validateOn, 'blur');
    assert.deepStrictEqual(canonicalizeAppDefinition(once).def, once);
});

test('validator accepts the legal values and rejects others', () => {
    for (const v of ['submit', 'blur', 'change']) {
        const definition = canonicalizeAppDefinition(defWith({ name: 'frm_a', validateOn: v })).def;
        const res = validateAppDefinition(definition);
        assert.ok(!JSON.stringify(res).includes('validateOn'), v);
    }
    const bad = canonicalizeAppDefinition(defWith({ name: 'frm_a', validateOn: 'bogus' })).def;
    assert.ok(JSON.stringify(validateAppDefinition(bad)).includes('validateOn'));
});
