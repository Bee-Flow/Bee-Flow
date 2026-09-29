/**
 * "Can I reach this server, is it a Bee Flow server, and will signing in work?"
 *
 * Asked on the first-run picker, when the user changes servers, and whenever
 * the main window fails to load. The answer has to be specific enough to act
 * on: "we could not connect" sends someone to their network settings when the
 * real problem was a certificate, a typo in the host name, the wrong port, or a
 * server that does not accept the address it was reached at.
 *
 * In order:
 *
 * 1. `/api/health` answers `{ status: 'ok' }`. An address typed without a
 *    scheme is tried over https first; if the port turns out to speak plain
 *    http, the probe retries over http — silently only for this computer and
 *    private IP addresses, never for a name another network could answer.
 * 2. `/` is a web app, not the bare API. A Docker install serves the SPA from
 *    its nginx port and only the API from the server port, and the API port
 *    passes step 1 perfectly well.
 * 3. The server accepts the address it is reached at. Its Origin gate answers
 *    403 to any address missing from CORS_ORIGIN, for every POST — so step 1
 *    and the page load pass and signing in fails. Asked up front, with the
 *    same `Origin` the window will send.
 * 4. `/auth/setup-status` names the origin single sign-on starts at, when that
 *    is a second address (SERVER_PUBLIC_HOST).
 *
 * The saved address is where the server actually is after its redirects.
 *
 * `fetch` is injected so every branch is testable without a network; the app
 * passes Chromium's network stack (chromiumFetch.ts), so the probe sees the
 * same proxy, certificates and HSTS as the window it decides for.
 */

import type { Platform, ServerProbeFailure, ServerProbeResult } from '../../shared/types.ts';
import { classifyNetworkError, hostOf } from './netErrors.ts';
import { hostKind, normaliseServerUrl, originOf, serverUrl, withHttp } from './url.ts';

export interface ProbeResponse {
    status: number;
    /** The URL that finally answered, after any redirects. */
    url: string;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
}

export interface ProbeRequestInit {
    signal?: AbortSignal;
    headers?: Record<string, string>;
}

export type FetchLike = (url: string, init?: ProbeRequestInit) => Promise<ProbeResponse>;

export interface ProbeOptions {
    fetch?: FetchLike;
    /** For the health check; the follow-up checks get less. */
    timeoutMs?: number;
    /** Injected for tests; defaults to Date.now. */
    now?: () => number;
    /** Chooses the certificate advice; defaults to process.platform. */
    platform?: Platform;
}

/** Long enough for a cold self-hosted container, short enough to not feel stuck. */
export const DEFAULT_PROBE_TIMEOUT_MS = 8_000;
const FOLLOW_UP_TIMEOUT_MS = 5_000;

interface Context {
    fetch: FetchLike;
    timeoutMs: number;
    platform: Platform;
}

type Step<T> = ({ ok: true } & T) | { ok: false; code: ServerProbeFailure; error: string; status?: number; speaksHttp?: boolean };

export async function probeServer(rawUrl: string, options: ProbeOptions = {}): Promise<ServerProbeResult> {
    const normalised = normaliseServerUrl(rawUrl);
    if (!normalised.ok) {
        return { ok: false, url: String(rawUrl ?? ''), error: normalised.error, code: normalised.code };
    }

    const now = options.now ?? Date.now;
    const context: Context = {
        fetch: options.fetch ?? nodeFetch,
        timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
        platform: options.platform ?? (process.platform as Platform),
    };
    const startedAt = now();
    const done = (result: ServerProbeResult): ServerProbeResult => ({ ...result, durationMs: now() - startedAt });

    // ── 1. Health, with the http fallback ────────────────────────────────────
    let base = normalised.url;
    let health = await checkHealth(base, context);
    if (!health.ok && !normalised.schemeTyped && base.startsWith('https:')) {
        // Refused on 443 with no port typed is the other shape of an http-only
        // server: `nas.local` whose web server listens on 80 alone.
        const worthHttp = health.speaksHttp === true || (health.code === 'refused' && !normalised.portTyped);
        if (worthHttp) {
            const httpBase = withHttp(base);
            const overHttp = await checkHealth(httpBase, context);
            if (overHttp.ok) {
                const kind = hostKind(new URL(httpBase).hostname);
                if (kind !== 'loopback' && kind !== 'private') {
                    return done({
                        ok: false,
                        url: base,
                        code: 'plain-http',
                        error: `${hostOf(httpBase)} answers plain http, not https. If that is your own server on your own network, type ${httpBase} to connect without encryption.`,
                    });
                }
                base = httpBase;
                health = overHttp;
            }
        }
    }
    if (!health.ok) return done({ ok: false, url: base, code: health.code, error: health.error, ...(health.status ? { status: health.status } : {}) });

    // ── 2. A web app lives here, and where it ends up after redirects ────────
    const warnings: string[] = [];
    const page = await checkPage(base, context);
    if (!page.ok) return done({ ok: false, url: base, code: page.code, error: page.error, ...(page.status ? { status: page.status } : {}) });
    if (page.warning) warnings.push(page.warning);

    if (page.finalBase && page.finalBase !== base) {
        // Redirected somewhere else. Followed by itself only when that cannot
        // lower the bar the person set by what they typed (see adoptsRedirect);
        // otherwise they are shown the new address and decide.
        if (!adoptsRedirect(base, page.finalBase)) {
            const downgrade = base.startsWith('https:') && page.finalBase.startsWith('http:');
            return done({
                ok: false,
                url: base,
                code: 'redirected',
                redirectTarget: page.finalBase,
                error: downgrade
                    ? `${hostOf(base)} sends you on to ${page.finalBase}, which is not encrypted. Bee Flow will not switch from https to http by itself; if that really is your server, enter the address yourself.`
                    : `${hostOf(base)} sends you on to ${page.finalBase}. If that is your Bee Flow server, enter that address instead.`,
            });
        }
        const moved = await checkHealth(page.finalBase, context);
        if (!moved.ok) {
            return done({
                ok: false,
                url: base,
                code: moved.code,
                error: `${hostOf(base)} redirects to ${page.finalBase}, and there: ${moved.error}`,
            });
        }
        base = page.finalBase;
        health = moved;
    }

    // ── 3 & 4. Signing in will work, and where single sign-on starts ─────────
    const [origin, apiOrigin] = await Promise.all([checkOrigin(base, context), findApiOrigin(base, context)]);
    if (!origin.ok) return done({ ok: false, url: base, code: origin.code, error: origin.error });
    if (origin.warning) warnings.push(origin.warning);

    const parsed = new URL(base);
    const result: ServerProbeResult = {
        ok: true,
        url: base,
        status: health.status,
        insecure: parsed.protocol === 'http:' && hostKind(parsed.hostname) !== 'loopback',
    };
    if (health.appVersion) result.appVersion = health.appVersion;
    if (apiOrigin) result.apiOrigin = apiOrigin;
    if (warnings.length > 0) result.warnings = warnings;
    return done(result);
}

