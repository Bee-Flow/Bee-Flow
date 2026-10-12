// @typecheck
/**
 * Tool-protocol hygiene shared by the builders: the things a build loop does
 * to a rejected call so a model can act on it.
 *
 * noteRepeatedRejection — the same call, rejected again. A rejected mutator
 * rolls back, so identical arguments against an unchanged draft are rejected
 * identically, and nothing in the result used to say so. Measured with the
 * fast local model: one byte-identical builder_add_steps sent three rounds
 * running, a builder_update_steps fifteen times before that. The counter
 * lives on the per-turn state object (draftWrap) the route keeps for the
 * whole turn; a successful mutation clears it because the draft the next
 * call sees is a different one.
 */

'use strict';

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * JSON with object keys sorted at every depth — "is this the same call?"
 * must answer yes when the model only serialised its keys in another order.
 */
function canonicalJson(value) {
    const out = JSON.stringify(value, (_k, v) => {
        if (!isPlainObject(v)) return v;
        const sorted = {};
        for (const key of Object.keys(v).sort()) sorted[key] = v[key];
        return sorted;
    });
    return out === undefined ? 'undefined' : out;
}

function signature(name, args) {
    return `${name}\n${canonicalJson(args === undefined ? null : args)}`;
}

/** Is this call the one the state remembers as rejected? */
function isRepeat(state, name, args) {
    const prev = state && typeof state === 'object' ? state._lastRejected : null;
    if (!prev || typeof prev !== 'object') return false;
    try { return prev.sig === signature(name, args); } catch (_) { return false; }
}

/**
 * @param {string} name
 * @param {any} args
 * @param {any} result
 * @param {any} state
 * @param {{ mutating?: Set<string>|((name: string) => boolean) }} [opts]
 */
function noteRepeatedRejection(name, args, result, state, { mutating } = {}) {
    if (!state || typeof state !== 'object') return result;
    const isMutating = mutating instanceof Set ? mutating.has(name) : (typeof mutating === 'function' ? !!mutating(name) : false);
    if (!result || typeof result !== 'object' || !result.error) {
        if (isMutating) state._lastRejected = null;
        return result;
    }
    let sig;
    try { sig = signature(name, args); } catch (_) { return result; }
    const prev = state._lastRejected;
    // The fix a rejection carries (a `_suggestedPatch` in the automation builder's
    // shape: { ops:[{op:'set', path, value}], why }) is remembered so the
    // identical resend can have it applied before dispatch — rung 2 of the
    // ladder. Kept across the count.
    const patch = result._suggestedPatch && typeof result._suggestedPatch === 'object' ? result._suggestedPatch : (prev && prev.sig === sig ? prev.patch : null);
    if (!prev || prev.sig !== sig) {
        state._lastRejected = { sig, count: 1, patch };
        return result;
    }
    prev.count += 1;
    prev.patch = patch;
    // A tool that counts its own repeats (a duplicate batch whose resends
    // differ only in debris, so the raw signature never matches) may have set
    // `_repeated` already; the ladder never lowers it.
    result._repeated = Math.max(prev.count, Number(result._repeated) || 0);
    const stop = result._repeated >= 3;
    result._fixHint = `${result._fixHint ? `${result._fixHint} ` : ''}This is the SAME call as your previous attempt (${prev.count} times now), rejected for the same reason — re-sending identical arguments cannot succeed. ${stop
        ? 'Stop retrying: tell the user what you tried and what the tool answered, and ask how to proceed.'
        : 'Change exactly what the error names before calling again.'}`;
    return result;
}

module.exports = { noteRepeatedRejection, isRepeat, canonicalJson };
