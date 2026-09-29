// @typecheck
/**
 * ISO Obligation Store — the single due-date engine for the ISMS process
 * layer (ISO 27001 cl. 9.2/9.3, A.5.36, A.6.3, A.8.8 …).
 *
 * One row = one open obligation ("review the access policy by 1 Oct").
 * Kinds cover the recurring ISMS clock (policy/SoA reviews, internal audit,
 * management review, training, access/supplier reviews, pentest) plus
 * 'custom'. Completing stamps WHO/WHEN — a human clicks, never automatic —
 * and when `recur_months` is set the next occurrence is inserted with the
 * due date rolled forward, so the clock never stops.
 *
 * `notify_offsets` are days-before-due reminder tiers (default 30/7/0);
 * `last_notified_offset` records the tier already sent, which makes the
 * notifier idempotent per tier (tiers shrink toward the due date, so a new
 * reminder is due when the applicable tier is SMALLER than the last sent).
 * A partial unique index keeps at most one OPEN obligation per
 * (org, kind, subject).
 */

const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');

const initDB = makeStoreInit('IsoObligationStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS iso_obligations (
            id SERIAL PRIMARY KEY,
            organization_id TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'custom',
            subject TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL,
            owner_user_id TEXT,
            due_at TIMESTAMPTZ NOT NULL,
            recur_months INT,
            notify_offsets JSONB NOT NULL DEFAULT '[30,7,0]'::jsonb,
            last_notified_offset INT,
            completed_at TIMESTAMPTZ,
            completed_by TEXT,
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_iso_obl_open_unique
        ON iso_obligations(organization_id, kind, subject)
        WHERE completed_at IS NULL
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_iso_obl_due ON iso_obligations(due_at) WHERE completed_at IS NULL`);
}

const KINDS = [
    'policy_review', 'soa_review', 'internal_audit', 'management_review',
    'training', 'access_review', 'supplier_review', 'pentest', 'custom',
];
const VALID_KINDS = new Set(KINDS);
const DEFAULT_OFFSETS = [30, 7, 0];
const NOTIFY_HORIZON_DAYS = 60;
const DAY_MS = 86400000;

/** Days-before-due tiers: non-negative ints, deduped, largest first. */
function normalizeOffsets(v) {
    const arr = (Array.isArray(v) ? v : DEFAULT_OFFSETS)
        .map(Number)
        .filter(n => Number.isInteger(n) && n >= 0 && n <= 365);
    const uniq = [...new Set(arr)].sort((a, b) => b - a);
    return uniq.length ? uniq : [...DEFAULT_OFFSETS];
}

function toRecurMonths(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 && n <= 120 ? n : null;
}

/** Calendar roll, clamped to the last day of the target month (31 Jan +1 → 28/29 Feb). */
function addMonths(date, months) {
    const d = new Date(date);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
    return d;
}

async function listObligations(orgId, { openOnly = false, limit = 200 } = {}) {
    await initDB();
    const params = [orgId];
    let where = 'organization_id = $1';
    if (openOnly) where += ' AND completed_at IS NULL';
    params.push(limit);
    return getAll(`
        SELECT * FROM iso_obligations
        WHERE ${where}
        ORDER BY (completed_at IS NOT NULL), due_at ASC
        LIMIT $${params.length}
    `, params);
}

async function getObligation(orgId, id) {
    await initDB();
    return getOne(`SELECT * FROM iso_obligations WHERE organization_id = $1 AND id = $2`, [orgId, id]);
}

async function createObligation(orgId, input, actorId = null) {
    await initDB();
    if (!orgId) throw new Error('organization_id is required');
    if (!input?.title) throw new Error('title is required');
    if (!input?.due_at) throw new Error('due_at is required');
    const kind = VALID_KINDS.has(input.kind) ? input.kind : 'custom';
    const { rows } = await run(`
        INSERT INTO iso_obligations
            (organization_id, kind, subject, title, owner_user_id, due_at,
             recur_months, notify_offsets, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
        RETURNING *
    `, [
        orgId,
        kind,
        String(input.subject || '').slice(0, 200),
        String(input.title).slice(0, 300),
        input.owner_user_id || null,
        new Date(input.due_at),
        toRecurMonths(input.recur_months),
        JSON.stringify(normalizeOffsets(input.notify_offsets)),
        actorId || null,
    ]);
    return rows?.[0] || null;
}

/**
 * Partial update — whitelisted fields only, everything else in `patch` is
 * silently dropped (same stance as soaStore.upsertEntry). `kind` is part of
 * the open-obligation identity and is deliberately NOT editable; completion
 * stamps only ever come from completeObligation. Changing `due_at` resets
 * `last_notified_offset` so the reminder tiers fire again for the new date.
 */
async function updateObligation(orgId, id, patch = {}, _actorId = null) {
    await initDB();
    const existing = await getObligation(orgId, id);
    if (!existing) return null;
    const safe = {
        subject: patch.subject !== undefined ? String(patch.subject || '').slice(0, 200) : existing.subject,
        title: patch.title !== undefined && patch.title ? String(patch.title).slice(0, 300) : existing.title,
        owner_user_id: patch.owner_user_id !== undefined ? (patch.owner_user_id || null) : existing.owner_user_id,
        due_at: patch.due_at !== undefined ? new Date(patch.due_at) : existing.due_at,
        recur_months: patch.recur_months !== undefined ? toRecurMonths(patch.recur_months) : existing.recur_months,
        notify_offsets: patch.notify_offsets !== undefined ? normalizeOffsets(patch.notify_offsets) : normalizeOffsets(existing.notify_offsets),
    };
    const dueChanged = patch.due_at !== undefined
        && new Date(patch.due_at).getTime() !== new Date(existing.due_at).getTime();
    await run(`
        UPDATE iso_obligations SET
            subject = $3,
            title = $4,
            owner_user_id = $5,
            due_at = $6,
            recur_months = $7,
            notify_offsets = $8::jsonb,
            last_notified_offset = $9,
            updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
    `, [
        orgId, id,
        safe.subject, safe.title, safe.owner_user_id, safe.due_at,
        safe.recur_months, JSON.stringify(safe.notify_offsets),
        dueChanged ? null : (existing.last_notified_offset ?? null),
    ]);
    return getObligation(orgId, id);
}

/**
 * Stamps completed_at/completed_by (who + when — never automatic), and when
 * `recur_months` is set inserts the next occurrence with due_at rolled
 * forward by that many months and the reminder tiers reset. ON CONFLICT
 * DO NOTHING respects the open-obligation unique index, so a manually
 * re-created duplicate can never appear.
 * Returns { completed, next } — next is null when non-recurring.
 */
async function completeObligation(orgId, id, actorId = null) {
    await initDB();
    const existing = await getObligation(orgId, id);
    if (!existing) return null;
    if (existing.completed_at) return { completed: existing, next: null };
    await run(`
        UPDATE iso_obligations SET
            completed_at = NOW(),
            completed_by = $3,
            updated_at = NOW()
        WHERE organization_id = $1 AND id = $2 AND completed_at IS NULL
    `, [orgId, id, actorId || null]);
    let next = null;
    if (existing.recur_months) {
        const nextDue = addMonths(existing.due_at, existing.recur_months);
        const { rows } = await run(`
            INSERT INTO iso_obligations
                (organization_id, kind, subject, title, owner_user_id, due_at,
                 recur_months, notify_offsets, last_notified_offset, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NULL, $9)
            ON CONFLICT DO NOTHING
            RETURNING *
        `, [
            orgId,
            existing.kind,
            existing.subject || '',
            existing.title,
            existing.owner_user_id || null,
            nextDue,
            existing.recur_months,
            JSON.stringify(normalizeOffsets(existing.notify_offsets)),
            actorId || null,
        ]);
        next = rows?.[0] || null;
    }
    return { completed: await getObligation(orgId, id), next };
}

/**
 * All orgs' open obligations that are due a reminder RIGHT NOW, each row
 * annotated with `notify_offset` — the tier to send (pass it back to
 * markNotified after delivery). SQL stays a broad "open, due within 60 days"
 * sweep; the tier arithmetic happens here:
 *   daysLeft   = (due_at - now) in fractional days (negative = overdue)
 *   reached    = offsets whose window has started (offset >= daysLeft)
 *   applicable = smallest reached tier (30 → 7 → 0 as the date approaches)
 * Send iff nothing was sent yet, or the applicable tier is smaller than the
 * last one sent.
 */
async function listDueForNotification() {
    await initDB();
    const rows = await getAll(`
        SELECT id, organization_id, kind, subject, title, owner_user_id,
               due_at, notify_offsets, last_notified_offset
        FROM iso_obligations
        WHERE completed_at IS NULL
          AND due_at < NOW() + INTERVAL '${NOTIFY_HORIZON_DAYS} days'
        ORDER BY due_at ASC
    `, []);
    const now = Date.now();
    const due = [];
    for (const r of rows || []) {
        const offsets = normalizeOffsets(r.notify_offsets);
        const daysLeft = (new Date(r.due_at).getTime() - now) / DAY_MS;
        const reached = offsets.filter(o => o >= daysLeft);
        if (!reached.length) continue; // not yet inside the earliest reminder window
        const applicable = Math.min(...reached);
        const last = r.last_notified_offset;
        if (last !== null && last !== undefined && applicable >= last) continue; // tier already sent
        due.push({ ...r, notify_offset: applicable });
    }
    return due;
}

/** Record that the reminder for a tier went out — keyed by id, notifier-global. */
async function markNotified(id, offset) {
    await initDB();
    await run(`
        UPDATE iso_obligations SET
            last_notified_offset = $2,
            updated_at = NOW()
        WHERE id = $1
    `, [id, Number.isFinite(Number(offset)) ? Number(offset) : 0]);
}

/** Counters for the readiness dashboard. */
async function getStats(orgId) {
    await initDB();
    const row = await getOne(`
        SELECT
            COUNT(*) FILTER (WHERE completed_at IS NULL)::int AS open,
            COUNT(*) FILTER (WHERE completed_at IS NULL AND due_at < NOW())::int AS overdue,
            COUNT(*) FILTER (
                WHERE completed_at IS NULL AND due_at >= NOW()
                  AND due_at < NOW() + INTERVAL '30 days'
            )::int AS due_30d
        FROM iso_obligations
        WHERE organization_id = $1
    `, [orgId]);
    return row || { open: 0, overdue: 0, due_30d: 0 };
}

module.exports = {
    initDB,
    KINDS,
    listObligations,
    getObligation,
    createObligation,
    updateObligation,
    completeObligation,
    listDueForNotification,
    markNotified,
    getStats,
};
