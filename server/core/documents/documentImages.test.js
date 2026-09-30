'use strict';

/**
 * Whose stored pictures a deck shows its reader (documentImages.js): the
 * reader's own, and a colleague's that the colleague put into this document
 * themselves; never a key somebody else wrote into the outline under another
 * person's prefix.
 *
 * Pure: the storage readers and the "who put it there" lookup are handed in.
 * The lookup itself runs against Postgres in stores/documentStore.test.js.
 * The answers are kept across renders (a live preview renders on every pause
 * in typing): once found for good, and "not there" only up to the latest
 * revision, so a revision saved since is still read.
 *
 * Run: cd server && node --test core/documents/documentImages.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { makeDocumentImageResolver, makeAuthorCache, ANSWER_TTL_MS, _test: { spellingsOf } } = require('./documentImages');

const DOC = { id: 'deck1', userId: 'anna' };

/** Storage as the per-user readers see it: each opens only its own prefix. */
function setup(authors) {
    const opened = [];
    const lookups = [];
    const resolverFor = (userId) => async (ref) => {
        if (ref.dataUrl) return ref.dataUrl;
        if (!String(ref.storageKey).startsWith(`users/${userId}/`)) return null;
        opened.push([userId, ref.storageKey]);
        return `data:image/png;base64,${userId}`;
    };
    const firstAuthorOf = async (documentId, needles) => {
        lookups.push([documentId, needles]);
        const hit = needles.map((n) => authors[n]).find((a) => a !== undefined);
        return hit === undefined ? null : { createdBy: hit };
    };
    return { opened, lookups, resolve: (readerId, doc = DOC) => makeDocumentImageResolver({ readerId, doc, firstAuthorOf, resolverFor }) };
}

test("a project member sees the owner's pictures that the owner put into the deck", async () => {
    const s = setup({ 'users/anna/uploads/logo.png': 'anna' });
    const bob = s.resolve('bob');
    assert.strictEqual(await bob({ storageKey: 'users/anna/uploads/logo.png' }), 'data:image/png;base64,anna');
    assert.deepStrictEqual(s.opened, [['anna', 'users/anna/uploads/logo.png']]);
});

test("and the owner sees a member's picture the member added", async () => {
    const s = setup({ 'users/bob/pics/chart.png': 'bob' });
    assert.strictEqual(await s.resolve('anna')({ storageKey: 'users/bob/pics/chart.png' }), 'data:image/png;base64,bob');
});

test("a key written into the deck under somebody else's prefix is never read for them", async () => {
    // Bob, an editor, typed a path to one of Anna's other files into the outline.
    const s = setup({ 'users/anna/private/scan.png': 'bob' });
    assert.strictEqual(await s.resolve('bob')({ storageKey: 'users/anna/private/scan.png' }), null);
    assert.strictEqual(await s.resolve('cas')({ storageKey: 'users/anna/private/scan.png' }), null);
    assert.deepStrictEqual(s.opened, []);
});

test('a key no saved revision holds (an unsaved draft) opens nobody else\'s storage', async () => {
    const s = setup({});
    assert.strictEqual(await s.resolve('bob')({ storageKey: 'users/anna/private/scan.png' }), null);
    assert.deepStrictEqual(s.opened, []);
});

test('a revision from before authors were recorded counts as the owner\'s', async () => {
    const s = setup({ 'users/anna/old.png': null, 'users/ben/old.png': null });
    assert.strictEqual(await s.resolve('bob')({ storageKey: 'users/anna/old.png' }), 'data:image/png;base64,anna');
    assert.strictEqual(await s.resolve('bob')({ storageKey: 'users/ben/old.png' }), null);
});

test("the reader's own pictures and inline pictures need no lookup", async () => {
    const s = setup({});
    const bob = s.resolve('bob');
    assert.strictEqual(await bob({ storageKey: 'users/bob/a.png' }), 'data:image/png;base64,bob');
    assert.strictEqual(await bob({ dataUrl: 'data:image/png;base64,AAA' }), 'data:image/png;base64,AAA');
    assert.strictEqual(await bob({ storageKey: 'shared/elsewhere.png' }), null, 'a key outside any user prefix stays refused');
    assert.deepStrictEqual(s.lookups, []);
});

test('one lookup per key per render, whatever the number of slides it is on', async () => {
    const s = setup({ 'users/anna/logo.png': 'anna' });
    const bob = s.resolve('bob');
    await Promise.all([bob({ storageKey: 'users/anna/logo.png' }), bob({ storageKey: 'users/anna/logo.png' })]);
    assert.strictEqual(s.lookups.length, 1);
});

test('a failed lookup leaves the picture out rather than failing the render', async () => {
    const bob = makeDocumentImageResolver({
        readerId: 'bob', doc: DOC,
        firstAuthorOf: async () => { throw new Error('db down'); },
        resolverFor: (userId) => async () => `data:${userId}`,
    });
    assert.strictEqual(await bob({ storageKey: 'users/anna/logo.png' }), null);
});

test('a key is looked up as stored and as the proxy URL spells it', () => {
    assert.deepStrictEqual(spellingsOf('users/anna/a b.png'), ['users/anna/a b.png', 'users/anna/a%20b.png']);
    assert.deepStrictEqual(spellingsOf('users/anna/plain.png'), ['users/anna/plain.png']);
});

