// @typecheck
/**
 * Suggestion Scan Cache — caches the result of a Automations "Find repeating work"
 * scan so the (expensive) analysis isn't re-run on every panel open.
 *
 * A scan is keyed by a PER-USER scope plus a content hash (`cache_key`)
 * derived from the scan inputs (mode + sources + focus + day bucket). The same
 * inputs hit the cache; changing them produces a fresh key and a fresh scan.
 * Rows expire (`expires_at`) so stale activity never lingers — `pruneExpired()`
 * reaps them (wired into jobs/platformRetention.js).
 *
 * PRIVACY: the scope is ALWAYS the user (`user:<id>`), never the organisation.
 * A scan reads the user's own mail, files and ledger with their own
 * credentials, so an org-wide scope served one person's patterns to every
 * colleague through /suggest/last. Legacy `org:` rows are deleted by
 * migrations/suggestion-user-scope-2026-10.js.
 *
 * READ-ONLY analysis artefact: nothing here is trusted model state — the caller
 * clamps the model output (templates and numbers only) before it's persisted.
 */

const { run, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');

const DDL = `
    CREATE TABLE IF NOT EXISTS suggestion_scan_cache (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        user_id TEXT,
        organization_id TEXT,
        cache_key TEXT NOT NULL,
        focus TEXT,
        integration_ids TEXT,
        suggestions_json JSONB NOT NULL,
        summary_json JSONB,
        reason TEXT,
        model TEXT,
        eu BOOLEAN,
        scanned_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        UNIQUE (scope_key, cache_key)
    );
    CREATE INDEX IF NOT EXISTS idx_sug_scan_scope_scanned ON suggestion_scan_cache(scope_key, scanned_at DESC);
    -- 'patterns' (deterministic miner) or 'ideas' (LLM tool loop). NULL on
    -- rows written before the split, read as 'ideas'.
    ALTER TABLE suggestion_scan_cache ADD COLUMN IF NOT EXISTS mode TEXT;
    CREATE INDEX IF NOT EXISTS idx_sug_scan_user ON suggestion_scan_cache(user_id);
`;

const MODES = Object.freeze(['patterns', 'ideas']);

// How long a scan's results are retained for display after they were produced.
// Independent of `expires_at` (the compute-freshness window) — results stay
// visible across restarts until they age past this or the user re-scans.
const RETENTION_DAYS = 30;

// ============ Helpers ============

/**
 * The scope key of a scan: always the user. `organizationId` is accepted for
 * call-site compatibility and deliberately ignored (see the header).
 * @param {{ organizationId?: string|null, userId?: string|null }} [opts]
 */
function deriveScopeKey({ userId } = {}) {
    if (userId) return `user:${userId}`;
    return 'anon';
}

function safeJson(v, fallback) {
    if (v == null) return fallback;
    if (typeof v === 'object') return v; // pg already parsed JSONB
    try { return JSON.parse(v); } catch { return fallback; }
}

function normaliseMode(mode) {
    return MODES.includes(mode) ? mode : null;
}

function mapRow(r) {
    if (!r) return null;
    return {
        id: r.id,
        scopeKey: r.scope_key,
        userId: r.user_id || null,
        organizationId: r.organization_id || null,
        cacheKey: r.cache_key,
        mode: r.mode || null,
        focus: r.focus || null,
        integrationIds: r.integration_ids || null,
        suggestions: safeJson(r.suggestions_json, []),
        summary: safeJson(r.summary_json, null),
        reason: r.reason || null,
        model: r.model || null,
        eu: r.eu == null ? null : !!r.eu,
        scannedAt: r.scanned_at ? new Date(r.scanned_at).toISOString() : null,
        expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    };
}

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{rows: any[], rowCount?: number}> }} db
 * @param {{ ready?: () => Promise<unknown> }} [opts]
 */
