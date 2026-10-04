// @typecheck
/**
 * Suggestion Feedback Store — records what the user did with a Automations
 * "Find repeating work" suggestion so the next scan can suppress or re-rank it.
 *
 * Actions and their lifetime:
 *   - `dismissed` / `snoozed` → expire after ttlDays (default 30): hidden for
 *     now, may resurface if the work keeps recurring.
 *   - `opened`  → expires after 30 days; a click, never a suppression. It never
 *     overwrites a permanent `built`/`asked` row.
 *   - `built` / `asked` → permanent (expires_at NULL): don't nag about work the
 *     user already turned into an automation / asked the assistant about.
 *
 * Keys. A pattern suggestion carries a `signature` (patterns/suppress.js:
 * stable across LLM wording) and is keyed by it; an ideas-mode suggestion has
 * none and falls back to the title fingerprint. Either way the row id is
 * `user:<id>:<key>`, so repeated feedback updates one row in place.
 *
 * PRIVACY:
 *   - The scope is ALWAYS the user (`user:<id>`). One person's dismissal must
 *     not hide a pattern for their colleagues, and the row is theirs to erase
 *     (Art. 17: purgeForUser, called from stores/user/users.deleteUser).
 *   - `suggestion_json` keeps an explicit ALLOW-LIST of template-safe fields
 *     (title, kind, signature, apps, template). Never copy the incoming object:
 *     a buildPrompt or evidence field added next year would leak along. The
 *     values come from the client, so the template is masked again and the
 *     title loses any address, link or host before either is stored.
 */

const { run, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');

const VALID_ACTIONS = ['dismissed', 'built', 'asked', 'snoozed', 'opened'];
const VALID_REASON_CODES = ['wrong_grouping', 'do_myself', 'already_automated', 'privacy'];
const DEFAULT_TTL_DAYS = 30;
/** Actions whose row lapses after a TTL; the rest are permanent. */
const EXPIRING_ACTIONS = ['dismissed', 'snoozed', 'opened'];
/** Rows a later `opened` must not downgrade. */
const STICKY_ACTIONS = ['built', 'asked'];

const DDL = `
    CREATE TABLE IF NOT EXISTS automation_suggestion_feedback (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        organization_id TEXT,
        title_fingerprint TEXT NOT NULL,
        title TEXT,
        action TEXT,
        reason TEXT,
        suggestion_json JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sug_fb_org_user_created ON automation_suggestion_feedback(organization_id, user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sug_fb_fingerprint ON automation_suggestion_feedback(title_fingerprint);
    ALTER TABLE automation_suggestion_feedback
        ADD COLUMN IF NOT EXISTS signature TEXT,
        ADD COLUMN IF NOT EXISTS reason_code TEXT,
        ADD COLUMN IF NOT EXISTS snooze_until TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_sug_fb_user_signature ON automation_suggestion_feedback(user_id, signature);
`;

// ============ Helpers ============

/**
 * The scope prefix of a feedback row: always the user. `organizationId` is
 * accepted for call-site compatibility and deliberately ignored.
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

const clip = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// The incoming suggestion is the CLIENT's echo, so "template-safe" is decided
// here, not trusted: the template is masked again (addresses, links, hosts,
// numbers, dates, ids) and the title loses any address, link or host. Pure
// functions, no I/O.
const lazyTemplating = () => require('../automation/patterns/templating');
const safeTemplate = (v) => clip(typeof v === 'string' ? lazyTemplating().maskText(v) : null, 500);
const safeTitle = (v) => clip(typeof v === 'string' ? lazyTemplating().maskContacts(v, { words: true }) : null, 200);

/**
 * The template-safe subset of a suggestion, built from an explicit allow-list.
 * Pattern fields may sit on the suggestion itself or under `pattern`.
 * Returns null when nothing survives.
 * @param {any} suggestion
 */
function toStoredSuggestion(suggestion) {
    if (!suggestion || typeof suggestion !== 'object') return null;
    const p = suggestion.pattern && typeof suggestion.pattern === 'object' ? suggestion.pattern : {};
    const appsRaw = Array.isArray(suggestion.apps) ? suggestion.apps : (Array.isArray(p.apps) ? p.apps : []);
    const apps = appsRaw.map(a => clip(a, 64)).filter(Boolean).slice(0, 10);
    const out = {
        title: safeTitle(suggestion.title),
        kind: clip(suggestion.kind ?? p.kind, 40),
        signature: clip(suggestion.signature ?? p.signature, 128),
        apps: apps.length ? apps : null,
        template: safeTemplate(suggestion.template ?? p.template),
    };
    const kept = Object.fromEntries(Object.entries(out).filter(([, v]) => v != null));
    return Object.keys(kept).length ? kept : null;
}

function mapRow(r) {
    if (!r) return null;
    return {
        id: r.id,
        userId: r.user_id || null,
        organizationId: r.organization_id || null,
        titleFingerprint: r.title_fingerprint,
        signature: r.signature || null,
        title: r.title || null,
        action: r.action || null,
        reason: r.reason || null,
        reasonCode: r.reason_code || null,
        suggestion: safeJson(r.suggestion_json, null),
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
        snoozeUntil: r.snooze_until ? new Date(r.snooze_until).toISOString() : null,
    };
}

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{rows: any[], rowCount?: number}> }} db
 * @param {{ ready?: () => Promise<unknown> }} [opts]
 */
