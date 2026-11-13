/**
 * Connecting to the company support mailbox: where the IMAP and SMTP sockets
 * go, with which options, and a test that logs in on both before anything is
 * saved.
 *
 * The host is typed by a platform administrator and may sit on the LAN (a
 * self-hosted mail server next to Bee Flow), so private addresses are allowed;
 * link-local and cloud-metadata addresses never are (core/http/linkLocalGuard).
 * The name is resolved once and the socket goes to that checked address, with
 * the name kept for TLS (SNI and certificate check), so a DNS answer that
 * changes between the check and the connect cannot redirect it.
 */

import { createRequire } from 'node:module';
import { isLinkLocalOrMetadataAddress, resolveHostAddresses } from '../../core/http/linkLocalGuard.mts';

const nodeRequire = createRequire(import.meta.url);
const { ImapFlow } = nodeRequire('imapflow') as typeof import('imapflow');
/** The part of a nodemailer transport this module uses (nodemailer ships no types). */
export interface SmtpTransport { verify(): Promise<unknown>; sendMail(mail: Record<string, unknown>): Promise<unknown>; close(): void }
const nodemailer = nodeRequire('nodemailer') as { createTransport: (options: object) => SmtpTransport };
const { normalizeHostname } = nodeRequire('../../core/http/ssrfGuard.js') as { normalizeHostname: (h: unknown) => { kind: 'ip4' | 'ip6' | 'name'; canonical: string | null } };

export type Security = 'tls' | 'starttls';

export interface ServerSettings { host: string; port: number; security: Security }

export interface MailboxConnection {
    emailAddress: string;
    imap: ServerSettings & { folder: string };
    smtp: ServerSettings;
    username: string;
    smtpUsername: string | null;
    secrets: { password: string; smtpPassword?: string | null };
}

/** A refusal or failure the administrator can act on; `code` is stable, `message` is for the screen. */
export class MailboxConnectError extends Error {
    code: string;
    constructor(code: string, message: string) {
        super(message);
        this.code = code;
    }
}

const TIMEOUT_MS = 15_000;

export interface PinnedHost { address: string; servername: string | undefined }

/**
 * Resolve `host` and refuse it when any answer is link-local or metadata.
 * Returns the address to connect to and the TLS name to verify against.
 */
export async function pinHost(host: string, resolve: (h: string) => Promise<string[]> = (h) => resolveHostAddresses(h)): Promise<PinnedHost> {
    const name = String(host || '').trim();
    if (!name) throw new MailboxConnectError('host_missing', 'No server address given.');
    if (isLinkLocalOrMetadataAddress(name)) throw new MailboxConnectError('host_refused', `${name} is a link-local or cloud-metadata address; Bee Flow does not connect there.`);
    let addresses: string[];
    try {
        addresses = await resolve(name);
    } catch {
        throw new MailboxConnectError('host_unknown', `The server name ${name} does not resolve.`);
    }
    if (!addresses.length) throw new MailboxConnectError('host_unknown', `The server name ${name} does not resolve.`);
    if (addresses.some((a) => isLinkLocalOrMetadataAddress(a))) {
        throw new MailboxConnectError('host_refused', `${name} points at a link-local or cloud-metadata address; Bee Flow does not connect there.`);
    }
    const literal = normalizeHostname(name).kind !== 'name';
    return { address: addresses[0], servername: literal ? undefined : name };
}

export function imapOptions(c: MailboxConnection, pinned: PinnedHost): ConstructorParameters<typeof ImapFlow>[0] {
    return {
        host: pinned.address,
        port: c.imap.port,
        secure: c.imap.security === 'tls',
        doSTARTTLS: c.imap.security === 'starttls' ? true : undefined,
        servername: pinned.servername,
        auth: { user: c.username, pass: c.secrets.password },
        logger: false,
        emitLogs: false,
        connectionTimeout: TIMEOUT_MS,
        greetingTimeout: TIMEOUT_MS,
        socketTimeout: 2 * 60_000,
    };
}

