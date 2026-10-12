/**
 * Pinned sample data — the rules for a payload an author saved onto a node so
 * the node serves it instead of running. One function for steps and triggers
 * alike, so the two cannot drift.
 */

const { isObject } = require('../helpers');
// Pinned sample data is persisted inside definition_json and re-snapshotted
// into automation_versions on every save, so its size is this validator's
// problem. The cap is the run history's own per-payload cap, IMPORTED rather
// than restated: a pin that would be truncated the moment it was recorded as a
// step output has no business being saved as one. isTruncatedOutput recognises
// the sentinel truncation leaves behind — which is emphatically not data, and
// must not be pinned as if it were.
const { DEFAULT_MAX_BYTES, isTruncatedOutput } = require('../../payloadTruncation');
const { BRANCHER_TYPES } = require('../constants');

/**
 * Rules for PINNED SAMPLE DATA on one node — BFSF-408/409/434.
 *
 * A pin is a payload the author saved onto a node so the node serves it instead
 * of running. Steps have had them for a while; a TRIGGER can carry one now,
 * which is what finally makes `{{trigger.output.*}}` resolvable in a builder
 * run. Both are validated here, by one function, so the two cannot drift.
 *
 * Three rules, each closing a way a pin silently breaks something:
 *
 *  1. SIZE. There is no definition size cap anywhere today except bodyParser's
 *     20 MB, and every save writes a full snapshot of the definition into
 *     `automation_versions`. So a 15 MB pasted pin is not one row: it is one row
 *     per save, forever, plus every read of the automation. The cap is the run
 *     history's own per-payload cap (payloadTruncation.DEFAULT_MAX_BYTES) —
 *     anything a step output would have been truncated at is not a sane pin.
 *
 *  2. THE TRUNCATION SENTINEL. `{__truncated__: true, headSample, ...}` is what
 *     the run history persists in place of an oversized output, on a row whose
 *     status is an ordinary 'success'. Pin one of those and the node serves the
 *     sentinel as if it were data: bindings resolve against `headSample`, a
 *     collection step reports "arrayRef did not resolve to an array", and the
 *     user is looking at the real output in the panel next to it. A sentinel is
 *     not data anywhere else in this codebase and it is not data here.
 *
 *  3. BRANCHER SHAPE. condition/guard/switch route by the `branch` label their
 *     executor returns — runDag reads `dispatched.output?.branch` and routes on
 *     it. A pinned output IS that dispatch result, so a hand-edited If pin with
 *     no `branch` falls through to 'on_success', matches none of the node's
 *     then/else/case edges, and DEAD-ENDS THE FLOW with the run reported green.
 *     That is the same silent-stop failure the unlabelled-brancher-edge rule
 *     exists for, reached from the other side, so it is an error here too.
 *
 * `outgoingLabels` is the set of branch labels actually wired out of this node,
 * or null when the caller has no edges to check against — inside a loop body or
 * a parallel branch, where the runtime synthesizes a linear chain rather than
 * reading authored edges. The shape rule still applies there; only the
 * does-it-match-an-edge half is skipped.
 */
function checkPinnedOutput(node, at, { pushE, outgoingLabels = null, isTrigger = false } = {}) {
    const pin = node?.pinnedOutput;
    if (pin === undefined || pin === null) return;
    const who = `${isTrigger ? 'Trigger' : 'Step'} ${node.id || '(no id)'}`;
    const unpin = isTrigger
        ? 'Open the trigger and clear its sample data, or replace it with a smaller one.'
        : 'Open the step and click Unpin, or pin a smaller sample.';

    // 1 — size (and serializability: a pin has to survive the JSON column).
    let bytes = null;
    try {
        const json = JSON.stringify(pin);
        if (typeof json === 'string') bytes = Buffer.byteLength(json, 'utf8');
    } catch (_) { bytes = null; }
    if (bytes === null) {
        pushE({ code: 'pin.unserializable', severity: 'error', path: at + '.pinnedOutput', message: `${who}: the pinned sample data cannot be saved — it has no JSON form (a circular reference, or a value JSON drops).`, hint: unpin });
        return;
    }
    if (bytes > DEFAULT_MAX_BYTES) {
        pushE({ code: 'pin.too_large', severity: 'error', path: at + '.pinnedOutput', message: `${who}: the pinned sample data is ${Math.round(bytes / 1024)} KB — the maximum is ${Math.round(DEFAULT_MAX_BYTES / 1024)} KB. It is stored inside the automation and re-saved in full on every change.`, hint: `${unpin} A few representative rows test the flow just as well as all of them.` });
    }

    // 2 — the truncation sentinel is not data.
    if (isTruncatedOutput(pin)) {
        pushE({ code: 'pin.truncated_sample', severity: 'error', path: at + '.pinnedOutput', message: `${who}: the pinned sample is the "output too large" placeholder from the run history, not the real output — anything reading it resolves to nothing.`, hint: 'Re-run the step and pin a smaller slice of its output, or write the sample by hand.' });
    }

    // 3 — a pinned brancher has to say which way it went.
    if (BRANCHER_TYPES.has(node.type)) {
        const labels = [];
        if (isObject(pin)) {
            if (typeof pin.branch === 'string' && pin.branch.trim()) labels.push(pin.branch.trim());
            if (Array.isArray(pin.branches)) {
                for (const b of pin.branches) if (typeof b === 'string' && b.trim()) labels.push(b.trim());
            }
        }
        const ports = node.type === 'switch' ? 'case:<name>, or case:default' : 'then or else';
        const example = node.type === 'switch' ? 'case:default' : 'then';
        if (!labels.length) {
            pushE({ code: 'pin.brancher_no_branch', severity: 'error', path: at + '.pinnedOutput', message: `${who}: a pinned ${node.type} must say which way the flow goes — its sample carries no "branch" value, so nothing after it would run.`, hint: `Add "branch": "${example}" to the sample (${ports}), or unpin the step so it decides for itself.` });
        } else if (outgoingLabels && outgoingLabels.size && !labels.some(l => outgoingLabels.has(l))) {
            pushE({ code: 'pin.brancher_branch_unwired', severity: 'error', path: at + '.pinnedOutput', message: `${who}: the pinned sample routes to "${labels.join('", "')}", and nothing is wired to that port — the flow would stop here.`, hint: `Wired ports: ${[...outgoingLabels].join(', ')}. Point the sample's "branch" at one of them, or connect the port it names.` });
        }
    }
}
module.exports = { checkPinnedOutput };
