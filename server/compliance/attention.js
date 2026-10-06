/**
 * Compliance — "Needs attention": the short list at the top of the Overview.
 *
 * `build(orgId, { limit })` merges two kinds of findings into one ranked list
 * (PLAN.md §1.2 `GET /attention`):
 *
 *   source:'check'    — the latest result of every check of an ACTIVE framework
 *                       that is fail or warn. Action: `auto_fix` when the check
 *                       has an autoFixId, otherwise `open_fix` (its remediation
 *                       link, or the check row in its framework page). The open
 *                       subject rows of a per-source check collapse into ONE
 *                       item (worst status, `meta.subjects` capped, the exact
 *                       count in `meta.subject_count`), and a finding an admin
 *                       acknowledged, accepted or snoozed (findingState.js) is
 *                       left out while it is unchanged.
 *   source:'register' — things a check does not (yet) say but the registers
 *                       do: a DSR overdue / due within 5 days / with an
 *                       unverified identity for > 7 days, an incident clock
 *                       running while no breach recipients are configured, a
 *                       CRA early warning due within 6 h, SoA rows still todo,
 *                       overdue ISMS obligations, an expired AI Act
 *                       attestation. Action: `navigate` to the register.
 *
 * Sort: fail before warn, then severity critical > high > medium > low, then
 * newest first. The first `limit` items are `items`; the rest is summarised as
 * `tail` (id/title/severity) + `warn_tail_count` so the card can say "and 4
 * more". `complete:false` when a source threw — the caller shows the list it
 * has and says it may be incomplete, never an empty "all good".
 *
 * Privacy (BFSF-441): titles and details never contain an e-mail address —
 * the register items are built from ids/types only, and check details pass
 * through `scrubEmails` because a per-source check may echo a subject label.
 *
 * Dependencies are injectable (`deps`) so the test runs without a database.
 */

'use strict';

const { complianceSectionPath, complianceIncidentPath } = require('../utils/appPaths');
const log = require('../telemetry/log');
const findingState = require('./findingState');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const SEVERITY_RANK = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });
const STATUS_RANK = Object.freeze({ fail: 0, warn: 1 });

const ACTION_LABEL_KEY = Object.freeze({
    auto_fix: 'compliance.attention_action_auto_fix',
    open_fix: 'compliance.attention_action_open_fix',
    navigate: 'compliance.attention_action_navigate',
});

// Registered client section per regulation (sections.js canonical ids).
const SECTION_FOR_REGULATION = Object.freeze({
    GDPR: 'gdpr', AIA: 'aia', ISO27001: 'iso', NIS2: 'nis2', CRA: 'cra', DATA_ACT: 'data_act',
    PLD: 'pld', EAA: 'eaa', DORA: 'dora', MACHINERY: 'machinery', CUSTOM: 'custom',
});

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
function scrubEmails(s) {
    if (s == null) return null;
    return String(s).replace(EMAIL_RE, '[e-mail]');
}

const DEFAULT_LOADERS = {
    complianceStore: () => require('../stores/complianceStore'),
    registry: () => require('./registry'),
    frameworkPolicy: () => require('./frameworkPolicy'),
    dsrStore: () => require('../stores/dsrStore'),
    incidentStore: () => require('../stores/incidentStore'),
    soaStore: () => require('../stores/soaStore'),
    obligationStore: () => require('../stores/isoObligationStore'),
    aiActAssessmentStore: () => require('../stores/aiActAssessmentStore'),
    titles: () => require('../i18n/defaults/en').GUI_DEFAULTS,
    now: () => Date.now,
};

function makeDeps(overrides = {}) {
    const d = {};
    for (const [k, loader] of Object.entries(DEFAULT_LOADERS)) {
        Object.defineProperty(d, k, { enumerable: true, get: () => (k in overrides ? overrides[k] : loader()) });
    }
    return d;
}

const toMs = (v) => { const t = v == null ? NaN : new Date(v).getTime(); return Number.isFinite(t) ? t : null; };

// ── Source (a): check results ────────────────────────────────────────────

function checkTitle(def, titles) {
    const t = titles && def?.titleKey ? titles[def.titleKey] : null;
    return t || def?.id || 'Check';
}

// How many subjects a collapsed item names in `meta.subjects`. The count is
// always exact; only the list is capped.
const SUBJECTS_IN_ITEM = 10;

function checkAction(def, sectionOf) {
    const section = sectionOf(def.regulation);
    const rowTarget = `${complianceSectionPath(section)}/${encodeURIComponent(def.id)}`;
    if (def.autoFixId) {
        return { type: 'auto_fix', label_key: ACTION_LABEL_KEY.auto_fix, target: rowTarget, auto_fix_id: def.autoFixId };
    }
    // A remediationLink is an app path without the /app/ prefix ('admin/security/users').
    const link = def.remediationLink ? `/app/${String(def.remediationLink).replace(/^\/+/, '')}` : rowTarget;
    return { type: 'open_fix', label_key: ACTION_LABEL_KEY.open_fix, target: link };
}

