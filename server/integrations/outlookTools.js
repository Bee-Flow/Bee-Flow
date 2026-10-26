// @typecheck
/**
 * Outlook Tools — Built-in tools for AI to search, read, and compose Outlook emails
 * 
 * Mirror of gmailTools.js for Microsoft 365 users.
 * Uses Microsoft Graph API v1.0 with OAuth2 tokens from session.
 */

const { graphFetch, graphBatch, isMicrosoftConnected } = require('./msGraphClient');
const { idList } = require('./shared/idList');
const log = require('../telemetry/log');
const { GRAPH_ID_RE, MESSAGE_ID_TEXT, FOLDER_TEXT, assertGraphId } = require('./graphIds');
// Own mailbox ("me") or a shared one: the address rule, the Graph path, the
// scope check and the error wording all come from one place.
const {
    MAILBOX_PARAM, parseMailbox, mailboxBase, assertSharedScopes, mapGraphMailboxError, mailboxLogRef,
} = require('../core/integrations/outlookMailbox.mts');
// Sending, replying and saving a draft (the approval card's route uses them too).
const { buildOutlookMessage, executeOutlookSend, executeOutlookSaveDraft } = require('./outlookSend');

/**
 * Tool definitions in OpenAI function-calling format.
 */
const OUTLOOK_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'outlook_search',
            description: 'Search the user\'s Outlook inbox for emails matching a query. Returns a list of email summaries (sender, subject, date, preview). Supports KQL (Keyword Query Language) search syntax and plain keywords.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query (supports keywords, from:, subject:, hasAttachments:true, received>=2025-01-01, etc.)'
                    },
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum number of results to return (1-20, default 10)'
                    },
                    mailbox: { ...MAILBOX_PARAM },
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'outlook_read',
            description: 'Read the full content of a specific Outlook email by its message ID. Use this after outlook_search to get the complete body of an email.',
            parameters: {
                type: 'object',
                properties: {
                    messageId: {
                        type: 'string',
                        description: 'The Outlook message ID to read (from outlook_search results)'
                    },
                    mailbox: { ...MAILBOX_PARAM },
                },
                required: ['messageId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'outlook_read_many',
            description: 'Read the full content of many Outlook emails at once (up to 100): Microsoft Graph is asked 20 at a time, so 40 emails cost two requests instead of 40 (plus the attachment lists, also 20 per request). Pass the message ids from outlook_search or outlook_list_recent (`results[*].id`). Returns `messages`, each shaped exactly like outlook_read; a body is cut at 20,000 characters. Ids Outlook does not know are listed in `notFound`. In an automation, use this instead of running outlook_read once per email.',
            parameters: {
                type: 'object',
                properties: {
                    messageIds: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Outlook message ids, at most 100 (e.g. the `id` of every outlook_search result). A list of search results works too: each one\'s id is used.'
                    },
                    mailbox: { ...MAILBOX_PARAM },
                },
                required: ['messageIds']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'outlook_list_recent',
            description: 'List the most recent emails from the user\'s Outlook mailbox, sorted by date (newest first). Use this when the user asks about their latest/newest/most recent emails (including recently sent ones), or when outlook_search doesn\'t return the very latest messages. For "latest sent email" / "most recent email I sent" set folder to "sentitems". Always prefer this over outlook_search for recency-based questions.',
            parameters: {
                type: 'object',
                properties: {
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum number of results to return (1-20, default 10)'
                    },
                    folder: {
                        type: 'string',
                        description: 'Mail folder to list from (default: "inbox"). Common values: inbox, sentitems, drafts, junkemail, deleteditems'
                    },
                    unreadOnly: {
                        type: 'boolean',
                        description: 'If true, only return unread emails (default: false)'
                    },
                    since: {
                        type: 'string',
                        description: 'Optional ISO date/time: only emails received (sent, for sentitems) at or after this moment, e.g. "2026-01-01T00:00:00Z"'
                    },
                    maxPages: {
                        type: 'integer',
                        description: 'Optional: follow Graph paging for up to this many pages (1-10, default 1). Above 1, maxResults may go up to 200.'
                    },
                    mailbox: { ...MAILBOX_PARAM },
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'outlook_compose',
            description: 'Compose and send a new email or reply to an existing email. In a chat the user sees a preview with Send and Discard buttons before anything is sent; in an unattended run (automation, scheduled agent) the email is sent directly. IMPORTANT: When replying, set replyToMessageId to the original message ID. For replies, prefix subject with "Re: ". For forwarding, prefix with "Fwd: " and include the original email body.',
            parameters: {
                type: 'object',
                properties: {
                    to: {
                        type: 'string',
                        description: 'Recipient email address(es), comma-separated for multiple'
                    },
                    cc: {
                        type: 'string',
                        description: 'Optional: CC recipient email address(es), comma-separated'
                    },
                    bcc: {
                        type: 'string',
                        description: 'Optional: BCC recipient email address(es), comma-separated'
                    },
                    subject: {
                        type: 'string',
                        description: 'Email subject line. For replies use "Re: <original subject>", for forwards use "Fwd: <original subject>"'
                    },
                    body: {
                        type: 'string',
                        description: 'Email body text (plain text). For forwards, include the original email content.'
                    },
                    replyToMessageId: {
                        type: 'string',
                        description: 'For replies: Outlook message ID of the email being replied to (from outlook_search or outlook_read results). Omit for new emails.'
                    },
                    mailbox: { ...MAILBOX_PARAM },
                },
                required: ['to', 'subject', 'body']
            }
        }
    }
];

