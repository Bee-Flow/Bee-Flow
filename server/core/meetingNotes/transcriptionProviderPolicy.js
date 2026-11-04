// @typecheck strict
/**
 * Which transcription engines a request may pick, per workspace.
 *
 * The engine decides which third party receives the meeting audio, so a
 * per-request choice is only honoured when the admin allows it. Every ingest
 * path asks the same question here: the multipart upload, the Nextcloud/Talk
 * import and the auto-imports (which pass no choice and so get the default).
 *
 * Admins set `transcription_providers_allowed` (an array). Unset means "any
 * known engine", the historical behaviour; narrowing it is opt-in so an
 * upgrade never breaks the "Switch engine & retry" button. The configured
 * default is always allowed, and `local` additionally requires
 * `local_whisper_enabled`.
 */

'use strict';

const configStore = require('../../stores/configStore');

// Every engine the pipeline knows how to drive.
const KNOWN_PROVIDERS = ['voxtral', 'whisperx', 'scaleway', 'azure', 'whisper_azure', 'pyannote', 'local'];

/** @returns {Promise<boolean>} */
async function isLocalWhisperEnabled() {
    return (await configStore.getConfig('local_whisper_enabled')) !== false;
}

/** @returns {Promise<string>} the admin's default engine */
async function configuredProvider() {
    return (await configStore.getConfig('transcription_provider')) || 'voxtral';
}

/**
 * @param {boolean} [localEnabled] read from config when omitted
 * @returns {Promise<string[]>}
 */
async function resolveAllowedProviders(localEnabled) {
    const local = localEnabled === undefined ? await isLocalWhisperEnabled() : localEnabled;
    const configured = await configuredProvider();
    const raw = await configStore.getConfig('transcription_providers_allowed');
    let allowed = Array.isArray(raw) && raw.length
        ? raw.map(p => String(p).trim().toLowerCase()).filter(p => KNOWN_PROVIDERS.includes(p))
        : [...KNOWN_PROVIDERS];
    if (!allowed.includes(configured)) allowed.push(configured);
    if (!local) allowed = allowed.filter(p => p !== 'local');
    return allowed;
}

/**
 * The engine a request ends up with. No request: the configured default. A
 * named engine the workspace does not allow (or does not know) is refused
 * rather than silently replaced, so a typo never looks honoured and an
 * excluded third party is never reached.
 * @param {string | null | undefined} requested
 * @returns {Promise<{ provider: string, refusal?: { code: 'provider_not_allowed', allowed: string[] } }>}
 */
async function resolveRequestedProvider(requested) {
    const provider = await configuredProvider();
    const req = String(requested || '').trim().toLowerCase();
    if (!req) return { provider };
    const allowed = await resolveAllowedProviders();
    if (!allowed.includes(req)) return { provider, refusal: { code: 'provider_not_allowed', allowed } };
    return { provider: req };
}

module.exports = { KNOWN_PROVIDERS, resolveAllowedProviders, resolveRequestedProvider };
