// @typecheck
/**
 * Check results (compliance_checks, a time series) and the per-sweep score
 * snapshots (compliance_score_history).
 *
 * The db helpers and the store's initDB come in from the barrel
 * (stores/complianceStore.js), so this module requires no database itself.
 */

// Legacy column ↔ framework id. The three original frameworks keep their
// columns so old sparkline consumers keep working; `scores` carries them too.
const LEGACY_SCORE_COLUMNS = { gdpr_score: 'gdpr', aia_score: 'aia', iso_score: 'iso27001' };

function _scoresObject(v) {
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/**
 * @param {{ run: Function, getAll: Function, initDB: () => Promise<any> }} deps
 */
function createChecks({ run, getAll, initDB }) {
    // ───────────────────────── Check results ─────────────────────────

    async function recordCheckResult(row) {
        await initDB();
        await run(`
            INSERT INTO compliance_checks
                (organization_id, check_id, regulation, article, severity, status,
                 evidence, details, scope_type, scope_id, run_type, framework_code)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
        `, [
            row.organization_id || null,
            row.check_id,
            row.regulation,
            row.article || null,
            row.severity || 'medium',
            row.status,
            JSON.stringify(row.evidence || {}),
            row.details || null,
            row.scope_type || 'global',
            row.scope_id || null,
            row.run_type || 'scheduled',
            row.framework_code || null,
        ]);
    }

    async function getLatestPerCheck(orgId) {
        await initDB();
        return getAll(`
            SELECT DISTINCT ON (check_id, scope_type, scope_id)
                check_id, regulation, article, severity, status, evidence, details,
                scope_type, scope_id, run_at, run_type, framework_code
            FROM compliance_checks
            WHERE organization_id = $1
            ORDER BY check_id, scope_type, scope_id, run_at DESC
        `, [orgId]);
    }

    /**
     * The newest row of every slot ONE check has ever written for an org —
     * `{scope_type, scope_id, status, evidence, run_at}`. The runner reads it after
     * a full sweep to retire the per-source subjects `listSubjects` stopped
     * returning (a deleted project must not keep its last warning forever).
     * Served by idx_compliance_checks_latest.
     */
    async function listLatestScopes(orgId, checkId) {
        await initDB();
        return getAll(`
            SELECT DISTINCT ON (scope_type, scope_id)
                scope_type, scope_id, status, evidence, run_at
            FROM compliance_checks
            WHERE organization_id = $1 AND check_id = $2
            ORDER BY scope_type, scope_id, run_at DESC
        `, [orgId, checkId]);
    }

    /**
     * The newest row per slot of the NAMED checks only — the targeted read the
     * end-user hint API makes instead of the org-wide getLatestPerCheck. Rows
     * older than `maxAgeDays` are left out: a check that stopped running (its
     * framework was switched off) must not keep feeding a hint.
     */
    async function getLatestForChecks(orgId, checkIds, { maxAgeDays = 3 } = {}) {
        await initDB();
        const ids = (Array.isArray(checkIds) ? checkIds : []).map(String).filter(Boolean);
        if (!ids.length) return [];
        return getAll(`
            SELECT DISTINCT ON (check_id, scope_type, scope_id)
                check_id, status, evidence, scope_type, scope_id, run_at
            FROM compliance_checks
            WHERE organization_id = $1 AND check_id = ANY($2::text[])
              AND run_at >= NOW() - ($3 || ' days')::interval
            ORDER BY check_id, scope_type, scope_id, run_at DESC
        `, [orgId, ids, String(Math.max(1, Math.trunc(Number(maxAgeDays) || 3)))]);
    }

    /**
     * One check's result rows, newest first. `scopeId` narrows them to one
     * subject's slot (a per-source check has a row per agent or automation, and
     * one row's audit trail must not show another subject's runs). Without it
     * every slot is returned, as before.
     *
     * @param {string} orgId
     * @param {string} checkId
     * @param {number} [limit]
     * @param {{ scopeId?: string | null }} [opts]
     */
    async function getCheckHistory(orgId, checkId, limit = 100, { scopeId } = {}) {
        await initDB();
        const scoped = typeof scopeId === 'string' && scopeId !== '';
        return getAll(`
            SELECT status, details, run_at, run_type, evidence, scope_type, scope_id, framework_code
            FROM compliance_checks
            WHERE organization_id = $1 AND check_id = $2
            ${scoped ? 'AND scope_id IS NOT DISTINCT FROM $4' : ''}
            ORDER BY run_at DESC
            LIMIT $3
        `, scoped ? [orgId, checkId, limit, scopeId] : [orgId, checkId, limit]);
    }

    // ───────────────────────── Score history ─────────────────────────
    /**
     * @param {object} row  organization_id, overall_score, pass/warn/fail/na,
     *   run_type, the legacy gdpr_score/aia_score/iso_score and/or `scores`
     *   ({<framework_id>: number|null}), and `coverage` — what the number was
     *   computed over. Either score side fills the other when only one is given,
     *   so a runner that passes just `scores` still lands the legacy columns and
     *   vice versa. A caller that passes no `coverage` stores NULL: the row then
     *   says the sweep did not record its coverage, which is not the same claim
     *   as "it covered everything" and must never be rendered as one.
     */
    async function recordScoreSnapshot(row) {
        await initDB();
        const scores = { ..._scoresObject(row.scores) };
        const legacy = {};
        for (const [col, fw] of Object.entries(LEGACY_SCORE_COLUMNS)) {
            legacy[col] = row[col] ?? scores[fw] ?? null;
            if (scores[fw] === undefined && row[col] != null) scores[fw] = row[col];
        }
        await run(`
            INSERT INTO compliance_score_history
                (organization_id, overall_score, gdpr_score, aia_score, iso_score, pass, warn, fail, na, run_type, scores, coverage)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
        `, [
            row.organization_id || 'default',
            row.overall_score ?? null,
            legacy.gdpr_score,
            legacy.aia_score,
            legacy.iso_score,
            row.pass ?? null, row.warn ?? null, row.fail ?? null, row.na ?? null,
            row.run_type || 'scheduled',
            JSON.stringify(scores),
            row.coverage == null ? null : JSON.stringify(row.coverage),
        ]);
    }

    /**
     * Snapshots of the last `days` days, oldest first. `scores` is always an
     * object: rows written before the column (or with an empty one) get
     * {gdpr, aia, iso27001} synthesised from the legacy columns on the way out —
     * read path only, the stored row is never rewritten.
     *
     * `coverage` is NOT synthesised. A row from before the column has no record of
     * what its score covered, and the honest value for that is `null`; inventing a
     * "fully covered" default for old rows would re-tell exactly the lie the
     * column was added to stop (compliance/runner.js, COVERAGE).
     */
    async function getScoreHistory(orgId, days = 90) {
        await initDB();
        const rows = await getAll(`
            SELECT overall_score, gdpr_score, aia_score, iso_score, pass, warn, fail, na, run_type, captured_at, scores, coverage
            FROM compliance_score_history
            WHERE organization_id = $1
              AND captured_at >= NOW() - ($2 || ' days')::interval
            ORDER BY captured_at ASC
        `, [orgId, String(days)]);
        return rows.map(r => {
            const stored = _scoresObject(r.scores);
            const scores = Object.keys(stored).length > 0
                ? stored
                : Object.fromEntries(Object.entries(LEGACY_SCORE_COLUMNS).map(([col, fw]) => [fw, r[col] ?? null]));
            const coverage = typeof r.coverage === 'string'
                ? (() => { try { return JSON.parse(r.coverage); } catch { return null; } })()
                : (r.coverage ?? null);
            return { ...r, scores, coverage };
        });
    }

    return {
        recordCheckResult,
        getLatestPerCheck,
        listLatestScopes,
        getLatestForChecks,
        getCheckHistory,
        recordScoreSnapshot,
        getScoreHistory,
    };
}

module.exports = { createChecks };
