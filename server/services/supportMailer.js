/**
 * Support Mailer — outbound replies for the tenant Support inbox.
 *
 * Since the shared send layer was extracted (services/email/send.js) this file
 * is a thin adapter: it resolves the inbox row + its decrypted tokens, applies
 * the SUPPORT-specific presentation rules (signature, AI-disclosure footer,
 * "Re:" prefixing) and delegates the wire work.
 *
 * It deliberately pins `replyStrategy: 'createReply'` and `mode: 'personal'` so
 * the extraction changed nothing here. Note that `createReply` requires
 * Mail.ReadWrite while the mailbox consent (MS_SCOPES) only asks for
 * Mail.Read/Mail.Send — that mismatch predates the extraction and is frozen on
 * purpose; switching this to the cheaper `'reply'` strategy is a separate,
 * verifiable change. services/supportMailer.test.js is the golden test that
 * holds this contract still.
 */

const {
    sendMailMessage,
    sanitizeHtml,
    textToHtml,
    markdownToHtml,
    htmlToText,
    _escapeHtml,
} = require('./email/send');
const supportInboxStore = require('../stores/supportInboxStore');

/**
 * AI-disclosure footer appended to EVERY automatic AI reply (not to human-sent
 * staff replies). Makes it unambiguous that the message was written by an AI
 * assistant and that a human can take over — satisfies AI-transparency
 * expectations and sets the right tone. Inline styles only (email clients strip
 * <style>); neutral greys, no brand-clashing colours.
 */
function buildAiDisclosureHtml(inbox) {
    const name = (inbox.display_name && inbox.display_name.trim()) || inbox.email_address || 'Support';
    return `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;`
        + `color:#6b7280;font-size:12px;line-height:1.5;`
        + `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">`
        + `<div style="font-weight:600;color:#374151;margin-bottom:2px">${_escapeHtml(name)}</div>`
        + `<div><span aria-hidden="true">🤖</span> Dit antwoord is automatisch opgesteld door onze AI-assistent. `
        + `Klopt er iets niet, of spreek je liever een collega? Antwoord dan gewoon op deze e-mail — een medewerker kijkt mee.</div>`
        + `</div>`;
}

const AI_DISCLOSURE_TEXT =
    '— Dit antwoord is automatisch opgesteld door onze AI-assistent. Antwoord gerust op deze e-mail; een medewerker kijkt mee.';

const SUPPORTED_PROVIDERS = new Set(['gmail', 'outlook']);

/**
 * Send a reply from a connected inbox into a thread's conversation.
 *
 * @param {string} inboxId
 * @param {object} thread  support_threads row (needs id, requester_email, subject, provider_thread_id)
 * @param {object} opts    { bodyText, bodyHtml, subject?, inReplyTo?, references?, sourceProviderMessageId?, isAiReply? }
 * @returns {Promise<{providerMessageId, providerThreadId, rfc822MessageId, status}>}
 */
async function sendReply(inboxId, thread, opts = {}) {
    const inbox = await supportInboxStore.getInboxWithTokens(inboxId);
    if (!inbox) throw new Error('Inbox not found');
    if (!inbox.tokens || !inbox.tokens.accessToken) throw new Error('Inbox is not connected — reconnect the mailbox.');
    if (!SUPPORTED_PROVIDERS.has(inbox.provider)) throw new Error(`Unsupported provider: ${inbox.provider}`);

    const onRefresh = (t) => supportInboxStore.updateTokens(inbox.id, t).catch(() => {});
    const baseSubject = opts.subject || thread.subject || '(no subject)';
    const subject = /^\s*re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`;
    const sig = inbox.signature ? String(inbox.signature) : '';
    // Agent/staff bodies are Markdown → render to HTML so the email isn't a wall
    // of literal **bold** and "1." markers. The signature is authored as HTML.
    // AI auto-replies (isAiReply) get an automatic AI-disclosure footer; human
    // staff replies do not (a person reviewed + sent them).
    let htmlBody = (opts.bodyHtml || markdownToHtml(opts.bodyText));
    if (sig) htmlBody += `<br><br>${sig}`;
    if (opts.isAiReply) htmlBody += buildAiDisclosureHtml(inbox);
    let textBody = (opts.bodyText || htmlToText(opts.bodyHtml));
    if (sig) textBody += `\n\n${htmlToText(sig)}`;
    if (opts.isAiReply) textBody += `\n\n${AI_DISCLOSURE_TEXT}`;

    const result = await sendMailMessage({
        provider: inbox.provider,
        tokens: inbox.tokens,
        onRefresh,
        mailbox: {
            address: inbox.email_address,
            displayName: inbox.display_name,
            // The support inbox owns its mailbox outright — never a delegated one.
            mode: 'personal',
        },
        to: thread.requester_email,
        subject,
        textBody,
        htmlBody,
        inReplyTo: opts.inReplyTo,
        references: opts.references,
        sourceProviderMessageId: opts.sourceProviderMessageId,
        providerThreadId: thread.provider_thread_id,
        messageIdSeed: thread.id,
        replyStrategy: 'createReply',
    });

    return { ...result, status: { ok: true, provider: inbox.provider, at: new Date().toISOString() } };
}

module.exports = { sendReply, sanitizeHtml, htmlToText, textToHtml, markdownToHtml };
