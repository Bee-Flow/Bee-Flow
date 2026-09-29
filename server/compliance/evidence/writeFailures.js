'use strict';
const log = require('../../telemetry/log');

/**
 * Evidence-chain WRITE failures — the hole the verifier cannot see.
 *
 * `compliance_evidence` is append-only and hash-chained, so `verifyChain`
 * can prove that what IS there has not been altered. It cannot prove that
 * everything that should be there arrived: a row that never landed leaves no
 * gap in `seq` (the sequence is allocated inside the same transaction), so a
 * swallowed `addEvidence` is indistinguishable from "nothing happened".
 *
 * Every call site that must not fail the user's action because of an evidence
 * write — the DSR fulfilment, the incident attestation, the custom
 * attestation, the report export, the auditor bundle stamp — routes its
 * rejection here instead of `.catch(() => {})`. Two things then happen:
 *
 *   1. it is logged, the way routes/compliance/frameworks.js already logs its
 *      own evidence failure;
 *   2. it is added to the org's counter, which `verifyChain` reports as
 *      `write_failures` — so it reaches the operator through the SAME report
 *      the Evidence/integrity page and `GET /api/compliance/evidence/chain`
 *      already render. That surface was chosen over an attention finding or a
 *      notification because this is a statement about the chain's
 *      completeness, and the chain report is the one place a reader already
 *      goes to ask "can I trust this trail?". An attention finding would need
 *      a check + a database read to persist it — and the failure we are
 *      reporting is precisely that a database write did not work.
 *
 * The counter is per process and in memory: it is a "something is wrong right
 * now" signal, not a record (a record would need the write that just failed).
 * It is bounded in both directions so a failing database cannot grow it.
 *
 * Privacy (BFSF-441): an entry is built from an explicit allow-list —
 * `check_id`, `subject_type`, `subject_id`, the error's CLASS and a
 * timestamp. `subject_id` is the opaque id the chain row itself carries (a
 * request number, an incident number, a check id), never a name, an address
 * or subject text. The error's MESSAGE is deliberately dropped: a Postgres
 * error routinely quotes the row value that broke it.
 */

const MAX_ENTRIES_PER_ORG = 50;
const MAX_ORGS = 200;

/** @type {Map<string, {count:number, first_at:string, last_at:string, entries:Array}>} */
const byOrg = new Map();

function errorType(err) {
    const raw = err && (err.code || err.name);
    return raw ? String(raw).slice(0, 60) : 'Error';
}

/**
 * Record one failed evidence write. Never throws — it is called from a
 * rejection handler, and a reporting bug must not replace the original error.
 *
 * @param {{organization_id?:string, check_id?:string|null, subject_type?:string|null, subject_id?:string|null}} row
 *        the evidence row that did NOT land (the same object handed to addEvidence)
 * @param {Error} err
 */
function recordWriteFailure(row, err) {
    try {
        const orgId = row?.organization_id ? String(row.organization_id) : 'unknown';
        const entry = {
            check_id: row?.check_id ? String(row.check_id).slice(0, 120) : null,
            subject_type: row?.subject_type ? String(row.subject_type).slice(0, 40) : null,
            subject_id: row?.subject_id ? String(row.subject_id).slice(0, 120) : null,
            error_type: errorType(err),
            at: new Date().toISOString(),
        };
        let bucket = byOrg.get(orgId);
        if (!bucket) {
            // Oldest org out first — a bounded map, like countsCache's.
            if (byOrg.size >= MAX_ORGS) byOrg.delete(byOrg.keys().next().value);
            bucket = { count: 0, first_at: entry.at, last_at: entry.at, entries: [] };
            byOrg.set(orgId, bucket);
        }
        bucket.count += 1;
        bucket.last_at = entry.at;
        bucket.entries.push(entry);
        if (bucket.entries.length > MAX_ENTRIES_PER_ORG) bucket.entries.shift();
        log.warn(
            `[Compliance] evidence write FAILED (org=${orgId} check=${entry.check_id} `
            + `subject=${entry.subject_type}/${entry.subject_id} error=${entry.error_type}) — `
            + 'the action succeeded but the append-only trail has a hole',
        );
    } catch { /* reporting must never mask the original failure */ }
}

/**
 * A `.catch` handler for an evidence write that must not fail its caller:
 *
 *   complianceStore.addEvidence(row).catch(onEvidenceWriteFailed(row));
 *
 * @param {object} row the evidence row handed to addEvidence
 * @returns {(err: Error) => void}
 */
function onEvidenceWriteFailed(row) {
    return (err) => recordWriteFailure(row, err);
}

/**
 * What `verifyChain` reports. `null` when this process has seen no failure for
 * the org — the common case, and the one the client renders as nothing.
 *
 * @param {string} orgId
 * @returns {{count:number, first_at:string, last_at:string, recent:Array}|null}
 */
function writeFailureSummary(orgId) {
    const bucket = byOrg.get(orgId == null ? 'unknown' : String(orgId));
    if (!bucket || !bucket.count) return null;
    return {
        count: bucket.count,
        first_at: bucket.first_at,
        last_at: bucket.last_at,
        // Newest first, capped — the operator needs the shape, not the volume.
        recent: bucket.entries.slice(-10).reverse(),
    };
}

/** Test hook. */
function _reset() { byOrg.clear(); }

module.exports = {
    recordWriteFailure,
    onEvidenceWriteFailed,
    writeFailureSummary,
    _reset,
    MAX_ENTRIES_PER_ORG,
    MAX_ORGS,
};