export function smtpOptions(c: MailboxConnection, pinned: PinnedHost) {
    return {
        host: pinned.address,
        port: c.smtp.port,
        secure: c.smtp.security === 'tls',
        requireTLS: c.smtp.security === 'starttls',
        auth: { user: c.smtpUsername || c.username, pass: c.secrets.smtpPassword || c.secrets.password },
        tls: pinned.servername ? { servername: pinned.servername } : {},
        connectionTimeout: TIMEOUT_MS,
        greetingTimeout: TIMEOUT_MS,
        socketTimeout: 60_000,
        logger: false,
    };
}

/** Open, log in and select the folder; the caller logs out. */
export async function openImap(c: MailboxConnection): Promise<InstanceType<typeof ImapFlow>> {
    const pinned = await pinHost(c.imap.host);
    const client = new ImapFlow(imapOptions(c, pinned));
    // ImapFlow emits 'error' on a dropped socket; without a listener that ends the process.
    client.on('error', () => { /* surfaced through the awaited call that fails */ });
    try {
        await client.connect();
    } catch (e) {
        throw describe(e, 'IMAP', c.imap.host);
    }
    return client;
}

export async function smtpTransport(c: MailboxConnection): Promise<SmtpTransport> {
    const pinned = await pinHost(c.smtp.host);
    return nodemailer.createTransport(smtpOptions(c, pinned));
}

/** Turn a socket or protocol error into something an administrator can act on, without echoing secrets. */
export function describe(e: unknown, kind: 'IMAP' | 'SMTP', host: string): MailboxConnectError {
    if (e instanceof MailboxConnectError) return e;
    const err = (e || {}) as { code?: string; message?: string; authenticationFailed?: boolean; responseCode?: number };
    const code = String(err.code || '');
    if (err.authenticationFailed || code === 'EAUTH' || err.responseCode === 535) {
        return new MailboxConnectError('auth_failed', `${kind}: the server refused the user name or password.`);
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new MailboxConnectError('host_unknown', `${kind}: the server name ${host} does not resolve.`);
    if (code === 'ECONNREFUSED') return new MailboxConnectError('connect_refused', `${kind}: ${host} refused the connection on that port.`);
    if (code === 'ETIMEDOUT' || code === 'NoConnection' || (code === 'ESOCKET' && /timeout/i.test(String(err.message)))) {
        return new MailboxConnectError('timeout', `${kind}: no answer from ${host} on that port.`);
    }
    if (/certificate|self[-_ ]signed|CERT|ERR_TLS/i.test(`${code} ${err.message || ''}`)) {
        return new MailboxConnectError('tls_failed', `${kind}: the TLS certificate of ${host} could not be verified.`);
    }
    if (/wrong version number|ssl3_get_record|EPROTO/i.test(`${code} ${err.message || ''}`)) {
        return new MailboxConnectError('tls_mismatch', `${kind}: TLS mismatch; try the other security setting for this port.`);
    }
    return new MailboxConnectError('connect_failed', `${kind}: connecting to ${host} failed${code ? ` (${code})` : ''}.`);
}

export interface TestResult { ok: boolean; imap: { ok: boolean; error?: string; code?: string }; smtp: { ok: boolean; error?: string; code?: string } }

/** Log in on both servers (IMAP also opens the folder). Never throws. */
export async function testConnection(c: MailboxConnection): Promise<TestResult> {
    const imap = await testImap(c);
    const smtp = await testSmtp(c);
    return { ok: imap.ok && smtp.ok, imap, smtp };
}

async function testImap(c: MailboxConnection): Promise<TestResult['imap']> {
    let client: InstanceType<typeof ImapFlow> | null = null;
    try {
        client = await openImap(c);
        try {
            await client.mailboxOpen(c.imap.folder || 'INBOX', { readOnly: true });
        } catch {
            return { ok: false, code: 'folder_missing', error: `IMAP: the folder ${c.imap.folder || 'INBOX'} does not exist.` };
        }
        return { ok: true };
    } catch (e) {
        const d = describe(e, 'IMAP', c.imap.host);
        return { ok: false, code: d.code, error: d.message };
    } finally {
        if (client) await client.logout().catch(() => undefined);
    }
}

async function testSmtp(c: MailboxConnection): Promise<TestResult['smtp']> {
    try {
        const transport = await smtpTransport(c);
        try {
            await transport.verify();
        } finally {
            transport.close();
        }
        return { ok: true };
    } catch (e) {
        const d = describe(e, 'SMTP', c.smtp.host);
        return { ok: false, code: d.code, error: d.message };
    }
}
