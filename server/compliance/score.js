/**
 * Compliance score model — the single implementation shared by the API routes
 * (/overview, /checks/run, /counts) and the runner's per-run score snapshot, so
 * a displayed score and a persisted snapshot can never disagree.
 *
 * score = round(sum(weight × statusFactor) / sum(weight) × 100)
 *   statusFactor: pass = 1.0, warn = 0.5, fail = 0
 *   'not_applicable' rows are excluded from the denominator.
 *
 * NOTHING TO MEASURE IS NOT 100 %. When every row is 'not_applicable' the
 * denominator is 0, and there is no evidence of compliance to report — the
 * `score` is then `null`, the contract's "unknown" (`scoreNumbers` keeps it
 * null, /frameworks and /counts pass it through, and the client's ScoreRing
 * renders its placeholder for a null). Returning 100 there meant an org that
 * marked DORA "not relevant" — which makes every DORA check answer
 * 'not_applicable' by design — saw a perfect DORA card. The counters
 * (total/na) are still reported, so the card can say "5 checks · 5 n/a".
 *
 * A check counts for every framework in its registry `frameworks[]` (a GDPR
 * Art. 33 result is also ISO A.5.24 evidence), so one result row can appear in
 * two frameworks' scores — once each, never twice in the same framework.
 */

const registry = require('./registry');
const frameworks = require('./frameworks');

const SEVERITY_WEIGHT = { critical: 3, high: 2, medium: 1, low: 0.5 };

// Every regulation the hub scores — GDPR, AIA, ISO27001 first, then the
// growing set, CUSTOM last. The runner snapshots one score per built-in
// framework into the `scores` JSONB; the three legacy columns are named in
// SNAPSHOT_COLUMN and keep being written for the old sparkline consumers.
const REGULATIONS = frameworks.regulationCodes();
const SNAPSHOT_COLUMN = { GDPR: 'gdpr_score', AIA: 'aia_score', ISO27001: 'iso_score' };

function computeScore(results) {
    // An EMPTY list keeps its historical `score: 0`. Callers that display a
    // framework never hand it one — scoresByFramework/frameworks.js guard on
    // `rows.length` and return null — so the 0 only ever reaches the "no
    // checks have run at all" aggregates, where `first_scan_ran` is the flag
    // that says so. Deliberately left alone here; see score.test.js.
    if (!results.length) return { score: 0, total: 0, pass: 0, warn: 0, fail: 0, na: 0 };
    let earned = 0, max = 0;
    let pass = 0, warn = 0, fail = 0, na = 0;
    for (const r of results) {
        const check = registry.get(r.check_id);
        const w = SEVERITY_WEIGHT[check?.severity || r.severity] || 1;
        // 'na' is the custom-framework runner's spelling of the same thing
        // (compliance/custom/runner.js OUTCOME_STATUS); without it a check
        // attested "not applicable" fell through to the `else` and scored 0.
        if (r.status === 'not_applicable' || r.status === 'na') { na++; continue; }
        max += w;
        if (r.status === 'pass') { earned += w; pass++; }
        else if (r.status === 'warn') { earned += w * 0.5; warn++; }
        else fail++;
    }
    // max === 0 means every row was 'not_applicable': there is no denominator,
    // so there is no score. `null`, never 100 (see the module docstring).
    const score = max > 0 ? Math.round((earned / max) * 100) : null;
    return { score, total: results.length, pass, warn, fail, na };
}

/**
 * Filter a result list to the rows that COUNT for one regulation. A registered
 * check counts via its `frameworks[]` (home + tagged); a row the registry does
 * not know (a custom-framework row, a check retired since) falls back to the
 * row's own `regulation` column.
 */
function forRegulation(results, regulation) {
    return results.filter(r => {
        const check = registry.get(r.check_id);
        if (check && Array.isArray(check.frameworks)) {
            return check.frameworks.some(f => f.regulation === regulation);
        }
        return r.regulation === regulation;
    });
}

/**
 * One score per built-in framework, keyed by framework id — the shape the
 * `scores` JSONB on a snapshot, /overview and /counts share.
 *   scoresByFramework(results)            → every built-in framework
 *   scoresByFramework(results, activeSet) → only frameworks whose regulation is
 *                                           in the Set (a disabled framework
 *                                           must not be scored from shared rows)
 * A framework with no counting rows is `null`, never 100 — and so is a
 * framework whose every row is 'not_applicable': there the entry is the
 * counter object with `score: null` (the n/a tally is still worth showing),
 * which `scoreNumbers` flattens to the same null.
 */
function scoresByFramework(results, active = null) {
    const out = {};
    for (const fw of frameworks.listBuiltin()) {
        if (active && !active.has(fw.regulation)) continue;
        const rows = forRegulation(results, fw.regulation);
        out[fw.id] = rows.length ? computeScore(rows) : null;
    }
    return out;
}

/** `{ gdpr: {score: 79, …} | null }` → `{ gdpr: 79 | null }` for the snapshot JSONB. */
function scoreNumbers(byFramework) {
    const out = {};
    for (const [id, s] of Object.entries(byFramework || {})) out[id] = s ? s.score : null;
    return out;
}

// Custom-framework check rows are attested, not evaluated: their status
// vocabulary maps onto the check vocabulary before the same weights apply.
const CUSTOM_STATUS = { attested: 'pass', todo: 'fail', not_applicable: 'not_applicable' };

/**
 * Score for one org-defined framework from its check rows
 * (`{ status: 'attested'|'todo'|'not_applicable', severity }`). A row whose
 * status is already in the check vocabulary passes through unchanged.
 */
function customFrameworkScore(rows) {
    const mapped = (rows || []).map(r => ({
        ...r,
        status: CUSTOM_STATUS[r.status] || r.status,
    }));
    return computeScore(mapped);
}

module.exports = {
    SEVERITY_WEIGHT, REGULATIONS, SNAPSHOT_COLUMN,
    computeScore, forRegulation, scoresByFramework, scoreNumbers, customFrameworkScore,
};
