/**
 * Microsoft 365 "New email" by polling — the way a SHARED mailbox fires.
 *
 * Why not a Graph change-notification subscription, like the own mailbox:
 * Microsoft does not support them for another user's or a shared mailbox with
 * delegated permissions ("Don't use the Outlook sharing permissions
 * (Mail.Read.Shared, ...), as they do not support subscribing to change
 * notifications on items in shared or delegated folders", Create subscription,
 * Graph v1.0). Bee Flow acts with the user's own delegated token, so a shared
 * mailbox is read on the polling tick instead: the inbox, newest first, since
 * the cursor. The same poller also serves an own-mailbox subscription that
 * fell back to polling (no PUBLIC_BASE_URL).
 *
 * Access is checked at every tick, never cached: the connection's scopes, then
 * Graph itself (Full Access). A refusal throws, so the polling pass escalates
 * it to the owner after its threshold, in words they can act on and without
 * the address (the error lands in a log line).
 *
 * The cursor is `{ t, ids }`: the receivedDateTime of the newest message seen,
 * and the ids seen AT that instant. The next tick asks for `ge t` and skips
 * those ids, so two mails in the same second are neither lost nor fired twice.
 *
 * Everything from the server's import cycle arrives through `ctx` (store, the
 * Microsoft session, the Graph client), so this module stays a leaf.
 */

import { createRequire } from 'node:module';
import type { Mailbox } from '../../../core/integrations/outlookMailbox.mts';
import {
    parseMailbox, mailboxBase, assertSharedScopes, mapGraphMailboxError, mailboxLogRef, OWN_MAILBOX,
} from '../../../core/integrations/outlookMailbox.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../../telemetry/log.js') as { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };

/** Messages one tick reads (and fires) at most; the rest come on the next tick. */
export const MAX_MESSAGES_PER_TICK = 25;
/** Ids kept for the cursor's instant (mails received in the same second). */
const MAX_CURSOR_IDS = 50;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;

/** `m` is the mailbox's log reference, so a cursor never carries over to another mailbox. */
export interface MailCursor { t: string; ids: string[]; m?: string }

interface GraphMessageRef { id?: unknown; receivedDateTime?: unknown }
type GraphFetch = (path: string, session: unknown) => Promise<{ value?: GraphMessageRef[] } | null | undefined>;

export interface MsGraphPollerCtx {
    store: () => { updateSubscription: (id: string, patch: Record<string, unknown>) => Promise<unknown> };
    microsoftSession: (session: unknown, userId: string, opts: { needsSharedMailbox: boolean }) => Promise<MsSessionLike | null>;
    msGraphClient: () => { graphFetch: GraphFetch };
}

interface MsSessionLike {
    accessToken?: string | null;
    oauthProvider?: string | null;
    oauthScope?: string | null;
    automationProviders?: { microsoft?: { scope?: string | null } | null } | null;
}

export interface PolledSub {
    id: string;
    userId: string;
    lastCursor?: string | null;
    filter?: Record<string, unknown> | null;
}

/** A stored cursor, or null when there is none (or it is not one of ours). */
export function parseCursor(raw: unknown): MailCursor | null {
    if (typeof raw !== 'string' || !raw) return null;
    try {
        const c = JSON.parse(raw) as { t?: unknown; ids?: unknown; m?: unknown };
        if (typeof c?.t !== 'string' || !ISO_RE.test(c.t)) return null;
        const ids = Array.isArray(c.ids) ? c.ids.filter((x): x is string => typeof x === 'string').slice(0, MAX_CURSOR_IDS) : [];
        return { t: c.t, ids, ...(typeof c.m === 'string' ? { m: c.m } : {}) };
    } catch {
        return null;
    }
}

/** The payload one new message fires with: the shape of a Graph notification, plus the mailbox. */
export function mailEvent(id: string, receivedDateTime: string | null, mailbox: Mailbox) {
    return {
        changeType: 'created',
        resource: `Messages('${id}')`,
        resourceData: { id, '@odata.type': '#Microsoft.Graph.Message' },
        receivedDateTime,
        // What the next steps pass as `mailbox` to read or answer this mail.
        mailbox: mailbox.shared ? mailbox.address : OWN_MAILBOX,
    };
}

/**
 * One tick's read: the messages after the cursor, the events they fire and
 * the cursor to store. Pure apart from the Graph call it is handed.
 */
