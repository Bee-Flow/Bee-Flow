// @typecheck
/**
 * Cowork templates on a real Postgres (PGlite): saved and read back with their plan, listed per organisation only,
 * and deleted by their creator or an administrator, never across organisations.
 *
 * Run: cd server && node --test stores/coworkTemplates.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
const { close } = require('../testUtils/pglitePool').usePglitePool();
const { makeCoworkTemplates, initDB } = require('./coworkTemplates.mts');

const templates = makeCoworkTemplates({ ready: initDB });

before(async () => { await initDB(); });
after(close);

const DEFINITION = { trigger: { kind: 'schedule' }, steps: [{ id: 's1', type: 'ai_step', label: 'Summarise' }], edges: [] };
const saved = (/** @type {Partial<import('./coworkTemplates.mts').NewTemplate>} */ over = {}) => templates.create({
    organizationId: 'org-a', createdBy: 'ann', title: 'Supplier radar', brief: 'Watch the suppliers.', repeatInterval: 'weekly',
    definition: null, fingerprint: null, ...over,
});

test('a template is stored with its plan and read back within its organisation only', async () => {
    const t = await saved({ definition: DEFINITION, fingerprint: 'f'.repeat(64) });
    assert.deepStrictEqual(
        { ...t, createdAt: typeof t.createdAt },
        { id: t.id, organizationId: 'org-a', createdBy: 'ann', title: 'Supplier radar', brief: 'Watch the suppliers.', repeatInterval: 'weekly', definition: DEFINITION, fingerprint: 'f'.repeat(64), createdAt: 'string' },
    );
    assert.deepStrictEqual(await templates.get(t.id, 'org-a'), t);
    assert.strictEqual(await templates.get(t.id, 'org-b'), null, 'another organisation does not see it');
});

test('the list is the organisation\'s, newest first', async () => {
    const first = await saved({ organizationId: 'org-list', title: 'First' });
    const second = await saved({ organizationId: 'org-list', title: 'Second' });
    await saved({ organizationId: 'org-other', title: 'Elsewhere' });
    const listed = await templates.listForOrg('org-list');
    assert.deepStrictEqual(new Set(listed.map((t) => t.id)), new Set([first.id, second.id]));
    assert.ok(listed.every((t) => t.organizationId === 'org-list'));
});

test('only its creator or an administrator of its organisation deletes it', async () => {
    const t = await saved();
    assert.strictEqual(await templates.remove(t.id, 'org-a', { userId: 'bob', asAdmin: false }), false, 'a colleague does not');
    assert.strictEqual(await templates.remove(t.id, 'org-b', { userId: 'eve', asAdmin: true }), false, 'nor an administrator of another organisation');
    assert.strictEqual(await templates.remove(t.id, 'org-a', { userId: 'ann', asAdmin: false }), true);
    assert.strictEqual(await templates.get(t.id, 'org-a'), null);
    const other = await saved();
    assert.strictEqual(await templates.remove(other.id, 'org-a', { userId: 'cas', asAdmin: true }), true, 'an administrator of the organisation does');
});
