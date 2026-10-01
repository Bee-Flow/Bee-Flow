/**
 * The model behind a value field on the phone: what a stored value is shown
 * as, and what a value picked from an earlier step turns it into. Pure; the
 * components (ValueChip, PickOptionsSheet, components/fields/BindingInput)
 * only draw. The decisions are the shared mapping core's, so a value the
 * phone writes is the one the web would write for the same tap:
 *
 *   - a pick (`{ kind: 'pick', v: 1, from, take, as }`) and a composed text
 *     (`{ kind: 'compose', v: 1, parts }`), whoever stored them (the web, the
 *     AI builder), show as what they are and are never rewritten unless the
 *     author changes them;
 *   - a stored legacy ref or one-call formula shows as the pick it lifts to
 *     (core liftLegacy, which proves on the sample that the chip gives what
 *     the run gives) where the field stores picks; anything else the core
 *     cannot lift is a "Formula";
 *   - a new pick gets its take/as/join from core defaultIntent, by the shape
 *     the value has in the sample and what the field wants (its slot).
 *
 * `storesPicks`: the field's value is a binding the runtime resolves itself
 * (a tool input, a set field): a pick may be written there. A binding that
 * the editor lowers into an expression (a condition's operands) does not
 * store picks: it keeps the legacy kinds, and only shows a pick someone else
 * stored there.
 */

import { isDataPath } from '@/features/flow-editor/bindings/dataPath';
import {
    MAPPING_DEPS,
    MAPPING_VERSION,
    createResolver,
    defaultIntent,
    inlineText,
    isCompose,
    isMany,
    isPick,
    liftLegacy,
    manyItems,
    renderText,
    shapeOf,
    slotShape,
    sourceBase,
    sourceFromPath,
    walkSource,
    type ComposeBinding,
    type MappingSource,
    type PickBinding,
    type PickIntent,
    type PickPart,
    type Shape,
    type Slot,
} from '@/shared/mapping';

/** The runState a preview resolves against: the sample, or the last run. */
export type Sample = object | null | undefined;

export type SlotView =
    /** A pick: stored as one, or a legacy binding shown as the pick it lifts to (`lifted`). */
    | { kind: 'pick'; pick: PickBinding; lifted: boolean }
    | { kind: 'compose'; compose: ComposeBinding }
    /** A legacy formula the core cannot lift: shown as a "Formula" chip. */
    | { kind: 'formula'; binding: unknown }
    /** Typed text, a legacy template, a path: the text editor's. */
    | { kind: 'text' };

