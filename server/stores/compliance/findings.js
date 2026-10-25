// @typecheck
/**
 * The Compliance Center's own small tables: the deadline notifier's
 * idempotency log, finding states, subject registrations and the end-user
 * hint dismissals. Their DDL (FINDING_DDL) lives here too; schema.js runs it.
 *
 * The db helpers and the store's initDB come in from the barrel
 * (stores/complianceStore.js), so this module requires no database itself.
 */

// ───────────────────────── Finding states, registrations, hints ─────────────
//
// Three small tables the Compliance Center writes for itself:
//
//   compliance_finding_states        an admin's decision about ONE finding
//                                    (acknowledged / accepted risk / snoozed).
//                                    compliance_checks stays the truth; this
//                                    only hides a finding from the attention
//                                    list and the counts while its fingerprint
//                                    (status + a stable evidence subset) is
//                                    unchanged. A worse finding re-opens.
//   compliance_subject_registrations the processing record an admin keeps for
//                                    a subject that has no register of its own
//                                    (a collaborative project): purpose, lawful
//                                    basis, retention. Read by
//                                    GDPR-Art30-project-personal-data and the
//                                    RoPA builder.
//   project_hint_dismissals          per person, per project: the one end-user
//                                    hint they dismissed (until its fingerprint
//                                    changes) or snoozed (until a date). On the
//                                    server so it follows them across devices.
const FINDING_STATES = Object.freeze(['acknowledged', 'accepted_risk', 'snoozed']);

const FINDING_DDL = [
    `CREATE TABLE IF NOT EXISTS compliance_finding_states (
        organization_id TEXT NOT NULL,
        check_id        TEXT NOT NULL,
        scope_key       TEXT NOT NULL,
        fingerprint     TEXT NOT NULL,
        state           TEXT NOT NULL
                        CHECK (state IN ('acknowledged', 'accepted_risk', 'snoozed')),
        reason          TEXT,
        until           TIMESTAMPTZ,
        actor_id        TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (organization_id, check_id, scope_key)
    )`,
    `CREATE TABLE IF NOT EXISTS compliance_subject_registrations (
        organization_id TEXT NOT NULL,
        subject_kind    TEXT NOT NULL,
        subject_id      TEXT NOT NULL,
        purpose         TEXT,
        lawful_basis    TEXT,
        retention_days  INTEGER,
        confirmed_by    TEXT,
        confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (organization_id, subject_kind, subject_id)
    )`,
    `CREATE TABLE IF NOT EXISTS project_hint_dismissals (
        user_id        TEXT NOT NULL,
        project_id     TEXT NOT NULL,
        hint_key       TEXT NOT NULL,
        fingerprint    TEXT,
        snoozed_until  TIMESTAMPTZ,
        dismissed_at   TIMESTAMPTZ,
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, project_id, hint_key)
    )`,
];

// ───────────────────────── Finding states ─────────────────────────

/**
 * @param {string | number | Date} v
 */
const _iso = (v) => (v == null ? null : new Date(v).toISOString());

function _stateRow(r) {
    if (!r) return null;
    return {
        check_id: r.check_id,
        scope_key: r.scope_key,
        fingerprint: r.fingerprint,
        state: r.state,
        reason: r.reason ?? null,
        until: _iso(r.until),
        actor_id: r.actor_id ?? null,
        created_at: _iso(r.created_at),
        updated_at: _iso(r.updated_at),
    };
}

// ───────────────────────── Subject registrations ─────────────────────────

function _registrationRow(r) {
    if (!r) return null;
    return {
        subject_kind: r.subject_kind,
        subject_id: r.subject_id,
        purpose: r.purpose ?? null,
        lawful_basis: r.lawful_basis ?? null,
        retention_days: r.retention_days == null ? null : Number(r.retention_days),
        confirmed_by: r.confirmed_by ?? null,
        confirmed_at: _iso(r.confirmed_at),
    };
}

/**
 * @param {{ run: Function, getOne: Function, getAll: Function, initDB: () => Promise<any> }} deps
 */
