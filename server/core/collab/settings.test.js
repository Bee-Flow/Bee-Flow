/**
 * Whether co-editing is on (core/collab/settings.js), with the config store
 * and the fold-back injected: no module mocking.
 *
 * Proven: on by default (also without an organisation, and when the config
 * read fails); the organisation setting turns it off; the server kill switch
 * wins over everything; answers are cached and a save invalidates; a save
 * keeps a complete shape; switching off (and saving off again) folds the
 * organisation's documents back, in the background.
 *
 * Run: cd server && node --test core/collab/settings.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const S = require('./settings');

function fakeConfig(initial = {}) {
    const data = new Map(Object.entries(initial));
    let reads = 0;
    return {
        data,
        get reads() { return reads; },
        fail: false,
        async getConfig(key) { reads += 1; if (this.fail) throw new Error('db down'); return data.get(key) ?? null; },
        async setConfig(key, value) { data.set(key, value); },
    };
}

test.beforeEach(() => S.invalidateCollabSettings());

test('on by default, also without an organisation and when the read fails', async () => {
    const cfg = fakeConfig();
    const s = S.makeCollabSettings({ configStore: cfg, env: {} });
    assert.strictEqual(await s.isCollabEnabled('org1'), true);
    assert.strictEqual(await s.isCollabEnabled(null), true);
    S.invalidateCollabSettings();
    cfg.fail = true;
    assert.strictEqual(await s.isCollabEnabled('org1'), true);
});

test('the organisation setting turns it off; the kill switch wins', async () => {
    const cfg = fakeConfig({ org_collab_org1: { collab_enabled: false }, org_collab_org2: { collab_enabled: true } });
    assert.strictEqual(await S.makeCollabSettings({ configStore: cfg, env: {} }).isCollabEnabled('org1'), false);
    for (const off of ['0', 'false', 'off', 'no']) {
        assert.strictEqual(await S.makeCollabSettings({ configStore: cfg, env: { COLLAB_ENABLED: off } }).isCollabEnabled('org2'), false, off);
    }
    assert.strictEqual(await S.makeCollabSettings({ configStore: cfg, env: { COLLAB_ENABLED: '1' } }).isCollabEnabled('org2'), true);
    assert.deepStrictEqual(S.normalizeSettings({ collab_enabled: 'yes', other: 1 }), { collab_enabled: true });
});

test('answers are cached; a save invalidates and keeps a complete shape', async () => {
    const cfg = fakeConfig();
    const s = S.makeCollabSettings({ configStore: cfg, env: {}, detachOrganisation: async () => ({ detached: 0, failed: 0 }) });
    await s.isCollabEnabled('org1');
    await s.isCollabEnabled('org1');
    assert.strictEqual(cfg.reads, 1);
    assert.deepStrictEqual(await s.saveCollabSettings('org1', { collab_enabled: false, junk: true }), { collab_enabled: false });
    assert.deepStrictEqual(cfg.data.get('org_collab_org1'), { collab_enabled: false });
    assert.strictEqual(await s.isCollabEnabled('org1'), false, 'the save is visible at once');
    await assert.rejects(s.saveCollabSettings('', {}), /orgId is required/);
});

test('switching off, and only off, folds the organisation\'s documents back in the background', async () => {
    const folded = [];
    const cfg = fakeConfig();
    const s = S.makeCollabSettings({ configStore: cfg, env: {}, detachOrganisation: async (orgId) => { folded.push(orgId); return { detached: 2, failed: 0 }; } });
    await s.saveCollabSettings('org1', { collab_enabled: true });
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(folded, []);
    await s.saveCollabSettings('org1', { collab_enabled: false });
    assert.deepStrictEqual(folded, [], 'the save does not wait for it');
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(folded, ['org1']);
    await s.saveCollabSettings('org1', {});
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(folded, ['org1'], 'a save that does not touch the switch folds nothing');
    // Saved off again: whatever could not be folded back gets another pass,
    // so "switch co-editing off" stays a remedy that works.
    await s.saveCollabSettings('org1', { collab_enabled: false });
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(folded, ['org1', 'org1']);
});
