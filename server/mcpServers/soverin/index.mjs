#!/usr/bin/env node
/**
 * Soverin MCP server (first-party, bundled).
 *
 * Soverin (soverin.nl) is a Dutch privacy-first mail provider that publishes no
 * HTTP API — it speaks IMAP + SMTP. Rather than pointing users at an unaudited
 * third-party mail bridge (their mailbox password would be handed to it), this
 * ships as a bundled server inside the API image: the process is spawned by
 * core/mcpManager.js with the user's own credentials injected as env vars, and
 * nothing leaves the box except the IMAP/SMTP connections to Soverin itself.
 *
 * Env (all injected per user by the MCP manager, except the operator flags):
 *   SOVERIN_EMAIL        full mailbox address, doubles as the username
 *   SOVERIN_PASSWORD     mailbox password
 *   SOVERIN_IMAP_HOST    default imap.soverin.net
 *   SOVERIN_IMAP_PORT    default 993 (use 143 for STARTTLS)
 *   SOVERIN_SMTP_HOST    default smtp.soverin.net
 *   SOVERIN_SMTP_PORT    default 465 (use 587 for STARTTLS)
 *   SOVERIN_READ_ONLY    operator flag — drops send/mark/move from the tool list
 *   SOVERIN_MAX_BODY_CHARS  operator flag — body truncation cap (default 8000)
 *
 * ESM because @modelcontextprotocol/sdk is ESM-only; the shared helpers stay
 * CommonJS so the rest of the server (and node --test) can require them.
 *
 * NOTE: stdout is the JSON-RPC channel. Never console.log here — every library
 * that could chatter (ImapFlow's pino logger, nodemailer) is muted below, and
 * our own diagnostics go to stderr.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import imapflow from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import mailparser from 'mailparser';
import helpers from './mail.js';

const { ImapFlow } = imapflow;
const { simpleParser } = mailparser;
const {
    readConfig,
    requireCredentials,
    clampLimit,
    buildSearchQuery,
    summarizeMessage,
    extractBody,
    summarizeAttachments,
    buildReplyHeaders,
    pickMailbox,
    normalizeRecipients,
    allowedTools,
} = helpers;

/** Hard cap on how much of a message we pull down before parsing (10 MB). */
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

const config = readConfig(process.env);

// ─── Tool definitions ───────────────────────────────────────────────
const MAILBOX_PROP = {
    type: 'string',
    description: 'Mailbox path, e.g. "INBOX" or "Archive". Defaults to INBOX.',
    default: 'INBOX',
};

