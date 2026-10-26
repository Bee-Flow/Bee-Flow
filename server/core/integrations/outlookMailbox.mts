/**
 * Which Outlook mailbox an Outlook action or trigger works on: the user's own
 * ("me", the default) or a shared mailbox the user has access to.
 *
 * One rule for every caller: the Outlook tools (integrations/outlookTools.js),
 * the approval-card send route, the new-mail trigger, the automation
 * validator and the App Studio mailbox connector all read the address,
 * the Graph path, the scope check and the error wording from here, so a
 * shared mailbox fails the same way, with the same words, wherever it is used.
 *
 * Microsoft decides who may open a shared mailbox: the administrator grants
 * the user Full Access (and Send As to send from it), and the user's
 * connection must carry the delegated Mail.Read.Shared and Mail.Send.Shared
 * scopes. Bee Flow never widens that; it asks Graph with the user's own
 * delegated token and translates a refusal into something the user can act on.
 *
 * Privacy: an address is personal data. Errors built here never carry the
 * address (they end up in run logs), and log lines use mailboxLogRef(), a
 * short one-way hash.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type HttpErrorCtor = new (status: number, code: string, message: string, details?: unknown) => Error & { status: number; code: string };
const { HttpError } = nodeRequire('../http/errors.js') as { HttpError: HttpErrorCtor };
// The App Studio mailbox connector's own address rule (connectorValidate.js),
// so an address valid there is valid here and the other way round.
const { MAILBOX_EMAIL_RE } = nodeRequire('../dataEngine/dataModel/vocabulary.js') as { MAILBOX_EMAIL_RE: RegExp };

/** The value that means "the signed-in user's own mailbox". */
export const OWN_MAILBOX = 'me';

// The scopes themselves live with the other Microsoft scopes (auth/permissionsOAuth.js).
const oauthScopes = nodeRequire('../../auth/permissionsOAuth.js') as {
    SHARED_MAILBOX_SCOPES: readonly string[];
    hasSharedMailboxScopes: (scope: unknown) => boolean;
};

/** What a connection must have been granted before a shared mailbox can work at all. */
export const SHARED_MAILBOX_SCOPES: readonly string[] = oauthScopes.SHARED_MAILBOX_SCOPES;

export type Mailbox = { shared: false } | { shared: true; address: string };

/** The JSON-schema property every Outlook tool and the trigger describe the field with. */
export const MAILBOX_PARAM = Object.freeze({
    type: 'string',
    description: 'Optional: whose mailbox. "me" (the default) is the user\'s own mailbox; an e-mail address is a shared mailbox the user has Full Access to (reads, searches and replies there; sending goes out AS that mailbox). Needs a Microsoft connection with shared-mailbox access.',
});

