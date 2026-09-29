// @typecheck
'use strict';
/**
 * The test bench's line to the model: raw candidates for `ai` types, for
 * tuning (POST /pii/probe on the guard). Throws HttpError 503
 * `guard_unavailable` whenever that answer cannot be had: no guard, a guard
 * too old to probe, a guard still loading its model, or any transport error.
 * Error messages carry the status and error types only (guardClient).
 */

const { HttpError } = require('../../http/errors');
const { getGuardEndpoint } = require('../piiDetection/guardEndpoint');
const { probeViaGuard } = require('../piiDetection/guardClient');
const guardCapabilities = require('./guardCapabilities');

const unavailable = (message) => new HttpError(503, 'guard_unavailable', message);

/**
 * @param {string[]} texts  1..8 texts of at most 4000 characters
 * @param {Record<string, string>} labelSet  cdt id → prompt (1..6)
 * @param {{ priority?: 'interactive'|'bulk', deps?: { getGuardEndpoint?: Function, supportsCustomLabels?: Function, probeViaGuard?: Function } }} [opts]
 * @returns {Promise<{ candidates: Array<{ text_idx: number, label: string, start: number, end: number, score: number }> }>}
 */
async function probeGuard(texts, labelSet, opts = {}) {
    const deps = opts.deps || {};
    const endpointOf = deps.getGuardEndpoint || getGuardEndpoint;
    const supports = deps.supportsCustomLabels || guardCapabilities.supportsCustomLabels;
    const post = deps.probeViaGuard || probeViaGuard;
    const priority = opts.priority === 'interactive' ? 'interactive' : 'bulk';

    const endpoint = await endpointOf();
    if (!endpoint?.url) throw unavailable('The PII Guard service is not installed, so the AI cannot be tested.');
    if (!(await supports(endpoint))) {
        throw unavailable('The installed PII Guard service is too old to test AI recognition. Update it and try again.');
    }
    let body;
    try {
        body = await post(endpoint, texts, labelSet, priority);
    } catch (err) {
        throw unavailable(err?.status === 503
            ? 'The PII Guard service is still starting. Try again in a moment.'
            : 'The PII Guard service could not be reached. Try again in a moment.');
    }
    if (body && body.model_ready === false) throw unavailable('The PII Guard service is still starting. Try again in a moment.');
    const candidates = Array.isArray(body?.candidates) ? body.candidates.filter(c => c
        && Number.isInteger(c.text_idx) && typeof c.label === 'string'
        && Number.isInteger(c.start) && Number.isInteger(c.end) && c.end > c.start
        && typeof c.score === 'number') : [];
    return { candidates };
}

module.exports = { probeGuard };
