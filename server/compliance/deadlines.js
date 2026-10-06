/**
 * Compliance — the running clocks of an organisation, in one list.
 *
 * `build(orgId)` gathers every statutory deadline the registers know about —
 * DSR response windows, breach/incident notification clocks (GDPR/NIS2/DORA),
 * CRA early-warning and full-report clocks on vulnerabilities, ISMS
 * obligations and expiring AI Act attestations — and returns them in the
 * shape the Overview "Deadlines" card and the mobile frame render (PLAN.md
 * §1.2 `GET /deadlines`):
 *
 *   { items:[{ id, kind, ref, title, meta, started_at, due_at, state, pct, target }],
 *     empty_kinds:[…], complete, generated_at }
 *
 * `state` is decided HERE, from the regulation, so the client never invents an
 * urgency threshold (fe-shared-primitives ask): DSR 5 d, incident 24 h, CRA
 * early warning 6 h, CRA full report 24 h, obligation 7 d, attestation 30 d.
 * `pct` = elapsed share of the window, clamped to [0, 1] (overdue → 1).
 *
 * Privacy (BFSF-441): a DSR item is "#<id> · <type>" — the data subject's
 * e-mail is never part of a title, ref or meta. Incident titles are the
 * admin-written incident title (no personal data by construction of that
 * form; the register UI says so).
 *
 * Every source is read inside its own try/catch: one store failing drops its
 * items and flags `complete:false`; the response never fails as a whole.
 * Dependencies are injectable through `build(orgId, { deps })` for the tests.
 */

'use strict';

const { complianceSectionPath, complianceIncidentPath } = require('../utils/appPaths');
const log = require('../telemetry/log');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Urgency windows per kind — the regulation's own cadence, not a UI taste.
const URGENT_BELOW_MS = Object.freeze({
    dsr: 5 * DAY,
    incident: 24 * HOUR,
    cra_early_warning: 6 * HOUR,
    cra_full_report: 24 * HOUR,
    obligation: 7 * DAY,
    attestation_expiry: 30 * DAY,
});

const KINDS = Object.freeze(Object.keys(URGENT_BELOW_MS));

// Article the clock comes from — rendered as the small ref next to the title.
const ARTICLE = Object.freeze({
    dsr: 'GDPR Art. 12(3)',
    incident: 'GDPR Art. 33',
    cra_early_warning: 'CRA Art. 14(2)(a)',
    cra_full_report: 'CRA Art. 14(2)(b)',
    obligation: 'ISO 27001 cl. 9',
    attestation_expiry: 'AI Act Art. 53',
});

const DEFAULT_LOADERS = {
    dsrStore: () => require('../stores/dsrStore'),
    incidentStore: () => require('../stores/incidentStore'),
    obligationStore: () => require('../stores/isoObligationStore'),
    aiActAssessmentStore: () => require('../stores/aiActAssessmentStore'),
    now: () => Date.now,
};

function makeDeps(overrides = {}) {
    const d = {};
    for (const [k, loader] of Object.entries(DEFAULT_LOADERS)) {
        Object.defineProperty(d, k, {
            enumerable: true,
            get: () => (k in overrides ? overrides[k] : loader()),
        });
    }
    return d;
}

const toMs = (v) => {
    if (v == null) return null;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
};
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

/**
 * The clock arithmetic, pure: `{ state, pct }` for a due date.
 * state: 'overdue' (due < now) · 'urgent' (within the kind's window) · 'ok' · 'none' (no due date).
 */
function clockState(kind, dueMs, startedMs, nowMs) {
    if (dueMs == null) return { state: 'none', pct: 0 };
    if (dueMs <= nowMs) return { state: 'overdue', pct: 1 };
    const left = dueMs - nowMs;
    const state = left <= (URGENT_BELOW_MS[kind] ?? 0) ? 'urgent' : 'ok';
    let pct = 0;
    if (startedMs != null && dueMs > startedMs) {
        pct = Math.min(1, Math.max(0, (nowMs - startedMs) / (dueMs - startedMs)));
    }
    return { state, pct: Math.round(pct * 1000) / 1000 };
}

function item(kind, id, ref, title, meta, startedMs, dueMs, target, nowMs) {
    const { state, pct } = clockState(kind, dueMs, startedMs, nowMs);
    return {
        id: `${kind}:${id}`,
        kind,
        ref,
        title,
        meta: { article: ARTICLE[kind], ...meta },
        started_at: iso(startedMs),
        due_at: iso(dueMs),
        state,
        pct,
        target,
    };
}

// ── Sources ──────────────────────────────────────────────────────────────

const DSR_TITLE = Object.freeze({
    access: 'Access request',
    deletion: 'Deletion request',
    rectification: 'Rectification request',
    portability: 'Portability request',
    restriction: 'Restriction request',
    objection: 'Objection',
});

async function dsrItems(orgId, d, nowMs) {
    const rows = await d.dsrStore.listOpenWithDeadlines(orgId);
    return (rows || []).map(r => item(
        'dsr', r.id, `#${r.id}`,
        DSR_TITLE[r.request_type] || 'Data-subject request',
        {
            request_type: r.request_type || null,
            status: r.status || null,
            identity_status: r.identity_status || null,
            channel: r.channel || null,
            extended: !!r.extended_until,
        },
        toMs(r.started_at || r.created_at), toMs(r.due_at),
        `${complianceSectionPath('dsr')}/${r.id}`, nowMs,
    ));
}

