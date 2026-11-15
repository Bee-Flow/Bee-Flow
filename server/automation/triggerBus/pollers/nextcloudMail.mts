/**
 * The Nextcloud Mail poller: `mail.new` read through Mail's API, for a user
 * without the connector, for a connector or Mail that cannot push the event
 * yet, and as the backstop of the push (the polling pass picks a webhook-mode
 * subscription up once its last push is stale, stores/automationStore
 * getPollingSubscriptions). It runs inside that pass, which a boot phase
 * starts; requiring this module starts nothing.
 *
 * Per tick, as the subscription's owner and through the Nextcloud scope guard
 * (the same order the Mail tools need under a narrowed scope: accounts, then
 * mailboxes, then a search):
 *   1. the accounts (`filter.accountId` narrows to one; at most
 *      AUTOMATION_NC_MAIL_MAX_ACCOUNTS, default 10, 0 = all);
 *   2. per account its inbox, or the mailbox `filter.mailboxId` names;
 *   3. the newest messages there (`nextcloud_mail_search`, at most
 *      AUTOMATION_NC_MAIL_POLL_LIMIT, default 25, max 100); those above the
 *      mailbox's cursor are the events, oldest first. A mailbox seen for the
 *      first time only anchors the cursor: switching an automation on never
 *      replays the inbox.
 * The cursor is the one the push writes too (../ncMailCursor.mts), read again
 * right before it is written.
 */

import { envInt } from '../../../utils/envNumber.mts';
import { advanceMailCursor, lastSeen, parseMailCursor } from '../ncMailCursor.mts';

type Payload = Record<string, unknown>;
type Sub = { id: string, userId: string, lastCursor?: string | null, filter?: Payload | null };
type ToolResult = Payload | null | undefined;

export interface MailPollCtx {
    store: () => {
        getSubscription: (id: string) => Promise<{ lastCursor?: string | null } | null>,
        updateSubscription: (id: string, patch: Payload) => Promise<unknown>,
    };
    nextcloudMailTools: () => { executeNextcloudMailTool: (name: string, args: Payload, userId: string, session: unknown) => Promise<ToolResult> };
    ncScopeGuard: () => { guardedNcCall: (name: string, args: Payload, who: { userId: string, session: unknown }, run: () => Promise<ToolResult>) => Promise<ToolResult> };
}

function maxAccounts(): number {
    return envInt('AUTOMATION_NC_MAIL_MAX_ACCOUNTS', 10, { min: 0 });
}

function pollLimit(): number {
    return Math.min(100, envInt('AUTOMATION_NC_MAIL_POLL_LIMIT', 25, { min: 1 }));
}

function set(v: unknown): boolean {
    return v !== undefined && v !== null && v !== '';
}

