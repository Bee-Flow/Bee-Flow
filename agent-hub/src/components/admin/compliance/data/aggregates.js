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
import { clockState, DAY_MS, HOUR_MS } from '../../../shared/deadlineMath';

const noop = () => {};

// ── Needs attention ────────────────────────────────────────────────────────
export function useComplianceAttention({ enabled = true, limit = 5 } = {}) {
    const res = useResource(`${API}/attention?limit=${limit}`, {
        enabled,
        parse: (b) => { const o = asObject(b); return o && Array.isArray(o.items) ? o : null; },
    });
    return { attention: res.data, items: res.data?.items ?? null, failed: res.failed, refresh: res.refresh };
}

// ── Deadlines ──────────────────────────────────────────────────────────────
/**
 * Client-side fallback: build the DSR + incident clocks from data the hub
 * already holds, so Overview's Deadlines card works before GET /deadlines
 * ships. Thresholds per regulation: DSR urgent ≤ 5 d, incident ≤ 24 h.
 */
export function deadlinesFromRegisters({ requests = null, incidents = null, now = Date.now() } = {}) {
    const items = [];
    for (const r of requests || []) {
        if (!['pending', 'in_progress'].includes(r.status)) continue;
        const started = r.created_at || r.received_at;
        const due = r.due_at || r.extended_until || (started ? new Date(new Date(started).getTime() + 30 * DAY_MS).toISOString() : null);
        const c = clockState({ dueAt: due, startedAt: started, now, urgentBelowMs: 5 * DAY_MS });
        items.push({ id: `dsr:${r.id}`, kind: 'dsr', ref: `#${r.id}`, title: r.request_type || 'request', meta: { article: '12–22' },
            started_at: started, due_at: due, state: c.state, pct: c.pct, target: { section: 'dsr', id: String(r.id) } });
    }
    for (const i of incidents || []) {
        if (!['open', 'assessing'].includes(i.status)) continue;
        const c = clockState({ dueAt: i.deadline_at, startedAt: i.detected_at || i.created_at, now, urgentBelowMs: 24 * HOUR_MS });
        items.push({ id: `incident:${i.id}`, kind: i.kind === 'vulnerability' ? 'cra_full_report' : 'incident', ref: `INC-${i.id}`, title: i.title,
            meta: { article: '33' }, started_at: i.detected_at || i.created_at, due_at: i.deadline_at, state: c.state, pct: c.pct,
            target: { section: i.kind === 'vulnerability' ? 'vulnerabilities' : 'incidents', id: String(i.id) } });
    }
    const rank = { overdue: 0, urgent: 1, ok: 2, none: 3, done: 4 };
    items.sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || new Date(a.due_at || 0) - new Date(b.due_at || 0));
    return items;
}

export function useComplianceDeadlines({ enabled = true, requests = null, incidents = null } = {}) {
    const res = useResource(`${API}/deadlines`, {
        enabled,
        parse: (b) => { const o = asObject(b); return o && Array.isArray(o.items) ? o : null; },
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
export function useFrameworks({ enabled = true, onChanged = noop } = {}) {
    const { t } = useTranslation();
    const res = useResource(`${API}/frameworks`, {
        enabled,
        parse: (b) => { const o = asObject(b); return o && Array.isArray(o.frameworks) ? o : null; },
    });
    const [busyId, setBusyId] = useState(null);
    const act = useCallback(async (id, action, body, okKey, okFallback) => {
        setBusyId(id);
        try {
            const r = await fetchJson(`${API}/frameworks/${encodeURIComponent(id)}/${action}`, json(body || {}));
            await res.refresh(); onChanged();
            if (okKey) toast.success(t(okKey, okFallback));
            return r;
        } catch (e) {
            const locked = /403/.test(String(e.message));
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
        byId: (id) => list?.find(f => f.id === id) || null,
        isEnabled: (id) => !!list?.find(f => f.id === id)?.enabled,
        busyId, failed: res.failed, refresh: res.refresh,
        enable: (id) => act(id, 'enable', {}, 'compliance.fw_toast_enabled', 'Framework enabled — its checks are running'),
        disable: (id) => act(id, 'disable', {}, 'compliance.fw_toast_disabled', 'Framework disabled'),
        setRelevance: (id, relevance, note) => act(id, 'relevance', { relevance, note }),
    };
}

// ── Regulatory calendar ────────────────────────────────────────────────────
export function useCalendar({ enabled = true, all = false } = {}) {
    const res = useResource(`${API}/calendar${all ? '?all=1' : ''}`, {
        enabled,
        parse: (b) => { const o = asObject(b); return o && Array.isArray(o.milestones) ? o : null; },
    });
    return { calendar: res.data, milestones: res.data?.milestones ?? null, failed: res.failed, refresh: res.refresh };
}

// ── AI Act assessments (the ladder) ────────────────────────────────────────
export function useAiActAssessment(kind, id) {
    const base = kind && id ? `${API}/ai-act/assessments/${encodeURIComponent(kind)}/${encodeURIComponent(id)}` : null;
    const res = useResource(base, { enabled: !!base, parse: (b) => asObject(b) });
    const loadSignals = useCallback(() => (base ? fetchJson(`${base}/signals`).then(asObject) : Promise.resolve(null)), [base]);
    const record = useCallback(async (answers) => {
        if (!base) return null;
        const r = await fetchJson(base, jsonInit('PUT', { answers }));
        await res.refresh();
        return r;
    }, [base, res]);
    return { assessment: res.data, failed: res.failed, refresh: res.refresh, loadSignals, record };
}

export function useAiActAssessments({ enabled = false } = {}) {
    const res = useResource(`${API}/ai-act/assessments`, { enabled, parse: (b) => asArray(b) ?? (asObject(b)?.assessments ?? null) });
    return { assessments: res.data, failed: res.failed, refresh: res.refresh };
}
