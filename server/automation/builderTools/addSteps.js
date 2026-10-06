/**
 * Builder tools — builder_add_steps: the batch append with $tempId
 * cross-references. Every entry runs through the SAME per-type builders as
 * the single-step tools. Entries apply IN ORDER and the built prefix stays:
 * a failing entry i is rolled back alone, 0..i-1 keep their ids, and a
 * resend never builds an entry twice (per-turn handle map + fingerprints on
 * draftWrap). Required from within automation/builderTools/ and the
 * ../builderTools facade.
 */

const { findStepAnywhere } = require('./draftGraph');
const {
    applyAddAction, applyAddArrayOp, PARSE_JSON_RETIRED_MSG, ADD_FOR_TYPE, findDuplicateAction,
} = require('./stepBuilders');
const { applyAddCallLayer } = require('./layers');
const { validateAndFixBindings } = require('./bindings');
const { canonicalJson, liftEntryPatch } = require('./suggestedPatch');

// ── builder_add_steps: batch append with tempId cross-references ──────────

const { TEMP_ID_RX, rewriteTempRefs, resolveHandlesForResend, resolveAnchor } = require('./tempRefs');

// Stamped on every $handle failure. Without its own hint, applyToolCall's
// generic matcher saw the word "refers" and labelled these "invalid input
// binding — fix the path/value", sending the model off to rewrite bindings
// that were fine. Measured twice in one build before it recovered on its own.
const TEMP_REF_HINT = 'Reject reason: a $tempId handle did not resolve. Fix the handle or the tempId it should point at and resend the batch — the bindings themselves were not the problem.';

// The three keys an entry itself has. Anything else beside `spec` is a step
// field that belongs INSIDE spec. Measured with the fast local model: told
// "source is required", it answered by adding `source` NEXT TO spec — and
// resent that byte-identical batch three rounds running, because the same
// message came back each time. The schema already says "never at the entry
// level"; a parser that quietly moves the field is what ends the loop.
const ENTRY_KEYS = new Set(['tempId', 'type', 'spec']);

// Type names the model reaches for that are not ours. `action` is what the
// live tool_draft scanner already maps; the others were seen in traces.
const TYPE_ALIASES = Object.freeze({
    action: 'integration_action', integration: 'integration_action', tool: 'integration_action',
    ai: 'ai_step', llm: 'ai_step',
    extraction: 'data_extraction', extract: 'data_extraction', data_extract: 'data_extraction',
    http: 'http_request', notify: 'notification', document: 'generate_document',
    // The other document step, by the words a model reaches for. `document`
    // above stays pointed at generate_document: it has been that since the
    // type existed, and re-aiming an alias would silently change what an
    // existing brief builds.
    fill: 'fill_document', invoice: 'fill_document', template_document: 'fill_document',
    // The presentation pair, by the words a model reaches for.
    deck: 'presentation', pptx: 'presentation', powerpoint: 'presentation', slides: 'presentation',
    dia: 'slide',
});

// A string value carrying JSON punctuation followed by another key is the
// signature of a batch whose JSON arrived corrupted mid-way — core/llm/
// partialJsonScan.looksGarbled, shared with the App Studio builder.
const { looksGarbled } = require('../../core/llm/partialJsonScan');

// The datatable evidence a typeless entry can carry: an addressing field, or
// an op the datatable step knows — canonical, or one of the aliases
// builder_add_datatable accepts (append/insert/upsert/list/query). The alias
// table lives in ./datatableRefs, which is being added beside this file;
// until it lands the aliases are simply not evidence, and a typeless
// `{op:"append"}` stays what it was — an entry the loop rejects for its
// missing type — rather than a boot failure.
const { DATATABLE_OPS } = require('../validate/constants');
const { DATATABLE_OP_ALIASES } = require('./datatableRefs');

// What a missing `type` can be read from without guessing. `prompt` is NOT
// evidence: ai_step, approval and form_page all take one.
function inferEntryType(spec) {
    if (!spec || typeof spec !== 'object') return null;
    if (typeof spec.tool === 'string' && spec.tool) return 'integration_action';
    if (spec.source !== undefined && Array.isArray(spec.fields)) return 'data_extraction';
    // Measured with the fast local model on the invoice brief: the save step
    // arrived as {op:"add_row", datatableId:…, values:…} with no type, and
    // the batch refused it three rounds running. Nothing but a datatable
    // step carries datatableId/datatableKey, and no array_op op collides
    // with the datatable op names.
    if (spec.datatableId !== undefined || spec.datatableKey !== undefined
        || (typeof spec.op === 'string' && (DATATABLE_OPS.has(spec.op) || Object.hasOwn(DATATABLE_OP_ALIASES, spec.op)))) {
        return 'datatable';
    }
    return null;
}

