/**
 * Builder tools — the leaf phases of builder_add_steps: batch pre-validation,
 * handle eviction, the partial-failure result and the per-entry dispatch.
 * Split out of addSteps.js, which keeps the entry loop and its turn state.
 */

'use strict';

const { liftEntryPatch } = require('./suggestedPatch');
const { TEMP_ID_RX, resolveHandlesForResend, resolveAnchor } = require('./tempRefs');
const { findStepAnywhere } = require('./draftGraph');
const { looksGarbled } = require('../../core/llm/partialJsonScan');

/** An entry that is not an object at all means the batch JSON was mangled in transit. */
function junkEntriesError(rawEntries) {
const junk = [];
rawEntries.forEach((e, i) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) junk.push({ i, v: e });
});
if (junk.length) {
    const shown = junk.slice(0, 4).map(({ i, v }) => `steps[${i}] = ${JSON.stringify(typeof v === 'string' && v.length > 40 ? `${v.slice(0, 40)}…` : v)}`).join(', ');
    return {
        error: `${shown}${junk.length > 4 ? `, …and ${junk.length - 4} more` : ''} — ${junk.length > 1 ? 'those entries are' : 'that entry is'} not a step object, so the batch JSON arrived corrupted and nothing was applied. Every entry is {tempId?, type, spec}.`,
        _fixHint: 'Reject reason: corrupted batch JSON. Nothing was applied, so nothing needs undoing. Resend the SAME steps with complete, well-formed JSON — in two smaller batches if the call was long. Do not redesign the steps.',
    };
}
    return null;
}

/** Pre-validate every entry BEFORE anything is mutated; the first problem is the answer. */
function validateEntries(graph, entries, rawEntries, { ADD_FOR_TYPE, PARSE_JSON_RETIRED_MSG }) {
    const seen = new Set();
for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.tempId !== undefined) {
        if (typeof e.tempId !== 'string' || !TEMP_ID_RX.test(e.tempId)) {
            return { error: `steps[${i}]: tempId "${e.tempId}" must match [A-Za-z][A-Za-z0-9_]* (max 25 chars).` };
        }
        if (seen.has(e.tempId)) return { error: `steps[${i}]: duplicate tempId "${e.tempId}" in this call.` };
        if (require('./draftGraph').isKnownNodeId(graph, e.tempId)) {
            return { error: `steps[${i}]: tempId "${e.tempId}" collides with an existing step id — pick another handle.` };
        }
        seen.add(e.tempId);
    }
    if (e.type === 'parse_json') return { error: `steps[${i}]: ${PARSE_JSON_RETIRED_MSG}` };
    const allowed = `${Object.keys(ADD_FOR_TYPE).join(', ')}, array_op`;
    if (!e.type) {
        // "unknown type undefined" named neither the missing key nor the
        // usual cause. When the entry's own strings carry JSON debris the
        // batch was mangled in transit — the model needs to know it is
        // resending, not redesigning.
        // The debris that proves a mangled batch is often in a SIBLING
        // entry, not in this one — the entry that lost its `type` is the
        // one that got cut, and the rest of its JSON landed elsewhere.
        const garbled = looksGarbled(e) || rawEntries.some(looksGarbled);
        return {
            error: `steps[${i}]: has no "type". Every entry is {tempId?, type, spec}. Allowed types: ${allowed}.${garbled
                ? ' This entry carries JSON punctuation inside a string value, so the batch JSON arrived corrupted — resend it carefully, in two smaller batches if it is long.'
                : ''}`,
            ...(garbled ? { _fixHint: 'Reject reason: corrupted batch JSON. Nothing was applied. Resend the same steps with complete, well-formed JSON — smaller batches are safer.' } : {}),
        };
    }
    if (!ADD_FOR_TYPE[e.type] && e.type !== 'array_op') {
        return { error: `steps[${i}]: unknown type "${e.type}". Allowed: ${allowed}.` };
    }
    if (!e.spec || typeof e.spec !== 'object' || Array.isArray(e.spec)) {
        return { error: `steps[${i}]: missing "spec" object — the step's fields go INSIDE spec (same fields as builder_add_${e.type}).` };
    }
}
    return null;
}

