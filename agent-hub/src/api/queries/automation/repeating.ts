// "Find repeating work": the ONLY place that knows the wire contract of
//   GET  /api/automation/builder/suggest/sources   which source groups exist
//   GET  /api/automation/builder/suggest/last      the viewer's last scan
//   POST /api/automation/builder/suggest           the scan itself (SSE)
//   POST /api/automation/builder/feedback          not now / not repetitive / opened
//
// `authFetch` rather than `apiClient`, like the other automation reads: the
// page renders a failure as a sentence. The SSE frames are read by the shared
// utils/sseStream reader, the same one useAutomationApi uses.
//
// The hooks call the network through `repeatingApi` (an object, not the bare
// functions), so a test can replace one call with vi.spyOn and keep the rest.

import { useMutation, useQuery } from '@tanstack/react-query';
import { safeText } from '../../../hooks/useAutomationApi';
import type { AutomationApiError } from '../../../hooks/useAutomationApi';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { readEventStream } from '../../../utils/sseStream';

/* ── Shapes ─────────────────────────────────────────────────────────── */

export interface ScanSourceApp { id: string; label: string; connected: boolean }

/** One group the scan can read: mail, calendar, files or Bee Flow activity. */
export interface ScanSourceGroup {
    id: string;
    /** `live` reads the app at scan time, `stored` reads what Bee Flow already keeps. */
    kind: 'live' | 'stored';
    apps: ScanSourceApp[];
    connected: boolean;
}

export interface ScanSources { windowDays: number; groups: ScanSourceGroup[] }

export type ScanMode = 'patterns' | 'ideas';
export type CadenceKind = 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly' | 'irregular';

export interface PatternCadence {
    kind: CadenceKind | string;
    /** 0 = Sunday, like Date#getDay. */
    weekday?: number;
    /** [from, to) in whole hours. */
    hourBand?: [number, number];
    perMonth?: number;
    weeksPresent?: number;
    weeksWindow?: number;
}

export interface DraftStep { family: string; app?: string; label: string }
export interface PatternDraft {
    /** An `app` trigger also names the declared `provider` and `event` the builder's app_event trigger takes. */
    trigger: { kind: string; app?: string; provider?: string; event?: string; label: string };
    steps: DraftStep[];
}

/** What the miner measured. Every number here is the server's, never the model's. */
export interface Pattern {
    kind: string;
    signature: string;
    cadence: PatternCadence;
    occurrences: number;
    windowDays: number;
    distinctDays: number;
    weekdayHistogram: number[];
    minutesPerMonth: [number, number] | null;
    basis: 'measured' | 'heuristic';
    template: string | null;
    apps: string[];
    draft: PatternDraft | null;
    reasons: string[];
    confidence: 'early' | 'normal' | 'high';
}

export interface RepeatingSuggestion {
    id: string;
    title: string;
    description?: string;
    requiredIntegrations?: string[];
    unavailableIntegrations?: string[];
    triggerKind?: string | null;
    buildPrompt?: string;
    groundedIn?: string | null;
    complexity?: string | null;
    evidence?: unknown;
    value?: unknown;
    /** Absent on an idea and on a scan from before the pattern miner. */
    pattern?: Pattern | null;
}

export interface ScanSummary {
    /** Patterns mode: the source groups or apps read. */
    sources?: string[];
    /** Ideas mode: the apps read. */
    integrations?: string[];
    events?: number;
    templates?: number;
    patterns?: number;
    toolCalls?: number;
    piiCategories?: string[];
}

export interface ScanResult {
    suggestions: RepeatingSuggestion[];
    summary: ScanSummary | null;
    reason: string | null;
    scannedAt: string | null;
    cached: boolean;
    mode: ScanMode;
    /** What this result was scanned with, when known (for the "sources changed" hint). */
    sources?: string[];
    focus?: string;
}

export interface ScanBody {
    mode?: ScanMode;
    sources?: string[];
    focus?: string;
    force?: boolean;
    /** The viewer's IANA zone: the server counts weekdays and hours in it ("Mon 09–10" is local time). */
    timezone?: string;
}

