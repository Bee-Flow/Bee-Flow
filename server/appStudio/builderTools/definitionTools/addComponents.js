/**
 * App Studio builder tools — app_add_components, the one tool that grows the
 * component tree: normalise, guard the data references, then land every whole
 * top-level entry and report the rest at the path the model sent it (PARTIAL
 * apply). Owns the batch bookkeeping that keeps a resend from duplicating
 * work — the identical batch, the corrected resend over a landed twin, and
 * the record of which paths still have to come back.
 */

'use strict';

const { COMPONENT_TYPES, getSpec } = require('../../componentSpecs');
const ops = require('../../definitionOps');
const { normaliseAddComponentsArgs } = require('../componentNormalise');
const { checkComponentDataRefs, guardResult } = require('../bindingGuard');
const { canonicalJson } = require('../../../automation/builderTools/suggestedPatch');
const { MAX_COMPONENTS_PER_CALL } = require('../schemas');
const { adoptCanonical } = require('../shared');
const { defaultParentSection, resolveParent, pageHeaderBelongsOnTop } = require('./componentPlacement');
const { buildComponentNode } = require('./componentNodes');
const { flattenEntries, flattenOne, topIndexOf, containerPathOf } = require('./componentEntries');
const { formNameClash, stripTempIds, entrySig, shellSig } = require('./batchIdentity');

