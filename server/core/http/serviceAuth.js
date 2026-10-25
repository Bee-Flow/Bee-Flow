// @typecheck strict
/**
 * Service Authentication Helper
 * 
 * Provides headers with X-API-Key for outgoing calls to sidecar services
 * (guard-service, classify-service, a remote search-service, whisperx).
 * 
 * When SERVICES_API_KEY is set in env, all outgoing service calls include it.
 * When not set (e.g. localhost direct access), calls work without it.
 */

const SERVICES_API_KEY = process.env.SERVICES_API_KEY || '';

/**
 * Build headers for service-to-service calls.
 * Automatically includes X-API-Key when configured.
 * 
 * @param {Record<string, string>} [extraHeaders={}] - Additional headers to merge
 * @returns {Record<string, string>} Headers object with Content-Type and optional API key
 */
function getServiceHeaders(extraHeaders = {}) {
    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (SERVICES_API_KEY) {
        headers['X-API-Key'] = SERVICES_API_KEY;
    }
    return headers;
}

module.exports = { getServiceHeaders, SERVICES_API_KEY };
