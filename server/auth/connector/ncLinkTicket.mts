/**
 * Nextcloud connector: linking an existing Bee Flow account to a Nextcloud
 * account, once, after a normal sign-in.
 *
 * The connector signs a person in by the Nextcloud uid its tenant key signed
 * (`sub`). When that uid belongs to no account of the organisation and the
 * address finds an account that the connector may not take by address alone
 * (it has a password, OPAQUE record, second factor, SSO identity or an admin
 * role, or it was not created by the connector or the user sync; see
 * emailLinkAllowed in ../ssoUserResolver.js), the sign-in answers
 * `nc_link_required` with a link ticket and the address of the page that
 * redeems it.
 *
 * The ticket is signed by this server and names the account, the
 * organisation, the Nextcloud uid and the uid stored on the account when it
 * was issued. It is redeemed by POST /auth/connector/link from a session of
 * that same account, signed in within the last few minutes (recentAuth.js:
 * the normal sign-in, second factor included). The write is conditional on
 * the stored uid still being the one the ticket names and on no other account
 * of the organisation holding the new uid, so a ticket links once: after the
 * write it no longer matches. Tickets live NC_LINK_TICKET_TTL_SECONDS
 * (default 600).
 */

import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Secret = { get(): Buffer; ensureDurable(): Promise<boolean> };
const { createSigningSecret } = nodeRequire('../lib/signingSecret') as {
    createSigningSecret: (opts: Record<string, unknown>) => Secret;
};
const signedPayload = nodeRequire('../lib/signedPayload') as {
    sign(secret: Buffer, payload: unknown): string;
    verify(secret: Buffer, token: string): Record<string, unknown> | null;
};
const { hasRecentAuth } = nodeRequire('../recentAuth') as { hasRecentAuth: (session: unknown) => boolean };
const log = nodeRequire('../../telemetry/log') as { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };

type UserRow = { id: string; organizationId?: string | null; nc_uid?: string | null };
type LinkStore = {
    getUser(id: string): Promise<UserRow | null>;
    setNcUidIfUnchanged(userId: string, orgId: string, ncUid: string, expectedStoredUid: string): Promise<boolean>;
};
// Read at call time: tests replace the store's methods.
const userStore = nodeRequire('../../stores/userStore') as LinkStore;

const PURPOSE = 'nc_link';
/** Where the ticket is redeemed: the Security section of the account settings (agent-hub). */
export const LINK_PAGE_PATH = '/app/settings/security';
/** The fragment key the page reads the ticket from (a fragment never reaches a server log). */
export const LINK_FRAGMENT_KEY = 'nc_link';

const secret = createSigningSecret({
    envVars: ['NC_LINK_TICKET_SECRET'],
    devCacheName: 'beeflow-nc-link-ticket-secret',
    configKey: 'nc_link_ticket_secret',
    label: 'NcLinkTicket',
    productionWarning:
        'NC_LINK_TICKET_SECRET not set and the startup bootstrap has not run: Nextcloud link tickets issued by '
        + 'this replica are refused by the others until ensureDurableSecret() finishes.',
    productionLogLevel: 'warn',
});

/** Bootstrap the durable signing secret (boot/startupTasks.js). */
export const ensureDurableSecret = (): Promise<boolean> => secret.ensureDurable();

/** NC_LINK_TICKET_TTL_SECONDS, default 600; at least 60. */
export function ticketTtlSeconds(): number {
    const n = Number.parseInt(String(process.env.NC_LINK_TICKET_TTL_SECONDS ?? ''), 10);
    return Number.isFinite(n) && n >= 60 ? n : 600;
}

export interface LinkClaims {
    userId: string;
    orgId: string;
    ncUid: string;
    /** The nc_uid stored on the account when the ticket was issued ('' = none). */
    storedUid: string;
    /** The Nextcloud address the organisation is linked to, for the page to show. */
    ncHost: string;
    expiresAt: number;
}

