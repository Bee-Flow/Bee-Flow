/**
 * The Compliance demo's access log (ISO 27001 A.8.15), in the shapes the
 * server writes and serves:
 *
 *   rows     access_audit_log as auth/loginAudit.js and routes/dsr.js write
 *            it: a sign-in names the ACCOUNT ID, never an address; a refused
 *            or blocked sign-in names a keyed fingerprint of what was typed
 *            (target_type 'login_identifier', changed_by 'anonymous'); a DSR
 *            read names the request id and its type only.
 *   actions  GET /access-audit/actions → { actions: [{ action, count, last_at }] },
 *            newest occurrence first, over the whole organisation (the
 *            filter's own options never narrow with the filter).
 *   list     GET /access-audit → { entries, total, limit, offset, scope },
 *            filtered by action(s), actor, target and dates like
 *            routes/compliance/accessAudit.js filterFrom.
 *
 * The demo used to answer `actions` with bare strings, which the filter read
 * as eight unlabelled pills with duplicate React keys.
 */

export interface AccessAuditRow {
    id: number;
    organization_id: string;
    action: string;
    target_type: string | null;
    target_id: string | null;
    changed_by: string | null;
    old_values: Record<string, unknown> | null;
    new_values: Record<string, unknown> | null;
    created_at: string;
}

export interface AccessAuditAction { action: string; count: number; last_at: string }

type AccessState = { accessAudit: AccessAuditRow[] };
type Ctx = { state: AccessState; query: URLSearchParams };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

/** A keyed fingerprint as loginAudit.identifierFingerprint prints it: version and 32 hex. */
const FINGERPRINT = 'v1:f1a9c47b03d2e8a51c6b9f0e7a4d2c18';

/** The seed log, newest first, as the store reads it. `org` is the demo organisation. */
export function accessAuditSeed(org: string, now: number = Date.now()): AccessAuditRow[] {
    const refused = (reason: string) => ({ method: 'password', reason, knownAccount: false, identifierFingerprint: FINGERPRINT, ip: '45.13.xxx.xxx' });
    // [id, action, target_type, target_id, changed_by, ms ago, new_values]
    const rows: [number, string, string, string, string, number, Record<string, unknown>][] = [
        [9, 'login_succeeded', 'user', 'u_marieke', 'u_marieke', HOUR_MS, { method: 'sso', ip: '82.94.xxx.xxx' }],
        [8, 'dsr.subject_viewed', 'dsr_request', '2417', 'u_marieke', 2 * HOUR_MS, { request_type: 'access' }],
        [7, 'dsr.discovery_run', 'dsr_request', '2417', 'u_marieke', 2 * HOUR_MS + 60_000, { request_type: 'access' }],
        [6, 'login_failed', 'login_identifier', FINGERPRINT, 'anonymous', 9 * HOUR_MS, refused('invalid_credentials')],
        [5, 'login_succeeded', 'user', 'u_farah', 'u_farah', 11 * HOUR_MS, { method: 'sso', ip: '82.94.xxx.xxx' }],
        [4, 'dsr.dossier_exported', 'dsr_request', '2415', 'u_marieke', 21 * DAY_MS, { audience: 'internal file' }],
        [3, 'studio_app_published', 'studio_app', 'app_intake', 'u_joost', 26 * DAY_MS, { appName: 'Polisintake' }],
        // passwordLoginRoutes: a sign-in refused by the login throttle.
        [2, 'login_blocked', 'login_identifier', FINGERPRINT, 'anonymous', 31 * DAY_MS, refused('throttled')],
        [1, 'studio_app_public_page_created', 'studio_app', 'app_intake', 'u_joost', 40 * DAY_MS, { appName: 'Polisintake', audience: 'public link' }],
    ];
    return rows.map(([id, action, target_type, target_id, changed_by, ms, new_values]) => ({
        id, organization_id: org, action, target_type, target_id, changed_by, old_values: null, new_values,
        created_at: new Date(now - ms).toISOString(),
    }));
}

/** Append one row the way userStore.logAccessAudit does: next id, now, newest first. */
export function logAccess(state: AccessState, entry: Omit<AccessAuditRow, 'id' | 'created_at' | 'old_values' | 'organization_id'> & { organization_id?: string }) {
    const id = state.accessAudit.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
    const organization_id = entry.organization_id ?? state.accessAudit[0]?.organization_id ?? '';
    state.accessAudit = [{ ...entry, organization_id, id, old_values: null, created_at: new Date().toISOString() }, ...state.accessAudit];
}

/** listAccessAuditActions: one row per action with its count and newest stamp, newest first. */
export function accessAuditActions(rows: readonly AccessAuditRow[]): AccessAuditAction[] {
    const by = new Map<string, AccessAuditAction>();
    for (const r of rows) {
        const seen = by.get(r.action);
        if (!seen) by.set(r.action, { action: r.action, count: 1, last_at: r.created_at });
        else {
            seen.count++;
            if (r.created_at > seen.last_at) seen.last_at = r.created_at;
        }
    }
    return [...by.values()].sort((a, b) => b.last_at.localeCompare(a.last_at));
}

/** The query's action list: `action` or `actions`, comma-separated (accessAudit.js actionsFrom). */
function actionsFrom(query: URLSearchParams): string[] {
    const raw = query.getAll('action').concat(query.getAll('actions')).join(',');
    return raw.split(',').map(a => a.trim()).filter(Boolean);
}

/** An ISO date from the query, or null: an unreadable date is no filter. */
function dateFrom(query: URLSearchParams, name: string): number | null {
    const v = query.get(name);
    if (!v) return null;
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
}

export function filterAccessAudit(rows: readonly AccessAuditRow[], query: URLSearchParams): AccessAuditRow[] {
    const actions = actionsFrom(query);
    const actor = query.get('actor');
    const targetType = query.get('targetType');
    const targetId = query.get('targetId');
    const since = dateFrom(query, 'since');
    const until = dateFrom(query, 'until');
    return rows.filter(r => (!actions.length || actions.includes(r.action))
        && (!actor || r.changed_by === actor)
        && (!targetType || r.target_type === targetType)
        && (!targetId || r.target_id === targetId)
        && (since === null || Date.parse(r.created_at) >= since)
        && (until === null || Date.parse(r.created_at) <= until));
}

export const ACCESS_LOG_ROUTES = {
    'GET /api/compliance/access-audit': ({ state, query }: Ctx) => {
        const rows = filterAccessAudit(state.accessAudit, query);
        const limit = Math.max(1, Math.min(MAX_PAGE, parseInt(query.get('limit') || '', 10) || DEFAULT_PAGE));
        const offset = Math.max(0, parseInt(query.get('offset') || '', 10) || 0);
        return { entries: rows.slice(offset, offset + limit), total: rows.length, limit, offset, scope: state.accessAudit[0]?.organization_id ?? null };
    },
    'GET /api/compliance/access-audit/actions': ({ state }: Ctx) => ({ actions: accessAuditActions(state.accessAudit) }),
};
