// @typecheck
/**
 * Incident Store — the ONE incident register (GDPR Art. 33/34, NIS2 Art. 23,
 * CRA Art. 14, DORA Art. 19).
 *
 * Every row has a `kind` (breach | security_incident | vulnerability) and the
 * `regimes` it is reported under (JSONB, default ["GDPR"]). The clocks are
 * computed from `detected_at` per regime and stored as columns so the
 * deadline feed, the notifier and the checks all read the same numbers:
 *
 *   GDPR  Art. 33(1)   authority notification      detected + 72 h
 *   NIS2  Art. 23(4)   early warning               detected + 24 h
 *                      incident notification       detected + 72 h
 *                      final report                detected + 1 month
 *   CRA   Art. 14      early warning               detected + 24 h
 *                      vulnerability notification  detected + 72 h
 *                      final report, vulnerability detected + 14 d
 *                      final report, severe        notification + 1 month
 *                      incident (Art. 14(4)(c))    (detected + 72 h + 1 month until notified)
 *   DORA  Art. 19      customer notice             detected + `dora_customer_notice_hours` (default 4)
 *
 * `deadline_at` stays what every existing query expects — the NEXT thing due
 * to somebody outside the organisation — and is the EARLIEST applicable
 * clock (72 h when GDPR is the only regime). `early_warning_due_at` and
 * `final_report_due_at` are the earliest of the regimes that carry that
 * clock; `customer_notice_due_at` exists only for DORA.
 *
 * A clock that has been SATISFIED is no longer "due", so `deadline_at` is
 * RECOMPUTED (`nextOpenDeadline`) every time a stage stamp lands — the early
 * warning, the final report / authority notification, the DORA customer
 * notice, and closure. Without that, an incident whose 24-hour early warning
 * was filed on time kept the 24-hour clock as its deadline and read as
 * overdue for ever in `getDeadlineStats`, `listNeedingAttention` (the daily
 * notifier), `/counts` (a negative `hours_left`) and the deadline feed.
 * When every applicable clock has been met, `deadline_at` is NULL — "nothing
 * is due", which every consumer already guards for — never a past timestamp.
 * Rows stamped before that rule existed are corrected once at boot by
 * `backfillDeadlines()` (see below) — an incident that is never stamped again
 * would otherwise keep its stale roll-up, and read as overdue, for ever.
 *
 * The tool records WHO notified WHAT and WHEN — it never files with a CSIRT,
 * a supervisory authority or the ENISA platform itself; every "sent" stamp is
 * an attestation (timestamp + actor + reference), by design.
 *
 * Statuses: open → assessing → [early_warning_sent →] authority_notified |
 * reported → subjects_notified → closed. (Art-34 data-subject notification
 * only applies when `high_risk` is set.)
 */

const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');
const log = require('../telemetry/log');
// The clock arithmetic is pure and lives on its own (incidentClocks.js); the
// store persists what it computes.
const {
    VALID_REGIMES, DEADLINE_HOURS, DEFAULT_CUSTOMER_NOTICE_HOURS, REGIME_CLOCKS,
    normalizeRegimes, computeClocks, nextOpenDeadline,
    _jsonArray, _ms, _severeIncidentFinalDue,
} = require('./incidentClocks');

