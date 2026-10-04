// @typecheck
/**
 * Guardrail Event Store — Tracks AI content moderation, PII detection, and regex guardrail events.
 * PostgreSQL-backed logging for the Usage & Monitoring dashboard.
 */

const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');
const log = require('../telemetry/log');

// Single-flight init with a warm-boot probe — see integrationActivityStore.js
// for the rationale. The probe targets the NEWEST schema object this init
// creates (currently the partial live index); bump it when adding DDL.
const initDB = makeStoreInit('GuardrailEventStore', _doInit);

async function _doInit() {
    // Probe the new partial index, the LAST index in the create ladder, AND
    // the absence of the retired idx_guardrail_org: with only the mid-sequence
    // check, a transient failure after that index was created made every retry
    // early-return and permanently skip the remaining DDL (incl. the DROP).
    const probe = await getOne(`
        SELECT
            (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_guardrail_org_ts_live') AS live,
            (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_guardrail_type') AS last,
            (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_guardrail_org') AS retired
    `).catch(() => null);
    if (probe && probe.live && probe.last && !probe.retired) return;

    await exec(`
        CREATE TABLE IF NOT EXISTS guardrail_events (
            id SERIAL PRIMARY KEY,
            timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            organization_id TEXT,
            user_id TEXT,
            agent_id TEXT,
            agent_name TEXT,
            conversation_id TEXT,
            violation_type TEXT NOT NULL,
            violation_categories TEXT,
            direction TEXT DEFAULT 'input',
            action_taken TEXT DEFAULT 'blocked',
            source TEXT DEFAULT 'unknown',
            model TEXT,
            attachment_filename TEXT,
            attachment_page INT
        )
    `);
    // One consolidated, idempotent column ladder. NOT NULL is intentionally
    // not enforced on attachment_*; message-path rows leave them NULL.
    await exec(`
        ALTER TABLE guardrail_events
            ADD COLUMN IF NOT EXISTS attachment_filename TEXT,
            ADD COLUMN IF NOT EXISTS attachment_page INT,
            -- Automation attribution — join a decision to a run/step.
            ADD COLUMN IF NOT EXISTS automation_id TEXT,
            ADD COLUMN IF NOT EXISTS run_id TEXT,
            ADD COLUMN IF NOT EXISTS step_id TEXT,
            ADD COLUMN IF NOT EXISTS is_dry_run BOOLEAN DEFAULT false
    `);
    // Via runDdl (stores/lib/_ddl.js): fouten per statement luid verzameld;
    // de Promise.all werd tóch al geserialiseerd door de DDL-queue. NB
    // (runbookregel in _ddl.js): guardrail_events is een volumetabel zonder
    // retentie — nieuwe indexen alleen handmatig via CONCURRENTLY.
    await runDdl('guardrailEventStore', [
        `CREATE INDEX IF NOT EXISTS idx_guardrail_timestamp ON guardrail_events(timestamp DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_guardrail_org_timestamp ON guardrail_events(organization_id, timestamp DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_guardrail_org_ts_live ON guardrail_events(organization_id, timestamp DESC) WHERE is_dry_run = false`,
        `CREATE INDEX IF NOT EXISTS idx_guardrail_user ON guardrail_events(user_id)`,
        `CREATE INDEX IF NOT EXISTS idx_guardrail_type ON guardrail_events(violation_type)`,
        // Fully covered by the org+timestamp composite.
        `DROP INDEX IF EXISTS idx_guardrail_org`,
    ]);
}

log.info('[GuardrailEventStore] Initialized (PostgreSQL)');

// ============ Logging ============

async function logGuardrailEvent(event) {
    await initDB();
    try {
        await run(`
            INSERT INTO guardrail_events (timestamp, organization_id, user_id, agent_id, agent_name, conversation_id, violation_type, violation_categories, direction, action_taken, source, model, attachment_filename, attachment_page, automation_id, run_id, step_id, is_dry_run)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        `, [
            event.timestamp || new Date().toISOString(),
            event.organization_id || null,
            event.user_id || null,
            event.agent_id || null,
            event.agent_name || null,
            event.conversation_id || null,
            event.violation_type || 'unknown',
            event.violation_categories || null,
            event.direction || 'input',
            event.action_taken || 'blocked',
            event.source || 'unknown',
            event.model || null,
            event.attachment_filename || null,
            typeof event.attachment_page === 'number' ? event.attachment_page : null,
            event.automation_id || null,
            event.run_id || null,
            event.step_id || null,
            event.is_dry_run || false,
        ]);
        log.info(`[GuardrailEventStore] Logged ${event.violation_type} event (${event.action_taken}) for user ${event.user_id || 'unknown'}`);
    } catch (e) {
        log.error('[GuardrailEventStore] Failed to log event:', e.message);
    }
}