// ── The individual checks ────────────────────────────────────────────────────

async function checkHealth(base: string, context: Context): Promise<Step<{ status: number; appVersion?: string }>> {
    const url = serverUrl(base, '/api/health');
    const response = await request(url, context, context.timeoutMs, { Accept: 'application/json' });
    if (!response.ok) return response;
    const { status } = response.response;

    if (status < 200 || status >= 300) {
        return { ok: false, code: 'http-error', status, error: describeStatus(status, base) };
    }

    // A 200 is not enough. A reverse proxy in front of the wrong vhost, a
    // captive portal and a parked domain all answer 200 with HTML, and telling
    // someone their Bee Flow server is fine when it is a login page for
    // somebody's router wastes an afternoon.
    let payload: unknown;
    try {
        payload = JSON.parse(await response.response.text());
    } catch {
        return { ok: false, code: 'not-bee-flow', status, error: 'Something answered at that address, but it is not a Bee Flow server.' };
    }
    const health = payload as { status?: unknown; appVersion?: unknown } | null;
    if (!health || health.status !== 'ok') {
        return { ok: false, code: 'not-bee-flow', status, error: 'That address answered, but not with a Bee Flow health check.' };
    }
    return {
        ok: true,
        status,
        ...(typeof health.appVersion === 'string' && health.appVersion ? { appVersion: health.appVersion } : {}),
    };
}

/**
 * GET the address the window will load.
 *
 * Only a 404 is a verdict: that is Express answering for the API port, where
 * no SPA is mounted. Anything else — the SPA, a marketing page on SaaS, a
 * login page — is something the window can show. A network failure here is
 * not a verdict either; the health check already reached the server.
 */
async function checkPage(base: string, context: Context): Promise<Step<{ finalBase?: string; warning?: string }>> {
    const response = await request(`${base}/`, context, FOLLOW_UP_TIMEOUT_MS, { Accept: 'text/html' });
    if (!response.ok) return { ok: true, warning: `The web app page did not load during the check (${response.error}).` };

    const { status, url } = response.response;
    if (status === 404) {
        return {
            ok: false,
            code: 'api-port',
            status,
            error: `${hostOf(base)} is the Bee Flow API, not the web app. Use the address you open Bee Flow at in a browser — on a standard install that is port 5176.`,
        };
    }
    const final = normaliseServerUrl(url || `${base}/`);
    return final.ok ? { ok: true, finalBase: final.url } : { ok: true };
}

/**
 * Will the server accept requests from this address?
 *
 * The server's Origin gate (server/index.js) answers 403 "Origin not allowed"
 * to ANY request whose Origin is not in CORS_ORIGIN, before routing. The window
 * sends `Origin` on every POST, so a server reached at an address it does not
 * list loads fine and then refuses the sign-in. Asked here with the Origin the
 * window will send — on /api/ and on /ai/, which a front proxy can route with a
 * different Host. Only an explicit refusal fails the probe; a check that could
 * not run is a warning.
 */