// ── Kept across renders: the live preview renders on every pause in typing ──

/** A history that counts its lookups; `latest` is the newest revision's number. */
function history(state) {
    const lookups = [];
    return {
        lookups,
        firstAuthorOf: async (documentId, needles, opts = {}) => {
            lookups.push(opts.afterSeq ?? null);
            const hit = needles.map((n) => state.authors[n]).find((a) => a !== undefined);
            return hit === undefined ? null : { createdBy: hit.by, seq: hit.seq };
        },
        revisionSeqOf: async () => state.latest,
    };
}
const colleague = (userId) => async (ref) => (String(ref.storageKey).startsWith(`users/${userId}/`) ? `data:${userId}` : null);

test('a picture found in the history is not looked up again on the next render', async () => {
    const state = { latest: 800, authors: { 'users/anna/logo.png': { by: 'anna', seq: 3 } } };
    const h = history(state);
    const cache = makeAuthorCache();
    const render = () => makeDocumentImageResolver({ readerId: 'bob', doc: DOC, ...h, resolverFor: colleague, cache });
    for (let i = 0; i < 5; i++) assert.strictEqual(await render()({ storageKey: 'users/anna/logo.png' }), 'data:anna');
    assert.deepStrictEqual(h.lookups, [null], 'one lookup for five renders, not one per render');
});

test('a picture no revision holds is looked for again only in the revisions saved since', async () => {
    const state = { latest: 800, authors: {} };
    const h = history(state);
    const cache = makeAuthorCache();
    const render = () => makeDocumentImageResolver({ readerId: 'bob', doc: DOC, ...h, resolverFor: colleague, cache });
    // Anna's picture in Bob's unsaved draft: nothing to show, and nothing read twice.
    assert.strictEqual(await render()({ storageKey: 'users/anna/new.png' }), null);
    assert.strictEqual(await render()({ storageKey: 'users/anna/new.png' }), null);
    assert.deepStrictEqual(h.lookups, [null]);
    // Anna saves it into the deck herself (revision 801): the next render reads only that revision.
    state.latest = 801;
    state.authors['users/anna/new.png'] = { by: 'anna', seq: 801 };
    assert.strictEqual(await render()({ storageKey: 'users/anna/new.png' }), 'data:anna');
    assert.deepStrictEqual(h.lookups, [null, 800]);
});

test('a key Bob wrote under Anna\'s prefix stays refused on every render, from the kept answer', async () => {
    const state = { latest: 12, authors: { 'users/anna/private/scan.png': { by: 'bob', seq: 12 } } };
    const h = history(state);
    const cache = makeAuthorCache();
    for (let i = 0; i < 3; i++) {
        const bob = makeDocumentImageResolver({ readerId: 'bob', doc: DOC, ...h, resolverFor: colleague, cache });
        assert.strictEqual(await bob({ storageKey: 'users/anna/private/scan.png' }), null);
    }
    assert.deepStrictEqual(h.lookups, [null]);
});

test('a kept answer is asked again once its time is up (a pruned revision can change it)', async () => {
    let clock = 0;
    const state = { latest: 5, authors: { 'users/anna/logo.png': { by: 'anna', seq: 1 } } };
    const h = history(state);
    const cache = makeAuthorCache({ now: () => clock });
    const render = () => makeDocumentImageResolver({ readerId: 'bob', doc: DOC, ...h, resolverFor: colleague, cache });
    await render()({ storageKey: 'users/anna/logo.png' });
    clock += ANSWER_TTL_MS + 1;
    await render()({ storageKey: 'users/anna/logo.png' });
    assert.deepStrictEqual(h.lookups, [null, null]);
});

test('without the latest revision number nothing negative is kept, and a failing read of it changes no answer', async () => {
    const state = { latest: null, authors: {} };
    const h = history(state);
    const cache = makeAuthorCache();
    const failing = { ...h, revisionSeqOf: async () => { throw new Error('db down'); } };
    for (const deps of [h, failing]) {
        assert.strictEqual(await makeDocumentImageResolver({ readerId: 'bob', doc: DOC, ...deps, resolverFor: colleague, cache })({ storageKey: 'users/anna/x.png' }), null);
    }
    assert.deepStrictEqual(h.lookups, [null, null], 'looked up each time: "not there" is only kept with a revision number');
    state.authors['users/anna/x.png'] = { by: 'anna', seq: 2 };
    assert.strictEqual(await makeDocumentImageResolver({ readerId: 'bob', doc: DOC, ...failing, resolverFor: colleague, cache })({ storageKey: 'users/anna/x.png' }), 'data:anna');
});

test('the answers kept are bounded', async () => {
    const cache = makeAuthorCache({ max: 2, now: () => 0 });
    cache.set('d', 'a', { through: 1, at: 0 });
    cache.set('d', 'b', { through: 1, at: 0 });
    cache.set('d', 'c', { through: 1, at: 0 });
    assert.strictEqual(cache.get('d', 'a'), null, 'the oldest goes first');
    assert.ok(cache.get('d', 'c'));
});