/** A per-subject deep link a check put in its evidence (appPaths-minted), or null. */
function linkOf(row) {
    const link = row?.evidence && typeof row.evidence === 'object' ? row.evidence.link : null;
    return typeof link === 'string' && link.startsWith('/app/') ? link : null;
}

function baseItem(def, row, d, sectionOf) {
    return {
        id: `check:${def.id}:${row.scope_id || 'global'}`,
        source: 'check',
        code: def.id,
        severity: def.severity || row.severity || 'medium',
        status: row.status,
        title: scrubEmails(checkTitle(def, d.titles)),
        meta: {
            frameworks: (def.frameworks || []).map(f => ({ regulation: f.regulation, ref: f.ref })),
            severity: def.severity || row.severity || 'medium',
            verification: def.verification || 'automated',
            detail: scrubEmails(row.details) || null,
            scope_id: row.scope_id || null,
            run_at: row.run_at || null,
            link: linkOf(row),
        },
        action: checkAction(def, sectionOf),
        _at: toMs(row.run_at) || 0,
    };
}

/**
 * ONE item for every open subject row of a per-source check. A check that
 * judges each project separately would otherwise put a hundred lines on the
 * Overview for one missing policy; the card names the check once, carries the
 * worst status, and lists (capped) which subjects it is about. A single open
 * subject keeps its own id and detail, so nothing changes for the common case.
 */
function collapsedItem(def, rows, d, sectionOf) {
    const sorted = rows.slice().sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
        || (toMs(b.run_at) || 0) - (toMs(a.run_at) || 0));
    const worst = sorted[0];
    const item = baseItem(def, worst, d, sectionOf);
    if (rows.length === 1) return item;
    const failing = rows.filter(r => r.status === 'fail').length;
    const noun = typeof def.subjectNoun === 'string' && def.subjectNoun ? def.subjectNoun : 'subjects';
    item.id = `check:${def.id}:subjects`;
    item.meta.scope_id = null;
    item.meta.link = null;
    item.meta.detail = failing > 0
        ? `${rows.length} ${noun} need attention, ${failing} of them failing.`
        : `${rows.length} ${noun} need attention.`;
    item.meta.subject_count = rows.length;
    item.meta.subjects = sorted.slice(0, SUBJECTS_IN_ITEM).map(r => ({ scope_id: r.scope_id, status: r.status, link: linkOf(r) }));
    item._at = Math.max(...rows.map(r => toMs(r.run_at) || 0));
    return item;
}

/** Stored finding decisions, or none when they cannot be read (showing more is the safe side). */
async function loadStates(orgId, d) {
    if (typeof d.complianceStore.listFindingStates !== 'function') return findingState.indexStates([]);
    try {
        return findingState.indexStates(await d.complianceStore.listFindingStates(orgId));
    } catch (e) {
        log.warn('[ComplianceAttention] finding states unreadable, showing every finding:', e?.message || e);
        return findingState.indexStates([]);
    }
}

async function checkItems(orgId, d, opts, nowMs) {
    const [latest, active, states] = await Promise.all([
        d.complianceStore.getLatestPerCheck(orgId),
        d.frameworkPolicy.activeRegulations(orgId, { req: opts.req || null }),
        loadStates(orgId, d),
    ]);
    const sectionOf = (r) => SECTION_FOR_REGULATION[r] || 'overview';
    const out = [];
    const perSource = new Map(); // check id -> { def, rows }
    for (const row of latest || []) {
        if (row.status !== 'fail' && row.status !== 'warn') continue;
        const def = d.registry.get(row.check_id);
        const reg = def?.regulation || row.regulation;
        if (!reg || !active.has(reg)) continue;
        // A custom-framework row has no registry entry: synthesise the minimum.
        const effDef = def || {
            id: row.check_id, regulation: reg, severity: row.severity || 'medium',
            verification: 'attestation', frameworks: [], autoFixId: null, remediationLink: null,
        };
        // An admin acknowledged, accepted or snoozed exactly this finding.
        if (findingState.applies(findingState.stateFor(states, row), row, def, nowMs)) continue;
        const isSubjectRow = row.scope_type === 'per-source' && row.scope_id;
        if (isSubjectRow) {
            const group = perSource.get(effDef.id) || { def: effDef, rows: [] };
            group.rows.push(row);
            perSource.set(effDef.id, group);
            continue;
        }
        out.push(baseItem(effDef, row, d, sectionOf));
    }
    for (const { def, rows } of perSource.values()) out.push(collapsedItem(def, rows, d, sectionOf));
    return out;
}