function applyAddComponents(draftWrap, rawArgs) {
    const def = draftWrap.def;
    // normalise → guard → build. The normaliser repairs what is unambiguous
    // (root aliases, type aliases, props beside props) and reports it; the
    // guard refuses data references that would fail at run time BEFORE any
    // node exists; the build lands every whole top-level entry and reports
    // the rest (partial apply, below).
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
    const parent = resolveParent(def, args?.parentId);
    if (parent.error) return parent;

    const list = Array.isArray(args?.components) ? args.components : null;
    if (!list || !list.length) {
        return {
            error: `components must be a non-empty array of { type, props?, style?, children?, tempId? }.${garbled ? ' The call\'s JSON carries punctuation inside a string value — it arrived corrupted; resend it carefully, in two smaller calls if it is long.' : ''}`,
            ...(garbled ? { _fixHint: 'Reject reason: corrupted JSON. Nothing was applied. Resend with complete, well-formed JSON.' } : {}),
        };
    }
    if (list.length > MAX_COMPONENTS_PER_CALL) {
        return { error: `components: max ${MAX_COMPONENTS_PER_CALL} top-level entries per call — split the build into two calls.` };
    }
    // The SAME batch again, this turn. Measured 2026-09-13: four sends of one
    // two-form batch (root debris and a renamed tempId between them) minted
    // four copies. A content-identical batch under the same parent is never
    // meant twice — refuse it as a soft error carrying the ids that already
    // exist, so the ladder counts the resend and the model reads where its
    // components are. tempIds are per-call handles and are not part of the
    // signature; a batch whose components were since removed is new again.
    //
    // Since the partial apply (2026-09-17) a batch may have LANDED IN PART.
    // Its record then remembers the PATHS that failed: the identical batch
    // sent again builds only those (the landed ones are skipped with a note),
    // and the landed subset alone is "Nothing new" — the signature says what
    // landed, never that the failed entries did. Paths, not content: the
    // resend is byte-identical, so positions align, while two entries with
    // the same content (a duplicate-tempId pair) are told apart by where
    // they sit, and every entry keeps the path the model sent it at.
    let items = list.map((entry, i) => ({ entry, at: `components[${i}]`, raw: entry }));
    const batchSig = canonicalJson({ parentId: args.parentId, components: stripTempIds(list) });
    if (!(draftWrap._addedBatches instanceof Map)) draftWrap._addedBatches = new Map();
    let seen = draftWrap._addedBatches.get(batchSig);
    if (seen && !seen.added.some((a) => a && a.id && ops.findNode(def, a.id))) {
        draftWrap._addedBatches.delete(batchSig);
        seen = null;
    }
    let retryOf = null; // the partial record this identical resend completes
    if (seen && Array.isArray(seen.failedPaths) && seen.failedPaths.length) {
        const retryTop = new Set(seen.failedPaths.map(topIndexOf));
        const retry = items.filter((it) => retryTop.has(topIndexOf(it.at)));
        if (retry.length) {
            const skipped = items.length - retry.length;
            notes.push(`${skipped} of ${items.length} entries already landed from this exact batch (${seen.added.slice(0, 8).map((a) => `${a.type} ${a.id}`).join(', ')}${seen.added.length > 8 ? ', …' : ''}) and were skipped — only the ${retry.length} that failed before ${retry.length === 1 ? 'was' : 'were'} applied. Resend ONLY failed entries next time.`);
            items = retry;
            retryOf = seen;
            seen = null;
        }
    }
    // Same test, looser key: a batch that brings a FORM whose props.name the
    // target screen already has. The trace's resends were not byte-identical
    // (the title the first send lost, a renamed tempId) but every one carried
    // the same two forms — and a form name is unique per screen by contract
    // (reset_form {form}, forms.<name> and the submit payload key on it), so
    // a second "supplier_form" can never be what was meant.
    let viaForms = false;
    if (!seen) {
        const clash = formNameClash(def, args.parentId, items.map((it) => it.raw));
        if (clash) {
            viaForms = true;
            const prior = [...draftWrap._addedBatches.values()].find((b) => b.parentId === args.parentId && clash.every((c) => b.added.some((a) => a.id === c.id)));
            seen = prior || { added: clash.map((c) => ({ id: c.id, type: 'form', name: c.name })), ids: Object.fromEntries(clash.map((c) => [c.name, c.id])), parentId: args.parentId, dupes: 0 };
            if (!prior) draftWrap._addedBatches.set(`forms:${args.parentId}:${clash.map((c) => c.name).join(',')}`, seen);
        }
    }
    if (seen) {
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
    const check = checkComponentDataRefs(items.map((it) => it.raw), draftWrap.dataModel);
    const guard = guardResult(check);
    if (guard) return guard;
    if (check.repairs.length) notes.push(...check.repairs);

    // PARTIAL APPLY, per top-level entry (since 2026-09-17; all-or-nothing
    // before). The recorded dashboard turn: one whole-screen call, its JSON
    // broken inside the second card, nothing applied, and the recovery added
    // components one at a time with the header last. Now the entries that
    // are whole land; each that is not is reported at its path with the
    // resend it needs; the batch record remembers which, so a resend of the
    // whole batch builds only those. definitionOps is immutable, so a failed
    // entry costs nothing to skip.
    const taken = ops.collectIds(def);
    const tempSeen = new Set();
    const idMap = Object.create(null);
    const added = [];
    const entryHints = [];
    const report = { failed: [], fragments: 0, debrisKeys: 0, lifted: 0, built: new Map(), nodes: [], parentNodeId: null };
    // Each entry is flattened at the path it has in the call — on a retried
    // subset that is the ORIGINAL path, so failed[].index/path still say
    // what the model sent.
    let flat = items.flatMap((it) => flattenOne(it.raw, it.at, report));
    if (retryOf) {
        // Only the paths that failed before are built again; a lifted
        // group's landed children stay landed (a top-level index is
        // retried as a whole, its paths tell the built from the failed).
        const retryPaths = new Set(retryOf.failedPaths);
        flat = flat.filter((e) => retryPaths.has(e.at));
        report.failed = report.failed.filter((f) => retryPaths.has(f.path));
    }
    // The lifted-group note keeps its pre-2026-09-17 wording (tests and the
    // model's habit both read "lifted in place").
    if (report.lifted) {
        notes.push(`${report.lifted} entr${report.lifted === 1 ? 'y' : 'ies'} carried children and no \`type\` — the components inside were lifted in place. components[] is already the group: nest only inside a REAL container (a card or a form), never inside a type-less wrapper.`);
    }
    // THE CORRECTED RESEND. A batch that landed in part is far more often
    // resent whole with the failed entry fixed — a different signature, so
    // the identical-batch net above never sees it — than byte for byte, and
    // building it as new minted the landed entries a second time (two page
    // headers, two body texts; caught in review 2026-09-18). So every entry
    // is first looked up among the nodes the partial batches under this
    // parent already built: an entry that matches one still on the canvas
    // is skipped (its id is handed back, its tempId resolves to it), and a
    // container whose SHELL matches a landed one — the dropped-child repair,
    // the card resent with the one bad stat fixed — is not built again: only
    // the children it did not have yet are added under the landed card's
    // id, at the position they hold in the resend. Only partial batches (and
    // the resends that continue one) are consulted, so a second copy the
    // model asks for on purpose, in a clean batch, is still built. The
    // identical resend is exempt: its retried entries are told apart by
    // POSITION (two byte-equal entries, one landed), and content would skip
    // the one that must be built.
    const priors = retryOf ? [] : [...draftWrap._addedBatches.values()].filter((b) => b && b.partial && b.parentId === args.parentId && Array.isArray(b.nodes));
    const landedTwin = (key, value, parentNodeId) => {
        if (value === null || value === undefined) return null;
        for (const b of priors) {
            for (const n of b.nodes) {
                if (n[key] === value && (n.parentNodeId || null) === parentNodeId && ops.findNode(def, n.id)) return n;
            }
        }
        return null;
    };
    const nodes = []; // { node, at } → under args.parentId
    const extra = []; // { node, parentId, index } → under a container that landed earlier
    const skipped = []; // { at, id, type } — entries that already landed
    const placed = []; // the top level in resend order: { node } built here, { twinId } landed before
    const skipAs = (item, twin) => {
        skipped.push({ at: item.at, id: twin.id, type: twin.type });
        if (typeof item.entry.tempId === 'string') { idMap[item.entry.tempId] = twin.id; tempSeen.add(item.entry.tempId); }
        report.nodes.push({ ...twin, parentNodeId: twin.parentNodeId || null });
    };
    // A container resent over its landed twin: its children, one by one —
    // landed ones skipped, containers among them merged the same way, the
    // rest built under the twin's real id. Depth-bounded like flattenEntries.
    const mergeIntoLanded = (item, twin, depth) => {
        const container = ops.findNode(def, twin.id);
        if (!container) return;
        skipAs(item, twin);
        report.built.set(item.at, container.node);
        const children = flattenEntries(Array.isArray(item.entry.children) ? item.entry.children : [], `${item.at}.children`, report);
        children.forEach((child, j) => {
            const same = landedTwin('sig', entrySig(child.entry), twin.id);
            if (same) { skipAs(child, same); return; }
            const shell = depth < 6 && getSpec(child.entry.type)?.container ? landedTwin('shellSig', shellSig(child.entry), twin.id) : null;
            if (shell) { mergeIntoLanded(child, shell, depth + 1); return; }
            report.parentNodeId = twin.id;
            try {
                extra.push({ node: buildComponentNode(child.entry, child.at, taken, tempSeen, idMap, added, entryHints, report), parentId: twin.id, index: j });
            } catch (e) {
                report.failed.push({ path: child.at, error: e.message });
            } finally {
                report.parentNodeId = null;
            }
        });
    };
    for (const item of flat) {
        if (priors.length) {
            const same = landedTwin('sig', entrySig(item.entry), null);
            if (same) { skipAs(item, same); placed.push({ twinId: same.id }); continue; }
            const shell = getSpec(item.entry.type)?.container ? landedTwin('shellSig', shellSig(item.entry), null) : null;
            if (shell) { mergeIntoLanded(item, shell, 0); placed.push({ twinId: shell.id }); continue; }
        }
        try {
            const node = buildComponentNode(item.entry, item.at, taken, tempSeen, idMap, added, entryHints, report);
            nodes.push({ node, at: item.at });
            placed.push({ node });
        } catch (e) {
            report.failed.push({ path: item.at, error: e.message });
        }
    }
    if (skipped.length) {
        const list = skipped.slice(0, 8).map((k) => `${k.at} = ${k.type} ${k.id}`).join(', ');
        notes.push(`${skipped.length} entr${skipped.length === 1 ? 'y' : 'ies'} already landed from an earlier batch this turn (${list}${skipped.length > 8 ? ', …' : ''}) and ${skipped.length === 1 ? 'was' : 'were'} skipped — ${extra.length ? `${extra.length} new child${extra.length === 1 ? '' : 'ren'} ${extra.length === 1 ? 'was' : 'were'} added under the container that had landed; ` : ''}only what was new was built. Resend ONLY failed entries next time, never the whole batch.`);
    }
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

    if (!nodes.length && !extra.length && skipped.length && !failed.length) {
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
    if (!nodes.length && !extra.length) {
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
    const result = adoptCanonical(draftWrap, next, { added, ids: { ...idMap } });
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
    return result;
}

module.exports = { applyAddComponents };
