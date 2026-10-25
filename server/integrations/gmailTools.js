/**
 * Gmail Tools — Built-in tools for AI to search and read Gmail
 * 
 * These tools are injected into the LLM tool set when the user
 * is logged in with Google, allowing the AI to proactively search
 * and read emails during conversations.
 */

require('googleapis');
require('../auth/permissions');

// The definitions, message shaping, composing, labels and the longer tool
// branches live under ./gmail/; this module keeps the client, search,
// batch reads and bulk changes, the dispatch, and the exported surface.
const { GMAIL_TOOLS } = require('./gmail/toolDefinitions');
const {
    guessMimeTypeFromName, extractAttachments, summarizeSearchMessage, shapeReadMessage,
    SEARCH_METADATA_HEADERS, SEARCH_FIELDS, READ_MANY_MAX_CHARS, READ_MANY_MAX, BULK_MODIFY_MAX, NOT_IN_BULK, GMAIL_MESSAGE_ID,
} = require('./gmail/messageShape');
const { buildRawMessage, sanitizeHeaderValue } = require('./gmail/compose');
const { rememberLabels, resolveLabelIds } = require('./gmail/labels');
const { readAttachment, composeMessage, modifyLabels, setReadOrArchived, createDraft } = require('./gmail/toolHandlers');

// Ids from a binding, the same way every bulk tool reads them (shared/idList.js).
const { idList: messageIdList, isOn } = require('./shared/idList');

/**
 * gmail_read_many: up to 100 full messages through Gmail's batch endpoint (two
 * requests for 100, where one gmail_read per email made 100). Takes the batch
 * function so a test can hand it a fake one.
 * @param {object} session
 * @param {{ messageIds?: unknown }} args
 * @param {{ batch?: Function }} [deps]
 */
async function readManyMessages(session, args, { batch = require('./googleBatch').googleBatch } = {}) {
    const { partError } = require('./googleBatch');
    const all = messageIdList(args?.messageIds);
    const wanted = all.slice(0, READ_MANY_MAX);
    const failed = wanted.filter(id => !GMAIL_MESSAGE_ID.test(id)).map(id => ({ id, error: 'not a Gmail message id' }));
    const valid = wanted.filter(id => GMAIL_MESSAGE_ID.test(id));
    const parts = valid.length > 0
        ? await batch(session, valid.map(id => ({ id, path: `/gmail/v1/users/me/messages/${id}?format=full` })))
        : new Map();
    const messages = [];
    const notFound = [];
    for (const id of valid) {
        const part = parts.get(id);
        if (part && part.status >= 200 && part.status < 300) messages.push(shapeReadMessage(part.body, READ_MANY_MAX_CHARS));
        else if (part?.status === 404) notFound.push(id);
        else failed.push({ id, error: partError(part) });
    }
    const out = { messages, count: messages.length, notFound, failed };
    if (all.length > wanted.length) {
        out.truncated = true;
        out.totalRequested = all.length;
        out.message = `Read the first ${READ_MANY_MAX} of ${all.length} messages; read the rest in another step.`;
    }
    // Nothing could be read at all: say so as an error, so a run does not
    // carry on green with an empty list.
    if (messages.length === 0 && failed.length > 0) {
        out.error = `Could not read any of the ${wanted.length} messages: ${failed[0].error}`;
    }
    return out;
}

/**
 * gmail_bulk_modify: labels, read/unread and archive for up to 1000 messages
 * in ONE users.messages.batchModify request.
 * @param {any} gmail - Gmail client (createGmailClient)
 * @param {object} args
 * @param {object} [labelCacheKey] - the session, so a run resolves label names once a minute
 */