// ── Source (b): register findings ────────────────────────────────────────

function registerItem({ id, code, severity, status, title, detail, section, target, regulation, ref, at }) {
    return {
        id: `register:${id}`,
        source: 'register',
        code,
        severity,
        status,
        title,
        meta: {
            frameworks: regulation ? [{ regulation, ref }] : [],
            severity,
            verification: 'register',
            detail: detail || null,
        },
        action: { type: 'navigate', label_key: ACTION_LABEL_KEY.navigate, target: target || complianceSectionPath(section) },
        _at: at || 0,
    };
}

const DSR_TYPE_LABEL = Object.freeze({
    access: 'access', deletion: 'deletion', rectification: 'rectification',
    portability: 'portability', restriction: 'restriction', objection: 'objection',
});

async function dsrFindings(orgId, d, nowMs) {
    const rows = await d.dsrStore.listOpenWithDeadlines(orgId);
    const out = [];
    for (const r of rows || []) {
        const due = toMs(r.due_at);
        const type = DSR_TYPE_LABEL[r.request_type] || 'data-subject';
        const target = `${complianceSectionPath('dsr')}/${r.id}`;
        const common = { section: 'dsr', target, regulation: 'GDPR', ref: 'Art. 12(3)', at: toMs(r.created_at) };
        if (due != null && due < nowMs) {
            const days = Math.floor((nowMs - due) / DAY);
            out.push(registerItem({
                ...common, id: `dsr:${r.id}:overdue`, code: 'dsr_overdue', severity: 'critical', status: 'fail',
                title: `DSR #${r.id} (${type}) is overdue`,
                detail: days > 0 ? `The 30-day response window closed ${days} day(s) ago.` : 'The 30-day response window has closed.',
            }));
            continue;
        }
        if (due != null && due - nowMs <= 5 * DAY) {
            const days = Math.max(0, Math.ceil((due - nowMs) / DAY));
            out.push(registerItem({
                ...common, id: `dsr:${r.id}:due_soon`, code: 'dsr_due_soon', severity: 'high', status: 'warn',
                title: `DSR #${r.id} (${type}) is due in ${days} day(s)`,
                detail: 'Fulfil or extend (once, +60 days with a reason) before the window closes.',
            }));
        }
        const created = toMs(r.created_at);
        if ((r.identity_status === 'unverified' || !r.identity_status) && created != null && nowMs - created > 7 * DAY) {
            out.push(registerItem({
                ...common, id: `dsr:${r.id}:unverified`, code: 'dsr_identity_unverified', severity: 'medium', status: 'warn',
                title: `DSR #${r.id} (${type}): identity not verified after 7 days`,
                detail: 'Verify the data subject before releasing or deleting data (Art. 12(6)).',
            }));
        }
    }
    return out;
}

async function incidentFindings(orgId, d, nowMs) {
    const [rows, settings] = await Promise.all([
        d.incidentStore.listOpenClocks(orgId),
        d.complianceStore.getSettings(orgId).catch(() => ({})),
    ]);
    const recipients = Array.isArray(settings?.breach_recipients) ? settings.breach_recipients : [];
    const out = [];
    for (const r of rows || []) {
        const regimes = Array.isArray(r.regimes) ? r.regimes : [];
        const target = complianceIncidentPath(r.id);
        const at = toMs(r.detected_at);
        const clockRunning = r.deadline_at && !r.authority_notified_at && toMs(r.deadline_at) != null;
        if (clockRunning && recipients.length === 0 && r.kind !== 'vulnerability') {
            out.push(registerItem({
                id: `incident:${r.id}:no_recipients`, code: 'incident_no_breach_recipients', severity: 'critical', status: 'fail',
                title: `INC-${r.id}: notification clock running, no breach recipients configured`,
                detail: 'Add the authority / DPO contacts under Compliance → Settings so the 72-hour notification can go out.',
                section: 'incidents', target, regulation: 'GDPR', ref: 'Art. 33', at,
            }));
        }
        const isCra = r.kind === 'vulnerability' || regimes.includes('CRA');
        const earlyDue = toMs(r.early_warning_due_at);
        if (isCra && earlyDue != null && !r.early_warning_sent_at && earlyDue - nowMs <= 6 * HOUR) {
            const overdue = earlyDue <= nowMs;
            out.push(registerItem({
                id: `incident:${r.id}:cra_early_warning`, code: 'cra_early_warning_due', severity: 'critical', status: overdue ? 'fail' : 'warn',
                title: overdue
                    ? `INC-${r.id}: CRA early warning is overdue`
                    : `INC-${r.id}: CRA early warning due within ${Math.max(1, Math.ceil((earlyDue - nowMs) / HOUR))} h`,
                detail: 'Report the actively exploited vulnerability to ENISA / the CSIRT within 24 hours of awareness (Art. 14(2)(a)).',
                section: 'vulnerabilities', target, regulation: 'CRA', ref: 'Art. 14(2)(a)', at,
            }));
        }
    }
    return out;
}

