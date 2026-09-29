#!/usr/bin/env node
/**
 * Verify one organisation's compliance evidence chain and print the report.
 *
 * Walks the newest `--limit` linked rows of compliance_evidence for the org
 * (compliance/evidence/chain.js verifyChain): every row's hash must equal
 * sha256(prev_hash ∥ payload_hash), prev_hash must be the previous row's
 * hash, seq must be contiguous, and the stored JSONB payload must still
 * canonicalise to its payload_hash. Pre-chain rows (seq IS NULL) are counted
 * and shape-checked only.
 *
 * READ-ONLY: two SELECTs, nothing is written. Prints hashes, sequence numbers
 * and counts — never a payload (payloads can carry subject labels).
 *
 * Usage:
 *   node server/scripts/verifyEvidenceChain.js <orgId> [--limit N] [--json]
 *
 *   --limit N   newest linked rows to walk (default 2000, max 50000)
 *   --json      print the raw report as JSON instead of the table
 *
 * Exit codes:
 *   0  chain intact in the walked window (also for an org without linked rows)
 *   1  a break was found — see first_break
 *   2  could not verify (chain columns not provisioned, database error, usage)
 *
 * Inside a running server container, the script may be copied in and run from
 * outside the app tree (e.g. /tmp), which breaks __dirname-relative requires —
 * hence the APP_ROOT dual-mode resolution below (inside the image the app
 * lives at /app).
 */

const path = require('path');
const fs = require('fs');

const APP_ROOT = fs.existsSync('/app/db.js') ? '/app' : path.join(__dirname, '..');

const EXIT_OK = 0;
const EXIT_BREAK = 1;
const EXIT_UNVERIFIED = 2;

function argValue(flag) {
    const i = process.argv.indexOf(flag);
    return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

// ── Pure helpers (exported so they can be exercised without a database) ─────

/** Exit code for a verifyChain report. */
function exitCodeFor(report) {
    if (!report || report.ok === null) return EXIT_UNVERIFIED;
    return report.first_break ? EXIT_BREAK : EXIT_OK;
}

const BREAK_REASON = {
    gap: 'gap — a sequence number is missing (a row was deleted)',
    link: 'link — hash does not equal sha256(prev_hash ∥ payload_hash), or prev_hash does not point at the previous row',
    content: 'content — the stored payload no longer canonicalises to its payload_hash (altered in place)',
};

/** Human-readable rendering of a verifyChain report. */
function formatReport(orgId, report) {
    const lines = [];
    lines.push(`Evidence chain — org ${orgId}`);
    lines.push(`checked at        ${report.checked_at}`);
    if (report.ok === null) {
        lines.push('verdict           NOT VERIFIABLE — chain columns (seq / prev_hash / payload_hash) are not provisioned on this database yet.');
        lines.push('                  Restart the server so complianceStore applies its DDL, then run again.');
        return lines.join('\n');
    }
    lines.push(`rows total        ${report.rows_total}`);
    lines.push(`  linked (seq)    ${report.chained_rows}`);
    lines.push(`  pre-chain       ${report.pre_chain_rows}${report.pre_chain_invalid ? `  (${report.pre_chain_invalid} with a missing/malformed fingerprint)` : ''}`);
    if (report.window) {
        lines.push(`window walked     seq ${report.window.from_seq} → ${report.window.to_seq}  (limit ${report.window.limit})`);
    } else {
        lines.push('window walked     — (no linked rows)');
    }
    lines.push(`verified rows     ${report.verified_rows}`);
    lines.push(`head              ${report.head ? `#${report.head.seq}  ${report.head.hash}` : '—'}`);
    lines.push(`latest captured   ${report.latest_captured_at ? new Date(report.latest_captured_at).toISOString() : '—'}`);
    if (report.first_break) {
        lines.push(`verdict           BROKEN at #${report.first_break.seq}: ${BREAK_REASON[report.first_break.reason] || report.first_break.reason}`);
    } else if (report.chained_rows === 0) {
        lines.push('verdict           INTACT (empty) — the chain has not started; the next compliance sweep seeds it.');
    } else {
        const partial = report.window && report.window.from_seq > 1 ? ` — rows before #${report.window.from_seq} were not walked (raise --limit)` : '';
        lines.push(`verdict           INTACT — ${report.verified_rows} linked row(s) verify${partial}.`);
    }
    return lines.join('\n');
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
    const orgId = process.argv.slice(2).find(a => !a.startsWith('--') && a !== argValue('--limit'));
    if (!orgId) {
        console.error('Usage: node server/scripts/verifyEvidenceChain.js <orgId> [--limit N] [--json]');
        return EXIT_UNVERIFIED;
    }
    const limitArg = argValue('--limit');
    const limit = limitArg == null ? 2000 : Number(limitArg);
    if (!Number.isFinite(limit) || limit < 1) {
        console.error(`--limit must be a positive number, got "${limitArg}"`);
        return EXIT_UNVERIFIED;
    }
    const asJson = process.argv.includes('--json');

    const db = require(path.join(APP_ROOT, 'db'));
    const { verifyChain } = require(path.join(APP_ROOT, 'compliance', 'evidence', 'chain'));
    try {
        const report = await verifyChain(orgId, { limit, db });
        console.log(asJson ? JSON.stringify(report, null, 2) : formatReport(orgId, report));
        return exitCodeFor(report);
    } catch (e) {
        console.error(`Could not verify the chain for org ${orgId}: ${e.message}`);
        return EXIT_UNVERIFIED;
    } finally {
        try { await db.pool.end(); } catch (_) { /* best-effort */ }
    }
}

if (require.main === module) {
    main()
        .then(code => process.exit(code))
        .catch(e => {
            console.error(e);
            process.exit(EXIT_UNVERIFIED);
        });
}

module.exports = { formatReport, exitCodeFor, EXIT_OK, EXIT_BREAK, EXIT_UNVERIFIED };
