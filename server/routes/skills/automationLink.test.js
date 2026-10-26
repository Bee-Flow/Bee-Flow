// @typecheck
/**
 * routes/skills/automationLink.js: linking an automation to a skill is starting
 * it, so only a caller who may start it may link it.
 *
 * Run: cd server && node --test routes/skills/automationLink.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');

/** @type {Record<string, string>} */
const ROLE = { olga: 'owner', ed: 'edit', ron: 'run', vic: 'view' };
/** @type {Array<{ userId: string, need: string }>} */
const asked = [];
const deps = {
    getAutomation: async (/** @type {string} */ id) => (id === 'au-1' ? { id, userId: 'olga' } : null),
    canAccessAutomation: async (/** @type {unknown} */ _a, /** @type {string} */ userId, /** @type {string} */ need) => {
        asked.push({ userId, need });
        return need === 'start' && ['owner', 'edit', 'run'].includes(ROLE[userId]);
    },
};
const { assertMayLinkAutomation: link } = require('./automationLink');
const assertMayLinkAutomation = (/** @type {string|null} */ id, /** @type {string} */ userId, /** @type {string|null} */ current = null) => link(id, userId, current, deps);

const forbidden = (/** @type {any} */ e) => e.status === 403 && e.code === 'automation_link_forbidden';

test('the owner, an edit share and a run share may link it; a view share and a stranger may not', async () => {
    for (const who of ['olga', 'ed', 'ron']) await assertMayLinkAutomation('au-1', who);
    await assert.rejects(() => assertMayLinkAutomation('au-1', 'vic'), forbidden);
    await assert.rejects(() => assertMayLinkAutomation('au-1', 'stranger'), forbidden);
    assert.ok(asked.every((a) => a.need === 'start'), 'the start right is what is asked');
});

test('a missing automation reads like a forbidden one, and no link or an unchanged link needs no check', async () => {
    await assert.rejects(() => assertMayLinkAutomation('au-gone', 'olga'), forbidden);
    asked.length = 0;
    await assertMayLinkAutomation(null, 'vic');
    await assertMayLinkAutomation('au-1', 'vic', 'au-1');
    assert.strictEqual(asked.length, 0);
});
