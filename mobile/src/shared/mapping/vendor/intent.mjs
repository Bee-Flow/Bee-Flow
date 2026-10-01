/**
 * What a pick asks for, beside where its value comes from:
 *
 *   take  which of the values the source holds
 *         one    the value (the first, with a warning, when there are many)
 *         all    every value, as one list
 *         first  the first value         last  the last value
 *         count  how many there are
 *         each   the value of the item the step is repeated for
 *                (step.repeat; see repeat.mjs)
 *   as    what the field gets (see slots.mjs): native, text, list, number,
 *         date, yesno or json
 *   join  how a text of many values is laid out: lines, comma or bullets
 *
 * defaultIntent decides these once, when the user picks; they are stored with
 * the pick, and the run only carries them out (fit.mjs). Nothing at run time
 * re-decides from a schema or a sample.
 *
 * normalizePick turns what a writer hands in (a stored pick, or the compact
 * `{ pick: 'steps.x.output.items.email', take: 'all' }` the AI builder may
 * write) into the one stored form, or null.
 */

import { isWild, parseLegacyPath, repairLegacyPath } from './source.mjs';
import { REF_RE, tokenizePath } from './legacy.mjs';

export const TAKES = Object.freeze(['one', 'all', 'first', 'last', 'count', 'each']);
export const AS = Object.freeze(['native', 'text', 'list', 'number', 'date', 'yesno', 'json']);
export const JOINS = Object.freeze(['lines', 'comma', 'bullets']);

/** The version of the stored pick/compose format this core reads. */
export const MAPPING_VERSION = 1;

const MANY = new Set(['list', 'table']);
const ONE_VALUE_SLOTS = new Set(['number', 'date', 'yesno']);

/**
 * The take/as/join a pick of a source of this shape gets in this slot.
 * `warning: 'many_for_one'` marks the one default the editor shows in amber:
 * a list going into a field that holds one value.
 * @param {string} sourceShape — shape.mjs: missing, single, object, list, table, unknown
 * @param {{ as?: string, multiLine?: boolean } | null | undefined} slot — slots.mjs
 * @returns {{ take: string, as: string, join?: string, warning?: string }}
 */
export function defaultIntent(sourceShape, slot) {
    const as = slot && AS.includes(slot.as) ? slot.as : 'native';
    if (!MANY.has(sourceShape)) return { take: 'one', as };
    if (as === 'text') return { take: 'all', as, join: slot && slot.multiLine ? 'lines' : 'comma' };
    if (ONE_VALUE_SLOTS.has(as)) return { take: 'first', as, warning: 'many_for_one' };
    return { take: 'all', as };
}

/**
 * The choices a pick of this shape offers in this slot (the editor's
 * PickOptions), each `{ id, take, as, join? }`, the default first. Ids are
 * language-free; the labels are the editor's. `repeat` adds "for each item"
 * when the step is repeated over this source.
 * @param {string} sourceShape
 * @param {{ as?: string, multiLine?: boolean } | null | undefined} slot
 * @param {{ repeat?: boolean }} [opts]
 */
export function optionsFor(sourceShape, slot, { repeat = false } = {}) {
    const def = defaultIntent(sourceShape, slot);
    const as = def.as;
    const out = [];
    const push = (id, take, extra = {}) => {
        if (!out.some(o => o.id === id)) out.push({ id, take, as: extra.as || as, ...(extra.join ? { join: extra.join } : {}) });
    };
    if (repeat) push('each', 'each');
    if (!MANY.has(sourceShape)) {
        push('one', 'one');
        return out;
    }
    if (as === 'text') {
        const first = def.join === 'comma' ? ['comma', 'lines'] : ['lines', 'comma'];
        for (const join of [...first, 'bullets']) push(`all_${join}`, 'all', { join });
    } else if (!ONE_VALUE_SLOTS.has(as)) {
        push('all', 'all');
    }
    push('first', 'first');
    push('last', 'last');
    // A count is a number: written out in a text field, the number itself
    // elsewhere. A date or a yes/no field has no use for one.
    if (as !== 'date' && as !== 'yesno' && as !== 'list') push('count', 'count', { as: as === 'text' || as === 'number' ? as : 'native' });
    return out;
}

const RUN_KEYS_EXCLUDED = new Set(['output', 'headers']);

/**
 * The v2 Source a legacy path names, `[*]` dropped (a key on a list maps
 * over it anyway), or null. Beyond parseLegacyPath: trigger metadata
 * (`trigger.firedAt`) is the `run` root, a collection row (`item.amount`)
 * the `item` root, and a path REF_RE rejects is read the way its writer
 * meant it (repairLegacyPath) when all of it reads.
 * @param {unknown} path
 */
export function sourceFromPath(path) {
    if (typeof path !== 'string') return null;
    let p = path.trim();
    if (!REF_RE.test(p)) {
        const { path: repaired, rest } = repairLegacyPath(p);
        if (!repaired || rest || !REF_RE.test(repaired)) return null;
        p = repaired;
    }
    const legacy = parseLegacyPath(p);
    if (legacy) return { ...legacy, path: legacy.path.filter(seg => !isWild(seg)) };
    const tokens = tokenizePath(p);
    if (!tokens || tokens.length < 2 || tokens.some(t => t.type !== 'prop')) return null;
    const [root, ...rest] = tokens.map(t => t.key);
    if (root === 'trigger' && typeof rest[0] === 'string' && !RUN_KEYS_EXCLUDED.has(rest[0])) return { root: 'run', path: rest };
    if (root === 'item') return { root: 'item', path: rest };
    return null;
}

function copySource(from) {
    if (typeof from === 'string') return sourceFromPath(from);
    if (!from || typeof from !== 'object' || Array.isArray(from)) return null;
    const out = { root: from.root };
    if (from.id !== undefined) out.id = from.id;
    out.path = Array.isArray(from.path) ? [...from.path] : from.path;
    return out;
}

/**
 * The stored form of a pick, or null when it cannot be one. Accepts a stored
 * pick (`kind: 'pick'`, `v: 1`), a compose part (no kind), or the compact
 * form `{ pick: '<legacy path>' | Source, take?, as?, join?, label? }`.
 * Only known keys are copied; take defaults to 'one' and as to 'native'.
 * The result still has to pass validate.mjs (pickProblems); this only
 * spells it.
 * @param {unknown} input
 * @param {{ part?: boolean }} [opts] — a compose part: no kind, no v
 */
export function normalizePick(input, { part = false } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    let from;
    if (input.pick !== undefined) from = copySource(input.pick);
    else if (input.kind === 'pick' || part || input.kind === undefined) from = copySource(input.from);
    else return null;
    if (!from) return null;
    const out = part ? {} : { kind: 'pick', v: MAPPING_VERSION };
    out.from = from;
    out.take = input.take === undefined ? 'one' : input.take;
    out.as = input.as === undefined ? (part ? 'text' : 'native') : input.as;
    if (input.join !== undefined) out.join = input.join;
    if (input.label !== undefined) out.label = input.label;
    if (input.required !== undefined) out.required = input.required;
    return out;
}
