/**
 * App Studio builder tools — the ARRAY form shared by app_update_component,
 * app_set_action and app_bind_action: reading the batch argument beside its
 * single form, applying one single-item tool across the batch against the live
 * draft, and shaping the outcome (partial: one bad patch never voids the rest).
 */

'use strict';

const { canonicalJson } = require('../../../automation/builderTools/suggestedPatch');
const { MAX_BATCH_PATCHES_PER_CALL } = require('../schemas');

// ── Batch forms (app_update_component / app_set_action / app_bind_action) ──
//
// app_add_components has batched since day one; these three did not, so a plain
// calculator cost ~70 sequential calls. Each now takes an ARRAY form alongside
// its single form (unchanged, verbatim, for back-compat).
//
// Unlike app_add_components — all-or-nothing, because half a component tree is
// worse than none — a patch batch is PARTIAL: one bad patch must not void 39
// good ones, and the model must be able to tell WHICH failed. Failures are
// reported at their index; the rest land.

/**
 * Read the optional batch argument. Returns { single:true } when the caller
 * used the single form, { items } for a batch, or { error }.
 */
function readBatchArg(args, key, singleKey) {
    const raw = args?.[key];
    if (raw === undefined || raw === null) return { single: true };
    if (!Array.isArray(raw)) {
        return { error: `${key} must be an array of ${key === 'updates' ? 'patch' : 'entry'} objects — or omit it and use the single form (${singleKey}).` };
    }
    if (!raw.length) return { error: `${key} is empty — pass at least one entry, or use the single form (${singleKey}).` };
    if (raw.length > MAX_BATCH_PATCHES_PER_CALL) {
        return { error: `${key}: max ${MAX_BATCH_PATCHES_PER_CALL} entries per call — split the batch into two calls.` };
    }
    if (args[singleKey] !== undefined) {
        // Measured 2026-09-13: `{id, updates:[{id, props}]}` five times in a row —
        // the single id repeated on the batch's one entry. Both forms name the
        // same thing: take the batch; stamp the single id on entries that lack
        // one; refuse only when they really disagree.
        const single = args[singleKey];
        const idKey = singleKey === 'id' ? 'id' : (singleKey === 'nodeId' ? 'nodeId' : null);
        if (idKey && typeof single === 'string') {
            const disagree = raw.some((it) => it && typeof it === 'object' && typeof it[idKey] === 'string' && it[idKey] !== single);
            if (!disagree) {
                const items = raw.map((it) => (it && typeof it === 'object' && it[idKey] === undefined ? { ...it, [idKey]: single } : it));
                return { items, note: `${singleKey} and ${key} both given — read as the ${key} batch (every entry names ${single}). Pass one form next time.` };
            }
        }
        return { error: `Pass EITHER the single form (${singleKey}) or the batch form (${key}) — not both.` };
    }
    return { items: raw };
}

/**
 * Apply one single-item tool function across a batch, sequentially, against
 * the LIVE draft (so later entries see what earlier ones did — a binding may
 * reference an action created two entries up).
 */
async function runPatchBatch(draftWrap, items, singleFn) {
    const ok = [];
    const failed = [];
    const hints = [];
    // Sequential and awaited: the three tools it drives are synchronous today,
    // but awaiting costs nothing and means a later async rewrite of any of them
    // cannot turn every entry into a silently-successful Promise.
    for (const [index, item] of items.entries()) {
        let res;
        try {
            res = await singleFn(draftWrap, item);
        } catch (e) {
            res = { error: e.message };
        }
        if (!res || typeof res !== 'object') res = {};
        if (res.error) {
            failed.push({
                index,
                error: res.error,
                ...(res._fixHint ? { _fixHint: res._fixHint } : {}),
                ...(res._suggestedPatch ? { _suggestedPatch: res._suggestedPatch } : {}),
                ...(Array.isArray(res._hints) && res._hints.length ? { _hints: res._hints } : {}),
                _item: item,
            });
            continue;
        }
        if (Array.isArray(res._hints)) hints.push(...res._hints.map((h) => `[${index}] ${h}`));
        ok.push({ index, result: res });
    }
    return { ok, failed, hints };
}

/**
 * Shape a batch outcome into a tool result. Nothing applied → a plain `error`
 * (so the route reports the call as failed and skips the draft emit); anything
 * applied → success carrying the per-index failures, because the good work is
 * already in the draft and hiding that would make the model redo it.
 */
function finishPatchBatch({ ok, failed, hints, allFailed, summary, listKey = 'entries' }) {
    const total = ok.length + failed.length;
    // Per-entry fixes lifted to the batch: each op's path is prefixed with
    // the entry's index and pinned to the entry's own signature, so rung 2
    // applies it on an identical batch resend and never to whatever now sits
    // at that index (automation/builderTools/suggestedPatch semantics).
    const liftedOps = [];
    const reasons = [];
    const cleanFailed = failed.map((f) => {
        const { _item, _suggestedPatch, ...rest } = f;
        if (_suggestedPatch && Array.isArray(_suggestedPatch.ops)) {
            const entrySig = canonicalJson(_item);
            for (const op of _suggestedPatch.ops) {
                if (!op || typeof op !== 'object') continue;
                const lift = (p) => (typeof p === 'string' ? `${listKey}[${f.index}]${p ? `.${p}` : ''}` : p);
                liftedOps.push(op.op === 'move'
                    ? { ...op, from: lift(op.from), to: lift(op.to), entrySig }
                    : { ...op, path: lift(op.path), entrySig });
            }
        }
        if (f._fixHint) reasons.push(`[${f.index}] ${f._fixHint}`);
        return rest;
    });
    if (!ok.length) {
        return {
            error: allFailed,
            failed: cleanFailed,
            _fixHint: reasons.length ? reasons.join(' ') : 'Every entry was rejected — fix the reported errors and resend the batch.',
            ...(liftedOps.length ? { _suggestedPatch: { ops: liftedOps, why: 'the entries named their own fixes' } } : {}),
            ...(hints.length ? { _hints: hints } : {}),
        };
    }
    const result = { batch: true, applied: ok.length, ...summary };
    const allHints = [...hints];
    if (failed.length) {
        result.failed = cleanFailed;
        allHints.push(`${failed.length} of ${total} entries failed and were skipped; the other ${ok.length} were applied. Fix and resend ONLY the failed ones (see failed[].index).`);
    }
    if (allHints.length) result._hints = allHints;
    return result;
}

module.exports = {
    readBatchArg,
    runPatchBatch,
    finishPatchBatch,
};
