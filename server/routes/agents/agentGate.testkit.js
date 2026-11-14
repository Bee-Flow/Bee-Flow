// @typecheck
/**
 * Stand-in agent gates for the route tests that mock `./crud`: the REAL gates
 * (auth/agentAccess.mts makeAgentGates: the 404 and 403 answers, what they
 * leave on `req.agentAccess`) over the test's own verdicts.
 *
 *   './crud': fakeAgentGates({
 *       agentStore: MOCKS['../../stores/agentStore'],
 *       canRead: () => fx.canRead, canModify: () => fx.canModify,
 *   }),
 *
 * The verdicts are read per call, so a test flips them between requests. The
 * returned object also carries `canReadAgent` and `canModifyAgent` on the same
 * verdicts, for the handlers that still ask by hand (a query parameter, a list).
 *
 * Not a test file: required by *.test.js next to it. No test cases here.
 */

'use strict';

const { makeAgentGates } = require('../../auth/agentAccess.mts');

/** @typedef {import('../../auth/agentAccess.mts').AgentRow} AgentRow */
/** @typedef {import('../../auth/agentAccess.mts').AgentRequest} AgentRequest */

/**
 * @param {{
 *   agentStore: { getAgent: (id: string) => Promise<any>, getAgentViews?: (id: string) => Promise<any> },
 *   canRead?: (agent: AgentRow, req: AgentRequest) => boolean | Promise<boolean>,
 *   canModify?: (agent: AgentRow, req: AgentRequest) => boolean | Promise<boolean>,
 *   canManage?: (agent: AgentRow, req: AgentRequest) => boolean | Promise<boolean>,
 *   canChat?: (agent: AgentRow, userId: string, req: AgentRequest) => boolean | Promise<boolean>,
 *   userId?: (req: AgentRequest) => string,
 * }} p  `canManage` defaults to `canModify`; `userId` to the session user (or a `guest_` id)
 */
function fakeAgentGates({ agentStore, canRead = () => true, canModify = () => true, canManage, canChat = () => true, userId }) {
    const effectiveUserId = userId || ((/** @type {AgentRequest} */ req) => req.session?.user?.id || 'guest_test');
    const manage = canManage || canModify;
    const gates = makeAgentGates({
        getAgent: (id) => agentStore.getAgent(id),
        getAgentViews: agentStore.getAgentViews
            ? (id) => /** @type {NonNullable<typeof agentStore.getAgentViews>} */ (agentStore.getAgentViews)(id)
            : async (id) => { const a = await agentStore.getAgent(id); return a ? { draft: a, runtime: a } : null; },
        getEffectiveUserId: effectiveUserId,
    }, {
        gradeOf: async (req, agent) => {
            const [r, m] = await Promise.all([canRead(agent, req), canModify(agent, req)]);
            if (!r && !m) return null;
            if (!m) return 'read';
            return (await manage(agent, req)) ? 'manage' : 'edit';
        },
        canChatAgent: (agent, uid, req) => Promise.resolve(canChat(agent, uid, req)),
    });
    return {
        ...gates,
        canReadAgent: async (/** @type {AgentRow} */ agent, /** @type {string} */ _userId, /** @type {AgentRequest} */ req) => canRead(agent, req),
        canModifyAgent: async (/** @type {AgentRow} */ agent, /** @type {string} */ _userId, /** @type {AgentRequest} */ req) => canModify(agent, req),
    };
}

module.exports = { fakeAgentGates };
