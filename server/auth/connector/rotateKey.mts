/**
 * Nextcloud connector: tenant-key rotation, and the bearer check the
 * connector's own server-to-server calls share.
 *
 * POST /auth/connector/rotate-key is the connector's "Rotate tenant key"
 * button (Nextcloud → Bee Flow /setup). It replaces the org's key with a fresh
 * one and answers it once; the old key stops verifying. Re-bootstrapping could
 * never do this: a known instance id always gets its existing key back.
 *
 * Auth: a bearer JWT signed with the CURRENT key, carrying
 * `purpose: "connector:rotate-tenant-key"` and a lifetime of at most two
 * minutes. The purpose claim keeps a captured per-user token (which carries
 * none) from rotating the key; whoever holds the key itself can rotate it, as
 * they could already act as the connector.
 */

import { createRequire } from 'node:module';
// Structural types instead of 'express': agent-hub's typecheck reaches this file
// through server modules its tests require, and the frontend CI job has no
// server node_modules to resolve express's types from.
type Request = { headers: Record<string, string | string[] | undefined> };
type Response = { status(code: number): Response; json(body: unknown): unknown; set(field: string, value: string): unknown };
type Router = { post(path: string, ...handlers: unknown[]): unknown };

const nodeRequire = createRequire(import.meta.url);

type RateLimit = (opts: Record<string, unknown>) => (req: Request, res: Response, next: () => void) => void;
const rateLimit = nodeRequire('express-rate-limit') as RateLimit;
const { rotateTenantKey } = nodeRequire('./provisioning.js') as { rotateTenantKey: (orgId: string) => Promise<string> };
// Read at call time: tests replace the store's methods.
const userStore = nodeRequire('../../stores/userStore') as {
    logAccessAudit: (action: string, resourceType: string, resourceId: string, actor: string, ip: string | null, details: Record<string, unknown>, orgId: string) => Promise<void>;
};

type ResolvedTenant = { orgId: string; payload: Record<string, unknown> };

/** The tenant a connector-signed bearer token belongs to, or the 401 answer. */
export async function resolveConnectorBearer(req: Request): Promise<ResolvedTenant | { error: string }> {
    const authHeader = String(req.headers['authorization'] || '');
    if (!authHeader.toLowerCase().startsWith('bearer ')) return { error: 'Missing bearer token' };
    const token = authHeader.slice(7).trim();
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return { error: 'Invalid connector token' };
    let resolved: ResolvedTenant | null = null;
    try {
        // Lazy: connectorJwt pulls in the session and provisioning stack.
        const { _resolveTenant } = nodeRequire('../connectorJwt') as { _resolveTenant: (t: string) => Promise<ResolvedTenant | null> };
        resolved = await _resolveTenant(token);
    } catch {
        resolved = null;
    }
    if (!resolved) return { error: 'Connector token rejected: no matching tenant key' };
    return resolved;
}

export const ROTATE_PURPOSE = 'connector:rotate-tenant-key';
const ROTATE_MAX_TOKEN_LIFETIME_S = 120;

// An admin button: a handful per hour is plenty, and the cap bounds what a
// leaked key can churn.
const rotateKeyLimiter = rateLimit({
    windowMs: 15 * 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many key rotations; try again later.' },
    validate: { trustProxy: false },
});

export function registerRotateKeyRoute(router: Router): void {
    router.post('/connector/rotate-key', rotateKeyLimiter, async (req: Request, res: Response) => {
        const resolved = await resolveConnectorBearer(req);
        if ('error' in resolved) return res.status(401).json({ error: resolved.error });
        const { orgId, payload } = resolved;
        if (payload.purpose !== ROTATE_PURPOSE) {
            return res.status(403).json({ error: 'This token may not rotate the tenant key', code: 'wrong_token_purpose' });
        }
        const exp = typeof payload.exp === 'number' ? payload.exp : null;
        if (exp === null || exp - Math.floor(Date.now() / 1000) > ROTATE_MAX_TOKEN_LIFETIME_S) {
            return res.status(401).json({ error: `A rotation token must expire within ${ROTATE_MAX_TOKEN_LIFETIME_S} seconds`, code: 'token_lifetime' });
        }
        const tenantKey = await rotateTenantKey(orgId);
        await userStore.logAccessAudit('connector_tenant_key_rotated', 'organization', orgId,
            'system:connector', null, {}, orgId);
        res.set('Cache-Control', 'no-store');
        return res.json({ tenantKey, organizationId: orgId });
    });
}
