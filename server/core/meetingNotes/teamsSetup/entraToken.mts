/**
 * One client-credentials token request against Microsoft Entra, for testing
 * an app registration (and, in option B, for the organisation app token).
 *
 * The request proves the client id, the secret and the tenant without any
 * Graph permission: scope `https://graph.microsoft.com/.default` is issued
 * even when no application permission is granted (the token then simply has
 * no `roles`). It changes nothing in Entra.
 *
 * What is kept of a refusal: the HTTP status, the OAuth `error` (allow-listed
 * to `[a-z_]`) and the AADSTS number (`error_codes[0]`, else the first
 * `AADSTS<digits>` in the description). The description itself, which can
 * name accounts and tenants, never leaves this module, and nothing here logs
 * the secret, the token or a response body.
 */

import { createRequire } from 'node:module';
import { GUID } from '../../../auth/oauth/microsoftConnections.mts';

const nodeRequire = createRequire(import.meta.url);

type SafeFetch = (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
type LazyDeps<T> = { deps: T; init: (overrides?: Partial<T>) => void };

const { lazyDeps } = nodeRequire('../lazyDeps.js') as { lazyDeps: <T>(loaders: Record<string, () => unknown>) => LazyDeps<T> };

const lazy = lazyDeps<{ safeFetch: SafeFetch }>({
    safeFetch: () => (nodeRequire('../../../utils/ssrfGuard.js') as { safeFetch: SafeFetch }).safeFetch,
});

/** Test seam: swap the fetch (the real one is utils/ssrfGuard.js safeFetch). */
export function init(overrides: { safeFetch?: SafeFetch } = {}): void { lazy.init(overrides); }

export interface TokenRequest { clientId: string; clientSecret: string; tenantId: string; timeoutMs?: number }

export type TokenResult =
    | { ok: true; accessToken: string; expiresAt: number; roles: string[] | null; tokenTenantId: string | null }
    | { ok: false; kind: 'entra'; httpStatus: number; error: string | null; aadsts: number | null }
    | { ok: false; kind: 'network'; timedOut?: boolean };

export const DEFAULT_TOKEN_TIMEOUT_MS = 15_000;
const GRAPH_DEFAULT_SCOPE = 'https://graph.microsoft.com/.default';
const OAUTH_ERROR = /^[a-z_]{1,64}$/;
const AADSTS_IN_TEXT = /AADSTS(\d{4,7})/;

/** The first AADSTS number of a token error body; null when there is none. */
export function aadstsOf(body: { error_codes?: unknown; error_description?: unknown } | null | undefined): number | null {
    const first = Array.isArray(body?.error_codes) ? Number(body.error_codes[0]) : NaN;
    if (Number.isFinite(first)) return first;
    const description = typeof body?.error_description === 'string' ? body.error_description.slice(0, 4096) : '';
    const match = AADSTS_IN_TEXT.exec(description);
    return match ? Number(match[1]) : null;
}

/** An OAuth error name as a report may carry it, or null. */
export function allowListedError(value: unknown): string | null {
    return typeof value === 'string' && OAUTH_ERROR.test(value) ? value : null;
}

/**
 * The `roles` and `tid` claims of an access token, best effort. Never throws,
 * never logs; anything unreadable is null.
 */
export function readTokenClaims(accessToken: string): { roles: string[] | null; tid: string | null } {
    try {
        const part = String(accessToken || '').split('.')[1];
        if (!part) return { roles: null, tid: null };
        const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { roles?: unknown; tid?: unknown };
        const roles = Array.isArray(claims?.roles) && claims.roles.every((r) => typeof r === 'string') ? [...claims.roles as string[]] : null;
        const tid = typeof claims?.tid === 'string' && GUID.test(claims.tid) ? claims.tid.toLowerCase() : null;
        return { roles, tid };
    } catch {
        return { roles: null, tid: null };
    }
}

function isTimeout(err: unknown): boolean {
    const name = (err as { name?: unknown } | null)?.name;
    return name === 'TimeoutError' || name === 'AbortError';
}

function parseJson(text: string): Record<string, unknown> | null {
    try {
        const v = JSON.parse(text) as unknown;
        return v && typeof v === 'object' ? v as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

function successOf(body: Record<string, unknown> | null, httpStatus: number): TokenResult {
    const accessToken = typeof body?.access_token === 'string' ? body.access_token : '';
    if (!accessToken) return { ok: false, kind: 'entra', httpStatus, error: null, aadsts: null };
    const expiresIn = Number(body?.expires_in);
    const { roles, tid } = readTokenClaims(accessToken);
    return {
        ok: true,
        accessToken,
        expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
        roles,
        tokenTenantId: tid,
    };
}

/**
 * POST the client-credentials grant to the tenant's v2 token endpoint. The
 * tenant must be a directory GUID (callers never pass `common`): anything else
 * is a programming error and throws a TypeError before any request.
 */
export async function requestClientCredentialsToken(req: TokenRequest): Promise<TokenResult> {
    const tenantId = String(req?.tenantId || '').toLowerCase();
    if (!GUID.test(tenantId)) throw new TypeError('requestClientCredentialsToken needs a directory (tenant) GUID');
    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: String(req.clientId || ''),
        client_secret: String(req.clientSecret || ''),
        scope: GRAPH_DEFAULT_SCOPE,
    });
    const timeoutMs = req.timeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;
    let response;
    try {
        response = await lazy.deps.safeFetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: body.toString(),
            ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
        });
    } catch (err) {
        return isTimeout(err) ? { ok: false, kind: 'network', timedOut: true } : { ok: false, kind: 'network' };
    }
    let text = '';
    try { text = await response.text(); } catch (err) {
        if (isTimeout(err)) return { ok: false, kind: 'network', timedOut: true };
        text = '';
    }
    const parsed = parseJson(text);
    if (response.ok) return successOf(parsed, response.status);
    return { ok: false, kind: 'entra', httpStatus: response.status, error: allowListedError(parsed?.error), aadsts: parsed ? aadstsOf(parsed) : null };
}