export interface ViewOptions {
    /** 'binding' for a `{kind, …}` binding, 'template' for a text the run interpolates. */
    mode: 'binding' | 'template' | 'path' | 'expression';
    storesPicks?: boolean;
    sample?: Sample;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// `parseJson(path, "a.b")`: a field read out of JSON text, which the text
// editor shows as its own pill (fields/JsonPickRow), not as a formula.
const JSON_CALL = /^\s*parseJson\(/;

/** A legacy ref or expr where the field stores picks: the pick it lifts to, the text editor's, or a Formula. */
function legacyView(value: Record<string, unknown>, sample: Sample): SlotView {
    const src = typeof value.value === 'string' ? value.value.trim() : '';
    if (value.kind === 'expr' && (JSON_CALL.test(src) || isDataPath(src) || !src)) return { kind: 'text' };
    const pick = liftLegacy(value, sample, null, MAPPING_DEPS);
    if (pick) return { kind: 'pick', pick, lifted: true };
    // A path the core cannot prove reads the same stays the pill it was.
    return value.kind === 'ref' ? { kind: 'text' } : { kind: 'formula', binding: value };
}

/** What a stored value is shown as. */
export function slotView(value: unknown, { mode, storesPicks = false, sample }: ViewOptions): SlotView {
    if (mode !== 'binding' && mode !== 'template') return { kind: 'text' };
    if (isPick(value)) return { kind: 'pick', pick: value, lifted: false };
    if (isCompose(value)) return { kind: 'compose', compose: value };
    if (mode === 'binding' && storesPicks && isRecord(value) && (value.kind === 'ref' || value.kind === 'expr')) {
        return legacyView(value, sample);
    }
    return { kind: 'text' };
}

/** What a field wants of a value: its schema's slot, a text for a text field, else native. */
export function slotFor({ schema, mode, multiline = false }: { schema?: unknown; mode?: ViewOptions['mode']; multiline?: boolean }): Slot {
    if (isRecord(schema)) {
        const slot = slotShape(schema);
        if (slot.as !== 'native') return multiline && slot.as === 'text' ? { ...slot, multiLine: true } : slot;
    }
    if (mode === 'template') return { as: 'text', multiLine: multiline };
    return { as: 'native', multiLine: multiline };
}

/** The shape of what a source holds in the sample ('unknown' without one). */
export function shapeAt(source: MappingSource, sample: Sample): Shape {
    if (!sample) return 'unknown';
    return shapeOf(walkSource(source, sample));
}

/** How many values a source holds in the sample, for a list; null otherwise. */
export function countAt(source: MappingSource, sample: Sample): number | null {
    if (!sample) return null;
    const result = walkSource(source, sample);
    if (isMany(result)) return manyItems(result).items.length;
    return Array.isArray(result) ? result.length : null;
}

/** A pick of one source with one intent, in the stored form. */
export function makePick(source: MappingSource, intent: PickIntent): PickBinding {
    const pick: PickBinding = { kind: 'pick', v: MAPPING_VERSION, from: source, take: intent.take, as: intent.as };
    if (intent.join) pick.join = intent.join;
    return pick;
}

/** The intent core defaultIntent gives, without its warning. */
function intentFor(source: MappingSource, slot: Slot, sample: Sample): PickIntent {
    const { take, as, join } = defaultIntent(shapeAt(source, sample), slot);
    return join ? { take, as, join } : { take, as };
}

/**
 * The pick a path the variable picker handed over becomes in this field, or
 * null when the path names no Source (a `secrets.` path, a half-typed one).
 */
export function pickFromPath(path: string, slot: Slot, sample: Sample): PickBinding | null {
    const source = sourceFromPath(path);
    return source ? makePick(source, intentFor(source, slot, sample)) : null;
}

/** The same, as a part of a composed text: always text, a list laid out as the field reads. */
export function partFromPath(path: string, slot: Slot, sample: Sample): PickPart | null {
    const source = sourceFromPath(path);
    if (!source) return null;
    const intent = intentFor(source, { as: 'text', multiLine: slot.multiLine }, sample);
    return { from: source, ...intent };
}

/** Does the pick hand many values to a field for one (the amber sentence)? */
export function manyForOne(intent: PickIntent, shape: Shape): boolean {
    if (shape !== 'list' && shape !== 'table') return false;
    return intent.take === 'one' || (intent.take === 'first' && (intent.as === 'number' || intent.as === 'date' || intent.as === 'yesno'));
}

const PREVIEW_MAX = 160;
const resolver = createResolver(MAPPING_DEPS);

/** What a resolved value looks like in one or two lines of grey text, or null for nothing. */
export function previewText(value: unknown): string | null {
    if (value === undefined) return null;
    let text: string;
    if (typeof value === 'string') text = value;
    else if (Array.isArray(value)) text = inlineText(value);
    else if (isRecord(value)) text = renderText(value, { join: 'comma' });
    else text = value === null ? '' : String(value);
    return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text;
}

/** The value a pick of `source` with this intent gives on the sample, as the run resolves it. */
export function resolvePreview(source: MappingSource, intent: PickIntent, sample: Sample): unknown {
    if (!sample) return undefined;
    return resolver.resolveValue(makePick(source, intent), sample, { silent: true });
}

// ── Where a source comes from ───────────────────────────────────────────

/** What the variable picker knows of an upstream step (bindings VariableGroup). */
export interface GroupLike {
    label?: string;
    basePath?: string;
    hasRealData?: boolean;
}

function baseOf(source: MappingSource): string | null {
    switch (source.root) {
        case 'steps':
            return `steps.${source.id}.output`;
        case 'trigger':
        case 'run':
            return 'trigger.output';
        case 'loop':
            return `loop.${source.id}`;
        case 'item':
            return 'item';
        case 'vars':
            return 'vars';
        default:
            return null;
    }
}

/** The display name of the step (or trigger) a source comes from. */
export function groupLabelOf(
    source: MappingSource,
    groups: readonly GroupLike[] | null | undefined,
    stepLabelById?: Pick<Map<string, string>, 'get'> | null,
): string {
    const base = baseOf(source);
    const group = (groups || []).find((g) => g.basePath === base);
    if (group?.label) return group.label;
    if (source.root === 'steps') return stepLabelById?.get(source.id) || '';
    return '';
}

/**
 * Is a pick's source gone? Its step is not before this one any more (deleted,
 * or moved after it), or the step's last real run lacks the first key it
 * reads (a field renamed upstream). Only said when the editor knows the
 * steps, and a key only against real data: a design-time sample is often
 * partial, and a chip must never cry wolf. The web's rule (slotModel isStale).
 */
export function isStale(source: MappingSource, groups: readonly GroupLike[] | null | undefined, sample: Sample): boolean {
    if (!groups || !groups.length) return false;
    const base = baseOf(source);
    const group = groups.find((g) => g.basePath === base);
    if ((source.root === 'steps' || source.root === 'loop') && !group) return true;
    if (!group?.hasRealData || (source.root !== 'steps' && source.root !== 'trigger')) return false;
    const first = source.path[0];
    const data = sample ? sourceBase(source, sample) : undefined;
    return typeof first === 'string' && isRecord(data) && !Object.prototype.hasOwnProperty.call(data, first);
}
