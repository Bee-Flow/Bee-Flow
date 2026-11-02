/**
 * App Studio action executor — send_email with `mode: "draft"`: the reply is
 * saved as a DRAFT in the mailbox and nothing is sent, so an employee reviews
 * and sends it from Outlook or Gmail themselves.
 *
 * emailStep.js resolves everything that decides WHERE the mail goes (threading,
 * recipients, DLP, identity, attachments) and hands over here at the point where
 * the send would happen. The provider calls live in services/email/draft.mts,
 * which has no send endpoint in it.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../telemetry/log') as { warn: (msg: string) => void };

type Row = Record<string, string | undefined>;
type Recorded = { recordedId: string | null; recordError: string | null };
type Draft = {
    draftId: string; providerMessageId: string; providerThreadId: string | null;
    webLink: string | null; webLinkKind: string | null;
};
type Identity = {
    provider: 'gmail' | 'outlook'; tokens: Record<string, unknown>; onRefresh: (t: unknown) => unknown;
    mailbox: { address: string; displayName?: string; mode?: string };
};

export type DraftStepInput<I extends Identity = Identity> = {
    app: { id: string };
    step: { recordOutbound?: boolean };
    emailSend: { createMailDraft: (p: unknown) => Promise<Draft> };
    identity: I;
    reply: Row | null;
    to: string[]; cc: string[]; subject: string; subjectExplicit: boolean; textBody: string; htmlBody: string;
    attachments?: unknown[];
    record: (mail: {
        sent: { providerMessageId: string; providerThreadId: string; rfc822MessageId: string };
        identity: I; to: string[]; cc: string[]; subject: string; textBody: string; htmlBody: string;
        direction: 'draft';
    }) => Promise<Recorded>;
};

/**
 * Create the draft and, unless the step says otherwise, record it in the thread
 * under its own direction ("draft"): never as "outbound", which is what
 * first-response times, the replied state and the reply de-duplication read.
 */
export async function draftEmailReply<I extends Identity>(p: DraftStepInput<I>) {
    const { identity, reply } = p;
    let draft: Draft;
    try {
        draft = await p.emailSend.createMailDraft({
            provider: identity.provider,
            tokens: identity.tokens,
            onRefresh: identity.onRefresh,
            mailbox: identity.mailbox,
            to: p.to,
            cc: p.cc,
            subject: p.subject,
            subjectExplicit: p.subjectExplicit,
            textBody: p.textBody,
            htmlBody: p.htmlBody,
            inReplyTo: reply?.rfc822_message_id || null,
            references: reply?.references || null,
            providerThreadId: reply?.provider_thread_id || null,
            sourceProviderMessageId: reply?.provider_message_id || null,
            messageIdSeed: reply?.thread_key || p.app.id,
            attachments: p.attachments,
        });
    } catch (err) {
        const e = err as { code?: string; message: string };
        // Actionable and client-visible; anything else is a real failure.
        if (e.code === 'draft_scope_missing') return { ok: false as const, code: e.code, error: e.message };
        throw err;
    }

    let recorded: Recorded = { recordedId: null, recordError: null };
    if (p.step.recordOutbound !== false) {
        recorded = await p.record({
            sent: { providerMessageId: draft.providerMessageId, providerThreadId: draft.providerThreadId || '', rfc822MessageId: '' },
            identity, to: p.to, cc: p.cc, subject: p.subject, textBody: p.textBody, htmlBody: p.htmlBody,
            direction: 'draft',
        });
        if (recorded.recordError) log.warn(`[ActionExecutor] send_email draft saved but could not be recorded on ${p.app.id}`);
    }

    return {
        ok: true as const,
        result: {
            sent: false,
            drafted: true,
            draftId: draft.draftId,
            providerMessageId: draft.providerMessageId,
            providerThreadId: draft.providerThreadId,
            webLink: draft.webLink,
            webLinkKind: draft.webLinkKind,
            recordId: recorded.recordedId,
            recorded: p.step.recordOutbound === false ? null : !!recorded.recordedId,
            ...(recorded.recordError ? { recordError: recorded.recordError } : {}),
            draftedAt: new Date().toISOString(),
        },
    };
}
