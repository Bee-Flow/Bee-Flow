/**
 * agents/notebooks/notebookAiShield.js — the Privacy Shield for a notebook's
 * one-shot AI calls (/generate, /ai-fill): block lists on the sources, one
 * scan over every prompt unit into the notebook's own token map, a refusal
 * when the shield blocks or fails closed, and the answer untokenised.
 *
 * Run: cd server && node --test agents/notebooks/notebookAiShield.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { shieldNotebookPrompt } = require('./notebookAiShield');

function world({ stored = { enabled: true }, scan } = {}) {
    const maps = new Map();
    const seen = { scans: [], stripped: [] };
    const deps = {
        getConfig: async (key) => (key === 'org_privacy_shield_org1' ? stored : null),
        resolveShieldFor: async () => ({ blockList: ['Project Nightjar'] }),
        stripInjectedText: async (text, { shield }) => { seen.stripped.push(text); return text.split(shield.blockList[0]).join(''); },
        composeScan: scan || (async ({ units, conversationId }) => {
            seen.scans.push({ units, conversationId });
            const tokenMap = { '[person_1]': 'Anna de Vries' };
            maps.set(conversationId, { ...(maps.get(conversationId) || {}), ...tokenMap });
            return { blocked: false, tokenMap, count: 1, mentions: 2, units: units.map((u) => u.split('Anna de Vries').join('[person_1]')) };
        }),
        dlp: {
            getConversationTokenMapAsync: async () => null,
            getConversationTokenMap: (id) => maps.get(id) || null,
        },
        log: { info() {}, warn() {} },
    };
    return { deps, seen };
}

const INPUT = { orgId: 'org1', userId: 'u1', notebookId: 'nb1', sourceText: 'Anna de Vries leads Project Nightjar.', otherUnits: ['Dear {{name}}'] };

test('the sources lose the block list, every unit is tokenised into the notebook\'s map, and the answer comes back real', async () => {
    const { deps, seen } = world();
    const out = await shieldNotebookPrompt(INPUT, deps);
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.units, ['[person_1] leads .', 'Dear {{name}}']);
    assert.strictEqual(seen.scans[0].conversationId, 'nb1', 'the notebook chat\'s own token map');
    assert.match(out.addendum, /\[person_1\]/, 'the model is told to keep the tokens');
    const back = out.untokenise.push('Hello [person_1]') + out.untokenise.flush();
    assert.strictEqual(back, 'Hello Anna de Vries');
});

test('a blocking shield refuses the call', async () => {
    const { deps } = world({ scan: async () => ({ blocked: true, reason: 'pii', mentions: 1, units: [] }) });
    const out = await shieldNotebookPrompt(INPUT, deps);
    assert.deepStrictEqual({ ok: out.ok, status: out.status, code: out.code }, { ok: false, status: 422, code: 'privacy_shield_blocked' });
});

test('a scan that cannot run: refused when the shield fails closed, passed through otherwise', async () => {
    const failing = async () => { throw new Error('guard down'); };
    const closed = world({ stored: { enabled: true, dlpFailureMode: 'fail_closed' }, scan: failing });
    const refused = await shieldNotebookPrompt(INPUT, closed.deps);
    assert.deepStrictEqual({ ok: refused.ok, status: refused.status, code: refused.code }, { ok: false, status: 503, code: 'privacy_shield_unavailable' });
    const open = world({ stored: { enabled: true, dlpFailureMode: 'fail_open' }, scan: failing });
    const passed = await shieldNotebookPrompt(INPUT, open.deps);
    assert.strictEqual(passed.ok, true);
    assert.deepStrictEqual(passed.units, ['Anna de Vries leads .', 'Dear {{name}}']);
});

test('the shield off: no scan, texts unchanged apart from the block list', async () => {
    const { deps, seen } = world({ stored: { enabled: false } });
    const out = await shieldNotebookPrompt({ ...INPUT, orgId: 'org1' }, deps);
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(seen.scans, []);
    assert.deepStrictEqual(out.units, ['Anna de Vries leads .', 'Dear {{name}}']);
    assert.strictEqual(out.addendum, '');
});
