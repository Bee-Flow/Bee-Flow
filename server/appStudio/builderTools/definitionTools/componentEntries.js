/**
 * App Studio builder tools — reading the RAW entries of an app_add_components
 * call: what each list element is (entry, type-less wrapper group, corrupted
 * tail, fragment), which of its keys are JSON debris rather than fields, how a
 * nested list flattens to buildable entries, and the call PATH each one keeps.
 *
 * Everything here is about surviving a model that wrote broken JSON — the
 * grammar-constrained local runtimes leave debris keys and swallowed types
 * behind — without silently building something the caller did not mean.
 * Pure: no draft, no ops, no I/O.
 */

'use strict';

/**
 * Entries that are only a wrapper — `{children:[…]}`, sometimes with a
 * `parentId` — replaced by the components inside them.
 *
 * The model reaches for a wrapper whenever it thinks in GROUPS: "these three
 * tiles belong together, so they go in a box". components[] already IS that
 * box, and a real box is a card or a form, so the wrapper has no `type` and
 * the build refuses the whole batch ("components[1] has no type (keys:
 * children, parentId)"). Measured 2026-09-16 over 12 dashboard builds: this
 * was the ONLY structural defect left, and it appeared in every single run —
 * at the top level and nested one level down, whatever the prompt said about
 * call size.
 *
 * Narrow on purpose: a wrapper is an entry with no `type`, a non-empty
 * `children` array and NOTHING else of its own. An entry carrying props or
 * style with no type is a component whose type went missing — a different
 * mistake, and lifting its children would throw away its title, so it still
 * fails with the message that names it.
 */
//
// `style` joined the list 2026-09-17: a `{children:[…], style:{span:12}}`
// wrapper is still a wrapper — the span belongs to nothing (the children
// carry their own) and refusing the group for it cost the whole batch.
const WRAPPER_KEYS = new Set(['children', 'parentId', 'tempId', 'index', 'style']);

// A key that is not a key: `"style"` (quotes included), `{\n "tableId"`.
// llama.cpp's grammar-constrained decoding of a string that swallowed JSON
// punctuation (issues #21384/#21680) leaves these behind after the point
// where a call's JSON broke — every one is debris, never a field.
const KEY_RX = /^[A-Za-z_$][\w$-]*$/;
const isDebrisKey = (k) => !KEY_RX.test(k);
// A `type` value that swallowed the rest of its entry: `chart},{props:{chartType:`.
// JSON punctuation only — a type written with a space ("data grid", "page
// header") is a wrong name, not debris, and gets the did-you-mean (the
// normaliser reads the underscore form first; the rest reach the build).
const GARBLED_TYPE_RX = /[{}\[\]"',:]/;

/**
 * Read one raw list element: what it is, with its debris keys removed.
 *   { kind:'fragment' }                    — not an object, or nothing but debris
 *   { kind:'group', entry }                — type-less, only children (+ wrapper keys)
 *   { kind:'corrupted', entry, reason }    — a typed entry whose JSON broke inside it
 *   { kind:'entry', entry }                — build it
 * Debris keys on a GROUP are stripped silently: Gemma writes keys in
 * alphabetical order, so `children` precedes `type` and a container whose
 * children broke always loses its own type — the debris IS its lost tail.
 */
function readEntry(raw, report) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { report.fragments += 1; return { kind: 'fragment' }; }
    const debris = Object.keys(raw).filter(isDebrisKey);
    let entry = raw;
    if (debris.length) {
        entry = {};
        for (const [k, v] of Object.entries(raw)) if (!isDebrisKey(k)) entry[k] = v;
        report.debrisKeys += debris.length;
    }
    if (!Object.keys(entry).length) { report.fragments += 1; return { kind: 'fragment' }; }
    const typeless = entry.type === undefined;
    if (typeless && Array.isArray(entry.children) && entry.children.length && Object.keys(entry).every((k) => WRAPPER_KEYS.has(k))) {
        return { kind: 'group', entry };
    }
    if (typeof entry.type === 'string' && GARBLED_TYPE_RX.test(entry.type)) {
        return { kind: 'corrupted', entry, reason: `its "type" arrived as JSON debris (${JSON.stringify(entry.type.slice(0, 40))})` };
    }
    if (!typeless && debris.length) {
        return { kind: 'corrupted', entry, reason: `its JSON broke inside it (${debris.length} key${debris.length === 1 ? '' : 's'} that ${debris.length === 1 ? 'is' : 'are'} not a key)` };
    }
    for (const part of ['props', 'style']) {
        const obj = entry[part];
        if (obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).some(isDebrisKey)) {
            return { kind: 'corrupted', entry, reason: `its ${part} carry JSON debris` };
        }
    }
    return { kind: 'entry', entry };
}

/**
 * The buildable entries of a raw list, each with the path it had in the
 * call (`components[1].children[0]`) — the path the model can resend.
 *
 *   • a type-less group is lifted: its children take its place, at their own
 *     paths (the 2026-09-16 dominant defect: the model groups tiles in
 *     `{children:[…]}` and components[] already IS the group);
 *   • a group with a corrupted DIRECT child is CUT — the JSON broke inside it
 *     and, keys being alphabetical, its own type went with it — so it fails as
 *     a unit at its path and nothing of it is built (lifting its clean half
 *     would land a bare chart where a card was meant, and the resend then
 *     doubles it); groups ABOVE the cut are still transparent, so a complete
 *     sibling group (the card before it) lands;
 *   • a corrupted typed entry fails at its path; fragments are dropped and
 *     counted (one note), never reported one by one.
 */
function flattenEntries(list, at, report, depth = 0) {
    if (!Array.isArray(list) || depth > 6) return [];
    return list.flatMap((raw, i) => flattenOne(raw, `${at}[${i}]`, report, depth));
}

/**
 * One raw list element at the path it has in the CALL (`here`) — the path is
 * the caller's, never re-derived, so a retried subset of a batch reports its
 * entries where the model sent them (components[1], not components[0]).
 */
function flattenOne(raw, here, report, depth = 0) {
    const read = readEntry(raw, report);
    if (read.kind === 'fragment') return [];
    if (read.kind === 'corrupted') {
        report.failed.push({ path: here, error: `${here} arrived corrupted — ${read.reason}; it was not applied. Resend this entry alone, with complete well-formed JSON.` });
        return [];
    }
    if (read.kind === 'group') {
        report.lifted += 1;
        const cutAt = read.entry.children.findIndex((c) => readEntry(c, { fragments: 0, debrisKeys: 0 }).kind === 'corrupted');
        if (cutAt >= 0) {
            report.failed.push({ path: here, error: `${here} is a group whose JSON broke at its child ${cutAt + 1} (children[${cutAt}]) and whose own type was lost with it — nothing of it was applied. Resend that whole group as ONE call of its own (the container with its children), with complete well-formed JSON.` });
            return [];
        }
        return flattenEntries(read.entry.children, `${here}.children`, report, depth + 1);
    }
    return [{ entry: read.entry, at: here }];
}

/** The top-level index a path starts with: `components[3].children[1]` → 3. */
function topIndexOf(path) {
    const m = /^components\[(\d+)\]/.exec(String(path));
    return m ? Number(m[1]) : null;
}

/** The path of the entry a path sits inside: `components[1].children[0].children[1]` → `components[1].children[0]`; null at the top level. */
function containerPathOf(path) {
    return /\.children\[\d+\]$/.test(path) ? path.replace(/\.children\[\d+\]$/, '') : null;
}

module.exports = {
    readEntry,
    flattenEntries,
    flattenOne,
    topIndexOf,
    containerPathOf,
};
