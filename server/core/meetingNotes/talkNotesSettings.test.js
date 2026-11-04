/**
 * talkNotesSettings — the org document's "no opinion" (null) survives the
 * admin screen's round trip, so one Save does not pin every member's choice.
 *
 * Run: cd server && node --test core/meetingNotes/talkNotesSettings.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { makeSwaps } = require('../../testUtils/swaps');

const docs = new Map();
// The real config store, its readers and writer swapped for an in-memory map.
const swaps = makeSwaps();
const configStore = require('../../stores/configStore');
swaps.swap(configStore, 'getConfig', async (k) => (docs.has(k) ? JSON.parse(JSON.stringify(docs.get(k))) : null));
swaps.swap(configStore, 'setConfig', async (k, v) => { docs.set(k, JSON.parse(JSON.stringify(v))); });
test.after(() => swaps.restore());

const s = require('./talkNotesSettings');

test.beforeEach(() => docs.clear());

test('an unconfigured org reports no opinion for member fields, defaults for org-only ones', async () => {
    const got = await s.getOrgSettings('o1');
    assert.strictEqual(got.autoTranscribe, null);
    assert.strictEqual(got.language, null);
    assert.strictEqual(got.recordingFolder, null);
    assert.strictEqual(got.insightsPerPersonStats, true);
    assert.strictEqual(got.defaultOwnerUserId, null);
});

test('REGRESSION: saving the org panel only to flip insights keeps members\' own settings', async () => {
    await s.saveUserSettings('u1', { autoTranscribe: true, language: 'en', recordingFolder: '/Mine' });
    const loaded = await s.getOrgSettings('o1');
    await s.saveOrgSettings('o1', { ...JSON.parse(JSON.stringify(loaded)), insightsPerPersonStats: false }, 'admin');
    const eff = await s.resolveTalkNotesSettings({ orgId: 'o1', userId: 'u1' });
    assert.strictEqual(eff.autoTranscribe, true);
    assert.strictEqual(eff.language, 'en');
    assert.strictEqual(eff.recordingFolder, '/Mine');
    assert.strictEqual(eff.insightsPerPersonStats, false);
});

test('an org value the admin did set still overrides the member', async () => {
    await s.saveUserSettings('u1', { autoRecord: true });
    await s.saveOrgSettings('o1', { autoRecord: false }, 'admin');
    assert.strictEqual((await s.resolveTalkNotesSettings({ orgId: 'o1', userId: 'u1' })).autoRecord, false);
});