const initDB = makeStoreInit('IncidentStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS compliance_incidents (
            id SERIAL PRIMARY KEY,
            organization_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            severity TEXT NOT NULL DEFAULT 'medium',
            source TEXT NOT NULL DEFAULT 'manual',
            high_risk BOOLEAN NOT NULL DEFAULT false,
            status TEXT NOT NULL DEFAULT 'open',
            occurred_at TIMESTAMPTZ,
            detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deadline_at TIMESTAMPTZ NOT NULL,
            recipients_notified_at TIMESTAMPTZ,
            authority_notified_at TIMESTAMPTZ,
            authority_reference TEXT,
            authority_notified_by TEXT,
            subjects_notified_at TIMESTAMPTZ,
            subjects_notified_by TEXT,
            created_by TEXT,
            notes JSONB DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_incidents_org_status ON compliance_incidents(organization_id, status, detected_at DESC)`);
    // Compliance Center redesign (2026-09): one register for breaches,
    // security incidents and product vulnerabilities, with the NIS2 / CRA /
    // DORA clocks beside the GDPR one. Existing rows keep kind 'breach'
    // and regimes ["GDPR"] through the defaults — no backfill needed.
    await runDdl('incidentStore', [
        `ALTER TABLE compliance_incidents ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'breach'`,
        `ALTER TABLE compliance_incidents ADD COLUMN IF NOT EXISTS regimes JSONB NOT NULL DEFAULT '["GDPR"]'::jsonb`,
        `ALTER TABLE compliance_incidents ADD COLUMN IF NOT EXISTS early_warning_due_at TIMESTAMPTZ`,
        `ALTER TABLE compliance_incidents ADD COLUMN IF NOT EXISTS early_warning_sent_at TIMESTAMPTZ`,
        `ALTER TABLE compliance_incidents ADD COLUMN IF NOT EXISTS final_report_due_at TIMESTAMPTZ`,
        `ALTER TABLE compliance_incidents ADD COLUMN IF NOT EXISTS final_report_sent_at TIMESTAMPTZ`,
        `ALTER TABLE compliance_incidents ADD COLUMN IF NOT EXISTS customer_notice_due_at TIMESTAMPTZ`,
        `ALTER TABLE compliance_incidents ADD COLUMN IF NOT EXISTS customer_notified_at TIMESTAMPTZ`,
        `ALTER TABLE compliance_incidents ADD COLUMN IF NOT EXISTS reported_via TEXT`,
        `ALTER TABLE compliance_incidents ADD COLUMN IF NOT EXISTS cve_ids JSONB DEFAULT '[]'::jsonb`,
        `ALTER TABLE compliance_incidents ADD COLUMN IF NOT EXISTS affected_products JSONB DEFAULT '[]'::jsonb`,
        `ALTER TABLE compliance_incidents ADD COLUMN IF NOT EXISTS exploited_in_wild BOOLEAN`,
        // `deadline_at` is the earliest clock that is still OPEN, so it has
        // to become NULL once every applicable clock has been met (see
        // nextOpenDeadline). A row with no outstanding obligation must not
        // be forced to carry a past timestamp — that is what made a filed
        // incident read as permanently overdue.
        `ALTER TABLE compliance_incidents ALTER COLUMN deadline_at DROP NOT NULL`,
        `CREATE INDEX IF NOT EXISTS idx_incidents_org_kind ON compliance_incidents(organization_id, kind, status)`,
    ]);
    // Additive, idempotent, and part of the same boot step as the columns
    // above (compliance tables carry their schema here, not in migrations/).
    await backfillDeadlines();
    await backfillCraIncidentFinals();
}

// ── One-time correction of `deadline_at` on already-stamped rows ────────────
//
// `deadline_at` only became "the earliest clock that is still open" when the
// recompute was added to the stamps. Rows stamped BEFORE that kept the clock
// they were created with, and a row that is never stamped again keeps it for
// ever — which is exactly the population that reads as permanently overdue in
// getDeadlineStats/`/counts`, in the deadline feed and in the daily notifier's
// listNeedingAttention. Lazy correction "on the next stamp" never reaches them,
// because there is no next stamp.
//
// It is a JS pass rather than one `UPDATE … SET deadline_at = <expression>`
// on purpose: the rule is `nextOpenDeadline`, and a second copy of it in SQL
// would be a second thing to keep right. Any row it cannot decide is left
// exactly as it is.
//
// Idempotent twice over: the WHERE only admits rows that carry a stamp (or are
// closed) AND still carry a deadline, and within that a row is written only
// when the recomputed value actually differs — so a second run issues no
// UPDATE at all. `updated_at` is deliberately NOT touched: this corrects a
// derived roll-up, and bumping it would make every historical incident look
// edited on the morning of the upgrade.
const BACKFILL_BATCH = 500;
const BACKFILL_MAX_BATCHES = 2000;

async function backfillDeadlines() {
    let lastId = 0;
    let scanned = 0;
    let moved = 0;
    try {
        for (let i = 0; i < BACKFILL_MAX_BATCHES; i++) {
            // Keyset paging on id, not OFFSET: most corrected rows leave the
            // filtered set (their deadline becomes NULL), which would shift an
            // offset window and skip rows.
            const batch = await getAll(`
                SELECT id, organization_id, status, kind, regimes, detected_at, deadline_at,
                       early_warning_due_at, early_warning_sent_at,
                       final_report_due_at, final_report_sent_at,
                       customer_notice_due_at, customer_notified_at,
                       authority_notified_at
                FROM compliance_incidents
                WHERE id > $1
                  AND deadline_at IS NOT NULL
                  AND (status = 'closed'
                       OR early_warning_sent_at IS NOT NULL
                       OR authority_notified_at IS NOT NULL
                       OR customer_notified_at IS NOT NULL
                       OR final_report_sent_at IS NOT NULL)
                ORDER BY id
                LIMIT $2
            `, [lastId, BACKFILL_BATCH]);
            if (!batch.length) break;
            scanned += batch.length;
            lastId = batch[batch.length - 1].id;
            for (const row of batch) {
                const next = nextOpenDeadline(row);
                const current = row.deadline_at ? new Date(row.deadline_at).getTime() : null;
                const wanted = next ? next.getTime() : null;
                if (current === wanted) continue;
                await run(`
                    UPDATE compliance_incidents SET deadline_at = $3
                    WHERE organization_id = $1 AND id = $2
                `, [row.organization_id, row.id, next]);
                moved += 1;
            }
            if (batch.length < BACKFILL_BATCH) break;
        }
        if (moved > 0) {
            log.info(`[IncidentStore] deadline backfill: ${moved} of ${scanned} stamped incident(s) re-pointed at their next open clock`);
        }
    } catch (err) {
        // Never fail the boot over a correction: an unbackfilled row is wrong
        // in the same way it was yesterday, while a rejected initDB promise
        // would take every read of the register down with it.
        log.error('[IncidentStore] deadline backfill failed:', err.message);
    }
    return { scanned, moved };
}

// ── One-time correction of `final_report_due_at` on CRA severe incidents ───
//
// Until the CRA final clock was split by kind, every CRA row got the
// vulnerability clock (detected + 14 d, Art. 14(2)(c)). A severe incident's
// final report is due one month after its notification (Art. 14(4)(c)), so
// those rows read as overdue — a critical fail of the Art. 14 check — around
// day 14 for a report due around day 33. Same shape as backfillDeadlines:
// keyset paging, the JS rule (_severeIncidentFinalDue + nextOpenDeadline)
// rather than a second copy in SQL, a write only when the value moves, and
// `updated_at` untouched. Idempotent: a corrected row computes to its own
// value on the next run.
async function backfillCraIncidentFinals() {
    let lastId = 0;
    let scanned = 0;
    let moved = 0;
    try {
        for (let i = 0; i < BACKFILL_MAX_BATCHES; i++) {
            const batch = await getAll(`
                SELECT id, organization_id, status, kind, regimes, detected_at, deadline_at,
                       early_warning_due_at, early_warning_sent_at,
                       final_report_due_at, final_report_sent_at,
                       customer_notice_due_at, customer_notified_at,
                       authority_notified_at
                FROM compliance_incidents
                WHERE id > $1
                  AND status <> 'closed'
                  AND kind <> 'vulnerability'
                  AND regimes @> '["CRA"]'::jsonb
                  AND final_report_sent_at IS NULL
                ORDER BY id
                LIMIT $2
            `, [lastId, BACKFILL_BATCH]);
            if (!batch.length) break;
            scanned += batch.length;
            lastId = batch[batch.length - 1].id;
            for (const row of batch) {
                const finalDue = _severeIncidentFinalDue(row);
                if (!finalDue || _ms(row.final_report_due_at) === finalDue.getTime()) continue;
                const next = nextOpenDeadline({ ...row, final_report_due_at: finalDue });
                await run(`
                    UPDATE compliance_incidents SET final_report_due_at = $3, deadline_at = $4
                    WHERE organization_id = $1 AND id = $2
                `, [row.organization_id, row.id, finalDue, next]);
                moved += 1;
            }
            if (batch.length < BACKFILL_BATCH) break;
        }
        if (moved > 0) {
            log.info(`[IncidentStore] CRA final-report backfill: ${moved} of ${scanned} severe incident(s) re-dated to one month after the notification`);
        }
    } catch (err) {
        // The SQLSTATE only, and never fail the boot (see backfillDeadlines).
        log.error('[IncidentStore] CRA final-report backfill failed:', err?.code || 'unknown');
    }
    return { scanned, moved };
}

// 'critical' is the top step of the severity picker in agent-hub and has its
// own tag ("Must fix") in the incident table. It was missing here, so an
// unrecognised value fell back: a critical incident was CREATED as 'medium'
// and a raise to critical on an existing row was dropped — both under a 200.
const VALID_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const VALID_KINDS = new Set(['breach', 'security_incident', 'vulnerability']);
const VALID_STATUSES = new Set([
    'open', 'assessing', 'early_warning_sent', 'authority_notified', 'reported', 'subjects_notified', 'closed',
]);
// "Open" for the aggregates = nothing has gone to an authority yet. An early
// warning is a first contact, but the notification is still pending, so the
// row stays in the open bucket until it is reported / authority_notified.
const OPEN_STATUSES = ['open', 'assessing', 'early_warning_sent'];
/**
 * Re-stamp `deadline_at` from the row's current stamps and hand back the row
 * every mutator returns. Writes only when the value actually moves. A CRA
 * severe incident's `final_report_due_at` is re-dated first (it runs from the
 * notification, see _severeIncidentFinalDue), so the roll-up sees the new one.
 */
async function _refreshDeadline(orgId, id) {
    let row = await getIncident(orgId, id);
    if (!row) return null;
    const finalDue = _severeIncidentFinalDue(row);
    if (finalDue && _ms(row.final_report_due_at) !== finalDue.getTime()) {
        await run(`
            UPDATE compliance_incidents SET final_report_due_at = $3, updated_at = NOW()
            WHERE organization_id = $1 AND id = $2
        `, [orgId, id, finalDue]);
        row = { ...row, final_report_due_at: finalDue };
    }
    const next = nextOpenDeadline(row);
    const now = row.deadline_at ? new Date(row.deadline_at).getTime() : null;
    const wanted = next ? next.getTime() : null;
    if (now === wanted) return row;
    await run(`
        UPDATE compliance_incidents SET deadline_at = $3, updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
    `, [orgId, id, next]);
    return { ...row, deadline_at: next };
}

function _cveIds(v) {
    return _jsonArray(v).map(x => String(x).trim().toUpperCase()).filter(x => /^CVE-\d{4}-\d{4,}$/.test(x)).slice(0, 100);
}

function _products(v) {
    return _jsonArray(v)
        .filter(p => p && (typeof p === 'string' || typeof p === 'object'))
        .map(p => typeof p === 'string'
            ? { name: p.slice(0, 200), version_range: null }
            : { name: String(p.name || '').slice(0, 200), version_range: p.version_range ? String(p.version_range).slice(0, 100) : null })
        .filter(p => p.name)
        .slice(0, 100);
}

/**
 * @param {object} input
 * @param {string} input.organization_id
 * @param {string} input.title
 * @param {'breach'|'security_incident'|'vulnerability'} [input.kind='breach']
 * @param {string[]} [input.regimes] e.g. ['GDPR','NIS2'] — default GDPR (CRA for a vulnerability)
 * @param {number} [input.customerNoticeHours] the org's DORA notice window (compliance_settings.dora_customer_notice_hours)
 * @param {number} [input.customer_notice_hours] snake_case alias of customerNoticeHours
 * @param {string[]} [input.cve_ids]
 * @param {Array<{name,version_range}>} [input.affected_products]
 * @param {boolean} [input.exploited_in_wild]
 * @param {boolean} [input.actively_exploited] alias of exploited_in_wild
 * @param {string} [input.reported_via]
 * @param {string} [input.severity]
 * @param {string|Date} [input.detected_at] defaults to now
 * @param {string|Date} [input.occurred_at]
 * @param {string} [input.description]
 * @param {string} [input.source] defaults to 'manual'
 * @param {boolean} [input.high_risk]
 * @param {string} [input.created_by]
 */
async function createIncident(input) {
    await initDB();
    if (!input?.organization_id) throw new Error('organization_id is required');
    if (!input?.title) throw new Error('title is required');
    const severity = VALID_SEVERITIES.has(input.severity) ? input.severity : 'medium';
    const kind = input.kind == null ? 'breach' : String(input.kind);
    if (!VALID_KINDS.has(kind)) throw new Error(`invalid kind "${kind}"`);
    const regimes = normalizeRegimes(input.regimes, kind);
    const detectedAt = input.detected_at ? new Date(input.detected_at) : new Date();
    const clocks = computeClocks(detectedAt, {
        regimes,
        kind,
        customerNoticeHours: input.customerNoticeHours ?? input.customer_notice_hours,
    });
    const exploited = typeof input.exploited_in_wild === 'boolean' ? input.exploited_in_wild
        : typeof input.actively_exploited === 'boolean' ? input.actively_exploited : null;
    // The first ten binds are the v1 shape — callers and tests index into them.
    const { rows } = await run(`
        INSERT INTO compliance_incidents
            (organization_id, title, description, severity, source, high_risk,
             occurred_at, detected_at, deadline_at, created_by,
             kind, regimes, early_warning_due_at, final_report_due_at, customer_notice_due_at,
             cve_ids, affected_products, exploited_in_wild, reported_via)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11, $12::jsonb, $13, $14, $15, $16::jsonb, $17::jsonb, $18, $19)
        RETURNING *
    `, [
        input.organization_id,
        String(input.title).slice(0, 300),
        input.description || null,
        severity,
        input.source || 'manual',
        !!input.high_risk,
        input.occurred_at || null,
        detectedAt,
        clocks.deadline_at,
        input.created_by || null,
        kind,
        JSON.stringify(regimes),
        clocks.early_warning_due_at,
        clocks.final_report_due_at,
        clocks.customer_notice_due_at,
        JSON.stringify(_cveIds(input.cve_ids)),
        JSON.stringify(_products(input.affected_products)),
        exploited,
        input.reported_via ? String(input.reported_via).slice(0, 100) : null,
    ]);
    return rows[0];
}

/**
 * @param orgId
 * @param {{ status?: string, kind?: string, limit?: number }} [opts]
 */
async function listIncidents(orgId, { status, kind, limit = 100 } = {}) {
    await initDB();
    const params = [orgId];
    let where = 'organization_id = $1';
    if (status) { params.push(status); where += ` AND status = $${params.length}`; }
    if (kind) {
        if (!VALID_KINDS.has(kind)) throw new Error(`invalid kind "${kind}"`);
        params.push(kind); where += ` AND kind = $${params.length}`;
    }
    params.push(limit);
    return getAll(`
        SELECT * FROM compliance_incidents
        WHERE ${where}
        ORDER BY detected_at DESC
        LIMIT $${params.length}
    `, params);
}

async function getIncident(orgId, id) {
    await initDB();
    return getOne(`SELECT * FROM compliance_incidents WHERE organization_id = $1 AND id = $2`, [orgId, id]);
}

/**
 * Partial update. Status stamps are applied server-side:
 *   status=authority_notified → authority_notified_at/by + reference
 *   status=subjects_notified  → subjects_notified_at/by
 * Notes are append-only entries { at, by, text }.
 */
async function updateIncident(orgId, id, patch = {}, actorId = null) {
    await initDB();
    const existing = await getIncident(orgId, id);
    if (!existing) return null;

    const status = VALID_STATUSES.has(patch.status) ? patch.status : existing.status;
    const notes = Array.isArray(existing.notes) ? existing.notes : [];
    if (patch.note) notes.push({ at: new Date().toISOString(), by: actorId, text: String(patch.note).slice(0, 2000) });

    await run(`
        UPDATE compliance_incidents SET
            title = COALESCE($3, title),
            description = COALESCE($4, description),
            severity = COALESCE($5, severity),
            high_risk = COALESCE($6, high_risk),
            status = $7,
            occurred_at = COALESCE($8, occurred_at),
            recipients_notified_at = COALESCE($9, recipients_notified_at),
            authority_notified_at = CASE WHEN $7 = 'authority_notified' AND authority_notified_at IS NULL THEN NOW() ELSE authority_notified_at END,
            authority_reference = COALESCE($10, authority_reference),
            authority_notified_by = CASE WHEN $7 = 'authority_notified' AND authority_notified_by IS NULL THEN $11 ELSE authority_notified_by END,
            subjects_notified_at = CASE WHEN $7 = 'subjects_notified' AND subjects_notified_at IS NULL THEN NOW() ELSE subjects_notified_at END,
            subjects_notified_by = CASE WHEN $7 = 'subjects_notified' AND subjects_notified_by IS NULL THEN $11 ELSE subjects_notified_by END,
            notes = $12::jsonb,
            updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
    `, [
        orgId, id,
        patch.title || null,
        patch.description || null,
        VALID_SEVERITIES.has(patch.severity) ? patch.severity : null,
        typeof patch.high_risk === 'boolean' ? patch.high_risk : null,
        status,
        patch.occurred_at || null,
        patch.recipients_notified_at || null,
        patch.authority_reference || null,
        actorId,
        JSON.stringify(notes),
    ]);
    // A status stamp can satisfy a clock (authority_notified / closed), so the
    // roll-up has to move with it.
    return _refreshDeadline(orgId, id);
}

// ───────────────────────── CRA / NIS2 / DORA stamps ─────────────────────────

const CRA_STAGES = new Set(['early_warning', 'full']);

/**
 * Attest that a report went out (CRA Art. 14 / NIS2 Art. 23 — the platform
 * never files it). `early_warning` stamps the 24-hour clock and moves an
 * open row to `early_warning_sent`; `full` stamps the final report AND the
 * notification (a final report implies the notification was made), records
 * the reference and moves the row to `reported`. Stamps are first-wins: a
 * second call never overwrites an earlier timestamp.
 *
 * @param {string} orgId
 * @param {string} id
 * @param {{stage?:'early_warning'|'full', reportedVia?:string, reference?:string, by?:string}} [opts]
 */
async function stampCraReport(orgId, id, { stage, reportedVia, reference, by } = {}) {
    await initDB();
    if (!CRA_STAGES.has(stage)) throw new Error(`invalid stage "${stage}"`);
    const via = reportedVia ? String(reportedVia).slice(0, 100) : null;
    const ref = reference ? String(reference).slice(0, 200) : null;
    if (stage === 'early_warning') {
        await run(`
            UPDATE compliance_incidents SET
                early_warning_sent_at = COALESCE(early_warning_sent_at, NOW()),
                reported_via = COALESCE($3, reported_via),
                authority_notified_by = COALESCE(authority_notified_by, $4),
                status = CASE WHEN status IN ('open','assessing') THEN 'early_warning_sent' ELSE status END,
                updated_at = NOW()
            WHERE organization_id = $1 AND id = $2
        `, [orgId, id, via, by || null]);
    } else {
        await run(`
            UPDATE compliance_incidents SET
                final_report_sent_at = COALESCE(final_report_sent_at, NOW()),
                authority_notified_at = COALESCE(authority_notified_at, NOW()),
                authority_notified_by = COALESCE(authority_notified_by, $4),
                authority_reference = COALESCE($5, authority_reference),
                reported_via = COALESCE($3, reported_via),
                status = CASE WHEN status IN ('open','assessing','early_warning_sent') THEN 'reported' ELSE status END,
                updated_at = NOW()
            WHERE organization_id = $1 AND id = $2
        `, [orgId, id, via, by || null, ref]);
    }
    // The stamp closes a clock — `deadline_at` must fall through to the next
    // one that is still open (or to NULL when none is).
    return _refreshDeadline(orgId, id);
}

/** DORA Art. 19 / contract: the customers were told. First-wins stamp. */
async function stampCustomerNotified(orgId, id, by) {
    await initDB();
    const notes = by ? `, notes = COALESCE(notes, '[]'::jsonb) || $3::jsonb` : '';
    const params = [orgId, id];
    if (by) params.push(JSON.stringify([{ at: new Date().toISOString(), by, text: 'Customer notice sent' }]));
    await run(`
        UPDATE compliance_incidents SET
            customer_notified_at = COALESCE(customer_notified_at, NOW()),
            updated_at = NOW()${notes}
        WHERE organization_id = $1 AND id = $2
    `, params);
    return _refreshDeadline(orgId, id);
}

/**
 * Every not-closed incident with all its clock columns — the deadline feed
 * (routes/compliance/deadlines) and the NIS2 / CRA checks read this. The
 * checks filter on `regimes` / `kind` themselves.
 */
async function listOpenClocks(orgId) {
    await initDB();
    return getAll(`
        SELECT id, kind, regimes, title, severity, high_risk, status, source,
               detected_at, deadline_at,
               early_warning_due_at, early_warning_sent_at,
               final_report_due_at, final_report_sent_at,
               customer_notice_due_at, customer_notified_at,
               authority_notified_at, authority_reference, reported_via,
               exploited_in_wild, cve_ids, affected_products
        FROM compliance_incidents
        WHERE organization_id = $1 AND status <> 'closed'
        ORDER BY deadline_at ASC, detected_at DESC
    `, [orgId]);
}

/**
 * Aggregates for the Art-33 check and the deadline notifier:
 *   open                — incidents still in open/assessing/early_warning_sent
 *   overdue_unnotified  — past deadline_at without an authority notification
 *   nearing_deadline    — within 24h of deadline, not yet notified
 *   vulnerabilities_open — kind='vulnerability' and not closed
 *   gdpr_overdue_unnotified / gdpr_nearing_deadline — the same two, but for
 *                         the GDPR Art. 33 clock only: incidents under the
 *                         GDPR regime, measured from detected_at + 72 h.
 *
 * `deadline_at` is the EARLIEST open clock over every regime (a NIS2/CRA 24 h
 * early warning, a DORA customer notice), so the first two counts cannot say
 * whether the 72-hour Art. 33 deadline has passed: a GDPR+NIS2 incident is
 * "overdue" at hour 25, a CRA-only vulnerability is never a GDPR matter. The
 * Art-33 check reads the gdpr_* counts; counts.js and ISO A.5.24 keep reading
 * the roll-up, which is what they mean.
 */
const GDPR_NOTIFICATION_HOURS = REGIME_CLOCKS.GDPR.notificationHours;
async function getDeadlineStats(orgId) {
    await initDB();
    const gdprDue = `detected_at + INTERVAL '${GDPR_NOTIFICATION_HOURS} hours'`;
    const gdprOpen = `status = ANY($2) AND regimes @> '["GDPR"]'::jsonb AND authority_notified_at IS NULL`;
    const row = await getOne(`
        SELECT
            COUNT(*) FILTER (WHERE status = ANY($2))::int AS open,
            COUNT(*) FILTER (
                WHERE status = ANY($2) AND authority_notified_at IS NULL AND deadline_at < NOW()
            )::int AS overdue_unnotified,
            COUNT(*) FILTER (
                WHERE status = ANY($2) AND authority_notified_at IS NULL
                  AND deadline_at >= NOW() AND deadline_at < NOW() + INTERVAL '24 hours'
            )::int AS nearing_deadline,
            COUNT(*) FILTER (WHERE kind = 'vulnerability' AND status <> 'closed')::int AS vulnerabilities_open,
            COUNT(*) FILTER (
                WHERE ${gdprOpen} AND ${gdprDue} < NOW()
            )::int AS gdpr_overdue_unnotified,
            COUNT(*) FILTER (
                WHERE ${gdprOpen} AND ${gdprDue} >= NOW() AND ${gdprDue} < NOW() + INTERVAL '24 hours'
            )::int AS gdpr_nearing_deadline
        FROM compliance_incidents
        WHERE organization_id = $1
    `, [orgId, OPEN_STATUSES]);
    return row || {
        open: 0, overdue_unnotified: 0, nearing_deadline: 0, vulnerabilities_open: 0,
        gdpr_overdue_unnotified: 0, gdpr_nearing_deadline: 0,
    };
}

/** Open incidents whose deadline is near or past — for the daily notifier. */
async function listNeedingAttention(orgId) {
    await initDB();
    return getAll(`
        SELECT id, title, severity, high_risk, status, kind, regimes, detected_at, deadline_at, authority_notified_at
        FROM compliance_incidents
        WHERE organization_id = $1
          AND status = ANY($2)
          AND authority_notified_at IS NULL
          AND deadline_at < NOW() + INTERVAL '24 hours'
        ORDER BY deadline_at ASC
    `, [orgId, OPEN_STATUSES]);
}

/** True when an auto-created incident already exists recently — dedupes signals. */
async function hasRecentAutoIncident(orgId, source, hours = 24) {
    await initDB();
    const row = await getOne(`
        SELECT id FROM compliance_incidents
        WHERE organization_id = $1 AND source = $2
          AND detected_at >= NOW() - ($3 || ' hours')::interval
        LIMIT 1
    `, [orgId, source, String(hours)]);
    return !!row;
}

module.exports = {
    initDB,
    backfillDeadlines,
    backfillCraIncidentFinals,
    createIncident,
    listIncidents,
    getIncident,
    updateIncident,
    stampCraReport,
    stampCustomerNotified,
    listOpenClocks,
    getDeadlineStats,
    listNeedingAttention,
    hasRecentAutoIncident,
    computeClocks,
    nextOpenDeadline,
    normalizeRegimes,
    DEADLINE_HOURS,
    DEFAULT_CUSTOMER_NOTICE_HOURS,
    REGIME_CLOCKS,
    VALID_KINDS: [...VALID_KINDS],
    VALID_REGIMES: [...VALID_REGIMES],
    VALID_STATUSES: [...VALID_STATUSES],
    OPEN_STATUSES: [...OPEN_STATUSES],
};