/**
 * Convenience helper: emit one guardrail row per (page, category) for an
 * attachment scan result. Message-path callers should stick with
 * `logGuardrailEvent` / `logDlpDecision` and leave the attachment_* fields null.
 */
async function logAttachmentPiiFindings({ summary, auditBase, action_taken }) {
    if (!summary || !summary.filename) return;
    const pages = summary.pages || {};
    const pageNumbers = Object.keys(pages);
    if (pageNumbers.length === 0) {
        // Non-paginated source (Office, txt) — emit one aggregate row.
        const categories = Object.keys(summary.byCategory || {}).join(', ') || null;
        if (!categories) return;
        await logGuardrailEvent({
            ...auditBase,
            violation_type: 'pii',
            violation_categories: categories,
            direction: 'input',
            action_taken: action_taken || 'redacted',
            attachment_filename: summary.filename,
            attachment_page: null,
        });
        return;
    }
    for (const pageStr of pageNumbers) {
        const page = parseInt(pageStr, 10);
        const byCat = pages[pageStr] || {};
        const categories = Object.keys(byCat).join(', ');
        if (!categories) continue;
        await logGuardrailEvent({
            ...auditBase,
            violation_type: 'pii',
            violation_categories: categories,
            direction: 'input',
            action_taken: action_taken || 'redacted',
            attachment_filename: summary.filename,
            attachment_page: page,
        });
    }
}

/**
 * Audit an INCOMPLETE attachment scan (page-cap overflow / deadline timeout /
 * degraded detector) even when no PII categories were found — the case
 * logAttachmentPiiFindings early-returns on. Records WHY the scan was
 * incomplete and what we did (passed unredacted vs held), so admins can see
 * (and measure) large-input pass-throughs before flipping any org to
 * fail_closed. `reason` ∈ {overflow, timeout, degraded}.
 */
async function logAttachmentScanIncomplete({ auditBase, filename, reason, scannedPages, totalPages, action_taken }) {
    if (!filename || !reason) return;
    const pageNote = (Number.isFinite(scannedPages) && Number.isFinite(totalPages))
        ? ` (${scannedPages}/${totalPages} pages)` : '';
    await logGuardrailEvent({
        ...auditBase,
        violation_type: 'pii',
        // Prefixed so it survives the "no categories → skip" guards downstream
        // and is filterable in the audit UI.
        violation_categories: `scan_${reason}`,
        direction: 'input',
        action_taken: action_taken || 'passed_unredacted',
        attachment_filename: `${filename}${pageNote}`,
        attachment_page: null,
    });
}

// ============ Queries ============

function buildFilters(filters, startIdx = 1) {
    const conditions = [];
    const params = [];
    let idx = startIdx;
    if (filters?.startDate) {
        conditions.push(`timestamp >= $${idx++}`);
        params.push(filters.startDate);
    }
    if (filters?.endDate) {
        conditions.push(`timestamp <= $${idx++}`);
        params.push(filters.endDate);
    }
    if (filters?.organizationId) {
        conditions.push(`organization_id = $${idx++}`);
        params.push(filters.organizationId);
    }
    if (filters?.userId) {
        conditions.push(`user_id = $${idx++}`);
        params.push(filters.userId);
    }
    if (filters?.violationType) {
        conditions.push(`violation_type = $${idx++}`);
        params.push(filters.violationType);
    }
    // Dashboards exclude dry-run automation rows (compliance checks always did).
    if (filters?.excludeDryRun) conditions.push(`is_dry_run = false`);
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    return { where, params, nextIdx: idx };
}

// Audit markers that travel in violation_categories but are not kinds of
// personal data (mirrors MARKERS in the Shield's activityLabels.js).
const AUDIT_MARKERS_SQL = ['privacy_protection_unavailable', 'scan_timeout', 'scan_overflow', 'scan_degraded', 'token_evicted', 'scan_failed']
    .map(m => `'${m}'`).join(', ');

