/**
 * Linking a provider sign-in to the account that is signed in now.
 *
 *   GET /auth/login/:provider?intent=link   (providerLoginRoutes.js)
 *   GET /auth/callback/:provider            (providerCallbackRoutes.js)
 *
 * The start needs a signed-in session with a recent proof of identity
 * (auth/recentAuth.js) and remembers WHICH account asked. The callback, after
 * the usual state, PKCE and token checks, records (provider, subject) for that
 * account instead of signing in, provided the session still belongs to it.
 * A subject that belongs to another account is refused, never moved.
 *
 * This is how an account that a provider's e-mail may not reach on its own
 * (a password, OPAQUE record or second factor; see ssoUserResolver.js) gets
 * its SSO sign-in. Microsoft identities keep their own administrator-run
 * binding and are not linked here.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { hasRecentAuth } = nodeRequire('../recentAuth') as { hasRecentAuth: (session: unknown) => boolean };
const { ssoIdentities, SSO_IDENTITY_PROVIDERS } = nodeRequire('../ssoIdentityStore.mts') as typeof import('../ssoIdentityStore.mts');
const log = nodeRequire('../../telemetry/log') as { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };

type LinkSession = {
    isAuthenticated?: boolean;
    user?: { id?: string } | null;
    oauthLinkUserId?: string;
    [key: string]: unknown;
};

export type LinkStartError = 'reauth_required' | 'sso_link_unsupported';
export type LinkError = 'sso_identity_taken' | 'sso_link_failed';

/** The query value that asks for a link instead of a sign-in. */
export const LINK_INTENT = 'link';

/**
 * Where a link attempt returns to: the Security section of the account
 * settings (agent-hub settingsRoutes.ts), which holds the link action and
 * reads the `?linked=` / `?error=` outcome.
 */
export const LINK_RETURN_PATH = '/app/settings/security';

/**
 * Begin a link for the signed-in account. Null when the start may go on,
 * otherwise the error code for the `?error=` redirect.
 */
export function startLink(session: LinkSession, provider: string): LinkStartError | null {
    delete session.oauthLinkUserId;
    if (!SSO_IDENTITY_PROVIDERS.includes(provider)) return 'sso_link_unsupported';
    const userId = session.user?.id;
    if (!session.isAuthenticated || !userId || !hasRecentAuth(session)) return 'reauth_required';
    session.oauthLinkUserId = userId;
    return null;
}

/** The account a pending link was started for, cleared from the session either way. */
export function takeLinkIntent(session: LinkSession): string | null {
    const userId = session.oauthLinkUserId || null;
    delete session.oauthLinkUserId;
    return userId;
}

/** Session fields a provider exchange writes (providerTokenExchange.js). */
const PROVIDER_SESSION_KEYS = ['nextcloudUid', 'nextcloudTokenExpiresAt'];

/** Snapshot those fields; the returned function puts them back as they were. */
export function keepProviderSessionKeys(session: LinkSession): () => void {
    const saved = PROVIDER_SESSION_KEYS.map((key) => [key, session[key]] as const);
    return () => {
        for (const [key, value] of saved) {
            if (value === undefined) delete session[key];
            else session[key] = value;
        }
    };
}

/**
 * Record the provider identity for the account the link was started for.
 * `identities` is injectable for tests.
 */
export async function completeLink(
    { session, linkUserId, provider, subject }: { session: LinkSession; linkUserId: string; provider: string; subject: unknown },
    identities = ssoIdentities(),
): Promise<{ linked: true } | { error: LinkError }> {
    if (session.user?.id !== linkUserId || !session.isAuthenticated) {
        log.warn(`[OAuth/${provider}] Link refused: the session no longer belongs to the account that started it`);
        return { error: 'sso_link_failed' };
    }
    if (typeof subject !== 'string' || !subject || !SSO_IDENTITY_PROVIDERS.includes(provider)) return { error: 'sso_link_failed' };
    const result = await identities.link(linkUserId, provider, subject);
    if (result === 'taken') {
        log.warn(`[OAuth/${provider}] Link refused: the provider identity belongs to another account`);
        return { error: 'sso_identity_taken' };
    }
    log.info(`[OAuth/${provider}] Provider identity linked (${result})`);
    return { linked: true };
}
