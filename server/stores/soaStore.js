// @typecheck
/**
 * SoA Store — Statement of Applicability rows (ISO 27001 clause 6.1.3 d).
 *
 * One row per org per Annex A control (93 when fully seeded). Auditors sample
 * the decision TRAIL, not a generated document — so applicability, justification
 * and ownership live as versionable rows and the PDF is only a render. Exports
 * snapshot into the compliance_evidence chain (mirrors the ROPA export).
 *
 * `source` records HOW the control is satisfied:
 *   'auto'      — continuously verified from Bee Flow's own signals
 *   'connector' — verified via an external-system evidence connector
 *   'attest'    — self-attested, typically tied to an ISMS document
 *   'inherited' — inherited from the IaaS provider (physical controls)
 *
 * `how_met` is the auditor-facing sentence — HOW the control is implemented
 * here ("MFA enforced via SSO; break-glass account in the vault") — distinct
 * from `justification`, which explains the applicability decision.
 */

const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');

const initDB = makeStoreInit('SoaStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS iso_soa_entries (
            organization_id TEXT NOT NULL,
            control_ref TEXT NOT NULL,
            applicable BOOLEAN NOT NULL DEFAULT TRUE,
            justification TEXT,
            source TEXT NOT NULL DEFAULT 'attest',
            status TEXT NOT NULL DEFAULT 'todo',
            owner_user_id TEXT,
            evidence_ref TEXT,
            updated_by TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (organization_id, control_ref)
        )
    `);
    // Compliance Center redesign (2026-09): the implementation statement.
    await runDdl('soaStore', [
        `ALTER TABLE iso_soa_entries ADD COLUMN IF NOT EXISTS how_met TEXT`,
    ]);
}

const VALID_SOURCES = new Set(['auto', 'connector', 'attest', 'inherited']);
const VALID_STATUSES = new Set(['todo', 'reviewed', 'approved']);

async function listEntries(orgId) {
    await initDB();
    return getAll(`
        SELECT * FROM iso_soa_entries
        WHERE organization_id = $1
        ORDER BY control_ref
    `, [orgId]);
}

async function getEntry(orgId, controlRef) {
    await initDB();
    return getOne(`
        SELECT * FROM iso_soa_entries
        WHERE organization_id = $1 AND control_ref = $2
    `, [orgId, controlRef]);
}

/**
 * Upsert one SoA row. Only whitelisted fields are writable; everything else in
 * `patch` is silently dropped (same stance as complianceStore.saveSettings).
 */
async function upsertEntry(orgId, controlRef, patch, actorId) {
    await initDB();
    const existing = await getEntry(orgId, controlRef);
    const safe = {
        applicable: typeof patch.applicable === 'boolean' ? patch.applicable : (existing?.applicable ?? true),
        justification: patch.justification !== undefined ? (patch.justification || null) : (existing?.justification ?? null),
        source: VALID_SOURCES.has(patch.source) ? patch.source : (existing?.source || 'attest'),
        status: VALID_STATUSES.has(patch.status) ? patch.status : (existing?.status || 'todo'),
        owner_user_id: patch.owner_user_id !== undefined ? (patch.owner_user_id || null) : (existing?.owner_user_id ?? null),
        evidence_ref: patch.evidence_ref !== undefined ? (patch.evidence_ref || null) : (existing?.evidence_ref ?? null),
        how_met: patch.how_met !== undefined ? (patch.how_met ? String(patch.how_met).slice(0, 4000) : null) : (existing?.how_met ?? null),
    };
    // how_met is bound LAST ($10) so the v1 positions stay stable for callers/tests.
    await run(`
        INSERT INTO iso_soa_entries
            (organization_id, control_ref, applicable, justification, source, status,
             owner_user_id, evidence_ref, updated_by, updated_at, how_met)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10)
        ON CONFLICT (organization_id, control_ref) DO UPDATE SET
            applicable = EXCLUDED.applicable,
            justification = EXCLUDED.justification,
            source = EXCLUDED.source,
            status = EXCLUDED.status,
            owner_user_id = EXCLUDED.owner_user_id,
            evidence_ref = EXCLUDED.evidence_ref,
            how_met = EXCLUDED.how_met,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
    `, [
        orgId, controlRef,
        safe.applicable, safe.justification, safe.source, safe.status,
        safe.owner_user_id, safe.evidence_ref, actorId || null,
        safe.how_met,
    ]);
    return getEntry(orgId, controlRef);
}

/**
 * Seed missing rows only — never overwrites an existing decision. `seeds` is
 * [{ control_ref, applicable, source, justification }]; returns how many rows
 * were actually inserted.
 */
async function seedMissing(orgId, seeds, actorId) {
    await initDB();
    let inserted = 0;
    for (const s of seeds || []) {
        if (!s?.control_ref) continue;
        const r = await run(`
            INSERT INTO iso_soa_entries
                (organization_id, control_ref, applicable, justification, source, status, updated_by)
            VALUES ($1, $2, $3, $4, $5, 'todo', $6)
            ON CONFLICT (organization_id, control_ref) DO NOTHING
        `, [
            orgId, s.control_ref,
            s.applicable !== false,
            s.justification || null,
            VALID_SOURCES.has(s.source) ? s.source : 'attest',
            actorId || null,
        ]);
        if (r?.rowCount) inserted += r.rowCount;
    }
    return inserted;
}

/** Row counts for the readiness dashboard's "SoA completeness" number. */
async function getStats(orgId) {
    await initDB();
    const rows = await getAll(`
        SELECT status, applicable, COUNT(*)::int AS n
        FROM iso_soa_entries
        WHERE organization_id = $1
        GROUP BY status, applicable
    `, [orgId]);
    const stats = { total: 0, approved: 0, reviewed: 0, todo: 0, excluded: 0 };
    for (const r of rows) {
        stats.total += r.n;
        if (!r.applicable) stats.excluded += r.n;
        if (stats[r.status] !== undefined) stats[r.status] += r.n;
    }
    return stats;
}

module.exports = {
    initDB,
    listEntries,
    getEntry,
    upsertEntry,
    seedMissing,
    getStats,
};