async function getGuardrailSummary(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getOne(`
        SELECT
            COUNT(*) as total_events,
            COUNT(*) FILTER (WHERE violation_type = 'moderation') as moderation_count,
            COUNT(*) FILTER (WHERE violation_type = 'pii') as pii_count,
            -- Events whose categories column names a FIND: the population the
            -- Shield's "personal data found" counts its kinds over. Not the
            -- configuration audit, not notes (hidden-character clean-up, the
            -- placeholder store) and not a check that could not run, whose
            -- column holds a marker. A row whose only categories are audit
            -- markers (e.g. token_evicted) names no find either.
            COUNT(*) FILTER (WHERE EXISTS (
                    SELECT 1 FROM unnest(string_to_array(COALESCE(violation_categories, ''), ',')) AS c
                    WHERE trim(c) <> '' AND trim(c) NOT IN (${AUDIT_MARKERS_SQL}))
                AND COALESCE(violation_type, '') NOT IN ('admin_action', 'user_action', 'unicode_smuggling', 'pii_tokenmap', 'scan_failed', 'pii_unavailable')
                AND action_taken IS DISTINCT FROM 'scan_failed') as pii_messages,
            COUNT(*) FILTER (WHERE violation_type = 'regex') as regex_count,
            COUNT(*) FILTER (WHERE violation_type = 'dlp_decision') as dlp_count,
            COUNT(*) FILTER (WHERE violation_type = 'dlp_decision' AND action_taken = 'allowed') as dlp_allowed,
            COUNT(*) FILTER (WHERE violation_type = 'dlp_decision' AND action_taken = 'redacted') as dlp_redacted,
            COUNT(*) FILTER (WHERE violation_type = 'dlp_decision' AND action_taken = 'blocked') as dlp_blocked,
            COUNT(*) FILTER (WHERE direction = 'input') as input_count,
            COUNT(*) FILTER (WHERE direction = 'output') as output_count,
            COUNT(DISTINCT user_id) as unique_users
        FROM guardrail_events ${where}
    `, params);
}

// ─── DLP-specific logger ───────────────────────────────────────────
// `violation_type: 'dlp_decision'` events are emitted when a prompt goes
// through pre-flight DLP scanning. `action_taken` is one of:
//   'allowed'  — no findings or user explicitly allowed raw text
//   'redacted' — tokenised before sending to the LLM
//   'blocked'  — user or policy blocked the prompt
//   'scan_failed' — PII service error (paired with fail-open/closed policy)
async function logDlpDecision(event) {
    return logGuardrailEvent({
        ...event,
        violation_type: 'dlp_decision',
        direction: 'outbound',
    });
}

async function getGuardrailTimeline(filters = {}, interval = 'day') {
    await initDB();
    const { where, params } = buildFilters(filters);
    const groupExpr = interval === 'hour'
        ? "to_char(date_trunc('hour', timestamp), 'YYYY-MM-DD HH24:00')"
        : "to_char(date_trunc('day', timestamp), 'YYYY-MM-DD')";
    return getAll(`
        SELECT
            ${groupExpr} as period,
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE violation_type = 'moderation') as moderation,
            COUNT(*) FILTER (WHERE violation_type = 'pii') as pii,
            COUNT(*) FILTER (WHERE violation_type = 'regex') as regex
        FROM guardrail_events ${where}
        GROUP BY period
        ORDER BY period ASC
    `, params);
}

async function getGuardrailByUser(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getAll(`
        SELECT
            user_id,
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE violation_type = 'moderation') as moderation,
            COUNT(*) FILTER (WHERE violation_type = 'pii') as pii,
            COUNT(*) FILTER (WHERE violation_type = 'regex') as regex,
            MAX(timestamp) as last_event
        FROM guardrail_events ${where}
        GROUP BY user_id
        ORDER BY total DESC
    `, params);
}

async function getGuardrailByCategory(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    // Split comma-separated categories and count each. Split on ',' + trim,
    // NOT on ', ': producers historically joined with ', ' but the canonical
    // encoding is a bare comma — splitting on ', ' silently glued canonical
    // rows into one giant "category".
    const baseWhere = where ? `${where} AND` : 'WHERE';
    return getAll(`
        SELECT
            trim(cat) as category,
            COUNT(*) as count,
            violation_type
        FROM guardrail_events,
             unnest(string_to_array(violation_categories, ',')) AS cat
        ${baseWhere}
            violation_categories IS NOT NULL
            AND violation_categories != ''
            AND trim(cat) != ''
        GROUP BY trim(cat), violation_type
        ORDER BY count DESC
    `, params);
}

