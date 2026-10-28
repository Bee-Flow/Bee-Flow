// @typecheck
/**
 * Guarded egress for step types that are not catalog tools.
 *
 * http_request, the code step's two bridges and notification delivery all push
 * runState content out of the platform, and all three would do it with no
 * privacy scan and no ledger row — three ways to send an org's personal data
 * to an arbitrary address invisibly. They go through the same order as an
 * integration_action: guard → decide what leaves → dispatch → log.
 *
 * Shared by execNotification.js, execHttpRequest.js and execCode.js.
 */

'use strict';

const safety = require('./safety');

const PRIVATE_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?|.*\.local|.*\.internal)$/i;

/**
 * @param {string} hostname
 */
function isPrivateHost(hostname) {
    return PRIVATE_HOST_RE.test(String(hostname || ''));
}

/**
 * Guard an outbound payload and decide what actually leaves.
 * Throws GuardrailBlockError on a block (after writing a `blocked` ledger row).
 *
 * @returns {Promise<{ payload, policy, auditBase, guarded, destination }>}
 * @param {string} mode
 */
async function guardOutbound(step, ctx, mode, /** @type {{ toolName: string, payload: unknown, destination?: string, integMeta?: Record<string, unknown> | null }} */ { toolName, payload, destination = 'external', integMeta = null }) {
    const policy = await safety.resolveAutomationPolicy(ctx);
    const auditBase = safety.buildAuditBase(ctx, step);
    let guarded;
    try {
        guarded = await safety.guardToolInput(payload, policy, auditBase, mode, ctx);
    } catch (err) {
        if (err && err.guardrailBlocked) {
            await safety.logEgress({
                toolName, toolArgs: {}, blocked: true, error: err,
                policy, auditBase, mode, integMeta, durationMs: 0,
            });
        }
        throw err;
    }
    return {
        payload: safety.prepareForEgress(guarded.value, policy, ctx, { destination }),
        policy, auditBase, guarded, destination,
    };
}

module.exports = { isPrivateHost, guardOutbound };
