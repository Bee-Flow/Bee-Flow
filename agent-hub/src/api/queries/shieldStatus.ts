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

export type ChatMonitoringState = 'off' | 'scheduled' | 'on';
/** The chat types a client can announce. Mobile and the notebook are not among them. */
export type ChatSignalsSurface = 'direct' | 'agent' | 'agent_public';
export type ChatSignal = 'outcomes' | 'kinds';

/**
 * Chat signals as the status route reports them for the caller's
 * organisation: the state, the start date, the version (the exact
 * `effective_from` timestamp a marker repeats), the counted chat types and
 * signals, and the organisation's own https notice. Nothing else travels.
 */
export interface ChatMonitoringStatus {
    state: ChatMonitoringState;
    from: string | null;
    version: string | null;
    surfaces: ChatSignalsSurface[];
    signals: ChatSignal[];
    noticeUrl: string | null;
}

export interface ShieldStatus {
    enabled: boolean;
    source: ShieldSource;
    action: ShieldAction | null;
    failMode: ShieldFailMode;
    guardReachable: boolean;
    euMode: boolean;
    coworkEnabled: boolean;
    chatMonitoring: ChatMonitoringStatus;
}

const SOURCES = new Set<string>(['org', 'personal', 'platform', 'off']);
const ACTIONS = new Set<string>(['redact', 'block', 'ask']);
const FAIL_MODES = new Set<string>(['fail_closed', 'fail_open']);
const CM_STATES = new Set<string>(['off', 'scheduled', 'on']);
const CM_SURFACES: readonly ChatSignalsSurface[] = ['direct', 'agent', 'agent_public'];
const CM_SIGNALS: readonly ChatSignal[] = ['outcomes', 'kinds'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The exact shape of `effective_from` as the server writes it: the version a marker repeats. */
export const CHAT_MONITORING_VERSION_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Nothing counted, nothing announced. Also what an older server (no field) and any junk read as. */
export const CHAT_MONITORING_OFF: ChatMonitoringStatus = Object.freeze({
    state: 'off',
    from: null,
    version: null,
    surfaces: Object.freeze([]) as unknown as ChatSignalsSurface[],
    signals: Object.freeze([]) as unknown as ChatSignal[],
    noticeUrl: null,
});

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
        chatMonitoring: parseChatMonitoring(raw.chatMonitoring),
    };
}

/** Only an absolute https URL survives; anything else is no link at all. */
export function httpsUrlOrNull(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 500) return null;
    try {
        return new URL(value).protocol === 'https:' ? value : null;
    } catch {
        return null;
    }
}

/** The known ids of `value`, deduplicated, in vocabulary order. */
function knownIds<T extends string>(value: unknown, vocabulary: readonly T[]): T[] {
    const given = new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
    return vocabulary.filter((id) => given.has(id));
}

/**
 * Allow-list the `chatMonitoring` block. A state the client cannot tie to a
 * version (no version, or one in another shape) reads as off: without the
 * version there is no marker, and a notice without a marker would announce
 * something that is then not counted.
 */
export function parseChatMonitoring(raw: unknown): ChatMonitoringStatus {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return CHAT_MONITORING_OFF;
    const r = raw as Record<string, unknown>;
    const state = typeof r.state === 'string' && CM_STATES.has(r.state) ? r.state as ChatMonitoringState : 'off';
    const version = typeof r.version === 'string' && CHAT_MONITORING_VERSION_RE.test(r.version) ? r.version : null;
    if (state === 'off' || !version) return CHAT_MONITORING_OFF;
    const from = typeof r.from === 'string' && DAY_RE.test(r.from) ? r.from : null;
    if (state === 'scheduled' && !from) return CHAT_MONITORING_OFF;
    return {
        state,
        from,
        version,
        surfaces: knownIds(r.surfaces, CM_SURFACES),
        signals: knownIds(r.signals, CM_SIGNALS),
        noticeUrl: httpsUrlOrNull(r.noticeUrl),
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
