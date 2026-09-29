/**
 * Custom-framework runner — evaluates every ACTIVE org-defined framework
 * (stores/customFrameworkStore) and persists one row per check through
 * complianceStore.recordCheckResult with regulation 'CUSTOM' and the
 * framework's code, so the ordinary check tables, evidence chain and score
 * history carry them like built-in checks.
 *
 * Called by compliance/runner.js after the static loop (guarded require; only
 * when 'CUSTOM' is an active regulation for the org). Returns
 *   { rows: [...resultRows], scores: { 'custom:<frameworkId>': n | null } }
 * — the static runner merges `scores` into the snapshot JSONB.
 *
 * Status per check (in this order):
 *   1. mapped_check_id → the latest persisted result of that built-in check
 *      is copied (status + severity) with evidence { satisfied_by, source_run_at };
 *      no such row yet → 'warn' ("mapped check has not run").
 *   2. latest attestation:
 *        none      → 'fail'  (or 'warn' during the 30-day grace after the framework was created)
 *        expired   → 'warn'
 *        compliant → 'pass' · partial → 'warn' · non_compliant → 'fail' · not_applicable → 'na'
 *   3. evidence_required && the attestation carries no evidence_refs → capped at 'warn'.
 */

const complianceStore = require('../../stores/complianceStore');
const customFrameworkStore = require('../../stores/customFrameworkStore');
const log = require('../../telemetry/log');

const GRACE_DAYS = 30;
const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;

const OUTCOME_STATUS = Object.freeze({
    compliant: 'pass',
    partial: 'warn',
    non_compliant: 'fail',
    not_applicable: 'na',
});

const STATUS_RANK = { na: 0, pass: 1, warn: 2, fail: 3 };

/** The worse of two statuses — used to cap a 'pass' at 'warn' when evidence is missing. */
function worst(a, b) {
    if (a === 'na') return b;
    if (b === 'na') return a;
    return (STATUS_RANK[a] ?? 0) >= (STATUS_RANK[b] ?? 0) ? a : b;
}

function _inGrace(framework, now) {
    const created = framework?.created_at ? new Date(framework.created_at).getTime() : NaN;
    if (Number.isNaN(created)) return false;
    return now - created < GRACE_MS;
}

function _hasEvidenceRefs(att) {
    const refs = att?.evidence_refs;
    if (Array.isArray(refs)) return refs.length > 0;
    if (typeof refs === 'string') {
        try { return Array.isArray(JSON.parse(refs)) && JSON.parse(refs).length > 0; } catch { return false; }
    }
    return false;
}

/**
 * Pure: the status/details/evidence for one custom check.
 *
 * @param {object} check            compliance_custom_checks row
 * @param {object} framework        compliance_custom_frameworks row
 * @param {object|null} attestation latest attestation (or null)
 * @param {object|null} mappedRow   latest built-in result for check.mapped_check_id (or null)
 * @param {number} now              Date.now()
 */
function evaluateCheck(check, framework, attestation, mappedRow, now = Date.now()) {
    const severity = check.severity || 'medium';

    if (check.mapped_check_id) {
        if (mappedRow) {
            return {
                status: mappedRow.status,
                severity: mappedRow.severity || severity,
                details: `Satisfied by built-in check ${mappedRow.check_id}: ${mappedRow.details || mappedRow.status}`,
                evidence: {
                    mode: 'mapped',
                    satisfied_by: mappedRow.check_id,
                    source_run_at: mappedRow.run_at || null,
                    source_status: mappedRow.status,
                },
            };
        }
        return {
            status: 'warn',
            severity,
            details: `Mapped to built-in check ${check.mapped_check_id}, which has not produced a result yet`,
            evidence: { mode: 'mapped', satisfied_by: check.mapped_check_id, source_run_at: null },
        };
    }

    if (!attestation) {
        const grace = _inGrace(framework, now);
        return {
            status: grace ? 'warn' : 'fail',
            severity,
            details: grace
                ? `Not attested yet (grace period of ${GRACE_DAYS} days after framework creation)`
                : 'Not attested',
            evidence: { mode: 'attestation', attestation_id: null, grace },
        };
    }

    const expired = !customFrameworkStore.isCurrent(attestation, now);
    const baseEvidence = {
        mode: 'attestation',
        attestation_id: attestation.id,
        outcome: attestation.outcome,
        attested_at: attestation.attested_at || null,
        expires_at: attestation.expires_at || null,
        evidence_refs: _hasEvidenceRefs(attestation)
            ? (Array.isArray(attestation.evidence_refs) ? attestation.evidence_refs : JSON.parse(attestation.evidence_refs)).length
            : 0,
    };

    if (expired) {
        return {
            status: 'warn',
            severity,
            details: `Attestation expired on ${new Date(attestation.expires_at).toISOString().slice(0, 10)} — re-attest`,
            evidence: { ...baseEvidence, expired: true },
        };
    }

    let status = OUTCOME_STATUS[attestation.outcome] || 'fail';
    let details = `Attested ${attestation.outcome}`;
    if (check.evidence_required && !_hasEvidenceRefs(attestation) && status !== 'na') {
        status = worst(status, 'warn');
        details += ' — evidence required but none attached';
    }
    return { status, severity, details, evidence: { ...baseEvidence, expired: false, evidence_required: !!check.evidence_required } };
}

