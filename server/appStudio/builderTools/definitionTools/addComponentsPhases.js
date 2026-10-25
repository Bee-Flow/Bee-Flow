/**
 * App Studio builder tools — the phases of app_add_components that do not
 * depend on the per-entry build loop: argument preparation, the three refusal
 * answers, landing the nodes in the draft and recording the batch. Split out of
 * addComponents.js, which keeps the build loop and its twin-dedupe closures.
 */

'use strict';

const { COMPONENT_TYPES } = require('../../componentSpecs');
const ops = require('../../definitionOps');
const { normaliseAddComponentsArgs } = require('../componentNormalise');
const { defaultParentSection, pageHeaderBelongsOnTop } = require('./componentPlacement');
const { topIndexOf, containerPathOf } = require('./componentEntries');
const { stripTempIds } = require('./batchIdentity');

/** Normalise the raw call and read the parent the model meant (root aliases, batch envelope, missing parentId, a screen id as parent). */
function prepareAddArgs(def, draftWrap, rawArgs) {
    const { args, notes, garbled } = normaliseAddComponentsArgs(rawArgs);
    // `{components:[{parentId, children:[…]}]}` — the batch envelope sent as
    // the one entry (measured 15× in one turn, 2026-09-13): lift it.
    if (args && Array.isArray(args.components) && args.components.length === 1) {
        const only = args.components[0];
        if (only && typeof only === 'object' && only.type === undefined && Array.isArray(only.children) && only.children.length && (typeof only.parentId === 'string' || args.parentId === undefined)) {
            if (typeof only.parentId === 'string' && !args.parentId) args.parentId = only.parentId;
            args.components = only.children;
            notes.push('components[0] carried parentId + children and no type — read as the batch itself (its children are the components).');
        }
    }
    // No parentId (measured 15× in one turn, 2026-09-13: a nested batch sent
    // without one): when the draft leaves no doubt — one screen, or the screen
    // added most recently this turn — its first section is the parent.
    if ((args?.parentId === undefined || args?.parentId === null || args?.parentId === '') && args) {
        const guess = defaultParentSection(def, draftWrap, args);
        if (guess) {
            args.parentId = guess.sectionId;
            notes.push(`parentId was missing — read as ${guess.sectionId} (the first section of screen "${guess.screenName}"${guess.why}). Pass the section id next time.`);
        }
    }
    // A screen id as the parent: its first section.
    if (args && typeof args.parentId === 'string' && /^scr_/.test(args.parentId)) {
        const scr = (def.screens || []).find((x) => x && x.id === args.parentId);
        const sec = scr && Array.isArray(scr.sections) ? scr.sections.find((x) => x && x.id) : null;
        if (sec) { notes.push(`parentId ${args.parentId} is a screen — read as its first section ${sec.id}.`); args.parentId = sec.id; }
    }
    return { args, notes, garbled };
}

/** The soft "Nothing new" answer for a batch (or its forms) that already landed this turn. */
function duplicateBatchError(seen, viaForms, args, notes) {
        seen.dupes += 1;
        const idList = seen.added.map((a) => `${a.type} ${a.id}${a.name ? ` (form "${a.name}")` : ''}`).slice(0, 12).join(', ');
        const formId = seen.added.find((a) => a.type === 'form')?.id || Object.values(seen.ids)[0];
        return {
            error: `Nothing new: ${viaForms ? 'the form(s) in this batch already exist on this screen' : 'this exact batch already landed this turn'} under ${args.parentId} as ${idList}${seen.added.length > 12 ? ', …' : ''} — the draft is unchanged.`,
            alreadyAdded: { added: seen.added, ids: seen.ids },
            _repeated: seen.dupes,
            _fixHint: `Reject reason: duplicate batch — ${viaForms ? 'a form name is unique per screen, and these forms are already there' : 'identical content under the same parent'}. Use the ids above; do not resend. Continue with the next step of your plan (create the action with app_set_action, then app_bind_action {nodeId:${formId ? `"${formId}"` : '<form id>'}, event:"onSubmit"}).`,
            ...(notes.length ? { _hints: notes } : {}),
        };
}

/** Every entry had landed before: the classic duplicate answer, with the ids to use. */
function allLandedError(skipped, idMap, args, notes, entryHints) {
        // Every entry had landed before, under a signature the identical-
        // batch net could not match (a fragment more, a group lifted): the
        // classic duplicate answer, with the ids the model should be using.
        const idList = skipped.map((k) => `${k.type} ${k.id}`).slice(0, 12).join(', ');
        return {
            error: `Nothing new: every entry of this batch already landed this turn under ${args.parentId} as ${idList}${skipped.length > 12 ? ', …' : ''} — the draft is unchanged.`,
            alreadyAdded: { added: skipped.map((k) => ({ id: k.id, type: k.type })), ids: { ...idMap } },
            _fixHint: 'Reject reason: duplicate batch — these components are already there. Use the ids above; do not resend. Continue with the next step of your plan.',
            ...(notes.length || entryHints.length ? { _hints: [...notes, ...entryHints] } : {}),
        };
}