/**
 * Strip HTML tags from email body and normalize whitespace.
 */
function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

/** What outlook_read and outlook_read_many ask Graph for, and how much of a body they keep. */
const READ_SELECT = 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,conversationId';
const ATTACHMENT_SELECT = 'id,name,contentType,size';
const READ_MAX_CHARS = 50000;
const READ_MANY_MAX_CHARS = 20000;
/** Ids per outlook_read_many call (five batches of 20). */
const READ_MANY_MAX = 100;

/**
 * A Graph message as outlook_read returns it, without its attachments (they
 * come from a second request). outlook_read and outlook_read_many both shape
 * through here, so one email reads the same either way.
 */
function shapeOutlookMessage(msg, maxChars = READ_MAX_CHARS) {
    const body = msg.body?.contentType === 'text' ? (msg.body.content || '') : stripHtml(msg.body?.content || '');
    return {
        id: msg.id,
        from: msg.from?.emailAddress ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address}>` : '',
        to: (msg.toRecipients || []).map(r => `${r.emailAddress?.name || ''} <${r.emailAddress?.address}>`).join(', '),
        cc: (msg.ccRecipients || []).map(r => r.emailAddress?.address).filter(Boolean).join(', '),
        subject: msg.subject || '(no subject)',
        date: msg.receivedDateTime || '',
        body: body.length > maxChars
            ? body.substring(0, maxChars) + '\n\n[... truncated, email too large ...]'
            : body,
        conversationId: msg.conversationId || null,
        hasAttachments: msg.hasAttachments || false,
    };
}

/** Graph's attachment list (value[]) the way outlook_read lists attachments. */
function shapeOutlookAttachments(list) {
    return (list || []).map(a => ({
        id: a.id,
        filename: a.name,
        mimeType: a.contentType,
        size: a.size || 0,
        canOCR: a.contentType === 'application/pdf',
    }));
}

/** The error of a failed batched request, in Graph's words when it gave some. */
function batchError(res) {
    return res?.body?.error?.message || (res?.status ? `HTTP ${res.status}` : 'no answer from Microsoft Graph');
}

/**
 * outlook_read_many: up to 100 messages through Graph JSON batching, then the
 * attachment lists of those that have any, also batched. Two to ten requests
 * for 100 emails, where outlook_read made up to 200.
 * @param {object} session - a Microsoft session (SSO or the vault shim)
 * @param {{ messageIds?: unknown, mailbox?: unknown }} args
 * @param {{ batch?: Function }} [deps]
 */
async function readManyOutlookMessages(session, args, { batch = graphBatch } = {}) {
    const mailbox = parseMailbox(args?.mailbox);
    const base = mailboxBase(mailbox);
    const all = idList(args?.messageIds);
    const wanted = all.slice(0, READ_MANY_MAX);
    const failed = wanted.filter(id => !GRAPH_ID_RE.test(id)).map(id => ({ id, error: MESSAGE_ID_TEXT }));
    const valid = wanted.filter(id => GRAPH_ID_RE.test(id));
    // Batch request ids are positions: a Graph message id can be 150+ characters.
    const reads = valid.length > 0
        ? await batch(session, valid.map((id, i) => ({ id: String(i), url: `${base}/messages/${id}?$select=${READ_SELECT}` })))
        : new Map();
    // A shared mailbox the user cannot open answers 403 on every request in
    // the batch: that is one fact about the mailbox, not a hundred failed ids.
    if (mailbox.shared && [...reads.values()].some(res => res?.status === 403)) {
        throw mapGraphMailboxError({ status: 403 }, mailbox);
    }
    const found = [];
    const notFound = [];
    valid.forEach((id, i) => {
        const res = reads.get(String(i));
        if (res && res.status >= 200 && res.status < 300 && res.body) found.push(res.body);
        else if (res?.status === 404) notFound.push(id);
        else failed.push({ id, error: batchError(res) });
    });
    const withFiles = found.filter(msg => msg.hasAttachments);
    const lists = withFiles.length > 0
        ? await batch(session, withFiles.map((msg, i) => ({ id: String(i), url: `${base}/messages/${msg.id}/attachments?$select=${ATTACHMENT_SELECT}` })))
        : new Map();
    const attachmentsOf = new Map(withFiles.map((msg, i) => {
        const res = lists.get(String(i));
        // A list that would not load leaves the email readable, as in outlook_read.
        return [msg, res && res.status >= 200 && res.status < 300 ? shapeOutlookAttachments(res.body?.value) : []];
    }));
    const messages = found.map(msg => {
        const shaped = shapeOutlookMessage(msg, READ_MANY_MAX_CHARS);
        if (msg.hasAttachments) shaped.attachments = attachmentsOf.get(msg) || [];
        return shaped;
    });
    const out = { messages, count: messages.length, notFound, failed };
    if (all.length > wanted.length) {
        out.truncated = true;
        out.totalRequested = all.length;
        out.message = `Read the first ${READ_MANY_MAX} of ${all.length} messages; read the rest in another step.`;
    }
    if (messages.length === 0 && failed.length > 0) {
        out.error = `Could not read any of the ${wanted.length} messages: ${failed[0].error}`;
    }
    return out;
}

const LIST_RECENT_SELECT = 'id,subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,hasAttachments,isRead';
const LIST_RECENT_MAX_PAGES = 10;
const LIST_RECENT_PAGED_CAP = 200;
const LIST_RECENT_PAGE_SIZE = 50;
const GRAPH_NEXT_LINK_PREFIX = 'https://graph.microsoft.com/';

/** The lower bound that lets unreadOnly lead with the date field without narrowing anything. */
const OPEN_LOWER_BOUND = '1900-01-01T00:00:00Z';

/**
 * outlook_list_recent. One page of at most 20 by default, as it always was.
 * With maxPages > 1 it follows @odata.nextLink (Graph's own continuation URL,
 * so the filter and order carry over) until maxResults (cap 200) or the page
 * cap is reached. `since` becomes a `ge` filter on the folder's date field;
 * Graph wants the $orderby property first in $filter, so it leads.
 *
 * @param {{ maxResults?: number|string, folder?: string, unreadOnly?: boolean, since?: string|null, maxPages?: number|string }} args - tool arguments
 * @param {(path: string) => Promise<any>} fetchPage - Graph GET (path or absolute nextLink URL)
 * @param {string} [base] - the mailbox's Graph prefix: `/me` (default) or `/users/{address}`
 */
async function listRecentMessages(args, fetchPage, base = '/me') {
    const { maxResults = 10, folder = 'inbox', unreadOnly = false, since } = args || {};
    const maxPages = Math.min(Math.max(parseInt(args?.maxPages) || 1, 1), LIST_RECENT_MAX_PAGES);
    const want = maxPages > 1
        ? Math.min(Math.max(parseInt(maxResults) || 10, 1), LIST_RECENT_PAGED_CAP)
        : Math.min(Math.max(parseInt(maxResults) || 10, 1), 20);
    const top = Math.min(want, LIST_RECENT_PAGE_SIZE);

    assertGraphId(folder, FOLDER_TEXT);
    const isSentFolder = String(folder).toLowerCase() === 'sentitems';
    const orderField = isSentFolder ? 'sentDateTime' : 'receivedDateTime';

    let sinceIso = null;
    if (since !== undefined && since !== null && since !== '') {
        const ms = Date.parse(String(since));
        if (!Number.isFinite(ms)) throw new Error('since must be an ISO date/time');
        sinceIso = new Date(ms).toISOString();
    }

    // Graph refuses a $filter that sorts by a field it does not filter on first
    // ("InefficientFilter"), so the date field always leads once there is a
    // filter: the caller's `since`, or for unreadOnly alone an open lower bound.
    const filters = [];
    if (sinceIso) filters.push(`${orderField} ge ${sinceIso}`);
    else if (unreadOnly) filters.push(`${orderField} ge ${OPEN_LOWER_BOUND}`);
    if (unreadOnly) filters.push('isRead eq false');

    let path = `${base}/mailFolders/${folder}/messages?$top=${top}&$orderby=${orderField} desc&$select=${LIST_RECENT_SELECT}`;
    if (filters.length) {
        path += `&$filter=${filters.join(' and ')}`;
    }

    const raw = [];
    let next = path;
    let pages = 0;
    let hasMore = false;
    while (next && pages < maxPages && raw.length < want) {
        const data = await fetchPage(next);
        pages++;
        for (const msg of (data?.value || [])) raw.push(msg);
        const link = data?.['@odata.nextLink'];
        // Only Graph's own host gets the bearer token on the next request.
        next = typeof link === 'string' && link.startsWith(GRAPH_NEXT_LINK_PREFIX) ? link : null;
    }
    if (next || raw.length > want) hasMore = true;

    const messages = raw.slice(0, want).map(msg => ({
        id: msg.id,
        from: msg.from?.emailAddress ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address}>` : '',
        to: (msg.toRecipients || []).map(r => r.emailAddress?.address).filter(Boolean).join(', '),
        subject: msg.subject || '(no subject)',
        date: (isSentFolder ? msg.sentDateTime : msg.receivedDateTime) || msg.receivedDateTime || msg.sentDateTime || '',
        snippet: msg.bodyPreview || '',
        isRead: msg.isRead ?? true,
        hasAttachments: msg.hasAttachments || false,
    }));

    const result = {
        results: messages,
        total: messages.length,
        folder,
    };
    if (maxPages > 1 || sinceIso) {
        result.pages = pages;
        result.hasMore = hasMore;
    }
    return result;
}

