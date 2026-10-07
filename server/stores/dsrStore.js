// @typecheck
/**
 * DSR Store — Data Subject Request persistence (GDPR Art. 15–22).
 *
 * Public POST /api/dsr/requests inserts here without auth (legal obligation).
 * Admin GET / fulfil endpoints in /api/dsr/* read & mutate.
 *
 * Request types: access | rectification | deletion | portability | restriction | objection
 * Status:        pending | in_progress | fulfilled | rejected
 * Channel:       public_form | email_dpo | phone | letter | other   (how it came in)
 * Identity:      unverified | verified_email_link | verified_manual
 *
 * Time is an axis here (Art. 12(3)): every request carries `due_at` —
 * received + one calendar month — and may be extended ONCE by two further
 * months (`extended_until` = received + three calendar months, `due_at`
 * follows). A month that lacks the start day ends on its last day (31 Jan →
 * 28/29 Feb, utils/calendarMonths): a fixed 30 days ran past the legal
 * deadline for every request whose month crosses February. The `timeline`
 * JSONB is the human-readable trail the register drawer shows:
 * [{ at, by, kind, text?, … }] with kinds received | started |
 * identity_verified | extended | fulfilled | rejected | note.
 *
 * Personal data: `subject_email` stays in this table only. Masking for list
 * views is the route's job (compliance/dsr/mask.js); the deadline feed
 * (listOpenWithDeadlines) never selects the address at all.
 */

// Module reference (not destructured) so the facade stays swappable — the
// tests replace db.getOne to simulate a race between the read and the UPDATE.
const db = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');
const { addCalendarMonths } = require('../utils/calendarMonths');

const initDB = makeStoreInit('DsrStore', _initDB);

