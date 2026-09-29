/**
 * GET /:id/audio — playback must work from the DURABLE copy too.
 *
 * The object-storage branch had no Range support at all and defaulted the MIME
 * type to 'audio/mpeg'. Together that meant: a note whose local file was gone
 * (every note, after a pod restart, since the server Deployment has no volume)
 * could not be seeked, and a browser recording — WebM/Opus — arrived labelled as
 * an MP3, which browsers refuse to decode. iOS Safari will not begin playback of
 * a media resource that does not advertise `Accept-Ranges` at all.
 *
 * Drives the REAL router with require-cache-stubbed collaborators.
 *
 * Run: cd server && node --test routes/transcriptions.audio.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let storedNote = null;
const fx = { storageUp: true, objects: new Map(), uploads: [] };

stub('../stores/transcriptionStore', {
    getTranscription: async () => (storedNote ? { ...storedNote } : null),
    updateTranscription: async () => ({}),
    timeoutStuckTranscriptions: async () => 0,
});
stub('../stores/configStore', { getConfig: async () => null, getSecret: async () => null });
stub('../stores/storageStore', {
    isAvailable: () => fx.storageUp,
    ensureAvailable: async () => fx.storageUp,
    getStatus: () => ({ mode: fx.storageUp ? 's3' : null, configured: true, lastError: null, nextRetryAt: 0 }),
    uploadFile: async (key, buffer) => { fx.uploads.push(key); fx.objects.set(key, buffer); return { key }; },
    headFile: async (key) => {
        if (!fx.objects.has(key)) { const e = new Error('gone'); e.name = 'NoSuchKey'; throw e; }
        // Deliberately vague, like a real object written before content types
        // were set — the route must not trust it over the extension.
        return { contentLength: fx.objects.get(key).length, contentType: 'application/octet-stream' };
    },
    streamFile: async (key, { range = null } = {}) => {
        if (!fx.objects.has(key)) { const e = new Error('gone'); e.name = 'NoSuchKey'; throw e; }
        const buf = fx.objects.get(key);
        const slice = range ? buf.subarray(range.start, range.end + 1) : buf;
        return {
            stream: Readable.from(slice),
            contentType: 'application/octet-stream',
            contentLength: slice.length,
            totalLength: buf.length,
            contentRange: range ? `bytes ${range.start}-${range.end}/${buf.length}` : null,
        };
    },
});
stub('../core/llm/llmClient', {});
stub('../core/meetingNotes/talkNotesSettings', { getOrgSettings: async () => ({}) });
stub('../auth/permissions', { requireAuth: (req, res, next) => next() });
stub('../auth', { resolveUserOrgIds: async () => new Set(['org-1']) });
stub('../stores/userStore', { getUser: async () => ({ groups: [] }), getAllGroups: async () => [] });
stub('../db', { run: async () => ({ rowCount: 1 }) });

const router = require('./transcriptions');

function dispatch({ url, headers = {}, query = {} }) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const req = {
            method: 'GET', url, query, headers,
            session: { isAuthenticated: true, user: { id: 'owner-1' } },
            get(n) { return this.headers[String(n).toLowerCase()]; },
            setTimeout() {},
        };
        const res = {
            statusCode: 200, headers: {}, body: undefined,
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = String(v); },
            getHeader(k) { return this.headers[String(k).toLowerCase()]; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
            // Enough of a writable for stream.pipe(res).
            on() { return this; },
            once() { return this; },
            emit() { return this; },
            write(c) { chunks.push(Buffer.from(c)); return true; },
            destroy() { resolve(this); },
            setTimeout() {},
            get bodyBytes() { return Buffer.concat(chunks); },
        };
        // pipe() ends the destination when the source finishes.
        const realEnd = res.end.bind(res);
        res.end = (c) => { if (c) chunks.push(Buffer.from(c)); res.body = Buffer.concat(chunks); return realEnd(); };
        router(req, res, (err) => reject(err || new Error(`fell through: ${url}`)));
    });
}

const localFile = path.join(os.tmpdir(), `audio-route-test-${process.pid}.webm`);
const LOCAL_BYTES = Buffer.from('0123456789abcdef');
fs.writeFileSync(localFile, LOCAL_BYTES);
test.after(() => { try { fs.unlinkSync(localFile); } catch (_) {} });

const GONE = path.join(os.tmpdir(), 'audio-route-not-here.webm');
const KEY = 'saved-recordings/1753612345678-owner-1.webm';

test.beforeEach(() => {
    fx.storageUp = true;
    fx.objects.clear();
    fx.uploads.length = 0;
    storedNote = {
        id: 't-1', title: 'Weekly sync', isOwner: true, ownerId: 'owner-1',
        organizationId: 'org-1', fileName: 'recording.webm',
        audioPath: localFile, audioStorageKey: KEY,
    };
});

// ── local branch (unchanged behaviour, now via the shared helpers) ───────────

test('local: a byte range yields 206 with the right Content-Range and length', async () => {
    const res = await dispatch({ url: '/t-1/audio', headers: { range: 'bytes=2-5' } });
    assert.strictEqual(res.statusCode, 206);
    assert.strictEqual(res.headers['content-range'], `bytes 2-5/${LOCAL_BYTES.length}`);
    assert.strictEqual(res.headers['content-length'], '4');
    assert.strictEqual(res.headers['accept-ranges'], 'bytes');
});

test('local: a malformed range is 416 with the resource size', async () => {
    const res = await dispatch({ url: '/t-1/audio', headers: { range: 'bytes=abc' } });
    assert.strictEqual(res.statusCode, 416);
    assert.strictEqual(res.headers['content-range'], `bytes */${LOCAL_BYTES.length}`);
});

// ── object-storage branch: the actual fix ───────────────────────────────────

test('durable copy: a byte range yields 206 — seeking works when the pod lost the file', async () => {
    // This is the case that made recordings unplayable after every deploy.
    storedNote.audioPath = GONE;
    fx.objects.set(KEY, LOCAL_BYTES);

    const res = await dispatch({ url: '/t-1/audio', headers: { range: 'bytes=2-5' } });

    assert.strictEqual(res.statusCode, 206);
    assert.strictEqual(res.headers['content-range'], `bytes 2-5/${LOCAL_BYTES.length}`);
    assert.strictEqual(res.headers['content-length'], '4');
    assert.strictEqual(res.headers['accept-ranges'], 'bytes', 'Safari will not play without this');
});

test('durable copy: a WebM recording is never served as audio/mpeg', async () => {
    // The stored object reports application/octet-stream; the extension is the
    // trustworthy signal and must win.
    storedNote.audioPath = GONE;
    fx.objects.set(KEY, LOCAL_BYTES);

    const res = await dispatch({ url: '/t-1/audio' });

    assert.strictEqual(res.headers['content-type'], 'audio/webm');
    assert.notStrictEqual(res.headers['content-type'], 'audio/mpeg');
});

test('durable copy: no range → 200 with Accept-Ranges and a length', async () => {
    storedNote.audioPath = GONE;
    fx.objects.set(KEY, LOCAL_BYTES);

    const res = await dispatch({ url: '/t-1/audio' });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['accept-ranges'], 'bytes');
    assert.strictEqual(res.headers['content-length'], String(LOCAL_BYTES.length));
});

test('durable copy: a malformed range is 416, not a silent full body', async () => {
    storedNote.audioPath = GONE;
    fx.objects.set(KEY, LOCAL_BYTES);

    const res = await dispatch({ url: '/t-1/audio', headers: { range: 'bytes=zzz' } });

    assert.strictEqual(res.statusCode, 416);
    assert.strictEqual(res.headers['content-range'], `bytes */${LOCAL_BYTES.length}`);
});

// ── availability ────────────────────────────────────────────────────────────

test('neither copy available → 404', async () => {
    storedNote.audioPath = GONE;
    storedNote.audioStorageKey = null;
    const res = await dispatch({ url: '/t-1/audio' });
    assert.strictEqual(res.statusCode, 404);
});

test('storage down with no local file → 404 rather than a hang', async () => {
    storedNote.audioPath = GONE;
    fx.storageUp = false;
    const res = await dispatch({ url: '/t-1/audio' });
    assert.strictEqual(res.statusCode, 404);
});

// ── opportunistic repair + rescue download ──────────────────────────────────

test('playing a note that has no durable copy backs it up', async () => {
    // On a multi-replica deploy the pod holding the file is the only one that
    // can fix this, so every play is a repair opportunity.
    storedNote.audioStorageKey = null;

    await dispatch({ url: '/t-1/audio' });
    await new Promise(r => setTimeout(r, 50)); // repair is fire-and-forget

    assert.strictEqual(fx.uploads.length, 1);
    assert.match(fx.uploads[0], /^saved-recordings\//);
});

test('?download=1 offers the file as an attachment', async () => {
    // The rescue hatch for a browser recording with no durable copy: it is the
    // only way the user can ever get those bytes back out.
    const res = await dispatch({ url: '/t-1/audio', query: { download: '1' } });
    assert.match(res.headers['content-disposition'], /^attachment;/);
});

test('without ?download the file plays inline', async () => {
    const res = await dispatch({ url: '/t-1/audio' });
    assert.match(res.headers['content-disposition'], /^inline;/);
});