/** Drop handles and fingerprints whose step left the graph since an earlier call this turn. */
function evictRemoved(turn, graph, draft, note) {
    // A handle whose step left the graph (builder_remove_step earlier this
    // turn) must not be reused. Measured: the model's remove-and-re-add left
    // the draft without the step, wired the consumer to the dead id, and was
    // told to patch a step that no longer existed. Root AND every layer are
    // checked (not just the scoped `graph`), so a handle minted in another
    // scope is not evicted by mistake. Every eviction is said once, here,
    // because the next entry that names the handle is built anew under a
    // NEW id and the model must not keep the old one.
    const alive = (id) => !!findStepAnywhere(graph, id)
        || !!(draft && (findStepAnywhere(draft, id)
            || Object.values(draft.layers || {}).some(g => g && findStepAnywhere(g, id))));
const evicted = new Set();
for (const [t, id] of Object.entries(turn._tempIds)) {
    if (alive(id)) continue;
    delete turn._tempIds[t];
    delete turn._rawEntryByHandle[t];
    evicted.add(id);
    note(`$${t}: was built earlier this turn as ${id}, but that step has since been removed — the handle is free again and an entry naming it is built anew, under a new id.`);
}
for (const [fp, v] of [...turn._builtThisTurn]) {
    if (alive(v.id)) continue;
    turn._builtThisTurn.delete(fp);
    if (!evicted.has(v.id)) {
        evicted.add(v.id);
        note(`${v.id} (${v.tool || v.type}) was built earlier this turn but has since been removed — an entry with that spec is built anew, not reported as already built.`);
    }
}
for (const id of [...turn._mintedThisTurn]) if (!alive(id)) turn._mintedThisTurn.delete(id);
}

/** The partial result: what was built, and the one call that continues the batch. */
function buildFailure(st, i, spec, error, res) {
    const { added, idMap, lastAppliedId, entries, rawEntries, warnings } = st;
    // The entry's OWN reason leads (that is what the model must change);
    // the resend contract follows it. Reversed, the first sentence the
    // model reads is bookkeeping and the actual defect is buried.
    const own = res && typeof res._fixHint === 'string' && res._fixHint
        ? res._fixHint
        : `Reject reason: entry ${i} was refused — see the error.`;
    const contract = added.length
        ? `Entries 0..${i - 1} are built (ids ${added.map(a => a.id).join(', ')}) and stay built. Fix entry ${i} and resend ONLY entries ${i}.. — steps.$<tempId> of the built entries still resolves, and the first resent entry chains after "${lastAppliedId}" unless you set afterStepId. Resending the built entries again is harmless (they are not added twice).`
        : null;
    const hint = [own, contract].filter(Boolean).join(' ');
    // The entry as this result asks for it back: real ids, anchored.
    //
    // "Real ids" has to be true of the WHOLE entry, not just the anchor.
    // The spec body carries the handles the model wrote — including the
    // bare `steps.foo` form that caused the refusal in the first place —
    // and an anchor naming a tempId is exactly the dangling reference the
    // error message warns about. Suggesting either back is suggesting the
    // same failure; resolve both against what was actually built.
    // A value nobody can guess back — an id that is not in the catalog,
    // a name that matches several tables — is DROPPED from the suggestion
    // rather than repeated. Handing the same invented datatableId back is
    // handing the same refusal back, and that is a loop the model cannot
    // break: it reads the suggestion as the corrected call.
    const anchor = resolveAnchor(spec.afterStepId, idMap) || lastAppliedId;
    const resendSpec = resolveHandlesForResend(spec, idMap);
    const rejectedPath = res && typeof res._rejectedPath === 'string' ? res._rejectedPath : null;
    const dropped = rejectedPath && rejectedPath in resendSpec;
    if (dropped) delete resendSpec[rejectedPath];
    const resendEntry = { ...entries[i], spec: { ...resendSpec, ...(anchor ? { afterStepId: anchor } : {}) } };
    // The patch is signed on BOTH shapes a resend repeats: the RAW entry
    // (the whole batch again) and `resendEntry` (obeying the contract
    // below). Measured with a two-entry batch: signed on the raw entry
    // only, the resend that obeyed resendAs was counted as a repeat but
    // the patch skipped it, and the repair landed one round late.
    const patch = res && res._suggestedPatch ? liftEntryPatch(res._suggestedPatch, i, rawEntries[i], resendEntry) : null;
    const fullHint = [hint, dropped
        ? (res && res._askArgs
            // A table the user has not chosen: the value is theirs to give.
            ? `The entry in resendAs has "${rejectedPath}" REMOVED — it is the value that was refused. Ask the user (builder_ask_questions with _askArgs) and resend with the table they choose; never pick one yourself.`
            : `The entry in resendAs has "${rejectedPath}" REMOVED — it is the value that was refused. Fill it with one of the options in the error, or ask the user, before resending.`)
        : null].filter(Boolean).join(' ');
    return {
        error,
        failedIndex: i,
        added,
        resendFrom: i,
        lastAppliedId,
        idMap: { ...idMap },
        resendAs: {
            tool: 'builder_add_steps',
            args: { steps: [resendEntry] },
        },
        ...(patch ? { _suggestedPatch: patch } : {}),
        ...(res && res._needsInspect ? { _needsInspect: res._needsInspect, toolSchema: res.toolSchema } : {}),
        // The consent question travels with the refusal: the model passes
        // _askArgs to builder_ask_questions as the hint says.
        ...(res && res._askArgs ? { code: res.code, _askArgs: res._askArgs } : {}),
        // Carry the entry's own hint. Without it applyToolCall stamps
        // this batch failure with "invalid input binding", so a refusal
        // that said "that app is not connected" reached the model as
        // advice to fix a binding it got right.
        ...(fullHint ? { _fixHint: fullHint } : {}),
        ...(warnings ? { _warnings: warnings } : {}),
    };
}

