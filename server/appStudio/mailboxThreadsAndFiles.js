// @typecheck strict
/**
 * Two phases of one mailbox pull (runMailboxConnector, mailboxConnector.js),
 * between the search and the grains: expanding each conversation the search
 * touched, and listing the attachment METADATA of the messages (no bytes)
 * with the same file seen twice in one conversation dropped.
 */

'use strict';

const { fallback } = require('../utils/bestEffort');

/**
 * @typedef {import('./mailboxConnector').MailboxConnectorConfig} MailboxConnectorConfig
 * @typedef {import('./mailboxConnector').MailMessage} MailMessage
 * @typedef {Awaited<ReturnType<typeof import('./mailboxIdentity').resolveMailboxIdentity>>} MailboxIdentity
 * @typedef {typeof import('../services/email/fetch')} EmailFetch  the mail read layer, passed in by the connector
 * @typedef {{ provider_message_id?: string, thread_key?: string, filename?: string, size?: number, mime_type?: string,
 *   _parentIndex: number, [column: string]: unknown }} AttachmentRow  one attachment row of grain 1 (grain 2 when threaded)
 */

/**
 * The first thread_key seen for each provider thread id.
 * @param {MailMessage[]} messages
 * @returns {Map<string, string>}
 */
function threadKeysByProviderId(messages) {
    /** @type {Map<string, string>} */
    const threadKeyByProviderId = new Map();
    for (const m of messages) {
        if (m.provider_thread_id && m.thread_key && !threadKeyByProviderId.has(m.provider_thread_id)) {
            threadKeyByProviderId.set(m.provider_thread_id, m.thread_key);
        }
    }
    return threadKeyByProviderId;
}

/**
 * Thread mode: pull in the rest of each conversation the search touched, so an
 * unlabelled reply still lands on its ticket. Deduped by message id, and capped
 * (maxExpansions conversations, maxRows messages) so one enormous thread cannot
 * swallow a run. `messages` grows in place; the batch it returns may be cut to
 * maxRows.
 *
 * `partialThreads` are the threads we KNOW we are holding only a slice of:
 * past the expansion cap, unreadable, or cut off by maxRows. Their roll-up
 * columns (message_count, has_unread, first_response_secs) must not be
 * written: a count computed over a slice overwrites a correct 11 with a wrong
 * 3, on every run, for as long as the thread stays busy. Tracked as "known
 * partial" rather than "known complete" on purpose: a mailbox whose provider
 * exposes no thread id has nothing to expand, and then the search result IS
 * everything we can know.
 * @param {MailMessage[]} messages  the search result
 * @param {MailboxIdentity} identity
 * @param {MailboxConnectorConfig} connector
 * @param {{ emailFetch: EmailFetch, maxExpansions: number, maxRows: number }} opts
 * @returns {Promise<{ messages: MailMessage[], partialThreads: Set<string> }>}
 */
async function expandThreads(messages, identity, connector, { emailFetch, maxExpansions, maxRows }) {
    /** @type {Set<string>} */
    const partialThreads = new Set();
    const seen = new Set(messages.map((m) => m.provider_message_id));
    const allThreadIds = [...new Set(messages.map((m) => m.provider_thread_id).filter(Boolean))];
    const threadIds = allThreadIds.slice(0, maxExpansions);

    // Over the expansion cap: everything past it stays as the search left it.
    const threadKeyByProviderId = threadKeysByProviderId(messages);
    for (const id of allThreadIds.slice(maxExpansions)) {
        const key = threadKeyByProviderId.get(/** @type {string} */ (id));
        if (key) partialThreads.add(key);
    }

    for (const threadId of threadIds) {
        try {
            const full = await emailFetch.listThreadMessages({
                provider: identity.provider,
                tokens: identity.tokens,
                onRefresh: identity.onRefresh,
                mailbox: identity.mailbox,
                threadId,
                includeBody: connector.includeBody !== false,
            });
            for (const m of full) {
                if (!m.provider_message_id || seen.has(m.provider_message_id)) continue;
                seen.add(m.provider_message_id);
                messages.push(m);
            }
        } catch {
            // One unreadable thread must not lose the batch — the messages
            // the search already returned are still worth writing. But we
            // do not hold it in full, so its counts stay untouched.
            const key = threadKeyByProviderId.get(/** @type {string} */ (threadId));
            if (key) partialThreads.add(key);
        }
    }
    // Truncating the batch drops messages we DID fetch, so anything past the
    // cut is a slice too.
    if (messages.length > maxRows) {
        for (const m of messages.slice(maxRows)) if (m.thread_key) partialThreads.add(m.thread_key);
        return { messages: messages.slice(0, maxRows), partialThreads };
    }
    return { messages, partialThreads };
}

