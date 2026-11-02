// @typecheck strict
/**
 * App Studio validator — the action a mailbox connector runs for each new row.
 *
 * The setting sits on the connector (data model), the action in the definition, so the
 * pair can only be checked where both are known: here, when the definition is validated
 * with its data model. The rules are mailboxHookPolicy.mts, which the runner applies
 * again before every run (an action can change after the connector was saved).
 */

'use strict';

const { readOnNewRecord, hookActionProblems } = require('../mailboxHookPolicy.mts');

/**
 * @param {unknown} dataModel  opts.dataModel; undefined or null when the caller has none
 * @param {Record<string, unknown> | null} actions  def.actions
 * @param {(finding: { code: string, severity: string, path: string, message: string, hint: string }) => void} pushE
 */
function checkMailboxHooks(dataModel, actions, pushE) {
    const connectors = dataModel && typeof dataModel === 'object' && Array.isArray(/** @type {{ connectors?: unknown }} */ (dataModel).connectors)
        ? /** @type {Array<Record<string, unknown>>} */ (/** @type {{ connectors: unknown[] }} */ (dataModel).connectors) : [];
    for (const connector of connectors) {
        if (!connector || connector.kind !== 'mailbox') continue;
        const hook = readOnNewRecord(connector.onNewRecord);
        if (!hook) continue;
        const action = actions && Object.hasOwn(actions, hook.actionId) ? actions[hook.actionId] : null;
        for (const message of hookActionProblems(action, hook.actionId)) {
            pushE({
                code: 'mailbox_hook.action_invalid', severity: 'error', path: `actions.${hook.actionId}`,
                message: `Mailbox connector ${String(connector.id)} runs this action for every new ${hook.target === 'thread' ? 'conversation' : 'incoming message'}. ${message}`,
                hint: 'Fix the action, or point the connector at another action (or none) with app_set_mailbox_hook.',
            });
        }
    }
}

module.exports = { checkMailboxHooks };