export type FeedbackAction = 'dismissed' | 'built' | 'asked' | 'snoozed' | 'opened';
export type ReasonCode = 'wrong_grouping' | 'do_myself' | 'already_automated' | 'privacy';

export interface FeedbackBody {
    action: FeedbackAction;
    signature?: string;
    reasonCode?: ReasonCode;
    suggestion: { id?: string; title: string; requiredIntegrations?: string[]; groundedIn?: string | null; complexity?: string | null };
}

export type ScanEventHandler = (event: string, data: unknown) => void;

/* ── Parsing (tolerant: an old cache row or a junk field must not crash the page) ── */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown, fb = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);
const pair = (v: unknown): [number, number] | null => (
    Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'number' && Number.isFinite(x)) ? [v[0], v[1]] : null
);

export function parseScanSources(body: unknown): ScanSources {
    const raw = obj(body) || {};
    const groups: ScanSourceGroup[] = [];
    for (const g of Array.isArray(raw.groups) ? raw.groups : []) {
        const row = obj(g);
        const id = text(row?.id);
        if (!row || !id) continue;
        const apps = (Array.isArray(row.apps) ? row.apps : [])
            .map(obj)
            .filter((a): a is Obj => !!a && !!text(a.id))
            .map(a => ({ id: a.id as string, label: text(a.label) || (a.id as string), connected: a.connected === true }));
        groups.push({
            id,
            kind: row.kind === 'live' ? 'live' : 'stored',
            apps,
            connected: row.connected === true || apps.some(a => a.connected),
        });
    }
    return { windowDays: num(raw.windowDays, 90) || 90, groups };
}

function parseDraft(v: unknown): PatternDraft | null {
    const d = obj(v);
    const trig = obj(d?.trigger);
    if (!d || !trig) return null;
    const steps = (Array.isArray(d.steps) ? d.steps : []).map(obj).filter((s): s is Obj => !!s && !!text(s.label))
        .map(s => ({ family: text(s.family) || 'app', label: s.label as string, ...(text(s.app) ? { app: s.app as string } : {}) }));
    const optional = (key: 'app' | 'provider' | 'event') => (text(trig[key]) ? { [key]: trig[key] as string } : {});
    return {
        trigger: { kind: text(trig.kind) || 'manual', label: text(trig.label) || '', ...optional('app'), ...optional('provider'), ...optional('event') },
        steps,
    };
}

export function parsePattern(v: unknown): Pattern | null {
    const p = obj(v);
    if (!p) return null;
    const c = obj(p.cadence) || {};
    const hist = Array.isArray(p.weekdayHistogram) ? p.weekdayHistogram.map(x => num(x)) : [];
    const band = pair(c.hourBand);
    return {
        kind: text(p.kind) || 'sequence',
        signature: text(p.signature) || '',
        cadence: {
            kind: text(c.kind) || 'irregular',
            ...(typeof c.weekday === 'number' ? { weekday: c.weekday } : {}),
            ...(band ? { hourBand: band } : {}),
            perMonth: num(c.perMonth),
            weeksPresent: num(c.weeksPresent),
            weeksWindow: num(c.weeksWindow),
        },
        occurrences: num(p.occurrences),
        windowDays: num(p.windowDays, 90),
        distinctDays: num(p.distinctDays),
        weekdayHistogram: hist.length === 7 ? hist : [0, 0, 0, 0, 0, 0, 0],
        minutesPerMonth: pair(p.minutesPerMonth),
        basis: p.basis === 'measured' ? 'measured' : 'heuristic',
        template: text(p.template),
        apps: strings(p.apps),
        draft: parseDraft(p.draft),
        reasons: strings(p.reasons),
        confidence: p.confidence === 'early' || p.confidence === 'high' ? p.confidence : 'normal',
    };
}

export function parseSuggestion(v: unknown, index = 0): RepeatingSuggestion | null {
    const s = obj(v);
    const title = text(s?.title);
    if (!s || !title) return null;
    return {
        ...(s as Partial<RepeatingSuggestion>),
        id: text(s.id) || `s${index}`,
        title,
        requiredIntegrations: strings(s.requiredIntegrations),
        unavailableIntegrations: strings(s.unavailableIntegrations),
        pattern: parsePattern(s.pattern),
    };
}

