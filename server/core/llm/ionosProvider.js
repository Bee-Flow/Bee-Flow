// @typecheck strict
const crypto = require('crypto');
const configStore = require('../../stores/configStore');
const log = require('../../telemetry/log');
const { IONOS_BASE_URL } = require('../providers/ionosModels');

/**
 * Auto-create or update the IONOS AI Model Hub provider when an IONOS API key
 * is set (`ionos_api_key` secret, or IONOS_API_KEY from the environment).
 *
 * Change-aware like Scaleway: it also runs from getProviders(), so a key that
 * boot-init wrote from the environment turns into a provider on the next read
 * without a config write per request. An admin-chosen URL stays.
 */
async function ensureIonosProvider() {
    const ai = await configStore.getConfig('ai') || {};
    const apiKey = (await configStore.getSecret('ionos_api_key')) || process.env.IONOS_API_KEY;

    if (!apiKey) return;

    if (!ai.providers) ai.providers = [];

    const existing = ai.providers.find((/** @type {{ id: string }} */ p) => p.id === 'ionos-default');
    if (existing) {
        const had = Buffer.from(String(existing.apiKey || ''));
        const want = Buffer.from(apiKey);
        if (had.length === want.length && crypto.timingSafeEqual(had, want)) return;
        existing.apiKey = apiKey;
    } else {
        ai.providers.push({
            id: 'ionos-default',
            name: 'IONOS AI Model Hub',
            type: 'ionos',
            url: IONOS_BASE_URL,
            model: '',
            apiKey,
        });
        log.info('[AIAgent] Auto-created default IONOS AI Model Hub provider');
    }
    await configStore.setConfig('ai', ai);
}

module.exports = { ensureIonosProvider };
