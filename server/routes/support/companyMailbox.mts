/**
 * The IMAP/SMTP mailbox of Bee Flow's own company support inbox, under
 * /api/support (routes/support.js). Super-admin only; the read for staff is
 * GET /mailbox in mailbox.js, which carries the public half.
 *
 *   PUT    /mailbox/imap        save (after a successful login on both servers)
 *   POST   /mailbox/imap/test   log in on both servers with these settings, save nothing
 *   POST   /mailbox/imap/sync   read the folder now
 *   DELETE /mailbox/imap        disconnect; the tickets it produced stay
 *
 * A password is write-only: no response carries it, and a save or test that
 * leaves it out uses the stored one (only while the account stays the same,
 * so a stored password is never sent to a host someone just typed in).
 */

import { createRequire } from 'node:module';
import type { NextFunction, Request, Response } from 'express';
import { testConnection, type MailboxConnection } from '../../services/supportCompanyMailbox/connection.mts';
import { syncCompanyMailbox } from '../../services/supportCompanyMailbox/sync.mts';

const nodeRequire = createRequire(import.meta.url);

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
type Router = { get: (p: string, ...h: Handler[]) => unknown; put: (p: string, ...h: Handler[]) => unknown; post: (p: string, ...h: Handler[]) => unknown; delete: (p: string, ...h: Handler[]) => unknown };
type HttpErrorCtor = new (status: number, code: string, message: string) => Error;

const { z } = nodeRequire('../../utils/zod.js') as { z: typeof import('zod').z };
const { bodyOf, closedObject, choice, wholeNumber, worded, flag } = nodeRequire('../../core/http/schemaParts.js') as {
    bodyOf: <S extends import('zod').ZodRawShape>(shape: S, subject?: string) => import('zod').ZodType;
    closedObject: <S extends import('zod').ZodRawShape>(shape: S, subject?: string) => import('zod').ZodObject<S>;
    choice: (values: string[], message: string) => import('zod').ZodType<string>;
    wholeNumber: (message: string, range?: { min?: number; max?: number }) => import('zod').ZodType<number>;
    worded: (message: string) => import('zod').ZodString;
    flag: (message: string) => import('zod').ZodType<boolean>;
};
const { validate } = nodeRequire('../../core/http/validate.js') as { validate: (schemas: Record<string, unknown>) => Handler };
const { HttpError } = nodeRequire('../../core/http/errors.js') as { HttpError: HttpErrorCtor };
const { requireSuperAdmin } = nodeRequire('../../auth/index.js') as { requireSuperAdmin: Handler };
const mailboxStore = nodeRequire('../../stores/supportCompanyMailboxStore.js') as typeof import('../../stores/supportCompanyMailboxStore.js');
const supportStore = nodeRequire('../../stores/supportStore.js') as { recordAuditEvent: (e: Record<string, unknown>) => Promise<unknown> };
const log = nodeRequire('../../telemetry/log.js') as { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };

/** A host name or address, checked with string operations (no pattern over request text). */
export function isPlausibleHost(value: string): boolean {
    const v = value.trim();
    if (!v || v.length > 253) return false;
    for (const ch of v) {
        const ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '.' || ch === '-' || ch === ':' || ch === '[' || ch === ']';
        if (!ok) return false;
    }
    return true;
}

const HOST_TEXT = 'host is a server name or address, such as imap.example.com.';
const host = worded(HOST_TEXT).trim().min(1, HOST_TEXT).max(253, HOST_TEXT).refine(isPlausibleHost, HOST_TEXT);
const port = wholeNumber('port is a whole number from 1 to 65535.', { min: 1, max: 65535 });
const security = choice(['tls', 'starttls'], 'security is tls or starttls.');
const secret = (name: string) => worded(`${name} must be text.`).min(1, `${name} must not be empty.`).max(1024, `${name} is at most 1024 characters.`);

const MailboxBody = bodyOf({
    emailAddress: worded('emailAddress must be an email address.').trim().max(320, 'emailAddress is at most 320 characters.').pipe(z.email('emailAddress must be an email address.')),
    displayName: worded('displayName must be text.').trim().max(120, 'displayName is at most 120 characters.').optional(),
    imap: closedObject({
        host,
        port,
        security,
        folder: worded('folder must be text.').trim().min(1, 'folder must not be empty.').max(200, 'folder is at most 200 characters.').optional(),
    }, 'imap'),
    smtp: closedObject({ host, port, security }, 'smtp'),
    username: worded('username must be text.').trim().min(1, 'username must not be empty.').max(320, 'username is at most 320 characters.'),
    password: secret('password').optional(),
    smtpUsername: worded('smtpUsername must be text.').trim().max(320, 'smtpUsername is at most 320 characters.').nullish(),
    smtpPassword: secret('smtpPassword').nullish(),
    aiAutoReply: flag('aiAutoReply is true or false.').optional(),
}, 'The mailbox settings');

const NoBody = bodyOf({}, 'This request');

