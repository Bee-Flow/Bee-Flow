/**
 * What a Code step leaves in `steps.<id>.output`, in ONE place for the server.
 *
 * execCode (core/automationRunner/execOutbound.js) does not hand on what the
 * code returned as the step output itself: it wraps it in an envelope,
 *   { result: <what main returned>, logs: [...], httpCalls: N }
 * plus `_dryRun` / `wouldHaveCalled` / `_dryRunSyntheticInputs` on a rehearsal.
 * So a returned `{ count, tickets }` is read at `steps.<id>.output.result.count`.
 * The canvas picker has always written that path (agent-hub
 * flow/stepPayload.ts holds the same table for the client).
 *
 * The AI builder did not know it. Its shape checker (builderTools/refCheck.js)
 * treated a code step's output as unknown, so `steps.<id>.output.count` was
 * saved without a word and resolved to nothing at run time: a flowlet whose
 * Return step read a code step's fields returned an empty record, and the
 * caller's next steps were skipped. refCheck now knows the envelope and
 * repairs such a path; `missingResultTokens` is the run's tolerant read for
 * the definitions that were saved before that (bind.js).
 *
 * Pure.
 */

'use strict';

const CODE_PAYLOAD_KEY = 'result';
// Sibling keys of `result` that describe the run, never the data.
const CODE_DIAGNOSTIC_KEYS = Object.freeze(['logs', 'httpCalls', 'wouldHaveCalled', '_dryRun', '_dryRunSyntheticInputs']);
const ENVELOPE_KEYS = new Set([CODE_PAYLOAD_KEY, ...CODE_DIAGNOSTIC_KEYS]);

const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Does this step output look like execCode's envelope? Recognised by the
 * diagnostics every live and rehearsal run writes (`logs` next to
 * `httpCalls`), so a replayed or JSON round-tripped output counts too, and a
 * pinned output in some other shape does not.
 */
function isCodeEnvelope(output) {
    return isPlainObject(output)
        && Object.prototype.hasOwnProperty.call(output, 'logs')
        && Object.prototype.hasOwnProperty.call(output, 'httpCalls');
}

/**
 * For a path that reads `steps.<id>.output.<key>…` where step <id> left a code
 * envelope and <key> is not one of the envelope's own keys: the same path
 * with `.result` put in front of <key>. Null otherwise.
 *
 * Only ever consulted after the path as written found nothing, and an
 * envelope has nothing but its own keys, so this can turn a miss into the
 * value the author meant and never changes a value that was found.
 *
 * `tokens` are shared/expr path tokens ({ type: 'prop', key } …).
 */
function missingResultTokens(tokens, root) {
    if (!Array.isArray(tokens) || tokens.length < 4) return null;
    const [head, id, out, key] = tokens;
    if (head.type !== 'prop' || head.key !== 'steps') return null;
    if (id.type !== 'prop' || out.type !== 'prop' || out.key !== 'output') return null;
    if (key.type !== 'prop' || ENVELOPE_KEYS.has(String(key.key))) return null;
    const steps = root && isPlainObject(root.steps) ? root.steps : null;
    const entry = steps && Object.prototype.hasOwnProperty.call(steps, id.key) ? steps[id.key] : null;
    if (!entry || !isCodeEnvelope(entry.output)) return null;
    return [head, id, out, { type: 'prop', key: CODE_PAYLOAD_KEY }, ...tokens.slice(3)];
}

module.exports = {
    CODE_PAYLOAD_KEY,
    CODE_DIAGNOSTIC_KEYS,
    isCodeEnvelope,
    missingResultTokens,
};
