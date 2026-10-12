/**
 * GET /api/studio/attention — the "Needs attention" list on Studio Home.
 *
 *   → { rows, total, sources, unavailable, capped, gated, complete }
 *
 * ── WHAT THIS ROUTE IS FOR ─────────────────────────────────────────────────
 *
 * An empty attention list is a SENTENCE, not a blank space: it says "nothing
 * here needs you". That sentence is only true when all six sources actually
 * answered, so this endpoint's whole job is to keep "we looked and found
 * nothing" apart from "we could not look".
 *
 * `complete` is the licence to say it. A client may render "Nothing needs
 * attention" only when `rows` is empty AND `complete === true`; with
 * `complete === false` the honest line is that some checks could not run and
 * this list may be incomplete. Getting that wrong is not a cosmetic bug — O2
 * phase 1 shipped "Everything in this project is connected and owned
 * consistently" over a graph half of which had never loaded, and this response
 * is shaped so the same screen cannot be built by accident.
 *
 * Four values, three of which look identical if you only read `rows`:
 *
 *   sources[k].status = 'checked'      it ran; `found` is how many rows it
 *                                      produced, and 0 is real news
 *   sources[k].status = 'capped'       it ran, but only over the first N of a
 *                                      bigger organisation; `found` counts what
 *                                      it saw and `complete` goes false
 *   sources[k].status = 'unavailable'  it fell over, or could only answer in
 *                                      part; `found` is null, and `complete`
 *                                      goes false
 *   sources[k].status = 'gated'        the caller may not see this kind at all
 *
 * A BUDGET IS NOT A BREAKDOWN, and it is not a clean bill of health either.
 * The four budgets in attentionChecks.js bite on SIZE: an organisation with 30
 * Solutions is checked over the first twelve, permanently, at every load.
 * Folding that into `unavailable` would tell such an organisation "some checks
 * could not run" forever — the same warning fatigue `gated` is kept out of
 * `complete` to avoid. Folding it into `checked` would be worse: "nothing needs
 * attention" over the two thirds nobody looked at. So it is its own value,
 * reported in `capped[]`, and it DOES clear `complete` — the screen may then
 * say "this covers the busiest part of your organisation", which is a different
 * sentence from "something went wrong" and from "all is well".
 *
 * GATED IS NOT A GAP, and that is a deliberate call. A source the caller is not
 * entitled to is a known, permanent absence — a Community organisation has no
 * Solutions to be blocked — and folding it into `complete` would leave those
 * organisations permanently told that "some checks could not run", which is the
 * fastest way to teach people to ignore the warning. `gated` is reported
 * separately instead, so the screen can say "agents were not checked because
 * you do not manage agents" rather than implying there are none. A gate that
 * THROWS is a different matter entirely: it lands in `unavailable`, because
 * "the entitlement service is down" must never read as an open door.
 *
 * ── The six sources ────────────────────────────────────────────────────────
 *
 * They live in ./attentionChecks.js as a register, they run under
 * Promise.allSettled so one slow store cannot hold up the other five, and each
 * one carries the SAME gate its own list route sits behind and the SAME scoping
 * that route uses — the two rules routes/studio/counts.js and
 * routes/studio/search.js are built to, applied a third time.
 *
 * ── It is an aggregate, not a second opinion ───────────────────────────────
 *
 * Every row comes out of the producer that already owns its rule (the App
 * Studio validator through projects/completeness.js, the empty-knowledge-base
 * rule itself, the Solution completeness verdict copied verbatim, the
 * kb_sources status column, the runs table). The two rules that exist nowhere
 * else — a published agent with no knowledge base, an automation's failure streak —
 * are written once in the register. Nothing here rephrases a producer's words.
 *
 * ── A row's deep link opens ────────────────────────────────────────────────
 *
 * `deepLink` is projects/completeness.js's own helper: the builder's screen for
 * that kind, or null when the producer had no id (a link to
 * /app/studio/apps/null is worse than no button). One source overrides it —
 * Solutions, whose kind is shared with the graph's synthetic nodes; see
 * attentionChecks.js solutionDeepLink for why that belongs to the source and
 * not to the shared map. Each source is additionally
 * scoped so the link cannot land on a 403 — apps are limited to the ones this
 * caller can open in the editor, automations to their own, Solutions to the ones
 * they hold a role on.
 *
 * Mounted at /api/studio behind requireAuth (server/index.js); the route
 * re-checks the session so a bare mount cannot leak.
 *
 * Dependencies are injectable (`createAttentionRouter(deps)`) so the tests
 * exercise every source, every source falling over, and the combination,
 * without a database.
 *
 * ── It takes no query, and says so ─────────────────────────────────────────
 * The query is `.strict()` and empty. A parameter this route does not read
 * used to be answered 200 as if it had been: `?refresh=1` after fixing
 * something got the cached list of up to a minute ago, and `?source=apps` got
 * all six sources — each under a 200 that read as the answer to the question.
 */

