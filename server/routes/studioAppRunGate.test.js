'use strict';

// The role gate through call_action: a called action is as reachable as the
// actions that call it, so a direct /step on a callee of an admin-only root is
// refused like the root itself (both bridges use assertActionRoleAccess).

const test = require('node:test');
const assert = require('node:assert');
const { actionRoleAccess, assertActionRoleAccess, documentChecks } = require('./studioAppRunGate');

const CALL = (actionId) => ({ kind: 'call_action', actionId, params: {} });
const SEQ = (...steps) => ({ kind: 'sequence', steps });
const MAIL = SEQ({ kind: 'send_email', to: 'a@example.test', subject: 's', body: 'b' });

/** One screen with the given buttons; `gate` puts visibleToRoles on a button. */
function defWith(buttons, actions) {
    const children = buttons.map(([onClick, gate], i) => ({ id: `cmp_${i}`, type: 'button', props: {}, onClick, ...(gate ? { visibleToRoles: gate } : {}) }));
    return { screens: [{ id: 'scr_1', sections: [{ id: 'sec_1', children }] }], actions };
}

function fakeRes() {
    return { statusCode: 200, status(c) { this.statusCode = c; return this; }, json() { return this; } };
}

test('a callee of an admin-only root is referenced and refused for a member', () => {
    const def = defWith([['act_admin', ['admin']]], { act_admin: SEQ(CALL('act_mail')), act_mail: MAIL });
    assert.deepStrictEqual(actionRoleAccess(def, 'act_mail', 'member'), { referenced: true, allowed: false });
    assert.deepStrictEqual(actionRoleAccess(def, 'act_mail', 'admin'), { referenced: true, allowed: true });
    const res = fakeRes();
    assert.strictEqual(assertActionRoleAccess(res, def, 'act_mail', 'member', { isOwner: false }), false);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(assertActionRoleAccess(fakeRes(), def, 'act_mail', 'member', { isOwner: true }), true, 'the owner always passes');
    assert.strictEqual(documentChecks(def, 'member').actionAllowed('act_mail'), false);
});

test('two levels deep: the grand-callee follows the root', () => {
    const def = defWith([['act_root', ['admin']]], { act_root: CALL('act_mid'), act_mid: SEQ(CALL('act_leaf')), act_leaf: MAIL });
    assert.strictEqual(actionRoleAccess(def, 'act_leaf', 'member').allowed, false);
    assert.strictEqual(actionRoleAccess(def, 'act_leaf', 'admin').allowed, true);
});

test('one reachable caller is enough: open root, or a programmatic (unwired, uncalled) root', () => {
    const both = defWith([['act_admin', ['admin']], ['act_open']], { act_admin: SEQ(CALL('act_mail')), act_open: SEQ(CALL('act_mail')), act_mail: MAIL });
    assert.deepStrictEqual(actionRoleAccess(both, 'act_mail', 'member'), { referenced: true, allowed: true });
    const programmatic = defWith([], { act_root: SEQ(CALL('act_mail')), act_mail: MAIL });
    assert.deepStrictEqual(actionRoleAccess(programmatic, 'act_mail', 'member'), { referenced: true, allowed: true });
});

test('an action nothing wires and nothing calls stays programmatic (unchanged behaviour)', () => {
    const def = defWith([['act_admin', ['admin']]], { act_admin: MAIL, act_chain: MAIL });
    assert.deepStrictEqual(actionRoleAccess(def, 'act_chain', 'member'), { referenced: false, allowed: false });
    assert.strictEqual(assertActionRoleAccess(fakeRes(), def, 'act_chain', 'member', { isOwner: false }), true);
});

test('a callee wired to an open button of its own stays allowed', () => {
    const def = defWith([['act_admin', ['admin']], ['act_mail']], { act_admin: SEQ(CALL('act_mail')), act_mail: MAIL });
    assert.strictEqual(actionRoleAccess(def, 'act_mail', 'member').allowed, true);
});

test('a hand-written call cycle terminates and grants nothing', () => {
    const def = defWith([], { act_a: SEQ(CALL('act_b')), act_b: SEQ(CALL('act_a')) });
    assert.deepStrictEqual(actionRoleAccess(def, 'act_a', 'member'), { referenced: true, allowed: false });
});

test('an action a node lists in its props follows that node\'s role gate, whichever list holds it', () => {
    const wirings = {
        rowActions: { rowActions: [{ label: 'Open', actionId: 'act_x' }] },
        itemActions: { itemActions: [{ label: 'Open', actionId: 'act_x' }] },
        bulkActions: { bulkActions: [{ label: 'Archive', actionId: 'act_x' }] },
        toolbarActions: { toolbarActions: [{ label: 'Export', actionId: 'act_x' }] },
        addRowActionId: { addRowActionId: 'act_x' },
        'columns[].actionId': { columns: [{ field: 'name' }, { label: 'Go', actionId: 'act_x' }] },
    };
    for (const [name, props] of Object.entries(wirings)) {
        const def = { screens: [{ id: 'scr_1', sections: [{ id: 'sec_1', children: [{ id: 'cmp_g', type: 'data_grid', visibleToRoles: ['admin'], props }] }] }], actions: { act_x: MAIL } };
        assert.deepStrictEqual(actionRoleAccess(def, 'act_x', 'member'), { referenced: true, allowed: false }, name);
        assert.deepStrictEqual(actionRoleAccess(def, 'act_x', 'admin'), { referenced: true, allowed: true }, name);
        const res = fakeRes();
        assert.strictEqual(assertActionRoleAccess(res, def, 'act_x', 'member', { isOwner: false }), false, name);
        assert.strictEqual(res.statusCode, 403, name);
        // Without a gate on the node it is open to everyone, as before.
        const open = JSON.parse(JSON.stringify(def));
        delete open.screens[0].sections[0].children[0].visibleToRoles;
        assert.deepStrictEqual(actionRoleAccess(open, 'act_x', 'member'), { referenced: true, allowed: true }, name);
    }
});

test('an action nothing wires and nothing calls stays programmatic', () => {
    const def = defWith([['act_other', ['admin']]], { act_other: MAIL, act_chain: MAIL });
    assert.deepStrictEqual(actionRoleAccess(def, 'act_chain', 'member'), { referenced: false, allowed: false });
    assert.strictEqual(assertActionRoleAccess(fakeRes(), def, 'act_chain', 'member', { isOwner: false }), true);
});