async function bulkModifyMessages(gmail, args, labelCacheKey = null) {
    const ids = messageIdList(args?.messageIds);
    if (ids.length > BULK_MODIFY_MAX) {
        throw new Error(`gmail_bulk_modify changes at most ${BULK_MODIFY_MAX} messages per call (got ${ids.length}). Narrow the search, or split the list.`);
    }
    const invalid = ids.filter(id => !GMAIL_MESSAGE_ID.test(id));
    if (invalid.length > 0) throw new Error(`Not Gmail message ids: ${invalid.slice(0, 3).join(', ')}`);
    if (isOn(args.markRead) && isOn(args.markUnread)) throw new Error('Pick one of markRead and markUnread, not both');
    const add = await resolveLabelIds(gmail, args.addLabelIds, labelCacheKey);
    const remove = await resolveLabelIds(gmail, args.removeLabelIds, labelCacheKey);
    if (isOn(args.markUnread)) add.push('UNREAD');
    if (isOn(args.markRead)) remove.push('UNREAD');
    if (isOn(args.archive)) remove.push('INBOX');
    const addLabelIds = [...new Set(add)];
    const removeLabelIds = [...new Set(remove)];
    // A thousand emails at once is fine for labels, read state and the archive,
    // which are undone the same way. Not for Trash or Spam: in a chat, one
    // instruction hidden in an email could otherwise bin a whole inbox in a
    // single unconfirmed call. That stays gmail_trash, one email at a time.
    const binned = addLabelIds.filter(id => NOT_IN_BULK.has(String(id).toUpperCase()));
    if (binned.length > 0) {
        throw new Error(`gmail_bulk_modify does not move emails to ${binned.join(' or ')}; use gmail_trash per email`);
    }
    const both = addLabelIds.filter(id => removeLabelIds.includes(id));
    if (both.length > 0) throw new Error(`A label cannot be added and removed at once: ${both.join(', ')}`);
    if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
        throw new Error('Nothing to change: give addLabelIds, removeLabelIds, markRead, markUnread or archive');
    }
    // An empty search is not an error: there was simply nothing to change.
    if (ids.length === 0) {
        return { modified: 0, messageIds: [], addLabelIds, removeLabelIds, message: 'No messages to change.' };
    }
    await gmail.users.messages.batchModify({ userId: 'me', requestBody: { ids, addLabelIds, removeLabelIds } });
    return { modified: ids.length, messageIds: ids, addLabelIds, removeLabelIds };
}

/**
 * Create an authenticated Gmail client from session tokens.
 */
async function createGmailClient(session) {
    const { createGoogleApiClient } = require('./googleClient');
    const gmail = await createGoogleApiClient(session, { api: 'gmail', version: 'v1', notConnectedError: 'Not connected to Gmail — user must log in with Google' });
    // Every call spends the account's Gmail quota on our side first, so a
    // fan-out waits briefly instead of hitting 429 and gaxios' retries.
    return require('./gmailQuota').withQuota(gmail, session);
}

/**
 * gmail_search: one messages.list (paged), then each hit's metadata ten at a
 * time. Takes the client, so a test can hand it a fake one.
 * @param {any} gmail - Gmail client (createGmailClient)
 * @param {{ query?: string, maxResults?: number|string }} args
 */
async function searchMessages(gmail, args) {
    const { query } = args;
    // Default 10 keeps interactive/agent use brief; the ceiling is raised
    // to 500 so automations can fan out over many matching emails. A
    // single messages.list page caps at 500, so we page through with
    // nextPageToken to honour large `maxResults` values.
    const want = Math.min(Math.max(parseInt(args.maxResults) || 10, 1), 500);

    const messageIds = [];
    let pageToken;
    let totalEstimate = 0;
    do {
        const page = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: Math.min(want - messageIds.length, 500),
            pageToken,
        });
        totalEstimate = page.data.resultSizeEstimate ?? totalEstimate;
        for (const m of (page.data.messages || [])) messageIds.push(m);
        pageToken = page.data.nextPageToken;
    } while (pageToken && messageIds.length < want);

    if (messageIds.length === 0) {
        return { results: [], total: totalEstimate, query, message: `No emails found for query: "${query}"` };
    }

    // Per-message metadata, ten at a time: each get costs 20 of the
    // account's 6,000 quota units a minute (gmailQuota.js paces them), and
    // `fields` asks for only what summarizeSearchMessage reads (Gmail's
    // performance guide: partial responses).
    const CONCURRENCY = 10;
    const messages = [];
    let unreadable = 0;
    for (let i = 0; i < messageIds.length; i += CONCURRENCY) {
        const batch = await Promise.all(
            messageIds.slice(i, i + CONCURRENCY).map(async (msg) => {
                try {
                    const detail = await gmail.users.messages.get({
                        userId: 'me',
                        id: msg.id,
                        format: 'metadata',
                        metadataHeaders: SEARCH_METADATA_HEADERS,
                        fields: SEARCH_FIELDS,
                    });
                    return summarizeSearchMessage(detail.data);
                } catch {
                    unreadable += 1;
                    return null;
                }
            })
        );
        for (const m of batch) if (m) messages.push(m);
    }

    return {
        results: messages,
        total: totalEstimate || messages.length,
        query,
        // Say it when a message could not be read, instead of a shorter
        // list nobody can tell from a complete one.
        ...(unreadable ? { unreadable } : {}),
    };
}

