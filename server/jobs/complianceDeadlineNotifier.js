/**
 * Compliance Deadline Notifier — daily nudges for the statutory clocks:
 *   1. Incidents: the authority clock of the non-CRA regimes (legacy sweep,
 *      CRA-only rows excluded), labelled per regime the way
 *      compliance/deadlines.js cites it (GDPR Art. 33, NIS2 Art. 23(4), DORA
 *      Art. 30(3)(b)), plus the CRA Art. 14 clocks — early warning (24 h)
 *      within 6 h / overdue, the notification (72 h) within 24 h / overdue
 *      and the final report within 24 h / overdue — skipping stamped ones.
 *   2. Open DSRs on `due_at` (Art. 12(3)): due in 5 days, due tomorrow,
 *      overdue (daily) — each tier fires ONCE per request through
 *      compliance_notify_log (complianceStore.markNotified).
 *   3. DPIAs expiring within 30 days (annual re-attestation).
 *   4. ISO obligations (policy reviews, internal audits, …) — the store
 *      computes which (obligation, offset) pairs are due.
 *   5. Regulatory-calendar milestones of the org's relevant frameworks at
 *      30 / 7 / 0 days before the date (compliance/calendar.js `list()` when
 *      present, frameworks.MILESTONES otherwise).
 *   6. AI Act self-assessment attestations expiring within 30 days.
 *
 * Notifications go to org admins via notificationStore (same channel the
 * compliance event bus uses). Messages never carry an e-mail address or a
 * subject's name — a DSR is '#id · type' (BFSF-441).
 */

const { recordJobRun } = require('../telemetry/metrics');
const { complianceSectionPath, complianceIncidentPath } = require('../utils/appPaths');
const log = require('../telemetry/log');
const { REGIME_ARTICLE } = require('../compliance/deadlines');

const INTERVAL_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
let _timer = null;
let _running = false;

/** DSR tiers on due_at, nearest first. `overdue` re-fires daily (one key per day). */
const DSR_TIERS = Object.freeze([
    { key: 'due_1d', withinMs: 1 * DAY_MS },
    { key: 'due_5d', withinMs: 5 * DAY_MS },
]);
/**
 * CRA Art. 14 tiers. A tier's due date is its `dueCol`, or `fromCol` +
 * `afterMs` for the notification, which has no column of its own (detected +
 * 72 h, met by the authority notification stamp — the same pair as
 * incidentStore.nextOpenDeadline). The final report's label carries no window:
 * 14 days for a vulnerability, one month after the notification for a severe
 * incident, and `final_report_due_at` already holds the right one.
 */
const CRA_TIERS = Object.freeze([
    { key: 'cra_early_warning', dueCol: 'early_warning_due_at', sentCol: 'early_warning_sent_at', withinMs: 6 * HOUR_MS, label: 'CRA early warning (24 h)' },
    { key: 'cra_notification', fromCol: 'detected_at', afterMs: 72 * HOUR_MS, sentCol: 'authority_notified_at', withinMs: 24 * HOUR_MS, label: 'CRA notification (72 h)' },
    { key: 'cra_full_report', dueCol: 'final_report_due_at', sentCol: 'final_report_sent_at', withinMs: 24 * HOUR_MS, label: 'CRA final report' },
]);
const MILESTONE_OFFSETS_DAYS = Object.freeze([30, 7, 0]);
const ATTESTATION_WINDOW_DAYS = 30;

function _lazy(path) {
    try { return require(path); } catch { return null; }
}

const DEP_LOADERS = Object.freeze({
    getAll: () => require('../db').getAll,
    userStore: () => require('../stores/userStore'),
    incidentStore: () => _lazy('../stores/incidentStore') || {},
    dsrStore: () => _lazy('../stores/dsrStore'),
    complianceStore: () => _lazy('../stores/complianceStore'),
    notificationStore: () => _lazy('../stores/notificationStore'),
    obligationStore: () => _lazy('../stores/isoObligationStore'),
    aiActAssessmentStore: () => _lazy('../stores/aiActAssessmentStore'),
    frameworkPolicy: () => _lazy('../compliance/frameworkPolicy'),
    calendar: () => _lazy('../compliance/calendar'),
    frameworks: () => _lazy('../compliance/frameworks'),
    now: () => () => Date.now(),
});