interface MailboxInput {
    emailAddress: string;
    displayName?: string;
    imap: { host: string; port: number; security: 'tls' | 'starttls'; folder?: string };
    smtp: { host: string; port: number; security: 'tls' | 'starttls' };
    username: string;
    password?: string;
    smtpUsername?: string | null;
    smtpPassword?: string | null;
    aiAutoReply?: boolean;
}

const lower = (s: string) => s.trim().toLowerCase();

/**
 * The connection the body describes, with the stored passwords filled in
 * where the body leaves them out and the account is the one they belong to.
 */
export function resolveConnection(body: MailboxInput, stored: Awaited<ReturnType<typeof mailboxStore.getMailboxWithSecrets>>): MailboxConnection & { displayName: string } {
    const sameImap = !!stored && lower(stored.imap.host) === lower(body.imap.host) && lower(stored.username) === lower(body.username);
    const smtpUsername = body.smtpUsername ? body.smtpUsername : null;
    const sameSmtp = !!stored && lower(stored.smtp.host) === lower(body.smtp.host)
        && lower(stored.smtpUsername || stored.username) === lower(smtpUsername || body.username);
    const separateSmtp = !!smtpUsername && lower(smtpUsername) !== lower(body.username);
    // Without a login of its own, SMTP logs in with the mailbox password, so a
    // stored one is reused only while the SMTP host is the stored one too.
    const reuseStored = sameImap && (separateSmtp || lower(stored?.smtp.host || '') === lower(body.smtp.host));
    const password = body.password ?? (reuseStored ? stored?.secrets.password : undefined);
    if (!password) throw new HttpError(400, 'password_required', 'Enter the password of the mailbox.');
    // An SMTP password of its own only when the SMTP login differs; else the IMAP one.
    let smtpPassword: string | null = null;
    if (separateSmtp) {
        smtpPassword = body.smtpPassword ?? (sameSmtp ? stored?.secrets.smtpPassword ?? null : null);
        if (!smtpPassword) throw new HttpError(400, 'smtp_password_required', 'Enter the password of the SMTP account.');
    } else if (body.smtpPassword) {
        smtpPassword = body.smtpPassword;
    }
    return {
        emailAddress: body.emailAddress.toLowerCase(),
        displayName: body.displayName || '',
        imap: { host: body.imap.host, port: body.imap.port, security: body.imap.security, folder: body.imap.folder || 'INBOX' },
        smtp: { host: body.smtp.host, port: body.smtp.port, security: body.smtp.security },
        username: body.username,
        smtpUsername,
        secrets: { password, smtpPassword },
    };
}

const userIdOf = (req: Request): string | null => {
    const u = (req as Request & { session?: { user?: { id?: unknown } } }).session?.user;
    return u && typeof u.id === 'string' ? u.id : null;
};

const audit = (req: Request, action: string, payload: Record<string, unknown>) => {
    supportStore.recordAuditEvent({ actorKind: 'staff', actorUserId: userIdOf(req), action, payload: { scope: 'company', ...payload } })
        .catch((e: Error) => log.warn('[CompanyMailbox] audit failed:', e.message));
};

export function register(router: Router): void {
    router.post('/mailbox/imap/test', requireSuperAdmin, validate({ body: MailboxBody }), async (req, res) => {
        const conn = resolveConnection(req.body as MailboxInput, await mailboxStore.getMailboxWithSecrets());
        res.json({ test: await testConnection(conn) });
    });

    router.put('/mailbox/imap', requireSuperAdmin, validate({ body: MailboxBody }), async (req, res) => {
        const body = req.body as MailboxInput;
        const conn = resolveConnection(body, await mailboxStore.getMailboxWithSecrets());
        const test = await testConnection(conn);
        if (!test.ok) {
            res.status(400).json({ error: test.imap.error || test.smtp.error || 'The connection test failed.', code: 'connection_failed', test });
            return;
        }
        const mailbox = await mailboxStore.saveMailbox({ ...conn, aiAutoReply: body.aiAutoReply === true, createdBy: userIdOf(req) });
        audit(req, 'inbox_connected', { provider: 'imap', imapHost: conn.imap.host, smtpHost: conn.smtp.host });
        log.info('[CompanyMailbox] mailbox saved');
        // The first read follows at once rather than at the next tick.
        syncCompanyMailbox().catch(() => undefined);
        res.json({ mailbox, test });
    });

    router.post('/mailbox/imap/sync', requireSuperAdmin, validate({ body: NoBody }), async (_req, res) => {
        if (!await mailboxStore.getMailbox()) throw new HttpError(404, 'not_connected', 'No mailbox is connected.');
        const out = await syncCompanyMailbox();
        res.json({ ran: out.ran, handled: out.handled, error: out.error || null, mailbox: await mailboxStore.getMailbox() });
    });

    router.delete('/mailbox/imap', requireSuperAdmin, async (req, res) => {
        const removed = await mailboxStore.deleteMailbox();
        if (removed) audit(req, 'inbox_disconnected', { provider: 'imap', purgedThreads: 0 });
        res.json({ ok: true, removed });
    });
}