/**
 * One batch entry in the shape the loop below expects, repaired where the
 * repair is unambiguous: stray step fields hoisted into spec (spec's own
 * value wins when both exist), a type alias resolved, an absent type read
 * off the spec. Every repair is written to `notes` so the model sees, in the
 * success result, what it should have sent — the shape is corrected, the
 * habit is corrected by the note.
 */
function normaliseEntry(raw, i, notes) {
    const e = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? { ...raw } : {};
    const stray = Object.keys(e).filter(k => !ENTRY_KEYS.has(k));
    if (stray.length) {
        const spec = (e.spec && typeof e.spec === 'object' && !Array.isArray(e.spec)) ? { ...e.spec } : {};
        const moved = [];
        const shadowed = [];
        for (const k of stray) {
            if (k in spec) shadowed.push(k);
            else { spec[k] = e[k]; moved.push(k); }
            delete e[k];
        }
        e.spec = spec;
        const parts = [];
        if (moved.length) parts.push(`${moved.map(k => `"${k}"`).join(', ')} ${moved.length > 1 ? 'were' : 'was'} placed next to spec — moved inside it`);
        if (shadowed.length) parts.push(`${shadowed.map(k => `"${k}"`).join(', ')} appeared both next to and inside spec — spec's value kept`);
        notes.push(`steps[${i}]: ${parts.join('; ')}. Every step field belongs INSIDE spec; only tempId and type sit beside it.`);
    }
    if (typeof e.type === 'string' && !ADD_FOR_TYPE[e.type] && e.type !== 'array_op' && TYPE_ALIASES[e.type]) {
        notes.push(`steps[${i}]: type "${e.type}" read as "${TYPE_ALIASES[e.type]}".`);
        e.type = TYPE_ALIASES[e.type];
    }
    if (!e.type) {
        const inferred = inferEntryType(e.spec);
        if (inferred) {
            notes.push(`steps[${i}]: had no type — read as "${inferred}" from its spec. Always send type explicitly.`);
            e.type = inferred;
        }
    }
    return e;
}

// ── Per-turn memory of what a batch built ───────────────────────────
//
// Measured 2026-09-12/13 with the fast local model: a batch of four whose
// entry 1 was refused came back byte-identical three rounds running. Under
// all-or-nothing that resend was the ONLY move that could succeed once the
// entry was fixed — and it was also what built the same list step twice
// when the model fixed entry 1 but kept entry 0 in the call. So the built
// prefix stays, and the three maps below make the resend harmless:
//   _tempIds        tempId → minted id, so steps.$list of a built entry
//                   still resolves on the next call of the turn;
//   _builtThisTurn  fingerprint → {id}, so an entry that was built is
//                   reported back, not built again;
//   _mintedThisTurn ids this turn minted, so an integration_action whose
//                   spec drifted (a bare literal instead of a binding) but
//                   whose tool+inputs equal a step minted this turn is the
//                   same no-op — while the single-step tool keeps refusing a
//                   duplicate, because there nothing says "resend".
// The route builds a fresh draftWrap per turn (builderDraft.js) and the MCP
// surface per call, so the handles live exactly as long as the schema says.
//   _rawEntryByHandle tempId → the entry AS SENT that minted it, so a
//                   byte-identical resend of an entry the server repaired
//                   on dispatch (rung 2 of the ladder) is still recognised
//                   as a resend — its fingerprint is of the patched spec.
function turnState(draftWrap) {
    const w = draftWrap && typeof draftWrap === 'object' ? draftWrap : {};
    if (!w._tempIds || typeof w._tempIds !== 'object') w._tempIds = Object.create(null);
    if (!(w._builtThisTurn instanceof Map)) w._builtThisTurn = new Map();
    if (!(w._mintedThisTurn instanceof Set)) w._mintedThisTurn = new Set();
    if (!w._rawEntryByHandle || typeof w._rawEntryByHandle !== 'object') w._rawEntryByHandle = Object.create(null);
    return w;
}

