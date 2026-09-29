// @typecheck
/**
 * Custom Framework Store — org-defined compliance frameworks (a customer
 * questionnaire, a sector code, an internal standard) and the attestations
 * that answer them.
 *
 * Three tables:
 *   compliance_custom_frameworks  one per org × code (^[A-Z0-9_]{2,24}$); status draft|active|archived
 *   compliance_custom_checks      the items; UNIQUE (framework_id, ref); `mapped_check_id` names a
 *                                 built-in check that satisfies the item automatically
 *   compliance_attestations       APPEND-ONLY answers, keyed by check_id ('CUSTOM-<CODE>-<REF>' or a
 *                                 built-in id such as MACHINERY-Art18-…) + optional subject_id.
 *                                 "Latest" = newest row with superseded_at IS NULL; a new attestation
 *                                 supersedes the previous one in the same transaction.
 *
 * Custom checks are NOT registered in compliance/registry.js (that registry
 * is process-wide, these are per org). compliance/custom/runner.js evaluates
 * them per run and persists results through complianceStore.recordCheckResult
 * with regulation 'CUSTOM' and framework_code = the framework's code; the
 * check id is `customCheckId(code, ref)` from this module so both sides agree.
 *
 * The `code` is part of every persisted check id and attestation, so it is
 * immutable after creation — updateFramework refuses it.
 */

const { run, getOne, getAll, exec, withTransaction } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');