'use strict';

const express = require('express');
const { z } = require('zod');

const { validate } = require('../../core/http/validate');

const { makeLazyDeps, userIdOf, orgIdOf } = require('./shared');
const { SOURCES, SOURCE_KEYS, MAX_ROWS_PER_SOURCE } = require('./attentionChecks');
const { deepLinkFor } = require('../../projects/completeness');
const { bySeverity } = require('../../core/findings/finding');
const log = require('../../telemetry/log');

/** Same window counts.js uses, and for the same reason: this is a poll. */
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 5000;

// Lazily-required production dependencies. Each is the module the producer of
// that source already uses; nothing here is new data access.
const DEFAULT_LOADERS = {
    modules: () => require('../../modules'),
    license: () => require('../../license/middleware'),
    entitlements: () => require('../../core/entitlements/entitlements'),
    permissions: () => require('../../auth/permissions'),
    auth: () => require('../../auth'),
    audience: () => require('../../auth/audience'),
    studioAppStore: () => require('../../stores/studioAppStore'),
    automationStore: () => require('../../stores/automationStore'),
    kbStore: () => require('../../stores/knowledgeBases'),
    kbShared: () => require('../knowledgeBases/shared'),
    kbSourcesStore: () => require('../../stores/kbSources'),
    kbUsage: () => require('../../core/kb/kbUsage'),
    projectStore: () => require('../../stores/projectStore'),
    configStore: () => require('../../stores/configStore'),
    db: () => require('../../db'),
    mapLimited: () => require('../../projects/summary').mapLimited,
    /**
     * One Solution's completeness — the SAME two calls GET /api/projects/summary
     * makes per card, so Studio Home and the Solutions overview cannot disagree
     * about whether a Solution is blocked.
     */
    solutionCompleteness: () => async (projectId) => {
        const { buildGraphForProject } = require('../projects');
        const { collectCompleteness } = require('../../projects/completeness');
        const { graph, members, unavailable } = await buildGraphForProject(projectId);
        return collectCompleteness({ graph, ...members, unavailable });
    },
    now: () => Date.now,
};

const makeDefaultDeps = () => makeLazyDeps(DEFAULT_LOADERS);

/** No parameters at all; each key it is sent is named back in the refusal. */
const NoQuery = z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object({}, {
        errorMap: (issue, ctx) => ({
            message: issue.code === z.ZodIssueCode.unrecognized_keys
                ? `The attention list takes no parameters — it always checks every source you may see (got ${issue.keys.map((k) => `"${k}"`).join(', ')}).`
                : ctx.defaultError,
        }),
    }).strict(),
);

/** The session check, ahead of the schema: a caller without one hears 401, not 400. */
const requireSession = (req, res, next) => (req.session?.isAuthenticated && userIdOf(req)
    ? next()
    : res.status(401).json({ error: 'Not authenticated' }));

