/**
 * 2BA "Sign in with 2BA" routes, mounted at /api/integrations/twoba: the
 * authorization-code half of a 2BA connection (integrations/twobaAuth.mts).
 *
 *   GET  /auth-url    start the sign-in (state + PKCE S256) with the signed-in user's own 2BA client
 *   GET  /callback    code exchange; tokens into the encrypted vault (automation_credentials, provider `twoba`)
 *   GET  /status      { mode, configured, connected, needsReauth, redirectUri }
 *   POST /disconnect  revoke the refresh token at 2BA, then vault delete + audit
 *
 * The NMBRS routes (routes/integrations/nmbrs.js) are the model. /callback
 * reads only 2BA's redirect query (`code`, `state`, `error`) and answers with a
 * self-closing page; the gate there is the state check: single use, bound to
 * the signed-in user, at most ten minutes old. The others read only the
 * session. No `:id` parameter: a user only reaches their own connection. No
 * token, secret or password is ever in a response or a log line.
 */

import { createRequire } from 'node:module';
import type { Request, RequestHandler, Response, Router } from 'express';
import * as auth from '../../integrations/twobaAuth.mts';

const nodeRequire = createRequire(import.meta.url);
const express = nodeRequire('express') as typeof import('express');
const log = nodeRequire('../../telemetry/log.js') as { info: (m: string) => void; warn: (m: string) => void };
const { validate } = nodeRequire('../../core/http/validate.js') as { validate: (schemas: Record<string, unknown>) => RequestHandler };
const { bodyOf } = nodeRequire('../../core/http/schemaParts.js') as { bodyOf: (shape: Record<string, unknown>, subject?: string) => unknown };
const { lazyGate } = nodeRequire('../../auth/gateMeta.js') as { lazyGate: (load: () => RequestHandler, meta: Record<string, unknown>) => RequestHandler };
const { fallback } = nodeRequire('../../utils/bestEffort.js') as { fallback: <T>(label: string, err: unknown, value?: T) => T };

interface Vault {
    getCredential: (userId: string, provider: string) => Promise<auth.VaultCredential | null>;
    upsertCredential: (row: { userId: string; orgId: string; provider: string; accessToken: string; refreshToken: string | null; expiresAt: number | null; scope: string | null }) => Promise<void>;
}

/** Stores, lazily, so a test injects them (the config store comes from auth.authDeps). */
export const routeDeps: {
    vault: () => Vault;
    getUser: (userId: string) => Promise<{ organizationId?: string | null } | null>;
    revokeLocal: (userId: string, provider: string) => Promise<{ found: boolean }>;
} = {
    vault: () => nodeRequire('../../stores/automationCredentialStore.js') as Vault,
    getUser: (userId) => (nodeRequire('../../stores/userStore.js') as { getUser: (id: string) => Promise<{ organizationId?: string | null } | null> }).getUser(userId),
    revokeLocal: (userId, provider) => (nodeRequire('../../auth/oauthRoutes.js') as { revokeProviderCredential: (u: string, p: string) => Promise<{ found: boolean }> }).revokeProviderCredential(userId, provider),
};

type Session = { user?: { id?: string }; twobaConnect?: auth.ConnectAttempt; save?: () => void };
const sessionOf = (req: Request) => req.session as unknown as Session | undefined;

function redirectUri(req: Request): string {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${String(protocol)}://${String(host)}/api/integrations/twoba/callback`;
}

function openerTargetOrigin(): string {
    const host = process.env.CLIENT_PUBLIC_HOST;
    if (!host) return '*';
    const lower = host.toLowerCase();
    let origin = lower.startsWith('http://') || lower.startsWith('https://') ? host : `https://${host}`;
    while (origin.endsWith('/')) origin = origin.slice(0, -1);
    return origin;
}

/** The self-closing popup page. `message` is one of our fixed sentences. */
export function callbackHtml(message: string, success: boolean): string {
    return `<!DOCTYPE html><html><head><title>2BA</title></head>
<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
<div style="text-align:center"><h2>${message}</h2><p>${success ? 'You can close this window.' : 'Please close this window and try again.'}</p></div>
<script>
  if (window.opener) {
    try { window.opener.postMessage({ type: 'twoba-callback', success: ${success} }, ${JSON.stringify(openerTargetOrigin())}); } catch (e) { console.debug('opener gone', e); }
    setTimeout(() => window.close(), 1500);
  }
</script></body></html>`;
}

/** The attempt of this session, taken out: it never survives the callback, whatever the outcome. */
function takeAttempt(session: Session | undefined): auth.ConnectAttempt | undefined {
    const attempt = session?.twobaConnect;
    if (session) {
        delete session.twobaConnect;
        session.save?.();
    }
    return attempt;
}

