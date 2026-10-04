/**
 * Compliance — the regulatory calendar: the framework catalogue's MILESTONES
 * (compliance/frameworks.js) with the two per-org facts the UI needs on top.
 *
 *   relevant — the milestone's framework is enabled for the org, or it is a
 *              candidate the org has not marked 'not_relevant'. A locked
 *              framework is still relevant (shown locked, never hidden).
 *   affects  — what in THIS org the date touches, for the milestones that
 *              carry an `affects_kind`:
 *                'marking'  → automations with a document step downstream of an
 *                             AI step (automation/automationGraph via
 *                             aiAct/signals.listGeneratingAutomations) and the
 *                             org's published agents (AI Act Art. 50 marking);
 *                'a11y'     → published webpages and live public forms (EAA);
 *                'releases' → null here (the PLD release record is a check).
 *              `{ automations, agents, webpages, forms }` — a count that could
 *              not be read is null, never 0.
 *
 * `list(orgId, { all })` returns relevant + uncertain milestones by default,
 * everything with `all:true`; `expected` ('2026-Q4') carries the horizon of an
 * undated one. Sorted by date, undated last. 60 s memo per org — the counts
 * touch several tables and the calendar is polled with the rail.
 *
 * The "today" marker is client-side; nothing here depends on the clock.
 */

'use strict';

const frameworks = require('./frameworks');

const MEMO_MS = Number(process.env.COMPLIANCE_CALENDAR_MEMO_MS) || 60_000;
const _memo = new Map(); // orgId → { at, milestones }

const DEFAULT_LOADERS = {
    frameworkPolicy: () => require('./frameworkPolicy'),
    signals: () => { try { return require('./aiAct/signals'); } catch { return null; } },
    db: () => require('../db'),
    now: () => Date.now,
};

function makeDeps(overrides = {}) {
    const d = {};
    for (const [k, loader] of Object.entries(DEFAULT_LOADERS)) {
        Object.defineProperty(d, k, { enumerable: true, get: () => (k in overrides ? overrides[k] : loader()) });
    }
    return d;
}

const n = (row) => (row && row.n != null && Number.isFinite(Number(row.n)) ? Number(row.n) : null);

// ── Per-org "affects" counts (each null on failure — never a fake 0) ──────

async function countGeneratingAutomations(orgId, d) {
    const signals = d.signals;
    if (!signals || typeof signals.listGeneratingAutomations !== 'function') return null;
    try {
        const rows = await signals.listGeneratingAutomations(orgId);
        return Array.isArray(rows) ? rows.length : null;
    } catch { return null; }
}

async function countPublishedAgents(orgId, d) {
    try {
        return n(await d.db.getOne(
            `SELECT COUNT(*)::int AS n FROM agents WHERE organization_id = $1 AND is_published = TRUE`, [orgId],
        ));
    } catch { return null; }
}

async function countPublishedWebpages(orgId, d) {
    try {
        return n(await d.db.getOne(
            `SELECT COUNT(*)::int AS n FROM webpages WHERE organization_id = $1 AND is_published = TRUE`, [orgId],
        ));
    } catch { return null; }
}

// Live public forms: form pages of the org's active, non-draft automations
// (same org join as stores/automationStore/forms.js listFormPagesForUser).
async function countPublicForms(orgId, d) {
    try {
        return n(await d.db.getOne(
            `SELECT COUNT(*)::int AS n
               FROM automation_form_pages p
               JOIN automations a ON a.id = p.automation_id
               JOIN users u ON u.id = a.user_id
              WHERE COALESCE(a.organization_id, u."organizationId") = $1
                AND a.is_active = TRUE AND COALESCE(a.is_draft, FALSE) = FALSE`,
            [orgId],
        ));
    } catch { return null; }
}

/**
 * The per-org "affects" counts for one affects_kind, uncached — the frameworks
 * page reuses it for the candidate cards ("Affects you: 3 automations · 4 agents").
 * @returns {Promise<{automations, agents, webpages, forms}|null>}
 */
async function affectsCounts(kind, orgId, opts = {}) {
    return affectsFor(kind, orgId, makeDeps(opts.deps || {}), {});
}

async function affectsFor(kind, orgId, d, cache) {
    if (kind === 'marking') {
        if (!cache.marking) {
            cache.marking = Promise.all([countGeneratingAutomations(orgId, d), countPublishedAgents(orgId, d)])
                .then(([automations, agents]) => ({ automations, agents, webpages: null, forms: null }));
        }
        return cache.marking;
    }
    if (kind === 'a11y') {
        if (!cache.a11y) {
            cache.a11y = Promise.all([countPublishedWebpages(orgId, d), countPublicForms(orgId, d)])
                .then(([webpages, forms]) => ({ automations: null, agents: null, webpages, forms }));
        }
        return cache.a11y;
    }
    return null;
}

// ── Relevance ─────────────────────────────────────────────────────────────

function relevanceOf(policyById, frameworkId) {
    const p = policyById.get(frameworkId);
    if (!p) return false;
    if (p.enabled) return true;
    return p.relevance !== 'not_relevant';
}

function sortMilestones(a, b) {
    if (a.date && b.date) return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    if (a.date) return -1;
    if (b.date) return 1;
    return String(a.expected || '').localeCompare(String(b.expected || ''));
}

/**
 * @param {string} orgId
 * @param {{ all?: boolean, deps?: object, req?: object, fresh?: boolean }} [opts]
 * @returns {Promise<Array<{ id, date, framework_id, kind, label_key, detail_key, relevant, affects, expected, affects_kind }>>}
 */
async function list(orgId, opts = {}) {
    const d = makeDeps(opts.deps || {});
    const now = typeof d.now === 'function' ? d.now() : Date.now();
    let milestones;
    const hit = _memo.get(orgId);
    if (hit && !opts.fresh && now - hit.at < MEMO_MS) {
        milestones = hit.milestones;
    } else {
        const policy = await d.frameworkPolicy.resolve(orgId, { req: opts.req || null });
        const byId = new Map((policy || []).map(p => [p.id, p]));
        const cache = {};
        milestones = await Promise.all(frameworks.MILESTONES.map(async (m) => {
            const relevant = relevanceOf(byId, m.framework_id);
            const affects = relevant && m.affects_kind ? await affectsFor(m.affects_kind, orgId, d, cache) : null;
            return {
                id: m.id,
                date: m.date || null,
                framework_id: m.framework_id,
                kind: m.kind,
                label_key: m.label_key,
                detail_key: m.detail_key,
                relevant,
                affects,
                expected: m.expected || null,
                affects_kind: m.affects_kind || null,
            };
        }));
        milestones.sort(sortMilestones);
        _memo.set(orgId, { at: now, milestones });
    }
    if (opts.all) return milestones.slice();
    return milestones.filter(m => m.relevant || m.kind === 'uncertain');
}

/** Number of milestones per framework id — the frameworks page footer ("n dates"). */
function countByFramework() {
    const out = {};
    for (const m of frameworks.MILESTONES) out[m.framework_id] = (out[m.framework_id] || 0) + 1;
    return out;
}

function invalidate(orgId) {
    if (orgId == null) _memo.clear();
    else _memo.delete(orgId);
}

module.exports = { list, countByFramework, affectsCounts, invalidate, relevanceOf, makeDeps, MEMO_MS };
