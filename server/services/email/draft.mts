/**
 * Save a reply as a DRAFT in the mailbox instead of sending it (send_email
 * mode "draft"): an employee reviews and sends it from Outlook or Gmail.
 *
 * Nothing here ever sends. Outlook creates a message in Drafts (createReply on
 * the original message, so the quoted history and the conversation stay; a
 * plain POST /messages without one); Gmail files a raw MIME message with
 * users.drafts.create. The send endpoints (/send, /sendMail, /reply,
 * users.messages.send) are not referenced in this file, and the test for it
 * keeps it that way.
 *
 * Scopes: a draft is a WRITE to the mailbox. Graph needs Mail.ReadWrite (or
 * Mail.ReadWrite.Shared for a shared mailbox), which is not the Mail.Send the
 * send path lives on; Gmail needs gmail.compose or gmail.modify, not gmail.send.
 * The stored token says what it was granted, and a known gap fails here with a
 * clear code BEFORE the first call. An unknown scope (an older credential stored
 * without one) is let through, as outlookMailbox.assertSharedScopes does.
 */

import { createRequire } from 'node:module';
import { graphAttachments } from './graphAttachments.mts';
import type { MailAttachment } from './graphAttachments.mts';

const nodeRequire = createRequire(import.meta.url);

type HttpErrorCtor = new (status: number, code: string, message: string) => Error & { status: number; code: string };
const { HttpError } = nodeRequire('../../core/http/errors.js') as { HttpError: HttpErrorCtor };

type Tokens = { accessToken?: string | null; refreshToken?: string | null; scope?: string | null };
type OnRefresh = (tokens: Tokens) => unknown;
type GraphFetch = (tokens: Tokens, onRefresh: OnRefresh | null, path: string, opts?: { method: string; body?: string }) => Promise<GraphMessage>;
type GmailClient = {
    users: { drafts: { create: (p: { userId: string; requestBody: { message: { raw: string; threadId?: string } } }) => Promise<{
        data: { id?: string | null; message?: { id?: string | null; threadId?: string | null } };
    }> } };
};
type GraphMessage = {
    id?: string; webLink?: string; conversationId?: string; subject?: string;
    toRecipients?: { emailAddress?: { address?: string } }[];
    ccRecipients?: { emailAddress?: { address?: string } }[];
};

export type DraftMailbox = { address: string; displayName?: string; mode?: string };

export type DraftInput = {
    provider: 'gmail' | 'outlook';
    tokens: Tokens;
    onRefresh: OnRefresh;
    mailbox: DraftMailbox;
    to: string[];
    cc?: string[];
    subject: string;
    /** The subject came from the step, not from the original message: set it on the reply draft. */
    subjectExplicit?: boolean;
    textBody: string;
    htmlBody: string;
    inReplyTo?: string | null;
    references?: string | null;
    providerThreadId?: string | null;
    /** The message being answered (Graph id): a reply draft hangs off it. */
    sourceProviderMessageId?: string | null;
    messageIdSeed?: string;
    attachments?: MailAttachment[];
};

export type DraftResult = {
    provider: 'gmail' | 'outlook';
    /** Outlook: the draft message id. Gmail: the draft id (users.drafts). */
    draftId: string;
    /** The id the mailbox lists the message under (the same as draftId for Outlook). */
    providerMessageId: string;
    providerThreadId: string | null;
    /** A link that opens the draft in the web client. */
    webLink: string | null;
    /** 'outlook_web' (Graph webLink) or 'gmail_compose' (built, best effort). */
    webLinkKind: 'outlook_web' | 'gmail_compose' | null;
};

export const DRAFT_SCOPE_MISSING_CODE = 'draft_scope_missing';

const OUTLOOK_DRAFT_SCOPE_TEXT = 'Saving a draft needs write access to the mailbox: the Mail.ReadWrite permission (Mail.ReadWrite.Shared for a shared mailbox), which this Microsoft connection does not have. Once your administrator has added the permission to the Microsoft app, reconnect Microsoft in Settings → Connections.';
const GMAIL_DRAFT_SCOPE_TEXT = 'Saving a draft needs the Gmail compose permission. Reconnect Google in Settings → Connections and approve the Gmail compose access.';

