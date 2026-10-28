// @typecheck strict
'use strict';

/**
 * The server side of ncVisibility.mts: how the checker reaches Nextcloud as a
 * subscriber. Credentials come from the polling pass's loadSession, the tool
 * executors through the integration client registry (registered at boot by
 * integrations/integrationClients.js), and every probe is gated by the org's
 * Nextcloud scope first. Kept out of triggerBus.js so ncVisibility.mts stays
 * a leaf and the automation layer does not require the integrations feature.
 */

const { createNcVisibility } = require('./ncVisibility.mts');
const log = require('../../telemetry/log');

/** @param {string} name */
function ncClient(name) {
    return require('../../core/integrations/integrationClients').integrationClient(name);
}

/**
 * dispatchEvent with the Nextcloud visibility checker attached. Callers never
 * pass one themselves; the tests of dispatch.js inject their own.
 * @param {typeof import('./dispatch').dispatchEvent} dispatchEvent
 * @param {(userId: string) => Promise<unknown>} loadSession
 * @returns {typeof import('./dispatch').dispatchEvent}
 */
function withNcVisibility(dispatchEvent, loadSession) {
    const ncVisibility = createNcVisibility({
        loadSession: (uid) => loadSession(uid),
        resolveAuth: (session, uid) => ncClient('nextcloud').resolveAuth(session, uid),
        // Through the scope guard like every Nextcloud executor call: a refused
        // or filtered answer reads as "not visible".
        runTool: (name, args, uid, session) => {
            const { guardedNcCall } = require('../../core/integrations/ncScopeGuard');
            const ctx = { userId: uid, session: /** @type {import('../../core/entitlements/entitlementTypes').SessionLike | null} */ (session) };
            if (name.startsWith('nextcloud_talk_')) return guardedNcCall(name, args, ctx, () => ncClient('nextcloudTalk').executeNextcloudTalkTool(name, args, uid, session));
            if (name.startsWith('nextcloud_deck_')) return guardedNcCall(name, args, ctx, () => ncClient('nextcloudDeck').executeNextcloudDeckTool(name, args, uid, session));
            if (name.startsWith('nextcloud_tables_')) return guardedNcCall(name, args, ctx, () => ncClient('nextcloudTables').executeNextcloudTablesTool(name, args, uid, session));
            return guardedNcCall(name, args, ctx, () => ncClient('nextcloudFiles').executeNextcloudTool(name, args, uid, session));
        },
        scopeDenied: async (name, args, uid, session) => !!(await require('../../core/integrations/ncScopeGuard')
            .checkToolCall({ toolName: name, toolArgs: args, userId: uid, session: /** @type {import('../../core/entitlements/entitlementTypes').SessionLike | null} */ (session) })),
        log,
    });
    return (args) => dispatchEvent({ ncVisibility, ...args });
}

module.exports = { withNcVisibility };
