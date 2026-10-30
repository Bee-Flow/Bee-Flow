/**
 * Microsoft sign-in connections: the primary app registration
 * (`providers.microsoft.clientId/clientSecret/tenantId`, as every installation
 * has had it) plus any number of ADDITIONAL tenants, each with its own app
 * registration, its own label and logo, and its own button on the login page.
 *
 *   providers.microsoft = {
 *     clientId, clientSecret, tenantId,            // the primary (unchanged)
 *     label?, logo?,                               // its login button
 *     connections?: [{ id, label, logo, clientId, clientSecret?, hasClientSecret?, tenantId }],
 *   }
 *
 * The primary stays where it is so every consumer of the Microsoft credentials
 * (Graph refresh, group sync, the Microsoft 365 connector, boot-init, the
 * publisher-domain file) keeps reading one place. The extra connections exist
 * for signing in: /auth/login/microsoft?connection=<id> picks one, the callback
 * exchanges the code with that connection's credentials and verifies the
 * token against that connection's tenant policy.
 *
 * Secrets never sit in `providers`: the auth config store keeps each
 * connection's secret encrypted under its own key (stores/authConfigStore.js)
 * and hands it back as `clientSecret` on load.
 */

import { randomBytes } from 'node:crypto';

export const PRIMARY_CONNECTION_ID = 'default';
export const MAX_CONNECTIONS = 20;
export const MAX_LABEL_LENGTH = 60;
/** The logo travels inside the config row and down to every login page: keep it small. */
export const MAX_LOGO_BYTES = 100 * 1024;

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_ALIASES = ['common', 'organizations', 'consumers'];
const CONNECTION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LOGO_DATA_URL = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/;

export interface MicrosoftConnection {
    id: string;
    label: string;
    logo: string;
    clientId: string;
    /** Present after authConfigStore.load(); absent in the stored metadata. */
    clientSecret?: string;
    hasClientSecret?: boolean;
    tenantId: string;
}

export interface MicrosoftProviderConfig {
    clientId?: string;
    clientSecret?: string;
    /** The stored metadata's flag (stores/authConfigStore.js); load() adds the secret itself. */
    hasClientSecret?: boolean;
    tenantId?: string;
    label?: string;
    logo?: string;
    connections?: MicrosoftConnection[];
}

export interface MicrosoftCredentials {
    clientId: string;
    clientSecret: string;
    tenantId: string;
}

/** What the login page needs for one button; nothing secret. */
export interface MicrosoftLogin {
    id: string;
    label: string;
    logo: string;
}

type AuthConfigLike = { providers?: { microsoft?: MicrosoftProviderConfig } } | null | undefined;

const primaryOf = (config: AuthConfigLike): MicrosoftProviderConfig => config?.providers?.microsoft || {};

const configured = (entry: { clientId?: string; clientSecret?: string; hasClientSecret?: boolean }): boolean =>
    !!entry.clientId && !!(entry.clientSecret || entry.hasClientSecret);

/** A directory GUID or one of the aliases; blank means `common`. Null when the value is neither. */
export function normalizeTenantId(value: unknown): string | null {
    const tid = String(value ?? '').trim();
    if (!tid) return 'common';
    if (GUID.test(tid)) return tid.toLowerCase();
    if (TENANT_ALIASES.includes(tid.toLowerCase())) return tid.toLowerCase();
    return null;
}

export function isValidConnectionId(id: unknown): id is string {
    return typeof id === 'string' && CONNECTION_ID.test(id) && id !== PRIMARY_CONNECTION_ID;
}

export function newConnectionId(): string {
    return randomBytes(6).toString('hex');
}

/**
 * A logo is either an https URL or a small base64 image data URL. An SVG data
 * URL is fine: it is only ever shown through <img>, where scripts do not run.
 */
export function isValidLogo(logo: unknown): logo is string {
    if (typeof logo !== 'string') return false;
    if (logo === '') return true;
    if (/^https:\/\/[^\s]{1,2040}$/.test(logo)) return true;
    const match = LOGO_DATA_URL.exec(logo);
    if (!match) return false;
    return Buffer.from(match[2], 'base64').length <= MAX_LOGO_BYTES;
}

/** The additional connections, as stored; never undefined. */
export function connectionsOf(config: AuthConfigLike): MicrosoftConnection[] {
    const list = primaryOf(config).connections;
    return Array.isArray(list) ? list : [];
}

/** The connection a login names; `undefined`/`default` is the primary. */
export function findConnection(config: AuthConfigLike, connectionId: string | undefined | null): MicrosoftConnection | undefined {
    if (!connectionId || connectionId === PRIMARY_CONNECTION_ID) return undefined;
    return connectionsOf(config).find((c) => c.id === connectionId);
}

/**
 * The credentials a sign-in (or a later token refresh of that sign-in) uses.
 * Null when the connection does not exist or has no client id/secret yet.
 */
export function microsoftCredentialsFor(config: AuthConfigLike, connectionId?: string | null): MicrosoftCredentials | null {
    if (!connectionId || connectionId === PRIMARY_CONNECTION_ID) {
        const primary = primaryOf(config);
        if (!primary.clientId || !primary.clientSecret) return null;
        return { clientId: primary.clientId, clientSecret: primary.clientSecret, tenantId: primary.tenantId || 'common' };
    }
    const connection = findConnection(config, connectionId);
    if (!connection || !connection.clientId || !connection.clientSecret) return null;
    return { clientId: connection.clientId, clientSecret: connection.clientSecret, tenantId: connection.tenantId || 'common' };
}

/**
 * The credentials for an account whose sign-in connection is not on record
 * (the automation credential vault stores tokens per provider, not per
 * connection): the connection pinned to the account's verified tenant, the
 * primary when it is that tenant or when nothing is pinned to it.
 */
export function microsoftCredentialsForTenant(config: AuthConfigLike, azureTenantId?: string | null): MicrosoftCredentials | null {
    const tenant = String(azureTenantId || '').toLowerCase();
    const primary = microsoftCredentialsFor(config);
    if (!GUID.test(tenant)) return primary;
    if (primary && primary.tenantId.toLowerCase() === tenant) return primary;
    const pinned = connectionsOf(config).find((c) => (c.tenantId || '').toLowerCase() === tenant && configured(c));
    return pinned ? microsoftCredentialsFor(config, pinned.id) : primary;
}

/**
 * The Microsoft buttons the login page shows, in order: the primary when it
 * is configured, then every configured additional connection. An empty label
 * means the default "Sign in with Microsoft"; an empty logo the Microsoft logo.
 */
export function listMicrosoftLogins(config: AuthConfigLike): MicrosoftLogin[] {
    const primary = primaryOf(config);
    const logins: MicrosoftLogin[] = [];
    if (configured(primary)) logins.push({ id: PRIMARY_CONNECTION_ID, label: primary.label || '', logo: primary.logo || '' });
    for (const c of connectionsOf(config)) {
        if (configured(c)) logins.push({ id: c.id, label: c.label || '', logo: c.logo || '' });
    }
    return logins;
}