/** Nothing landed: a plain error led by the first failure's own message. */
function nothingLandedError(failed, corruptionNote, notes, entryHints) {
        // Nothing landed: a plain error (the route reports the call as failed
        // and skips the draft emit), led by the first failure's own message.
        const first = failed[0] || { error: 'components: nothing to add — every entry was a fragment of corrupted JSON.' };
        const unknownType = failed.some((f) => /unknown component type/.test(f.error));
        return {
            error: `${first.error}${failed.length > 1 ? ` (${failed.length - 1} more entr${failed.length === 2 ? 'y' : 'ies'} failed — see failed[])` : ''}${corruptionNote ? ` ${corruptionNote}` : ''}`,
            ...(failed.length ? { failed } : {}),
            _fixHint: unknownType
                ? `Legal component types: ${COMPONENT_TYPES.join(', ')}. Check the catalog for each type's props and style knobs.`
                : (first._fixHint || 'Nothing was applied. Resend with complete, well-formed JSON, one card per call.'),
            ...(notes.length || entryHints.length ? { _hints: [...notes, ...entryHints] } : {}),
        };
}

/** Insert the landed nodes (and the new children of containers that had landed) into the draft. */
function insertLanded(def, args, nodes, placed, extra, notes) {
    let next = def;
    const explicitIndex = Number.isInteger(args?.index) ? args.index : null;
    const landed = nodes.map((n) => n.node);
    const hoist = explicitIndex === null ? pageHeaderBelongsOnTop(def, args.parentId, landed) : null;
    if (hoist !== null) {
        notes.push('page_header placed at the TOP of the section: components render in the order they are added, so a header that arrives after the rest would sit below it.');
    }
    const baseIndex = explicitIndex !== null ? explicitIndex : hoist;
    if (baseIndex === null && placed.some((p) => p.twinId)) {
        // Beside the entries that had landed: a new node goes right after
        // the nearest landed twin before it in the resend, or before the
        // nearest one after it — the corrected table lands between the
        // header and the text, where the model put it, not below the text.
        const twinIndex = (twinId) => {
            const f = ops.findNode(next, twinId);
            return f && f.parent && f.parent.id === args.parentId ? f.index : null;
        };
        placed.forEach((p, i) => {
            if (!p.node) return;
            let index;
            for (let k = i - 1; k >= 0 && index === undefined; k--) {
                if (!placed[k].twinId) continue;
                const at = twinIndex(placed[k].twinId);
                if (at !== null) index = at + 1;
            }
            for (let k = i + 1; k < placed.length && index === undefined; k++) {
                if (!placed[k].twinId) continue;
                const at = twinIndex(placed[k].twinId);
                if (at !== null) index = at;
            }
            next = ops.insertNode(next, { parentId: args.parentId, index, node: p.node }).def;
        });
    } else {
        landed.forEach((node, i) => {
            const res = ops.insertNode(next, {
                parentId: args.parentId,
                index: baseIndex === null ? undefined : baseIndex + i,
                node,
            });
            next = res.def;
        });
    }
    // The new children of a container that had landed: under its real id,
    // where the resend placed them (ascending, so each index still holds).
    for (const x of extra) {
        next = ops.insertNode(next, { parentId: x.parentId, index: x.index, node: x.node }).def;
    }
    return next;
}

/** Remember what this batch landed (and what it did not) and attach the hints to the result. */
function finishBatch(draftWrap, def, args, result, b) {
    const { canonicalJson, items, batchSig, report, retryOf, added, idMap, skipped, failed, containerOf, notes, entryHints, corruptionNote } = b;
    // The screen this batch landed on — the default parent of a parent-less batch that follows.
    const touched = ops.findSection(def, args.parentId) || (ops.findNode(def, args.parentId) ? { screen: ops.findNode(def, args.parentId).screen } : null);
    if (touched && touched.screen && touched.screen.id) draftWrap._lastTouchedScreenId = touched.screen.id;
    // The batch record: what landed (a retry adds to what its first send
    // landed), and — when the apply was partial — the PATHS that did not, so
    // the identical batch resent builds only those. A dropped child inside a
    // landed container is not among them: that container is built, and the
    // child's resend goes under its id (failed[]._fixHint says so). The
    // landed subset alone is registered too, without failures, so resending
    // just what already exists is "Nothing new".
    // `partial` + `nodes` (every node this batch built or skipped as
    // already built, with its identity and the node it sits under) are what
    // the corrected resend of this batch is deduped against; a record is
    // partial when something failed, or when it continued a partial batch.
    const failedPaths = report.failed.filter((f) => !containerOf(f.path)).map((f) => f.path);
    const partial = report.failed.length > 0 || skipped.length > 0 || Boolean(retryOf);
    const record = {
        added: [...(retryOf ? retryOf.added : []), ...added.map((a) => ({ ...a }))],
        ids: { ...(retryOf ? retryOf.ids : {}), ...idMap },
        parentId: args.parentId, dupes: 0, failedPaths,
        partial,
        nodes: [...(retryOf && Array.isArray(retryOf.nodes) ? retryOf.nodes : []), ...report.nodes],
    };
    draftWrap._addedBatches.set(batchSig, record);
    if (failedPaths.length) {
        const failedTop = new Set(failedPaths.map(topIndexOf));
        const landedRaw = items.filter((it) => !failedTop.has(topIndexOf(it.at))).map((it) => it.raw);
        if (landedRaw.length) draftWrap._addedBatches.set(canonicalJson({ parentId: args.parentId, components: stripTempIds(landedRaw) }), { ...record, failedPaths: [] });
    }
    // Repair notes, then entry-key hints (what the tool THREW AWAY), then the
    // canonicalizer's repairs of what it kept.
    const lead = [...notes, ...entryHints];
    if (failed.length) {
        result.failed = failed;
        lead.push(`${failed.length} entr${failed.length === 1 ? 'y' : 'ies'} failed and ${failed.length === 1 ? 'was' : 'were'} skipped; the rest landed (see \`added\`). Fix and resend ONLY the failed ${failed.length === 1 ? 'one' : 'ones'} (failed[].path says which and where) — never the whole batch.`);
    }
    if (corruptionNote) lead.push(corruptionNote);
    if (lead.length) result._hints = [...lead, ...(result._hints || [])];
}

