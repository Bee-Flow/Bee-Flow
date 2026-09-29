/**
 * Art-44 transfer assessment over the grouped ledger rows of the last 30 days
 * (compliance/checks/gdpr/art44-external-transfers.js runs the query).
 *
 * Pure: rows in, { status, evidence, details } out, so the decision is tested
 * without a database. Per row, by location state:
 *   outside      a transfer: fail without an SCC attestation for the operator
 *   via_network  through a global network whose final location the connection
 *                cannot see: its own evidence list, warn when unattested,
 *                never a fail
 *   unknown      not a transfer; above UNLOCATED_WARN_RATIO of all calls the
 *                ledger cannot vouch for where the data went: warn
 *   local / eu   fine
 * A row without location_state (an older reader, a test fixture) falls back on
 * its is_local / is_eu flags, which is what the check did before.
 */

'use strict';

// 5 %: room for the odd tool that runs as a child process, not for a ledger
// that mostly cannot say where data went.
const UNLOCATED_WARN_RATIO = 0.05;

function rowState(row) {
    if (row.location_state) return row.location_state;
    if (row.is_local) return 'local';
    if (row.is_eu) return 'eu';
    return 'outside';
}

/**
 * @param {Array<object>} transfers  grouped rows: operator, country_code, country_name, is_eu, is_local, location_state, calls, …
 * @param {Set<string>} sccConfirmed  lower-cased attested operator names
 */
function assessTransfers(transfers, sccConfirmed) {
    const nonEuUnconfirmed = [];
    const nonEuConfirmed = [];
    const euOrLocal = [];
    const viaNetwork = [];
    let unlocatedCalls = 0;
    let totalCalls = 0;
    for (const row of transfers) {
        const calls = Number(row.calls) || 0;
        totalCalls += calls;
        const state = rowState(row);
        if (state === 'local' || state === 'eu') { euOrLocal.push(row); continue; }
        if (state === 'unknown') { unlocatedCalls += calls; continue; }
        const op = String(row.operator || '').toLowerCase();
        const attested = !!op && sccConfirmed.has(op);
        if (state === 'via_network') { viaNetwork.push({ ...row, scc_confirmed: attested }); continue; }
        if (attested) nonEuConfirmed.push(row);
        else nonEuUnconfirmed.push(row);
    }
    const totalNonEu = nonEuUnconfirmed.length + nonEuConfirmed.length;
    const viaUnattested = viaNetwork.filter(r => !r.scc_confirmed);
    const unlocatedPct = totalCalls > 0 ? Math.round((1000 * unlocatedCalls) / totalCalls) / 10 : 0;
    const tooManyUnlocated = totalCalls > 0 && unlocatedCalls / totalCalls > UNLOCATED_WARN_RATIO;

    let status;
    let details;
    if (nonEuUnconfirmed.length > 0) {
        status = 'fail';
        details = `${nonEuUnconfirmed.length} operator(s) routed personal data outside the EU in the last 30 days without SCC attestation. Confirm SCCs/DPAs under Compliance → Settings or switch traffic to an EU operator.`;
    } else if (viaUnattested.length > 0) {
        const names = [...new Set(viaUnattested.map(r => r.operator || 'unknown operator'))].join(', ');
        status = 'warn';
        details = `${viaUnattested.length} operator(s) received data through a global network (${names}) whose final location the connection cannot see. Confirm SCCs/DPAs for them, or check where the service processes data.`;
    } else if (tooManyUnlocated) {
        status = 'warn';
        details = `${unlocatedPct}% of the outbound calls in the last 30 days have no known location, so this check cannot confirm where that data went.`;
    } else if (totalNonEu > 0) {
        status = 'pass';
        details = `${nonEuConfirmed.length} non-EU operator(s) in use — all covered by attested Standard Contractual Clauses.`;
    } else {
        status = 'pass';
        details = 'All located outbound integration calls in the last 30 days routed to EU or local infrastructure.';
    }
    return {
        status,
        evidence: {
            window_days: 30,
            transfers_total: transfers.length,
            non_eu_unconfirmed: nonEuUnconfirmed.slice(0, 50),
            non_eu_confirmed: nonEuConfirmed.slice(0, 50),
            via_network: viaNetwork.slice(0, 50),
            eu_or_local_sample: euOrLocal.slice(0, 10),
            unlocated_calls: unlocatedCalls,
            unlocated_pct: unlocatedPct,
            unlocated_warn_pct: UNLOCATED_WARN_RATIO * 100,
            scc_confirmed_operators: Array.from(sccConfirmed),
        },
        details,
    };
}

module.exports = { assessTransfers, rowState, UNLOCATED_WARN_RATIO };