/**
 * Run every active custom framework for the org. Frameworks in 'draft' or
 * 'archived' are skipped. Never throws for a single framework — a failure is
 * logged and the others still run.
 */
async function runAll(orgId, { runType = 'scheduled' } = {}) {
    if (!orgId) throw new Error('orgId is required');
    const now = Date.now();
    const frameworks = (await customFrameworkStore.listFrameworks(orgId)) || [];
    const active = frameworks.filter(f => f.status === 'active');
    const rows = [];
    const scores = {};
    if (!active.length) return { rows, scores };

    let latestBuiltin = null;
    const builtinFor = async (checkId) => {
        if (!latestBuiltin) {
            const all = (await complianceStore.getLatestPerCheck(orgId)) || [];
            latestBuiltin = new Map();
            for (const r of all) {
                // Prefer the global-scope row; fall back to the newest of any scope.
                const existing = latestBuiltin.get(r.check_id);
                if (!existing || (r.scope_type === 'global' && existing.scope_type !== 'global')) latestBuiltin.set(r.check_id, r);
            }
        }
        return latestBuiltin.get(checkId) || null;
    };

    for (const fw of active) {
        const fwRows = [];
        try {
            const checks = (await customFrameworkStore.listChecks(orgId, fw.id)) || [];
            const prefix = `CUSTOM-${fw.code}-`;
            const attestations = (await customFrameworkStore.listLatestByPrefix(orgId, prefix)) || [];
            const latestByCheck = new Map();
            for (const a of attestations) {
                if (a.subject_id) continue; // framework items are unscoped; subject-scoped rows belong to Machinery etc.
                if (!latestByCheck.has(a.check_id)) latestByCheck.set(a.check_id, a);
            }

            for (const chk of checks) {
                const checkId = customFrameworkStore.customCheckId(fw.code, chk.ref);
                const mappedRow = chk.mapped_check_id ? await builtinFor(chk.mapped_check_id) : null;
                const attestation = chk.mapped_check_id ? null : (latestByCheck.get(checkId) || null);
                const ev = evaluateCheck(chk, fw, attestation, mappedRow, now);
                const row = {
                    organization_id: orgId,
                    check_id: checkId,
                    regulation: 'CUSTOM',
                    framework_code: fw.code,
                    framework_id: fw.id,
                    article: chk.ref,
                    severity: ev.severity,
                    status: ev.status,
                    details: ev.details,
                    evidence: { ...ev.evidence, custom_check_row_id: chk.id, title: chk.title },
                    scope_type: 'global',
                    scope_id: null,
                    run_type: runType,
                };
                try {
                    await complianceStore.recordCheckResult(row);
                } catch (e) {
                    log.warn(`[CustomRunner] persist failed for ${checkId} org="${orgId}":`, e.message);
                }
                fwRows.push(row);
            }
        } catch (e) {
            log.warn(`[CustomRunner] framework ${fw.code} failed for org="${orgId}":`, e.message);
        }
        rows.push(...fwRows);
        scores[`custom:${fw.id}`] = fwRows.length ? _score(fwRows) : null;
    }
    return { rows, scores };
}

function _score(fwRows) {
    try {
        const score = require('../score');
        const r = score.customFrameworkScore(fwRows);
        return typeof r === 'number' ? r : (r?.score ?? null);
    } catch {
        return null;
    }
}

module.exports = {
    runAll,
    evaluateCheck,
    worst,
    GRACE_DAYS,
    OUTCOME_STATUS,
};
