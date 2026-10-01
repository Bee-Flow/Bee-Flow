/**
 * A legacy `{{ }}` text, or a legacy ref path, as the v2 binding that reads
 * the same values: THE one rule for it, so the AI builder (which writes a
 * compose where the model wrote a template) and the editor (which lifts a
 * template to a compose when a person edits it) can never disagree.
 *
 * A pick reads with the v2 walker (walk.mjs), the legacy path with the
 * frozen legacy walk (legacy.mjs). They agree on a plain path, and a `[*]`
 * followed by a key is a pick that takes all. Where they read differently
 * the path is not lifted, and the caller keeps the template or the ref it
 * had:
 *
 *   - a key the walker refuses (`length`, `constructor`, ...): the legacy
 *     walk reads `items.length` as the count and `subject.length` as the
 *     number of characters, the walker reads neither;
 *   - an index (`text[0]`, `["0"]`): the legacy walk indexes a string by
 *     character, the walker does not, and the path does not say which it
 *     is;
 *   - a `[*]` at the end, or followed by an index or another `[*]`: the
 *     legacy walk flattens there, and a pick of the list does not
 *     (`matrix[*][0]` is the first of every row, not the first row).
 *
 * A text is lifted whole or not at all: one placeholder that does not lift
 * (an expression, `secrets.x`, one of the above) keeps the whole text the
 * template it was. Labels are the caller's (the builder and the editor
 * derive them the same way, from the key a Source reads).
 */

import { REF_RE } from './legacy.mjs';
import { isWild, parseLegacyPath, repairLegacyPath } from './source.mjs';
import { MAPPING_VERSION, sourceFromPath } from './intent.mjs';
import { REFUSED_KEYS } from './walk.mjs';
import { composeProblems, isPick, pickProblems, templatePaths } from './validate.mjs';
import { slotShape } from './slots.mjs';

const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
const SOLE_RE = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/;

/** The segments a path reads with its `[*]` kept, or null. */
function legacySegments(path, from) {
    const trimmed = path.trim();
    let p = trimmed;
    if (!REF_RE.test(p)) {
        const { path: repaired } = repairLegacyPath(p);
        p = repaired || '';
    }
    const legacy = parseLegacyPath(p);
    // A path parseLegacyPath does not read is a `run` or `item` Source,
    // which sourceFromPath only builds from plain keys.
    return legacy ? legacy.path : from.path;
}

/**
 * The pick a legacy path is, when a pick reads exactly the value the legacy
 * walk read there: `{ from, take }`, take 'all' for a path with a `[*]` and
 * 'one' otherwise. Null when the path reads no Source, or reads one the two
 * walks read differently (see the header).
 * @param {unknown} path
 * @returns {{ from: object, take: 'one'|'all' } | null}
 */
export function pickForLegacyPath(path) {
    if (typeof path !== 'string') return null;
    const from = sourceFromPath(path);
    if (!from) return null;
    const segs = legacySegments(path, from);
    let wild = false;
    for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        if (isWild(seg)) {
            if (typeof segs[i + 1] !== 'string') return null;
            wild = true;
            continue;
        }
        // A digit key (`["0"]`) indexes a list in the legacy walk and maps
        // over it in the walker.
        if (typeof seg !== 'string' || REFUSED_KEYS.includes(seg) || /^[0-9]+$/.test(seg)) return null;
    }
    return { from, take: wild ? 'all' : 'one' };
}

/** The slot of a text field (`values.<key>` of a fill_document is the slot of `values`). */
function textSlot(stepType, field) {
    const base = stepType === 'fill_document' && String(field || '').split('.')[0] === 'values' ? 'values' : field;
    const slot = slotShape(null, { stepType, field: base });
    return slot.as === 'native' ? { as: 'text', multiLine: slot.multiLine } : slot;
}

function partFor(inner, slot) {
    const lifted = pickForLegacyPath(inner);
    if (!lifted) return null;
    const part = { from: lifted.from, take: lifted.take, as: slot.as };
    // All of a list goes one per line in a multi-line field and
    // comma-separated in a one-line field.
    if (slot.as === 'text' && lifted.take === 'all') part.join = slot.multiLine ? 'lines' : 'comma';
    return pickProblems(part, { part: true }).length ? null : part;
}

/**
 * A `{{ }}` text as a compose binding (its parts unlabelled), or null when
 * it holds no placeholder or one that does not lift (see the header); then
 * the text stays the template it is.
 * `sole`: a text that is exactly one placeholder becomes a pick of the value
 * itself (`as: 'native'`), for the fields whose executor keeps a sole
 * placeholder's real type (a fill_document value: a list stays a list).
 * @param {unknown} text
 * @param {{ stepType?: string, field?: string, sole?: boolean }} [where]
 * @returns {object|null}
 */
export function templateToCompose(text, { stepType, field, sole = false } = {}) {
    if (typeof text !== 'string' || !templatePaths(text).length) return null;
    if (sole) {
        const m = SOLE_RE.exec(text);
        if (m) {
            const lifted = pickForLegacyPath(m[1]);
            if (!lifted) return null;
            const pick = { kind: 'pick', v: MAPPING_VERSION, from: lifted.from, take: lifted.take, as: 'native' };
            return isPick(pick) ? pick : null;
        }
    }
    const slot = textSlot(stepType, field);
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(PLACEHOLDER_RE)) {
        const part = partFor(m[1].trim(), slot);
        if (!part) return null;
        if (m.index > last) parts.push(text.slice(last, m.index));
        parts.push(part);
        last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    const compose = { kind: 'compose', v: MAPPING_VERSION, parts };
    return composeProblems(compose).length ? null : compose;
}