const INVALID_TEXT = 'mailbox is "me" or the e-mail address of a shared mailbox.';
// The address is encoded into the path anyway; refusing the characters that
// mean something in a URL keeps a hostile value from even looking like a path.
const URL_SIGNIFICANT = /[/?#%&=]/;

/** "No access" in the App Studio mailbox connector's words (appStudio/mailboxConnector.js). */
export function sharedMailboxDeniedText(address?: string | null): string {
    const which = address ? `the shared mailbox ${address}` : 'the shared mailbox';
    return `No access to ${which}. Your Microsoft administrator must grant you Full Access, and the connection needs the Mail.Read.Shared permission — reconnect Microsoft in Settings → Connections.`;
}

/** The connection was granted without the shared-mailbox scopes. */
export const SHARED_SCOPES_MISSING_TEXT = 'Your Microsoft connection has no access to shared mailboxes yet: it needs the Mail.Read.Shared and Mail.Send.Shared permissions. Reconnect Microsoft in Settings → Connections (your Microsoft administrator may have to approve these permissions first).';

/** No mailbox of that address exists in the tenant (Graph 404 on the mailbox itself). */
export const SHARED_MAILBOX_NOT_FOUND_TEXT = 'That shared mailbox was not found. Check the address; it must be a mailbox in your organisation\'s Microsoft 365.';

/** A lent or acting connection must never open someone's shared mailboxes. */
export const SHARED_MAILBOX_NOT_LENDABLE_TEXT = 'A shared mailbox can only be used with your own Microsoft connection, not with a connection someone else lends to this automation.';

/**
 * Parse the `mailbox` field. Absent, empty or "me" (any case) is the own
 * mailbox; anything else must be a valid e-mail address (it becomes a path
 * segment of /users/{address}/...). Throws HttpError 400 otherwise.
 */
export function parseMailbox(value: unknown): Mailbox {
    if (value === undefined || value === null) return { shared: false };
    if (typeof value !== 'string') throw new HttpError(400, 'invalid_mailbox', INVALID_TEXT);
    const text = value.trim();
    if (text === '' || text.toLowerCase() === OWN_MAILBOX) return { shared: false };
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- bounded character classes ({1,64}, {1,255}, {2,24}), anchored: linear
    if (text.length > 320 || !MAILBOX_EMAIL_RE.test(text) || URL_SIGNIFICANT.test(text)) throw new HttpError(400, 'invalid_mailbox', INVALID_TEXT);
    return { shared: true, address: text.toLowerCase() };
}

/** Is `value` a valid `mailbox` field? (The validator's question, without the throw.) */
export function isValidMailbox(value: unknown): boolean {
    try { parseMailbox(value); return true; } catch { return false; }
}

/** The Graph path prefix of a mailbox: `/me` or `/users/{address}`. */
export function mailboxBase(mailbox: Mailbox): string {
    return mailbox.shared ? `/users/${encodeURIComponent(mailbox.address)}` : '/me';
}

/** The subscription resource prefix (no leading slash): `me` or `users/{address}`. */
export function mailboxResource(mailbox: Mailbox): string {
    return mailboxBase(mailbox).slice(1);
}

/** Did the grant include both shared-mailbox scopes? (Case-insensitive, as Microsoft echoes them.) */
export function hasSharedMailboxScopes(scope: unknown): boolean {
    return oauthScopes.hasSharedMailboxScopes(scope);
}

interface ScopedSession {
    oauthScope?: string | null;
    automationProviders?: { microsoft?: { scope?: string | null } | null } | null;
}

/** The scope string a Microsoft session (SSO, vault shim or automation session) carries, or null when unknown. */
export function grantedScopeOf(session: ScopedSession | null | undefined): string | null {
    const scope = session?.oauthScope || session?.automationProviders?.microsoft?.scope || null;
    return typeof scope === 'string' && scope.trim() ? scope : null;
}

/**
 * Refuse a shared mailbox up front when the credential is KNOWN to lack the
 * shared scopes. An unknown scope (an older credential stored without one) is
 * let through: Graph then answers 403, which mapGraphMailboxError turns into
 * the same instruction.
 */
export function assertSharedScopes(mailbox: Mailbox, session: ScopedSession | null | undefined): void {
    if (!mailbox.shared) return;
    const scope = grantedScopeOf(session);
    if (scope !== null && !hasSharedMailboxScopes(scope)) {
        throw new HttpError(403, 'shared_mailbox_scope_missing', SHARED_SCOPES_MISSING_TEXT);
    }
}

/**
 * A Graph failure on a shared mailbox, in words the user can act on. 403 is
 * the common one (no Full Access, or a token without the .Shared scopes); 404
 * on the mailbox means the address is wrong or the user cannot see it. Any
 * other error (and every error on the own mailbox) comes back unchanged.
 */
export function mapGraphMailboxError(err: unknown, mailbox: Mailbox): unknown {
    if (!mailbox.shared) return err;
    const e = (err || {}) as { status?: unknown; graphStatus?: unknown; graphCode?: unknown; message?: unknown };
    // graphFetch puts Graph's status on `graphStatus`; a batched answer or the
    // subscription calls hand it in as `status`.
    const status = e.graphStatus ?? e.status;
    if (status === 403) {
        return new HttpError(403, 'shared_mailbox_denied', sharedMailboxDeniedText());
    }
    // A 404 on a MESSAGE (ErrorItemNotFound) stays what it is; only a mailbox
    // Graph cannot find becomes "not found".
    if (status === 404 &&(MAILBOX_MISSING_CODES.has(String(e.graphCode || '')) || /mailbox|requested user|resource could not be discovered/i.test(String(e.message || '')))) {
        return new HttpError(404, 'mailbox_not_found', SHARED_MAILBOX_NOT_FOUND_TEXT);
    }
    return err;
}

/** Graph error codes for "no such mailbox" (as opposed to "no such message"). */
const MAILBOX_MISSING_CODES = new Set(['ErrorInvalidUser', 'ErrorNonExistentMailbox', 'MailboxNotEnabledForRESTAPI', 'ResourceNotFound']);

/** A short one-way reference to a mailbox for a log line (never the address itself). */
export function mailboxLogRef(mailbox: Mailbox): string {
    if (!mailbox.shared) return 'own';
    return `shared:${createHash('sha256').update(mailbox.address).digest('hex').slice(0, 10)}`;
}
