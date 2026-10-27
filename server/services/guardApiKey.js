// @typecheck strict
'use strict';
/**
 * The API key of the guard container the dashboard installs.
 *
 * The guard fails closed: without SERVICES_API_KEY it refuses to start. So an
 * install that was given no key (the admin left the field empty) must not start
 * it with an empty one. It takes the key a previous install stored, else makes a
 * new one. The server reads the stored key back for every call it makes to the
 * guard (core/privacy/piiDetection/guardEndpoint.js).
 */

const crypto = require('crypto');

/**
 * @param {string | undefined} requested   the key the admin typed, if any
 * @param {() => Promise<string | null | undefined>} getStored   reads pii_guard_api_key
 * @param {() => string} [generate]
 * @returns {Promise<string>} never empty
 */
async function resolveGuardApiKey(requested, getStored, generate = () => crypto.randomBytes(24).toString('hex')) {
    if (typeof requested === 'string' && requested.trim()) return requested.trim();
    const stored = await getStored();
    if (typeof stored === 'string' && stored.trim()) return stored.trim();
    return generate();
}

module.exports = { resolveGuardApiKey };