/**
 * Execute a Gmail tool call.
 * @param {string} toolName - 'gmail_search' / 'gmail_read' / 'gmail_compose' / etc.
 * @param {object} args - Tool arguments
 * @param {object} session - Express session with OAuth tokens
 * @param {object} [opts]
 * @param {boolean} [opts.autoSend=false] - For gmail_compose: when true the tool
 *   actually sends the email (no UI handshake). Set by the automation runner
 *   because there is no user present to confirm a draft. Direct-chat / agent
 *   chat leave this false so the existing email_draft → user-approves → send
 *   flow stays in place as a safety net.
 * @returns {object} Tool result
 */
async function executeGmailTool(toolName, args, session, opts = {}) {
    const gmail = await createGmailClient(session);

    if (toolName === 'gmail_search') {
        return searchMessages(gmail, args);
    } else if (toolName === 'gmail_read') {
        const { messageId } = args;
        if (!messageId) throw new Error('messageId is required');

        const detail = await gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'full',
        });
        return shapeReadMessage(detail.data);

    } else if (toolName === 'gmail_read_many') {
        return readManyMessages(session, args);

    } else if (toolName === 'gmail_read_attachment') {
        return readAttachment(gmail, args);

    } else if (toolName === 'gmail_compose') {
        return composeMessage(gmail, args, session, opts);

    } else if (toolName === 'gmail_list_labels') {
        const res = await gmail.users.labels.list({ userId: 'me' });
        rememberLabels(session, res.data.labels || []);
        const labels = (res.data.labels || []).map(l => ({ id: l.id, name: l.name, type: l.type }));
        return { labels };

    } else if (toolName === 'gmail_bulk_modify') {
        return bulkModifyMessages(gmail, args, session);

    } else if (toolName === 'gmail_modify_labels') {
        return modifyLabels(gmail, args, session);

    } else if (toolName === 'gmail_mark_read' || toolName === 'gmail_mark_unread' || toolName === 'gmail_archive') {
        return setReadOrArchived(gmail, toolName, args);

    } else if (toolName === 'gmail_trash') {
        const { messageId } = args;
        if (!messageId) throw new Error('messageId is required');
        const res = await gmail.users.messages.trash({ userId: 'me', id: messageId });
        return { messageId, trashed: true, labelIds: res.data.labelIds || [] };

    } else if (toolName === 'gmail_create_draft') {
        return createDraft(gmail, args, session);

    } else {
        throw new Error(`Unknown Gmail tool: ${toolName}`);
    }
}

/**
 * Check if a tool name is a Gmail tool.
 */
function isGmailTool(toolName) {
    return [
        'gmail_search', 'gmail_read', 'gmail_read_attachment', 'gmail_compose',
        'gmail_list_labels', 'gmail_modify_labels', 'gmail_mark_read', 'gmail_mark_unread',
        'gmail_archive', 'gmail_trash', 'gmail_create_draft',
        'gmail_read_many', 'gmail_bulk_modify',
    ].includes(toolName);
}

/**
 * Resolve a `gmail_attachment` sourceHandle back to raw bytes. Lets
 * downstream tools (drive_upload_file, nextcloud_upload_file, …) forward
 * an attachment without round-tripping the base64 through the AI context.
 */
async function fetchAttachmentBuffer(session, { messageId, attachmentId }) {
    if (!messageId || !attachmentId) {
        throw new Error('fetchAttachmentBuffer: messageId and attachmentId are required');
    }
    const gmail = await createGmailClient(session);
    const attachment = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachmentId,
    });
    const base64Data = attachment.data.data;
    if (!base64Data) throw new Error('Attachment data is empty');
    // Gmail returns URL-safe base64; Buffer accepts standard base64.
    const standardBase64 = base64Data.replace(/-/g, '+').replace(/_/g, '/');
    const buffer = Buffer.from(standardBase64, 'base64');
    return { buffer, size: attachment.data.size || buffer.length };
}

module.exports = {
    GMAIL_TOOLS,
    executeGmailTool,
    isGmailTool,
    createGmailClient,
    searchMessages,
    extractAttachments,
    fetchAttachmentBuffer,
    // exposed for tests
    guessMimeTypeFromName,
    resolveLabelIds,
    buildRawMessage,
    sanitizeHeaderValue,
    summarizeSearchMessage,
    SEARCH_METADATA_HEADERS,
    shapeReadMessage,
    messageIdList,
    readManyMessages,
    bulkModifyMessages,
};

/**
 * @typedef {import('./gmail/messageShape').GmailClient} GmailClient
 * @typedef {import('./gmail/toolHandlers').GmailSession} GmailSession
 */
