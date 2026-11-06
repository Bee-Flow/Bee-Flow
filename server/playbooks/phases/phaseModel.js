// @typecheck strict
/**
 * What a playbook phase needs from the model layer, in one place: the lazy
 * model dependencies a phase is constructed with (resolveModel, chatForcedTool),
 * the production default that also meters the call, and the one usage row the
 * phase writes for its model call. The design and compliance phases carried a
 * copy each; a test's deps without `logUsage` log nothing.
 */

'use strict';

/** @typedef {import('../../core/llm/surfaceUsage').SurfaceCall} SurfaceCall */
/** @typedef {{ logUsage?: (call: SurfaceCall) => void }} MeteredDeps */

/**
 * One usage row for the phase's model call (source `playbook`,
 * core/llm/surfaceUsage.js): the person, their organisation, the model and
 * the tokens the provider reported.
 * @param {MeteredDeps} deps
 * @param {{ userId: string | null, userOrgId: string | null, modelId: string, answer: unknown, startedAt: number }} call
 */
function meterPhase(deps, { userId, userOrgId, modelId, answer, startedAt }) {
    if (typeof deps.logUsage !== 'function') return;
    const usage = answer && typeof answer === 'object' ? /** @type {{ usage?: unknown }} */ (answer).usage : null;
    deps.logUsage({ source: 'playbook', userId, orgId: userOrgId, model: modelId, usage, startedAt });
}

/**
 * Runs one model call and writes its usage row (meterPhase): for the playbook
 * steps outside the phases (compose, resolve, access plan) that call the
 * model through the same deps.
 * @template R
 * @param {MeteredDeps} deps
 * @param {{ userId: string | null, userOrgId: string | null, modelId: string }} who
 * @param {() => Promise<R>} call
 * @returns {Promise<R>}
 */
async function meteredCall(deps, who, call) {
    const startedAt = Date.now();
    const answer = await call();
    meterPhase(deps, { ...who, answer, startedAt });
    return answer;
}

function modelDeps() {
    return {
        /** @param {{ tier?: string, userOrgId?: string | null, userId?: string | null }} opts */
        resolveModel: (opts) => require('../../core/llm/modelResolver').resolveModelForTierName(opts.tier || 'fast', opts),
        /** @param {unknown[]} args */
        chatForcedTool: (...args) => /** @type {(...args: unknown[]) => Promise<{ structured?: unknown, usage?: unknown }>} */ (require('../../core/llm/llmClient').chatForcedTool)(...args),
    };
}

/** @returns {ReturnType<typeof modelDeps> & MeteredDeps} */
function defaultDeps() {
    return {
        ...modelDeps(),
        logUsage: (call) => require('../../core/llm/surfaceUsage').logSurfaceUsage(call),
    };
}

module.exports = { meterPhase, meteredCall, modelDeps, defaultDeps };
