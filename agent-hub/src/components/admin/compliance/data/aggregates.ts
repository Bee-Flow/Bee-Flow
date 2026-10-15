/**
 * The aggregate reads the redesign adds beside the registers: attention,
 * deadlines, frameworks, calendar, AI Act assessments. Each degrades to
 * `null` ("not loaded / not shipped") when the endpoint is absent or answers
 * junk — the nav test mocks every non-/overview url as `[]`.
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { toast } from '../../../shared/Toast';
import { API, fetchJson, json, jsonInit, asObject, asArray } from './api';
import useResource from './useResource';
import { addCalendarMonths, clockState, DAY_MS, HOUR_MS } from '../../../shared/deadlineMath';

const noop = () => {};

// ── Shapes the aggregate endpoints answer with ─────────────────────────────

/** One item of GET /attention. */
export interface AttentionItem {
    [key: string]: unknown;
}

/** GET /attention: the capped list of open items. */
export interface AttentionPayload {
    items: AttentionItem[];
    [key: string]: unknown;
}

/** A DSR row as the deadline clock reads it. */
export interface DsrRequestRow {
    id: number | string;
    status?: string | null;
    request_type?: string | null;
    created_at?: string | null;
    received_at?: string | null;
    due_at?: string | null;
    extended_until?: string | null;
}

/** An incident or vulnerability row as the deadline clock reads it. */
export interface IncidentRow {
    id: number | string;
    kind?: string | null;
    status?: string | null;
    title?: string | null;
    regimes?: unknown;
    deadline_at?: string | null;
    detected_at?: string | null;
    created_at?: string | null;
    early_warning_due_at?: string | null;
    early_warning_sent_at?: string | null;
    authority_notified_at?: string | null;
}

/** One clock of the deadlines card. */
export interface DeadlineItem {
    id: string;
    kind: string;
    ref: string;
    title?: string | null;
    meta?: { article: string } | null;
    started_at?: string | null;
    due_at?: string | null;
    state: string;
    pct?: number | null;
    /** A server app path, or a { section, id } object from the client fallback. */
    target?: string | { section: string; id?: string; tab?: string } | null;
}

/** GET /deadlines. */
export interface DeadlinesPayload {
    items: DeadlineItem[];
    empty_kinds?: string[];
    [key: string]: unknown;
}

/** One framework of GET /frameworks. */
export interface FrameworkRow {
    id: string;
    enabled?: boolean;
    core?: boolean;
    [key: string]: unknown;
}

/** GET /frameworks. */
export interface FrameworksPayload {
    frameworks: FrameworkRow[];
    custom?: unknown;
    catalogue?: unknown;
    [key: string]: unknown;
}

/** GET /calendar. */
export interface CalendarPayload {
    milestones: unknown[];
    [key: string]: unknown;
}

// ── Needs attention ────────────────────────────────────────────────────────
// The whole list (the server caps `limit` at 50): the Overview shows five and
// expands the rest inline, so every item is reachable without leaving the page.
export function useComplianceAttention({ enabled = true, limit = 50 }: { enabled?: boolean; limit?: number } = {}) {
    const res = useResource<AttentionPayload>(`${API}/attention?limit=${limit}`, {
        enabled,
        parse: (b) => { const o = asObject<AttentionPayload>(b); return o && Array.isArray(o.items) ? o : null; },
    });
    return { attention: res.data, items: res.data?.items ?? null, failed: res.failed, refresh: res.refresh };
}

// ── Deadlines ──────────────────────────────────────────────────────────────
// The citations GET /deadlines sends (server compliance/deadlines.js ARTICLE
// and REGIME_ARTICLE), printed as-is by the card.
const DSR_ARTICLE = 'GDPR Art. 12(3)';
const REGIME_ARTICLE: Readonly<Record<string, string>> = Object.freeze({
    GDPR: 'GDPR Art. 33',
    NIS2: 'NIS2 Art. 23(4)',
    DORA: 'DORA Art. 30(3)(b)',
    // A severe incident under the CRA beside another regime: one row here,
    // so the stage is unknown (the server lists each Art. 14(4) stage apart).
    CRA: 'CRA Art. 14(4)',
});
// The three CRA stages: a vulnerability (Art. 14(2)) or a severe incident (Art. 14(4)).
const CRA_ARTICLE = Object.freeze({
    vulnerability: Object.freeze({ cra_early_warning: 'CRA Art. 14(2)(a)', cra_notification: 'CRA Art. 14(2)(b)', cra_full_report: 'CRA Art. 14(2)(c)' }),
    severe: Object.freeze({ cra_early_warning: 'CRA Art. 14(4)(a)', cra_notification: 'CRA Art. 14(4)(b)', cra_full_report: 'CRA Art. 14(4)(c)' }),
});

