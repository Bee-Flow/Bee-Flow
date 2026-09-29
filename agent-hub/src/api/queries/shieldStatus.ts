// Privacy Shield status — the ONLY place that knows the
// /api/privacy/shield-status wire contract.
//
// The memo and the in-flight promise that used to sit in module scope at the
// top of hooks/useShieldStatus are gone: React Query already collapses
// concurrent mounts into one request and already shares the last answer, and
// unlike a `let _cache` it is dropped on logout — a module cache keyed on
// nothing kept showing the previous account's org shield (sessionCaches.ts).
//
// `authFetch` rather than `apiClient`: a non-ok response here is a STATE with
// its own code, not an exception carrying a parsed error body, and the
// consuming screens all mock `authFetch` with a bare `{ ok, status, json }`.

import { useQuery } from '@tanstack/react-query';
import { useDocumentFocused } from './documentFocus';
import { API_BASE, authFetch } from '../../utils/helpers';

export const SHIELD_STATUS_POLL_MS = 30_000;
// Shorter than the poll, so an instance's own tick actually refreshes rather
// than reading its neighbour's cached answer forever.
export const SHIELD_STATUS_TTL_MS = 25_000;

export type ShieldSource = 'org' | 'personal' | 'platform' | 'off';
export type ShieldAction = 'redact' | 'block' | 'ask';
export type ShieldFailMode = 'fail_closed' | 'fail_open';
/** A code, never a sentence — the consumer picks the wording. */
export type ShieldError = 'unauthorized' | 'unavailable' | 'invalid' | 'network';

export interface ShieldStatus {
    enabled: boolean;
    source: ShieldSource;
    action: ShieldAction | null;
    failMode: ShieldFailMode;
    guardReachable: boolean;
    euMode: boolean;
    coworkEnabled: boolean;
}

const SOURCES = new Set<string>(['org', 'personal', 'platform', 'off']);
const ACTIONS = new Set<string>(['redact', 'block', 'ask']);
const FAIL_MODES = new Set<string>(['fail_closed', 'fail_open']);

export const shieldStatusKeys = {
    all: ['shield-status'] as const,
};

/**
 * Allow-list one response body. Exported for the test; tolerant of junk —
 * anything unexpected reads as the negative state, and a non-object is null.
 */
export function parseShieldStatus(body: unknown): ShieldStatus | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const raw = body as Record<string, unknown>;
    const source = typeof raw.source === 'string' && SOURCES.has(raw.source) ? raw.source as ShieldSource : 'off';
    const action = typeof raw.action === 'string' && ACTIONS.has(raw.action) ? raw.action as ShieldAction : null;
    const failMode = typeof raw.failMode === 'string' && FAIL_MODES.has(raw.failMode)
        ? raw.failMode as ShieldFailMode
        : 'fail_closed';
    return {
        enabled: raw.enabled === true,
        source,
        action,
        failMode,
        guardReachable: raw.guardReachable === true,
        euMode: raw.euMode === true,
        coworkEnabled: raw.coworkEnabled === true,
    };
}

/** Carries the code the consumer is allowed to see. */
export class ShieldStatusError extends Error {
    code: ShieldError;
    constructor(code: ShieldError) {
        super(code);
        this.name = 'ShieldStatusError';
        this.code = code;
    }
}

/** The code for an error of any shape — anything unrecognised is a network fault. */
export function shieldErrorCode(e: unknown): ShieldError {
    return e instanceof ShieldStatusError ? e.code : 'network';
}

export async function fetchShieldStatus(signal?: AbortSignal): Promise<ShieldStatus> {
    let res: Response;
    try {
        res = await authFetch(`${API_BASE}/api/privacy/shield-status`, { signal });
    } catch {
        throw new ShieldStatusError('network');
    }
    if (!res.ok) throw new ShieldStatusError(res.status === 401 ? 'unauthorized' : 'unavailable');
    let data: ShieldStatus | null;
    try {
        data = parseShieldStatus(await res.json());
    } catch {
        throw new ShieldStatusError('network');
    }
    if (!data) throw new ShieldStatusError('invalid');
    return data;
}

export function useShieldStatusQuery({ enabled = true }: { enabled?: boolean } = {}) {
    const focused = useDocumentFocused();
    return useQuery<ShieldStatus, ShieldStatusError>({
        queryKey: shieldStatusKeys.all,
        queryFn: ({ signal }) => fetchShieldStatus(signal),
        // Hidden tab: no read at all, not even the one React Query would do on
        // mount. Becoming visible flips this and the read happens then.
        enabled: enabled && focused,
        staleTime: SHIELD_STATUS_TTL_MS,
        // A RUNTIME claim, not configuration: an admin flipping the shield, or
        // the detector going down, has to reach the screen without a reload.
        refetchInterval: SHIELD_STATUS_POLL_MS,
        refetchOnWindowFocus: true,
        // The poll is the retry. Retrying inside one tick would only delay the
        // honest "unknown" by the backoff.
        retry: false,
    });
}
