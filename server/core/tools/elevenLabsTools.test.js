/**
 * ElevenLabs tools: a zero prompt influence stays zero, and a usage row that
 * cannot be written never becomes an unhandled rejection.
 *
 * Run: cd server && node --test core/tools/elevenLabsTools.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const configStore = require('../../stores/configStore');
const usageStore = require('../../stores/usageStore');
const storageStore = require('../../stores/storageStore');
const elevenlabsProvider = require('../providers/elevenlabs');
const { runElevenLabsTool } = require('./elevenLabsTools');

async function* audio() { yield Buffer.from('mp3-bytes'); }

test('a prompt influence of 0 reaches the API as 0, not as the 0.5 default', async (t) => {
    const seen = [];
    t.mock.method(elevenlabsProvider, 'createClient', () => ({
        textToSoundEffects: { convert: async (req) => { seen.push(req); return audio(); } },
    }));
    await elevenlabsProvider.generateSoundEffect('k', 'rain', { duration_seconds: 2, prompt_influence: 0 });
    await elevenlabsProvider.generateSoundEffect('k', 'rain', { duration_seconds: 2 });
    await elevenlabsProvider.generateSoundEffect('k', 'rain', { duration_seconds: 2, prompt_influence: 0.9 });
    assert.deepStrictEqual(seen.map((r) => r.promptInfluence), [0, 0.5, 0.9]);
});

test('a failing usage row does not surface as an unhandled rejection', async (t) => {
    t.mock.method(configStore, 'getSecret', async () => 'key');
    t.mock.method(elevenlabsProvider, 'generateSoundEffect', async () => ({ audioBase64: Buffer.from('x').toString('base64'), mimeType: 'audio/mpeg' }));
    t.mock.method(storageStore, 'isAvailable', () => true);
    t.mock.method(storageStore, 'buildKey', () => 'users/u/audio/x.mp3');
    t.mock.method(storageStore, 'uploadFile', async () => {});
    t.mock.method(storageStore, 'buildProxyUrl', () => '/api/storage/x');
    t.mock.method(usageStore, 'logUsage', async () => { throw new Error('db down'); });

    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
        const out = await runElevenLabsTool({ toolName: 'elevenlabs_sfx', toolArgs: { prompt: 'rain' }, send: () => {}, req: null, nanoBananaSettings: null });
        assert.strictEqual(out.success, true);
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        assert.deepStrictEqual(unhandled, []);
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
});
