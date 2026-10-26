// @typecheck strict
/**
 * The Microsoft session an Outlook tool call runs on, from the dispatcher's
 * context. Split out of toolFamilies.js.
 *
 * A Google (or Nextcloud) session may carry Outlook tools when the user
 * connected Microsoft 365 separately: Graph then gets a Microsoft-only shim,
 * never the caller's foreign token (auth/microsoftSessionHydration.js).
 *
 * A SHARED mailbox (`mailbox` in the arguments) opens with the credential of
 * whoever holds it, so it is only ever opened with the asker's OWN connection:
 * never through a lent connection, and never as an acting identity (the asker
 * is not the integration user then, e.g. the Support inbox's operator).
 * Lending a connection lends that person's own mailbox, not every shared
 * mailbox they can reach. A Microsoft login session without the .Shared
 * scopes gives way to the vault credential when that one has them.
 */

const { parseMailbox, SHARED_MAILBOX_NOT_LENDABLE_TEXT } = require('../core/integrations/outlookMailbox.mts');
const { HttpError } = require('../core/http/errors');

/**
 * @param {Record<string, unknown> | null | undefined} toolArgs
 * @param {{ session?: unknown, userId?: string | null, askerUserId?: string | null, lentConnection?: unknown }} context
 * @returns {Promise<import('./outlookTools').OutlookSession>} the session to hand to executeOutlookTool
 */
async function outlookSessionFor(toolArgs, context) {
    const { session, userId } = context;
    const needsSharedMailbox = parseMailbox(toolArgs?.mailbox).shared;
    if (needsSharedMailbox && (context.lentConnection || (context.askerUserId && context.askerUserId !== userId))) {
        throw new HttpError(403, 'shared_mailbox_not_lendable', SHARED_MAILBOX_NOT_LENDABLE_TEXT);
    }
    const { resolveMicrosoftSession } = require('../auth/microsoftSessionHydration');
    return (await resolveMicrosoftSession(session, userId || null, { needsSharedMailbox })) || session;
}

module.exports = { outlookSessionFor };