/**
 * Execute an Outlook tool call.
 *
 * @param {string} toolName
 * @param {OutlookArgs} args
 * @param {OutlookSession} session - a Microsoft session (SSO or the vault shim)
 * @param {Object} [opts]
 * @param {boolean} [opts.autoSend=false] - For outlook_compose: when true the
 *   mail is sent straight away instead of returning an email_draft for the
 *   user to approve. Only unattended callers (the automation runner, a
 *   scheduled agent run) set it — there is nobody to click Send there, and a
 *   draft would sit unsent forever. Same contract as gmail_compose.
 * @returns {Promise<OutlookToolResult>} the tool's JSON result (its shape differs per tool)
 */
async function executeOutlookTool(toolName, args, session, opts = {}) {
    if (!isMicrosoftConnected(session)) {
        throw new Error('Not connected to Outlook — user must log in with Microsoft');
    }
    // Which mailbox, checked at the moment of use (every call, every run):
    // the address, and the connection's shared-mailbox scopes. Microsoft then
    // decides about Full Access; its 403 comes back in the same words.
    const mailbox = parseMailbox(args?.mailbox);
    assertSharedScopes(mailbox, session);
    try {
        return await runOutlookTool(toolName, args, session, opts, mailbox);
    } catch (err) {
        throw mapGraphMailboxError(err, mailbox);
    }
}