async function soaFindings(orgId, d) {
    const stats = await d.soaStore.getStats(orgId);
    if (!stats || !(stats.todo > 0)) return [];
    return [registerItem({
        id: 'soa:todo', code: 'soa_todo', severity: 'medium', status: 'warn',
        title: `${stats.todo} Statement-of-Applicability row(s) still to decide`,
        detail: `${stats.approved || 0} of ${stats.total || 0} controls approved.`,
        section: 'soa', regulation: 'ISO27001', ref: 'cl. 6.1.3(d)', at: 0,
    })];
}

async function obligationFindings(orgId, d, nowMs) {
    const rows = await d.obligationStore.listObligations(orgId, { openOnly: true });
    return (rows || [])
        .filter(r => toMs(r.due_at) != null && toMs(r.due_at) < nowMs)
        .map(r => registerItem({
            id: `obligation:${r.id}`, code: 'obligation_overdue', severity: 'high', status: 'fail',
            title: `Overdue: ${String(r.title || r.kind || 'ISMS obligation').slice(0, 100)}`,
            detail: `Due ${new Date(r.due_at).toISOString().slice(0, 10)}.`,
            // The ISMS obligations live on Training & competence; the client
            // still aliases the old `audits?tab=obligations` for stored rows.
            section: 'training', target: complianceSectionPath('training'),
            regulation: 'ISO27001', ref: 'cl. 9', at: toMs(r.due_at),
        }));
}

async function attestationFindings(orgId, d, nowMs) {
    const rows = await d.aiActAssessmentStore.listForOrg(orgId);
    return (rows || [])
        .filter(r => toMs(r.expires_at) != null && toMs(r.expires_at) < nowMs)
        .map(r => registerItem({
            id: `ai_act:${r.target_kind}:${r.target_id}`, code: 'ai_act_attestation_expired', severity: 'medium', status: 'warn',
            title: `AI Act self-assessment expired (${r.target_kind === 'agent' ? 'agent' : 'automation'})`,
            detail: `Recorded outcome "${r.outcome || 'unknown'}" expired ${new Date(r.expires_at).toISOString().slice(0, 10)} — reassess.`,
            section: 'frameworks', target: `${complianceSectionPath('frameworks')}?tab=per_automation`,
            regulation: 'AIA', ref: 'Art. 53', at: toMs(r.expires_at),
        }));
}

const REGISTER_SOURCES = Object.freeze([
    ['dsr', dsrFindings],
    ['incidents', incidentFindings],
    ['soa', soaFindings],
    ['obligations', obligationFindings],
    ['ai_act', attestationFindings],
]);

// ── Assembly ─────────────────────────────────────────────────────────────

function compare(a, b) {
    const s = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
    if (s !== 0) return s;
    const sev = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    if (sev !== 0) return sev;
    return (b._at || 0) - (a._at || 0);
}

/**
 * @param {string} orgId
 * @param {{ limit?: number, deps?: object, now?: number, req?: object }} [opts]
 */
async function build(orgId, opts = {}) {
    const d = makeDeps(opts.deps || {});
    const nowMs = typeof opts.now === 'number' ? opts.now : (typeof d.now === 'function' ? d.now() : Date.now());
    const limit = Math.min(50, Math.max(0, Number.isFinite(+opts.limit) ? Math.trunc(+opts.limit) : 5));
    let complete = true;
    const all = [];

    const run = async (name, fn) => {
        try { all.push(...await fn()); }
        catch (e) { complete = false; log.warn(`[ComplianceAttention] ${name} source failed:`, e?.message || e); }
    };
    await Promise.all([
        run('checks', () => checkItems(orgId, d, opts, nowMs)),
        ...REGISTER_SOURCES.map(([name, fn]) => run(name, () => fn(orgId, d, nowMs))),
    ]);

    all.sort(compare);
    const strip = ({ _at, ...rest }) => rest;
    const items = all.slice(0, limit).map(strip);
    const rest = all.slice(limit);
    return {
        items,
        total: all.length,
        tail: rest.map(i => ({ id: i.id, title: i.title, severity: i.severity, status: i.status })),
        warn_tail_count: rest.filter(i => i.status === 'warn').length,
        fail_tail_count: rest.filter(i => i.status === 'fail').length,
        complete,
        generated_at: new Date(nowMs).toISOString(),
    };
}

module.exports = {
    build,
    scrubEmails,
    SEVERITY_RANK,
    ACTION_LABEL_KEY,
    SECTION_FOR_REGULATION,
    makeDeps,
};