/** Injected deps win; only the missing ones are required (tests boot no store). */
function _resolveDeps(deps) {
    const d = {};
    for (const [k, load] of Object.entries(DEP_LOADERS)) {
        d[k] = deps && k in deps ? deps[k] : load();
    }
    return d;
}

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const shortDate = (v) => { try { return new Date(v).toISOString().slice(0, 10); } catch { return String(v); } };

async function _notifyAdmins(d, orgId, title, message, link) {
    const store = d.notificationStore;
    if (!store?.createNotification) return;
    try {
        const rows = await d.getAll(
            `SELECT id FROM users WHERE "organizationId" = $1 AND (role = 'admin' OR "orgRole" IN ('org_admin', 'admin', 'dpo'))`,
            [orgId],
        );
        for (const u of rows || []) {
            await store.createNotification({ userId: u.id, category: 'urgent', title, message, link }).catch(() => {});
        }
    } catch (e) {
        log.warn('[ComplianceDeadlines] notify failed:', e.message);
    }
}

/**
 * Fire once per (subject, offset): returns true when THIS call claimed the
 * slot. Without a notify log (store absent) every tier fires — loud beats
 * silent for a statutory clock.
 */
async function _claim(d, orgId, subjectKind, subjectId, offsetKey) {
    if (!d.complianceStore?.markNotified) return true;
    try { return await d.complianceStore.markNotified(orgId, subjectKind, subjectId, offsetKey); } catch { return true; }
}

// ── 1. Incidents ─────────────────────────────────────────────────────────

/** The row's regimes; an absent or unreadable list is the column default (CRA for a vulnerability). */
function _regimesOf(inc) {
    let list = inc.regimes;
    if (typeof list === 'string') { try { list = JSON.parse(list || '[]'); } catch { list = []; } }
    list = Array.isArray(list) ? list.map(r => String(r).toUpperCase()) : [];
    return list.length ? list : [inc.kind === 'vulnerability' ? 'CRA' : 'GDPR'];
}

/**
 * The citation of a row's authority clock: one article per non-CRA regime,
 * from compliance/deadlines.js REGIME_ARTICLE, so a NIS2-only row cites
 * NIS2 Art. 23(4) and never GDPR Art. 33. `deadline_at` is the earliest of
 * those clocks (24 h for a NIS2 early warning, 72 h for GDPR, the DORA
 * customer notice), so the label names no fixed number of hours.
 */
function _authorityArticle(regimes) {
    const cited = regimes.filter(r => r !== 'CRA').map(r => REGIME_ARTICLE[r]).filter(Boolean);
    return cited.length ? cited.join(' · ') : REGIME_ARTICLE.GDPR;
}

