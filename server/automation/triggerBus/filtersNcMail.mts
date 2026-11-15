/**
 * The nextcloud `mail.new` filter (split out of filters.js, like filtersTables.js).
 *
 * Filter keys (all optional, AND across keys):
 *   accountId        the Mail account (nextcloud_mail_list_accounts id)
 *   mailboxId        the mailbox (nextcloud_mail_list_mailboxes id); without
 *                    it only the account's inbox counts, so mail Nextcloud
 *                    synchronises into Sent, Drafts or a folder does not start
 *                    the automation. Both producers say which mailbox it was
 *                    (`mailboxRole`); an unknown mailbox is not the inbox.
 *   fromContains     case-insensitive substring of the sender
 *   subjectContains  case-insensitive substring of the subject
 *   hasAttachment    true: only with attachments; false: only without
 */

type Payload = Record<string, unknown> | null | undefined;
type Filter = Record<string, unknown> | null | undefined;

function set(v: unknown): boolean {
    return v !== undefined && v !== null && v !== '';
}

function containsCI(haystack: unknown, needle: unknown): boolean {
    if (typeof haystack !== 'string' || typeof needle !== 'string') return false;
    return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** Without a mailboxId only the inbox counts; with one, that mailbox. */
function mailboxOk(p: Record<string, unknown>, f: Record<string, unknown>): boolean {
    if (set(f.mailboxId)) return String(p.mailboxId) === String(f.mailboxId).trim();
    return p.mailboxRole === 'inbox';
}

function attachmentOk(p: Record<string, unknown>, f: Record<string, unknown>): boolean {
    if (f.hasAttachment === true) return p.hasAttachments === true;
    if (f.hasAttachment === false) return p.hasAttachments === false;
    return true;
}

export function matchNextcloudMailFilter(payload: Payload, filter: Filter): boolean {
    const p = payload ?? {};
    const f = filter ?? {};
    if (set(f.accountId) && String(p.accountId) !== String(f.accountId).trim()) return false;
    if (!mailboxOk(p, f) || !attachmentOk(p, f)) return false;
    if (set(f.fromContains) && !containsCI(p.from, String(f.fromContains))) return false;
    return !set(f.subjectContains) || containsCI(p.subject, String(f.subjectContains));
}
