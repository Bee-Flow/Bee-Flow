/**
 * Company mailbox sync: new mail in the IMAP folder of Bee Flow's own support
 * mailbox becomes a ticket (or a reply on one) in the company inbox at
 * /app/admin/support.
 *
 * - Cursor: the UID of the last message handled, under the folder's
 *   UIDVALIDITY. A fresh cursor (new mailbox, or the server renumbered the
 *   folder) starts at `sync_after`, the moment the mailbox was connected, so
 *   connecting never imports the history.
 * - Threading: In-Reply-To / References against the Message-IDs stored on
 *   company tickets (ours on the replies we sent, theirs on what came in).
 *   A message whose own Message-ID is already stored is a duplicate.
 * - Loop and bulk safety: auto-replies, lists, bounces, no-reply senders and
 *   our own address are skipped (services/email/parse.detectAutoOrBulk).
 * - One sync at a time across pods: a lease the database expires by itself.
 * - The AI answers only when the mailbox says so (`aiAutoReply`, off by
 *   default), and then over the same SMTP account.
 */

import { createRequire } from 'node:module';
import { openImap, type MailboxConnection } from './connection.mts';
import { sendCompanyReply } from './send.mts';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;

const envInt = (name: string, fallback: number): number => {
    const n = Number.parseInt(String(process.env[name] ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};
/** How often the folder is read. */
const TICK_MS = envInt('SUPPORT_COMPANY_MAILBOX_TICK_MS', 60_000);
/** Messages handled per sync; the rest follow on the next tick. 0 = no cap. */
const MAX_PER_SYNC = envInt('SUPPORT_COMPANY_MAILBOX_MAX_PER_SYNC', 50);
/** A message larger than this (MB) becomes a ticket without its body. 0 = no cap. */
const MAX_MESSAGE_MB = envInt('SUPPORT_COMPANY_MAILBOX_MAX_MESSAGE_MB', 25);
const LOCK_TTL_MINUTES = 10;

export interface Mailbox extends MailboxConnection {
    displayName: string;
    active: boolean;
    aiAutoReply: boolean;
    uidValidity: string | null;
    lastUid: number | null;
    syncAfter: string;
}

interface MailboxStore {
    getMailboxWithSecrets: () => Promise<Mailbox | null>;
    acquireSyncLock: (ttl: number) => Promise<boolean>;
    releaseSyncLock: () => Promise<void>;
    setCursor: (c: { uidValidity: string; lastUid: number }) => Promise<void>;
    setSyncResult: (r: { status: 'idle' | 'error'; error?: string | null }) => Promise<void>;
}

const store = (): MailboxStore => nodeRequire('../../stores/supportCompanyMailboxStore.js') as MailboxStore;
const log = nodeRequire('../../telemetry/log.js') as { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

// ── Parsing ─────────────────────────────────────────────────────────────────

export interface NormalizedMail {
    providerMessageId: string;
    rfc822MessageId: string | null;
    inReplyTo: string | null;
    references: string[];
    from: string;
    fromName: string;
    subject: string;
    text: string;
    html: string;
    attachments: Array<{ filename: string; mimeType: string; size: number }>;
    getHeader: (name: string) => string;
}

interface ParsedAddress { value?: Array<{ address?: string; name?: string }> }
export interface ParsedMail {
    messageId?: string;
    inReplyTo?: string;
    references?: string | string[];
    from?: ParsedAddress;
    replyTo?: ParsedAddress;
    subject?: string;
    text?: string;
    html?: string | false;
    attachments?: Array<{ filename?: string; contentType?: string; size?: number }>;
    headerLines?: Array<{ key: string; line: string }>;
}

const firstAddress = (a: ParsedAddress | undefined) => a?.value?.find((v) => v.address) ?? null;

/** A parsed RFC 822 message as the ingest needs it. The requester is Reply-To when there is one (contact forms), else From. */
export function normalizeParsed(p: ParsedMail, { uid, uidValidity }: { uid: number; uidValidity: string }): NormalizedMail {
    const lines = p.headerLines || [];
    const getHeader = (name: string): string => {
        const key = name.toLowerCase();
        const hit = lines.find((h) => h.key === key);
        if (!hit) return '';
        const i = hit.line.indexOf(':');
        return i < 0 ? '' : hit.line.slice(i + 1).trim();
    };
    const sender = firstAddress(p.replyTo) || firstAddress(p.from);
    const refs = Array.isArray(p.references) ? p.references : String(p.references || '').split(/\s+/);
    return {
        providerMessageId: `imap:${uidValidity}:${uid}`,
        rfc822MessageId: p.messageId || null,
        inReplyTo: p.inReplyTo || null,
        references: refs.map((r) => r.trim()).filter(Boolean),
        from: String(sender?.address || '').toLowerCase(),
        fromName: String(sender?.name || ''),
        subject: String(p.subject || '').trim() || '(no subject)',
        text: p.text || '',
        html: typeof p.html === 'string' ? p.html : '',
        attachments: (p.attachments || []).map((a) => ({ filename: String(a.filename || 'attachment'), mimeType: String(a.contentType || ''), size: Number(a.size) || 0 })),
        getHeader,
    };
}

/** The UIDs after the cursor, oldest first, at most `max` (0 = all). `n:*` also returns the newest message when it is below n. */
export function pickUids(found: number[], lastUid: number | null, max: number): number[] {
    const after = lastUid ?? 0;
    const uids = Array.from(new Set(found)).filter((u) => u > after).sort((a, b) => a - b);
    return max > 0 ? uids.slice(0, max) : uids;
}

// ── Ingest ──────────────────────────────────────────────────────────────────

interface Deps {
    supportStore: {
        findCompanyThreadByRfcMessageId: (ids: string[]) => Promise<Row | null>;
        createThread: (t: Row) => Promise<Row>;
        appendMessage: (m: Row) => Promise<Row | null>;
        updateThread: (id: string, patch: Row) => Promise<Row>;
        recordThreadEvent: (e: Row) => Promise<unknown>;
        setThreadSla: (id: string, s: Row) => Promise<unknown>;
    };
    notifyStaff: (n: { title: string; message: string; threadId: string }) => Promise<unknown>;
    emit: (event: string, data: unknown) => void;
    chatNotify: (a: { thread: Row; event: string }) => Promise<unknown>;
    computeSlaDueAt: (t: Row) => Promise<{ first?: unknown; resolution?: unknown } | null>;
    runAi: (threadId: string) => Promise<{ message?: { id: string; body: string }; escalated?: boolean; escalateReason?: string | null } | null>;
    sendReply: typeof sendCompanyReply;
    detectAutoOrBulk: (get: (n: string) => string, o: { fromAddress: string; inboxAddress: string }) => { skip: boolean; reason: string | null };
    htmlToText: (html: string) => string;
}

function defaultDeps(): Deps {
    const r = nodeRequire;
    return {
        supportStore: r('../../stores/supportStore.js'),
        notifyStaff: (r('../../support/notifications.js') as { notifyStaff: Deps['notifyStaff'] }).notifyStaff,
        emit: (r('../../support/events.js') as { emit: Deps['emit'] }).emit,
        chatNotify: (a) => (r('../outboundChatNotifier.js') as { notify: Deps['chatNotify'] }).notify(a),
        computeSlaDueAt: (t) => (r('../supportSlaEnforcer.js') as { computeSlaDueAt: Deps['computeSlaDueAt'] }).computeSlaDueAt(t),
        runAi: (id) => (r('../supportAiResponder.js') as { runAiAutoResponder: Deps['runAi'] }).runAiAutoResponder(id),
        sendReply: sendCompanyReply,
        detectAutoOrBulk: (r('../email/parse.js') as { detectAutoOrBulk: Deps['detectAutoOrBulk'] }).detectAutoOrBulk,
        htmlToText: (r('../supportMailer.js') as { htmlToText: Deps['htmlToText'] }).htmlToText,
    };
}

/** The address in a staff notification: enough to recognise, not the address itself. */
export function maskAddress(addr: string): string {
    const at = addr.indexOf('@');
    if (at < 1) return `${addr.slice(0, 3)}***`;
    return `${addr.slice(0, Math.min(2, at))}***@${addr.slice(at + 1).split('.')[0].slice(0, 1)}***`;
}

const ignore = () => undefined;

/**
 * File one message into the company inbox. Returns what happened, for the
 * log and the tests: 'created' | 'appended' | 'duplicate' | 'skipped:<reason>'.
 */
export async function ingestCompanyMail(n: NormalizedMail, mb: Pick<Mailbox, 'emailAddress' | 'aiAutoReply'>, deps: Deps = defaultDeps()): Promise<string> {
    if (!n.from) return 'skipped:no_sender';
    const auto = deps.detectAutoOrBulk(n.getHeader, { fromAddress: n.from, inboxAddress: mb.emailAddress });
    if (auto.skip) return `skipped:${auto.reason}`;
    const s = deps.supportStore;
    if (n.rfc822MessageId && await s.findCompanyThreadByRfcMessageId([n.rfc822MessageId])) return 'duplicate';

    const refs = [n.inReplyTo, ...n.references].filter((x): x is string => !!x);
    let thread = refs.length ? await s.findCompanyThreadByRfcMessageId(refs) : null;
    const isNew = !thread;
    if (!thread) {
        thread = await s.createThread({
            requesterEmail: n.from,
            requesterName: n.fromName || null,
            source: 'email',
            subject: n.subject,
            inboxId: null,
            rfc822MessageId: n.rfc822MessageId,
        });
        try {
            const due = await deps.computeSlaDueAt(thread);
            if (due && (due.first || due.resolution)) await s.setThreadSla(String(thread.id), { firstDueAt: due.first, resolutionDueAt: due.resolution });
        } catch { /* the SLA is best-effort, the ticket is not */ }
    }
    const threadId = String(thread.id);
    const body = n.text || deps.htmlToText(n.html) || '(no content)';
    const appended = await s.appendMessage({
        threadId,
        authorKind: 'requester',
        authorDisplay: n.fromName || n.from,
        body,
        bodyHtml: n.html || null,
        rfc822MessageId: n.rfc822MessageId,
        inReplyTo: n.inReplyTo,
        emailReferences: n.references.join(' ') || null,
        providerMessageId: n.providerMessageId,
        attachments: n.attachments,
    });
    if (!appended) return 'duplicate';
    s.recordThreadEvent({ threadId, actorKind: 'requester', action: 'reply', payload: { source: 'email', initial: isNew } }).catch(ignore);

    if (isNew) {
        deps.notifyStaff({ title: `New support: ${n.subject}`, message: `Email · ${maskAddress(n.from)}`, threadId }).catch(ignore);
        deps.emit('thread_created', { threadId });
        deps.chatNotify({ thread, event: 'ticket_created' }).catch(ignore);
    } else {
        const wasClosed = thread.status === 'resolved' || thread.status === 'closed';
        await s.updateThread(threadId, wasClosed ? { status: 'awaiting_agent', resolved_at: null } : { status: 'awaiting_agent' });
        if (wasClosed) s.recordThreadEvent({ threadId, actorKind: 'requester', action: 'reopened', payload: { from: thread.status } }).catch(ignore);
        deps.notifyStaff({ title: `Customer replied: ${String(thread.subject || n.subject)}`, message: `Email · ${maskAddress(n.from)}`, threadId }).catch(ignore);
        deps.emit('thread_updated', { threadId });
        deps.chatNotify({ thread, event: 'customer_message' }).catch(ignore);
    }

    // The AI answers a new ticket, or a reply while no person has answered yet.
    const aiOwns = isNew || (!thread.first_response_at && thread.ai_handled === true);
    if (mb.aiAutoReply && aiOwns) void answerWithAi(thread, deps);
    return isNew ? 'created' : 'appended';
}

async function answerWithAi(thread: Row, deps: Deps): Promise<void> {
    const threadId = String(thread.id);
    try {
        const result = await deps.runAi(threadId);
        if (!result?.message) return;
        if (result.escalated) {
            deps.notifyStaff({ title: `AI escalated: ${String(thread.subject || '')}`, message: result.escalateReason || 'AI handed off to staff', threadId }).catch(ignore);
        }
        await deps.sendReply({ id: threadId, source: 'email', inbox_id: null, requester_email: thread.requester_email, subject: thread.subject }, { body: result.message.body, messageId: result.message.id, isAiReply: true });
        deps.emit('thread_updated', { threadId });
    } catch (e) {
        log.warn('[CompanyMailbox] AI reply failed:', (e as Error).message);
    }
}

// ── Sync ────────────────────────────────────────────────────────────────────

type Imap = Awaited<ReturnType<typeof openImap>>;

export interface SyncDeps {
    open: (mb: Mailbox) => Promise<Imap>;
    parse: (source: Buffer) => Promise<ParsedMail>;
    ingest: (n: NormalizedMail, mb: Mailbox) => Promise<string>;
}

function defaultSyncDeps(): SyncDeps {
    const { simpleParser } = nodeRequire('mailparser') as { simpleParser: (s: Buffer, o?: object) => Promise<ParsedMail> };
    return {
        open: (mb) => openImap(mb),
        parse: (source) => simpleParser(source, { skipImageLinks: true, skipTextToHtml: true }),
        ingest: (n, mb) => ingestCompanyMail(n, mb),
    };
}

export interface SyncOutcome { ran: boolean; handled: number; results: string[]; error?: string }

/** One pass over the folder under the lease. Never throws: the outcome lands on the row and is returned. */
export async function syncCompanyMailbox(deps: SyncDeps = defaultSyncDeps()): Promise<SyncOutcome> {
    const st = store();
    if (!await st.acquireSyncLock(LOCK_TTL_MINUTES)) return { ran: false, handled: 0, results: [] };
    const results: string[] = [];
    let client: Imap | null = null;
    try {
        const mb = await st.getMailboxWithSecrets();
        if (!mb || !mb.active) return { ran: false, handled: 0, results };
        client = await deps.open(mb);
        const lock = await client.getMailboxLock(mb.imap.folder || 'INBOX', { readOnly: true });
        try {
            await readFolder(client, mb, deps, results);
        } finally {
            lock.release();
        }
        await st.setSyncResult({ status: 'idle' });
        return { ran: true, handled: results.length, results };
    } catch (e) {
        const message = (e as Error).message || 'sync failed';
        await st.setSyncResult({ status: 'error', error: message }).catch(ignore);
        return { ran: true, handled: results.length, results, error: message };
    } finally {
        if (client) await client.logout().catch(ignore);
        await st.releaseSyncLock().catch(ignore);
    }
}

async function readFolder(client: Imap, mb: Mailbox, deps: SyncDeps, results: string[]): Promise<void> {
    const box = client.mailbox;
    const uidValidity = String(box && typeof box === 'object' ? box.uidValidity : '');
    const fresh = mb.uidValidity !== uidValidity || mb.lastUid == null;
    const since = new Date(mb.syncAfter);
    const found = fresh
        ? await client.search({ since }, { uid: true })
        : await client.search({ uid: `${(mb.lastUid ?? 0) + 1}:*` }, { uid: true });
    const uids = pickUids(Array.isArray(found) ? found : [], fresh ? null : mb.lastUid, MAX_PER_SYNC);
    const maxBytes = MAX_MESSAGE_MB > 0 ? MAX_MESSAGE_MB * 1024 * 1024 : Infinity;
    for (const uid of uids) {
        results.push(await handleOne(client, uid, { mb, uidValidity, fresh, since, maxBytes, deps }));
        await store().setCursor({ uidValidity, lastUid: uid });
    }
}

interface OneCtx { mb: Mailbox; uidValidity: string; fresh: boolean; since: Date; maxBytes: number; deps: SyncDeps }

async function handleOne(client: Imap, uid: number, c: OneCtx): Promise<string> {
    try {
        const meta = await client.fetchOne(String(uid), { uid: true, size: true, internalDate: true, envelope: true }, { uid: true });
        if (!meta) return 'skipped:gone';
        // SEARCH SINCE has day precision: what arrived earlier on the connect day is history.
        const received = meta.internalDate ? new Date(meta.internalDate) : null;
        if (c.fresh && received && received < c.since) return 'skipped:before_connect';
        let parsed: ParsedMail;
        if ((meta.size ?? 0) > c.maxBytes) {
            parsed = tooLarge(meta, c.maxBytes);
        } else {
            const full = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (!full || !full.source) return 'skipped:gone';
            parsed = await c.deps.parse(full.source);
        }
        return await c.deps.ingest(normalizeParsed(parsed, { uid, uidValidity: c.uidValidity }), c.mb);
    } catch (e) {
        log.warn(`[CompanyMailbox] message uid ${uid}:`, (e as Error).message);
        return 'error';
    }
}

/** A message over the size cap: its envelope, and a line that says where the rest is. */
function tooLarge(meta: { size?: number; envelope?: { messageId?: string; inReplyTo?: string; subject?: string; from?: Array<{ address?: string; name?: string }>; replyTo?: Array<{ address?: string; name?: string }> } }, maxBytes: number): ParsedMail {
    const env = meta.envelope || {};
    const mb = Math.round((meta.size ?? 0) / 1024 / 1024);
    return {
        messageId: env.messageId,
        inReplyTo: env.inReplyTo,
        subject: env.subject,
        from: { value: env.from || [] },
        replyTo: { value: env.replyTo || [] },
        text: `(This message is ${mb} MB, over the import limit of ${Math.round(maxBytes / 1024 / 1024)} MB. Open it in the mailbox itself.)`,
        headerLines: [],
    };
}

// ── Tick ────────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;

/** Start the poll. It goes through the runtime module gate, so switching Support off stops it. */
export function startCompanyMailboxSync({ gate }: { gate?: (mod: string, fn: () => Promise<unknown>, label: string) => () => Promise<unknown> } = {}): void {
    if (timer) return;
    const moduleGatedTick = gate || (nodeRequire('../../modules/index.js') as { moduleGatedTick: NonNullable<typeof gate> }).moduleGatedTick;
    const tick = moduleGatedTick('support', async () => {
        const out = await syncCompanyMailbox();
        if (out.error) log.warn('[CompanyMailbox] sync error:', out.error);
        else if (out.handled) log.info(`[CompanyMailbox] handled ${out.handled} message(s)`);
    }, 'supportCompanyMailboxSync');
    const run = () => { tick().catch((e: Error) => log.error('[CompanyMailbox] tick error:', e.message)); };
    timer = setInterval(run, TICK_MS);
    timer.unref?.();
    setTimeout(run, 15_000).unref?.();
}

export function stopCompanyMailboxSync(): void {
    if (timer) { clearInterval(timer); timer = null; }
}