async function _sweepIncidents(d, orgId, nowMs) {
    // Legacy authority-clock sweep (GDPR / NIS2 / DORA): the store decides
    // what needs attention; the notice cites each regime's own article.
    try {
        const incidents = d.incidentStore.listNeedingAttention ? await d.incidentStore.listNeedingAttention(orgId) : [];
        for (const inc of incidents || []) {
            const regimes = _regimesOf(inc);
            // A CRA-only row has no authority clock here: its clocks are the
            // CRA tiers below, which would otherwise fire alongside this nudge.
            if (regimes.every(r => r === 'CRA')) continue;
            const article = _authorityArticle(regimes);
            const overdue = new Date(inc.deadline_at).getTime() < nowMs;
            // The claim keys keep their historical art33_* names, so a row
            // already nudged under them is not nudged again.
            const key = overdue ? `art33_overdue:${dayKey(nowMs)}` : 'art33_24h';
            if (!(await _claim(d, orgId, 'incident', inc.id, key))) continue;
            await _notifyAdmins(d,
                orgId,
                overdue ? `Incident past its notification deadline (${article})` : `Incident approaching its notification deadline (${article})`,
                `Incident #${inc.id} ${overdue ? 'passed' : 'reaches'} its notification deadline ${overdue ? '' : 'within 24 hours '}(${new Date(inc.deadline_at).toLocaleString()}). Record the notification or close the incident with an assessment.`,
                complianceIncidentPath(inc.id),
            );
        }
    } catch (e) {
        log.warn(`[ComplianceDeadlines] incident sweep for "${orgId}" failed:`, e.message);
    }

    // CRA Art. 14 clocks on the open incidents.
    if (!d.incidentStore.listOpenClocks) return;
    let clocks = [];
    try { clocks = await d.incidentStore.listOpenClocks(orgId); } catch { return; }
    for (const inc of clocks || []) {
        const isCra = inc.kind === 'vulnerability' || _regimesOf(inc).includes('CRA');
        if (!isCra) continue;
        for (const tier of CRA_TIERS) {
            if (inc[tier.sentCol]) continue;                // already reported — clock satisfied
            const col = tier.dueCol || tier.fromCol;
            const due = inc[col] ? new Date(inc[col]).getTime() + (tier.afterMs || 0) : NaN;
            if (!Number.isFinite(due)) continue;
            const overdue = due <= nowMs;
            if (!overdue && due - nowMs > tier.withinMs) continue;
            const key = overdue ? `${tier.key}_overdue:${dayKey(nowMs)}` : `${tier.key}_due`;
            if (!(await _claim(d, orgId, 'incident', inc.id, key))) continue;
            await _notifyAdmins(d,
                orgId,
                overdue ? `${tier.label} overdue` : `${tier.label} due soon`,
                `Incident #${inc.id} ${overdue ? 'has passed' : 'reaches'} its ${tier.label} deadline (${new Date(due).toLocaleString()}). Report it to the CSIRT / ENISA single reporting platform and record the reference.`,
                complianceIncidentPath(inc.id),
            );
        }
    }
}

// ── 2. DSR clocks on due_at ──────────────────────────────────────────────

async function _sweepDsr(d, orgId, nowMs) {
    let rows = [];
    try {
        if (d.dsrStore?.listOpenWithDeadlines) rows = await d.dsrStore.listOpenWithDeadlines(orgId);
        else rows = await d.getAll(`
            SELECT id, request_type, status, due_at, extended_until FROM dsr_requests
            WHERE organization_id = $1 AND status IN ('pending', 'in_progress')
        `, [orgId]);
    } catch { return; /* table absent on fresh installs */ }

    for (const r of rows || []) {
        const due = r.due_at ? new Date(r.due_at).getTime() : NaN;
        if (!Number.isFinite(due)) continue;
        const ref = `#${r.id} · ${r.request_type}`;
        const link = `${complianceSectionPath('dsr')}?id=${r.id}`;
        if (due <= nowMs) {
            if (!(await _claim(d, orgId, 'dsr', r.id, `overdue:${dayKey(nowMs)}`))) continue;
            const daysOver = Math.floor((nowMs - due) / DAY_MS);
            await _notifyAdmins(d,
                orgId,
                'Data-subject request overdue',
                `Request ${ref} passed its Art. 12(3) deadline ${daysOver === 0 ? 'today' : `${daysOver} day(s) ago`} (${shortDate(due)}). Respond now${r.extended_until ? '' : ' or record an extension with the reason'}.`,
                link,
            );
            continue;
        }
        // The nearest tier only — a request 20 h from its deadline gets the
        // "tomorrow" nudge, not a belated "within 5 days" one as well.
        const tier = DSR_TIERS.find(t => due - nowMs <= t.withinMs);
        if (!tier) continue;
        if (!(await _claim(d, orgId, 'dsr', r.id, tier.key))) continue;
        const daysLeft = Math.ceil((due - nowMs) / DAY_MS);
        await _notifyAdmins(d,
            orgId,
            tier.key === 'due_1d' ? 'Data-subject request due tomorrow' : 'Data-subject request due within 5 days',
            `Request ${ref} is due ${daysLeft <= 1 ? 'tomorrow' : `in ${daysLeft} days`} (${shortDate(due)}). GDPR Art. 12(3) requires a response within one month${r.extended_until ? ' (already extended)' : ''}.`,
            link,
        );
    }
}