function numId(v: unknown): number | null {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function listOf(result: ToolResult, key: string): Payload[] {
    const v = result && typeof result === 'object' ? result[key] : null;
    return Array.isArray(v) ? v.filter((x): x is Payload => !!x && typeof x === 'object') : [];
}

function iso(unixSeconds: unknown): string | null {
    const n = Number(unixSeconds);
    return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

/** The poller's event for one search hit (the push's shape, ncPayload normaliseMailPayload). */
export function mailEventOf(accountId: number, mailboxId: number, role: string | null, m: Payload): Payload {
    const at = iso(m.dateInt);
    return {
        accountId,
        mailboxId,
        messageId: numId(m.id),
        from: typeof m.from === 'string' && m.from ? m.from : null,
        subject: typeof m.subject === 'string' ? m.subject : '',
        hasAttachments: typeof m.hasAttachments === 'boolean' ? m.hasAttachments : null,
        receivedAt: at,
        datetime: at,
        mailboxRole: role,
    };
}

/** The mailbox to read on one account: the one the filter names, else the inbox. */
function pickMailbox(mailboxes: Payload[], filter: Payload): { id: number, role: string | null } | null {
    const wanted = set(filter.mailboxId) ? String(filter.mailboxId).trim() : null;
    const box = wanted
        ? mailboxes.find((b) => String(b.id) === wanted)
        : mailboxes.find((b) => b.specialRole === 'inbox');
    const id = box ? numId(box.id) : null;
    return box && id ? { id, role: typeof box.specialRole === 'string' ? box.specialRole : null } : null;
}

type Call = (name: string, args: Payload) => Promise<ToolResult>;
type Seen = { events: Payload[], top: [number, number] | null };

/** The accounts to read: the filter's one, else all, capped. */
async function accountsToRead(call: Call, filter: Payload): Promise<number[]> {
    const listed = await call('nextcloud_mail_list_accounts', {});
    if (!listed || typeof listed.error === 'string') throw new Error(`Nextcloud Mail accounts could not be read: ${listed?.error ?? 'no answer'}`);
    let accounts = listOf(listed, 'accounts').map((a) => numId(a.id)).filter((id): id is number => id !== null);
    if (set(filter.accountId)) accounts = accounts.filter((id) => String(id) === String(filter.accountId).trim());
    const cap = maxAccounts();
    return cap > 0 ? accounts.slice(0, cap) : accounts;
}

/** One account: the new messages above its mailbox's cursor, and the newest id seen there. */
async function readAccount(call: Call, accountId: number, filter: Payload, cursor: ReturnType<typeof parseMailCursor>): Promise<Seen> {
    const box = pickMailbox(listOf(await call('nextcloud_mail_list_mailboxes', { accountId }), 'mailboxes'), filter);
    if (!box) return { events: [], top: null };
    const found = await call('nextcloud_mail_search', { mailboxId: box.id, limit: pollLimit() });
    if (!found || typeof found.error === 'string') return { events: [], top: null };
    const hits = listOf(found, 'messages')
        .map((m) => ({ m, id: numId(m.id) }))
        .filter((h): h is { m: Payload, id: number } => h.id !== null)
        .sort((a, b) => a.id - b.id);
    if (!hits.length) return { events: [], top: null };
    const last = lastSeen(cursor, box.id);
    // First sight of this mailbox: anchor only.
    const events = last === null ? [] : hits.filter((h) => h.id > last).map((h) => mailEventOf(accountId, box.id, box.role, h.m));
    return { events, top: [box.id, hits[hits.length - 1].id] };
}

export async function pollNextcloudMail(ctx: MailPollCtx, sub: Sub, session: unknown): Promise<Payload[]> {
    const filter: Payload = sub.filter && typeof sub.filter === 'object' ? sub.filter : {};
    const tools = ctx.nextcloudMailTools();
    const { guardedNcCall } = ctx.ncScopeGuard();
    const call: Call = (name, args) => guardedNcCall(name, args, { userId: sub.userId, session },
        () => tools.executeNextcloudMailTool(name, args, sub.userId, session));

    const cursor = parseMailCursor(sub.lastCursor);
    const events: Payload[] = [];
    const tops: Array<[number, number]> = [];
    for (const accountId of await accountsToRead(call, filter)) {
        const seen = await readAccount(call, accountId, filter, cursor);
        events.push(...seen.events);
        if (seen.top) tops.push(seen.top);
    }
    if (!tops.length) return events;

    // Read the cursor again: a push may have handed out a message meanwhile.
    const fresh = await ctx.store().getSubscription(sub.id).catch(() => null);
    let lastCursor: string | null = fresh ? (fresh.lastCursor ?? null) : (sub.lastCursor ?? null);
    const pushed = parseMailCursor(lastCursor);
    const out = events.filter((e) => {
        const top = lastSeen(pushed, e.mailboxId);
        return top === null || Number(e.messageId) > top;
    });
    for (const [boxId, top] of tops) lastCursor = advanceMailCursor(lastCursor, boxId, top);
    await ctx.store().updateSubscription(sub.id, { lastCursor });
    return out;
}