/**
 * The tool body, on an already-resolved mailbox.
 * @param {string} toolName
 * @param {OutlookArgs} args
 * @param {OutlookSession} session
 * @param {{ autoSend?: boolean }} opts
 * @param {import('../core/integrations/outlookMailbox.mts').Mailbox} mailbox
 */
async function runOutlookTool(toolName, args, session, opts, mailbox) {
    const base = mailboxBase(mailbox);
    // The draft and the result name the shared mailbox so the approval card
    // sends from the same place; the own mailbox stays implicit, as before.
    const mailboxField = mailbox.shared ? { mailbox: mailbox.address } : {};

    if (toolName === 'outlook_search') {
        const { query, maxResults = 10 } = args;
        const top = Math.min(Math.max(parseInt(maxResults) || 10, 1), 20);

        const data = await graphFetch(
            `${base}/messages?$search="${encodeURIComponent(query)}"&$top=${top}&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,hasAttachments,isRead`,
            session
        );

        const messages = (data.value || []).map(msg => ({
            id: msg.id,
            from: msg.from?.emailAddress ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address}>` : '',
            to: (msg.toRecipients || []).map(r => r.emailAddress?.address).filter(Boolean).join(', '),
            subject: msg.subject || '(no subject)',
            date: msg.receivedDateTime || '',
            snippet: msg.bodyPreview || '',
            isRead: msg.isRead ?? true,
            hasAttachments: msg.hasAttachments || false,
        }));

        return {
            results: messages,
            total: messages.length,
            query,
            ...mailboxField,
            note: 'Results are sorted by relevance, not date. If you need the latest emails, use outlook_list_recent instead.',
        };

    } else if (toolName === 'outlook_list_recent') {
        const listed = await listRecentMessages(args, (path) => graphFetch(path, session), base);
        return { ...listed, ...mailboxField };

    } else if (toolName === 'outlook_read') {
        const { messageId } = args;
        if (!messageId) throw new Error('messageId is required');
        assertGraphId(messageId, MESSAGE_ID_TEXT);

        const msg = await graphFetch(`${base}/messages/${messageId}?$select=${READ_SELECT}`, session);
        const result = shapeOutlookMessage(msg);

        // Fetch attachments if present
        if (msg.hasAttachments) {
            try {
                const attachData = await graphFetch(`${base}/messages/${messageId}/attachments?$select=${ATTACHMENT_SELECT}`, session);
                result.attachments = shapeOutlookAttachments(attachData.value);
            } catch (e) {
                log.info('[Outlook] Could not fetch attachments:', e.message);
                result.attachments = [];
            }
        }

        return result;

    } else if (toolName === 'outlook_read_many') {
        return readManyOutlookMessages(session, args);

    } else if (toolName === 'outlook_compose') {
        const { to, cc, bcc, subject, body, replyToMessageId } = args;
        if (!to || !subject || !body) throw new Error('to, subject, and body are required');
        if (replyToMessageId) assertGraphId(replyToMessageId, MESSAGE_ID_TEXT);

        // For replies, fetch conversation context
        let conversationId = null;
        if (replyToMessageId) {
            try {
                const original = await graphFetch(
                    `${base}/messages/${replyToMessageId}?$select=conversationId`,
                    session
                );
                conversationId = original.conversationId || null;
            } catch (err) {
                log.info('[Outlook] Could not fetch reply context:', err.message);
            }
        }

        if (opts.autoSend) {
            await executeOutlookSend({ to, cc, bcc, subject, body, replyToMessageId, ...mailboxField }, session);
            log.info(`[Outlook] (autoSend) Email sent to ${String(to).split(',').length} recipient(s) from mailbox ${mailboxLogRef(mailbox)}`);
            return {
                sent: true,
                to,
                subject,
                replyToMessageId: replyToMessageId || null,
                conversationId: conversationId || null,
                ...mailboxField,
                message: `Email sent to ${to}.`,
            };
        }

        return {
            _action: 'email_draft',
            _provider: 'microsoft',
            draft: {
                _provider: 'microsoft',
                to,
                cc: cc || null,
                bcc: bcc || null,
                subject,
                body,
                replyToMessageId: replyToMessageId || null,
                conversationId: conversationId || null,
                ...mailboxField,
            },
            message: `Email draft prepared for ${to}. Waiting for user approval to send.`,
        };

    } else {
        throw new Error(`Unknown Outlook tool: ${toolName}`);
    }
}

/**
 * Check if a tool name is an Outlook tool.
 */
function isOutlookTool(toolName) {
    return ['outlook_search', 'outlook_list_recent', 'outlook_read', 'outlook_read_many', 'outlook_compose'].includes(toolName);
}

/**
 * Read-only subset of Outlook tools (search, list_recent, read only — no compose/send).
 */
const OUTLOOK_READONLY_TOOLS = OUTLOOK_TOOLS.filter(t =>
    ['outlook_search', 'outlook_list_recent', 'outlook_read', 'outlook_read_many'].includes(t.function.name)
);

module.exports = {
    OUTLOOK_TOOLS,
    OUTLOOK_READONLY_TOOLS,
    executeOutlookTool,
    executeOutlookSend,
    executeOutlookSaveDraft,
    isOutlookTool,
    // exposed for tests
    buildOutlookMessage,
    shapeOutlookMessage,
    shapeOutlookAttachments,
    readManyOutlookMessages,
    listRecentMessages,
};

/**
 * A Graph message (only the fields read here).
 * @typedef {{ emailAddress?: { name?: string, address?: string } }} GraphRecipient
 * @typedef {{ id?: string, subject?: string, from?: GraphRecipient, toRecipients?: GraphRecipient[],
 *   ccRecipients?: GraphRecipient[], receivedDateTime?: string, sentDateTime?: string, bodyPreview?: string,
 *   body?: { contentType?: string, content?: string }, hasAttachments?: boolean, isRead?: boolean,
 *   conversationId?: string }} GraphMessage
 * @typedef {{ id?: string, name?: string, contentType?: string, size?: number }} GraphAttachment
 * @typedef {ReturnType<typeof shapeOutlookMessage> & { attachments?: ReturnType<typeof shapeOutlookAttachments> }} ShapedMessage
  * @typedef {{ query?: string, maxResults?: number|string, messageId?: string, messageIds?: unknown,
 *   to?: string, cc?: string, bcc?: string, subject?: string, body?: string, replyToMessageId?: string,
 *   folder?: string, unreadOnly?: boolean, since?: string|null, maxPages?: number|string, mailbox?: unknown }} OutlookArgs  the arguments of an outlook_* call
 * @typedef {import('./msGraphClient').MsSession & { oauthProvider?: string }} OutlookSession
 * @typedef {{ [key: string]: unknown, _action?: string, draft?: Record<string, unknown>, sent?: boolean, mailbox?: string,
 *   messages?: unknown[], results?: unknown[] }} OutlookToolResult  what an outlook_* call answers (loose JSON per tool)
 */
