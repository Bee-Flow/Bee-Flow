/**
 * PATCH /:id/speakers — the rename/merge substitution.
 *
 * REGRESSION: renames were applied as a mutating CHAIN — each rename rewrote
 * any existing mapping value that pointed at the old name. That made the result
 * order-dependent and destroyed a swap: renaming A→"B" and B→"A" in one save
 * resolved to {A→A, B→A}, so every segment of B was relabelled A and the two
 * speakers merged into one. Irreversible: /reidentify-speakers rebuilds from
 * the already-collapsed speakers list, so the split can never be restored.
 *
 * Run: cd server && node --test routes/transcriptions.speakers.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let storedNote = null;
const updates = [];

stub('../stores/transcriptionStore', {
    getTranscription: async () => (storedNote ? { ...storedNote } : null),
    updateTranscription: async (id, userId, u) => { updates.push(u); return true; },
    timeoutStuckTranscriptions: async () => 0,
});
stub('../stores/configStore', { getConfig: async () => null, getSecret: async () => null });
stub('../stores/storageStore', { isAvailable: () => false });
stub('../core/llm/llmClient', {});
stub('../core/meetingNotes/talkNotesSettings', { getOrgSettings: async () => ({}) });
stub('../auth/permissions', { requireAuth: (req, res, next) => next() });
stub('../auth', { resolveUserOrgIds: async () => new Set(['org-1']) });
stub('../stores/userStore', { getUser: async () => ({ groups: [] }), getAllGroups: async () => [] });
stub('../db', { run: async () => ({ rowCount: 1 }) });

const router = require('./transcriptions');

function dispatch({ method = 'PATCH', url, body, user = 'owner-1' }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, query: {}, headers: {}, body: body || {},
            session: { isAuthenticated: true, user: { id: user } },
            get(n) { return this.headers[String(n).toLowerCase()]; },
            setTimeout() {},
        };
        const res = {
            statusCode: 200, headers: {}, body: undefined,
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
            setTimeout() {},
        };
        router(req, res, (err) => reject(err || new Error(`fell through: ${method} ${url}`)));
    });
}

/** Two speakers, one segment each. */
function twoSpeakerNote() {
    return {
        id: 't-1',
        isOwner: true,
        ownerId: 'owner-1',
        organizationId: 'org-1',
        segments: [
            { speaker: 'Ans', start: 0, end: 10, text: 'eerste' },
            { speaker: 'Bert', start: 10, end: 20, text: 'tweede' },
        ],
        speakers: [
            { id: 'Ans', speakingSeconds: 10, segments: 1 },
            { id: 'Bert', speakingSeconds: 10, segments: 1 },
        ],
    };
}

test.beforeEach(() => { storedNote = twoSpeakerNote(); updates.length = 0; });

test('REGRESSION: a rename SWAP keeps two speakers', async () => {
    const res = await dispatch({
        url: '/t-1/speakers',
        body: { renames: { Ans: 'Bert', Bert: 'Ans' }, merges: [] },
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));

    const saved = updates.at(-1);
    assert.strictEqual(saved.speakers.length, 2, `expected 2 speakers, got ${JSON.stringify(saved.speakers.map(s => s.id))}`);
    assert.deepStrictEqual(saved.speakers.map(s => s.id).sort(), ['Ans', 'Bert']);
    // The swap actually happened: the segment that said Ans now says Bert.
    assert.strictEqual(saved.segments[0].speaker, 'Bert');
    assert.strictEqual(saved.segments[1].speaker, 'Ans');
    // And no speaking time was fused into one row.
    assert.ok(saved.speakers.every(s => s.speakingSeconds === 10));
});

test('a plain rename still works', async () => {
    const res = await dispatch({
        url: '/t-1/speakers',
        body: { renames: { Ans: 'Anneke' }, merges: [] },
    });
    assert.strictEqual(res.statusCode, 200);
    const saved = updates.at(-1);
    assert.deepStrictEqual(saved.speakers.map(s => s.id).sort(), ['Anneke', 'Bert']);
});

test('an explicit merge still collapses — that is the user asking for it', async () => {
    const res = await dispatch({
        url: '/t-1/speakers',
        body: { renames: {}, merges: [{ from: ['Ans', 'Bert'], into: 'Ans' }] },
    });
    assert.strictEqual(res.statusCode, 200);
    const saved = updates.at(-1);
    assert.strictEqual(saved.speakers.length, 1);
    assert.strictEqual(saved.speakers[0].id, 'Ans');
    assert.strictEqual(saved.speakers[0].speakingSeconds, 20, 'merged time is summed');
});

test('merge-then-rename resolves to the final name', async () => {
    const res = await dispatch({
        url: '/t-1/speakers',
        body: { renames: { Bert: 'Chris' }, merges: [{ from: ['Ans', 'Bert'], into: 'Bert' }] },
    });
    assert.strictEqual(res.statusCode, 200);
    const saved = updates.at(-1);
    assert.strictEqual(saved.speakers.length, 1);
    assert.strictEqual(saved.speakers[0].id, 'Chris');
});

test('an ACCIDENTAL collision is refused, not silently collapsed', async () => {
    const res = await dispatch({
        url: '/t-1/speakers',
        body: { renames: { Ans: 'Bert' }, merges: [] },   // Bert already exists
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'speaker_name_collision');
    assert.strictEqual(updates.length, 0, 'nothing may be written when the edit is refused');
});

test('a three-way rotation survives intact', async () => {
    storedNote = {
        ...twoSpeakerNote(),
        segments: [
            { speaker: 'A', start: 0, end: 10, text: 'a' },
            { speaker: 'B', start: 10, end: 20, text: 'b' },
            { speaker: 'C', start: 20, end: 30, text: 'c' },
        ],
        speakers: [
            { id: 'A', speakingSeconds: 10, segments: 1 },
            { id: 'B', speakingSeconds: 10, segments: 1 },
            { id: 'C', speakingSeconds: 10, segments: 1 },
        ],
    };
    const res = await dispatch({
        url: '/t-1/speakers',
        body: { renames: { A: 'B', B: 'C', C: 'A' }, merges: [] },
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const saved = updates.at(-1);
    assert.strictEqual(saved.speakers.length, 3);
    assert.deepStrictEqual(saved.segments.map(s => s.speaker), ['B', 'C', 'A']);
});

test('a user-touched row is marked manual so later passes cannot undo it', async () => {
    await dispatch({ url: '/t-1/speakers', body: { renames: { Ans: 'Anneke' }, merges: [] } });
    const saved = updates.at(-1);
    assert.strictEqual(saved.speakers.find(s => s.id === 'Anneke').source, 'manual');
});
