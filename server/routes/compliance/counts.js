/**
 * GET /api/compliance/counts[?keys=a,b] — the numbers on the Compliance rail.
 *
 *   → { attention_open, last_run, frameworks, frameworks_summary, dsr,
 *       incidents, ropa, dpia, risks, soa, policies, audits, training,
 *       connectors, evidence, onboarded, setup_step }
 *
 * A clone of routes/studio/counts.js's discipline — the same three rules, for
 * the same reason (not becoming an entitlement oracle, never lying with a 0):
 *
 *   1. Every key applies the SAME gate the screen behind it sits behind: the
 *      ISO registers (soa/policies/audits/training/connectors/risks) only when
 *      iso27001 is active for the org; `frameworks.<id>` only for ENABLED
 *      frameworks — a candidate appears only in `frameworks_summary`. A key
 *      the caller may not see is OMITTED; the response never 403s as a whole.
 *   2. Every key is counted with the SAME scoping its list route uses (the
 *      store function is named per kind), so the rail never says "DSR 4" over
 *      an inbox that shows three.
 *   3. Every key is counted inside its own try/catch: one store falling over
 *      drops one number, never the response. A body with a dropped number is
 *      PARTIAL and is never cached — an omitted key is exactly the shape the
 *      client reads as "unknown, render nothing", so caching it would turn a
 *      transient store error into a minute of a silent rail row.
 *
 * And one rule of its own: THIS ENDPOINT NEVER TRIGGERS A CHECK RUN. It reads
 * `getLatestPerCheck`; the auto-run on staleness lives in overview.js and only
 * there. The test injects a runner that throws to pin this.
 *
 * Cached 60 s per ORG (not per user — every admin of an org sees the same
 * numbers) with `Cache-Control: private, no-store`; `invalidate(orgId)` is
 * called by the runner after a sweep and by the event handlers. `?keys=`
 * filters the cached body (the Settings-nav badge only wants attention_open).
 *
 * Dependencies are injectable (`createCountsRouter(deps)`) so the test
 * exercises gating/omission/caching/no-runner without a database.
 */

'use strict';

const express = require('express');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** The rail asks for a subset by name; a misspelled PARAMETER is a mistake. */
const CountsQuery = z.object({
    keys: z.string({ invalid_type_error: 'keys is a comma-separated list of count keys.' }).optional(),
}).strict();

const CACHE_TTL_MS = 60_000;
const SWEEP_INTERVAL_HOURS = 6;
const RECENTLY_IN_FORCE_DAYS = 60;
const EVIDENCE_CHAIN_CHECK_ROWS = 200;
const DSR_DUE_SOON_MS = 5 * 24 * 3600 * 1000;

const DEFAULT_LOADERS = {
    shared: () => require('./shared'),
    permissions: () => require('../../auth/permissions'),
    complianceStore: () => require('../../stores/complianceStore'),
    frameworkPolicy: () => require('../../compliance/frameworkPolicy'),
    frameworks: () => require('../../compliance/frameworks'),
    registry: () => require('../../compliance/registry'),
    score: () => require('../../compliance/score'),
    attention: () => require('../../compliance/attention'),
    chain: () => require('../../compliance/evidence/chain'),
    dsrStore: () => require('../../stores/dsrStore'),
    incidentStore: () => require('../../stores/incidentStore'),
    dpiaStore: () => require('../../stores/dpiaStore'),
    riskStore: () => require('../../stores/riskStore'),
    soaStore: () => require('../../stores/soaStore'),
    ismsDocStore: () => require('../../stores/ismsDocStore'),
    isoAuditStore: () => require('../../stores/isoAuditStore'),
    isoEvidenceStore: () => require('../../stores/isoEvidenceStore'),
    db: () => require('../../db'),
    now: () => Date.now,
};

function makeLazyDeps(loaders, overrides = {}) {
    const d = {};
    for (const [k, loader] of Object.entries(loaders)) {
        let cached; let has = false;
        Object.defineProperty(d, k, {
            enumerable: true,
            get: () => {
                if (k in overrides) return overrides[k];
                if (!has) { cached = loader(); has = true; }
                return cached;
            },
        });
    }
    return d;
}