/**
 * A Finding → the row the client renders.
 *
 * Exactly the fields Studio Home needs, plus two that carry meaning it would
 * otherwise have to guess: `source` (which of the six produced this, so the row
 * can be labelled and grouped) and `remediation` (the producer's own hint,
 * which the validation pill renders as its "→" line). `targetId` is
 * targetRef.id flattened — null when the producer only ever saw a definition.
 */
function toRow(source, finding) {
    const row = {
        source: source.key,
        code: finding.code,
        severity: finding.severity,
        kind: finding.kind,
        targetId: finding.targetRef?.id ?? null,
        message: finding.message,
        // completeness.js's helper, unless the source can prove a link its
        // general map is not allowed to build (see solutionDeepLink).
        deepLink: (source.linkFor || deepLinkFor)(finding),
    };
    if (finding.remediation) row.remediation = finding.remediation;
    return row;
}

/**
 * A gap that is a SIZE, not a failure.
 *
 * The loaders name their budget gaps `<source>:budget` (attentionChecks.js),
 * and that suffix is the whole vocabulary — a gap label is written in one
 * place and read here.
 */
const isBudgetGap = (label) => typeof label === 'string' && label.endsWith(':budget');

/**
 * Run ONE source to a verdict. Never throws.
 *
 * The order of the three catches is the contract:
 *   - the gate says no        → gated, no rows, not a gap
 *   - the gate cannot answer  → unavailable (unknown NARROWS). The gate helpers
 *     in ./shared.js throw a GateUndecidable for exactly this; without it a
 *     degraded entitlement or permission lookup would arrive as a plain `false`
 *     and be reported as "not yours", which is a reassurance nobody earned
 *   - load/evaluate throws    → unavailable
 * A source that hit a gap INSIDE itself still returns the rows it did find —
 * dropping them would lose real problems — and cannot vouch for the rest: a
 * budget gap makes it `capped`, any other gap makes it `unavailable`.
 */
async function runSource(source, req, d, ctx) {
    try {
        if (!(await source.gate(req, d))) {
            return { key: source.key, status: 'gated', findings: [], gaps: [] };
        }
    } catch (err) {
        log.warn(`[StudioAttention] gate ${source.key} failed:`, err?.message || err);
        return { key: source.key, status: 'unavailable', findings: [], gaps: ['gate'] };
    }
    try {
        const data = await source.load(req, d, ctx);
        const { findings, gaps } = source.evaluate(data);
        const list = Array.isArray(findings) ? findings : [];
        const holes = Array.isArray(gaps) ? gaps : [];
        const broke = holes.filter((g) => !isBudgetGap(g));
        let status = 'checked';
        if (broke.length > 0) status = 'unavailable';
        else if (holes.length > 0) status = 'capped';
        return { key: source.key, status, findings: list, gaps: holes };
    } catch (err) {
        log.warn(`[StudioAttention] ${source.key} failed:`, err?.message || err);
        return { key: source.key, status: 'unavailable', findings: [], gaps: ['load'] };
    }
}

/**
 * → the response body.
 *
 * `Promise.allSettled`, not `Promise.all`: runSource already catches everything
 * it can name, and allSettled is the net under the one it cannot — a source
 * that rejects in some way nobody predicted becomes `unavailable` instead of
 * vanishing from `sources` and quietly shrinking the question.
 */
