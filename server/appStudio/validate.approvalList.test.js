/**
 * approval_list — catalog acceptance + the public-screen warning.
 *
 * The component is SAFE on a public page (sign-in wall, session-authed API,
 * canView scoping) but useless there — the validator says so as a WARNING,
 * never an error, so an author who wants the wall on purpose can keep it.
 *
 * Run: node --test appStudio/validate.approvalList.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');

function defWith({ publicAccess } = {}) {
    return {
        schemaVersion: 2,
        name: 'Approvals app',
        screens: [
            {
                id: 'scr_home', name: 'Home',
                sections: [{ children: [
                    { id: 'cmp_ap1', type: 'approval_list', props: { scope: 'mine', show: 'waiting' } },
                ] }],
            },
            { id: 'scr_other', name: 'Other', sections: [{ children: [] }] },
        ],
        ...(publicAccess ? { publicAccess } : {}),
    };
}

function canonAndValidate(raw) {
    const { def } = canonicalizeAppDefinition(raw);
    return { definition: def, res: validateAppDefinition(def) };
}

test('approval_list canonicalizes and validates clean on a private screen', () => {
    const { definition, res } = canonAndValidate(defWith());
    const node = definition.screens[0].sections[0].children[0];
    assert.strictEqual(node.type, 'approval_list');
    assert.strictEqual(node.props.scope, 'mine');
    assert.strictEqual(node.props.showDetails, true, 'spec default fills in');
    assert.ok(res.ok, JSON.stringify(res.errors));
    assert.ok(!res.warnings.some(w => w.code === 'publicAccess.approval_list_walled'));
});

test('an approval_list on a publicly shared screen warns — and only warns', () => {
    const { res } = canonAndValidate(defWith({
        publicAccess: { entryScreenId: 'scr_home', screenIds: ['scr_home'], roleKey: 'visitor' },
    }));
    const hit = res.warnings.find(w => w.code === 'publicAccess.approval_list_walled');
    assert.ok(hit, `expected the wall warning, got: ${JSON.stringify(res.warnings.map(w => w.code))}`);
    assert.ok(!res.errors.some(e => e.code === 'publicAccess.approval_list_walled'), 'a warning, never an error');
});

test('a public app whose approvals sit on a members-only screen stays quiet', () => {
    const raw = defWith({
        publicAccess: { entryScreenId: 'scr_other', screenIds: ['scr_other'], roleKey: 'visitor' },
    });
    const { res } = canonAndValidate(raw);
    assert.ok(!res.warnings.some(w => w.code === 'publicAccess.approval_list_walled'),
        JSON.stringify(res.warnings.filter(w => String(w.code).startsWith('publicAccess'))));
});