/** The regimes a row is reported under; an unreadable list is the column's default (CRA for a vulnerability, else GDPR). */
function regimesOf(i: IncidentRow): string[] {
    let list: unknown = i.regimes;
    if (typeof list === 'string') {
        try { list = JSON.parse(list); } catch { list = null; }
    }
    return Array.isArray(list) && list.length ? (list as string[]) : [i.kind === 'vulnerability' ? 'CRA' : 'GDPR'];
}

/**
 * The CRA stage a CRA-only row's `deadline_at` counts down. The store keeps
 * `deadline_at` at the earliest clock still open, so it is the first stage
 * without its stamp: early warning (24 h), notification (72 h), final report.
 * Kinds, articles and urgency as the server's.
 */
function craStage(i: IncidentRow, severe: boolean): { kind: string; article: string; urgentBelowMs: number } {
    const articles: Readonly<Record<string, string>> = severe ? CRA_ARTICLE.severe : CRA_ARTICLE.vulnerability;
    let kind = 'cra_full_report';
    if (i.early_warning_due_at && !i.early_warning_sent_at) kind = 'cra_early_warning';
    else if (!i.authority_notified_at) kind = 'cra_notification';
    return { kind, article: articles[kind], urgentBelowMs: kind === 'cra_early_warning' ? 6 * HOUR_MS : 24 * HOUR_MS };
}

/** An incident's authority clock, cited per regime ("GDPR Art. 33 · NIS2 Art. 23(4)"). */
function incidentStage(regimes: string[]): { kind: string; article: string; urgentBelowMs: number } {
    const article = regimes.map(r => REGIME_ARTICLE[r]).filter(Boolean).join(' · ') || REGIME_ARTICLE.GDPR;
    return { kind: 'incident', article, urgentBelowMs: 24 * HOUR_MS };
}

/** A DSR's clock: the server's due date, else the extension, else one calendar month after receipt (Art. 12(3)). */
function dsrItem(r: DsrRequestRow, now: number): DeadlineItem {
    const started = r.created_at || r.received_at;
    const fallbackDue = addCalendarMonths(started, 1);
    const due = r.due_at || r.extended_until || (fallbackDue === null ? null : new Date(fallbackDue).toISOString());
    const c = clockState({ dueAt: due, startedAt: started, now, urgentBelowMs: 5 * DAY_MS });
    return { id: `dsr:${r.id}`, kind: 'dsr', ref: `#${r.id}`, title: r.request_type || 'request', meta: { article: DSR_ARTICLE },
        started_at: started, due_at: due, state: c.state, pct: c.pct, target: { section: 'dsr', id: String(r.id) } };
}

/** An incident's or a vulnerability's next open clock (`deadline_at`). */
function incidentItem(i: IncidentRow, now: number): DeadlineItem {
    const vuln = i.kind === 'vulnerability';
    const regimes = regimesOf(i);
    // A vulnerability, or a severe incident under the CRA alone, runs the CRA
    // stages; any other incident the authority clock of its regimes.
    const craOnly = vuln || regimes.every(r => r === 'CRA');
    const stage = craOnly ? craStage(i, !vuln) : incidentStage(regimes);
    const started = i.detected_at || i.created_at;
    const c = clockState({ dueAt: i.deadline_at, startedAt: started, now, urgentBelowMs: stage.urgentBelowMs });
    return { id: `${stage.kind}:${i.id}`, kind: stage.kind, ref: `INC-${i.id}`, title: i.title,
        meta: { article: stage.article }, started_at: started, due_at: i.deadline_at, state: c.state, pct: c.pct,
        target: { section: vuln ? 'vulnerabilities' : 'incidents', id: String(i.id) } };
}

/**
 * Client-side fallback: build the DSR + incident clocks from data the hub
 * already holds, so Overview's Deadlines card works before GET /deadlines
 * ships. Thresholds per regulation: DSR urgent ≤ 5 d, incident ≤ 24 h, CRA
 * early warning ≤ 6 h. A DSR without a server `due_at` is due one calendar
 * month after receipt (GDPR Art. 12(3)), the same date the server stores.
 */
export function deadlinesFromRegisters({ requests = null, incidents = null, now = Date.now() }: {
    requests?: DsrRequestRow[] | null;
    incidents?: IncidentRow[] | null;
    now?: number;
} = {}): DeadlineItem[] {
    const items = [
        ...(requests || []).filter(r => ['pending', 'in_progress'].includes(r.status ?? '')).map(r => dsrItem(r, now)),
        ...(incidents || []).filter(i => ['open', 'assessing'].includes(i.status ?? '')).map(i => incidentItem(i, now)),
    ];
    const rank: Record<string, number> = { overdue: 0, urgent: 1, ok: 2, none: 3, done: 4 };
    items.sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || new Date(a.due_at || 0).getTime() - new Date(b.due_at || 0).getTime());
    return items;
}

