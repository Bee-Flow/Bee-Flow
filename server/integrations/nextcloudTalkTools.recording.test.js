/**
 * Talk recording capability detection.
 *
 * The bug this pins down: `recording-v1` sits in spreed's STATIC
 * `Capabilities::FEATURES` array, so every Talk >= 26 advertises it whether or
 * not an admin ever configured a recording backend. Gating on it alone always
 * said "recording available" — the auto-record poller then hammered the start
 * endpoint for 400 `config` on every tick, and the Upcoming view promised
 * "will record" for meetings that could never be recorded.
 *
 * The real gate is `config.call.recording` (upstream
 * `Config::isRecordingEnabled()`: an HPB, `call_recording=yes`, and a recording
 * secret). `config.attachments.folder` is read at the same time because it
 * gives us the user's real recordings root instead of a guessed default.
 *
 * Run: cd server && node --test integrations/nextcloudTalkTools.recording.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const fx = { capabilities: null, status: 200, fetches: 0, uid: 'alice' };

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let baseUrlSeq = 0;
stub('./nextcloudClient', {
    resolveAuth: async () => ({
        // A fresh baseUrl per call defeats the 10-minute capability cache so
        // each test sees its own fixture.
        baseUrl: `https://cloud-${++baseUrlSeq}.example.test`,
        uid: fx.uid,
        authError: 'nc auth failed',
        fetch: async () => {
            fx.fetches++;
            return {
                ok: fx.status >= 200 && fx.status < 300,
                status: fx.status,
                text: async () => JSON.stringify({ ocs: { data: { capabilities: { spreed: fx.capabilities || {} } } } }),
            };
        },
    }),
});

const { getTalkRecordingCapability } = require('./nextcloudTalkTools');

const FEATURES = ['recording-v1', 'chat-v2', 'conversation-v4'];

test('a configured recording backend is usable', async () => {
    fx.status = 200;
    fx.capabilities = {
        features: FEATURES,
        config: { call: { recording: true }, attachments: { folder: '/Talk' } },
    };
    const cap = await getTalkRecordingCapability({}, 'u1');
    assert.strictEqual(cap.recordingEnabled, true);
    assert.strictEqual(cap.apiAvailable, true);
    assert.strictEqual(cap.backendConfigured, true);
});

test('recording-v1 alone does NOT mean the instance can record', async () => {
    fx.status = 200;
    fx.capabilities = {
        // Exactly what a stock Talk with no HPB / no recording server returns.
        features: FEATURES,
        config: { call: { recording: false }, attachments: { folder: '/Talk' } },
    };
    const cap = await getTalkRecordingCapability({}, 'u1');
    assert.strictEqual(cap.apiAvailable, true, 'the API exists');
    assert.strictEqual(cap.backendConfigured, false, 'but no backend is configured');
    assert.strictEqual(cap.recordingEnabled, false, 'so recording is not available');
});

test('the recordings folder is the attachment folder plus /Recording', async () => {
    fx.status = 200;
    fx.capabilities = {
        features: FEATURES,
        config: { call: { recording: true }, attachments: { folder: '/Talk' } },
    };
    const cap = await getTalkRecordingCapability({}, 'u1');
    assert.strictEqual(cap.attachmentFolder, '/Talk');
    assert.strictEqual(cap.recordingFolder, '/Talk/Recording');
});

test('a custom attachment folder carries through', async () => {
    fx.status = 200;
    fx.capabilities = {
        features: FEATURES,
        config: { call: { recording: true }, attachments: { folder: '/Meetings/Talk' } },
    };
    const cap = await getTalkRecordingCapability({}, 'u1');
    assert.strictEqual(cap.recordingFolder, '/Meetings/Talk/Recording');
});

test('an attachment folder at the Files root still resolves', async () => {
    fx.status = 200;
    fx.capabilities = {
        features: FEATURES,
        config: { call: { recording: true }, attachments: { folder: '/' } },
    };
    const cap = await getTalkRecordingCapability({}, 'u1');
    assert.strictEqual(cap.recordingFolder, '/Recording');
});

test('Talk not installed / no capabilities → nothing claimed', async () => {
    fx.status = 200;
    fx.capabilities = {};
    const cap = await getTalkRecordingCapability({}, 'u1');
    assert.deepStrictEqual(
        { recordingEnabled: cap.recordingEnabled, apiAvailable: cap.apiAvailable, recordingFolder: cap.recordingFolder },
        { recordingEnabled: false, apiAvailable: false, recordingFolder: null },
    );
});

test('an unreachable capabilities endpoint fails closed', async () => {
    fx.status = 503;
    fx.capabilities = null;
    const cap = await getTalkRecordingCapability({}, 'u1');
    assert.strictEqual(cap.recordingEnabled, false);
    assert.strictEqual(cap.recordingFolder, null);
    assert.deepStrictEqual(cap.features, []);
});

test('the cache is keyed per user, not just per instance', async () => {
    // config.attachments.folder is a USER preference — caching it per baseUrl
    // handed one user another user's recordings folder.
    fx.status = 200;
    const before = fx.fetches;
    const fixedBase = 'https://shared.example.test';
    const client = require('./nextcloudClient');
    const original = client.resolveAuth;
    client.resolveAuth = async (_s, userId) => ({
        baseUrl: fixedBase,
        uid: userId === 'u1' ? 'alice' : 'bob',
        authError: 'nc auth failed',
        fetch: async () => {
            fx.fetches++;
            const folder = fx.fetches % 2 === 1 ? '/Talk' : '/Personal/Talk';
            return {
                ok: true, status: 200,
                text: async () => JSON.stringify({ ocs: { data: { capabilities: { spreed: {
                    features: FEATURES, config: { call: { recording: true }, attachments: { folder } },
                } } } } }),
            };
        },
    });
    try {
        const a = await getTalkRecordingCapability({}, 'u1');
        const b = await getTalkRecordingCapability({}, 'u2');
        assert.strictEqual(fx.fetches - before, 2, 'both users were asked');
        assert.notStrictEqual(a.recordingFolder, b.recordingFolder);
        const aAgain = await getTalkRecordingCapability({}, 'u1');
        assert.strictEqual(fx.fetches - before, 2, 'the second read for u1 came from cache');
        assert.strictEqual(aAgain.recordingFolder, a.recordingFolder);
    } finally {
        client.resolveAuth = original;
    }
});