const toneOfScore = (s) => (s == null ? 'none' : s >= 80 ? 'good' : s >= 60 ? 'warn' : 'bad');
const maxDate = (rows, col) => rows.reduce((m, r) => (r?.[col] && (!m || new Date(r[col]) > new Date(m)) ? r[col] : m), null);

// A context every kind can read: the policy and the latest rows are fetched
// ONCE per computation, not once per key (they are the two expensive reads).
async function loadContext(req, orgId, d) {
    const ctx = { orgId, req, policy: null, active: null, latest: null, settings: null, errors: [] };
    const tryLoad = async (name, fn) => {
        try { ctx[name] = await fn(); } catch (e) { ctx.errors.push(name); log.warn(`[ComplianceCounts] ${name} failed:`, e?.message || e); }
    };
    await Promise.all([
        tryLoad('policy', () => d.frameworkPolicy.resolve(orgId, { req })),
        tryLoad('latest', () => d.complianceStore.getLatestPerCheck(orgId)),
        tryLoad('settings', () => d.complianceStore.getSettings(orgId)),
    ]);
    if (ctx.policy) {
        ctx.active = new Set();
        for (const p of ctx.policy) if (p.enabled && !p.locked) ctx.active.add(p.regulation);
    }
    return ctx;
}

const isoActive = (ctx) => !!ctx.active && ctx.active.has('ISO27001');
const needs = (ctx, ...names) => { for (const n of names) if (ctx[n] == null) throw new Error(`${n} unavailable`); };

