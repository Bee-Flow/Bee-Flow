// @typecheck
/**
 * Org Health Store — DB-backed capture layer for per-organization
 * Nextcloud-connector / chat health ("NC orgs with 0 AI messages" diagnosis).
 *
 * Three tables (CREATE TABLE IF NOT EXISTS in a memoized initDB(), same
 * convention as supportStore/usageStore — no separate migration file):
 *
 *   org_health_problems — deduplicating CURRENT-PROBLEMS rollup.
 *       UNIQUE(subject_key, code): a broken org retrying every 30s bumps
 *       count/last_seen_at instead of exploding rows. Reopen detection via
 *       the Postgres-specific (xmax = 0) trick + a prev-CTE that snapshots
 *       resolved_at before the upsert. This store is Postgres-only.
 *   org_health_events   — append-only timeline (state transitions, lifecycle
 *       codes, throttled recurrences), keyset-paginated on (created_at, id)
 *       exactly like supportStore.listAuditEvents.
 *   org_health_liveness — last-seen markers per org (auth ok / bootstrap /
 *       connector status report) + connector version.
 *
 * subject_key = organization id, or 'nc:<instanceId>' (pre-org bootstrap
 * refusals), or 'domain:<mailDomain>' (unattributable tenant-key 401s), or
 * 'unknown' — so failures BEFORE an org exists stay capturable and dedupable.
 *
 * PRIVACY: rows are metadata-only. All writes should go through the
 * never-throws emitter (server/services/orgHealth.js) which sanitizes meta —
 * never prompts, message content, secrets or tenant keys.
 */