/** Why a $handle did not resolve: declared later, on itself, or never. */
function missingRefMessage(missing, entries, i, at, idMap) {
    // Distinguish "declared later" from "never declared". The old
    // message said only "not an EARLIER entry", which reads as a typo
    // report — so a model that had simply ordered its entries wrongly
    // went looking for a misspelling instead of moving the entry. This
    // was the most frequent remaining failure in measured builds.
    const laterAt = entries.findIndex((x, j) => j > i && x && x.tempId === missing);
    const declaredHere = entries.some(x => x && x.tempId === missing);
    const known = Object.keys(idMap);
    const err = laterAt > -1
        ? `${at}: "steps.$${missing}" refers to tempId "${missing}", which this call declares LATER at steps[${laterAt}]. A step can only reference something built before it — move entry ${laterAt} ahead of entry ${i}.`
        : declaredHere
            ? `${at}: "steps.$${missing}" refers to tempId "${missing}", declared on this same entry. A step cannot reference its own output.`
            : (() => {
                // The overwhelmingly common case, measured: the model
                // references $handle but never put `tempId` on the
                // entry it means. "not declared" is true and useless —
                // name the entry and the exact field to add, or it
                // retries the identical call two to four times.
                const anon = entries.findIndex((x, j) => j < i && x && !x.tempId);
                if (anon > -1) {
                    const what = entries[anon].spec?.tool || entries[anon].type || 'that step';
                    return `${at}: "steps.$${missing}" refers to tempId "${missing}", but no entry declares it — steps[${anon}] (${what}) has NO tempId. Add "tempId": "${missing}" to steps[${anon}], then this reference resolves. A $handle only exists if an earlier entry declares it.`;
                }
                return `${at}: "steps.$${missing}" refers to tempId "${missing}", which this call never declares. Declared so far: ${known.length ? known.map(k => '$' + k).join(', ') : '(none)'}. For a step that already exists, use its real id instead of a $tempId.`;
            })();
    return err;
}

/** Resolve $tempId wiring fields in place; returns the first error, or null. */
function resolveWires(spec, idMap, at) {
let wireErr = null;
const resolveWire = (val, field) => {
    if (typeof val === 'string' && val.startsWith('$')) {
        const real = idMap[val.slice(1)];
        if (!real) { wireErr = wireErr || `${at}: ${field} "${val}" is not an EARLIER entry's tempId.`; return val; }
        return real;
    }
    return val;
};
for (const f of ['afterStepId', 'thenStepId', 'elseStepId']) {
    if (f in spec) spec[f] = resolveWire(spec[f], f);
}
if (spec.nextStepIds && typeof spec.nextStepIds === 'object' && !Array.isArray(spec.nextStepIds)) {
    for (const k of Object.keys(spec.nextStepIds)) spec.nextStepIds[k] = resolveWire(spec.nextStepIds[k], `nextStepIds.${k}`);
}
    return wireErr;
}

module.exports = { junkEntriesError, validateEntries, evictRemoved, buildFailure, missingRefMessage, resolveWires };
