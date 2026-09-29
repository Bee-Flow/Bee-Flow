/**
 * What a note payload is allowed to contain when it leaves the server.
 *
 * Two regressions pinned here, both of which shipped data to people who passed
 * the READ acl but should not have had it:
 *
 *  - `audioPath` / `audioStorageKey`: server-side file locations. Combined with
 *    the unauthenticated /uploads static mount this made the raw recording
 *    fetchable with no session at all, forever, bypassing both the ACL on
 *    GET /:id/audio and the deletion path. Nothing in the client reads them.
 *  - `voiceprintMatches`: biometric diagnostics — colleagues' names, internal
 *    user ids, raw acoustic confidence, including near-misses for people who
 *    were probably not in the meeting. routes/voiceprints.js deliberately
 *    withholds the enrolled-user list from non-admins; shipping it inside every
 *    shared note contradicted that. Owner only.
 *
 * Drives the REAL router with require-cache-stubbed collaborators and the same
 * dispatch harness as transcriptions.reprocess.test.js — no HTTP, no DB.
 *
 * Run: cd server && node --test routes/transcriptions.payload.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let storedNote = null;

stub('../stores/transcriptionStore', {
    getTranscription: async () => (storedNote ? { ...storedNote } : null),
    updateTranscription: async () => ({}),
    timeoutStuckTranscriptions: async () => 0,
});
stub('../stores/configStore', { getConfig: async () => null, getSecret: async () => null });
stub('../stores/storageStore', { isAvailable: () => false, streamFile: async () => { throw new Error('no'); } });
stub('../core/llm/llmClient', {});
stub('../core/meetingNotes/talkNotesSettings', { getOrgSettings: async () => ({}) });
stub('../auth/permissions', { requireAuth: (req, res, next) => next() });
stub('../auth', { resolveUserOrgIds: async () => new Set(['org-1']) });
stub('../stores/userStore', { getUser: async () => ({ groups: [] }), getAllGroups: async () => [] });
stub('../db', { run: async () => ({ rowCount: 1 }) });

const router = require('./transcriptions');

function dispatch({ method = 'GET', url, user = 'owner-1' }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, query: {}, headers: {},
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

const MATCHES = [{ speakerId: 'SPEAKER_00', name: 'Tom Smit', userId: 'tomsmit', confidence: 90, decision: 'matched' }];

function note(over = {}) {
    return {
        id: 't-1',
        title: 'Weekly sync',
        transcript: '[Tom Smit] 00:00 - 00:05: hallo',
        segments: [{ speaker: 'Tom Smit', start: 0, end: 5, text: 'hallo' }],
        speakers: [{ id: 'Tom Smit', speakingSeconds: 5 }],
        organizationId: 'org-1',
        audioPath: '/app/server/data/uploads/saved-recordings/1753612345678-owner-1.webm',
        audioStorageKey: 'saved-recordings/1753612345678-owner-1.webm',
        voiceprintMatches: MATCHES,
        isOwner: true,
        ownerId: 'owner-1',
        ...over,
    };
}

test.beforeEach(() => { storedNote = note(); });

test('the server-side audio path NEVER leaves the server', async () => {
    const res = await dispatch({ url: '/t-1' });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(!('audioPath' in res.body), 'audioPath must be stripped');
    assert.ok(!('audioStorageKey' in res.body), 'audioStorageKey must be stripped');
    assert.ok(!JSON.stringify(res.body).includes('saved-recordings'),
        'no server-side location may appear anywhere in the payload');
});

test('the owner still gets the voiceprint diagnostics', async () => {
    const res = await dispatch({ url: '/t-1', user: 'owner-1' });
    assert.deepStrictEqual(res.body.voiceprintMatches, MATCHES);
});

test('a NON-owner gets no biometric diagnostics at all', async () => {
    storedNote = note({ isOwner: false });
    const res = await dispatch({ url: '/t-1', user: 'colleague-2' });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.transcript, 'the note itself is still readable — this is not an ACL change');
    assert.ok(!('voiceprintMatches' in res.body), 'colleagues must not receive voiceprint match detail');
    const json = JSON.stringify(res.body);
    assert.ok(!json.includes('tomsmit'), 'no internal user id may leak');
    assert.ok(!json.includes('"confidence"'), 'no acoustic confidence may leak');
});

test('the Insights display policy still rides along (unchanged behaviour)', async () => {
    const res = await dispatch({ url: '/t-1' });
    assert.strictEqual(res.body.perPersonInsights, true);
});

test('a note with no voiceprint data is unaffected', async () => {
    storedNote = note({ voiceprintMatches: [] });
    const res = await dispatch({ url: '/t-1' });
    assert.deepStrictEqual(res.body.voiceprintMatches, []);
});

// ── derived audio state (replaces the stripped locations) ───────────────────
//
// The client has to distinguish "the audio service is having a minute" from
// "this recording is gone", and for a browser recording it must never be told
// to upload the original again — there is no original.

test('the payload reports playability without leaking any location', async () => {
    storedNote = note({
        audioPath: path.join(os.tmpdir(), 'definitely-not-here.webm'),
        audioStorageKey: null,
        source: 'recording',
    });

    const res = await dispatch({ url: '/t-1' });

    assert.ok(!('audioPath' in res.body), 'still stripped');
    assert.ok(!('audioStorageKey' in res.body), 'still stripped');
    assert.strictEqual(res.body.audio.available, false);
    assert.strictEqual(res.body.audio.durable, false);
    assert.strictEqual(res.body.audio.recoverable, false, 'nothing to recover from');
    assert.strictEqual(res.body.audio.capture, 'recording');
    assert.ok(!JSON.stringify(res.body.audio).includes(os.tmpdir()), 'no path fragments');
});

test('a durable copy with the local file gone reads as recoverable, not lost', async () => {
    storedNote = note({
        audioPath: path.join(os.tmpdir(), 'definitely-not-here.webm'),
        audioStorageKey: 'saved-recordings/x.webm',
    });

    const res = await dispatch({ url: '/t-1' });

    assert.strictEqual(res.body.audio.available, true, 'the durable copy counts as available');
    assert.strictEqual(res.body.audio.durable, true);
    assert.strictEqual(res.body.audio.recoverable, true);
    assert.strictEqual(res.body.audio.localOnly, false);
});

test('a note with only a local copy is flagged localOnly (backup still pending)', async () => {
    storedNote = note({ audioPath: __filename, audioStorageKey: null });

    const res = await dispatch({ url: '/t-1' });

    assert.strictEqual(res.body.audio.available, true);
    assert.strictEqual(res.body.audio.durable, false);
    assert.strictEqual(res.body.audio.localOnly, true, 'one pod restart from gone');
});
