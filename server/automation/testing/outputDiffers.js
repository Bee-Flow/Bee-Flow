// @typecheck noImplicitAny
'use strict';
/**
 * The registry of OUTPUT DIFFERS: how two values that carry a `kind` are
 * compared by the run compare (automation/testing/jsonDiff.js).
 *
 * A step output is mostly plain JSON, and a plain structural walk is the right
 * comparison. A few outputs are not plain: they are HANDLES to something big
 * that lives elsewhere (a generated file, and in phase 4 a table), and two
 * runs never hold the same handle id even when the thing behind it is the
 * same. Comparing the ids would flag every run as different. A differ knows
 * what the handle stands for and compares THAT.
 *
 * THIS IS THE HOOK FOR LATER PHASES. A feature that adds a new handle kind
 * registers its differ here, at load time, and the compare, the golden replay
 * and the run page pick it up with no change of their own:
 *
 *     registerOutputDiffer({
 *         kind: 'table',                               // the handle's `kind`
 *         matches: (v) => v?.kind === 'table' && typeof v.tableId === 'string',
 *         diff: async (a, b, ctx) => ({ changes: [...], summary: { ... } }),
 *     });
 *
 *   matches(value) → boolean       is this value one of mine? (never throws)
 *   diff(a, b, ctx) → Promise<{ changes: Change[], summary?: object }>
 *   ctx = { path, caps, loadFileSummary(fileId, side: 'a'|'b') }
 *
 * `changes` carry paths RELATIVE to the handle ('slides[3].title'); the JSON
 * walk prefixes them with the handle's own path. Values in a change are JSON
 * text cut to 200 characters (cutValue below). A differ reads only what `ctx`
 * hands it: that is how it stays inside the two journeys the caller may read.
 *
 * Re-registering a kind replaces the earlier differ. Phase 9 ships only the
 * built-in 'generated_file' differ; there is NO table differ here.
 */

const CUT = 200;

/**
 * A value as JSON text, cut to 200 characters. `undefined` reads as the word.
 * @param {unknown} value
 */
function cutValue(value) {
    /** @type {string} */
    let text;
    try { text = JSON.stringify(value); } catch { text = '"[unserialisable]"'; }
    if (text === undefined) text = 'undefined';
    return text.length > CUT ? `${text.slice(0, CUT - 1)}…` : text;
}

/** @typedef {{ path: string, change: 'added'|'removed'|'changed'|'type_changed', before?: string, after?: string }} Change */
/**
 * @typedef {{
 *   kind: string,
 *   matches: (value: any) => boolean,
 *   diff: (a: any, b: any, ctx: any) => Promise<{ changes: Change[], summary?: object }>,
 * }} OutputDiffer
 */

/** @type {Map<string, OutputDiffer>} */
const registry = new Map();

/** @param {OutputDiffer} differ */
function registerOutputDiffer(differ) {
    if (!differ || typeof differ.kind !== 'string' || !differ.kind.trim()) {
        throw new TypeError('registerOutputDiffer: a differ needs a kind');
    }
    if (typeof differ.matches !== 'function' || typeof differ.diff !== 'function') {
        throw new TypeError(`registerOutputDiffer(${differ.kind}): matches and diff must be functions`);
    }
    registry.set(differ.kind, { kind: differ.kind, matches: differ.matches, diff: differ.diff });
}

/** The registered differs, in registration order. */
function listOutputDiffers() {
    return [...registry.values()];
}

/**
 * The differ that claims this value, or null. Only an object with a string `kind` is asked.
 * @param {{ kind?: unknown } | null | undefined} value
 */
function differFor(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.kind !== 'string') return null;
    for (const differ of registry.values()) {
        let hit = false;
        try { hit = !!differ.matches(value); } catch { hit = false; }
        if (hit) return differ;
    }
    return null;
}

// ── Built in: generated_file ─────────────────────────────────────────────

/** @param {{ kind?: unknown, fileId?: unknown } | null | undefined} v */
const isFileHandle = (v) => !!v && typeof v === 'object' && v.kind === 'generated_file'
    && typeof v.fileId === 'string' && v.fileId.length > 0;

/**
 * Compare one scalar field of two summaries.
 * @param {Change[]} changes
 * @param {string} path
 * @param {unknown} before
 * @param {unknown} after
 */
function fieldChange(changes, path, before, after) {
    if (before === after) return;
    changes.push({ path, change: 'changed', before: cutValue(before), after: cutValue(after) });
}

/**
 * The parts (slides, sheets) of two summaries, by position.
 * @param {Change[]} changes
 * @param {string} label
 * @param {number} i
 * @param {Record<string, unknown> | null | undefined} pa
 * @param {Record<string, unknown> | null | undefined} pb
 */
function comparePart(changes, label, i, pa, pb) {
    const base = `${label}[${i}]`;
    if (pa && !pb) { changes.push({ path: base, change: 'removed', before: cutValue(pa) }); return; }
    if (!pa && pb) { changes.push({ path: base, change: 'added', after: cutValue(pb) }); return; }
    for (const field of ['title', 'name', 'rows', 'cols', 'textChars', 'textHash']) {
        if (pa[field] === undefined && pb[field] === undefined) continue;
        fieldChange(changes, `${base}.${field}`, pa[field], pb[field]);
    }
}

/** @param {FileSummary} sa @param {FileSummary} sb */
function compareSummaries(sa, sb) {
    /** @type {Change[]} */
    const changes = [];
    fieldChange(changes, 'name', sa.name, sb.name);
    fieldChange(changes, 'mime', sa.mime, sb.mime);
    // Two documents made from the same content still differ in bytes (stamped
    // dates inside the archive). When both sides could be read into parts, the
    // PARTS are the content; size and hash only speak when they could not.
    const byParts = Array.isArray(sa.parts) && Array.isArray(sb.parts) && !sa.unreadable && !sb.unreadable;
    if (!byParts) {
        fieldChange(changes, 'size', sa.size, sb.size);
        if (sa.sha256 && sb.sha256) fieldChange(changes, 'sha256', sa.sha256, sb.sha256);
    }
    const partsA = Array.isArray(sa.parts) ? sa.parts : [];
    const partsB = Array.isArray(sb.parts) ? sb.parts : [];
    const kind = (partsA[0] || partsB[0] || {}).kind;
    const label = kind === 'slide' ? 'slides' : kind === 'sheet' ? 'sheets' : 'parts';
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        comparePart(changes, label, i, partsA[i], partsB[i]);
    }
    return changes;
}

registerOutputDiffer({
    kind: 'generated_file',
    matches: isFileHandle,
    async diff(a, b, ctx) {
        const [sa, sb] = await Promise.all([
            ctx.loadFileSummary(a.fileId, 'a'),
            ctx.loadFileSummary(b.fileId, 'b'),
        ]);
        // Nothing to compare when neither file can be read any more (expired).
        if (!sa && !sb) return { changes: [], summary: { unavailable: true } };
        if (sa && !sb) return { changes: [{ path: 'file', change: 'removed', before: cutValue(sa.name) }], summary: { unavailable: true } };
        if (!sa && sb) return { changes: [{ path: 'file', change: 'added', after: cutValue(sb.name) }], summary: { unavailable: true } };
        const changes = compareSummaries(sa, sb);
        return { changes, summary: { same: changes.length === 0 } };
    },
});

module.exports = { registerOutputDiffer, listOutputDiffers, differFor, cutValue, compareSummaries };

/** @typedef {Awaited<ReturnType<typeof import('./fileSummary').summarizeFile>>} FileSummary */