const { run, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS org_health_problems (
    id SERIAL PRIMARY KEY,
    subject_key TEXT NOT NULL,
    organization_id TEXT,
    code TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info','warning','error','critical')),
    source TEXT NOT NULL,
    message TEXT,
    remediation TEXT,
    meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    count INTEGER NOT NULL DEFAULT 1,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    resolved_by TEXT,
    UNIQUE (subject_key, code)
);
CREATE INDEX IF NOT EXISTS idx_ohp_org  ON org_health_problems(organization_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_ohp_open ON org_health_problems(severity, last_seen_at DESC) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS org_health_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_key TEXT NOT NULL,
    organization_id TEXT,
    code TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    actor_kind TEXT NOT NULL DEFAULT 'system' CHECK (actor_kind IN ('system','connector','user','admin')),
    actor_user_id TEXT,
    message TEXT,
    meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ohe_org_created ON org_health_events(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ohe_code ON org_health_events(code);
CREATE INDEX IF NOT EXISTS idx_ohe_created ON org_health_events(created_at);

CREATE TABLE IF NOT EXISTS org_health_liveness (
    organization_id TEXT PRIMARY KEY,
    last_auth_ok_at TIMESTAMPTZ,
    last_bootstrap_at TIMESTAMPTZ,
    last_status_report_at TIMESTAMPTZ,
    connector_version TEXT
);
`;

const initDB = makeStoreInit('OrgHealthStore', async () => {
    await exec(INIT_SQL);
    log.info('[OrgHealthStore] PostgreSQL initialized');
});

// ── Row mapping (snake_case DB → camelCase API, matching the pinned admin
// connector-health contract so routes can pass rows through unchanged) ─────

function _mapProblemRow(r) {
    return {
        id: r.id,
        subjectKey: r.subject_key,
        organizationId: r.organization_id || null,
        code: r.code,
        category: r.category,
        severity: r.severity,
        source: r.source,
        message: r.message || null,
        remediation: r.remediation || null,
        meta: r.meta || {},
        count: Number(r.count) || 0,
        firstSeenAt: r.first_seen_at || null,
        lastSeenAt: r.last_seen_at || null,
        resolvedAt: r.resolved_at || null,
        resolvedBy: r.resolved_by || null,
    };
}

function _mapEventRow(r) {
    return {
        id: r.id,
        subjectKey: r.subject_key,
        organizationId: r.organization_id || null,
        code: r.code,
        category: r.category,
        severity: r.severity,
        actorKind: r.actor_kind,
        actorUserId: r.actor_user_id || null,
        message: r.message || null,
        meta: r.meta || {},
        ip: r.ip || null,
        createdAt: r.created_at || null,
    };
}

// ── Problems rollup ────────────────────────────────────────────────────────

const SEVERITIES = ['info', 'warning', 'error', 'critical'];
const EVENT_ACTOR_KINDS = ['system', 'connector', 'user', 'admin'];

/**
 * Dedup upsert on (subject_key, code). Single statement:
 *  - the `prev` CTE snapshots resolved_at BEFORE the write (statement-start
 *    snapshot) so we can detect a reopen;
 *  - (xmax = 0) is true only for a freshly inserted row (Postgres-specific).
 * Returns { inserted, reopened, count } so the emitter can decide whether the
 * timeline gets an event (state transition) or not (pure recurrence).
 */
async function upsertProblem({ subjectKey, organizationId = null, code, category, severity, source = 'unknown', message = null, remediation = null, meta = {} }) {
    await initDB();
    if (!subjectKey || !code || !category) return null;
    const sev = SEVERITIES.includes(severity) ? severity : 'warning';
    const { rows } = await run(
        `WITH prev AS (
            SELECT resolved_at FROM org_health_problems WHERE subject_key = $1 AND code = $3
         )
         INSERT INTO org_health_problems
            (subject_key, organization_id, code, category, severity, source, message, remediation, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT (subject_key, code) DO UPDATE SET
            count = org_health_problems.count + 1,
            last_seen_at = now(),
            severity = EXCLUDED.severity,
            message = EXCLUDED.message,
            remediation = EXCLUDED.remediation,
            meta = EXCLUDED.meta,
            source = EXCLUDED.source,
            organization_id = COALESCE(EXCLUDED.organization_id, org_health_problems.organization_id),
            resolved_at = NULL,
            resolved_by = NULL
         RETURNING (xmax = 0) AS inserted, count, (SELECT resolved_at FROM prev) AS prev_resolved_at`,
        [subjectKey, organizationId, code, category, sev, source, message, remediation, JSON.stringify(meta || {})]
    );
    const row = rows && rows[0];
    if (!row) return null;
    const inserted = row.inserted === true;
    return {
        inserted,
        reopened: !inserted && row.prev_resolved_at != null,
        count: Number(row.count) || 1,
    };
}

/**
 * Mark open problems resolved. `subjectKeyOrOrgId` matches either the
 * organization id column OR the subject_key (so 'nc:<id>' buckets resolve too).
 * Returns the number of rows actually flipped — callers append a timeline
 * event only when > 0.
 */
async function resolveProblems(subjectKeyOrOrgId, codes = [], resolvedBy = 'system') {
    await initDB();
    const list = (Array.isArray(codes) ? codes : [codes]).filter(Boolean);
    if (!subjectKeyOrOrgId || !list.length) return 0;
    const { rowCount } = await run(
        `UPDATE org_health_problems
            SET resolved_at = now(), resolved_by = $3
          WHERE (organization_id = $1 OR subject_key = $1)
            AND code = ANY($2::text[])
            AND resolved_at IS NULL`,
        [String(subjectKeyOrOrgId), list, resolvedBy || 'system']
    );
    return rowCount || 0;
}

// The org / subject / code filter both list queries share. Appends to `where`
// and `vals` in place, so a caller adds its own clauses after it.
function _pushSubjectFilter(where, vals, { organizationId = null, subjectKey = null, code = null }) {
    if (organizationId) {
        vals.push(String(organizationId));
        where.push(`(organization_id = $${vals.length} OR subject_key = $${vals.length})`);
    }
    if (subjectKey) { vals.push(String(subjectKey)); where.push(`subject_key = $${vals.length}`); }
    if (code) { vals.push(String(code)); where.push(`code = $${vals.length}`); }
}

async function listProblems({ organizationId = null, subjectKey = null, code = null, includeResolved = false, limit = 100 } = {}) {
    await initDB();
    const where = [];
    const vals = [];
    _pushSubjectFilter(where, vals, { organizationId, subjectKey, code });
    if (!includeResolved) where.push('resolved_at IS NULL');
    vals.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500));
    const rows = await getAll(
        `SELECT * FROM org_health_problems
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY (resolved_at IS NULL) DESC, last_seen_at DESC
         LIMIT $${vals.length}`,
        vals
    );
    return rows.map(_mapProblemRow);
}

// ── Events timeline (append-only, keyset-paginated) ────────────────────────

async function appendEvent({ subjectKey, organizationId = null, code, category, severity = 'info', actorKind = 'system', actorUserId = null, message = null, meta = {}, ip = null }) {
    await initDB();
    if (!subjectKey || !code || !category) return null;
    const kind = EVENT_ACTOR_KINDS.includes(actorKind) ? actorKind : 'system';
    const sev = SEVERITIES.includes(severity) ? severity : 'info';
    const { rows } = await run(
        `INSERT INTO org_health_events
            (subject_key, organization_id, code, category, severity, actor_kind, actor_user_id, message, meta, ip)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
         RETURNING id, created_at`,
        [subjectKey, organizationId, code, category, sev, kind, actorUserId, message, JSON.stringify(meta || {}), ip]
    );
    return rows && rows[0] ? rows[0] : null;
}

// Cursor pattern copied from supportStore._encodeAuditCursor/_decodeAuditCursor:
// opaque base64 of { t: created_at ISO, id: uuid }, keyset on
// (created_at, id) < (t, id) with ORDER BY created_at DESC, id DESC.
function _decodeCursor(cursor) {
    if (!cursor) return null;
    try {
        const obj = JSON.parse(Buffer.from(String(cursor), 'base64').toString('utf8'));
        if (obj && obj.t && obj.id) return obj;
    } catch { /* ignore malformed cursor */ }
    return null;
}
function _encodeCursor(row) {
    const t = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
    return Buffer.from(JSON.stringify({ t, id: row.id })).toString('base64');
}

/**
 * Newest-first keyset pagination. Returns { events, nextCursor } matching the
 * pinned GET /auth/admin/connector-health/:orgId/events contract.
 */
async function listEvents({ organizationId = null, subjectKey = null, code = null, severity = null, since = null, limit = 50, cursor = null } = {}) {
    await initDB();
    const where = [];
    const vals = [];
    _pushSubjectFilter(where, vals, { organizationId, subjectKey, code });
    if (severity) { vals.push(String(severity)); where.push(`severity = $${vals.length}`); }
    if (since) { vals.push(since); where.push(`created_at >= $${vals.length}`); }
    const cur = _decodeCursor(cursor);
    if (cur) {
        vals.push(cur.t); vals.push(cur.id);
        where.push(`(created_at, id) < ($${vals.length - 1}::timestamptz, $${vals.length}::uuid)`);
    }
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    vals.push(lim + 1);
    const rows = await getAll(
        `SELECT * FROM org_health_events
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY created_at DESC, id DESC
         LIMIT $${vals.length}`,
        vals
    );
    let nextCursor = null;
    if (rows.length > lim) {
        nextCursor = _encodeCursor(rows[lim - 1]);
        rows.length = lim;
    }
    return { events: rows.map(_mapEventRow), nextCursor };
}

// ── Liveness ───────────────────────────────────────────────────────────────

/**
 * Upsert last-seen markers. Pass whichever flags apply:
 *   touchLiveness(orgId, { authOk: true })
 *   touchLiveness(orgId, { statusReport: true, connectorVersion: '1.2.3' })
 * The emitter throttles calls (15 min in-memory) — this write is cheap but
 * must stay off the per-request hot path.
 */
async function touchLiveness(organizationId, { authOk = false, bootstrap = false, statusReport = false, connectorVersion = null } = {}) {
    await initDB();
    if (!organizationId) return;
    await run(
        `INSERT INTO org_health_liveness (organization_id, last_auth_ok_at, last_bootstrap_at, last_status_report_at, connector_version)
         VALUES ($1,
                 CASE WHEN $2::boolean THEN now() END,
                 CASE WHEN $3::boolean THEN now() END,
                 CASE WHEN $4::boolean THEN now() END,
                 $5)
         ON CONFLICT (organization_id) DO UPDATE SET
            last_auth_ok_at       = CASE WHEN $2::boolean THEN now() ELSE org_health_liveness.last_auth_ok_at END,
            last_bootstrap_at     = CASE WHEN $3::boolean THEN now() ELSE org_health_liveness.last_bootstrap_at END,
            last_status_report_at = CASE WHEN $4::boolean THEN now() ELSE org_health_liveness.last_status_report_at END,
            connector_version     = COALESCE($5, org_health_liveness.connector_version)`,
        [String(organizationId), !!authOk, !!bootstrap, !!statusReport, connectorVersion || null]
    );
}

// ── Health classification (pure — exported for tests and routes) ───────────

// Pinned health enum:
// 'ok'|'no_subscription'|'onboarding_pending'|'users_pending_approval'|
// 'tenant_key_mismatch'|'chat_failing'|'inactive'
const HEALTH_STATES = ['ok', 'no_subscription', 'onboarding_pending', 'users_pending_approval', 'tenant_key_mismatch', 'chat_failing', 'inactive'];

const TENANT_KEY_PROBLEM_CODES = ['connector.key_divergence', 'auth.no_matching_tenant_key'];

/**
 * Map a fleet row (camelCase, with `problems` = OPEN problems) to the pinned
 * health enum. Priority (first match wins):
 *   tenant_key_mismatch > no_subscription > onboarding_pending >
 *   users_pending_approval > chat_failing > inactive > ok
 * Pure function — no DB access.
 */
function computeHealth(org) {
    const problems = Array.isArray(org && org.problems) ? org.problems : [];
    const open = problems.filter(p => p && !p.resolvedAt);
    const codes = new Set(open.map(p => p.code));

    if (TENANT_KEY_PROBLEM_CODES.some(c => codes.has(c))) return 'tenant_key_mismatch';

    // hasActiveSubscription === false is authoritative; when the caller didn't
    // join subscriptions (e.g. the org-admin '/mine' subset) fall back to the
    // open subscription-block problems.
    if (org && org.hasActiveSubscription === false) return 'no_subscription';
    if ((!org || org.hasActiveSubscription == null)
        && (codes.has('chat.subscription_blocked') || codes.has('bootstrap.community_fallback'))) {
        return 'no_subscription';
    }

    if (org && org.ncInstanceId != null && org.ncOnboardingCompletedAt == null) return 'onboarding_pending';

    const users = (org && org.users) || {};
    if ((Number(users.pending) || 0) > 0 && (Number(users.active) || 0) === 0) return 'users_pending_approval';

    if (open.some(p => p.category === 'chat' && (p.severity === 'error' || p.severity === 'critical'))) {
        return 'chat_failing';
    }

    if ((Number(org && org.messagesTotal) || 0) === 0 && open.length === 0) return 'inactive';

    return 'ok';
}

// ── Fleet overview ─────────────────────────────────────────────────────────

function _mapFleetRow(r) {
    const org = {
        id: r.id,
        name: r.name,
        ncBaseUrl: r.nc_base_url || null,
        ncInstanceId: r.nc_instance_id || null,
        ncProvisionedAt: r.nc_provisioned_at || null,
        ncLastSyncAt: r.nc_last_sync_at || null,
        ncOnboardingCompletedAt: r.nc_onboarding_completed_at || null,
        hasActiveSubscription: r.has_active_subscription === true,
        users: {
            total: Number(r.total_users) || 0,
            active: Number(r.active_users) || 0,
            pending: Number(r.pending_users) || 0,
        },
        messagesTotal: Number(r.messages_total) || 0,
        messages30d: Number(r.messages_30d) || 0,
        lastMessageAt: r.last_message_at || null,
        liveness: {
            lastAuthOkAt: r.last_auth_ok_at || null,
            lastBootstrapAt: r.last_bootstrap_at || null,
            lastStatusReportAt: r.last_status_report_at || null,
            connectorVersion: r.connector_version || null,
        },
        problems: Array.isArray(r.problems) ? r.problems : [],
    };
    org.health = computeHealth(org);
    return org;
}

/**
 * Super-admin fleet view: one aggregate query over connector-registered orgs
 * (nc_instance_id set OR registration_source = 'nextcloud_connector' — the
 * only NC value written by connectorBootstrap/org-registration-source
 * migration), plus the orphan pre-org problem buckets ('nc:%', 'domain:%',
 * 'unknown' subjects that never produced an organization).
 */
async function getFleetOverview() {
    await initDB();
    const rows = await getAll(
        `SELECT o.id, o.name,
                o.nc_base_url, o.nc_instance_id, o.nc_provisioned_at, o.nc_last_sync_at,
                o.nc_onboarding_completed_at,
                EXISTS (
                    SELECT 1 FROM organization_subscriptions os
                     WHERE os.organization_id = o.id AND os.status = 'active'
                ) AS has_active_subscription,
                u.total_users, u.active_users, u.pending_users,
                a.messages_total, a.messages_30d, a.last_message_at,
                l.last_auth_ok_at, l.last_bootstrap_at, l.last_status_report_at, l.connector_version,
                p.problems
           FROM organizations o
      LEFT JOIN LATERAL (
                SELECT COUNT(*)::int AS total_users,
                       (COUNT(*) FILTER (WHERE u.status = 'active'))::int AS active_users,
                       (COUNT(*) FILTER (WHERE u.status = 'pending'))::int AS pending_users
                  FROM users u
                 WHERE u."organizationId" = o.id
                ) u ON true
      LEFT JOIN LATERAL (
                SELECT COUNT(*)::int AS messages_total,
                       (COUNT(*) FILTER (WHERE al."timestamp" > now() - interval '30 days'))::int AS messages_30d,
                       MAX(al."timestamp") AS last_message_at
                  FROM ai_usage_log al
                 WHERE al.organization_id = o.id
                ) a ON true
      LEFT JOIN org_health_liveness l ON l.organization_id = o.id
      LEFT JOIN LATERAL (
                SELECT COALESCE(jsonb_agg(jsonb_build_object(
                           'code', hp.code,
                           'category', hp.category,
                           'severity', hp.severity,
                           'message', hp.message,
                           'remediation', hp.remediation,
                           'count', hp.count,
                           'firstSeenAt', hp.first_seen_at,
                           'lastSeenAt', hp.last_seen_at
                       ) ORDER BY hp.last_seen_at DESC), '[]'::jsonb) AS problems
                  FROM org_health_problems hp
                 WHERE (hp.organization_id = o.id OR hp.subject_key = o.id)
                   AND hp.resolved_at IS NULL
                ) p ON true
          WHERE o.nc_instance_id IS NOT NULL
             OR o.registration_source = 'nextcloud_connector'
          ORDER BY o.name ASC NULLS LAST`
    );
    const orphanRows = await getAll(
        `SELECT subject_key,
                MAX(last_seen_at) AS last_seen_at,
                COALESCE(jsonb_agg(jsonb_build_object(
                    'code', code,
                    'category', category,
                    'severity', severity,
                    'message', message,
                    'remediation', remediation,
                    'count', count,
                    'firstSeenAt', first_seen_at,
                    'lastSeenAt', last_seen_at
                ) ORDER BY last_seen_at DESC), '[]'::jsonb) AS problems
           FROM org_health_problems
          WHERE resolved_at IS NULL
            AND organization_id IS NULL
            AND (subject_key LIKE 'nc:%' OR subject_key LIKE 'domain:%' OR subject_key = 'unknown')
          GROUP BY subject_key
          ORDER BY MAX(last_seen_at) DESC`
    );
    return {
        generatedAt: new Date().toISOString(),
        orgs: rows.map(_mapFleetRow),
        orphans: orphanRows.map(r => ({
            subjectKey: r.subject_key,
            lastSeenAt: r.last_seen_at || null,
            problems: Array.isArray(r.problems) ? r.problems : [],
        })),
    };
}

// ── Retention ──────────────────────────────────────────────────────────────

/**
 * Retention: timeline events after `eventRetentionDays` (default 90),
 * resolved problems after `resolvedProblemRetentionDays` (default 30), and —
 * unconditionally at 30d — unattributable 'domain:%'/'unknown' buckets so
 * spoofable subject keys can't grow the table forever. All DELETEs are
 * idempotent (safe on multi-replica double runs).
 */
async function pruneOld({ eventRetentionDays = 90, resolvedProblemRetentionDays = 30 } = {}) {
    await initDB();
    const evDays = Math.max(parseInt(eventRetentionDays, 10) || 90, 1);
    const prDays = Math.max(parseInt(resolvedProblemRetentionDays, 10) || 30, 1);
    const ev = await run(
        `DELETE FROM org_health_events WHERE created_at < now() - ($1::int * interval '1 day')`,
        [evDays]
    );
    const pr = await run(
        `DELETE FROM org_health_problems
          WHERE resolved_at IS NOT NULL
            AND resolved_at < now() - ($1::int * interval '1 day')`,
        [prDays]
    );
    const orph = await run(
        `DELETE FROM org_health_problems
          WHERE organization_id IS NULL
            AND (subject_key LIKE 'domain:%' OR subject_key = 'unknown')
            AND last_seen_at < now() - interval '30 days'`
    );
    return {
        events: ev.rowCount || 0,
        resolvedProblems: pr.rowCount || 0,
        unattributed: orph.rowCount || 0,
    };
}

module.exports = {
    initDB,
    upsertProblem,
    resolveProblems,
    listProblems,
    appendEvent,
    listEvents,
    touchLiveness,
    getFleetOverview,
    computeHealth,
    pruneOld,
    HEALTH_STATES,
    TENANT_KEY_PROBLEM_CODES,
    SEVERITIES,
    EVENT_ACTOR_KINDS,
    // internal — exported for unit tests (DB-free)
    _encodeCursor,
    _decodeCursor,
    _mapProblemRow,
    _mapEventRow,
    _mapFleetRow,
};