const TOOLS = [
    {
        name: 'list_mailboxes',
        description: 'List the mailboxes (folders) in the Soverin account, with message and unread counts.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'search_messages',
        description:
            'Search a mailbox and return message summaries (uid, date, from, subject, unread, attachments). ' +
            'Combine filters freely; with no filters it returns the most recent messages. ' +
            'Use the returned uid with read_message to get the body.',
        inputSchema: {
            type: 'object',
            properties: {
                mailbox: MAILBOX_PROP,
                from: { type: 'string', description: 'Match the From header (substring).' },
                to: { type: 'string', description: 'Match the To header (substring).' },
                cc: { type: 'string', description: 'Match the Cc header (substring).' },
                subject: { type: 'string', description: 'Match the Subject header (substring).' },
                body: { type: 'string', description: 'Match text in the message body.' },
                text: { type: 'string', description: 'Match text anywhere in headers or body.' },
                unread: { type: 'boolean', description: 'true = only unread, false = only read.' },
                flagged: { type: 'boolean', description: 'true = only flagged/starred messages.' },
                since: { type: 'string', description: 'Only messages after this point — ISO date or relative ("7d", "24h").' },
                before: { type: 'string', description: 'Only messages before this point — ISO date or relative.' },
                limit: { type: 'integer', description: 'Max results, 1-50 (default 20). Newest first.' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'read_message',
        description:
            'Read one message by uid: headers, plain-text body (long bodies are truncated) and attachment metadata. ' +
            'Attachment bytes are never returned.',
        inputSchema: {
            type: 'object',
            properties: {
                uid: { type: 'integer', description: 'Message UID from search_messages.' },
                mailbox: MAILBOX_PROP,
                markSeen: { type: 'boolean', description: 'Mark the message as read after fetching (default false).' },
            },
            required: ['uid'],
            additionalProperties: false,
        },
    },
    {
        name: 'send_message',
        description:
            'Send an e-mail from the Soverin account and file a copy in Sent. ' +
            'Pass replyToUid to reply in-thread (subject and threading headers are derived from the original).',
        inputSchema: {
            type: 'object',
            properties: {
                to: { type: 'array', items: { type: 'string' }, description: 'Recipients — plain addresses or "Name <a@b.nl>".' },
                cc: { type: 'array', items: { type: 'string' }, description: 'Cc recipients.' },
                bcc: { type: 'array', items: { type: 'string' }, description: 'Bcc recipients.' },
                subject: { type: 'string', description: 'Subject. Optional when replyToUid is set.' },
                text: { type: 'string', description: 'Plain-text body.' },
                html: { type: 'string', description: 'Optional HTML body.' },
                replyToUid: { type: 'integer', description: 'UID of the message being replied to.' },
                mailbox: { ...MAILBOX_PROP, description: 'Mailbox holding replyToUid. Defaults to INBOX.' },
            },
            required: ['to'],
            additionalProperties: false,
        },
    },
    {
        name: 'mark_message',
        description: 'Set or clear the read (\\Seen) and flagged (\\Flagged) state of a message.',
        inputSchema: {
            type: 'object',
            properties: {
                uid: { type: 'integer', description: 'Message UID.' },
                mailbox: MAILBOX_PROP,
                seen: { type: 'boolean', description: 'true = mark read, false = mark unread.' },
                flagged: { type: 'boolean', description: 'true = flag, false = unflag.' },
            },
            required: ['uid'],
            additionalProperties: false,
        },
    },
    {
        name: 'move_message',
        description:
            'Move a message to another mailbox. The target may be a path ("Archive") or a role: ' +
            'trash, archive, junk, drafts, sent.',
        inputSchema: {
            type: 'object',
            properties: {
                uid: { type: 'integer', description: 'Message UID.' },
                mailbox: MAILBOX_PROP,
                target: { type: 'string', description: 'Destination mailbox path or role keyword.' },
            },
            required: ['uid', 'target'],
            additionalProperties: false,
        },
    },
];

// ─── IMAP / SMTP connections ────────────────────────────────────────
let imapClient = null;

async function getImap() {
    requireCredentials(config);
    if (imapClient && imapClient.usable) return imapClient;

    const client = new ImapFlow({
        host: config.imap.host,
        port: config.imap.port,
        secure: config.imap.secure,
        auth: { user: config.email, pass: config.password },
        // pino would otherwise write to stdout and corrupt the JSON-RPC stream.
        logger: false,
        emitLogs: false,
    });
    // ImapFlow emits 'error' on socket drops; without a listener that kills the process.
    client.on('error', (err) => {
        process.stderr.write(`[soverin-mcp] IMAP error: ${err.message}\n`);
    });

    await client.connect();
    imapClient = client;
    return imapClient;
}

function getSmtp() {
    requireCredentials(config);
    return nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: { user: config.email, pass: config.password },
        logger: false,
    });
}

/** Run `fn` with an exclusive lock on `mailbox`, always releasing it. */
async function withMailbox(mailbox, options, fn) {
    const client = await getImap();
    const lock = await client.getMailboxLock(mailbox || 'INBOX', options);
    try {
        return await fn(client, lock);
    } finally {
        lock.release();
    }
}

/** Resolve a role keyword ("trash") to a real mailbox path, else pass through. */
async function resolveMailboxTarget(client, target) {
    const role = String(target || '').trim().toLowerCase();
    if (['sent', 'trash', 'drafts', 'junk', 'archive'].includes(role)) {
        const resolved = pickMailbox(await client.list(), role);
        if (!resolved) throw new Error(`No "${role}" mailbox found in this account`);
        return resolved;
    }
    return target;
}

// ─── Tool handlers ──────────────────────────────────────────────────
const handlers = {
    async list_mailboxes() {
        const client = await getImap();
        const boxes = await client.list();
        const mailboxes = [];

        for (const box of boxes) {
            const entry = {
                path: box.path,
                name: box.name,
                specialUse: box.specialUse || null,
                messages: null,
                unread: null,
            };
            // Counts are a per-mailbox round trip — best effort, never fatal.
            try {
                const status = await client.status(box.path, { messages: true, unseen: true });
                entry.messages = status.messages ?? null;
                entry.unread = status.unseen ?? null;
            } catch (_) { /* \Noselect folders and the like */ }
            mailboxes.push(entry);
        }

        return { mailboxes };
    },

    async search_messages(args = {}) {
        const mailbox = args.mailbox || 'INBOX';
        const limit = clampLimit(args.limit);
        const query = buildSearchQuery(args);

        return withMailbox(mailbox, { readOnly: true }, async (client) => {
            const uids = await client.search(query, { uid: true });
            if (!uids || uids.length === 0) {
                return { mailbox, total: 0, returned: 0, messages: [] };
            }

            // Newest first, then cap — UIDs ascend with arrival order.
            const selected = uids.slice(-limit).reverse();
            const messages = [];
            for await (const message of client.fetch(
                selected,
                { uid: true, envelope: true, flags: true, size: true, bodyStructure: true },
                { uid: true }
            )) {
                messages.push(summarizeMessage(message, mailbox));
            }
            // fetch() streams in mailbox order, so re-apply newest-first.
            messages.sort((a, b) => b.uid - a.uid);

            return { mailbox, total: uids.length, returned: messages.length, messages };
        });
    },

    async read_message(args = {}) {
        const mailbox = args.mailbox || 'INBOX';
        const uid = Number(args.uid);
        if (!Number.isFinite(uid)) throw new Error('uid is required');

        return withMailbox(mailbox, { readOnly: !args.markSeen }, async (client) => {
            const meta = await client.fetchOne(String(uid), { uid: true, envelope: true, flags: true, size: true }, { uid: true });
            if (!meta) throw new Error(`Message uid ${uid} not found in ${mailbox}`);

            const download = await client.download(String(uid), undefined, { uid: true, maxBytes: MAX_DOWNLOAD_BYTES });
            const parsed = await simpleParser(download.content);
            const { body, truncated } = extractBody(parsed, config.maxBodyChars);

            if (args.markSeen) {
                await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
            }

            const envelope = meta.envelope || {};
            return {
                ...summarizeMessage(meta, mailbox),
                messageId: envelope.messageId || null,
                inReplyTo: envelope.inReplyTo || null,
                cc: (parsed.cc && parsed.cc.text) || '',
                body,
                bodyTruncated: truncated,
                attachments: summarizeAttachments(parsed.attachments),
            };
        });
    },

    async send_message(args = {}) {
        const to = normalizeRecipients(args.to, 'to');
        if (to.length === 0) throw new Error('At least one recipient is required in "to"');
        const cc = normalizeRecipients(args.cc, 'cc');
        const bcc = normalizeRecipients(args.bcc, 'bcc');

        let subject = String(args.subject || '').trim();
        let headers = null;

        // Reply mode — pull the original's threading headers.
        if (args.replyToUid) {
            const mailbox = args.mailbox || 'INBOX';
            headers = await withMailbox(mailbox, { readOnly: true }, async (client) => {
                const original = await client.fetchOne(String(args.replyToUid), { uid: true, envelope: true }, { uid: true });
                if (!original) throw new Error(`Message uid ${args.replyToUid} not found in ${mailbox}`);
                return buildReplyHeaders(original.envelope || {});
            });
            if (!subject) subject = headers.subject;
        }

        if (!subject) throw new Error('subject is required');
        if (!args.text && !args.html) throw new Error('Either "text" or "html" is required');

        // Compose once, then send and archive the exact same bytes so the copy in
        // Sent is byte-identical to what the recipient got.
        const composed = await new MailComposer({
            from: config.email,
            to,
            cc: cc.length ? cc : undefined,
            bcc: bcc.length ? bcc : undefined,
            subject,
            text: args.text || undefined,
            html: args.html || undefined,
            inReplyTo: headers?.inReplyTo || undefined,
            references: headers?.references?.length ? headers.references : undefined,
        })
            .compile()
            .build();

        const transporter = getSmtp();
        const info = await transporter.sendMail({
            envelope: { from: config.email, to: [...to, ...cc, ...bcc] },
            raw: composed,
        });
        transporter.close();

        // File a copy in Sent — best effort, the mail is already delivered.
        let savedToSent = false;
        try {
            const client = await getImap();
            const sentPath = pickMailbox(await client.list(), 'sent');
            if (sentPath) {
                await client.append(sentPath, composed, ['\\Seen']);
                savedToSent = true;
            }
        } catch (err) {
            process.stderr.write(`[soverin-mcp] could not save to Sent: ${err.message}\n`);
        }

        return {
            sent: true,
            messageId: info.messageId || null,
            accepted: info.accepted || [],
            rejected: info.rejected || [],
            subject,
            savedToSent,
        };
    },

    async mark_message(args = {}) {
        const mailbox = args.mailbox || 'INBOX';
        const uid = Number(args.uid);
        if (!Number.isFinite(uid)) throw new Error('uid is required');
        if (typeof args.seen !== 'boolean' && typeof args.flagged !== 'boolean') {
            throw new Error('Set at least one of "seen" or "flagged"');
        }

        return withMailbox(mailbox, {}, async (client) => {
            const applied = {};
            const range = String(uid);

            if (typeof args.seen === 'boolean') {
                const method = args.seen ? 'messageFlagsAdd' : 'messageFlagsRemove';
                await client[method](range, ['\\Seen'], { uid: true });
                applied.seen = args.seen;
            }
            if (typeof args.flagged === 'boolean') {
                const method = args.flagged ? 'messageFlagsAdd' : 'messageFlagsRemove';
                await client[method](range, ['\\Flagged'], { uid: true });
                applied.flagged = args.flagged;
            }

            return { uid, mailbox, applied };
        });
    },

    async move_message(args = {}) {
        const mailbox = args.mailbox || 'INBOX';
        const uid = Number(args.uid);
        if (!Number.isFinite(uid)) throw new Error('uid is required');
        if (!args.target) throw new Error('target is required');

        const client = await getImap();
        const target = await resolveMailboxTarget(client, args.target);
        if (target === mailbox) throw new Error('Source and target mailbox are the same');

        return withMailbox(mailbox, {}, async (locked) => {
            await locked.messageMove(String(uid), target, { uid: true });
            return { uid, from: mailbox, to: target, moved: true };
        });
    },
};

// ─── Wire up the MCP server ─────────────────────────────────────────
const server = new Server(
    { name: 'soverin', version: '1.0.0' },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allowedTools(TOOLS, config),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const available = allowedTools(TOOLS, config);
    if (!available.some((t) => t.name === name)) {
        const reason = TOOLS.some((t) => t.name === name)
            ? `Tool "${name}" is disabled — this Soverin connection is read-only.`
            : `Unknown tool: ${name}`;
        return { content: [{ type: 'text', text: reason }], isError: true };
    }

    try {
        const result = await handlers[name](args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
        // Never leak the mailbox password through an error string — some IMAP
        // failures echo the command that failed straight back at you.
        let message = String(err.message || err);
        if (config.password) message = message.split(config.password).join('***');
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});

async function shutdown() {
    try {
        if (imapClient && imapClient.usable) await imapClient.logout();
    } catch (_) { /* closing anyway */ }
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
process.stderr.write(`[soverin-mcp] ready (${config.readOnly ? 'read-only' : 'read-write'})\n`);
