/**
 * Whose mail is it? The `mail.new` check of ncVisibility.mts.
 *
 * Nextcloud Mail sends its new-message event from the background sync, so the
 * delivery names no user (AANNAME A-19): only `accountId`, `mailboxId` and
 * `messageId`. A Mail account belongs to one Nextcloud user (or is delegated
 * to a few), and Mail lists for each user exactly the accounts they may read.
 * So a subscriber receives the event when the account is in THEIR account
 * list, asked as them, after the org's Nextcloud scope allowed that account.
 * Nobody else's automation ever sees it, whatever its filter says.
 *
 * The same check reads, as that subscriber, what the event leaves out: the
 * sender and the attachment flag (`GET /api/messages/{id}`, the message's
 * metadata, no body), and which mailbox it landed in (its special-use role,
 * so the trigger can keep to the inbox). Fails closed: an error, an unknown
 * account or a message that is not in that mailbox reads as "not theirs".
 *
 * A leaf: the caller hands in the subscriber's Nextcloud auth and the scope check.
 */

type Payload = Record<string, unknown>;
type NcResponse = { ok: boolean, status: number, text: () => Promise<string> };

export interface MailAuth {
    baseUrl: string;
    fetch: (url: string, options?: Record<string, unknown>) => Promise<NcResponse>;
}

export interface MailDecision {
    visible: boolean;
    overrides?: Payload;
}

/** True when the org's Nextcloud scope refuses this call for the subscriber. */
export type ScopeDenied = (toolName: string, args: Record<string, unknown>) => Promise<boolean>;

const MAIL_API = '/index.php/apps/mail/api';
const HEADERS = { 'Accept': 'application/json', 'OCS-APIRequest': 'true' };
const NOT_VISIBLE: MailDecision = Object.freeze({ visible: false });

/** A positive whole-number id as text, or null. */
export function mailIdOf(v: unknown): string | null {
    const text = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : (typeof v === 'string' ? v.trim() : '');
    if (!text || text.length > 15) return null;
    for (const ch of text) if (ch < '0' || ch > '9') return null;
    return text === '0' ? null : text;
}

async function getJson(auth: MailAuth, path: string): Promise<unknown> {
    const res = await auth.fetch(`${auth.baseUrl}${MAIL_API}${path}`, { headers: HEADERS });
    if (!res.ok) return null;
    try { return JSON.parse(await res.text()) as unknown; } catch { return null; }
}

function isObject(v: unknown): v is Payload {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Mail's special-use role of a mailbox ("inbox", "sent", ...), or null. */
export function mailboxRoleOf(m: Payload): string | null {
    const raw = m.specialRole ?? m.specialUse;
    const first = Array.isArray(raw) ? raw[0] : raw;
    if (typeof first !== 'string' || !first) return null;
    return (first.startsWith('\\') ? first.slice(1) : first).toLowerCase();
}

/** The sender as the Mail tools give it: addresses (or names), comma-separated. */
export function senderOf(from: unknown): string | null {
    if (!Array.isArray(from)) return typeof from === 'string' && from ? from : null;
    const parts = from.map((a) => (isObject(a) ? (a.email || a.label) : null)).filter((s): s is string => typeof s === 'string' && s !== '');
    return parts.length ? parts.join(', ') : null;
}

/** True when the account is in the subscriber's own Mail account list. */
async function ownsAccount(auth: MailAuth, accountId: string): Promise<boolean> {
    const accounts = await getJson(auth, '/accounts');
    return Array.isArray(accounts) && accounts.some((a) => isObject(a) && mailIdOf(a.accountId ?? a.id) === accountId);
}

/** The mailbox of that account, as the subscriber sees it, or null. */
async function findMailbox(auth: MailAuth, accountId: string, mailboxId: string): Promise<Payload | null> {
    const raw = await getJson(auth, `/mailboxes?accountId=${encodeURIComponent(accountId)}`);
    const boxes = Array.isArray(raw) ? raw : (isObject(raw) && Array.isArray(raw.mailboxes) ? raw.mailboxes : []);
    return boxes.find((b): b is Payload => isObject(b) && mailIdOf(b.databaseId ?? b.id) === mailboxId) ?? null;
}

/** The message's metadata (no body) when it sits in that mailbox, or null. */
async function messageFacts(auth: MailAuth, messageId: string, mailboxId: string): Promise<Payload | null> {
    const message = await getJson(auth, `/messages/${encodeURIComponent(messageId)}`);
    if (!isObject(message) || mailIdOf(message.mailboxId) !== mailboxId) return null;
    const flags = isObject(message.flags) ? message.flags : {};
    const hasAttachments = typeof message.hasAttachments === 'boolean' ? message.hasAttachments
        : (typeof flags.hasAttachments === 'boolean' ? flags.hasAttachments : null);
    return {
        from: senderOf(message.from),
        hasAttachments,
        ...(typeof message.subject === 'string' ? { subject: message.subject } : {}),
    };
}

/**
 * Decide one `mail.new` delivery for one subscriber, and what they see of it.
 */
export async function mailOwnerDecision(auth: MailAuth, payload: Payload, scopeDenied: ScopeDenied): Promise<MailDecision> {
    const accountId = mailIdOf(payload.accountId);
    const mailboxId = mailIdOf(payload.mailboxId);
    const messageId = mailIdOf(payload.messageId);
    if (!accountId || !mailboxId || !messageId) return NOT_VISIBLE;
    // The account is a resource of the Mail scope: off, or not among the
    // selected accounts, and the subscriber does not get it.
    if (await scopeDenied('nextcloud_mail_list_mailboxes', { accountId: Number(accountId) })) return NOT_VISIBLE;
    if (!(await ownsAccount(auth, accountId))) return NOT_VISIBLE;
    const box = await findMailbox(auth, accountId, mailboxId);
    if (!box) return NOT_VISIBLE;
    const facts = await messageFacts(auth, messageId, mailboxId);
    if (!facts) return NOT_VISIBLE;
    return { visible: true, overrides: { ...facts, mailboxRole: mailboxRoleOf(box) } };
}