// What makes two entries "the same step": type + the spec as it is about
// to be built (handles already rewritten to real ids) + where it lands —
// the explicit afterStepId, else the entry that landed before it — minus
// its label. Key order does not count (canonicalJson). Measured 2026-09-13:
// with the anchor stripped, a second wait{seconds:30} after a later poll,
// and a second 'Done' notification on the other branch tail, matched the
// first copy's fingerprint inside ONE call and came back `reused:true` —
// the automation ran its polls back to back while the result listed both
// entries as added. A byte-identical resend of a built prefix still
// matches entry for entry, because reuse() below walks the same anchor
// chain the first build did.
function fingerprintOf(type, spec, anchor) {
    const { label, afterStepId, ...rest } = spec || {};
    void label; void afterStepId;
    return `${type}\n${anchor || ''}\n${canonicalJson(rest)}`;
}

// The inputs as applyAddAction will store them: a bare value is wrapped as
// a literal there (canonicalizeInputs), so a resend that dropped the
// {kind:"literal"} envelope must compare equal to the step it built.
function comparableInputs(graph, inputs) {
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return null;
    if (!Object.keys(inputs).length) return null;
    try {
        const fixed = validateAndFixBindings(inputs, graph);
        return fixed.error ? inputs : fixed.inputs;
    } catch (_) { return inputs; }
}

/**
 * builder_add_steps — append several steps in ONE call. Each entry is
 * {tempId?, type, spec} where `spec` is exactly the matching builder_add_<type>
 * args. Entries apply in order through the SAME per-type builders as the
 * single-step tools (inheriting every validation, binding fix-up, inspect
 * gate and edge auto-wiring); an entry without afterStepId chains after the
 * previous entry. Batch-level pre-validation (handle grammar, types, spec
 * shape) applies nothing. From then on each entry is snapshotted and rolled
 * back ALONE on failure: the result names the failing index, lists what was
 * built (`added`, same key as success), and carries `resendAs` — the failing
 * entry with real ids and its anchor — so the model resends from that index
 * (gate rejections keep their inlined `toolSchema` so the retry costs one
 * round). Entries already built this turn come back `reused:true`.
 */
