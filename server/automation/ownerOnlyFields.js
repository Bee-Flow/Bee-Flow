// @typecheck
/**
 * What only the OWNER of an automation may change through a save, whoever else
 * holds an `edit` share: the sidebar folder it is filed in, and whose
 * connections a shared or agent-called run uses (runPolicy.connections).
 * The second is the owner's call because moving it to 'owner' lends the
 * owner's mailbox and drive to every sharer. A change by the owner is logged
 * (ids only); the version history keeps the change itself.
 */

'use strict';

const log = require('../telemetry/log');
const { resolveRunPolicy } = require('../core/automationRunner/runPolicy');

/**
 * @param {{ body: { folderId?: any, definition?: any }, existing: { id: string, definition?: object },
 *           role: string|null, userId: string }} args
 * @returns {string|null} the refusal sentence, or null when the save may go on
 */
function ownerOnlyRefusal({ body, existing, role, userId }) {
    if (role === 'owner') {
        if (body.definition !== undefined) logConnectionsChange(existing, body.definition, userId);
        return null;
    }
    if (body.folderId !== undefined) return 'Only the owner can move this automation to another folder.';
    if (body.definition !== undefined && connectionsChanged(existing.definition, body.definition)) {
        return 'Only the owner can change whose connections this automation uses.';
    }
    return null;
}

/** Would a definition move runPolicy.connections away from what is stored? */
function connectionsChanged(storedDefinition, nextDefinition) {
    return resolveRunPolicy(storedDefinition).connections !== resolveRunPolicy(nextDefinition).connections;
}

function logConnectionsChange(existing, nextDefinition, userId) {
    if (!connectionsChanged(existing.definition, nextDefinition)) return;
    const from = resolveRunPolicy(existing.definition).connections;
    const to = resolveRunPolicy(nextDefinition).connections;
    log.info(`[automation] connections policy of ${existing.id} changed ${from} -> ${to} by ${userId}`);
}

module.exports = { ownerOnlyRefusal, connectionsChanged };
