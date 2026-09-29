/**
 * The /uploads allowlist.
 *
 * Regression: `app.use('/uploads', express.static(...))` served the entire
 * `data/uploads` tree with no authentication, ahead of every router. Meeting
 * recordings live in `saved-recordings/`, so any note's audio could be fetched
 * by filename with no session — and the filename did not have to be guessed,
 * because the note payload carried the server-side path.
 *
 * These tests pin BOTH directions: the private subtrees stay closed, and the
 * genuinely public images (avatars, org logos, agent avatars) keep working —
 * the fix is worthless if it 404s every profile picture.
 *
 * Run: cd server && node --test middleware/publicUploads.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { isPublicUploadPath, publicUploadsOnly } = require('./publicUploads');

// ── The thing this exists to stop ────────────────────────────────────

test('meeting recordings are NOT public', () => {
    for (const p of [
        '/saved-recordings/1753612345678-tomsmit.webm',
        'saved-recordings/1753612345678-tomsmit.webm',
        '/saved-recordings/anything.flac',
    ]) {
        assert.strictEqual(isPublicUploadPath(p), false, `${p} must not be served anonymously`);
    }
});

test('the upload staging area is NOT public', () => {
    assert.strictEqual(isPublicUploadPath('/audio/abc123'), false);
});

test('a NEW subdirectory is private by default — allowlist, not denylist', () => {
    // The point of the allowlist: someone adding data/uploads/<newthing>/ must
    // not silently publish it.
    assert.strictEqual(isPublicUploadPath('/transcripts/secret.txt'), false);
    assert.strictEqual(isPublicUploadPath('/exports/2026/q3.csv'), false);
});

test('traversal cannot escape, encoded or not', () => {
    for (const p of [
        '/../../.env',
        '/agents/../saved-recordings/x.webm',
        '/%2e%2e/%2e%2e/.env',
        '/agents%2f..%2fsaved-recordings%2fx.webm',
        '\\saved-recordings\\x.webm',
    ]) {
        assert.strictEqual(isPublicUploadPath(p), false, `${p} must be refused`);
    }
});

test('a malformed percent-encoding is refused rather than thrown on', () => {
    assert.strictEqual(isPublicUploadPath('/%E0%A4%A'), false);
});

// ── The thing this must not break ────────────────────────────────────

test('flat files stay public — admin-uploaded avatars and org logos', () => {
    // auth/adminRoutes.js writes these directly into data/uploads and stores
    // the path as `/uploads/<filename>`.
    assert.strictEqual(isPublicUploadPath('/avatar-1753612345678.png'), true);
    assert.strictEqual(isPublicUploadPath('/logo-abc.svg'), true);
});

test('the agents/ subtree stays public', () => {
    // agent-hub/src/utils/agentAvatar.js builds `/uploads/agents/<id>.png`.
    assert.strictEqual(isPublicUploadPath('/agents/agent-42.png'), true);
});

test('an empty path is not public', () => {
    assert.strictEqual(isPublicUploadPath('/'), false);
    assert.strictEqual(isPublicUploadPath(''), false);
    assert.strictEqual(isPublicUploadPath(null), false);
});

// ── Middleware wiring ────────────────────────────────────────────────

test('the middleware 404s a private path and passes a public one', () => {
    const calls = [];
    const res = { sendStatus: (c) => { calls.push(c); return res; } };

    let nexted = 0;
    publicUploadsOnly({ path: '/saved-recordings/x.webm' }, res, () => nexted++);
    assert.deepStrictEqual(calls, [404]);
    assert.strictEqual(nexted, 0, 'a private path must never reach express.static');

    publicUploadsOnly({ path: '/agents/a.png' }, res, () => nexted++);
    assert.strictEqual(nexted, 1);
    assert.deepStrictEqual(calls, [404], 'no extra status was sent for the public path');
});