function makeSuggestionFeedbackStore(db, { ready = async () => {} } = {}) {
    const q = async (sql, params) => { await ready(); return db.query(sql, params); };

    /**
     * Record (or update) feedback for a suggestion. Keyed by `signature` when
     * given, else by `titleFingerprint`; one of the two is required.
     */
    async function saveSuggestionFeedback({
        userId, organizationId, action, reason, reasonCode, signature, suggestion, titleFingerprint, ttlDays,
    }) {
        const sig = clip(signature, 128);
        if (!titleFingerprint && !sig) throw new Error('saveSuggestionFeedback requires a signature or titleFingerprint');
        if (!VALID_ACTIONS.includes(action)) {
            throw new Error(`Invalid suggestion feedback action: ${action}. Expected one of ${VALID_ACTIONS.join(', ')}`);
        }
        if (reasonCode != null && !VALID_REASON_CODES.includes(reasonCode)) {
            throw new Error(`Invalid suggestion feedback reason code: ${reasonCode}. Expected one of ${VALID_REASON_CODES.join(', ')}`);
        }

        const scopeKey = deriveScopeKey({ userId });
        const key = sig ? `sig:${sig}` : String(titleFingerprint);
        const stored = toStoredSuggestion(suggestion);

        const params = [
            `${scopeKey}:${key}`,
            userId || null,
            organizationId || null,
            titleFingerprint || key,
            stored?.title || null,
            action,
            reason || null,
            stored == null ? null : JSON.stringify(stored),
            sig,
            reasonCode || null,
        ];

        let expiresExpr = 'NULL';
        if (EXPIRING_ACTIONS.includes(action)) {
            const ttl = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : DEFAULT_TTL_DAYS;
            params.push(String(ttl));
            expiresExpr = `NOW() + ($${params.length} || ' days')::interval`;
        }
        const snoozeExpr = action === 'snoozed' ? expiresExpr : 'NULL';
        params.push(STICKY_ACTIONS);
        const sticky = `$${params.length}::text[]`;
        // An `opened` click on a built/asked row keeps that row as it was.
        const keep = `(EXCLUDED.action = 'opened' AND automation_suggestion_feedback.action = ANY(${sticky}))`;

        const { rows } = await q(`
            INSERT INTO automation_suggestion_feedback
                (id, user_id, organization_id, title_fingerprint, title, action, reason,
                 suggestion_json, signature, reason_code, created_at, expires_at, snooze_until)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, NOW(), ${expiresExpr}, ${snoozeExpr})
            ON CONFLICT (id) DO UPDATE SET
                user_id = EXCLUDED.user_id,
                organization_id = EXCLUDED.organization_id,
                title = COALESCE(EXCLUDED.title, automation_suggestion_feedback.title),
                suggestion_json = COALESCE(EXCLUDED.suggestion_json, automation_suggestion_feedback.suggestion_json),
                signature = COALESCE(EXCLUDED.signature, automation_suggestion_feedback.signature),
                action = CASE WHEN ${keep} THEN automation_suggestion_feedback.action ELSE EXCLUDED.action END,
                reason = CASE WHEN ${keep} THEN automation_suggestion_feedback.reason ELSE EXCLUDED.reason END,
                reason_code = CASE WHEN ${keep} THEN automation_suggestion_feedback.reason_code ELSE EXCLUDED.reason_code END,
                expires_at = CASE WHEN ${keep} THEN automation_suggestion_feedback.expires_at ELSE EXCLUDED.expires_at END,
                snooze_until = CASE WHEN ${keep} THEN automation_suggestion_feedback.snooze_until ELSE EXCLUDED.snooze_until END
            RETURNING *
        `, params);
        return mapRow(rows[0]);
    }

    /**
     * Titles the ideas-mode scan should suppress for this user: every
     * non-expired row except `opened` clicks. Flat string[].
     * @param {{ userId?: string|null, organizationId?: string|null }} [opts]
     */
    async function getRecentSuppressedTitles({ userId } = {}) {
        if (!userId) return [];
        const { rows } = await q(`
            SELECT title FROM automation_suggestion_feedback
            WHERE user_id = $1
              AND action <> 'opened'
              AND title IS NOT NULL
              AND title != ''
              AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY created_at DESC
        `, [String(userId)]);
        return rows.map(r => r.title).filter(Boolean);
    }

    /**
     * Pattern signatures the user gave live feedback on, for patterns/suppress.js
     * to decide (suppress, or down-weight `wrong_grouping`). `opened` clicks
     * and lapsed rows are left out.
     * @param {{ userId?: string|null }} [opts]
     * @returns {Promise<Array<{signature: string, action: string, reasonCode: string|null}>>}
     */
    async function getSuppressedSignatures({ userId } = {}) {
        if (!userId) return [];
        const { rows } = await q(`
            SELECT signature, action, reason_code FROM automation_suggestion_feedback
            WHERE user_id = $1
              AND signature IS NOT NULL
              AND action <> 'opened'
              AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY created_at DESC
        `, [String(userId)]);
        return rows.map(r => ({ signature: r.signature, action: r.action, reasonCode: r.reason_code || null }));
    }

    /** Art. 17: every feedback row of this user. */
    async function purgeForUser(userId) {
        if (!userId) return 0;
        const res = await q(`DELETE FROM automation_suggestion_feedback WHERE user_id = $1`, [String(userId)]);
        return res.rowCount || 0;
    }

    /**
     * Reap lapsed rows (dismissed/snoozed/opened past their TTL) so a
     * suggestion can resurface. Permanent rows (expires_at NULL) stay.
     */
    async function pruneExpired() {
        const res = await q(`DELETE FROM automation_suggestion_feedback WHERE expires_at IS NOT NULL AND expires_at <= NOW()`);
        return res.rowCount || 0;
    }

    return { saveSuggestionFeedback, getRecentSuppressedTitles, getSuppressedSignatures, purgeForUser, pruneExpired };
}

const initDB = makeStoreInit('SuggestionFeedbackStore', async () => {
    await exec(DDL);
    log.info('[SuggestionFeedbackStore] Initialized (PostgreSQL)');
});

const defaultStore = makeSuggestionFeedbackStore({ query: (sql, params) => run(sql, params) }, { ready: initDB });

module.exports = {
    initDB,
    DDL,
    deriveScopeKey,
    VALID_ACTIONS,
    VALID_REASON_CODES,
    toStoredSuggestion,
    makeSuggestionFeedbackStore,
    ...defaultStore,
};