// ── 3. DPIA expiries ─────────────────────────────────────────────────────

async function _sweepDpia(d, orgId, nowMs) {
    try {
        const dpias = await d.getAll(`
            SELECT DISTINCT ON (agent_id) agent_id, expires_at
            FROM dpia_assessments
            WHERE organization_id = $1
            ORDER BY agent_id, created_at DESC
        `, [orgId]);
        const expiring = (dpias || []).filter(x => x.expires_at
            && new Date(x.expires_at).getTime() > nowMs
            && new Date(x.expires_at).getTime() < nowMs + 30 * DAY_MS);
        if (expiring.length) {
            await _notifyAdmins(d,
                orgId,
                'DPIA re-attestation due',
                `${expiring.length} impact assessment(s) expire within 30 days. Re-attest them under Compliance → DPIA.`,
                complianceSectionPath('dpia'),
            );
        }
    } catch { /* table absent on fresh installs */ }
}

// ── 5. Regulatory calendar ───────────────────────────────────────────────

async function _relevantFrameworkIds(d, orgId) {
    try {
        if (d.frameworkPolicy?.resolve) {
            const entries = await d.frameworkPolicy.resolve(orgId);
            return new Set((entries || []).filter(e => e.enabled && e.relevance !== 'not_relevant').map(e => e.id));
        }
    } catch { /* fall through */ }
    return null; // unknown → every milestone counts
}

/**
 * Per-org "affects" counts from the calendar — an EXPLICIT allow-list of count
 * fields (BFSF-441): a number of automations/agents/pages, never a name, an
 * address or a title. A null count is "unknown", so it stays out entirely.
 */
const AFFECTS_FIELDS = Object.freeze([
    ['automations', 'automation', 'automations'],
    ['agents', 'agent', 'agents'],
    ['webpages', 'webpage', 'webpages'],
    ['forms', 'public form', 'public forms'],
]);

function _affectsLine(affects) {
    if (!affects || typeof affects !== 'object') return '';
    const parts = [];
    for (const [key, one, many] of AFFECTS_FIELDS) {
        const v = Number(affects[key]);
        if (!Number.isFinite(v) || v <= 0) continue;
        parts.push(`${v} ${v === 1 ? one : many}`);
    }
    return parts.length ? ` Affects you: ${parts.join(' · ')}.` : '';
}

/**
 * The notify-log subject id for a milestone. A source without a usable `id`
 * (a custom framework, a future calendar source) still gets a STABLE key —
 * one shared "undefined" key would let the first such milestone silence the
 * rest of them.
 */
function _milestoneKey(m) {
    if (m.id != null && m.id !== '') return String(m.id);
    if (m.label_key) return String(m.label_key);
    return `${m.framework_id || 'unknown'}:${m.date || m.expected || 'undated'}`;
}

/**
 * The org's milestones. compliance/calendar.js is the source of truth when it
 * is present: `list(orgId, { all: true })` (its real API — there is no
 * `build()`) returns every milestone with the per-org `relevant` flag and the
 * `affects` counts, so a framework the org marked 'not_relevant' drops out
 * here. The raw frameworks table is the fallback for when that module is
 * absent or unusable.
 */
async function _milestones(d, orgId) {
    try {
        if (typeof d.calendar?.list === 'function') {
            const out = await d.calendar.list(orgId, { all: true });
            const list = Array.isArray(out) ? out : (Array.isArray(out?.milestones) ? out.milestones : null);
            if (list) return list.filter(m => m && m.relevant !== false);
        }
    } catch (e) {
        log.warn(`[ComplianceDeadlines] calendar unavailable for "${orgId}":`, e.message);
    }
    const relevant = await _relevantFrameworkIds(d, orgId);
    const all = Array.isArray(d.frameworks?.MILESTONES) ? d.frameworks.MILESTONES : [];
    return all.filter(m => !relevant || relevant.has(m.framework_id));
}