function makeSuggestionScanCache(db, { ready = async () => {} } = {}) {
    const q = async (sql, params) => { await ready(); return db.query(sql, params); };
    const one = async (sql, params) => (await q(sql, params)).rows[0] || null;

    /**
     * Fetch a fresh cached scan for an exact (scope, inputs) match, or null.
     * "Fresh" = not yet expired at `now`. Pass the same clock that computed
     * `expiresAt` on the write (the route's `d.now()`), so both sides agree;
     * without one, the database's NOW() decides.
     * @param {{ scopeKey?: string, cacheKey?: string, now?: Date|number|null }} p
     */
    async function getCachedScan({ scopeKey, cacheKey, now = null }) {
        if (!scopeKey || !cacheKey) return null;
        const at = now == null ? null : new Date(now);
        return mapRow(await one(`
            SELECT * FROM suggestion_scan_cache
            WHERE scope_key = $1 AND cache_key = $2 AND expires_at > COALESCE($3::timestamptz, NOW())
            LIMIT 1
        `, [scopeKey, cacheKey, at && Number.isFinite(at.getTime()) ? at.toISOString() : null]));
    }

    /**
     * Most-recent scan for a scope (optionally of one mode), regardless of
     * inputs. Lets the UI show "your last scan" after the inputs change.
     *
     * NOTE: deliberately NOT filtered by `expires_at`. `expires_at` is only the
     * compute-freshness window used by getCachedScan. The user's last results
     * persist for display until they re-scan the same inputs (overwrite) or
     * the retention prune reaps them. A legacy row without a mode counts as
     * 'ideas'.
     * @param {{ scopeKey?: string, mode?: string|null }} [opts]
     */
    async function getLatestScan({ scopeKey, mode } = {}) {
        if (!scopeKey) return null;
        const m = normaliseMode(mode);
        if (!m) {
            return mapRow(await one(`
                SELECT * FROM suggestion_scan_cache
                WHERE scope_key = $1
                ORDER BY scanned_at DESC
                LIMIT 1
            `, [scopeKey]));
        }
        return mapRow(await one(`
            SELECT * FROM suggestion_scan_cache
            WHERE scope_key = $1 AND COALESCE(mode, 'ideas') = $2
            ORDER BY scanned_at DESC
            LIMIT 1
        `, [scopeKey, m]));
    }

    /**
     * Remove every suggestion matching `predicate` from all of a scope's scan
     * rows, in place. `predicate(suggestion)` returns true for suggestions to
     * DROP. Returns the number of rows actually modified.
     *
     * Powers the "dismiss a suggestion" action: stripping it from the persisted
     * rows means it never resurfaces from getLatestScan after a reload.
     */
    async function removeSuggestionsFromScope({ scopeKey, predicate }) {
        if (!scopeKey || typeof predicate !== 'function') return 0;
        const { rows } = await q(
            `SELECT id, suggestions_json FROM suggestion_scan_cache WHERE scope_key = $1`,
            [scopeKey],
        );
        let updated = 0;
        for (const row of rows) {
            const list = safeJson(row.suggestions_json, []);
            if (!Array.isArray(list) || list.length === 0) continue;
            const kept = list.filter(s => !predicate(s));
            if (kept.length !== list.length) {
                await q(
                    `UPDATE suggestion_scan_cache SET suggestions_json = $2::jsonb WHERE id = $1`,
                    [row.id, JSON.stringify(kept)],
                );
                updated++;
            }
        }
        return updated;
    }

    /**
     * Insert (or refresh) the cached scan for a (scope, inputs) pair. The row
     * id is deterministic (`scope:cacheKey`) so re-scanning the same inputs
     * overwrites in place. Always bumps scanned_at/expires_at.
     */
    async function upsertScan({
        scopeKey, cacheKey, userId, organizationId, mode, focus, integrationIds,
        suggestions, summary, reason, model, eu, expiresAt,
    }) {
        if (!scopeKey || !cacheKey) throw new Error('upsertScan requires scopeKey and cacheKey');
        const id = `${scopeKey}:${cacheKey}`;
        const integrationIdsStr = Array.isArray(integrationIds)
            ? integrationIds.join(',')
            : (integrationIds || null);
        return mapRow(await one(`
            INSERT INTO suggestion_scan_cache
                (id, scope_key, user_id, organization_id, cache_key, focus, integration_ids,
                 suggestions_json, summary_json, reason, model, eu, scanned_at, expires_at, mode)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, NOW(), $13, $14)
            ON CONFLICT (scope_key, cache_key) DO UPDATE SET
                id = EXCLUDED.id,
                user_id = EXCLUDED.user_id,
                organization_id = EXCLUDED.organization_id,
                focus = EXCLUDED.focus,
                integration_ids = EXCLUDED.integration_ids,
                suggestions_json = EXCLUDED.suggestions_json,
                summary_json = EXCLUDED.summary_json,
                reason = EXCLUDED.reason,
                model = EXCLUDED.model,
                eu = EXCLUDED.eu,
                mode = EXCLUDED.mode,
                scanned_at = NOW(),
                expires_at = EXCLUDED.expires_at
            RETURNING *
        `, [
            id,
            scopeKey,
            userId || null,
            organizationId || null,
            cacheKey,
            focus || null,
            integrationIdsStr,
            JSON.stringify(suggestions ?? []),
            summary == null ? null : JSON.stringify(summary),
            reason || null,
            model || null,
            eu == null ? null : !!eu,
            expiresAt,
            normaliseMode(mode),
        ]));
    }

    /** Drop every cached scan for a scope. Returns the number of rows removed. */
    async function invalidateForScope({ scopeKey }) {
        if (!scopeKey) return 0;
        const res = await q(`DELETE FROM suggestion_scan_cache WHERE scope_key = $1`, [scopeKey]);
        return res.rowCount || 0;
    }

    /**
     * Art. 17: every scan of this user, whatever scope it was written under
     * (a legacy `org:` row carries the scanning user in user_id).
     */
    async function purgeForUser(userId) {
        if (!userId) return 0;
        const res = await q(
            `DELETE FROM suggestion_scan_cache WHERE user_id = $1 OR scope_key = $2`,
            [String(userId), `user:${userId}`],
        );
        return res.rowCount || 0;
    }

    /**
     * Reap scans older than the retention window (by scanned_at). Idempotent.
     * NOT keyed on `expires_at` — that is only the re-compute window and must
     * not delete still-displayable results.
     */
    async function pruneExpired() {
        const res = await q(
            `DELETE FROM suggestion_scan_cache WHERE scanned_at < NOW() - ($1 || ' days')::interval`,
            [String(RETENTION_DAYS)],
        );
        return res.rowCount || 0;
    }

    return {
        getCachedScan,
        getLatestScan,
        removeSuggestionsFromScope,
        upsertScan,
        invalidateForScope,
        purgeForUser,
        pruneExpired,
    };
}

const initDB = makeStoreInit('SuggestionScanCache', async () => {
    await exec(DDL);
    log.info('[SuggestionScanCache] Initialized (PostgreSQL)');
});

const defaultStore = makeSuggestionScanCache({ query: (sql, params) => run(sql, params) }, { ready: initDB });

module.exports = {
    initDB,
    DDL,
    MODES,
    RETENTION_DAYS,
    deriveScopeKey,
    makeSuggestionScanCache,
    ...defaultStore,
};
