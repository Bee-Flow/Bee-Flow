/**
 * Replies from Bee Flow's own company inbox that go out as real email, over
 * the SMTP account of the company mailbox, into the conversation the customer
 * started (In-Reply-To / References of their last message), so their mail
 * client threads it and their answer comes back in on IMAP to the same ticket.
 *
 * Only for tickets that came in by email (source 'email', inbox_id IS NULL)
 * while a mailbox is connected: `usesCompanyMailbox` is the one place that
 * decides it. Every other company ticket keeps the branded notification mail.
 */

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { smtpTransport, describe } from './connection.mts';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
interface MailboxStore {
    getMailbox: () => Promise<{ active: boolean } | null>;
    getMailboxWithSecrets: () => Promise<(import('./connection.mts').MailboxConnection & { displayName: string; active: boolean }) | null>;
}
interface SupportStore {
    getThreadMessages: (threadId: string, opts: { includeInternal: boolean }) => Promise<Row[]>;
    setMessageDelivery: (id: string, d: { emailSendStatus?: unknown; rfc822MessageId?: string | null }) => Promise<void>;
    setMessageEmailStatus: (id: string, status: unknown) => Promise<void>;
}
interface Mailer {
    markdownToHtml: (md: string) => string;
    htmlToText: (html: string) => string;
    buildAiDisclosureHtml: (inbox: { display_name?: string | null; email_address?: string | null }) => string;
    AI_DISCLOSURE_TEXT: string;
}

const mailboxStore = (): MailboxStore => nodeRequire('../../stores/supportCompanyMailboxStore.js') as MailboxStore;
const supportStore = (): SupportStore => nodeRequire('../../stores/supportStore.js') as SupportStore;
const mailer = (): Mailer => nodeRequire('../supportMailer.js') as Mailer;

export interface CompanyThread { id: string; source?: unknown; inbox_id?: unknown; requester_email?: unknown; subject?: unknown }

/** Does a reply to this ticket go out over the company mailbox? */
export async function usesCompanyMailbox(thread: CompanyThread): Promise<boolean> {
    if (thread.source !== 'email' || thread.inbox_id != null) return false;
    const mb = await mailboxStore().getMailbox();
    return !!(mb && mb.active);
}

/** `Re: <subject>`, once. */
export function replySubject(subject: unknown): string {
    const base = String(subject || '').trim() || '(no subject)';
    return /^re:/i.test(base) ? base : `Re: ${base}`;
}

/** The threading headers of a reply: answer the customer's last message that carries a Message-ID. */
export function threadingHeaders(messages: Row[]): { inReplyTo: string | null; references: string[] } {
    const last = [...messages].reverse().find((m) => m.author_kind === 'requester' && typeof m.rfc822_message_id === 'string' && m.rfc822_message_id);
    if (!last) return { inReplyTo: null, references: [] };
    const refs = `${typeof last.email_references === 'string' ? last.email_references : ''} ${String(last.rfc822_message_id)}`
        .split(/\s+/).filter(Boolean);
    return { inReplyTo: String(last.rfc822_message_id), references: Array.from(new Set(refs)) };
}

/** A Message-ID on the mailbox's own domain, so replies to it come back recognisable. */
export function newMessageId(emailAddress: string): string {
    const domain = String(emailAddress).split('@')[1] || 'beeflow.local';
    return `<support-${crypto.randomUUID()}@${domain}>`;
}

export interface SendArgs { body: string; messageId?: string | null; isAiReply?: boolean }

/**
 * Send `body` (Markdown) to the requester of `thread` and record the outcome
 * on the stored message. Throws when nothing was sent; the status on the
 * message says why either way.
 */
export async function sendCompanyReply(thread: CompanyThread, { body, messageId = null, isAiReply = false }: SendArgs): Promise<{ rfc822MessageId: string }> {
    const at = () => new Date().toISOString();
    try {
        const mb = await mailboxStore().getMailboxWithSecrets();
        if (!mb || !mb.active) throw new Error('No company mailbox is connected.');
        const to = String(thread.requester_email || '');
        if (!to) throw new Error('The ticket has no requester address.');
        const msgs = await supportStore().getThreadMessages(thread.id, { includeInternal: false });
        const { inReplyTo, references } = threadingHeaders(msgs);
        const m = mailer();
        let html = m.markdownToHtml(body);
        let text = body;
        if (isAiReply) {
            html += m.buildAiDisclosureHtml({ display_name: mb.displayName, email_address: mb.emailAddress });
            text += `\n\n${m.AI_DISCLOSURE_TEXT}`;
        }
        const rfc822MessageId = newMessageId(mb.emailAddress);
        const transport = await smtpTransport(mb);
        try {
            await transport.sendMail({
                from: { name: mb.displayName || mb.emailAddress, address: mb.emailAddress },
                to,
                subject: replySubject(thread.subject),
                text,
                html,
                messageId: rfc822MessageId,
                inReplyTo: inReplyTo || undefined,
                references: references.length ? references : undefined,
                headers: isAiReply ? { 'Auto-Submitted': 'auto-generated' } : undefined,
            });
        } catch (e) {
            throw describe(e, 'SMTP', mb.smtp.host);
        } finally {
            transport.close();
        }
        if (messageId) {
            await supportStore().setMessageDelivery(messageId, { emailSendStatus: { ok: true, provider: 'smtp', at: at() }, rfc822MessageId });
        }
        return { rfc822MessageId };
    } catch (e) {
        if (messageId) {
            await supportStore().setMessageEmailStatus(messageId, { ok: false, provider: 'smtp', error: (e as Error).message, at: at() }).catch(() => undefined);
        }
        throw e;
    }
}