async function _sweepCalendar(d, orgId, nowMs) {
    let milestones = [];
    try { milestones = await _milestones(d, orgId); } catch { return; }
    const today = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
    for (const m of milestones || []) {
        // One milestone we cannot render must not cost this org the rest of the
        // calendar — nor the orgs behind it in the queue. The message is built
        // BEFORE the claim, so a milestone that throws never burns its
        // once-per-tier slot in the notify log.
        try {
            if (!m?.date) continue;
            const dateMs = new Date(`${m.date}T00:00:00Z`).getTime();
            if (!Number.isFinite(dateMs)) continue;
            const daysUntil = Math.round((dateMs - today) / DAY_MS);
            if (daysUntil < 0 || daysUntil > Math.max(...MILESTONE_OFFSETS_DAYS)) continue;
            // Nearest offset: 30 fires when 7 < days ≤ 30, 7 when 0 < days ≤ 7, 0 on the day.
            const tier = daysUntil === 0 ? 0 : daysUntil <= 7 ? 7 : 30;
            const subjectId = _milestoneKey(m);
            const label = String(m.id || m.framework_id || 'milestone').replace(/_/g, ' ');
            const fw = String(m.framework_id || '').toUpperCase();
            const title = `${fw ? `${fw}: r` : 'R'}egulatory milestone ${daysUntil === 0 ? 'today' : `in ${daysUntil} day(s)`}`;
            const message = `${label} (${m.kind || 'milestone'}) ${daysUntil === 0 ? 'applies from today' : `applies from ${m.date}`}.${_affectsLine(m.affects)} Review the framework's checks under Compliance → Frameworks.`;
            if (!(await _claim(d, orgId, 'milestone', subjectId, `d${tier}`))) continue;
            await _notifyAdmins(d, orgId, title, message, `${complianceSectionPath('frameworks')}?tab=calendar`);
        } catch (e) {
            log.warn(`[ComplianceDeadlines] milestone skipped for "${orgId}":`, e.message);
        }
    }
}

// ── 6. AI Act attestation expiries ───────────────────────────────────────

async function _sweepAttestations(d, orgId, nowMs) {
    if (!d.aiActAssessmentStore?.listExpiring) return;
    let rows = [];
    try { rows = await d.aiActAssessmentStore.listExpiring(orgId, ATTESTATION_WINDOW_DAYS); } catch { return; }
    for (const r of rows || []) {
        const exp = r.expires_at ? new Date(r.expires_at).getTime() : NaN;
        if (!Number.isFinite(exp)) continue;
        const subjectId = `${r.target_kind}:${r.target_id}`;
        const overdue = exp <= nowMs;
        const key = overdue ? `expired:${dayKey(nowMs)}` : 'expires_30d';
        if (!(await _claim(d, orgId, 'attestation', subjectId, key))) continue;
        await _notifyAdmins(d,
            orgId,
            overdue ? 'AI Act self-assessment expired' : 'AI Act self-assessment expires within 30 days',
            `The ${r.target_kind === 'agent' ? 'agent' : 'automation'} ${r.target_id} ${overdue ? 'has an expired' : 'has an expiring'} AI Act self-assessment (${shortDate(exp)}). Re-run the "Does the AI Act apply?" ladder to re-attest.`,
            `${complianceSectionPath('frameworks')}?tab=per_automation`,
        );
    }
}

/** The per-org sections, each independent of the others. */
const ORG_SWEEPS = Object.freeze([
    ['incident', _sweepIncidents],
    ['dsr', _sweepDsr],
    ['dpia', _sweepDpia],
    ['calendar', _sweepCalendar],
    ['attestation', _sweepAttestations],
]);

