/**
 * Shared set-up of the agentScheduleRun tests (review, claim): a store that records its calls, and the collaborators
 * executeAgentRun takes through deps.services, so no module is mocked.
 */

'use strict';

/** A store that records every call; `claim` is what markRunning answers (null refuses the claim). */
function fakeStore(claim = 'run-1') {
    const calls = [];
    const rec = (name, answer) => async (...a) => { calls.push([name, ...a]); return answer; };
    return {
        calls,
        markRunning: rec('markRunning', claim), markCompleted: rec('markCompleted'), markError: rec('markError'),
        updateTask: rec('updateTask'), advanceSchedule: rec('advanceSchedule'), releaseRun: rec('releaseRun'),
    };
}

/**
 * The deps of executeAgentRun. `chat` stands in for the agent runtime; `onFail(err, opts)` and `onNote(notification)`
 * receive what failRun and the notification store were handed; `services` replaces or adds a collaborator.
 */
function fakeDeps({ chat, onFail = () => {}, onNote = () => {}, organizationId = null, services = {} }) {
    return {
        scheduleText: 'x', resolveUserSession: async () => null, isRepeating: () => true,
        failRun: async (task, err, opts) => { onFail(err, opts); },
        NOTIFICATION: { category: 'cowork', link: null, prefix: '' },
        services: {
            agentStore: { getForRuntime: async () => ({ id: 'a1', name: 'Mail agent', owner_id: 'u1', organization_id: organizationId, config: {} }) },
            notificationStore: { createNotification: async (n) => { onNote(n); } },
            terminationStore: { logTermination: async () => {} },
            buildUserAuth: async () => ({ accessToken: 't', userId: 'u1' }),
            chatWithAgentStream: chat,
            skillNames: async () => new Map(),
            ...services,
        },
    };
}

module.exports = { fakeStore, fakeDeps };
