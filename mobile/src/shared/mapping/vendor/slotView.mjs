/**
 * What a value field shows about a pick, the same on the web and the phone:
 * the shape and count of what its source holds in the sample, the amber
 * "many values into a field for one" sentence, the name of the step it
 * comes from, and whether its source is gone (a stale chip).
 *
 * These were written twice, once in the web's valueSlot/slotModel.ts and once
 * in the phone's, and had drifted: the phone warned about fewer takes, missed
 * the `trigger.<key>` stale rule and ignored a drag's shape hint. Both editors
 * now import them from here. Pure, no platform dependency.
 */

import { TRIGGER_RUN_KEYS } from './validate.mjs';
import { isMany, manyItems, sourceBase, walkSource } from './walk.mjs';
import { shapeOf } from './shape.mjs';
import { MAPPING_VERSION } from './intent.mjs';

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The shape of what a source holds in the sample, or the hint a drag
 * carried when the sample does not hold it: 'missing' with a sample that
 * lacks it, 'unknown' without a sample.
 * @param {object} source
 * @param {object|null|undefined} sample
 * @param {string|null} [hint]
 */
export function shapeAt(source, sample, hint) {
    if (sample) {
        const shape = shapeOf(walkSource(source, sample));
        if (shape !== 'missing') return shape;
    }
    if (hint === 'scalar' || hint === 'json' || hint === 'single') return 'single';
    if (hint === 'list' || hint === 'table' || hint === 'object') return hint;
    return sample ? 'missing' : 'unknown';
}

/** How many values a source holds in the sample, for a list; null otherwise. */
export function countAt(source, sample) {
    if (!sample) return null;
    const result = walkSource(source, sample);
    if (isMany(result)) return manyItems(result).items.length;
    return Array.isArray(result) ? result.length : null;
}

/** A pick of one source with one intent, in the stored form. */
export function makePick(source, intent) {
    const pick = { kind: 'pick', v: MAPPING_VERSION, from: source, take: intent.take, as: intent.as };
    if (intent.join) pick.join = intent.join;
    return pick;
}

const MANY = new Set(['list', 'table']);
const ONE_VALUE = new Set(['number', 'date', 'yesno']);

/**
 * Does the pick need the amber sentence (many values into a field for one)?
 * A number, date or yes/no field always says so while a list feeds it: the
 * first or last of it (the default), and a stored ref that hands over the
 * whole list as it is, which such a field cannot hold. Without a slot only
 * `take: 'one'` of a list is.
 * @param {{ take: string }} pick
 * @param {string} shape
 * @param {{ as?: string } | null} [slot]
 */
export function manyForOne(pick, shape, slot) {
    if (!MANY.has(shape)) return false;
    if (pick.take === 'one') return true;
    return !!slot && ONE_VALUE.has(slot.as) && pick.take !== 'count';
}

/**
 * The runtime base path of a source's root, as the variable picker's groups
 * name it (`steps.<id>.output`, `trigger.output`, `loop.<id>`, …), or null.
 */
export function sourceBasePath(source) {
    switch (source && source.root) {
        case 'steps': return `steps.${source.id}.output`;
        case 'trigger':
        case 'run': return 'trigger.output';
        case 'loop': return `loop.${source.id}`;
        case 'item': return 'item';
        case 'vars': return 'vars';
        default: return null;
    }
}

/**
 * The display name of the step (or trigger) a source comes from.
 * @param {object} source
 * @param {Array<{ label?: string, basePath?: string }>|null|undefined} groups
 * @param {{ get(id: string): string | undefined } | null} [stepLabelById]
 */
export function groupLabelOf(source, groups, stepLabelById) {
    const base = sourceBasePath(source);
    const group = (groups || []).find(g => g && g.basePath === base);
    if (group && group.label) return group.label;
    if (source.root === 'steps') return (stepLabelById && stepLabelById.get(source.id)) || '';
    return '';
}

/**
 * Is a pick's source gone? Its step is not before this one any more (deleted,
 * or moved after it), the step's last real run lacks the first key it reads
 * (a field renamed upstream), or it is a `trigger.<key>` that is neither the
 * payload nor the trigger's metadata. Only said when the editor knows the
 * steps, and a key only against real data: a design-time sample is often
 * partial, and a chip must never cry wolf.
 * @param {object} source
 * @param {Array<{ basePath?: string, hasRealData?: boolean }>|null|undefined} groups
 * @param {object|null|undefined} sample
 */
export function isStale(source, groups, sample) {
    // `trigger.<key>` without `.output` reads the trigger's own metadata; any
    // other key there reads nothing at run time, whatever the editor knows.
    if (source.root === 'run') return !TRIGGER_RUN_KEYS.includes(String(source.path[0]));
    if (!groups || !groups.length) return false;
    const base = sourceBasePath(source);
    const group = groups.find(g => g && g.basePath === base);
    if ((source.root === 'steps' || source.root === 'loop') && !group) return true;
    if (!group || !group.hasRealData || (source.root !== 'steps' && source.root !== 'trigger')) return false;
    const first = source.path[0];
    const data = sample ? sourceBase(source, sample) : undefined;
    return typeof first === 'string' && isRecord(data) && !Object.prototype.hasOwnProperty.call(data, first);
}

/**
 * Is a source read off a list on its way (a column of a table, a key of each
 * order)? What its name says ("Product of all lines" or "Tags of …").
 * Undefined without data to tell.
 */
export function crossesList(source, sample) {
    if (!sample) return undefined;
    for (let n = 0; n < source.path.length; n++) {
        const shape = shapeAt({ ...source, path: source.path.slice(0, n) }, sample);
        if (shape === 'list' || shape === 'table') return true;
        if (shape === 'missing') return undefined;
    }
    return false;
}