// ── The kinds ─────────────────────────────────────────────────────────────
// gate(ctx, d)  → boolean: may this caller see the key at all
// count(ctx, d) → the value for the key
const KINDS = [
    {
        // compliance/attention.build — the same list the Overview shows.
        key: 'attention_open',
        gate: () => true,
        count: async (ctx, d) => {
            const a = await d.attention.build(ctx.orgId, { limit: 0, req: ctx.req });
            if (!a.complete) throw new Error('attention incomplete');
            return a.total;
        },
    },
    {
        // routes/compliance/overview.js last_run_at — newest run_at of the latest rows.
        key: 'last_run',
        gate: () => true,
        count: async (ctx) => {
            needs(ctx, 'latest');
            return { at: maxDate(ctx.latest, 'run_at'), interval_hours: SWEEP_INTERVAL_HOURS };
        },
    },
    {
        // score.scoresByFramework over the ACTIVE rows — enabled frameworks only;
        // a candidate is never given a score key (that would leak "there is
        // something to score" to an org without the capability).
        key: 'frameworks',
        gate: (ctx) => !!ctx.policy,
        count: async (ctx, d) => {
            needs(ctx, 'latest', 'policy');
            const activeIds = new Set(ctx.policy.filter(p => p.enabled && !p.locked).map(p => p.id));
            const rows = ctx.latest.filter(r => {
                const def = d.registry.get(r.check_id);
                return ctx.active.has(def?.regulation || r.regulation);
            });
            // scoresByFramework gates on REGULATION CODES, not framework ids —
            // ctx.active is that set; activeIds only shapes the output below.
            const by = d.score.scoresByFramework(rows, ctx.active);
            const out = {};
            for (const id of activeIds) {
                const s = by[id]?.score ?? null;
                out[id] = { score: s, tone: toneOfScore(s) };
            }
            return out;
        },
    },
    {
        // frameworkPolicy.resolve — active / candidates / recently in force / locked.
        key: 'frameworks_summary',
        gate: (ctx) => !!ctx.policy,
        count: async (ctx, d) => {
            needs(ctx, 'policy');
            const now = d.now();
            const cutoff = now - RECENTLY_IN_FORCE_DAYS * 24 * 3600 * 1000;
            let active = 0, candidates = 0, recently = 0, locked = 0;
            for (const p of ctx.policy) {
                if (p.enabled && !p.locked) { active++; continue; }
                candidates++;
                if (p.locked) locked++;
                const fw = d.frameworks.byId(p.id);
                const since = fw?.in_force_since ? new Date(fw.in_force_since).getTime() : null;
                if (since != null && since <= now && since >= cutoff) recently++;
            }
            return { active, candidates, recently_in_force: recently, locked };
        },
    },
    {
        // dsrStore.listOpenWithDeadlines — same rows the inbox lists as open.
        key: 'dsr',
        gate: (ctx) => !!ctx.active && ctx.active.has('GDPR'),
        count: async (ctx, d) => {
            const rows = await d.dsrStore.listOpenWithDeadlines(ctx.orgId);
            const now = d.now();
            let overdue = 0, dueSoon = 0;
            for (const r of rows || []) {
                const due = r.due_at ? new Date(r.due_at).getTime() : null;
                if (due == null) continue;
                if (due < now) overdue++;
                else if (due - now <= DSR_DUE_SOON_MS) dueSoon++;
            }
            return { open: (rows || []).length, overdue, due_soon: dueSoon };
        },
    },
    {
        // incidentStore.getDeadlineStats + listOpenClocks (next clock).
        key: 'incidents',
        gate: (ctx) => !!ctx.active && (ctx.active.has('GDPR') || ctx.active.has('NIS2') || ctx.active.has('CRA') || ctx.active.has('DORA')),
        count: async (ctx, d) => {
            const [stats, clocks] = await Promise.all([
                d.incidentStore.getDeadlineStats(ctx.orgId),
                d.incidentStore.listOpenClocks(ctx.orgId),
            ]);
            const now = d.now();
            let next = null;
            for (const r of clocks || []) {
                if (r.authority_notified_at || !r.deadline_at) continue;
                const t = new Date(r.deadline_at).getTime();
                if (Number.isFinite(t) && (next == null || t < next)) next = t;
            }
            return {
                open: Number(stats?.open) || 0,
                next_deadline_at: next == null ? null : new Date(next).toISOString(),
                hours_left: next == null ? null : Math.floor((next - now) / 3600_000),
                vulnerabilities_open: ctx.active.has('CRA') ? (Number(stats?.vulnerabilities_open) || 0) : null,
            };
        },
    },
    {
        // complianceStore.getSettings ropa_reviewed_at.
        key: 'ropa',
        gate: (ctx) => !!ctx.active && ctx.active.has('GDPR'),
        count: async (ctx) => { needs(ctx, 'settings'); return { last_reviewed_at: ctx.settings.ropa_reviewed_at || null }; },
    },
    {
        // dpiaStore.listForOrg — published agents without a CURRENT assessment
        // are what the DPIA page lists as "to do"; the store gives the latest
        // per agent, so todo = latest rows that are not current + agents with
        // no row at all (from the Art. 35 latest result when present).
        key: 'dpia',
        gate: (ctx) => !!ctx.active && ctx.active.has('GDPR'),
        count: async (ctx, d) => {
            const rows = await d.dpiaStore.listForOrg(ctx.orgId);
            let todo = (rows || []).filter(r => !d.dpiaStore.isCurrent(r)).length;
            // Agents that never had an assessment: the per-source Art. 35 rows
            // that fail/warn (each is one high-risk agent without a DPIA).
            if (ctx.latest) {
                const assessed = new Set((rows || []).map(r => String(r.agent_id)));
                for (const r of ctx.latest) {
                    if (r.check_id === 'GDPR-Art35-dpia-high-risk' && r.scope_id && (r.status === 'fail' || r.status === 'warn') && !assessed.has(String(r.scope_id))) todo++;
                }
            }
            return { todo };
        },
    },
    {
        // riskStore.getStats.
        key: 'risks',
        gate: isoActive,
        count: async (ctx, d) => {
            const s = await d.riskStore.getStats(ctx.orgId);
            return { total: Number(s?.total) || 0, high: Number(s?.high) || 0 };
        },
    },
    {
        // soaStore.getStats.
        key: 'soa',
        gate: isoActive,
        count: async (ctx, d) => {
            const s = await d.soaStore.getStats(ctx.orgId);
            return { approved: Number(s?.approved) || 0, total: Number(s?.total) || 0 };
        },
    },
    {
        // ismsDocStore.listDocs — published docs; review_due when review_due_at < now.
        key: 'policies',
        gate: isoActive,
        count: async (ctx, d) => {
            const docs = await d.ismsDocStore.listDocs(ctx.orgId);
            const now = d.now();
            const published = (docs || []).filter(x => x.status === 'published');
            return {
                total: published.length,
                review_due: published.filter(x => x.review_due_at && new Date(x.review_due_at).getTime() < now).length,
            };
        },
    },
    {
        // isoAuditStore.listAudits — planned = not yet completed.
        key: 'audits',
        gate: isoActive,
        count: async (ctx, d) => {
            const audits = await d.isoAuditStore.listAudits(ctx.orgId);
            return { planned: (audits || []).filter(a => !a.completed_at && a.status !== 'completed' && a.status !== 'closed').length };
        },
    },
    {
        // routes/compliance/isoProcess.js GET /iso/training — members of the
        // org; done = members who acknowledged every published document (the
        // page's "policy_acks / policy_total" column at 100 %).
        key: 'training',
        gate: isoActive,
        count: async (ctx, d) => {
            const row = await d.db.getOne(`
                WITH members AS (
                    SELECT id FROM users
                    WHERE "organizationId" = $1 AND email IS NOT NULL AND email <> '' AND id <> 'admin'
                ),
                published AS (
                    SELECT COUNT(*)::int AS n FROM isms_documents WHERE organization_id = $1 AND status = 'published'
                ),
                acks AS (
                    SELECT a.user_id, COUNT(*)::int AS n
                    FROM isms_acknowledgements a
                    JOIN isms_documents d ON d.organization_id = a.organization_id
                        AND d.slug = a.slug AND d.current_version = a.version
                    WHERE a.organization_id = $1 AND d.status = 'published'
                    GROUP BY a.user_id
                )
                SELECT (SELECT COUNT(*)::int FROM members) AS total,
                       (SELECT COUNT(*)::int FROM members m
                          JOIN acks ON acks.user_id = m.id
                         WHERE (SELECT n FROM published) > 0 AND acks.n >= (SELECT n FROM published)) AS done
            `, [ctx.orgId]);
            return { done: Number(row?.done) || 0, total: Number(row?.total) || 0 };
        },
    },
    {
        // isoEvidenceStore.listConfigs — enabled connectors; next sweep = last + 6 h.
        key: 'connectors',
        gate: isoActive,
        count: async (ctx, d) => {
            const configs = await d.isoEvidenceStore.listConfigs(ctx.orgId);
            const enabled = (configs || []).filter(c => c.enabled !== false);
            const last = maxDate(enabled, 'last_sweep_at');
            return {
                count: enabled.length,
                next_sweep_at: last ? new Date(new Date(last).getTime() + SWEEP_INTERVAL_HOURS * 3600_000).toISOString() : null,
            };
        },
    },
    {
        // evidence/chain.verifyChain over the newest 200 rows (the footer of
        // the rail: "n rows · SHA-256 · chain intact").
        key: 'evidence',
        gate: () => true,
        count: async (ctx, d) => {
            const report = await d.chain.verifyChain(ctx.orgId, { limit: EVIDENCE_CHAIN_CHECK_ROWS });
            // ok === null is "not provisioned" (the chain columns do not exist
            // yet), never "broken". Omit the key — the rail renders no footer
            // for an absent key, but renders "chain broken" for chain_ok:false.
            if (!report || report.ok == null) throw new Error('evidence chain not verifiable');
            return {
                rows: Number(report?.rows_total) || 0,
                chain_ok: report?.ok === true,
                algorithm: 'SHA-256',
                checked_rows: Number(report?.verified_rows) || 0,
            };
        },
    },
    {
        key: 'onboarded',
        gate: () => true,
        count: async (ctx) => { needs(ctx, 'settings'); return !!ctx.settings.onboarded_at; },
    },
    {
        // Which of the four setup tiles is next (1-based); null once onboarded.
        key: 'setup_step',
        gate: () => true,
        count: async (ctx) => {
            needs(ctx, 'settings');
            const s = ctx.settings;
            if (s.onboarded_at) return null;
            if (!s.dpo_name && !s.dpo_email) return 1;
            if (!Array.isArray(s.breach_recipients) || s.breach_recipients.length === 0) return 2;
            if (!s.ropa_reviewed_at) return 3;
            return 4;
        },
    },
];

