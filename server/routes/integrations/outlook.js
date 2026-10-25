// @typecheck strict
/**
 * Outlook Routes — REST API for Outlook Mail integration UI
 *
 * Mirror of gmail.js for Microsoft 365 users.
 * Provides endpoints for the frontend email picker and send/draft actions.
 *
 * /status reads nothing but the session, so it carries no schema.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const { requireAuth } = require('../../auth/permissions');
const { isMicrosoftConnected, graphFetch } = require('../../integrations/msGraphClient');
const { executeOutlookSend, executeOutlookSaveDraft } = require('../../integrations/outlookTools');
const { GRAPH_ID_RE, MESSAGE_ID_TEXT, FOLDER_TEXT } = require('../../integrations/graphIds');
const { resolveMicrosoftSession } = require('../../auth/microsoftSessionHydration');
const { validate } = require('../../core/http/validate');
const { z } = require('../../utils/zod');
const { worded } = require('../../core/http/schemaParts');
const { optionalText, draftFields, listSize } = require('./mailSchemaParts');

// ── What a caller may send ──────────────────────────────────────────
//
// `folder` is CONCATENATED into the Graph path
// (`/me/mailFolders/${folder}/messages?$top=…`), and it arrived unchecked:
// a value carrying a `/` or a `?` appended its own path segments and query
// parameters to the request this server makes on the caller's behalf. It is
// pinned to a well-known folder name or a Graph id.
//
// The schema does NOT enumerate folder names: Graph takes well-known names
// AND opaque folder ids for custom folders, so an allow-list would lock
// custom folders out. A name Graph does not know still 404s there, loudly,
// which is the right answer — what had to close is the path separator.
//
// `top` was `Math.min(Math.max(parseInt(top) || 20, 1), 50)`, which already
// had both ends; the change there is only that `?top=abc` now says so
// instead of quietly meaning 20.
//
// /send and /draft take the approval card's draft verbatim and hand the whole
// object to outlookTools. `.strict()` is what stops a misspelled `bcc` from
// sending the mail to everyone EXCEPT the blind copies, on a 200 reading
// `Email sent via Outlook`. `replyToMessageId` is interpolated into
// `/me/messages/${id}/reply`, so it is pinned to a Graph id too.

// GRAPH_ID_RE, FOLDER_TEXT and MESSAGE_ID_TEXT come from integrations/graphIds,
// so the tool path (including unattended autoSend) and this route apply one rule.

const MessagesQuery = z.object({
    search: worded('search must be text.').optional(),
    top: listSize('top'),
    folder: worded(FOLDER_TEXT).regex(GRAPH_ID_RE, FOLDER_TEXT).optional(),
}).strict();

const MessageParams = z.object({
    id: worded(MESSAGE_ID_TEXT).regex(GRAPH_ID_RE, MESSAGE_ID_TEXT),
}).strict();

const EmailBody = z.object({
    ...draftFields,
    replyToMessageId: worded(MESSAGE_ID_TEXT).regex(GRAPH_ID_RE, MESSAGE_ID_TEXT).nullish(),
    // Carried by the draft outlookTools builds; read by nobody here.
    conversationId: optionalText('conversationId'),
    _provider: z.enum(['microsoft'], { error: () => '_provider is microsoft on this route.' }).optional(),
}).strict();

/**
 * The session Graph calls run on. A Microsoft session is used as it is; a
 * Google/Nextcloud SSO session whose user connected Microsoft 365 separately
 * gets a Microsoft-only shim from the vault (auth/microsoftSessionHydration),
 * so the approval card's Send works for them too and the Google tokens on
 * req.session are never touched.
 * @param {Pick<import('express').Request, 'session'>} req
 */
async function msSessionOf(req) {
    return (await resolveMicrosoftSession(req.session)) || req.session;
}

// ── Status ──────────────────────────────────────────────────────────────────
router.get('/status', requireAuth, async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const msSession = await msSessionOf(req);
    const isConnected = isMicrosoftConnected(msSession);
    log.info('[Outlook] Status check — hasAccessToken:', !!msSession?.accessToken, 'oauthProvider:', req.session?.oauthProvider, 'connected:', isConnected);
    res.json({ connected: isConnected });
});