/** Graph reports scopes bare or as `https://graph.microsoft.com/Mail.ReadWrite`; compare case-insensitively on the bare name. */
function scopeSet(scope: string): Set<string> {
    return new Set(scope.split(/[\s,]+/).filter(Boolean).map((s) => s.toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//, '')));
}

/**
 * Throw a clear 403 when the connection is KNOWN to lack what a draft needs.
 * An empty or unknown scope passes (the provider then answers for itself).
 */
export function assertDraftScope(provider: string, scope: string | null | undefined, mailbox?: { mode?: string }): void {
    const text = typeof scope === 'string' ? scope.trim() : '';
    if (!text) return;
    const granted = scopeSet(text);
    if (provider === 'outlook') {
        const needed = mailbox?.mode === 'shared' ? 'mail.readwrite.shared' : 'mail.readwrite';
        // The shared mailbox has its own permission; Mail.ReadWrite covers only the signed-in user's own.
        if (!granted.has(needed)) throw new HttpError(403, DRAFT_SCOPE_MISSING_CODE, OUTLOOK_DRAFT_SCOPE_TEXT);
        return;
    }
    if (provider === 'gmail') {
        const ok = ['gmail.compose', 'gmail.modify'].some((s) => granted.has(`https://www.googleapis.com/auth/${s}`) || granted.has(s))
            || granted.has('https://mail.google.com/');
        if (!ok) throw new HttpError(403, DRAFT_SCOPE_MISSING_CODE, GMAIL_DRAFT_SCOPE_TEXT);
    }
}

const addressesOf = (list: GraphMessage['toRecipients']): string[] =>
    (list || []).map((r) => String(r.emailAddress?.address || '').toLowerCase()).filter(Boolean);

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

async function draftViaOutlook(p: DraftInput, send: typeof import('./send.js'), graphFetch: GraphFetch): Promise<DraftResult> {
    const html = send.sanitizeHtml(p.htmlBody);
    // Built before the first call, so a refusal (over 3 MB) never leaves a half-made draft.
    const files = graphAttachments(p.attachments);
    const base = p.mailbox.mode === 'shared' && p.mailbox.address
        ? `/users/${encodeURIComponent(p.mailbox.address)}`
        : '/me';
    const call = (path: string, method: string, body?: unknown) =>
        graphFetch(p.tokens, p.onRefresh, `${base}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

    const toList = p.to.map((a) => a.toLowerCase());
    const ccList = (p.cc || []).map((a) => a.toLowerCase());
    let draft: GraphMessage;
    if (p.sourceProviderMessageId) {
        // The body goes in as `comment`, which Graph puts above the quoted history.
        draft = await call(`/messages/${encodeURIComponent(p.sourceProviderMessageId)}/createReply`, 'POST', { comment: html });
        if (!draft.id) throw new Error('Outlook did not return the draft.');
        const patch: Record<string, unknown> = {};
        if (!sameSet(addressesOf(draft.toRecipients), toList)) patch.toRecipients = send.graphRecipients(p.to);
        if (!sameSet(addressesOf(draft.ccRecipients), ccList)) patch.ccRecipients = send.graphRecipients(p.cc);
        if (p.subjectExplicit) patch.subject = send.stripHeaderValue(p.subject);
        if (Object.keys(patch).length) await call(`/messages/${encodeURIComponent(draft.id)}`, 'PATCH', patch);
    } else {
        draft = await call('/messages', 'POST', {
            subject: send.stripHeaderValue(p.subject),
            body: { contentType: 'HTML', content: html },
            toRecipients: send.graphRecipients(p.to),
            ...(ccList.length ? { ccRecipients: send.graphRecipients(p.cc) } : {}),
        });
        if (!draft.id) throw new Error('Outlook did not return the draft.');
    }
    const draftId = draft.id;
    for (const file of files) await call(`/messages/${encodeURIComponent(draftId)}/attachments`, 'POST', file);

    let webLink = draft.webLink || null;
    let conversationId = draft.conversationId || null;
    if (!webLink) {
        const got = await call(`/messages/${encodeURIComponent(draftId)}?$select=webLink,conversationId`, 'GET');
        webLink = got.webLink || null;
        conversationId = conversationId || got.conversationId || null;
    }
    return {
        provider: 'outlook',
        draftId,
        providerMessageId: draftId,
        providerThreadId: conversationId || p.providerThreadId || null,
        webLink,
        webLinkKind: webLink ? 'outlook_web' : null,
    };
}

async function draftViaGmail(p: DraftInput, send: typeof import('./send.js'), gmailClient: (t: Tokens, r: OnRefresh) => Promise<GmailClient>): Promise<DraftResult> {
    const gmail = await gmailClient(p.tokens, p.onRefresh);
    const raw = await send.buildRawMime({
        fromName: p.mailbox.displayName,
        fromEmail: p.mailbox.address,
        to: send.toRecipientList(p.to).join(', '),
        cc: send.toRecipientList(p.cc).join(', ') || undefined,
        subject: send.stripHeaderValue(p.subject),
        text: p.textBody,
        html: send.sanitizeHtml(p.htmlBody),
        inReplyTo: p.inReplyTo || undefined,
        references: send.buildReferenceChain(p.references || undefined, p.inReplyTo || undefined),
        messageId: send.mintMessageId(p.messageIdSeed || 'draft', p.mailbox.address),
        attachments: p.attachments as never,
    } as never) as Buffer;
    const encoded = raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const message: { raw: string; threadId?: string } = { raw: encoded };
    if (p.providerThreadId) message.threadId = p.providerThreadId;
    const res = await gmail.users.drafts.create({ userId: 'me', requestBody: { message } });
    const draftId = res.data.id || '';
    const messageId = res.data.message?.id || '';
    if (!draftId) throw new Error('Gmail did not return the draft.');
    return {
        provider: 'gmail',
        draftId,
        providerMessageId: messageId || draftId,
        providerThreadId: res.data.message?.threadId || p.providerThreadId || null,
        // Gmail has no webLink field: this is the compose deep link for the draft's message id,
        // scoped to the mailbox with /u/<address>/. Built, not returned by the API.
        webLink: messageId ? `https://mail.google.com/mail/u/${encodeURIComponent(p.mailbox.address)}/#drafts?compose=${encodeURIComponent(messageId)}` : null,
        webLinkKind: messageId ? 'gmail_compose' : null,
    };
}

/** Graph/Gmail refused the write: say what to do instead of showing a raw 403. */
function explainRefusal(err: unknown, provider: string): unknown {
    const status = (err as { status?: number; code?: number })?.status ?? (err as { code?: number })?.code;
    if (status !== 403) return err;
    return new HttpError(403, DRAFT_SCOPE_MISSING_CODE, provider === 'outlook' ? OUTLOOK_DRAFT_SCOPE_TEXT : GMAIL_DRAFT_SCOPE_TEXT);
}

/**
 * Create the draft. Never sends. Throws HttpError(403, 'draft_scope_missing')
 * before any call when the stored scope is known to be too narrow.
 */
export async function createMailDraft(p: DraftInput): Promise<DraftResult> {
    if (p.provider !== 'gmail' && p.provider !== 'outlook') throw new Error(`Unsupported provider: ${p.provider}`);
    if (!p.tokens || !p.tokens.accessToken) throw new Error('Mailbox is not connected — reconnect the mailbox.');
    if (!p.mailbox?.address) throw new Error('No mailbox address to save the draft in.');
    assertDraftScope(p.provider, p.tokens.scope, p.mailbox);

    const send = nodeRequire('./send.js') as typeof import('./send.js');
    const clients = nodeRequire('./providerClients.js') as { graphFetchFromTokens: GraphFetch; gmailClientFromTokens: (t: Tokens, r: OnRefresh) => Promise<GmailClient> };
    try {
        return p.provider === 'outlook'
            ? await draftViaOutlook(p, send, clients.graphFetchFromTokens)
            : await draftViaGmail(p, send, clients.gmailClientFromTokens);
    } catch (err) {
        throw explainRefusal(err, p.provider);
    }
}
