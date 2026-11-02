// @typecheck strict
/**
 * app_set_mailbox_hook — make a mailbox connector run an app action for each NEW
 * conversation or incoming message (appStudio/mailboxNewRecordHook.mts).
 *
 * The one connector setting the builder may write: the connector itself (account,
 * folder, retention) is the owner's to set up, but which action files an arriving
 * mail is app logic. The action may only carry steps that run unattended, and never
 * send_email (mailboxHookPolicy.mts); the same rules are checked again when the
 * definition is validated and before every run.
 */

'use strict';

const { currentDataModel, persistDataModel, dataModelPersistError } = require('./dataToolsShared');
const { HOOK_TARGETS, hookActionProblems, onNewRecordErrors } = require('../mailboxHookPolicy.mts');

/** @typedef {import('../builderTools').BuilderDraft} BuilderDraft */

/**
 * @param {BuilderDraft} draftWrap
 * @param {import('../builderTools').ToolArgs} args
 * @returns {Promise<import('../builderTools').ToolResult>}
 */
async function applySetMailboxHook(draftWrap, args) {
    const model = currentDataModel(draftWrap);
    /** @type {Array<Record<string, any>>} */
    const connectors = Array.isArray(model.connectors) ? model.connectors : [];
    const mailboxes = connectors.filter((c) => c && c.kind === 'mailbox');
    const connectorId = typeof args?.connectorId === 'string' ? args.connectorId : '';
    const connector = mailboxes.find((c) => c.id === connectorId);
    if (!connector) {
        return {
            error: `Unknown mailbox connector ${JSON.stringify(args?.connectorId)}.`,
            _fixHint: mailboxes.length
                ? `Mailbox connectors in this app: ${mailboxes.map((c) => c.id).join(', ')}. Use app_list_connectors to see them.`
                : 'This app has no mailbox connector. The app owner adds one in the Data tab; you cannot create it.',
        };
    }

    const clearing = args?.actionId === null;
    /** @type {{ actionId: string, target: string } | null} */
    let hook = null;
    if (!clearing) {
        const actionId = typeof args?.actionId === 'string' ? args.actionId : '';
        const actions = draftWrap.def?.actions && typeof draftWrap.def.actions === 'object' ? draftWrap.def.actions : {};
        if (!actionId || !Object.hasOwn(actions, actionId)) {
            return {
                error: `Unknown actionId ${JSON.stringify(args?.actionId)}.`,
                _fixHint: `Create the action first with app_set_action. Actions: ${Object.keys(actions).join(', ') || '(none yet)'}. Pass actionId null to switch the hook off.`,
            };
        }
        const problems = hookActionProblems(actions[actionId], actionId);
        if (problems.length) {
            return {
                error: problems.join(' '),
                _fixHint: 'The action runs without anybody pressing a button, so it may only hold steps that run on the server and reach no person: create_record, update_record, ai_generate, ai_extract, kb_query, dataset_query, file_intake, generate_file, fill_document, generate_presentation, redact_pdf, with condition/switch around them. Never send_email. Build a separate action for the steps a person triggers.',
            };
        }
        hook = { actionId, target: typeof args?.target === 'string' ? args.target : '' };
        const shape = onNewRecordErrors(hook, connector, 'connector');
        if (shape.length) {
            return {
                error: shape.join('; '),
                _fixHint: `target is one of ${HOOK_TARGETS.join(', ')}: "thread" for each new conversation (needs the connector to group into threads), "inbound_message" for each new message that came in.`,
            };
        }
    }

    /** @param {Record<string, any>} m */
    const op = (m) => ({
        ...m,
        connectors: (Array.isArray(m.connectors) ? m.connectors : []).map((c) => {
            if (!c || c.id !== connectorId) return c;
            const { onNewRecord: _old, ...rest } = c;
            return hook ? { ...rest, onNewRecord: hook } : rest;
        }),
    });
    const persisted = await persistDataModel(draftWrap, op(model), { rebase: op });
    const failed = dataModelPersistError(persisted);
    if (failed) return failed;
    return {
        ok: true,
        connectorId,
        onNewRecord: hook,
        modelVersion: draftWrap.dataModelVersion,
        note: hook
            ? 'From the next sync on, each new row runs the action as the app owner with { item: <the new row> }. Rows that are already stored are not processed. Runs are capped per sync and per minute, and appear in the audit log as studio_app_mailbox_hook_*.'
            : 'The hook is off: new rows no longer run an action.',
    };
}

module.exports = { applySetMailboxHook };