// ── List / Search Messages ──────────────────────────────────────────────────
router.get('/messages', requireAuth, validate({ query: MessagesQuery }), /** @param {import('express').Request<{}, any, any, { search?: string, top?: number, folder?: string }>} req */ async (req, /** @type {import('express').Response} */ res, /** @type {import('express').NextFunction} */ next) => {
    const msSession = await msSessionOf(req);
    if (!isMicrosoftConnected(msSession)) {
        return res.status(401).json({ error: 'Not connected to Outlook' });
    }

    try {
        const { search, top = 20, folder = 'inbox' } = req.query;
        const limit = Math.min(top, 50);

        const isSentFolder = String(folder).toLowerCase() === 'sentitems';
        const orderField = isSentFolder ? 'sentDateTime' : 'receivedDateTime';

        let path = `/me/mailFolders/${folder}/messages?$top=${limit}&$orderby=${orderField} desc&$select=id,subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,isRead,hasAttachments`;

        if (search) {
            path = `/me/messages?$search="${encodeURIComponent(search)}"&$top=${limit}&$select=id,subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,isRead,hasAttachments`;
        }

        const data = await graphFetch(path, msSession);

        /**
         * @typedef {{ emailAddress?: { name?: string, address?: string } }} GraphRecipient
         * @typedef {{ id: string, from?: GraphRecipient, toRecipients?: GraphRecipient[], subject?: string,
         *   sentDateTime?: string, receivedDateTime?: string, bodyPreview?: string, isRead?: boolean,
         *   hasAttachments?: boolean }} GraphMessageSummary
         */
        const messages = (data.value || []).map((/** @type {GraphMessageSummary} */ msg) => ({
            id: msg.id,
            from: msg.from?.emailAddress ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address}>` : '',
            to: (msg.toRecipients || []).map((/** @type {GraphRecipient} */ r) => r.emailAddress?.address).filter(Boolean).join(', '),
            subject: msg.subject || '(no subject)',
            date: (isSentFolder ? msg.sentDateTime : msg.receivedDateTime) || msg.receivedDateTime || msg.sentDateTime || '',
            snippet: msg.bodyPreview || '',
            isRead: msg.isRead || false,
            hasAttachments: msg.hasAttachments || false,
        }));

        res.json({ messages });

    } catch (err) {
        log.error('[Outlook] Error listing messages:', /** @type {Error} */ (err).message);
        if (/** @type {Error} */ (err).message === 'NOT_CONNECTED') {
            return res.status(401).json({ error: 'Microsoft session expired' });
        }
        next(err);
    }
});

// ── Get Single Message ──────────────────────────────────────────────────────
router.get('/messages/:id', requireAuth, validate({ params: MessageParams }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const msSession = await msSessionOf(req);
    if (!isMicrosoftConnected(msSession)) {
        return res.status(401).json({ error: 'Not connected to Outlook' });
    }

    const msg = await graphFetch(
        `/me/messages/${req.params.id}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,conversationId`,
        msSession
    );

    let body = '';
    if (msg.body?.contentType === 'text') {
        body = msg.body.content || '';
    } else {
        // Return HTML for frontend rendering
        body = msg.body?.content || '';
    }

    res.json({
        id: msg.id,
        from: msg.from?.emailAddress ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address}>` : '',
        to: (msg.toRecipients || []).map((/** @type {{ emailAddress?: { address?: string } }} */ r) => r.emailAddress?.address).filter(Boolean).join(', '),
        cc: (msg.ccRecipients || []).map((/** @type {{ emailAddress?: { address?: string } }} */ r) => r.emailAddress?.address).filter(Boolean).join(', '),
        subject: msg.subject || '(no subject)',
        date: msg.receivedDateTime || '',
        body,
        bodyType: msg.body?.contentType || 'text',
        conversationId: msg.conversationId || null,
        hasAttachments: msg.hasAttachments || false,
    });
});

// ── Send Email (after user approval) ────────────────────────────────────────
router.post('/send', requireAuth, validate({ body: EmailBody }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const result = await executeOutlookSend(req.body, await msSessionOf(req));
    res.json(result);
});

// ── Save as Draft ───────────────────────────────────────────────────────────
router.post('/draft', requireAuth, validate({ body: EmailBody }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const result = await executeOutlookSaveDraft(req.body, await msSessionOf(req));
    res.json(result);
});

module.exports = router;
