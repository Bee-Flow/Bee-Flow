/**
 * ingestTranscription.chooseProvider — the engine a Nextcloud/Talk/auto import
 * runs on obeys the same workspace allow-list as the multipart upload.
 *
 * Run: cd server && node --test core/meetingNotes/ingestTranscription.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { makeSwaps } = require('../../testUtils/swaps');

const config = {};
// The real config store, its readers swapped (the provider policy reads it per call).
const swaps = makeSwaps();
const configStore = require('../../stores/configStore');
swaps.swap(configStore, 'getSecret', async () => 'key');
swaps.swap(configStore, 'getConfig', async (k) => config[k]);
test.after(() => swaps.restore());

const { chooseProvider } = require('./ingestTranscription');

test.beforeEach(() => { for (const k of Object.keys(config)) delete config[k]; });

test('a requested engine outside transcription_providers_allowed is refused with 403 provider_not_allowed', async () => {
    Object.assign(config, { transcription_provider: 'whisperx', transcription_providers_allowed: ['whisperx'] });
    await assert.rejects(() => chooseProvider('azure', null), (err) => err.code === 'provider_not_allowed' && err.status === 403);
});

test('an unknown engine name is refused instead of silently falling back to the default', async () => {
    Object.assign(config, { transcription_provider: 'whisperx' });
    await assert.rejects(() => chooseProvider('azur', null), (err) => err.code === 'provider_not_allowed');
});

test('local is refused when local whisper is switched off', async () => {
    Object.assign(config, { local_whisper_enabled: false });
    await assert.rejects(() => chooseProvider('local', null), (err) => err.code === 'provider_not_allowed');
});

test('an allowed engine is honoured, no request gets the configured default', async () => {
    Object.assign(config, { transcription_provider: 'whisperx', transcription_providers_allowed: ['whisperx', 'scaleway'] });
    assert.strictEqual(await chooseProvider('Scaleway', null), 'scaleway');
    assert.strictEqual(await chooseProvider(undefined, null), 'whisperx');
    // The configured default is always allowed, even when the list leaves it out.
    config.transcription_providers_allowed = ['scaleway'];
    assert.strictEqual(await chooseProvider('whisperx', null), 'whisperx');
});

test('with no allow-list every known engine may be requested', async () => {
    assert.strictEqual(await chooseProvider('azure', null), 'azure');
    assert.strictEqual(await chooseProvider(null, null), 'voxtral');
});

test('a platform transcript runs no engine and needs no allow-list entry', async () => {
    Object.assign(config, { transcription_providers_allowed: ['whisperx'] });
    assert.strictEqual(await chooseProvider(null, { segments: [] }), 'platform_transcript');
});
