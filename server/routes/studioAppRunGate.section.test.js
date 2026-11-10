'use strict';

// A section's visibleToRoles is part of the role gate: a button inside a section hidden from a
// role is as unreachable for that role as a button that carries the gate itself, and a document
// component inside it is out of that role's document pool. A section without the key changes
// nothing (the same walk as before).

const test = require('node:test');
const assert = require('node:assert');
const { actionRoleAccess, assertActionRoleAccess, documentChecks } = require('./studioAppRunGate');
const { findDocumentNode } = require('../appStudio/appDocuments/pool.mts');

function defWithSections(sections) {
    return {
        screens: [{ id: 'scr_1', sections }],
        actions: { act_save: { kind: 'refresh' }, act_open: { kind: 'refresh' } },
    };
}

const button = (id, onClick) => ({ id, type: 'button', props: {}, onClick });
const viewer = (id) => ({ id, type: 'document_viewer', props: {} });

function fakeRes() {
    return { statusCode: 200, status(c) { this.statusCode = c; return this; }, json() { return this; } };
}

test('a button in a section gated to admin is refused for a member and allowed for admin', () => {
    const def = defWithSections([
        { id: 'sec_admin', visibleToRoles: ['admin'], children: [button('cmp_a', 'act_save')] },
        { id: 'sec_open', children: [button('cmp_b', 'act_open')] },
    ]);
    assert.deepStrictEqual(actionRoleAccess(def, 'act_save', 'member'), { referenced: true, allowed: false });
    assert.deepStrictEqual(actionRoleAccess(def, 'act_save', 'admin'), { referenced: true, allowed: true });
    assert.deepStrictEqual(actionRoleAccess(def, 'act_open', 'member'), { referenced: true, allowed: true });
    const res = fakeRes();
    assert.strictEqual(assertActionRoleAccess(res, def, 'act_save', 'member', { isOwner: false }), false);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(assertActionRoleAccess(fakeRes(), def, 'act_save', 'member', { isOwner: true }), true, 'the owner always passes');
});

test('a viewer without a role clears an open section only', () => {
    const def = defWithSections([{ id: 'sec_admin', visibleToRoles: ['admin'], children: [button('cmp_a', 'act_save')] }]);
    assert.strictEqual(actionRoleAccess(def, 'act_save', null).allowed, false);
    const open = defWithSections([{ id: 'sec_open', visibleToRoles: [], children: [button('cmp_a', 'act_save')] }]);
    assert.strictEqual(actionRoleAccess(open, 'act_save', null).allowed, true, 'an empty list is open');
});

test('the same action wired in an open section stays reachable', () => {
    const def = defWithSections([
        { id: 'sec_admin', visibleToRoles: ['admin'], children: [button('cmp_a', 'act_save')] },
        { id: 'sec_open', children: [button('cmp_b', 'act_save')] },
    ]);
    assert.strictEqual(actionRoleAccess(def, 'act_save', 'member').allowed, true);
});

test('a document component in a role-gated section is outside that role\'s pool', () => {
    const def = defWithSections([
        { id: 'sec_admin', visibleToRoles: ['admin'], children: [viewer('cmp_doc')] },
        { id: 'sec_open', children: [viewer('cmp_doc2')] },
    ]);
    assert.strictEqual(findDocumentNode(def, 'cmp_doc', documentChecks(def, 'member')), null);
    assert.ok(findDocumentNode(def, 'cmp_doc', documentChecks(def, 'admin')));
    assert.ok(findDocumentNode(def, 'cmp_doc', documentChecks(def, 'owner')));
    assert.ok(findDocumentNode(def, 'cmp_doc2', documentChecks(def, 'member')));
});
