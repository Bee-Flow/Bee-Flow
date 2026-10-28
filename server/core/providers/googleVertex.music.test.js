/**
 * Vertex Lyria music: audio arrives through the live-music callbacks (the SDK
 * has no session.receive()). Run: node --test core/providers/googleVertex.music.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const GoogleVertexProvider = require('./googleVertex');

/** Fake client whose connect() hands the callbacks to `drive`. */
function providerWith(drive) {
    const session = {
        closed: false,
        setWeightedPrompts: async () => {},
        setMusicGenerationConfig: async () => {},
        play() { setImmediate(() => drive(session.cb, session)); },
        close() { session.closed = true; },
    };
    const p = new GoogleVertexProvider();
    p._createMusicClient = () => ({
        live: { music: { connect: async ({ callbacks }) => { session.cb = callbacks; return session; } } },
    });
    return { p, session };
}

const opts = { project: 'p', durationSeconds: 0.05 };
const chunk = (s) => ({ serverContent: { audioChunks: [{ data: Buffer.from(s).toString('base64') }] } });

test('chunks from onmessage become a WAV, session closed after the duration', async () => {
    const { p, session } = providerWith((cb) => { cb.onmessage(chunk('aaaa')); cb.onmessage(chunk('bbbb')); });
    const out = await p.generateMusic('k', 'lofi', opts);
    assert.strictEqual(out.mimeType, 'audio/wav');
    const wav = Buffer.from(out.audioBase64, 'base64');
    assert.strictEqual(wav.length, 44 + 8);
    assert.ok(session.closed);
});

test('an error before any audio rejects', async () => {
    const { p, session } = providerWith((cb) => cb.onerror({ message: 'quota' }));
    await assert.rejects(() => p.generateMusic('k', 'lofi', opts), /Music generation failed: quota/);
    assert.ok(session.closed);
});

test('an error after some audio keeps the partial audio', async () => {
    const { p } = providerWith((cb) => { cb.onmessage(chunk('aaaa')); cb.onerror({ message: 'drop' }); });
    const out = await p.generateMusic('k', 'lofi', opts);
    assert.ok(out.audioBase64);
});

test('close without audio gives a null result', async () => {
    const { p } = providerWith((cb) => cb.onclose());
    const out = await p.generateMusic('k', 'lofi', opts);
    assert.strictEqual(out.audioBase64, null);
});