/** Why the callback cannot go on, as the sentence to show; null when it can. */
function callbackRefusal(query: { code?: unknown; state?: unknown; error?: unknown }, userId: string | undefined, attempt: auth.ConnectAttempt | undefined): string | null {
    if (query.error) return '2BA sign-in was cancelled or refused.';
    if (!userId) return 'Not signed in to Bee Flow. Please sign in first.';
    if (!attempt || !auth.attemptMatches(attempt, query.state, userId) || typeof query.code !== 'string' || !query.code) return 'Invalid or expired request. Please try again.';
    return null;
}

async function handleCallback(req: Request, res: Response): Promise<void> {
    const query = req.query as { code?: unknown; state?: unknown; error?: unknown };
    const session = sessionOf(req);
    const userId = session?.user?.id;
    const attempt = takeAttempt(session);
    const refusal = callbackRefusal(query, userId, attempt);
    if (refusal || !userId || !attempt) {
        res.send(callbackHtml(refusal || 'Invalid or expired request. Please try again.', false));
        return;
    }
    try {
        const tokens = await auth.exchangeCode(await auth.configFor(userId), String(query.code), attempt);
        if (!tokens.refreshToken) throw new Error('2BA issued no refresh token (offline_access missing)');
        const user = await routeDeps.getUser(userId).catch((e) => fallback('routes/integrations/twoba:user', e, null));
        await routeDeps.vault().upsertCredential({
            userId,
            // The same encryption scope rule as the other connectors (auth/automationAuth.js vaultOrgIdFor).
            orgId: user?.organizationId || `user:${userId}`,
            provider: auth.PROVIDER,
            ...tokens,
        });
        log.info(`[2BA] signed in for user ${userId}`);
        res.send(callbackHtml('2BA connected!', true));
    } catch (err) {
        log.warn(`[2BA] sign-in failed for user ${userId}: ${(err as { code?: string }).code || 'exchange failed'}`);
        res.send(callbackHtml('2BA sign-in failed. Please try again.', false));
    }
}

export function makeTwobaRouter(deps: { requireAuth?: RequestHandler } = {}): Router {
    const router = express.Router();
    // lazyGate keeps the deferred require and tags the mount as the session gate it is.
    const requireAuth: RequestHandler = deps.requireAuth || lazyGate(() => (nodeRequire('../../auth/permissions.js') as { requireAuth: RequestHandler }).requireAuth, { axis: 'auth' });

    router.get('/auth-url', requireAuth, async (req: Request, res: Response) => {
        const session = sessionOf(req);
        const userId = session?.user?.id;
        if (!session || !userId) { res.status(401).json({ error: 'Not authenticated' }); return; }
        const cfg = await auth.configFor(userId);
        if (!cfg.clientId || !cfg.clientSecret || cfg.mode !== 'authorization_code') {
            res.status(400).json({ error: 'Save the 2BA client id and client secret with "Sign in with 2BA" first.', code: 'twoba_not_configured' });
            return;
        }
        const attempt = auth.newConnectAttempt(userId, redirectUri(req));
        session.twobaConnect = attempt;
        session.save?.();
        res.json({ url: auth.authorizeUrl(cfg.clientId, attempt), redirectUri: attempt.redirectUri });
    });

    router.get('/callback', handleCallback);

    router.get('/status', requireAuth, async (req: Request, res: Response) => {
        const userId = sessionOf(req)?.user?.id;
        if (!userId) { res.status(401).json({ error: 'Not authenticated' }); return; }
        const cfg = await auth.configFor(userId);
        const cred = await routeDeps.vault().getCredential(userId, auth.PROVIDER).catch((e) => fallback('routes/integrations/twoba:status', e, null));
        res.json({
            mode: cfg.mode,
            configured: !!(cfg.clientId && cfg.clientSecret) && cfg.mode === 'authorization_code',
            connected: cred?.status === 'active',
            needsReauth: cred?.status === 'needs_reauth',
            // The address to register as redirect URI with 2BA.
            redirectUri: redirectUri(req),
        });
    });

    router.post('/disconnect', requireAuth, validate({ body: bodyOf({}, 'Disconnecting 2BA') }), async (req: Request, res: Response) => {
        const userId = sessionOf(req)?.user?.id;
        if (!userId) { res.status(401).json({ error: 'Not authenticated' }); return; }
        const cred = await routeDeps.vault().getCredential(userId, auth.PROVIDER).catch((e) => fallback('routes/integrations/twoba:disconnect', e, null));
        const revoked = cred ? await auth.revokeAt2ba(await auth.configFor(userId), cred.refreshToken) : false;
        const result = await routeDeps.revokeLocal(userId, auth.PROVIDER);
        auth.forgetToken(userId);
        log.info(`[2BA] sign-in removed for user ${userId} (revoked at 2BA: ${revoked})`);
        res.json({ success: true, hadCredential: result.found, revokedAt2ba: revoked });
    });

    return router;
}

export const twobaRouter: Router = makeTwobaRouter();