function createFindings({ run, getOne, getAll, initDB }) {
    // ───────────────────────── Notifier idempotency ─────────────────────────
    //
    // The deadline notifier fires tiers (DSR 7 d/1 d/overdue, CRA 24 h/72 h,
    // calendar milestones 30/7/0 d, attestation expiries). Each tier is recorded
    // once per subject; a sweep that finds the row already there sends nothing.

    /** @returns {Promise<boolean>} true when this call inserted the row (= send now). */
    async function markNotified(orgId, subjectKind, subjectId, offsetKey) {
        await initDB();
        const r = await run(`
            INSERT INTO compliance_notify_log (organization_id, subject_kind, subject_id, offset_key)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (organization_id, subject_kind, subject_id, offset_key) DO NOTHING
        `, [orgId, String(subjectKind), String(subjectId), String(offsetKey)]);
        return (r?.rowCount || 0) > 0;
    }

    async function wasNotified(orgId, subjectKind, subjectId, offsetKey) {
        await initDB();
        const row = await getOne(`
            SELECT 1 AS hit FROM compliance_notify_log
            WHERE organization_id = $1 AND subject_kind = $2 AND subject_id = $3 AND offset_key = $4
        `, [orgId, String(subjectKind), String(subjectId), String(offsetKey)]);
        return !!row;
    }

    /** Every recorded decision of an org (a few rows per check at most). */
    async function listFindingStates(orgId) {
        await initDB();
        const rows = await getAll(`
            SELECT check_id, scope_key, fingerprint, state, reason, until, actor_id, created_at, updated_at
            FROM compliance_finding_states
            WHERE organization_id = $1
        `, [orgId]);
        return (rows || []).map(_stateRow);
    }

    /**
     * Record (or replace) the decision about one finding. `scopeKey` is the
     * result row's scope_id, or 'global'. The caller computes the fingerprint
     * (compliance/findingState.js) from the row the admin looked at.
     */
    async function setFindingState(orgId, { checkId, scopeKey, fingerprint, state, reason = null, until = null, actorId = null }) {
        await initDB();
        if (!FINDING_STATES.includes(state)) throw new Error(`Unknown finding state: ${state}`);
        const row = await getOne(`
            INSERT INTO compliance_finding_states
                (organization_id, check_id, scope_key, fingerprint, state, reason, until, actor_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (organization_id, check_id, scope_key) DO UPDATE SET
                fingerprint = EXCLUDED.fingerprint,
                state = EXCLUDED.state,
                reason = EXCLUDED.reason,
                until = EXCLUDED.until,
                actor_id = EXCLUDED.actor_id,
                updated_at = NOW()
            RETURNING check_id, scope_key, fingerprint, state, reason, until, actor_id, created_at, updated_at
        `, [orgId, String(checkId), String(scopeKey), String(fingerprint), state, reason, until, actorId]);
        return _stateRow(row);
    }

    /** Re-open a finding: forget the decision. Returns true when one existed. */
    async function clearFindingState(orgId, checkId, scopeKey) {
        await initDB();
        const r = await run(`
            DELETE FROM compliance_finding_states
            WHERE organization_id = $1 AND check_id = $2 AND scope_key = $3
        `, [orgId, String(checkId), String(scopeKey)]);
        return (r?.rowCount || 0) > 0;
    }

    /** The org's processing records for one kind of subject ('project'). */
    async function listSubjectRegistrations(orgId, subjectKind) {
        await initDB();
        const rows = await getAll(`
            SELECT subject_kind, subject_id, purpose, lawful_basis, retention_days, confirmed_by, confirmed_at
            FROM compliance_subject_registrations
            WHERE organization_id = $1 AND subject_kind = $2
            ORDER BY confirmed_at DESC
        `, [orgId, String(subjectKind)]);
        return (rows || []).map(_registrationRow);
    }

    /** Record or re-confirm one processing record; confirmed_at moves to NOW(). */
    async function upsertSubjectRegistration(orgId, { subjectKind, subjectId, purpose = null, lawfulBasis = null, retentionDays = null, confirmedBy = null }) {
        await initDB();
        const row = await getOne(`
            INSERT INTO compliance_subject_registrations
                (organization_id, subject_kind, subject_id, purpose, lawful_basis, retention_days, confirmed_by, confirmed_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            ON CONFLICT (organization_id, subject_kind, subject_id) DO UPDATE SET
                purpose = EXCLUDED.purpose,
                lawful_basis = EXCLUDED.lawful_basis,
                retention_days = EXCLUDED.retention_days,
                confirmed_by = EXCLUDED.confirmed_by,
                confirmed_at = NOW()
            RETURNING subject_kind, subject_id, purpose, lawful_basis, retention_days, confirmed_by, confirmed_at
        `, [orgId, String(subjectKind), String(subjectId), purpose, lawfulBasis, retentionDays, confirmedBy]);
        return _registrationRow(row);
    }

    async function deleteSubjectRegistration(orgId, subjectKind, subjectId) {
        await initDB();
        const r = await run(`
            DELETE FROM compliance_subject_registrations
            WHERE organization_id = $1 AND subject_kind = $2 AND subject_id = $3
        `, [orgId, String(subjectKind), String(subjectId)]);
        return (r?.rowCount || 0) > 0;
    }

    // ───────────────────────── End-user hint dismissals ─────────────────────────

    /** `{[hintKey]: {fingerprint, snoozedUntil, dismissedAt}}` for one person in one project. */
    async function getHintDismissals(userId, projectId) {
        await initDB();
        const rows = await getAll(`
            SELECT hint_key, fingerprint, snoozed_until, dismissed_at
            FROM project_hint_dismissals
            WHERE user_id = $1 AND project_id = $2
        `, [String(userId), String(projectId)]);
        const out = {};
        for (const r of rows || []) {
            out[r.hint_key] = {
                fingerprint: r.fingerprint ?? null,
                snoozedUntil: _iso(r.snoozed_until),
                dismissedAt: _iso(r.dismissed_at),
            };
        }
        return out;
    }

    /**
     * Dismiss (`snoozedUntil` null) or snooze one hint. A dismissal stores the
     * fingerprint it was made against, so the hint returns only when what it
     * reports changes; a snooze lapses by date whatever the fingerprint.
     */
    async function recordHintDismissal(userId, projectId, hintKey, { fingerprint = null, snoozedUntil = null } = {}) {
        await initDB();
        await run(`
            INSERT INTO project_hint_dismissals (user_id, project_id, hint_key, fingerprint, snoozed_until, dismissed_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::timestamptz IS NULL THEN NOW() ELSE NULL END, NOW())
            ON CONFLICT (user_id, project_id, hint_key) DO UPDATE SET
                fingerprint = EXCLUDED.fingerprint,
                snoozed_until = EXCLUDED.snoozed_until,
                dismissed_at = EXCLUDED.dismissed_at,
                updated_at = NOW()
        `, [String(userId), String(projectId), String(hintKey), fingerprint, snoozedUntil]);
    }

    // A table this install never created holds nothing to erase — and erasing a
    // person must not create the compliance schema on the way.
    /**
     * @param {string} sql
     */
    async function _deleteHintRows(sql, params) {
        try {
            const r = await run(sql, params);
            return r?.rowCount || 0;
        } catch (e) {
            if (e?.code === '42P01') return 0;
            throw e;
        }
    }

    /**
     * Account erasure (stores/user/projectErasure.js): every hint this person put
     * away. The rows say which projects they belonged to and when they acted, and
     * a later account that reused the id would inherit their dismissals.
     */
    async function eraseHintDismissals(userId) {
        if (!userId) return { rows: 0 };
        const rows = await _deleteHintRows('DELETE FROM project_hint_dismissals WHERE user_id = $1', [String(userId)]);
        return { rows };
    }

    /**
     * The dismissals whose project or person no longer exists — whatever path
     * removed them (the project's delete route, the cascade that takes an erased
     * owner's projects with them, a directory sync). The table has no foreign key
     * (the compliance schema may be created before the projects table exists), so
     * the compliance sweep runs this once per tick (compliance/scheduler.js).
     */
    async function pruneHintDismissals() {
        const rows = await _deleteHintRows(`
            DELETE FROM project_hint_dismissals d
            WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = d.project_id)
               OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = d.user_id)
        `, []);
        return { rows };
    }

    return {
        markNotified,
        wasNotified,
        listFindingStates,
        setFindingState,
        clearFindingState,
        listSubjectRegistrations,
        upsertSubjectRegistration,
        deleteSubjectRegistration,
        getHintDismissals,
        recordHintDismissal,
        eraseHintDismissals,
        pruneHintDismissals,
    };
}

module.exports = { FINDING_STATES, FINDING_DDL, createFindings };

/**
 * @typedef {{ check_id: string, scope_key: string, fingerprint: string, state: string, reason?: string | null, until?: string | Date | null, actor_id?: string | null, created_at: string | Date, updated_at: string | Date }} FindingStateDbRow
 */

/**
 * @typedef {{ subject_kind: string, subject_id: string, purpose?: string | null, lawful_basis?: string | null, retention_days?: number | string | null, confirmed_by?: string | null, confirmed_at: string | Date }} RegistrationDbRow
 */