const KIND_KEYS = Object.freeze(KINDS.map(k => k.key));

/** → { body, partial } — `partial` is true when any kind threw (its key is absent). */
async function computeCounts(req, orgId, d) {
    const ctx = await loadContext(req, orgId, d);
    const body = {};
    let partial = ctx.errors.length > 0;
    await Promise.all(KINDS.map(async (kind) => {
        try {
            if (!(await kind.gate(ctx, d))) return;
            body[kind.key] = await kind.count(ctx, d);
        } catch (err) {
            partial = true;
            log.warn(`[ComplianceCounts] ${kind.key} failed:`, err?.message || err);
        }
    }));
    return { body, partial };
}

/**
 * A key the body does not carry is left out, as counts.test.js pins: the rail
 * asks for the counts it knows and a Community build answers fewer of them, so
 * "ignore what is not there" is how a newer client talks to an older server.
 * What IS refused is a misspelled PARAMETER (`?kesy=`), which used to drop the
 * filter and answer with every count — see CountsQuery below.
 */
function pickKeys(body, keysParam) {
    if (typeof keysParam !== 'string' || !keysParam.trim()) return body;
    const wanted = new Set(keysParam.split(',').map(s => s.trim()).filter(Boolean));
    const out = {};
    for (const k of wanted) if (k in body) out[k] = body[k];
    return out;
}

