/**
 * ISO 27001 A.5.28 / A.5.36 — Collection of evidence & compliance with the
 * organisation's own monitoring.
 *
 * Self-referential control: every check run appends a row to
 * compliance_evidence, and since the evidence chain every row is linked to the
 * one before it — `hash = sha256(prev_hash ∥ payload_hash)` with
 * `payload_hash = sha256(canonicalJSON(payload))` (compliance/evidence/*).
 * This check walks the chain with `verifyChain` and gates on the result:
 *
 *   fail   the chain is broken — a gap in `seq`, a link that does not hash,
 *          or a payload that no longer matches its stored payload_hash. The
 *          report names the first offending row and the kind of break.
 *   warn   nothing to verify yet: the chain columns have not been provisioned
 *          (DDL pending), the chain has not started (the first sweep after
 *          this release seeds it), the ledger is not reachable, a pre-chain
 *          row carries a malformed fingerprint, or the newest row is older
 *          than a week (the 6-hourly sweep has stopped).
 *   pass   every linked row in the window verifies.
 *
 * Content verification is possible because payload_hash is computed over the
 * canonical JSON form, which is stable across the JSONB round-trip — the
 * old "recompute as corroboration only" caveat no longer applies. Rows from
 * before the chain (seq IS NULL) were hashed over the raw JSON.stringify
 * bytes and are shape-checked only; their count is reported, not verified.
 */

const { verifyChain } = require('../../evidence/chain');

// The A.5.28 window: the newest 5000 linked rows. An org running ~60 checks
// every 6 h appends ~240 rows a day, so this covers roughly three weeks.
const WINDOW_ROWS = 5000;
// The scheduler sweeps every 6 h — a week of silence means the loop is broken.
const FRESH_DAYS = 7;

const BREAK_REASON = {
    gap: 'a gap in the sequence (a row is missing)',
    link: 'a link that does not hash to its predecessor (a row was rewritten or reordered)',
    content: 'a payload that no longer matches its stored fingerprint (content altered in place)',
};

module.exports = {
    id: 'ISO27001-A.5.28-evidence-integrity',
    regulation: 'ISO27001',
    article: 'A.5.28',
    controls: ['A.5.28', 'A.5.36'],
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_evidence_integrity.title',
    descriptionKey: 'compliance.checks.iso_evidence_integrity.desc',
    remediationKey: 'compliance.checks.iso_evidence_integrity.fix',
    remediationLink: null,
    async evaluate(orgId) {
        const org = orgId || 'default';
        let report;
        try {
            report = await verifyChain(org, { limit: WINDOW_ROWS });
        } catch (e) {
            return {
                status: 'warn',
                evidence: { window_rows: WINDOW_ROWS, ledger_reachable: false, error: e.message },
                details: 'The evidence ledger is not reachable yet — nothing to verify. Expected only on a fresh install.',
            };
        }
        // Evidence = the verification report itself.
        const evidence = { ...report, window_rows: WINDOW_ROWS };

        if (report.ok === null) {
            return {
                status: 'warn',
                evidence,
                details: 'The evidence chain columns are not provisioned yet (seq / prev_hash / payload_hash) — the chain cannot be verified until the schema update has run. Restart the server so the store applies its DDL.',
            };
        }
        if (report.first_break) {
            const { seq, reason } = report.first_break;
            return {
                status: 'fail',
                evidence,
                details: `Evidence chain broken at row #${seq}: ${BREAK_REASON[reason] || reason}. `
                    + `${report.verified_rows} row(s) before it verify; the chain cannot demonstrate integrity from that point on.`,
            };
        }
        if (report.chained_rows === 0) {
            if (report.rows_total === 0) {
                return {
                    status: 'warn',
                    evidence,
                    details: 'No evidence rows have been appended yet. On a fresh install the first scheduled sweep seeds the chain; otherwise the compliance scheduler has stopped.',
                };
            }
            return {
                status: 'warn',
                evidence,
                details: `The evidence chain has not started yet: ${report.pre_chain_rows} pre-chain row(s) are fingerprinted but not linked. `
                    + 'The first sweep after this release seeds the chain — nothing to do unless this persists past the next sweep.',
            };
        }
        if (report.pre_chain_invalid > 0) {
            return {
                status: 'warn',
                evidence,
                details: `Evidence chain intact (${report.verified_rows} linked row(s) verified), but ${report.pre_chain_invalid} of ${report.pre_chain_rows} pre-chain row(s) `
                    + 'carry a missing or malformed SHA-256 fingerprint — integrity cannot be demonstrated for those historic rows.',
            };
        }
        const latest = report.latest_captured_at ? new Date(report.latest_captured_at).getTime() : NaN;
        const ageDays = Number.isFinite(latest) ? (Date.now() - latest) / 86400000 : null;
        if (ageDays != null && ageDays > FRESH_DAYS) {
            return {
                status: 'warn',
                evidence: { ...evidence, age_days: Math.floor(ageDays), fresh_days: FRESH_DAYS },
                details: `Evidence chain intact (${report.verified_rows} linked row(s) verified), but the newest row is ${Math.floor(ageDays)} days old — the 6-hourly compliance sweep appears to have stopped.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `Evidence chain intact: ${report.verified_rows} linked row(s) verified (${report.pre_chain_rows} pre-chain row(s) fingerprinted), head #${report.head.seq}.`,
        };
    },
};
