/**
 * Which Bee Flow does this install talk to?
 *
 * The web app never has to ask — it is served BY the server, so `API_BASE` is
 * a relative path (agent-hub/src/utils/helpers.js getApiBase). An APK has no
 * such anchor: the same binary is installed by a SaaS customer pointing at
 * beeflow.nl, by a company pointing at ai.acme.example, and by someone running
 * `./selfhost.sh` on a laptop at http://192.168.1.20:3101. So the server URL is
 * first-class state: asked for on first run, changeable in Settings, and
 * validated against /api/health before it is ever remembered.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

import { MIN_SERVER_BUILD } from './contract';

export { MIN_SERVER_BUILD };

const STORAGE_KEY = 'beeflow.server.url';

/**
 * Seeded at build time (BEEFLOW_DEFAULT_SERVER_URL). Empty by default, which
 * makes first run ASK rather than silently point a self-hoster at the SaaS.
 */
const BUILD_DEFAULT = String(
    (Constants.expoConfig?.extra as { defaultServerUrl?: string } | undefined)?.defaultServerUrl ?? '',
);

let current: string | null = null;
const listeners = new Set<(url: string | null) => void>();

/**
 * Normalise what a person typed into something fetch can use.
 *
 * People type "beeflow.nl", "beeflow.nl/", "https://beeflow.nl/app". All three
 * mean the same host. Scheme defaults to https — a bare host over cleartext is
 * a mistake far more often than it is a LAN address, and the LAN case can
 * still be expressed by typing http:// explicitly.
 */
export function normaliseServerUrl(input: string): string {
    let value = input.trim();
    if (!value) return '';
    if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
    try {
        const url = new URL(value);
        // Strip a trailing slash and any path the user pasted from a browser
        // address bar — API paths are appended to this and "/app" would break
        // every one of them.
        const path = url.pathname.replace(/\/+$/, '');
        const keptPath = path === '' || path === '/app' ? '' : path;
        return `${url.protocol}//${url.host}${keptPath}`;
    } catch {
        return '';
    }
}

/** True when the URL would send credentials in the clear. */
export function isInsecure(url: string): boolean {
    return /^http:\/\//i.test(url.trim());
}

/**
 * Loopback and RFC1918 addresses. Cleartext to one of these is a self-hoster on
 * their own network; cleartext to a public host is a mistake worth blocking on.
 */
export function isPrivateHost(url: string): boolean {
    try {
        const { hostname } = new URL(url);
        if (hostname === 'localhost' || hostname.endsWith('.local')) return true;
        if (/^10\./.test(hostname)) return true;
        if (/^192\.168\./.test(hostname)) return true;
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
        if (/^127\./.test(hostname)) return true;
        return false;
    } catch {
        return false;
    }
}

export async function loadServerUrl(): Promise<string | null> {
    if (current !== null) return current;
    try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY);
        current = stored ?? (BUILD_DEFAULT ? normaliseServerUrl(BUILD_DEFAULT) : null);
    } catch {
        current = BUILD_DEFAULT ? normaliseServerUrl(BUILD_DEFAULT) : null;
    }
    return current;
}

/** Synchronous read for call sites that cannot await (interceptors, SSE). */
export function getServerUrl(): string | null {
    return current;
}

export async function setServerUrl(url: string | null): Promise<void> {
    current = url;
    if (url) await AsyncStorage.setItem(STORAGE_KEY, url);
    else await AsyncStorage.removeItem(STORAGE_KEY);
    listeners.forEach((fn) => fn(url));
}

export function onServerUrlChange(fn: (url: string | null) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export interface HealthResult {
    ok: boolean;
    /** Server build sha, when it reports one. Shown in Settings → About. */
    appVersion?: string;
    /** Populated when ok is false — a human-readable reason, not a stack. */
    error?: string;
}

/**
 * Probe a candidate server before committing to it.
 *
 * /api/health is public (server/index.js) and answers `{status:'ok'}`, so this
 * distinguishes "wrong URL" from "right URL, not logged in" — which a 401 from
 * any other endpoint would not.
 */
export async function checkHealth(url: string, timeoutMs = 8000): Promise<HealthResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${url}/api/health`, {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
        });
        if (!res.ok) return { ok: false, error: `Server answered HTTP ${res.status}` };
        const body = (await res.json()) as { status?: string; appVersion?: string };
        if (body?.status !== 'ok') {
            return { ok: false, error: 'That address answered, but it is not a Bee Flow server.' };
        }
        return { ok: true, appVersion: body.appVersion };
    } catch (err) {
        const message = (err as Error)?.name === 'AbortError'
            ? 'The server did not answer in time.'
            : 'Could not reach that address. Check the URL and your connection.';
        return { ok: false, error: message };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Is the configured server new enough for this APK?
 *
 * The APK and the server ship independently, and the server reports only a
 * git sha — nothing orderable — so "new enough" cannot be a version compare.
 * It is a CAPABILITY probe instead: every server built since MIN_SERVER_BUILD
 * serves `GET /api/health/schema` (unauthenticated, always 200 — see
 * server/routes/healthSchema.js, pinned in serverContract.test.ts). A 404
 * there is therefore a server from before that date.
 *
 * Deliberately soft. The answer feeds a warning (Settings → About), never a
 * lock: a self-hoster mid-upgrade still deserves a working app plus an honest
 * explanation of why some screens misbehave — not a wall.
 */
export interface ServerSupport {
    /**
     * 'ok'       — the probe answered; the server meets MIN_SERVER_BUILD.
     * 'outdated' — the probe 404'd: the server predates MIN_SERVER_BUILD.
     * 'unknown'  — network trouble or a non-JSON answer; say nothing rather
     *              than accuse a reachable-but-hiccuping server of being old.
     */
    level: 'ok' | 'outdated' | 'unknown';
    /** The server's build stamp, when it reported one. */
    build?: string;
}

export async function checkServerSupport(url: string, timeoutMs = 8000): Promise<ServerSupport> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${url}/api/health/schema`, {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
        });
        if (res.status === 404) return { level: 'outdated' };
        if (!res.ok) return { level: 'unknown' };
        const body = (await res.json()) as { ok?: boolean; build?: string };
        return {
            level: 'ok',
            build: typeof body?.build === 'string' ? body.build : undefined,
        };
    } catch {
        return { level: 'unknown' };
    } finally {
        clearTimeout(timer);
    }
}

/** Absolute URL for an API path, or null when no server is configured yet. */
export function apiUrl(path: string): string {
    const base = current;
    if (!base) throw new NoServerConfiguredError();
    if (path.startsWith('http')) return path;
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export class NoServerConfiguredError extends Error {
    constructor() {
        super('No Bee Flow server has been configured yet.');
        this.name = 'NoServerConfiguredError';
    }
}