// The cache itself lives in compliance/countsCache.js so the runner and the
// event handlers can bust it without requiring this route module (a feature
// must not reach up into its own HTTP layer — layering.test.js).
const countsCache = require('../../compliance/countsCache');
const invalidate = countsCache.invalidate;

function createCountsRouter(overrides = null) {
    const d = makeLazyDeps(DEFAULT_LOADERS, overrides || {});
    const router = express.Router();
    const now = () => (typeof d.now === 'function' ? d.now() : Date.now());

    const cacheGet = (key) => countsCache.get(key, now());
    const cacheSet = (key, body) => countsCache.set(key, body, now());

    // Gates resolved per request so requiring this module never touches the
    // auth layer (and its db) at load time — the runner injects this module
    // lazily from inside a sweep.
    const requireAuth = (req, res, next) => d.permissions.requireAuth(req, res, next);
    const requireAdminCompliance = (req, res, next) => d.permissions.requirePermission('admin_compliance')(req, res, next);
    router.get('/counts', requireAuth, requireAdminCompliance, validate({ query: CountsQuery }), async (req, res) => {
        const orgId = await d.shared.requireOrgId(req, res);
        if (!orgId) return;
        // The server cache is the only cache: no-store keeps the browser from
        // answering the visibilitychange catch-up fetch with a stale body.
        res.set('Cache-Control', 'private, no-store');
        const cached = cacheGet(orgId);
        if (cached) return res.json(pickKeys(cached, req.query.keys));
        let counted;
        try {
            counted = await computeCounts(req, orgId, d);
        } catch (err) {
            log.error('[ComplianceCounts] failed:', err?.message || err);
            return res.status(500).json({ error: 'Could not count' });
        }
        // Outside the catch: a misspelled `keys` is the caller's 400, never a
        // "could not count" that reads as the server's own fault.
        if (!counted.partial) cacheSet(orgId, counted.body);
        return res.json(pickKeys(counted.body, req.query.keys));
    });

    router.__clearCacheForTests = () => countsCache.clear();
    return router;
}

const router = createCountsRouter();

module.exports = router;
module.exports.createCountsRouter = createCountsRouter;
module.exports.invalidate = invalidate;
module.exports.KIND_KEYS = KIND_KEYS;
module.exports.CACHE_TTL_MS = CACHE_TTL_MS;
module.exports.toneOfScore = toneOfScore;
module.exports.RECENTLY_IN_FORCE_DAYS = RECENTLY_IN_FORCE_DAYS;
module.exports.EVIDENCE_CHAIN_CHECK_ROWS = EVIDENCE_CHAIN_CHECK_ROWS;
