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

const since = require('./schemaSince.mts');
const { renderExtensionIndex } = require('./builderPrompt/extensionIndex.mts');
const { applyInspectCatalog } = require('./builderTools/inspectionTools');

test('a form using validateOn is stamped schemaVersion 3, one without keeps 2', () => {
    const used = canonicalizeAppDefinition(defWith({ name: 'frm_a', validateOn: 'blur' })).def;
    const plain = canonicalizeAppDefinition(defWith({ name: 'frm_a' })).def;
    assert.strictEqual(used.schemaVersion, 3);
    assert.strictEqual(since.requiredSchemaVersion(used), 3);
    assert.strictEqual(plain.schemaVersion, 2);
});

test('validateOn is in the extension index and served by app_inspect_catalog', () => {
    assert.ok(renderExtensionIndex().includes('form.validateOn'));
    // A call that names something is never the "nothing asked" error.
    const res = /** @type {{ extensions?: Record<string, string>, unknown?: string[] }} */ (applyInspectCatalog({ extensions: ['form.validateOn'] }));
    assert.ok(JSON.stringify(res.extensions || {}).includes('validateOn'), JSON.stringify(res).slice(0, 300));
    assert.ok(!res.unknown || res.unknown.length === 0);
});