export async function pollInbox(fetch: (path: string) => ReturnType<GraphFetch>, mailbox: Mailbox, cursor: MailCursor) {
    const base = mailboxBase(mailbox);
    const data = await fetch(`${base}/mailFolders('inbox')/messages?$filter=receivedDateTime ge ${cursor.t}&$orderby=receivedDateTime asc&$top=${MAX_MESSAGES_PER_TICK + cursor.ids.length}&$select=id,receivedDateTime`);
    const seen = new Set(cursor.ids);
    const events = [];
    let next: MailCursor = { t: cursor.t, ids: [...cursor.ids], m: mailboxLogRef(mailbox) };
    for (const msg of data?.value || []) {
        if (events.length >= MAX_MESSAGES_PER_TICK) break;
        const id = typeof msg?.id === 'string' ? msg.id : null;
        const at = typeof msg?.receivedDateTime === 'string' && ISO_RE.test(msg.receivedDateTime) ? msg.receivedDateTime : null;
        if (!id || !at || seen.has(id)) continue;
        seen.add(id);
        events.push(mailEvent(id, at, mailbox));
        if (at === next.t) next = { ...next, ids: [...next.ids, id].slice(-MAX_CURSOR_IDS) };
        else if (Date.parse(at) > Date.parse(next.t)) next = { ...next, t: at, ids: [id] };
    }
    return { events, cursor: next };
}

export function createMsGraphPollers(ctx: MsGraphPollerCtx) {
    return {
        'mail.new': async (sub: PolledSub, session: unknown) => {
            // An address that does not parse fails here, every tick, until it is fixed.
            const mailbox = parseMailbox(sub.filter?.mailbox);
            const ms = await ctx.microsoftSession(session, sub.userId, { needsSharedMailbox: mailbox.shared });
            if (!ms?.accessToken || ms.oauthProvider !== 'microsoft') {
                throw new Error('No Microsoft connection: connect Microsoft in Settings → Connections.');
            }
            assertSharedScopes(mailbox, ms);
            const { graphFetch } = ctx.msGraphClient();
            const fetch = (path: string) => graphFetch(path, ms);
            try {
                const stored = parseCursor(sub.lastCursor);
                // A cursor of another mailbox (the trigger was pointed elsewhere) starts over.
                const cursor = stored && stored.m === mailboxLogRef(mailbox) ? stored : null;
                if (!cursor) {
                    // First tick: anchor at the newest mail (or now) and fire
                    // nothing, so switching a trigger on never replays the inbox.
                    // This read is also the first access check.
                    const data = await fetch(`${mailboxBase(mailbox)}/mailFolders('inbox')/messages?$top=1&$orderby=receivedDateTime desc&$select=id,receivedDateTime`);
                    const newest = data?.value?.[0];
                    const t = typeof newest?.receivedDateTime === 'string' && ISO_RE.test(newest.receivedDateTime)
                        ? newest.receivedDateTime : new Date().toISOString().replace(/\.\d+Z$/, 'Z');
                    const anchor: MailCursor = { t, ids: typeof newest?.id === 'string' && t === newest.receivedDateTime ? [newest.id] : [], m: mailboxLogRef(mailbox) };
                    await ctx.store().updateSubscription(sub.id, { lastCursor: JSON.stringify(anchor) });
                    log.info(`[TriggerBus] msgraph mail bootstrap sub ${sub.id} (mailbox ${mailboxLogRef(mailbox)})`);
                    return [];
                }
                const { events, cursor: next } = await pollInbox(fetch, mailbox, cursor);
                if (next.t !== cursor.t || next.ids.length !== cursor.ids.length) {
                    await ctx.store().updateSubscription(sub.id, { lastCursor: JSON.stringify(next) });
                }
                return events;
            } catch (err) {
                const mapped = mapGraphMailboxError(err, mailbox);
                // Graph's own text can name the mailbox; on a shared one only
                // the status goes on (this error is logged and escalated).
                if (mapped === err && mailbox.shared) {
                    const status = (err as { graphStatus?: unknown })?.graphStatus;
                    throw new Error(`Microsoft Graph could not read the shared mailbox${status ? ` (HTTP ${String(status)})` : ''}.`);
                }
                throw mapped;
            }
        },
    };
}