function applyAddSteps(graph, args, { draft, scope = null, sent = null } = {}, draftWrap) {
    const rawEntries = Array.isArray(args?.steps) ? args.steps : null;
    if (!rawEntries || !rawEntries.length) return { error: 'steps must be a non-empty array of { tempId?, type, spec }.' };
    // The entries as the MODEL sent them. On a rung-2 resend applyToolCall
    // dispatches the patched args, so `rawEntries` carries the repair and
    // `sent` is what the model will send again when it repeats itself.
    const sentEntries = Array.isArray(sent?.steps) && sent.steps.length === rawEntries.length ? sent.steps : rawEntries;
    if (rawEntries.length > 20) return { error: 'steps: max 20 entries per call — split the build into two calls, with fresh tempIds in the second (a handle names ONE step for the whole turn).' };

    // An entry that is not an object at all. The normaliser turns one into
    // `{}` and the batch then fails on the FIRST entry with no type, which
    // sends the model back to redesign a step that was fine. Measured
    // 2026-09-16: a batch arrived as
    // [{…}, {spec, label}, "$filter_files", "array_op", "},{spec:{op:"] —
    // one entry's tempId, type and the JSON between them, each as a bare
    // array element. Nothing there is a step; the call was mangled in
    // transit, and that is what the model has to be told.
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

    // Repairs ride on the result as warnings — on a partial failure too, so
    // the model sees what happened to the entries that did land.
    const notes = [];
    // A step field at the ROOT of the call (`{steps:[…], type:"integration_action"}`,
    // measured 2026-09-16) belongs to an entry. It is ignored either way; said
    // once, the next batch does not carry it.
    const strayRoot = Object.keys(args || {}).filter(k => k !== 'steps');
    if (strayRoot.length) {
        notes.push(`${strayRoot.map(k => `"${k}"`).join(', ')} sat at the root of the call and ${strayRoot.length > 1 ? 'were' : 'was'} ignored — the call takes only \`steps\`, and every step field belongs inside that entry's spec.`);
    }
    const entries = rawEntries.map((e, i) => normaliseEntry(e, i, notes));

    // Pre-validate every entry BEFORE mutating anything. A tempId that was
    // already used THIS TURN is not a collision (it is not a node id) — the
    // loop below decides whether it is a resend or a re-use with a new spec.
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

    const turn = turnState(draftWrap);
    const added = [];
    let warnings = notes.length ? [...notes] : null;
    const note = (line) => { (warnings = warnings || []).push(line); };
    let lastAppliedId = null;

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

    // The call's handle map starts from what this turn already built, so a
    // resend from the failing index still resolves steps.$<built>.
    const idMap = Object.assign(Object.create(null), turn._tempIds);

    // "Already built this turn" is answered against what was built BEFORE
    // this call. A call can never be a resend of itself — only an earlier
    // call of the turn can. Measured: one call [wait 60s, notif, wait 60s,
    // notif] built 2 steps and mapped $w2 to $w1, and a condition whose
    // both branches ended in the same notification lost the else copy.
    // The turn-level maps are still written below, so a resend in a LATER
    // call still comes back `reused:true`.
    const builtBefore = new Map(turn._builtThisTurn);
    const mintedBefore = new Set(turn._mintedThisTurn);

    // The partial result. `added` is the SAME key as on success — entries
    // 0..i-1 as built — and `resendAs` is the one call that continues the
    // batch: the failing entry, handles already real ids, anchored after the
    // last entry that landed unless it named its own anchor.
    const fail = (i, spec, error, res) => {
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
            ? `The entry in resendAs has "${rejectedPath}" REMOVED — it is the value that was refused. Fill it with one of the options in the error, or ask the user, before resending.`
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
            // Carry the entry's own hint. Without it applyToolCall stamps
            // this batch failure with "invalid input binding", so a refusal
            // that said "that app is not connected" reached the model as
            // advice to fix a binding it got right.
            ...(fullHint ? { _fixHint: fullHint } : {}),
            ...(warnings ? { _warnings: warnings } : {}),
        };
    };

    // An entry this turn already built: reported, not dispatched.
    const reuse = (i, e, id, type, tool, extra) => {
        if (e.tempId) {
            const have = turn._tempIds[e.tempId];
            if (have && have !== id) {
                note(`steps[${i}] ($${e.tempId}): "$${e.tempId}" already names ${have} in this turn; this entry is the step built as ${id} — "$${e.tempId}" keeps pointing at ${have}.`);
            } else {
                turn._tempIds[e.tempId] = id;
                idMap[e.tempId] = id;
            }
        }
        added.push({
            ...(e.tempId ? { tempId: e.tempId } : {}),
            id, type,
            ...(tool ? { tool } : {}),
            reused: true,
            ...(extra || {}),
        });
        // A reused entry is the last one that landed in order: without this
        // a resend-the-whole-batch prefix left lastAppliedId null, the hint
        // read `chains after "null"`, resendAs carried no anchor, and the
        // entry after it took a different anchor on the resend than at first
        // build — measured: the add path stored afterStepId:"null" as a
        // dangling edge (edge.unknown_from), and an un-anchored resend
        // chained after whatever else the turn had appended.
        lastAppliedId = id;
    };

    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const at = `steps[${i}]${e.tempId ? ` ($${e.tempId})` : ''}`;

        // Resolve $tempId references (inline paths + bare wiring fields).
        let missing = null;
        let bare = null;
        const spec = rewriteTempRefs(structuredClone(e.spec), idMap,
            (t) => { missing = missing || t; },
            (t, real) => { bare = bare || { t, real }; });
        if (bare) {
            return fail(i, spec, `${at}: "steps.${bare.t}" looks like tempId "${bare.t}" from this batch but is missing the $. Write steps.$${bare.t}… so it resolves — or use the minted id "${bare.real}". A bare tempId is stored verbatim and dangles.`, { _fixHint: TEMP_REF_HINT });
        }
        if (missing) {
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
            return fail(i, spec, err, { _fixHint: TEMP_REF_HINT });
        }
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
        if (wireErr) return fail(i, spec, wireErr, { _fixHint: TEMP_REF_HINT });

        // Default chaining: no explicit anchor → appendAfter's layerAwareAnchor
        // targets the graph tail, which after entry i-1 IS entry i-1 — and,
        // unlike an explicit afterStepId, keeps the flowlet layer_output
        // splice intact (an explicit anchor deliberately skips that splice).
        delete spec.scope; // scope was resolved at dispatch; nested scopes are invalid

        // ── Already built this turn? Three ways to tell, in order. ──
        // spec.afterStepId is a real id here (resolveWire ran above).
        const fp = fingerprintOf(e.type, spec, spec.afterStepId || lastAppliedId);
        const prior = builtBefore.get(fp);
        if (prior) {
            reuse(i, e, prior.id, prior.type, prior.tool);
            note(`${at}: already built in this turn as ${prior.id} — not added twice.`);
            continue;
        }
        if (e.tempId && turn._tempIds[e.tempId]) {
            const id = turn._tempIds[e.tempId];
            const built = findStepAnywhere(graph, id)?.step;
            // A resend: the previous call was refused (a drifted resend of
            // the whole batch), or this is the very entry that minted the
            // handle, byte for byte — its fingerprint differs only because
            // the server patched it on dispatch (rung 2) and the model resent
            // its own version again.
            const sameEntryAgain = turn._rawEntryByHandle[e.tempId] === canonicalJson(sentEntries[i]);
            if (turn._lastRejected || sameEntryAgain) {
                // The handle is taken and the spec drifted. Skipped, never
                // refused: the entries after it may be the ones the resend
                // was for, and they keep resolving $handle.
                reuse(i, e, id, built?.type || e.type, built?.tool || null, { differs: true });
                note(`${at}: "$${e.tempId}" was already built as ${id} with a different spec; the built one was kept. Change it with builder_update_step({stepId:"${id}", patch:{…}}).`);
                continue;
            }
            // Measured shape: the previous batch SUCCEEDED, so nothing is
            // being resent — the model recycled a generic handle ("read",
            // "ai") for a different step in a later call of the same turn.
            // Skipping here built the earlier step into this chain and
            // dropped the new one; the graph finalised clean and read the
            // wrong list. Refused through the partial-result contract, with
            // resendAs already carrying a free handle.
            let fresh = `${e.tempId.slice(0, 23)}2`;
            for (let n = 3; (seen.has(fresh) || turn._tempIds[fresh]) && n < 100; n++) fresh = `${e.tempId.slice(0, 23)}${n}`;
            entries[i] = { ...e, tempId: fresh };
            return fail(i, spec,
                `${at}: tempId "${e.tempId}" already names ${id} (${built?.type || e.type}${built?.tool ? '/' + built.tool : ''}) in this turn and this entry is a different step. A handle names ONE step per turn — give this one a fresh tempId.`,
                { _fixHint: `Reject reason: tempId "${e.tempId}" is already bound this turn. Resend this entry as tempId "${fresh}" and write steps.$${fresh}… / "$${fresh}" in the entries after it; to change ${id} instead, call builder_update_step({stepId:"${id}", patch:{…}}).` });
        }
        if (e.type === 'integration_action' && typeof spec.tool === 'string' && spec.tool) {
            const cmp = comparableInputs(graph, spec.inputs);
            const dup = cmp ? findDuplicateAction(graph, spec.tool, cmp) : null;
            if (dup && mintedBefore.has(dup.id)) {
                reuse(i, e, dup.id, 'integration_action', dup.tool);
                note(`${at}: ${spec.tool} with these inputs was already built in this turn as ${dup.id} — not added twice.`);
                continue;
            }
        }

        // ── Dispatch, with THIS entry's own snapshot. ──
        const snapSteps = structuredClone(graph.steps);
        const snapEdges = structuredClone(graph.edges);
        let res;
        try {
            if (e.type === 'integration_action') res = applyAddAction(graph, spec, draftWrap);
            else if (e.type === 'call_layer') res = applyAddCallLayer(draft, spec, { graph, scope });
            else if (e.type === 'array_op') res = applyAddArrayOp(graph, spec, draftWrap);
            // draftWrap flows to every builder: the gates read it, and every
            // binding check reads the shapes a dry run left on it.
            else res = ADD_FOR_TYPE[e.type](graph, spec, draftWrap);
        } catch (err) { res = { error: err.message }; }

        if (!res || res.error) {
            // Only this entry is undone. A builder that mutated before it
            // threw leaves nothing behind; entries 0..i-1 are untouched.
            graph.steps = snapSteps;
            graph.edges = snapEdges;
            return fail(i, spec, `${at}: ${res?.error || 'builder failed'}`, res);
        }
        const id = res.added.id;
        if (e.tempId) { idMap[e.tempId] = id; turn._tempIds[e.tempId] = id; turn._rawEntryByHandle[e.tempId] = canonicalJson(sentEntries[i]); }
        turn._mintedThisTurn.add(id);
        turn._builtThisTurn.set(fp, { id, tempId: e.tempId || null, type: res.added.type, tool: res.added.tool || null });
        lastAppliedId = id;
        if (res._warnings) (warnings = warnings || []).push(...res._warnings.map(w => `${at}: ${w}`));
        added.push({
            ...(e.tempId ? { tempId: e.tempId } : {}),
            id,
            type: res.added.type,
            ...(res.added.tool ? { tool: res.added.tool } : {}),
        });
    }
    return { added, idMap: { ...idMap }, ...(warnings ? { _warnings: warnings } : {}) };
}

module.exports = {
    applyAddSteps,
};