/**
 * Attachment METADATA plus a PENDING descriptor — still no bytes here. The
 * sync stays cheap and stores nothing a stranger sent; the descriptor is
 * redeemed for real bytes the first time someone opens or parses the file
 * (mailboxAttachments.materializeAttachment). `_parentIndex` relates a child
 * row back to the message the sync engine just wrote. A message whose
 * attachments cannot be listed is skipped (best effort).
 * @param {MailMessage[]} messages
 * @param {MailboxIdentity} identity
 * @param {MailboxConnectorConfig} connector
 * @param {EmailFetch} emailFetch
 * @returns {Promise<AttachmentRow[]>}
 */
async function listAttachmentRows(messages, identity, connector, emailFetch) {
    /** @type {AttachmentRow[]} */
    const attachmentRows = [];
    for (let i = 0; i < messages.length; i++) {
        if (!messages[i].has_attachments) continue;
        try {
            const metas = await emailFetch.listAttachmentMeta({
                provider: identity.provider,
                tokens: identity.tokens,
                onRefresh: identity.onRefresh,
                mailbox: identity.mailbox,
                messageId: messages[i].provider_message_id,
            });
            for (const meta of metas) attachmentRows.push(attachmentRow(meta, messages[i], i, connector));
        } catch (err) { fallback('appStudio/mailboxConnector:runMailboxConnector', err); }
    }
    return attachmentRows;
}

/**
 * One attachment's row: its metadata, the keys that relate it to its message
 * and conversation, and the pending file descriptor.
 * @param {{ provider_attachment_id?: string, filename?: string, size?: number, mime_type?: string, is_inline?: boolean, [k: string]: unknown }} meta
 * @param {MailMessage} message
 * @param {number} index  the message's position in the batch
 * @param {MailboxConnectorConfig} connector
 * @returns {AttachmentRow}
 */
function attachmentRow(meta, message, index, connector) {
    return {
        ...meta,
        // The upsert key — SYNTHESISED, because Gmail's attachment ids are
        // ephemeral tokens that rotate on every fetch: keyed on them the upsert
        // would never match, and every sync would insert the same attachments
        // again, each older generation holding an expired token. This key is
        // stable across runs; the live token rides inside the descriptor below,
        // refreshed on every sync so redemption always has a usable one.
        provider_attachment_id: `${message.provider_message_id}:${meta.filename || ''}:${meta.size ?? ''}`,
        provider_message_id: message.provider_message_id,
        // Denormalised on purpose: an app filters attachments by the
        // conversation it is showing, and walking the relation from a binding
        // filter is not expressible, so without it the filter matches nothing.
        thread_key: message.thread_key,
        // An OBJECT, not JSON text. Serialising a file column is the query
        // compiler's job (coerceValue): text here would be stringified AGAIN
        // on write, one parse would yield a string, and the attachment chain —
        // preview, materialize, AI read — would find "no descriptor".
        file: {
            kind: 'mailbox_attachment',
            connectorId: connector.id,
            messageId: message.provider_message_id,
            attachmentId: meta.provider_attachment_id,
            name: meta.filename,
            mime: meta.mime_type,
            size: meta.size,
            isInline: meta.is_inline,
        },
        _parentIndex: index,
    };
}

/**
 * Drop the same file seen twice in one conversation. A provider's attachment
 * id is per (message, MIME part), so a customer who replies with their invoice
 * still quoted underneath produces a NEW id for the same bytes, and the desk
 * would show it once per message, each downloading separately on first open.
 * Identity here is what a person would use: same name, same size, same type,
 * same conversation. Deliberately not a hash: hashing would mean downloading
 * every attachment at sync time, which is the one thing this design exists to
 * avoid. The first row of each file is kept, in order.
 * @param {AttachmentRow[]} attachmentRows
 * @returns {AttachmentRow[]}
 */
function dedupeAttachmentRows(attachmentRows) {
    const deduped = [];
    const seenFiles = new Set();
    for (const row of attachmentRows) {
        const scope = row.thread_key || row.provider_message_id || '';
        const key = `${scope}|${row.filename || ''}|${row.size ?? ''}|${row.mime_type || ''}`;
        if (seenFiles.has(key)) continue;
        seenFiles.add(key);
        deduped.push(row);
    }
    return deduped;
}

module.exports = { expandThreads, listAttachmentRows, dedupeAttachmentRows };
