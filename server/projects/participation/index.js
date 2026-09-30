// @typecheck
/**
 * The AI that decides by itself when to take part — the public face.
 *
 *   const participation = require('../projects/participation');
 *   participation.registerSurface('comment', adapter);   // once, at module load
 *   participation.onHumanMessage({ surface, containerId, messageId, authorUserId,
 *                                  orgId, limitOrgId, projectId });
 *   participation.cancelContainer(surface, containerId); // mode left `auto`
 *
 * One engine per process (engine.js), built on first use with the real store,
 * the org/user policy (policy.js) and the fast-tier relevance gate
 * (relevanceGate.js); the team chat surface (chatSurface.js) is registered
 * with it. The background job (jobs/aiParticipation.js) drives processWatch.
 *
 * A surface registers when its module loads. The job only claims watches of
 * surfaces this process knows, so a watch never meets a missing adapter.
 */

'use strict';

const { makeParticipationEngine } = require('./engine');
const { defaultPolicy } = require('./policy');

let engine = null;

/** The process's engine, built on first use. */
function defaultEngine() {
    if (engine) return engine;
    const { makeRelevanceGate } = require('./relevanceGate');
    const { makeChatSurface } = require('./chatSurface');
    engine = makeParticipationEngine({
        store: require('../../stores/projectAiParticipationStore'),
        policy: defaultPolicy(),
        gate: makeRelevanceGate(),
    });
    engine.registerSurface('chat', makeChatSurface());
    return engine;
}

module.exports = {
    defaultEngine,
    /** @param {string} name @param {any} adapter */
    registerSurface: (name, adapter) => defaultEngine().registerSurface(name, adapter),
    /** @param {Parameters<ReturnType<typeof makeParticipationEngine>['onHumanMessage']>[0]} p */
    onHumanMessage: (p) => defaultEngine().onHumanMessage(p),
    /** @param {string} surface @param {string} containerId */
    cancelContainer: (surface, containerId) => defaultEngine().cancelContainer(surface, containerId),
    surfaceNames: () => defaultEngine().surfaceNames(),
    policy: () => defaultPolicy(),
};