export function useComplianceDeadlines({ enabled = true, requests = null, incidents = null }: {
    enabled?: boolean;
    requests?: DsrRequestRow[] | null;
    incidents?: IncidentRow[] | null;
} = {}) {
    const res = useResource<DeadlinesPayload>(`${API}/deadlines`, {
        enabled,
        parse: (b) => { const o = asObject<DeadlinesPayload>(b); return o && Array.isArray(o.items) ? o : null; },
    });
    const fallback = useMemo(
        () => (requests || incidents ? deadlinesFromRegisters({ requests, incidents }) : null),
        [requests, incidents],
    );
    return {
        deadlines: res.data,
        items: res.data?.items ?? fallback,
        emptyKinds: res.data?.empty_kinds ?? [],
        fromServer: !!res.data,
        failed: res.failed,
        refresh: res.refresh,
    };
}

// ── Frameworks (the growing set) ───────────────────────────────────────────
export function useFrameworks({ enabled = true, onChanged = noop }: { enabled?: boolean; onChanged?: () => void } = {}) {
    const { t } = useTranslation();
    const res = useResource<FrameworksPayload>(`${API}/frameworks`, {
        enabled,
        parse: (b) => { const o = asObject<FrameworksPayload>(b); return o && Array.isArray(o.frameworks) ? o : null; },
    });
    const [busyId, setBusyId] = useState<string | null>(null);
    const act = useCallback(async (id: string, action: string, body: Record<string, unknown> | undefined, okKey?: string, okFallback?: string) => {
        setBusyId(id);
        try {
            const r = await fetchJson(`${API}/frameworks/${encodeURIComponent(id)}/${action}`, json(body || {}));
            await res.refresh(); onChanged();
            if (okKey) toast.success(t(okKey, okFallback));
            return r;
        } catch (e) {
            const locked = /403/.test(String((e as Error).message));
            toast.error(locked
                ? t('compliance.fw_toast_locked', 'This framework is not included in your plan')
                : t('compliance.fw_toast_failed', 'Could not update the framework'));
            throw e;
        } finally { setBusyId(null); }
    }, [res, onChanged, t]);

    const list = res.data?.frameworks ?? null;
    return {
        frameworks: list,
        active: list ? list.filter(f => f.enabled) : null,
        candidates: list ? list.filter(f => !f.enabled && !f.core) : null,
        custom: res.data?.custom ?? null,
        // How recently the legal register was checked (server: catalogueReview).
        catalogue: res.data?.catalogue ?? null,
        byId: (id: string) => list?.find(f => f.id === id) || null,
        isEnabled: (id: string) => !!list?.find(f => f.id === id)?.enabled,
        busyId, failed: res.failed, refresh: res.refresh,
        enable: (id: string) => act(id, 'enable', {}, 'compliance.fw_toast_enabled', 'Framework enabled — its checks are running'),
        disable: (id: string) => act(id, 'disable', {}, 'compliance.fw_toast_disabled', 'Framework disabled'),
        setRelevance: (id: string, relevance: unknown, note: unknown) => act(id, 'relevance', { relevance, note }),
    };
}

// ── Regulatory calendar ────────────────────────────────────────────────────
export function useCalendar({ enabled = true, all = false }: { enabled?: boolean; all?: boolean } = {}) {
    const res = useResource<CalendarPayload>(`${API}/calendar${all ? '?all=1' : ''}`, {
        enabled,
        parse: (b) => { const o = asObject<CalendarPayload>(b); return o && Array.isArray(o.milestones) ? o : null; },
    });
    return { calendar: res.data, milestones: res.data?.milestones ?? null, failed: res.failed, refresh: res.refresh };
}

// ── AI Act assessments (the ladder) ────────────────────────────────────────
export function useAiActAssessment(kind: string | null | undefined, id: string | number | null | undefined) {
    const base = kind && id ? `${API}/ai-act/assessments/${encodeURIComponent(kind)}/${encodeURIComponent(String(id))}` : null;
    const res = useResource(base, { enabled: !!base, parse: (b) => asObject(b) });
    const loadSignals = useCallback(() => (base ? fetchJson(`${base}/signals`).then(asObject) : Promise.resolve(null)), [base]);
    const record = useCallback(async (answers: unknown) => {
        if (!base) return null;
        const r = await fetchJson(base, jsonInit('PUT', { answers }));
        await res.refresh();
        return r;
    }, [base, res]);
    return { assessment: res.data, failed: res.failed, refresh: res.refresh, loadSignals, record };
}

export function useAiActAssessments({ enabled = false }: { enabled?: boolean } = {}) {
    const res = useResource(`${API}/ai-act/assessments`, { enabled, parse: (b) => asArray(b) ?? (asObject(b)?.assessments ?? null) });
    return { assessments: res.data, failed: res.failed, refresh: res.refresh };
}