/** A ticket for linking `ncUid` of `orgId`'s Nextcloud to the account `userId`. */
export function issueLinkTicket(c: Omit<LinkClaims, 'expiresAt'>, now = Date.now()): string {
    const payload = {
        p: PURPOSE, u: c.userId, o: c.orgId, n: c.ncUid, s: c.storedUid || '', h: c.ncHost || '',
        e: now + ticketTtlSeconds() * 1000, j: crypto.randomBytes(9).toString('base64url'),
    };
    return signedPayload.sign(secret.get(), payload);
}

/** The claims of a valid, unexpired ticket, or null. */
export function verifyLinkTicket(token: unknown, now = Date.now()): LinkClaims | null {
    if (typeof token !== 'string' || !token || token.length > 2048) return null;
    const p = signedPayload.verify(secret.get(), token);
    if (!p || p.p !== PURPOSE) return null;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    if (!str(p.u) || !str(p.o) || !str(p.n) || typeof p.e !== 'number' || p.e < now) return null;
    return { userId: str(p.u), orgId: str(p.o), ncUid: str(p.n), storedUid: str(p.s), ncHost: str(p.h), expiresAt: p.e };
}

type Env = Record<string, string | undefined>;
type HostReq = { protocol?: string; get?(name: string): string | undefined };

/**
 * The web app's own address: CLIENT_PUBLIC_HOST, else SERVER_PUBLIC_HOST, else
 * the address this request reached the server at.
 */
export function appBaseUrl(req: HostReq, env: Env = process.env): string {
    if (env.CLIENT_PUBLIC_HOST) return `${env.CLIENT_PROTOCOL || env.SERVER_PROTOCOL || 'https'}://${env.CLIENT_PUBLIC_HOST}`;
    if (env.SERVER_PUBLIC_HOST) return `${env.SERVER_PROTOCOL || 'https'}://${env.SERVER_PUBLIC_HOST}`;
    const host = req.get?.('host');
    return host ? `${req.protocol || 'https'}://${host}` : '';
}

/** The page address that redeems `ticket`, or '' when this server does not know its own address. */
export function linkPageUrl(req: HostReq, ticket: string, env: Env = process.env): string {
    const base = appBaseUrl(req, env);
    return base ? `${base}${LINK_PAGE_PATH}#${LINK_FRAGMENT_KEY}=${encodeURIComponent(ticket)}` : '';
}

type LinkSession = { isAuthenticated?: boolean; user?: { id?: string; organizationId?: string | null } | null };

export type LinkError = 'nc_link_invalid' | 'nc_link_other_account' | 'reauth_required' | 'nc_link_stale';
export type LinkOutcome = { linked: true; ncUid: string } | { error: LinkError; status: number };

/**
 * Redeem a ticket for the signed-in account. The session must belong to the
 * account the ticket names, in its organisation, and hold a recent proof of
 * identity. Never moves a uid another account of the organisation holds.
 */
export async function redeemLinkTicket(session: LinkSession | null | undefined, ticket: unknown, store: LinkStore = userStore): Promise<LinkOutcome> {
    const claims = verifyLinkTicket(ticket);
    if (!claims) return { error: 'nc_link_invalid', status: 400 };
    const userId = session?.user?.id;
    if (!session?.isAuthenticated || !userId) return { error: 'reauth_required', status: 403 };
    if (userId !== claims.userId) {
        log.warn('[NcLink] Refused: the ticket names another account than the one signed in');
        return { error: 'nc_link_other_account', status: 403 };
    }
    if (!hasRecentAuth(session)) return { error: 'reauth_required', status: 403 };
    const row = await store.getUser(userId);
    if (!row || row.organizationId !== claims.orgId) return { error: 'nc_link_other_account', status: 403 };
    const written = await store.setNcUidIfUnchanged(userId, claims.orgId, claims.ncUid, claims.storedUid);
    if (!written) {
        const now = await store.getUser(userId);
        if (now?.nc_uid === claims.ncUid) return { linked: true, ncUid: claims.ncUid };
        log.warn(`[NcLink] Not linked for user ${userId}: the account or the Nextcloud uid changed since the ticket was issued`);
        return { error: 'nc_link_stale', status: 409 };
    }
    log.info(`[NcLink] Nextcloud account linked to user ${userId} in org ${claims.orgId}`);
    return { linked: true, ncUid: claims.ncUid };
}