/** The failed entries as the model reads them (path + the resend it needs), and the corrupted-JSON note. */
function describeFailures(report, garbled) {
    // Paths → the model's resend instructions. A dropped child whose
    // container landed (report.built, any depth) resends under that
    // container's real id; everything else — a top-level entry, a child of a
    // lifted type-less group — resends under the same parent.
    const containerOf = (path) => {
        const containerAt = containerPathOf(path);
        return containerAt ? report.built.get(containerAt) || null : null;
    };
    const failed = report.failed.map((f) => {
        const index = topIndexOf(f.path);
        const container = containerOf(f.path);
        return {
            ...(index !== null ? { index } : {}),
            path: f.path,
            error: f.error,
            _fixHint: container
                ? `Resend ONLY ${f.path} as its own app_add_components call with parentId "${container.id}" (its container, already built); everything in \`added\` is built — do not resend it.`
                : `Resend ONLY ${f.path} as its own app_add_components call (parentId unchanged); everything in \`added\` is built — do not resend it.`,
        };
    });
    // Duplicate-tempId and other per-entry throws left ids in `taken`/`tempSeen`
    // only for this call; nothing of a failed entry reached `added`.
    const corruption = garbled || report.debrisKeys > 0 || report.fragments > 0;
    const corruptionNote = corruption
        ? `The call's JSON arrived corrupted (${[report.debrisKeys ? `${report.debrisKeys} key${report.debrisKeys === 1 ? '' : 's'} that ${report.debrisKeys === 1 ? 'is' : 'are'} not a key` : null, report.fragments ? `${report.fragments} fragment${report.fragments === 1 ? '' : 's'} dropped` : null, garbled && !report.debrisKeys && !report.fragments ? 'punctuation inside a string value' : null].filter(Boolean).join(', ')}) — keep calls small: one card per call, complete well-formed JSON.`
        : null;
    return { containerOf, failed, corruptionNote };
}

/** Tell the model which entries were skipped because they had already landed. */
function noteSkipped(notes, skipped, extra) {
    const list = skipped.slice(0, 8).map((k) => `${k.at} = ${k.type} ${k.id}`).join(', ');
    notes.push(`${skipped.length} entr${skipped.length === 1 ? 'y' : 'ies'} already landed from an earlier batch this turn (${list}${skipped.length > 8 ? ', …' : ''}) and ${skipped.length === 1 ? 'was' : 'were'} skipped — ${extra.length ? `${extra.length} new child${extra.length === 1 ? '' : 'ren'} ${extra.length === 1 ? 'was' : 'were'} added under the container that had landed; ` : ''}only what was new was built. Resend ONLY failed entries next time, never the whole batch.`);
}

module.exports = { noteSkipped, describeFailures, prepareAddArgs, duplicateBatchError, allLandedError, nothingLandedError, insertLanded, finishBatch };

/**
 * @typedef {import('./addComponents').BatchRecord} BatchRecord
 * @typedef {import('./addComponents').BatchReport} BatchReport
 * @typedef {import('./addComponents').BatchItem} BatchItem
 * @typedef {import('./addComponents').AddedNode} AddedNode
 * @typedef {import('../../builderTools').AppDef} AppDef
 * @typedef {Array<{ at: string, id: string, type: string }>} SkippedEntries  Entries that had already landed.
 * @typedef {{ index?: number, path?: string, error: string, _fixHint?: string }} FailedEntry
 * @typedef {{ node: ReturnType<typeof import('./componentNodes').buildComponentNode>, at: string }} LandedEntry
 * @typedef {{ node?: LandedEntry['node'], twinId?: string }} PlacedEntry
 * @typedef {{ node: LandedEntry['node'], parentId: string, index: number }} ExtraEntry
 * @typedef {{ type?: string, parentId?: string, children?: object[] }} AddComponentsEntry
 * @typedef {{ parentId?: string, components?: AddComponentsEntry[], index?: number }} AddComponentsArgs
 */