// One incident can carry several clocks: the authority notification (GDPR /
// NIS2 / DORA — `deadline_at` is the earliest of them) and, for a CRA
// vulnerability, the early warning and the full report. A clock that has been
// stamped (`*_sent_at` / `authority_notified_at`) is done and is not listed.
async function incidentItems(orgId, d, nowMs) {
    const rows = await d.incidentStore.listOpenClocks(orgId);
    const out = [];
    for (const r of rows || []) {
        const started = toMs(r.detected_at || r.created_at);
        const regimes = Array.isArray(r.regimes) ? r.regimes : (typeof r.regimes === 'string' ? safeJson(r.regimes, []) : []);
        const isCra = r.kind === 'vulnerability' || regimes.includes('CRA');
        const base = {
            incident_kind: r.kind || 'breach',
            regimes,
            severity: r.severity || null,
            reported_via: r.reported_via || null,
        };
        const title = r.title ? String(r.title).slice(0, 120) : 'Incident';
        const target = complianceIncidentPath(r.id);
        if (isCra) {
            if (r.early_warning_due_at && !r.early_warning_sent_at) {
                out.push(item('cra_early_warning', r.id, `INC-${r.id}`, title, { ...base, stage: 'early_warning' },
                    started, toMs(r.early_warning_due_at), target, nowMs));
            }
            if (r.final_report_due_at && !r.final_report_sent_at) {
                out.push(item('cra_full_report', r.id, `INC-${r.id}`, title, { ...base, stage: 'full' },
                    started, toMs(r.final_report_due_at), target, nowMs));
            }
        }
        // The authority clock for the non-CRA regimes (GDPR 72 h, NIS2 24/72 h,
        // DORA customer notice) — `deadline_at` when not yet notified.
        const nonCra = regimes.filter(x => x !== 'CRA');
        const hasAuthorityClock = r.kind !== 'vulnerability' || nonCra.length > 0;
        if (hasAuthorityClock && r.deadline_at && !r.authority_notified_at) {
            const due = toMs(r.deadline_at);
            out.push(item('incident', r.id, `INC-${r.id}`, title, { ...base, regimes: nonCra.length ? nonCra : regimes },
                started, due, target, nowMs));
        }
    }
    return out;
}

function safeJson(s, fallback) {
    try { return JSON.parse(s); } catch { return fallback; }
}

async function obligationItems(orgId, d, nowMs) {
    const rows = await d.obligationStore.listObligations(orgId, { openOnly: true });
    return (rows || [])
        .filter(r => r.due_at)
        .map(r => item(
            'obligation', r.id, r.kind ? String(r.kind).replace(/_/g, ' ') : 'obligation',
            r.title ? String(r.title).slice(0, 120) : 'ISMS obligation',
            { kind: r.kind || null, recur_months: r.recur_months ?? null },
            // Training & competence holds the ISMS obligations (the client
            // aliases the old `audits?tab=obligations` for rows sent before).
            toMs(r.created_at || r.last_completed_at), toMs(r.due_at),
            complianceSectionPath('training'), nowMs,
        ));
}

async function attestationItems(orgId, d, nowMs) {
    const rows = await d.aiActAssessmentStore.listForOrg(orgId);
    return (rows || [])
        .filter(r => r.expires_at)
        .map(r => item(
            'attestation_expiry', `${r.target_kind}:${r.target_id}`,
            r.target_kind === 'agent' ? 'Agent' : 'Automation',
            r.title ? String(r.title).slice(0, 120) : `AI Act self-assessment (${r.outcome || 'recorded'})`,
            { target_kind: r.target_kind, target_id: r.target_id, outcome: r.outcome || null },
            toMs(r.attested_at || r.created_at), toMs(r.expires_at),
            `${complianceSectionPath('frameworks')}?tab=per_automation`, nowMs,
        ));
}

const SOURCES = Object.freeze([
    { kinds: ['dsr'], read: dsrItems },
    { kinds: ['incident', 'cra_early_warning', 'cra_full_report'], read: incidentItems },
    { kinds: ['obligation'], read: obligationItems },
    { kinds: ['attestation_expiry'], read: attestationItems },
]);

const STATE_RANK = { overdue: 0, urgent: 1, ok: 2, none: 3 };

/**
 * Every running clock of the org, most pressing first.
 * @param {string} orgId
 * @param {{ deps?: object, now?: number }} [opts]
 */
async function build(orgId, opts = {}) {
    const d = makeDeps(opts.deps || {});
    const nowMs = typeof opts.now === 'number' ? opts.now : (typeof d.now === 'function' ? d.now() : Date.now());
    let complete = true;
    const items = [];
    await Promise.all(SOURCES.map(async (src) => {
        try {
            items.push(...await src.read(orgId, d, nowMs));
        } catch (e) {
            complete = false;
            log.warn(`[ComplianceDeadlines] ${src.kinds.join('/')} source failed:`, e?.message || e);
        }
    }));
    items.sort((a, b) => {
        const s = STATE_RANK[a.state] - STATE_RANK[b.state];
        if (s !== 0) return s;
        const ad = a.due_at ? new Date(a.due_at).getTime() : Infinity;
        const bd = b.due_at ? new Date(b.due_at).getTime() : Infinity;
        return ad - bd;
    });
    const present = new Set(items.map(i => i.kind));
    return {
        items,
        empty_kinds: KINDS.filter(k => !present.has(k)),
        complete,
        generated_at: new Date(nowMs).toISOString(),
    };
}

module.exports = { build, clockState, URGENT_BELOW_MS, KINDS, ARTICLE, makeDeps };