/**
 * Sweep one org. A section that throws is logged and skipped — it may not cost
 * this org its other statutory clocks, and it may certainly not abort the
 * queue (the orgs behind it would silently lose their DSR / CRA / Art. 33
 * nudges for the day, with the already-claimed slots never retried).
 * @returns {Promise<number>} how many sections failed (0 = clean sweep).
 */
async function _sweepOrg(d, orgId, nowMs) {
    let failures = 0;
    for (const [name, sweep] of ORG_SWEEPS) {
        try {
            await sweep(d, orgId, nowMs);
        } catch (e) {
            failures += 1;
            log.warn(`[ComplianceDeadlines] ${name} sweep for "${orgId}" failed:`, e.message);
        }
    }
    return failures;
}

// 4. ISO obligations — the store computes which (obligation, offset) pairs are
// due for a nudge; we notify and mark, so each offset fires exactly once.
async function _sweepObligations(d) {
    const obligationStore = d.obligationStore;
    if (!obligationStore?.listDueForNotification) return;
    try {
        const due = await obligationStore.listDueForNotification();
        for (const { obligation, offset } of due || []) {
            const overdue = new Date(obligation.due_at).getTime() < d.now();
            await _notifyAdmins(d,
                obligation.organization_id,
                overdue ? `ISMS obligation overdue: ${obligation.title}` : `ISMS obligation due in ${offset} day(s): ${obligation.title}`,
                `${obligation.kind.replace(/_/g, ' ')}${obligation.subject ? ` — ${obligation.subject}` : ''} is ${overdue ? 'past' : 'approaching'} its due date (${new Date(obligation.due_at).toLocaleDateString()}). Complete it under ISO 27001 → Training & obligations.`,
                complianceSectionPath('iso_training'),
            );
            await obligationStore.markNotified(obligation.id, offset).catch(() => {});
        }
    } catch (e) {
        log.warn('[ComplianceDeadlines] obligation sweep failed:', e.message);
    }
}

/**
 * One sweep over every org. `deps` lets the test inject stores; production
 * passes nothing.
 */
async function runOnce({ deps = null } = {}) {
    if (_running) return;
    _running = true;
    const d = _resolveDeps(deps);
    const started = Date.now();
    let ok = true;
    try {
        const nowMs = d.now();
        const orgIds = new Set(['default']);
        try {
            const orgs = await d.userStore.getAllOrganizations();
            for (const o of orgs || []) if (o?.id) orgIds.add(o.id);
        } catch (e) {
            log.warn('[ComplianceDeadlines] could not list orgs:', e.message);
        }
        let failures = 0;
        for (const orgId of orgIds) {
            failures += await _sweepOrg(d, orgId, nowMs);
        }
        await _sweepObligations(d);
        if (failures) ok = false;   // recorded as an error run, but every org was swept
        if (!deps) log.info(`[ComplianceDeadlines] swept ${orgIds.size} org(s) in ${Date.now() - started} ms${failures ? ` (${failures} section(s) failed)` : ''}`);
    } catch (e) {
        ok = false;
        throw e;
    } finally {
        _running = false;
        recordJobRun({ job: 'compliance_deadlines', status: ok ? 'ok' : 'error', durationMs: Date.now() - started });
    }
}

function start() {
    if (_timer) return;
    // First sweep 3 minutes after boot, after the stores initialise.
    const initial = setTimeout(() => runOnce().catch(e =>
        log.warn('[ComplianceDeadlines] initial sweep failed:', e.message)
    ), 180 * 1000);
    if (initial.unref) initial.unref();

    _timer = setInterval(() => {
        runOnce().catch(e =>
            log.warn('[ComplianceDeadlines] scheduled sweep failed:', e.message)
        );
    }, INTERVAL_MS);
    if (_timer.unref) _timer.unref();
    log.info(`[ComplianceDeadlines] Started — interval ${INTERVAL_MS / 3600000} h`);
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, runOnce, DSR_TIERS, CRA_TIERS, MILESTONE_OFFSETS_DAYS };
