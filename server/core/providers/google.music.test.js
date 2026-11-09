/**
 * Gemini-API Lyria music: the socket callbacks can fire while the session is
 * still being set up. Run: node --test core/providers/google.music.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const GoogleProvider = require('./google');

/** Fake client; `during(cb)` runs inside setWeightedPrompts, i.e. mid-setup. */
function providerWith({ during, afterPlay, failConfig } = {}) {
    const session = {
        closed: false,
        setWeightedPrompts: async () => { if (during) during(session.cb); },
        setMusicGenerationConfig: async () => { if (failConfig) throw new Error(failConfig); },
        play() { if (afterPlay) setImmediate(() => afterPlay(session.cb)); },
        close() { session.closed = true; },
    };
    const p = new GoogleProvider();
    p._createMusicClient = () => ({
        live: { music: { connect: async ({ callbacks }) => { session.cb = callbacks; return session; } } },
    });
    return { p, session };
}

const opts = { durationSeconds: 0.05 };
const chunk = (s) => ({ serverContent: { audioChunks: [{ data: Buffer.from(s).toString('base64') }] } });

test('chunks become a WAV and the session is closed after the duration', async () => {
    const { p, session } = providerWith({ afterPlay: (cb) => { cb.onmessage(chunk('aaaa')); cb.onmessage(chunk('bbbb')); } });
    const out = await p.generateMusic('k', 'lofi', opts);
    assert.strictEqual(Buffer.from(out.audioBase64, 'base64').length, 44 + 8);
    assert.ok(session.closed);
});

test('a socket close during setup settles the call instead of throwing in the callback', async () => {
    let thrown = null;
    const { p } = providerWith({ during: (cb) => { try { cb.onclose(); } catch (e) { thrown = e; } } });
    const out = await p.generateMusic('k', 'lofi', opts);
    assert.strictEqual(thrown, null);
    assert.strictEqual(out.audioBase64, null);
});

test('a socket error during setup rejects instead of throwing in the callback', async () => {
    let thrown = null;
    const { p } = providerWith({ during: (cb) => { try { cb.onerror('quota'); } catch (e) { thrown = e; } } });
    await assert.rejects(() => p.generateMusic('k', 'lofi', opts), /Music generation failed: quota/);
    assert.strictEqual(thrown, null);
});

test('a setup failure closes the session it opened', async () => {
    const { p, session } = providerWith({ failConfig: 'bad config' });
    await assert.rejects(() => p.generateMusic('k', 'lofi', opts), /Music generation failed: bad config/);
    assert.ok(session.closed);
});