async function _initDB() {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS dsr_requests (
            id SERIAL PRIMARY KEY,
            organization_id TEXT,
            request_type TEXT NOT NULL,
            subject_email TEXT NOT NULL,
            subject_user_id TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            notes TEXT,
            result_summary TEXT,
            result_payload JSONB,
            source_ip TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            fulfilled_at TIMESTAMPTZ,
            fulfilled_by TEXT
        )
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_dsr_org_status ON dsr_requests(organization_id, status, created_at DESC)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_dsr_subject_email ON dsr_requests(subject_email)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_dsr_type_created ON dsr_requests(request_type, created_at DESC)`);
    // Compliance Center redesign (2026-09): intake channel, identity
    // verification, the one-month clock with its one-time extension, the
    // timeline and the single-use verify token. The due_at backfill is
    // idempotent (WHERE due_at IS NULL) so it can sit in boot DDL.
    await runDdl('dsrStore', [
        `ALTER TABLE dsr_requests ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'public_form'`,
        `ALTER TABLE dsr_requests ADD COLUMN IF NOT EXISTS identity_status TEXT NOT NULL DEFAULT 'unverified'`,
        `ALTER TABLE dsr_requests ADD COLUMN IF NOT EXISTS identity_verified_at TIMESTAMPTZ`,
        `ALTER TABLE dsr_requests ADD COLUMN IF NOT EXISTS created_by TEXT`,
        `ALTER TABLE dsr_requests ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`,
        `ALTER TABLE dsr_requests ADD COLUMN IF NOT EXISTS started_by TEXT`,
        `ALTER TABLE dsr_requests ADD COLUMN IF NOT EXISTS extended_until TIMESTAMPTZ`,
        `ALTER TABLE dsr_requests ADD COLUMN IF NOT EXISTS extension_reason TEXT`,
        `ALTER TABLE dsr_requests ADD COLUMN IF NOT EXISTS extended_by TEXT`,
        `ALTER TABLE dsr_requests ADD COLUMN IF NOT EXISTS extended_at TIMESTAMPTZ`,
        `ALTER TABLE dsr_requests ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ`,
        `ALTER TABLE dsr_requests ADD COLUMN IF NOT EXISTS timeline JSONB NOT NULL DEFAULT '[]'::jsonb`,
        `ALTER TABLE dsr_requests ADD COLUMN IF NOT EXISTS verify_token_hash TEXT`,
        // Postgres clamps a month the same way (2027-01-31 + 1 month = 2027-02-28).
        `UPDATE dsr_requests SET due_at = created_at + INTERVAL '1 month' WHERE due_at IS NULL`,
        `CREATE INDEX IF NOT EXISTS idx_dsr_org_due ON dsr_requests(organization_id, due_at) WHERE status IN ('pending','in_progress')`,
    ]);
}

const VALID_TYPES = new Set(['access', 'rectification', 'deletion', 'portability', 'restriction', 'objection']);
const VALID_STATUSES = new Set(['pending', 'in_progress', 'fulfilled', 'rejected']);
const VALID_CHANNELS = new Set(['public_form', 'email_dpo', 'phone', 'letter', 'other']);
const IDENTITY_STATUSES = new Set(['unverified', 'verified_email_link', 'verified_manual']);
const OPEN_STATUSES = ['pending', 'in_progress'];

/**
 * Art. 12(3): one month, extendable by two further months — calendar months.
 * A deadline on a weekend or public holiday is NOT moved to the next working
 * day: holidays differ per Member State, and a clock that is early is safe
 * where one that is late is not.
 */
const SLA_MONTHS = 1;
const EXTENDED_SLA_MONTHS = 3;

class AlreadyExtendedError extends Error {
    constructor(id) {
        super(`DSR request ${id} was already extended — Art. 12(3) allows one extension`);
        this.name = 'AlreadyExtendedError';
        this.code = 'dsr_already_extended';
    }
}

const LIST_COLUMNS = `id, request_type, subject_email, subject_user_id, status, notes,
               result_summary, source_ip, created_at, fulfilled_at, fulfilled_by,
               channel, identity_status, identity_verified_at, created_by,
               started_at, started_by, extended_until, extension_reason, extended_by, extended_at,
               due_at, timeline`;

function _dueFrom(receivedAt, months) {
    return addCalendarMonths(new Date(receivedAt), months);
}

function _channel(v) {
    const c = String(v || 'public_form').toLowerCase();
    if (!VALID_CHANNELS.has(c)) throw new Error(`invalid channel "${c}"`);
    return c;
}

/**
 * @param kind
 * @param {{ at?: string|Date, by?: string|null, [key: string]: any }} [opts]
 */
function _event(kind, { at, by, ...rest } = {}) {
    return { at: at ? new Date(at).toISOString() : new Date().toISOString(), by: by ?? null, kind, ...rest };
}

/**
 * Rows written before the timeline column have `[]`; synthesise the trail
 * from the columns on the way out (read path only — never an UPDATE).
 */
function _withTimeline(row) {
    if (!row) return row;
    let tl = row.timeline;
    if (typeof tl === 'string') { try { tl = JSON.parse(tl); } catch { tl = null; } }
    if (Array.isArray(tl) && tl.length > 0) return { ...row, timeline: tl };
    const synth = [_event('received', { at: row.created_at, channel: row.channel || 'public_form' })];
    if (row.started_at) synth.push(_event('started', { at: row.started_at, by: row.started_by }));
    if (row.fulfilled_at) {
        synth.push(_event(row.status === 'rejected' ? 'rejected' : 'fulfilled', { at: row.fulfilled_at, by: row.fulfilled_by }));
    }
    return { ...row, timeline: synth };
}

// ───────────────────────── Intake ─────────────────────────

/**
 * Public-form intake (unauthenticated). The clock starts now: due_at =
 * created_at + one calendar month, timeline opens with `received`.
 */
async function createRequest(input) {
    await initDB();
    if (!input || !input.subject_email) throw new Error('subject_email is required');
    const type = String(input.request_type || 'access').toLowerCase();
    if (!VALID_TYPES.has(type)) throw new Error(`invalid request_type "${type}"`);
    const channel = _channel(input.channel);
    const createdAt = input.received_at ? new Date(input.received_at) : new Date();
    const timeline = [_event('received', { at: createdAt, by: input.created_by || null, channel, text: null })];
    const { rows } = await db.run(`
        INSERT INTO dsr_requests
            (organization_id, request_type, subject_email, subject_user_id, notes, source_ip, status,
             channel, identity_status, created_by, created_at, due_at, timeline)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, 'unverified', $8, $9, $10, $11::jsonb)
        RETURNING id, created_at, due_at, channel, identity_status
    `, [
        input.organization_id || null,
        type,
        String(input.subject_email).trim().toLowerCase(),
        input.subject_user_id || null,
        input.notes || null,
        input.source_ip || null,
        channel,
        input.created_by || null,
        createdAt,
        _dueFrom(createdAt, SLA_MONTHS),
        JSON.stringify(timeline),
    ]);
    return rows[0];
}

/**
 * Admin intake of a request that arrived outside the form (mail to the DPO,
 * phone, letter). The admin has seen the person or their letter, so identity
 * is `verified_manual`; the clock starts at `received_at`, not at data entry.
 * @param orgId
 * @param {{ subject_email?: string, request_type?: string, channel?: string, notes?: string, received_at?: string|Date, created_by?: string }} [opts]
 */
async function createManual(orgId, { subject_email, request_type, channel, notes, received_at, created_by } = {}) {
    await initDB();
    if (!orgId) throw new Error('organization_id is required');
    if (!subject_email) throw new Error('subject_email is required');
    if (!created_by) throw new Error('created_by is required');
    const type = String(request_type || 'access').toLowerCase();
    if (!VALID_TYPES.has(type)) throw new Error(`invalid request_type "${type}"`);
    const ch = _channel(channel || 'other');
    const receivedAt = received_at ? new Date(received_at) : new Date();
    if (Number.isNaN(receivedAt.getTime())) throw new Error('received_at is not a date');
    if (receivedAt.getTime() > Date.now() + 60_000) throw new Error('received_at cannot be in the future');
    const now = new Date();
    const timeline = [
        _event('received', { at: receivedAt, by: created_by, channel: ch, text: notes ? String(notes).slice(0, 2000) : null }),
        _event('identity_verified', { at: now, by: created_by, method: 'manual' }),
    ];
    const { rows } = await db.run(`
        INSERT INTO dsr_requests
            (organization_id, request_type, subject_email, notes, status,
             channel, identity_status, identity_verified_at, created_by, created_at, due_at, timeline)
        VALUES ($1, $2, $3, $4, 'pending', $5, 'verified_manual', $6, $7, $8, $9, $10::jsonb)
        RETURNING id, created_at, due_at, channel, identity_status
    `, [
        orgId,
        type,
        String(subject_email).trim().toLowerCase(),
        notes || null,
        ch,
        now,
        created_by,
        receivedAt,
        _dueFrom(receivedAt, SLA_MONTHS),
        JSON.stringify(timeline),
    ]);
    return rows[0];
}

// ───────────────────────── Reads ─────────────────────────

/**
 * @param orgId
 * @param {{ status?: string, limit?: number }} [opts]
 */
async function listRequests(orgId, { status, limit = 200 } = {}) {
    await initDB();
    const params = [orgId];
    let where = `organization_id = $1`;
    if (status) {
        params.push(status);
        where += ` AND status = $${params.length}`;
    }
    params.push(limit);
    const rows = await db.getAll(`
        SELECT ${LIST_COLUMNS}
        FROM dsr_requests
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length}
    `, params);
    return rows.map(_withTimeline);
}

async function getRequest(orgId, id) {
    await initDB();
    const row = await db.getOne(`
        SELECT * FROM dsr_requests
        WHERE organization_id = $1 AND id = $2
    `, [orgId, id]);
    return _withTimeline(row);
}

/** Open requests ordered by deadline — the deadline feed. No e-mail address. */
async function listOpenWithDeadlines(orgId) {
    await initDB();
    return db.getAll(`
        SELECT id, request_type, status, channel, identity_status,
               created_at, started_at, due_at, extended_until
        FROM dsr_requests
        WHERE organization_id = $1 AND status = ANY($2)
        ORDER BY due_at ASC NULLS LAST, created_at ASC
    `, [orgId, OPEN_STATUSES]);
}

// ───────────────────────── Mutations ─────────────────────────

// Atomic jsonb append: no read-modify-write on the timeline.
const APPEND_TIMELINE = `timeline = COALESCE(timeline, '[]'::jsonb) || $%N::jsonb`;
const appendSql = (n) => APPEND_TIMELINE.replace('%N', String(n));

/** Which timeline kind a status transition writes (null = none). */
const STATUS_EVENT = { fulfilled: 'fulfilled', rejected: 'rejected', in_progress: 'started', pending: null };

/**
 * @param orgId
 * @param id
 * @param status
 * @param {{ fulfilledBy?: string, resultSummary?: string, resultPayload?: any }} [opts]
 */
async function updateStatus(orgId, id, status, { fulfilledBy, resultSummary, resultPayload } = {}) {
    await initDB();
    if (!VALID_STATUSES.has(status)) throw new Error(`invalid status "${status}"`);
    const fulfilledAt = status === 'fulfilled' ? new Date() : null;
    const payloadJson = resultPayload === undefined ? null : JSON.stringify(resultPayload);
    const kind = STATUS_EVENT[status];
    const events = kind ? [_event(kind, { by: fulfilledBy || null, text: kind === 'started' ? null : (resultSummary ? String(resultSummary).slice(0, 2000) : null) })] : [];
    await db.run(`
        UPDATE dsr_requests SET
            status = $3,
            fulfilled_at = COALESCE($4, fulfilled_at),
            fulfilled_by = COALESCE($5, fulfilled_by),
            result_summary = COALESCE($6, result_summary),
            result_payload = COALESCE($7::jsonb, result_payload),
            ${appendSql(8)}
        WHERE organization_id = $1 AND id = $2
    `, [orgId, id, status, fulfilledAt, fulfilledBy || null, resultSummary || null, payloadJson, JSON.stringify(events)]);
    return getRequest(orgId, id);
}

/**
 * pending → in_progress with the actor stamped. Idempotent: an already
 * started request is returned unchanged (no second `started` event).
 */
async function start(orgId, id, userId) {
    await initDB();
    if (!userId) throw new Error('userId is required');
    const event = _event('started', { by: userId });
    await db.run(`
        UPDATE dsr_requests SET
            status = 'in_progress',
            started_at = $3,
            started_by = $4,
            ${appendSql(5)}
        WHERE organization_id = $1 AND id = $2 AND status = 'pending'
    `, [orgId, id, new Date(event.at), userId, JSON.stringify([event])]);
    return getRequest(orgId, id);
}

/**
 * Art. 12(3) extension — exactly once, with a reason the subject is told.
 * extended_until = received + three calendar months and the deadline follows it.
 * @throws {AlreadyExtendedError} on a second attempt (also under a race:
 *   the UPDATE is guarded by `extended_at IS NULL`).
 * @param orgId
 * @param id
 * @param {{ reason?: string, by?: string }} [opts]
 */
async function extend(orgId, id, { reason, by } = {}) {
    await initDB();
    const text = String(reason || '').trim();
    if (!text) throw new Error('reason is required');
    const existing = await getRequest(orgId, id);
    if (!existing) return null;
    if (existing.extended_at) throw new AlreadyExtendedError(id);
    if (!OPEN_STATUSES.includes(existing.status)) throw new Error(`cannot extend a ${existing.status} request`);
    const extendedUntil = _dueFrom(existing.created_at, EXTENDED_SLA_MONTHS);
    const event = _event('extended', { by: by || null, text: text.slice(0, 2000), until: extendedUntil.toISOString() });
    const r = await db.run(`
        UPDATE dsr_requests SET
            extended_until = $3,
            due_at = $3,
            extension_reason = $4,
            extended_by = $5,
            extended_at = $6,
            ${appendSql(7)}
        WHERE organization_id = $1 AND id = $2 AND extended_at IS NULL
    `, [orgId, id, extendedUntil, text.slice(0, 2000), by || null, new Date(event.at), JSON.stringify([event])]);
    if (!r?.rowCount) throw new AlreadyExtendedError(id);
    return getRequest(orgId, id);
}

/**
 * @param {string} orgId
 * @param {string} id
 * @param {{method?:'email_link'|'manual', by?:string|null}} [opts] - `email_link`
 *   is the subject clicking the acknowledgement link (by = null), `manual` is
 *   an admin who checked the person's identity another way.
 */
async function verifyIdentity(orgId, id, { method, by } = {}) {
    await initDB();
    const status = method === 'email_link' ? 'verified_email_link' : method === 'manual' ? 'verified_manual' : null;
    if (!status) throw new Error(`invalid identity method "${method}"`);
    if (status === 'verified_manual' && !by) throw new Error('by is required for a manual verification');
    const event = _event('identity_verified', { by: by || null, method });
    await db.run(`
        UPDATE dsr_requests SET
            identity_status = $3,
            identity_verified_at = $4,
            ${appendSql(5)}
        WHERE organization_id = $1 AND id = $2
    `, [orgId, id, status, new Date(event.at), JSON.stringify([event])]);
    return getRequest(orgId, id);
}

/** Append one free event ({kind, text?, by?, …}); `at` defaults to now. */
async function appendTimeline(orgId, id, event) {
    await initDB();
    if (!event || typeof event.kind !== 'string' || !event.kind.trim()) throw new Error('event.kind is required');
    const safe = _event(event.kind.trim(), {
        ...event,
        text: event.text != null ? String(event.text).slice(0, 2000) : null,
    });
    await db.run(`
        UPDATE dsr_requests SET ${appendSql(3)}
        WHERE organization_id = $1 AND id = $2
    `, [orgId, id, JSON.stringify([safe])]);
    return getRequest(orgId, id);
}

// ───────────────────────── Verify token (single use) ─────────────────────────

async function setVerifyTokenHash(orgId, id, hash) {
    await initDB();
    if (!hash) throw new Error('hash is required');
    const r = await db.run(`
        UPDATE dsr_requests SET verify_token_hash = $3
        WHERE organization_id = $1 AND id = $2
    `, [orgId, id, String(hash)]);
    return (r?.rowCount || 0) > 0;
}

/**
 * Burn the token: matches only when the stored hash equals `hash`, and clears
 * it in the same statement — a second click with the same link finds nothing.
 * @returns {Promise<boolean>} true when this call consumed the token
 */
async function consumeVerifyToken(orgId, id, hash) {
    await initDB();
    if (!hash) return false;
    const r = await db.run(`
        UPDATE dsr_requests SET verify_token_hash = NULL
        WHERE organization_id = $1 AND id = $2 AND verify_token_hash = $3
    `, [orgId, id, String(hash)]);
    return (r?.rowCount || 0) > 0;
}

// ───────────────────────── Aggregates ─────────────────────────

/**
 * SLA aggregates for the Art-15 / Art-17 checks. Returns counts and average
 * fulfilment time in days for the requested type over the rolling window.
 * "Overdue" is measured against `due_at`, so a granted extension moves it.
 * "Nearing" is an open request whose `due_at` falls within the next 5 days —
 * the age of the open requests themselves, which the average fulfilment time
 * (over FULFILLED requests) cannot tell.
 */
async function getSlaStats(orgId, requestType, windowDays = 365) {
    await initDB();
    const row = await db.getOne(`
        SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'fulfilled')::int AS fulfilled,
            COUNT(*) FILTER (WHERE status IN ('pending','in_progress'))::int AS open,
            COUNT(*) FILTER (
                WHERE status IN ('pending','in_progress')
                AND due_at < NOW()
            )::int AS overdue,
            COUNT(*) FILTER (
                WHERE status IN ('pending','in_progress')
                AND due_at >= NOW()
                AND due_at < NOW() + INTERVAL '5 days'
            )::int AS nearing,
            COALESCE(AVG(
                EXTRACT(EPOCH FROM (fulfilled_at - created_at)) / 86400
            ) FILTER (WHERE status = 'fulfilled'), 0) AS avg_days_to_fulfil
        FROM dsr_requests
        WHERE organization_id = $1 AND request_type = $2
        AND created_at >= NOW() - ($3 || ' days')::interval
    `, [orgId, requestType, String(windowDays)]);
    return row || { total: 0, fulfilled: 0, open: 0, overdue: 0, nearing: 0, avg_days_to_fulfil: 0 };
}

module.exports = {
    initDB,
    createRequest,
    createManual,
    listRequests,
    getRequest,
    listOpenWithDeadlines,
    updateStatus,
    start,
    extend,
    verifyIdentity,
    appendTimeline,
    setVerifyTokenHash,
    consumeVerifyToken,
    getSlaStats,
    AlreadyExtendedError,
    VALID_TYPES: [...VALID_TYPES],
    VALID_STATUSES: [...VALID_STATUSES],
    VALID_CHANNELS: [...VALID_CHANNELS],
    IDENTITY_STATUSES: [...IDENTITY_STATUSES],
    SLA_MONTHS,
    EXTENDED_SLA_MONTHS,
};