async function checkOrigin(base: string, context: Context): Promise<Step<{ warning?: string }>> {
    const origin = originOf(base);
    if (!origin) return { ok: true };
    const paths = ['/api/health', '/ai/'];
    const answers = await Promise.all(paths.map((suffix) => request(serverUrl(base, suffix), context, FOLLOW_UP_TIMEOUT_MS, { Origin: origin })));

    for (const answer of answers) {
        if (!answer.ok || answer.response.status !== 403) continue;
        const body = await answer.response.text().catch(() => '');
        if (/origin not allowed/i.test(body)) {
            return {
                ok: false,
                code: 'origin-refused',
                error: `${hostOf(base)} does not accept requests from ${origin} yet, so signing in would fail. On the server, add ${origin} to CLIENT_PUBLIC_HOST (or CORS_ORIGIN) and restart it.`,
            };
        }
    }
    const failed = answers.find((answer) => !answer.ok);
    return failed && !failed.ok ? { ok: true, warning: `Could not confirm that the server accepts ${origin} (${failed.error}).` } : { ok: true };
}

/**
 * The origin the web app starts single sign-on at, when it is a second one.
 *
 * The SPA sends its SSO buttons to `SERVER_PROTOCOL://SERVER_PUBLIC_HOST`
 * (reported by /auth/setup-status) — often the API port or an API host rather
 * than the address the SPA was loaded from. Without knowing it, the window
 * treats that hop as a link to another site and hands it to the browser, where
 * the sign-in completes in the wrong cookie jar.
 *
 * Refused: anything that is not http(s); a loopback address for a server that
 * is not itself on this computer (the stock `localhost:3001` would point back
 * at the user's own machine); and a downgrade from an https server to http.
 */
async function findApiOrigin(base: string, context: Context): Promise<string | undefined> {
    const response = await request(serverUrl(base, '/auth/setup-status'), context, FOLLOW_UP_TIMEOUT_MS, { Accept: 'application/json' });
    if (!response.ok || response.response.status !== 200) return undefined;

    let reported: unknown;
    try {
        reported = (JSON.parse(await response.response.text()) as { serverUrl?: unknown })?.serverUrl;
    } catch {
        return undefined;
    }
    if (typeof reported !== 'string' || !reported) return undefined;

    const candidate = originOf(reported);
    const server = new URL(base);
    if (!candidate || candidate === server.origin) return undefined;
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    if (server.protocol === 'https:' && parsed.protocol !== 'https:') return undefined;
    if (hostKind(parsed.hostname) === 'loopback' && hostKind(server.hostname) !== 'loopback') return undefined;
    return candidate;
}

/**
 * May the probe save the address a redirect leads to without asking?
 *
 * - the same host (another path or port, or http becoming https): yes —
 *   nobody can hand the app to a different machine that way;
 * - https to https: yes — the certificate vouches for the new host;
 * - anything else, no. That covers https→http, and http onto another host,
 *   where whoever answered in plain text could have sent the app anywhere —
 *   including to a name like `nas.local` that the fallback itself refuses.
 */
export function adoptsRedirect(from: string, to: string): boolean {
    let a: URL;
    let b: URL;
    try {
        a = new URL(from);
        b = new URL(to);
    } catch {
        return false;
    }
    if (a.protocol === 'https:' && b.protocol === 'http:') return false;
    if (a.hostname === b.hostname) return true;
    return a.protocol === 'https:' && b.protocol === 'https:';
}

// ── Plumbing ─────────────────────────────────────────────────────────────────

async function request(
    url: string,
    context: Context,
    timeoutMs: number,
    headers: Record<string, string>,
): Promise<{ ok: true; response: ProbeResponse } | { ok: false; code: ServerProbeFailure; error: string; speaksHttp: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await context.fetch(url, {
            signal: controller.signal,
            headers: { 'X-Beeflow-Client': 'desktop', ...headers },
        });
        return { ok: true, response };
    } catch (error) {
        const classified = classifyNetworkError(error, { url, timeoutMs, platform: context.platform });
        return { ok: false, code: classified.code, error: classified.message, speaksHttp: classified.speaksHttp };
    } finally {
        clearTimeout(timer);
    }
}

function describeStatus(status: number, url: string): string {
    if (status === 401 || status === 403) {
        return 'That server is there but refused the health check — something in front of it is asking for a login.';
    }
    if (status === 404) {
        return `No Bee Flow API at ${url}. If your server lives under a path, include it (for example ${url}/beeflow).`;
    }
    if (status === 502 || status === 503 || status === 504) {
        return 'The server is reachable but not answering yet — it may still be starting up.';
    }
    return `The server answered with HTTP ${status}.`;
}

/** Node's own fetch, for callers (and tests) that do not pass one. */
const nodeFetch: FetchLike = async (url, init) => {
    const response = await fetch(url, { ...(init?.signal ? { signal: init.signal } : {}), ...(init?.headers ? { headers: init.headers } : {}), redirect: 'follow' });
    return { status: response.status, url: response.url || url, headers: response.headers, text: () => response.text() };
};
