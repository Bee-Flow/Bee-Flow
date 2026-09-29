/**
 * automation/templates.js — organisation templates next to the built-in ones
 * (handoff 5, "Save as template"). The store is injected.
 *
 * Run: cd server && node --test automation/templates.org.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { listTemplatesFor, getTemplateFor, listTemplates } = require('./templates');

const ORG_ROW = {
    id: 'org-1', organizationId: 'org1', createdBy: 'u1', title: 'Our invoices', description: 'Reads them', icon: 'file',
    definition: { trigger: { kind: 'manual' }, steps: [{ id: 'a', type: 'integration_action', tool: 'nextcloud_list_files' }] },
    createdAt: '2026-09-28T10:00:00.000Z',
};

const getUser = async (id) => (id === 'u1' ? { id: 'u1', displayName: 'Anne de Vries', username: 'anne' } : null);

test('the list leads with the organisation templates, then the built-in ones, each with its source', async () => {
    const seen = [];
    const store = { async listTemplatesFor(scope) { seen.push(scope); return [ORG_ROW]; } };
    const list = await listTemplatesFor({ userId: 'u1', orgId: 'org1' }, { store, getUser });
    assert.deepStrictEqual(seen, [{ userId: 'u1', orgId: 'org1' }]);
    assert.strictEqual(list[0].id, 'org-1');
    assert.strictEqual(list[0].source, 'org');
    assert.strictEqual(list[0].category, null);
    assert.deepStrictEqual(list[0].requiredIntegrations, ['nextcloud']);
    assert.strictEqual(list[0].definition, undefined, 'cards carry no definition');
    assert.strictEqual(list.length, 1 + listTemplates().length);
    assert.ok(list.slice(1).every((t) => t.source === 'builtin'));
});

test('a store that cannot be read leaves the built-in gallery', async () => {
    const warned = [];
    const store = { async listTemplatesFor() { throw new Error('db down'); } };
    const list = await listTemplatesFor({ userId: 'u1' }, { store, getUser, log: { warn: (m) => warned.push(m) } });
    assert.strictEqual(list.length, listTemplates().length);
    assert.strictEqual(warned.length, 1);
});

test('an organisation card says who saved it, and whether that was the caller', async () => {
    const theirs = { ...ORG_ROW, id: 'org-2', createdBy: 'u2' };
    const gone = { ...ORG_ROW, id: 'org-3', createdBy: 'u3' };
    const store = { async listTemplatesFor() { return [ORG_ROW, theirs, gone]; } };
    const lookups = [];
    const users = {
        u1: { displayName: 'Anne de Vries', username: 'anne' },
        u2: { displayName: '', username: 'joost' },
    };
    const lookup = async (id) => {
        lookups.push(id);
        if (id === 'u3') throw new Error('no such user');
        return users[id] || null;
    };
    const list = await listTemplatesFor({ userId: 'u1', orgId: 'org1' }, { store, getUser: lookup });
    assert.deepStrictEqual(list.slice(0, 3).map((c) => [c.id, c.createdByName, c.mine]), [
        ['org-1', 'Anne de Vries', true],
        ['org-2', 'joost', false],
        ['org-3', null, false],
    ]);
    assert.deepStrictEqual(lookups.sort(), ['u1', 'u2', 'u3'], 'each saver is looked up once');
});

test('every card carries its trigger and step count for the "starts with" line', async () => {
    const store = { async listTemplatesFor() { return [ORG_ROW]; } };
    const [org] = await listTemplatesFor({ userId: 'u1', orgId: 'org1' }, { store, getUser });
    assert.strictEqual(org.triggerKind, 'manual');
    assert.strictEqual(org.triggerApp, null);
    assert.strictEqual(org.stepCount, 1);
    for (const card of listTemplates()) {
        assert.strictEqual(typeof card.stepCount, 'number', `${card.id} stepCount`);
        assert.ok(card.stepCount > 0, `${card.id} has steps`);
        assert.ok(card.triggerKind, `${card.id} triggerKind`);
        if (card.triggerKind === 'app_event') assert.ok(card.triggerApp, `${card.id} triggerApp`);
    }
});

test('one template: built-in by id first, else the organisation row with its definition', async () => {
    const store = { async getTemplateFor(id, scope) { return id === 'org-1' && scope.orgId === 'org1' ? ORG_ROW : null; } };
    const builtin = await getTemplateFor('nc-invoice-inbox', { userId: 'u1', orgId: 'org1' }, { store });
    assert.strictEqual(builtin.source, 'builtin');
    assert.ok(builtin.definition.steps.length);
    const org = await getTemplateFor('org-1', { userId: 'u1', orgId: 'org1' }, { store });
    assert.strictEqual(org.source, 'org');
    assert.deepStrictEqual(org.definition, ORG_ROW.definition);
    assert.strictEqual(await getTemplateFor('org-1', { userId: 'u1', orgId: 'org2' }, { store }), null);
});