async function getRecentGuardrailEvents(limit = 50, filters = {}) {
    await initDB();
    // Built on the shared buildFilters ON PURPOSE — the hand-rolled WHERE here
    // ignored filters.userId, which is the ONLY scope a consumer (org-less)
    // account has. See getRecentIntegrationActivity for the full story.
    const { where, params, nextIdx } = buildFilters(filters);
    let idx = nextIdx;
    const conditions = [];
    // Keyset pagination — id DESC and timestamp DESC agree (SERIAL).
    if (Number.isFinite(filters?.beforeId)) { conditions.push(`id < $${idx++}`); params.push(filters.beforeId); }
    // Default 30-day guard
    if (!filters?.startDate && !filters?.endDate) {
        conditions.push(`timestamp >= NOW() - INTERVAL '30 days'`);
    }
    const extra = conditions.length ? `${where ? where + ' AND' : 'WHERE'} ${conditions.join(' AND ')}` : where;
    return getAll(`
        SELECT
            id, timestamp, organization_id, user_id, agent_id, agent_name,
            conversation_id, violation_type, violation_categories, direction,
            action_taken, source, model, attachment_filename, attachment_page,
            automation_id, run_id, step_id, is_dry_run
        FROM guardrail_events
        ${extra}
        ORDER BY id DESC
        LIMIT $${idx}
    `, [...params, Math.max(1, Math.min(Number(limit) || 50, 200))]);
}

async function getGuardrailByAction(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getAll(`
        SELECT
            action_taken,
            violation_type,
            COUNT(*) as count
        FROM guardrail_events ${where}
        GROUP BY action_taken, violation_type
        ORDER BY count DESC
    `, params);
}

/**
 * Everything the redesigned Activity dashboard needs from the guardrail
 * ledger, in one response — replaces six separate endpoint round-trips.
 */
async function getGuardrailOverview(filters = {}, interval = 'day') {
    await initDB();
    const { where, params } = buildFilters(filters);
    const and = where ? `${where} AND` : 'WHERE';
    const groupExpr = interval === 'hour'
        ? "to_char(date_trunc('hour', timestamp), 'YYYY-MM-DD HH24:00')"
        : "to_char(date_trunc('day', timestamp), 'YYYY-MM-DD')";

    const [summary, timeline, topCategories, byAction, topUsers, bySurface, health] = await Promise.all([
        getGuardrailSummary(filters),
        getAll(`
            SELECT
                ${groupExpr} AS period,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE violation_type = 'moderation') AS moderation,
                COUNT(*) FILTER (WHERE violation_type = 'pii') AS pii,
                COUNT(*) FILTER (WHERE violation_type = 'regex') AS regex,
                COUNT(*) FILTER (WHERE violation_type = 'dlp_decision') AS dlp
            FROM guardrail_events ${where}
            GROUP BY period ORDER BY period ASC
        `, params),
        getAll(`
            SELECT trim(cat) AS category, violation_type, COUNT(*) AS count
            FROM guardrail_events,
                 unnest(string_to_array(violation_categories, ',')) AS cat
            ${and} violation_categories IS NOT NULL AND violation_categories != '' AND trim(cat) != ''
            GROUP BY trim(cat), violation_type ORDER BY count DESC LIMIT 10
        `, params),
        getGuardrailByAction(filters),
        getAll(`
            SELECT
                user_id,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE violation_type = 'moderation') AS moderation,
                COUNT(*) FILTER (WHERE violation_type = 'pii') AS pii,
                COUNT(*) FILTER (WHERE violation_type = 'regex') AS regex,
                MAX(timestamp) AS last_event
            FROM guardrail_events ${and} user_id IS NOT NULL
            GROUP BY user_id ORDER BY total DESC LIMIT 10
        `, params),
        // Which SURFACE produced the events — "was this chat, an agent, or a
        // automation?". Classified structurally (attribution columns beat the
        // free-text source values, which drifted across eras).
        getAll(`
            SELECT
                CASE WHEN automation_id IS NOT NULL THEN 'automation'
                     WHEN agent_id IS NOT NULL THEN 'agent'
                     WHEN source ILIKE 'notebook%' THEN 'notebook'
                     ELSE 'direct' END AS surface,
                COUNT(*) AS count
            FROM guardrail_events ${where}
            GROUP BY 1 ORDER BY count DESC
        `, params),
        getOne(`SELECT MAX(timestamp) AS last_event_at FROM guardrail_events ${where}`, params),
    ]);

    return {
        summary,
        timeline,
        top_categories: topCategories,
        by_action: byAction,
        top_users: topUsers,
        by_surface: bySurface,
        health: { last_event_at: health?.last_event_at || null },
    };
}

module.exports = {
    logGuardrailEvent,
    logDlpDecision,
    getGuardrailOverview,
    buildFilters, // exported for tests (excludeDryRun / userId contract)
    logAttachmentPiiFindings,
    logAttachmentScanIncomplete,
    getGuardrailSummary,
    getGuardrailTimeline,
    getGuardrailByUser,
    getGuardrailByCategory,
    getGuardrailByAction,
    getRecentGuardrailEvents,
};

// Awaitbare init-ingang voor migrateDb.
module.exports.initDB = initDB;