const initDB = makeStoreInit('CustomFrameworkStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS compliance_custom_frameworks (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id TEXT NOT NULL,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            reference TEXT,
            description TEXT,
            attestation_valid_months INTEGER NOT NULL DEFAULT 12,
            status TEXT NOT NULL DEFAULT 'draft',
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (organization_id, code)
        )
    `);
    await exec(`
        CREATE TABLE IF NOT EXISTS compliance_custom_checks (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            framework_id UUID NOT NULL REFERENCES compliance_custom_frameworks(id) ON DELETE CASCADE,
            organization_id TEXT NOT NULL,
            ref TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            severity TEXT NOT NULL DEFAULT 'medium',
            evidence_required BOOLEAN NOT NULL DEFAULT false,
            mapped_check_id TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (framework_id, ref)
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_custom_checks_org_fw ON compliance_custom_checks(organization_id, framework_id, sort_order)`);
    await exec(`
        CREATE TABLE IF NOT EXISTS compliance_attestations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id TEXT NOT NULL,
            check_id TEXT NOT NULL,
            subject_id TEXT,
            outcome TEXT NOT NULL,
            statement TEXT,
            evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
            attested_by TEXT,
            attested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ,
            superseded_at TIMESTAMPTZ
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_attestations_lookup ON compliance_attestations(organization_id, check_id, subject_id, attested_at DESC)`);
}

const CODE_RE = /^[A-Z0-9_]{2,24}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,39}$/;
const FRAMEWORK_STATUSES = new Set(['draft', 'active', 'archived']);
const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const OUTCOMES = new Set(['compliant', 'partial', 'non_compliant', 'not_applicable']);
const MAX_CHECKS_PER_UPSERT = 500;

class InvalidCodeError extends Error {
    constructor(code) {
        super(`invalid framework code "${code}" — expected ${CODE_RE}`);
        this.name = 'InvalidCodeError';
        this.code = 'custom_framework_code_invalid';
    }
}
class CodeTakenError extends Error {
    constructor(code) {
        super(`framework code "${code}" already exists in this organisation`);
        this.name = 'CodeTakenError';
        this.code = 'custom_framework_code_taken';
    }
}

function normalizeCode(code) {
    const c = String(code || '').trim().toUpperCase();
    if (!CODE_RE.test(c)) throw new InvalidCodeError(code);
    return c;
}

/**
 * The persisted check id for a custom item: 'CUSTOM-<CODE>-<REFSLUG>'.
 * The ref keeps letters, digits and dots (so 'A.5.1' reads like an ISO ref);
 * everything else collapses to a single dash.
 */
function refSlug(ref) {
    return String(ref || '').trim().replace(/[^A-Za-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
}
function customCheckId(frameworkCode, ref) {
    const code = normalizeCode(frameworkCode);
    const slug = refSlug(ref);
    if (!slug) throw new Error('ref is required');
    return `CUSTOM-${code}-${slug}`;
}

function _text(v, max) {
    if (v == null) return null;
    const s = String(v).trim();
    return s ? s.slice(0, max) : null;
}
function _months(v, fallback) {
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 120) throw new Error('attestation_valid_months must be 1..120');
    return n;
}
function _isUniqueViolation(e) {
    return e && e.code === '23505';
}

const FW_COLUMNS = `f.id, f.organization_id, f.code, f.name, f.reference, f.description, f.attestation_valid_months,
               f.status, f.created_by, f.created_at, f.updated_at`;

// ───────────────────────── Frameworks ─────────────────────────

async function listFrameworks(orgId, { includeArchived = false } = {}) {
    await initDB();
    const params = [orgId];
    let where = `f.organization_id = $1`;
    if (!includeArchived) where += ` AND f.status <> 'archived'`;
    return getAll(`
        SELECT ${FW_COLUMNS},
               (SELECT COUNT(*)::int FROM compliance_custom_checks c WHERE c.framework_id = f.id) AS checks_count
        FROM compliance_custom_frameworks f
        WHERE ${where}
        ORDER BY f.status = 'active' DESC, f.name ASC
    `, params);
}

async function getFramework(orgId, id) {
    await initDB();
    if (!id) return null;
    return getOne(`
        SELECT ${FW_COLUMNS},
               (SELECT COUNT(*)::int FROM compliance_custom_checks c WHERE c.framework_id = f.id) AS checks_count
        FROM compliance_custom_frameworks f
        WHERE f.organization_id = $1 AND f.id = $2
    `, [orgId, String(id)]);
}

async function getFrameworkByCode(orgId, code) {
    await initDB();
    return getOne(`
        SELECT ${FW_COLUMNS}
        FROM compliance_custom_frameworks f
        WHERE f.organization_id = $1 AND f.code = $2
    `, [orgId, normalizeCode(code)]);
}

/**
 * @param {string} orgId
 * @param {{code?:string, name?:string, reference?:string, description?:string,
 *          attestationValidMonths?:number, attestation_valid_months?:number,
 *          status?:string, createdBy?:string, created_by?:string}} [input]
 *          `status` is 'draft' or 'active'; anything else is rejected.
 * @throws {InvalidCodeError|CodeTakenError}
 */
async function createFramework(orgId, input = {}) {
    await initDB();
    if (!orgId) throw new Error('organization_id is required');
    const code = normalizeCode(input.code);
    const name = _text(input.name, 200);
    if (!name) throw new Error('name is required');
    const status = input.status === undefined ? 'draft' : input.status;
    if (status === 'archived' || !FRAMEWORK_STATUSES.has(status)) throw new Error(`invalid status "${status}"`);
    try {
        const { rows } = await run(`
            INSERT INTO compliance_custom_frameworks
                (organization_id, code, name, reference, description, attestation_valid_months, status, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, organization_id, code, name, reference, description, attestation_valid_months,
                      status, created_by, created_at, updated_at
        `, [
            orgId, code, name,
            _text(input.reference, 300),
            _text(input.description, 4000),
            _months(input.attestationValidMonths ?? input.attestation_valid_months, 12),
            status,
            input.createdBy || input.created_by || null,
        ]);
        return rows[0] || null;
    } catch (e) {
        if (_isUniqueViolation(e)) throw new CodeTakenError(code);
        throw e;
    }
}

/**
 * Whitelisted patch: name, reference, description, attestation_valid_months,
 * status (draft|active — archiving goes through archiveFramework). `code`
 * is immutable: persisted check ids embed it.
 */
async function updateFramework(orgId, id, patch = {}) {
    await initDB();
    if (patch.code !== undefined) throw new Error('code is immutable — create a new framework instead');
    const existing = await getFramework(orgId, id);
    if (!existing) return null;
    const status = patch.status === undefined ? existing.status : patch.status;
    if (!FRAMEWORK_STATUSES.has(status) || status === 'archived') throw new Error(`invalid status "${status}"`);
    const name = patch.name === undefined ? existing.name : _text(patch.name, 200);
    if (!name) throw new Error('name is required');
    await run(`
        UPDATE compliance_custom_frameworks SET
            name = $3,
            reference = $4,
            description = $5,
            attestation_valid_months = $6,
            status = $7,
            updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
    `, [
        orgId, String(id),
        name,
        patch.reference === undefined ? existing.reference : _text(patch.reference, 300),
        patch.description === undefined ? existing.description : _text(patch.description, 4000),
        _months(patch.attestationValidMonths ?? patch.attestation_valid_months, existing.attestation_valid_months),
        status,
    ]);
    return getFramework(orgId, id);
}

/** Archived frameworks keep their checks and attestations; the runner skips them. */
async function archiveFramework(orgId, id) {
    await initDB();
    const r = await run(`
        UPDATE compliance_custom_frameworks SET status = 'archived', updated_at = NOW()
        WHERE organization_id = $1 AND id = $2 AND status <> 'archived'
    `, [orgId, String(id)]);
    return (r?.rowCount || 0) > 0;
}

// ───────────────────────── Checks ─────────────────────────

async function listChecks(orgId, frameworkId) {
    await initDB();
    return getAll(`
        SELECT id, framework_id, organization_id, ref, title, description, severity, evidence_required,
               mapped_check_id, sort_order, created_at, updated_at
        FROM compliance_custom_checks
        WHERE organization_id = $1 AND framework_id = $2
        ORDER BY sort_order ASC, ref ASC
    `, [orgId, String(frameworkId)]);
}

async function getCheck(orgId, checkRowId) {
    await initDB();
    return getOne(`
        SELECT c.id, c.framework_id, c.organization_id, c.ref, c.title, c.description, c.severity, c.evidence_required,
               c.mapped_check_id, c.sort_order, c.created_at, c.updated_at, f.code AS framework_code
        FROM compliance_custom_checks c
        JOIN compliance_custom_frameworks f ON f.id = c.framework_id
        WHERE c.organization_id = $1 AND c.id = $2
    `, [orgId, String(checkRowId)]);
}

function _normalizeCheckRow(row, index) {
    const ref = _text(row?.ref, 40);
    if (!ref || !REF_RE.test(ref)) throw new Error(`row ${index + 1}: ref is required (letters, digits, . _ - and spaces; max 40)`);
    const title = _text(row.title, 300);
    if (!title) throw new Error(`row ${index + 1} (${ref}): title is required`);
    const severity = row.severity == null || row.severity === '' ? 'medium' : String(row.severity).toLowerCase();
    if (!SEVERITIES.has(severity)) throw new Error(`row ${index + 1} (${ref}): invalid severity "${row.severity}"`);
    const evidenceRequired = row.evidence_required === true || row.evidence_required === 'true' || row.evidence_required === 1
        || row.evidenceRequired === true;
    const sortOrder = row.sort_order ?? row.sortOrder;
    return {
        ref,
        title,
        description: _text(row.description, 4000),
        severity,
        evidence_required: evidenceRequired,
        mapped_check_id: _text(row.mapped_check_id ?? row.mappedCheckId, 120),
        sort_order: Number.isInteger(Number(sortOrder)) ? Number(sortOrder) : index,
    };
}

/**
 * Bulk upsert by `ref` (the pasted-questionnaire import). The framework must
 * belong to the org — a foreign framework id upserts nothing and returns null.
 * Existing rows with a ref not in `rows` are left alone (use deleteCheck).
 */
async function upsertChecks(orgId, frameworkId, rows) {
    await initDB();
    const fw = await getFramework(orgId, frameworkId);
    if (!fw) return null;
    const list = Array.isArray(rows) ? rows : [];
    if (list.length > MAX_CHECKS_PER_UPSERT) throw new Error(`at most ${MAX_CHECKS_PER_UPSERT} checks per upsert`);
    const normalized = list.map(_normalizeCheckRow);
    const seen = new Set();
    for (const r of normalized) {
        const key = r.ref.toLowerCase();
        if (seen.has(key)) throw new Error(`duplicate ref "${r.ref}" in the same batch`);
        seen.add(key);
    }
    for (const r of normalized) {
        await run(`
            INSERT INTO compliance_custom_checks
                (framework_id, organization_id, ref, title, description, severity, evidence_required, mapped_check_id, sort_order)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (framework_id, ref) DO UPDATE SET
                title = EXCLUDED.title,
                description = EXCLUDED.description,
                severity = EXCLUDED.severity,
                evidence_required = EXCLUDED.evidence_required,
                mapped_check_id = EXCLUDED.mapped_check_id,
                sort_order = EXCLUDED.sort_order,
                updated_at = NOW()
            WHERE compliance_custom_checks.organization_id = $2
        `, [fw.id, orgId, r.ref, r.title, r.description, r.severity, r.evidence_required, r.mapped_check_id, r.sort_order]);
    }
    if (normalized.length) {
        await run(`UPDATE compliance_custom_frameworks SET updated_at = NOW() WHERE organization_id = $1 AND id = $2`, [orgId, fw.id]);
    }
    return listChecks(orgId, fw.id);
}

/** Removes the item; its attestations stay (append-only history). */
async function deleteCheck(orgId, checkRowId) {
    await initDB();
    const r = await run(`
        DELETE FROM compliance_custom_checks
        WHERE organization_id = $1 AND id = $2
    `, [orgId, String(checkRowId)]);
    return (r?.rowCount || 0) > 0;
}

// ───────────────────────── Attestations ─────────────────────────

function _evidenceRefs(v) {
    const list = Array.isArray(v) ? v : [];
    return list
        .filter(e => e && typeof e === 'object')
        .map(e => ({
            evidence_id: e.evidence_id ?? e.id ?? null,
            sha256: e.sha256 ? String(e.sha256).toLowerCase().slice(0, 64) : null,
            filename: e.filename ? String(e.filename).slice(0, 255) : null,
        }))
        .filter(e => e.evidence_id != null || e.sha256)
        .slice(0, 50);
}

const ATT_COLUMNS = `id, organization_id, check_id, subject_id, outcome, statement, evidence_refs,
               attested_by, attested_at, expires_at, superseded_at`;

/**
 * Append an attestation and supersede the previous latest for the same
 * (check_id, subject_id) in one transaction. `expiresAt` undefined → no
 * expiry is set here (the caller — the route — derives it from the
 * framework's attestation_valid_months); pass a date to set one, null for
 * none.
 *
 * @param {string} orgId
 * @param {{checkId?:string, subjectId?:string|null, outcome?:string, statement?:string,
 *          evidenceRefs?:Array<{evidence_id,sha256,filename}>, attestedBy?:string, expiresAt?:Date|string|null}} [input]
 */
async function attest(orgId, { checkId, subjectId, outcome, statement, evidenceRefs, attestedBy, expiresAt } = {}) {
    await initDB();
    if (!orgId) throw new Error('organization_id is required');
    const check = _text(checkId, 160);
    if (!check) throw new Error('checkId is required');
    if (!OUTCOMES.has(outcome)) throw new Error(`invalid outcome "${outcome}"`);
    const subject = _text(subjectId, 200);
    let expires = null;
    if (expiresAt != null) {
        expires = new Date(expiresAt);
        if (Number.isNaN(expires.getTime())) throw new Error('expires_at is not a date');
    }
    const params = [
        orgId, check, subject, outcome,
        _text(statement, 4000),
        JSON.stringify(_evidenceRefs(evidenceRefs)),
        attestedBy || null,
        expires,
    ];
    const supersede = `
        UPDATE compliance_attestations SET superseded_at = NOW()
        WHERE organization_id = $1 AND check_id = $2 AND subject_id IS NOT DISTINCT FROM $3 AND superseded_at IS NULL
    `;
    const insert = `
        INSERT INTO compliance_attestations
            (organization_id, check_id, subject_id, outcome, statement, evidence_refs, attested_by, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
        RETURNING ${ATT_COLUMNS}
    `;
    if (typeof withTransaction === 'function') {
        return withTransaction(async (client) => {
            await client.query(supersede, [orgId, check, subject]);
            const { rows } = await client.query(insert, params);
            return rows[0] || null;
        });
    }
    await run(supersede, [orgId, check, subject]);
    const { rows } = await run(insert, params);
    return rows[0] || null;
}

/** The current answer: newest non-superseded row for (check_id, subject_id). */
async function latestAttestation(orgId, checkId, subjectId = null) {
    await initDB();
    return getOne(`
        SELECT ${ATT_COLUMNS}
        FROM compliance_attestations
        WHERE organization_id = $1 AND check_id = $2 AND subject_id IS NOT DISTINCT FROM $3 AND superseded_at IS NULL
        ORDER BY attested_at DESC
        LIMIT 1
    `, [orgId, _text(checkId, 160), _text(subjectId, 200)]);
}

/** Full history, newest first — the drawer's "previous answers". */
async function listAttestations(orgId, checkId, subjectId = null, { limit = 50 } = {}) {
    await initDB();
    return getAll(`
        SELECT ${ATT_COLUMNS}
        FROM compliance_attestations
        WHERE organization_id = $1 AND check_id = $2 AND subject_id IS NOT DISTINCT FROM $3
        ORDER BY attested_at DESC
        LIMIT $4
    `, [orgId, _text(checkId, 160), _text(subjectId, 200), limit]);
}

/** Latest attestations for the org's check ids with prefix (e.g. 'CUSTOM-ACME-') — the runner's bulk read. */
async function listLatestByPrefix(orgId, prefix) {
    await initDB();
    return getAll(`
        SELECT ${ATT_COLUMNS}
        FROM compliance_attestations
        WHERE organization_id = $1 AND check_id LIKE $2 AND superseded_at IS NULL
        ORDER BY check_id ASC, attested_at DESC
    `, [orgId, `${String(prefix).replace(/[%_]/g, '\\$&')}%`]);
}

/** Current attestations expiring within `days` (or already expired) — the notifier's 5th sweep. */
async function listExpiring(orgId, days = 30) {
    await initDB();
    const d = Number.isFinite(Number(days)) && Number(days) >= 0 ? Math.floor(Number(days)) : 30;
    return getAll(`
        SELECT ${ATT_COLUMNS}
        FROM compliance_attestations
        WHERE organization_id = $1 AND superseded_at IS NULL
          AND expires_at IS NOT NULL AND expires_at < NOW() + ($2 || ' days')::interval
        ORDER BY expires_at ASC
    `, [orgId, String(d)]);
}

/** Pure: does this attestation still count right now? */
function isCurrent(row, now = Date.now()) {
    if (!row || row.superseded_at) return false;
    if (!row.expires_at) return true;
    return new Date(row.expires_at).getTime() > now;
}

module.exports = {
    initDB,
    // frameworks
    listFrameworks,
    getFramework,
    getFrameworkByCode,
    createFramework,
    updateFramework,
    archiveFramework,
    // checks
    listChecks,
    getCheck,
    upsertChecks,
    deleteCheck,
    // attestations
    attest,
    latestAttestation,
    listAttestations,
    listLatestByPrefix,
    listExpiring,
    isCurrent,
    // helpers / constants
    customCheckId,
    refSlug,
    normalizeCode,
    InvalidCodeError,
    CodeTakenError,
    CODE_RE,
    FRAMEWORK_STATUSES: [...FRAMEWORK_STATUSES],
    SEVERITIES: [...SEVERITIES],
    OUTCOMES: [...OUTCOMES],
};
