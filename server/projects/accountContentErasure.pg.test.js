'use strict';

/**
 * projects/accountContentErasure.js: erasing meeting notes also arms the
 * meeting_tag knowledge sources watching their tags, in every refresh mode,
 * so a colleague's knowledge base drops the erased summaries at its next tick
 * instead of answering from them until its next scheduled pass. The arm is
 * best-effort: a failing kb store never fails the erasure.
 * Real stores on PGlite; the one failure is a swap on the store object.
 *
 * Run: cd server && node --test projects/accountContentErasure.pg.test.js
 */

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { usePglitePool } = require('../testUtils/pglitePool');
const { makeSwaps } = require('../testUtils/swaps');

const { pg, close } = usePglitePool();
const transcriptCrypto = require('../stores/transcriptCrypto');
const transcriptionStore = require('../stores/transcriptionStore');
const kbStore = require('../stores/knowledgeBases');
const sourcesStore = require('../stores/kbSources');
const { eraseTranscriptions, eraseOrgTranscriptions } = require('./accountContentErasure');

const fileSwaps = makeSwaps();
const testSwaps = makeSwaps();

before(async () => {
    await pg.exec(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner_id TEXT, organization_id TEXT NOT NULL DEFAULT '')`);
    fileSwaps.swap(transcriptCrypto, 'resolveTranscriptCrypto', async () => transcriptCrypto.PLAINTEXT_CONTEXT);
    await transcriptionStore.initDB();
    await kbStore.whenReady();
    await sourcesStore.initDB();
});
afterEach(() => testSwaps.restore());
after(async () => {
    fileSwaps.restore();
    await close();
});

/** A manual meeting_tag source (one a new meeting would not arm), never due. */
async function manualSource(tag) {
    const tenant = `tu_${crypto.randomBytes(4).toString('hex')}`;
    const kb = await kbStore.createKB(tenant, `meetings-${tenant}`, 'erasure arm test');
    const src = await sourcesStore.create({ knowledgeBaseId: kb.id, kind: 'meeting_tag', config: { tag }, refreshMode: 'manual' });
    await pg.query(`UPDATE kb_sources SET next_refresh_at = NULL WHERE id = $1`, [src.id]);
    return src.id;
}
const dueOf = async (id) => (await pg.query('SELECT next_refresh_at FROM kb_sources WHERE id = $1', [id])).rows[0].next_refresh_at;

test('erasing a person\'s notes arms the sources of their tags, manual ones included', async () => {
    const tag = `sales-${crypto.randomBytes(3).toString('hex')}`;
    const other = await manualSource(`other-${tag}`);
    const watching = await manualSource(tag);
    await transcriptionStore.createTranscription({ userId: 'leaver', organizationId: 'org1', title: 'A', tags: [tag] });
    await transcriptionStore.createTranscription({ userId: 'leaver', organizationId: 'org1', title: 'B', tags: [] });

    assert.equal(await eraseTranscriptions('leaver'), 2);
    assert.equal((await pg.query(`SELECT COUNT(*)::int AS n FROM transcriptions WHERE user_id = 'leaver'`)).rows[0].n, 0);
    assert.ok(await dueOf(watching), 'the source watching the erased tag is due now');
    assert.equal(await dueOf(other), null, 'a source on another tag is left alone');
});

test('the organisation cascade arms them too', async () => {
    const tag = `hr-${crypto.randomBytes(3).toString('hex')}`;
    const watching = await manualSource(tag);
    await transcriptionStore.createTranscription({ userId: 'gone-member', organizationId: 'org-erase', title: 'C', tags: [tag] });
    assert.equal(await eraseOrgTranscriptions('org-erase'), 1);
    assert.ok(await dueOf(watching));
});

test('a failing arm never fails the erasure', async () => {
    const tag = `ops-${crypto.randomBytes(3).toString('hex')}`;
    await transcriptionStore.createTranscription({ userId: 'leaver-2', organizationId: 'org1', title: 'D', tags: [tag] });
    testSwaps.swap(sourcesStore, 'armMeetingSourcesForRemoval', async () => { throw new Error('kb down'); });
    assert.equal(await eraseTranscriptions('leaver-2'), 1);
    assert.equal((await pg.query(`SELECT COUNT(*)::int AS n FROM transcriptions WHERE user_id = 'leaver-2'`)).rows[0].n, 0);
});
