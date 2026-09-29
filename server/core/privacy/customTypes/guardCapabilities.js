// @typecheck
'use strict';
/**
 * Does the installed guard understand `custom_labels`?
 *
 * The guard's API version (`SERVICE_VERSION`) is in its /health answer.
 * `custom_labels` arrived in 2.3.0; an older guard refuses the field with a
 * 422 (extra="forbid"), so it is only sent when the version says it will be
 * understood. /health answers 503 while the model loads and STILL carries the
 * version, so the body is read whatever the status. Remembered for MEMO_MS
 * per endpoint; a 422 on the field clears it (a guard rolled back mid-memo).
 */

const { httpGetJson } = require('../piiDetection/guardClient');

const MEMO_MS = 60_000;
const MIN_CUSTOM_LABELS_VERSION = '2.3.0';

/** @type {Map<string, { at: number, version: string|null }>} */
const _memo = new Map();

/** -1 / 0 / 1; a malformed part counts as 0. */
function compareVersions(a, b) {
    const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d > 0 ? 1 : -1;
    }
    return 0;
}

/**
 * @param {{ url: string|null, apiKey?: string }} endpoint
 * @returns {Promise<string|null>} the guard's API version, or null when unknown
 */
async function guardVersion(endpoint) {
    if (!endpoint?.url) return null;
    const hit = _memo.get(endpoint.url);
    if (hit && Date.now() - hit.at < MEMO_MS) return hit.version;
    let version = null;
    try {
        const { body } = await httpGetJson(`${endpoint.url}/health`, endpoint.apiKey || '');
        version = typeof body?.version === 'string' ? body.version : null;
    } catch (_) {
        version = null;
    }
    _memo.set(endpoint.url, { at: Date.now(), version });
    return version;
}

/** @param {{ url: string|null, apiKey?: string }} endpoint */
async function supportsCustomLabels(endpoint) {
    const v = await guardVersion(endpoint);
    return !!v && compareVersions(v, MIN_CUSTOM_LABELS_VERSION) >= 0;
}

/** Forget what a guard said (after it refused the field, or in tests). */
function clearGuardCapabilities(url = null) {
    if (url) _memo.delete(url); else _memo.clear();
}

module.exports = { guardVersion, supportsCustomLabels, clearGuardCapabilities, compareVersions, MIN_CUSTOM_LABELS_VERSION, MEMO_MS };