async function collectAttention(req, d, sources = SOURCES) {
    const memo = new Map();
    const ctx = {
        // Shared reads (the visible knowledge bases) happen once per request.
        // Sharing a READ does not share a VERDICT: every source still runs in
        // its own try/catch, so a failure here marks each of its users
        // unavailable independently, which is exactly what happened.
        once: (key, fn) => {
            if (!memo.has(key)) memo.set(key, fn());
            return memo.get(key);
        },
    };

    const settled = await Promise.allSettled(sources.map(s => runSource(s, req, d, ctx)));

    const rows = [];
    const summary = {};
    const unavailable = [];
    const capped = [];
    const gated = [];
    let total = 0;

    settled.forEach((outcome, i) => {
        const key = sources[i].key;
        const result = outcome.status === 'fulfilled'
            ? outcome.value
            // Defensive: runSource is written not to reject. If it ever does,
            // the source is UNCHECKED, never silently absent.
            : { key, status: 'unavailable', findings: [], gaps: ['runner'] };

        if (result.status === 'gated') {
            summary[key] = { status: 'gated', found: null, truncated: false };
            gated.push(key);
            return;
        }
        const found = result.findings.length;
        total += found;
        const kept = result.findings.slice(0, MAX_ROWS_PER_SOURCE);
        for (const finding of kept) rows.push(toRow(sources[i], finding));
        if (result.status === 'unavailable') {
            // `found: null` even when this source DID contribute rows: those
            // rows are real and are kept, but the COUNT cannot be vouched for
            // — there may be more behind the gap. Rows say what was found;
            // `found` says how much of the question was answered, and on this
            // screen a number nobody can stand behind is not a number.
            summary[key] = { status: 'unavailable', found: null, truncated: found > kept.length };
            unavailable.push(key);
        } else if (result.status === 'capped') {
            // `found` IS a number here, and an honest one: it is what this
            // source found in the part it was given. What it cannot say is
            // that there is nothing behind the cap — which is what `capped`
            // and `complete: false` say instead.
            summary[key] = { status: 'capped', found, truncated: found > kept.length };
            capped.push(key);
        } else {
            summary[key] = { status: 'checked', found, truncated: found > kept.length };
        }
    });

    unavailable.sort();
    capped.sort();
    gated.sort();
    rows.sort(bySeverity);

    return {
        rows,
        // The number FOUND, before any per-source cap — so "17 things need
        // attention" over 20 shown rows is still an honest count.
        total,
        sources: summary,
        unavailable,
        // Ran, but only over the first N. Not a breakdown; still not the whole
        // organisation, so it is named separately and still clears `complete`.
        capped,
        gated,
        // The one field that licenses "nothing needs attention".
        complete: unavailable.length === 0 && capped.length === 0,
    };
}

function createAttentionRouter(deps = null) {
    const d = deps || makeDefaultDeps();
    const router = express.Router();
    const cache = new Map();

    const now = () => (typeof d.now === 'function' ? d.now() : Date.now());
    const cacheGet = (key) => {
        const hit = cache.get(key);
        if (!hit) return null;
        if (now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
        return hit.body;
    };
    const cacheSet = (key, body) => {
        if (cache.size >= CACHE_MAX_ENTRIES) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, { at: now(), body });
    };

    router.get('/attention', requireSession, validate({ query: NoQuery }), async (req, res) => {
        const key = `${orgIdOf(req) || ''}:${userIdOf(req)}`;
        // The server cache is the only cache; a per-user answer must not also
        // sit in a browser cache.
        res.set('Cache-Control', 'private, no-store');
        const cached = cacheGet(key);
        if (cached) return res.json(cached);
        try {
            const body = await collectAttention(req, d);
            // ONLY A COMPLETE ANSWER IS CACHED. Holding an incomplete one for a
            // minute would turn a two-second store hiccup into a minute of a
            // screen that cannot say whether anything is wrong.
            if (body.complete) cacheSet(key, body);
            return res.json(body);
        } catch (err) {
            // collectAttention swallows per-source failures, so this is the
            // "could not even start" case. It 500s rather than answering with
            // an empty list, because an empty list is the one sentence this
            // endpoint must never say by accident.
            log.error('[StudioAttention] failed:', err?.message || err);
            return res.status(500).json({ error: 'Could not check' });
        }
    });

    router.__clearCacheForTests = () => cache.clear();
    return router;
}

const router = createAttentionRouter();

module.exports = router;
module.exports.createAttentionRouter = createAttentionRouter;
module.exports.collectAttention = collectAttention;
module.exports.toRow = toRow;
module.exports.SOURCE_KEYS = SOURCE_KEYS;
module.exports.CACHE_TTL_MS = CACHE_TTL_MS;