export function parseSuggestions(v: unknown): RepeatingSuggestion[] {
    const out: RepeatingSuggestion[] = [];
    (Array.isArray(v) ? v : []).forEach((x, i) => {
        const s = parseSuggestion(x, i);
        if (s && !out.some(o => o.id === s.id)) out.push(s);
    });
    return out;
}

/** A `done` frame or a /suggest/last body, as one result. */
export function parseScanResult(body: unknown, fallbackMode: ScanMode = 'patterns'): ScanResult | null {
    const raw = obj(body);
    if (!raw || !Array.isArray(raw.suggestions)) return null;
    const summary = obj(raw.summary);
    return {
        suggestions: parseSuggestions(raw.suggestions),
        summary: summary ? summary as ScanSummary : null,
        reason: text(raw.reason),
        scannedAt: text(raw.scannedAt) || text(raw.scanned_at),
        cached: raw.cached === true,
        mode: raw.mode === 'ideas' ? 'ideas' : raw.mode === 'patterns' ? 'patterns' : fallbackMode,
        ...(Array.isArray(raw.sources) ? { sources: strings(raw.sources) } : {}),
        ...(typeof raw.focus === 'string' ? { focus: raw.focus } : {}),
    };
}

/* ── Calls ──────────────────────────────────────────────────────────── */

const BASE = () => `${API_BASE}/api/automation/builder`;

async function fetchScanSources(signal?: AbortSignal): Promise<ScanSources> {
    const res = await authFetch(`${BASE()}/suggest/sources`, { signal });
    if (!res.ok) throw new Error((await safeText(res)) || `Scan sources ${res.status}`);
    return parseScanSources(await res.json());
}

/** The viewer's last patterns scan, or null (204, 404, an ideas scan, or anything unreadable). */
async function fetchLastScan(signal?: AbortSignal): Promise<ScanResult | null> {
    try {
        const res = await authFetch(`${BASE()}/suggest/last`, { signal });
        if (!res.ok || res.status === 204) return null;
        const body = await res.text();
        if (!body) return null;
        const result = parseScanResult(JSON.parse(body));
        return result && result.mode === 'patterns' ? result : null;
    } catch {
        return null;
    }
}

async function postFeedback(body: FeedbackBody): Promise<void> {
    const res = await authFetch(`${BASE()}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await safeText(res)) || `Feedback ${res.status}`);
}

/**
 * Run one scan; resolves when the stream ends. A refusal before the stream
 * starts throws with `status`, and `retryAfter` on a 429, so the page can tell
 * a cooldown from a failure.
 */
async function streamPatternScan(body: ScanBody, onEvent: ScanEventHandler, signal?: AbortSignal): Promise<void> {
    const res = await authFetch(`${BASE()}/suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok || !res.body) {
        const err: AutomationApiError = new Error((await safeText(res)) || 'Suggestion scan failed');
        err.status = res.status;
        const ra = Number(res.headers?.get?.('Retry-After'));
        if (Number.isFinite(ra) && ra > 0) err.retryAfter = ra;
        throw err;
    }
    await readEventStream(res.body, onEvent, signal);
}

export const repeatingApi = { fetchScanSources, fetchLastScan, postFeedback, streamPatternScan };

/* ── Hooks ──────────────────────────────────────────────────────────── */

export const repeatingKeys = {
    sources: ['automation', 'repeating', 'sources'] as const,
    last: ['automation', 'repeating', 'last'] as const,
};

export function useScanSources() {
    return useQuery({
        queryKey: repeatingKeys.sources,
        queryFn: ({ signal }) => repeatingApi.fetchScanSources(signal),
        staleTime: 60_000,
    });
}

/** Never refetched behind the viewer's back: a scan runs only on demand, and its result is written here. */
export function useLastScan() {
    return useQuery({
        queryKey: repeatingKeys.last,
        queryFn: ({ signal }) => repeatingApi.fetchLastScan(signal),
        staleTime: Infinity,
        refetchOnWindowFocus: false,
    });
}

export function useScanFeedback() {
    return useMutation({ mutationFn: (body: FeedbackBody) => repeatingApi.postFeedback(body) });
}
