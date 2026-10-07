// @typecheck
'use strict';

/**
 * Finding states — an admin's decision about ONE open finding.
 *
 * compliance_checks stays the truth: a sweep keeps writing what it finds, the
 * score keeps counting it, the check table keeps showing it. A decision only
 * takes the finding off the "Needs attention" list and out of the counts, and
 * only for as long as the finding is the SAME one the admin looked at:
 *
 *   acknowledged   "we know, it is being handled"      holds while unchanged
 *   accepted_risk  "we accept this, for this reason"   holds while unchanged
 *                                                       (reason required; an
 *                                                       optional review date)
 *   snoozed        "not now"                            holds until a date,
 *                                                       and while unchanged
 *
 * "The same one" is the FINGERPRINT: sha256 over the status and a stable subset
 * of the evidence. A check may name that subset itself (`fingerprintOf`) — the
 * project checks hand over the set of offending projects, so one more offender
 * re-opens the finding while a re-run that finds exactly the same thing does
 * not. Without one, every scalar evidence field counts except the ones that
 * move on every run by nature (timestamps, ages, durations) and the subject's
 * display label. A finding that turns from warn into fail always re-opens:
 * the status is in the hash.
 *
 * Pure. The store keeps the rows (stores/complianceStore.js), the route writes
 * them (routes/compliance/checks.js), attention.js and the check table read
 * them through `stateFor` / `applies`.
 */

const crypto = require('crypto');

const STATES = Object.freeze(['acknowledged', 'accepted_risk', 'snoozed']);
const GLOBAL_SCOPE_KEY = 'global';

// Evidence keys that differ between two runs over an unchanged workspace.
const VOLATILE_KEY = /(_at|_ms|_hours|_age|age_hours|_days_ago|heartbeat|elapsed|timeout|generated|checked|run_type)$/i;
// Evidence keys that NAME what was found rather than describe it: the runner
// stamps `subject_label` (an agent's or automation's current title) on the
// result row, and renaming the agent is not a different finding.
const LABEL_KEYS = new Set(['subject_label']);

/** The slot key a state is stored under: the row's scope_id, or 'global'. */
function scopeKeyOf(row) {
    const id = row && row.scope_id;
    return id == null || id === '' ? GLOBAL_SCOPE_KEY : String(id);
}

/** Evidence reduced to the scalar fields that describe WHAT was found. */
function stableSubset(evidence) {
    const out = {};
    if (!evidence || typeof evidence !== 'object') return out;
    for (const key of Object.keys(evidence).sort()) {
        if (VOLATILE_KEY.test(key) || LABEL_KEYS.has(key)) continue;
        const v = evidence[key];
        if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[key] = v;
    }
    return out;
}

/**
 * The fingerprint of a result row. `def` is the check definition; its
 * optional `fingerprintOf(evidence, row)` names the stable subset itself.
 * @param {{status?: string, evidence?: any}} row
 * @param {{fingerprintOf?: Function}|null} [def]
 */
function fingerprintOf(row, def = null) {
    const status = String(row?.status || '');
    let subset;
    if (def && typeof def.fingerprintOf === 'function') {
        try { subset = def.fingerprintOf(row?.evidence || {}, row); } catch { subset = stableSubset(row?.evidence); }
    } else {
        subset = stableSubset(row?.evidence);
    }
    return crypto.createHash('sha256').update(JSON.stringify([status, subset ?? null])).digest('hex');
}

/** Index a list of stored states by `check_id` + scope key. */
function indexStates(states) {
    const map = new Map();
    for (const s of Array.isArray(states) ? states : []) {
        if (!s || !s.check_id) continue;
        map.set(`${s.check_id}␟${s.scope_key || GLOBAL_SCOPE_KEY}`, s);
    }
    return map;
}

/** The stored decision for a result row, or null. */
function stateFor(index, row) {
    if (!index || !row) return null;
    return index.get(`${row.check_id}␟${scopeKeyOf(row)}`) || null;
}

/**
 * Does `state` still hold for `row`? Only an open finding (warn/fail) can be
 * held at all; the fingerprint must match; a date, when there is one, must
 * not have passed.
 */
function applies(state, row, def = null, now = Date.now()) {
    if (!state || !row) return false;
    if (row.status !== 'warn' && row.status !== 'fail') return false;
    if (state.fingerprint !== fingerprintOf(row, def)) return false;
    if (state.until) {
        const until = Date.parse(state.until);
        if (Number.isFinite(until) && until <= now) return false;
    }
    return true;
}

/** The shape the check table shows next to a row (never the fingerprint). */
function publicState(state, row, def = null, now = Date.now()) {
    if (!state) return null;
    return {
        state: state.state,
        reason: state.reason ?? null,
        until: state.until ?? null,
        actor_id: state.actor_id ?? null,
        updated_at: state.updated_at ?? null,
        active: applies(state, row, def, now),
    };
}

module.exports = {
    STATES,
    GLOBAL_SCOPE_KEY,
    scopeKeyOf,
    stableSubset,
    fingerprintOf,
    indexStates,
    stateFor,
    applies,
    publicState,
};
