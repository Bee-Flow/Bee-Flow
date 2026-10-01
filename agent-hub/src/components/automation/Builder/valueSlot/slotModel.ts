import { evaluate } from '@shared/expr/index.mjs';
import * as parse from '@shared/expr/parse.mjs';
import {
    MAPPING_VERSION, TRIGGER_RUN_KEYS, defaultIntent, humanizeKey, isCompose, isMany, isPick, isPrefix, legacyPathOf,
    liftLegacy, lowerPick, manyItems, shapeOf, slotShape, sourceBase, sourceFromPath, walkMany, walkSource,
} from '@shared/mapping/index.mjs';
import type {
    ComposeBinding, CurrentItem, MappingSource, PickBinding, PickIntent, PickPart, Shape, Slot, Source,
} from '@shared/mapping/index.mjs';
import { bindingFromInput as bindingFromInputJs } from '../../../../utils/bindingHelpers';
import { pickableSource, type DraggedSource } from './slotDnd';

/**
 * The model behind ValueSlot: what a stored value is shown as, and what a
 * picked value turns it into. Pure; the component only draws.
 *
 * A slot stores its value in one of three spellings (`storage`):
 *
 *   binding  a step input or config binding: picks are stored as v1 picks
 *            (`{ kind: 'pick', v: 1, from, take, as }`), typed text as a
 *            literal, text with values as a compose.
 *   legacy   a value that ends up inside an expression string (a condition's
 *            operands): picks are written in the legacy spelling the core's
 *            lowerPick gives (`first(p)`, a ref).
 *   path     a config field that holds a plain path string (a collection
 *            step's list, a datetime input): the path of the list itself.
 *
 * Whatever the spelling, a stored legacy ref or one-call formula is SHOWN as
 * the pick it lifts to (core liftLegacy, which proves on the sample that the
 * chip gives what the run gives) and only rewritten when the user changes it.
 */

export type SlotStorage = 'binding' | 'legacy' | 'path';

export type SlotView =
    | { kind: 'empty' }
    | { kind: 'literal'; text: string }
    | { kind: 'pick'; pick: PickBinding; lifted: boolean }
    | { kind: 'compose'; compose: ComposeBinding }
    | { kind: 'formula'; binding: unknown };

type Sample = object | null | undefined;

const LIFT_DEPS = { evaluate, parse };

const bindingFromInput = bindingFromInputJs as (text: unknown, mode: 'fixed' | 'expression') => unknown;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function liftOrFormula(binding: unknown, sample: Sample): SlotView {
    const pick = liftLegacy(binding, sample, null, LIFT_DEPS);
    if (pick) return { kind: 'pick', pick, lifted: true };
    // `trigger.<key>` that is neither the payload nor the trigger's metadata
    // reads nothing at run time: shown as the chip it means, which isStale
    // marks amber, never as a Formula that looks like it works.
    const ref = binding as { kind?: string; path?: unknown };
    const from = ref.kind === 'ref' ? sourceFromPath(ref.path) : null;
    if (from && from.root === 'run' && !TRIGGER_RUN_KEYS.includes(String(from.path[0]))) {
        return { kind: 'pick', pick: makePick(from, { take: 'one', as: 'native' }), lifted: true };
    }
    return { kind: 'formula', binding };
}

/** What a stored value is shown as. */
export function viewOf(value: unknown, storage: SlotStorage, sample: Sample): SlotView {
    if (storage === 'path') {
        const text = typeof value === 'string' ? value : '';
        if (!text.trim()) return { kind: 'empty' };
        const pick = liftLegacy({ kind: 'ref', path: text.trim() }, sample, null, LIFT_DEPS);
        // Anything that is not one path (a fixed date, a half-typed path) is text.
        return pick ? { kind: 'pick', pick, lifted: true } : { kind: 'literal', text };
    }
    if (value === null || value === undefined) return { kind: 'empty' };
    if (!isRecord(value)) {
        const text = String(value);
        return text === '' ? { kind: 'empty' } : { kind: 'literal', text };
    }
    if (isPick(value)) return { kind: 'pick', pick: value, lifted: false };
    if (isCompose(value)) return { kind: 'compose', compose: value };
    switch (value.kind) {
        case 'literal': {
            const v = value.value;
            if (v === null || v === undefined || v === '') return { kind: 'empty' };
            return isRecord(v) || Array.isArray(v) ? { kind: 'formula', binding: value } : { kind: 'literal', text: String(v) };
        }
        case 'ref':
        case 'expr':
            return liftOrFormula(value, sample);
        default:
            return { kind: 'formula', binding: value };
    }
}

/** The plain-language kinds of the field chrome, as the `as` of a slot. */
const KIND_AS: Readonly<Record<string, Slot['as']>> = {
    text: 'text', email: 'text', choice: 'text', number: 'number', date: 'date', yesno: 'yesno', list: 'list', table: 'list',
};

export interface SlotSpec {
    /** What the field wants, when the caller knows it exactly. */
    slot?: Partial<Slot> | null;
    /** The field's JSON schema (a tool input). */
    schema?: unknown;
    stepType?: string;
    field?: string;
    /** The chrome's kind word (fieldKinds expectedKindFor), for callers without a schema. */
    expectKind?: string | null;
    multiLine?: boolean;
}

/** What a field wants: the caller's slot, else its schema (core slotShape), else its kind word, else native. */
export function slotFor({ slot, schema, stepType, field, expectKind, multiLine }: SlotSpec): Slot {
    if (slot && slot.as) return { multiLine: !!multiLine, ...slot } as Slot;
    if (isRecord(schema) || stepType) {
        const s = slotShape(schema, { stepType, field }) as Slot;
        if (s.as !== 'native' || !expectKind) return multiLine && s.as === 'text' ? { ...s, multiLine: true } : s;
    }
    const as = (expectKind && KIND_AS[expectKind]) || 'native';
    return { as, multiLine: !!multiLine };
}

/** The shape of what a source holds in the sample, or the hint a drag carried. */
export function shapeAt(source: MappingSource, sample: Sample, hint?: string | null): Shape {
    if (sample) {
        const shape = shapeOf(walkSource(source, sample)) as Shape;
        if (shape !== 'missing') return shape;
    }
    if (hint === 'scalar' || hint === 'json' || hint === 'single') return 'single';
    if (hint === 'list' || hint === 'table' || hint === 'object') return hint;
    return sample ? 'missing' : 'unknown';
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
    const pick: PickBinding = { kind: 'pick', v: MAPPING_VERSION as 1, from: source, take: intent.take, as: intent.as };
    if (intent.join) pick.join = intent.join;
    return pick;
}

/**
 * The source a click or a drop hands over, from its legacy path and what came
 * with it. A Source that came along is used when a pick can hold it (a
 * column's WILD dropped, slotDnd.pickableSource); otherwise the path's.
 */
export function draggedFrom(
    path: string,
    extra: Omit<Partial<DraggedSource>, 'source' | 'shape'> & { source?: Source | MappingSource | null; shape?: string | null } = {},
): DraggedSource | null {
    const source = pickableSource(extra.source) || sourceFromPath(path);
    if (!source) return null;
    const out: DraggedSource = { source };
    if (extra.labelParts) out.labelParts = extra.labelParts;
    if (extra.groupLabel) out.groupLabel = extra.groupLabel;
    if (extra.shape) out.shape = extra.shape as Shape;
    if (typeof extra.count === 'number') out.count = extra.count;
    if (extra.take === 'each') out.take = 'each';
    return out;
}

const MANY = new Set(['list', 'table']);
const ONE_VALUE = new Set(['number', 'date', 'yesno']);

/**
 * Does the pick need the amber sentence (many values into a field for one)?
 * A number, date or yes/no field always says so while a list feeds it: the
 * first or last of it (the default), and a stored ref that hands over the
 * whole list as it is, which such a field cannot hold.
 */
export function manyForOne(pick: PickIntent, shape: Shape, slot: Slot): boolean {
    if (!MANY.has(shape)) return false;
    if (pick.take === 'one') return true;
    return ONE_VALUE.has(slot.as) && pick.take !== 'count';
}

// ── Columns: a whole table into a list field ─────────────────────────────

export interface Columns {
    /** The table the column comes from. */
    table: MappingSource;
    columns: Array<{ key: string; label: string }>;
    /** The chosen column, or null when none is (amber). */
    column: string | null;
}

/** Wants the field a list of single values (not of records)? */
function wantsValueList(slot: Slot): boolean {
    return slot.as === 'list' && slot.items !== 'table' && slot.items !== 'object';
}

function columnsOf(table: MappingSource, sample: Sample): string[] {
    const result = walkSource(table, sample || {});
    const items = isMany(result) ? manyItems(result).items : Array.isArray(result) ? result : [];
    const keys: string[] = [];
    for (const row of items.slice(0, 20)) {
        if (!isRecord(row)) continue;
        for (const k of Object.keys(row)) if (!keys.includes(k)) keys.push(k);
    }
    return keys;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The column named like the field ("E-mail" for a field "email"), or null. */
export function matchColumn(columns: string[], names: Array<string | null | undefined>): string | null {
    const wanted = names.filter((n): n is string => !!n).map(squash).filter(Boolean);
    for (const name of wanted) {
        const exact = columns.find(c => squash(c) === name);
        if (exact) return exact;
    }
    for (const name of wanted) {
        const near = columns.find(c => squash(c).length > 2 && (name.includes(squash(c)) || squash(c).includes(name)));
        if (near) return near;
    }
    return null;
}

/**
 * The "Which column?" question for a pick into a list field: when the pick
 * is a whole table (no column yet), or a column of one (the current answer).
 * Null when the question does not apply.
 */
export function columnChoice(pick: PickBinding, sample: Sample, slot: Slot): Columns | null {
    if (!wantsValueList(slot) || !sample) return null;
    const from = pick.from;
    const asTable = shapeAt(from, sample) === 'table' ? from : null;
    const parent = !asTable && from.path.length ? ({ ...from, path: from.path.slice(0, -1) } as MappingSource) : null;
    const table = asTable || (parent && shapeAt(parent, sample) === 'table' ? parent : null);
    if (!table) return null;
    const keys = columnsOf(table, sample);
    if (!keys.length) return null;
    const last = from.path[from.path.length - 1];
    const column = !asTable && typeof last === 'string' && keys.includes(last) ? last : null;
    if (!asTable && !column) return null;
    return { table, columns: keys.map(key => ({ key, label: humanizeKey(key) || key })), column };
}

// ── Accepting a pick ────────────────────────────────────────────────────

export interface AcceptContext {
    storage: SlotStorage;
    slot: Slot;
    sample: Sample;
    /** The field's names, for the column a whole table defaults to. */
    names?: Array<string | null | undefined>;
    /**
     * The legacy path the user clicked or dropped, when there is one: its
     * `[*]` are kept when the pick is written in the legacy spelling, where
     * the sample cannot show the list (core legacyPathOf).
     */
    hint?: string | null;
}

/** The pick a dragged source becomes in this slot: core defaultIntent, and a column for a table. */
export function pickFor(dragged: DraggedSource, { slot, sample, names = [] }: AcceptContext): { pick: PickBinding; shape: Shape } {
    if (dragged.take === 'each') {
        // A value of the current item: as ONE item holds it (the panel's
        // shape), not as the whole list's column reads in the sample.
        const shape = shapeAt(dragged.source, null, dragged.shape);
        const { warning: _w, ...intent } = defaultIntent(shape, slot);
        return { pick: makePick(dragged.source, { ...intent, take: 'each' }), shape };
    }
    let source = dragged.source;
    let shape = shapeAt(source, sample, dragged.shape);
    if (shape === 'table' && wantsValueList(slot)) {
        const column = matchColumn(columnsOf(source, sample), names);
        if (column) {
            source = { ...source, path: [...source.path, column] } as MappingSource;
            shape = shapeAt(source, sample);
        }
    }
    const { warning: _w, ...intent } = defaultIntent(shape, slot);
    return { pick: makePick(source, intent), shape };
}

/** A pick as a part of a compose (a text). */
function partOf(pick: PickBinding): PickPart {
    const part: PickPart = { from: pick.from, take: pick.take, as: 'text' };
    if (pick.join) part.join = pick.join;
    return part;
}

/**
 * The value a slot holds after a pick arrives, and whether that pick
 * REPLACED something (the slot then offers Undo). Typed text in a text field
 * is never replaced: the value is added after it (a compose), the same for
 * a value added to a text that already holds values. A stored `{{ }}`
 * template (the old editor wrote every text with values as one; M5 lifts
 * them) is text with values too: a single value is added to it as one more
 * `{{ }}`. Only what a template cannot hold (a list joined into a text)
 * replaces it, with Undo.
 */
export function acceptPick(current: unknown, pick: PickBinding, ctx: AcceptContext): { value: unknown; replaced: boolean } {
    const view = viewOf(current, ctx.storage, ctx.sample);
    const replaced = view.kind !== 'empty';
    // A path or a legacy binding cannot read the current item: such a field keeps what it holds.
    if (pick.take === 'each' && ctx.storage !== 'binding') return { value: current, replaced: false };
    if (ctx.storage === 'path') {
        // The list itself: its path, with [*] where the data shows a list on the way.
        return { value: legacyPathOf(pick.from, ctx.sample, ctx.hint) ?? '', replaced };
    }
    if (ctx.storage === 'legacy') {
        const lowered = lowerPick(pick, ctx.sample, ctx.hint) || lowerPick({ ...pick, take: 'one' }, ctx.sample, ctx.hint);
        return { value: lowered ?? current, replaced };
    }
    if (ctx.slot.as === 'text' && view.kind === 'literal' && view.text.trim()) {
        return { value: { kind: 'compose', v: MAPPING_VERSION, parts: [view.text, partOf(pick)] }, replaced: false };
    }
    if (view.kind === 'compose') {
        return { value: { ...view.compose, parts: [...view.compose.parts, partOf(pick)] }, replaced: false };
    }
    const template = templateText(current);
    if (template !== null) {
        const lowered = lowerPick(pick, ctx.sample, ctx.hint);
        if (lowered?.kind === 'ref') return { value: { kind: 'template', value: `${template}{{${lowered.path}}}` }, replaced: false };
    }
    return { value: pick, replaced };
}

/** The text of a stored `{{ }}` template, or null for anything else. */
function templateText(value: unknown): string | null {
    return isRecord(value) && value.kind === 'template' && typeof value.value === 'string' ? value.value : null;
}

// One of the calls lowerPick writes a pick as: `first(p)`, `join(p, ", ")`.
const LOWERED_CALL_RE = /^\s*(?:first|last|count|join)\(\s*([^,()]+?)\s*(?:,[^()]*)?\)\s*$/;

/**
 * The legacy path a slot's stored value reads, for the `[*]` a rewrite of it
 * keeps (AcceptContext.hint): a path field's path, a ref's path, the path in
 * a `first(p)` / `join(p, …)` call. Null for anything else.
 */
export function storedPathOf(value: unknown, storage: SlotStorage): string | null {
    if (storage === 'path') return typeof value === 'string' && value.trim() ? value.trim() : null;
    if (!isRecord(value)) return null;
    if (value.kind === 'ref' && typeof value.path === 'string') return value.path;
    if (value.kind === 'expr' && typeof value.value === 'string') return LOWERED_CALL_RE.exec(value.value)?.[1] ?? null;
    return null;
}

/** A changed pick written back in the slot's spelling (`hint`: as in AcceptContext). */
export function storePick(pick: PickBinding, storage: SlotStorage, sample: Sample, hint?: string | null): unknown {
    if (storage === 'path') return legacyPathOf(pick.from, sample, hint) ?? '';
    if (storage === 'legacy') return lowerPick(pick, sample, hint);
    return pick;
}

// ── Advanced › Formula ──────────────────────────────────────────────────

/**
 * What Advanced › Formula edits for a stored value, or null when a value
 * cannot be written as a formula (the slot then offers no Formula):
 *
 *   path storage  the path string as the binding it reads (`{ kind: 'ref' }`)
 *   a pick        its legacy spelling (core lowerPick: `first(p)`, a ref);
 *                 null for what has none (a bulleted text, per item)
 *   a compose     a `{{ }}` template, when every value in it is a single one
 *                 and no typed part holds `{{`; null otherwise
 *   anything else as stored
 *
 * The editor never shows a stored pick or compose as JSON: typing into that
 * JSON saved it as a literal string and destroyed the binding.
 */
export function formulaInput(value: unknown, storage: SlotStorage, sample: Sample): { value: unknown } | null {
    if (storage === 'path') {
        const text = typeof value === 'string' ? value.trim() : '';
        return { value: text ? bindingFromInput(text, 'expression') : { kind: 'literal', value: '' } };
    }
    if (isPick(value)) {
        const lowered = lowerPick(value, sample);
        return lowered ? { value: lowered } : null;
    }
    if (isCompose(value)) {
        let text = '';
        for (const part of value.parts) {
            if (typeof part === 'string') {
                if (part.includes('{{')) return null;
                text += part;
                continue;
            }
            const lowered = lowerPick(part, sample);
            if (lowered?.kind !== 'ref') return null;
            text += `{{${lowered.path}}}`;
        }
        return { value: bindingFromInput(text, 'fixed') };
    }
    return { value };
}

/** What the formula editor gave, in the slot's spelling: a path field gets the path back. */
export function formulaOutput(binding: unknown, storage: SlotStorage): unknown {
    if (storage !== 'path') return binding;
    const x = (binding || {}) as { kind?: string; path?: unknown; value?: unknown };
    if (x.kind === 'ref') return String(x.path ?? '');
    const text = typeof x.value === 'string' ? x.value : x.value == null ? '' : String(x.value);
    // A lone `{{p}}` is the path p; the runtime walks a path field, never renders it.
    const lone = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/.exec(text);
    return lone ? lone[1] : text;
}

// ── The current item (a step that runs once per item) ──────────────────

/** The first item of the list a step repeats over, in the sample; undefined without one. */
function firstItem(currentItem: CurrentItem | null | undefined, sample: Sample): unknown {
    if (!sample || currentItem?.take !== 'each' || !currentItem.over) return undefined;
    const { items } = manyItems(walkSource(currentItem.over, sample));
    return items[0];
}

/**
 * The sample with the list's first item as the current one, the scope
 * execRepeat sets per item, so an `each` pick previews as the run gives it
 * for that item (the core resolver reads `_mappingScope`). The sample as it
 * is when the step does not repeat or the list is empty there.
 */
export function withItemScope(sample: Sample, currentItem: CurrentItem | null | undefined): Sample {
    const item = firstItem(currentItem, sample);
    if (item === undefined || !sample || !currentItem?.over) return sample;
    return { ...sample, _mappingScope: { over: currentItem.over, item, index: 0 } } as Sample;
}

/** The shape of what an `each` pick reads in the first item; null when it is not one of the current item. */
export function itemShapeAt(pick: Pick<PickBinding, 'from' | 'take'>, sample: Sample, currentItem: CurrentItem | null | undefined): Shape | null {
    if (pick.take !== 'each' || currentItem?.take !== 'each' || !currentItem.over || !isPrefix(currentItem.over, pick.from)) return null;
    const item = firstItem(currentItem, sample);
    if (item === undefined) return 'unknown';
    return shapeOf(walkMany(item, pick.from.path.slice(currentItem.over.path.length))) as Shape;
}

// ── Where a source comes from ───────────────────────────────────────────

export interface GroupLike {
    id?: string;
    label?: string;
    basePath?: string;
    /** The group shows a real run's output (not only the design-time sample). */
    hasRealData?: boolean;
}

function baseOf(source: MappingSource): string | null {
    switch (source.root) {
        case 'steps': return `steps.${(source as { id: string }).id}.output`;
        case 'trigger':
        case 'run': return 'trigger.output';
        case 'loop': return `loop.${(source as { id: string }).id}`;
        case 'item': return 'item';
        case 'vars': return 'vars';
        default: return null;
    }
}

/** The display name of the step (or trigger) a source comes from. */
export function groupLabelOf(source: MappingSource, groups: readonly GroupLike[] | null | undefined, stepLabelById?: ReadonlyMap<string, string> | null): string {
    const base = baseOf(source);
    const group = (groups || []).find(g => g.basePath === base);
    if (group?.label) return group.label;
    if (source.root === 'steps') return stepLabelById?.get((source as { id: string }).id) || '';
    return '';
}

/**
 * Is a pick's source gone? Its step is not before this one any more (deleted,
 * or moved after it), the step's last real run lacks the first key it reads
 * (a field renamed upstream), or it is a `trigger.<key>` that is neither the
 * payload nor the trigger's metadata. Only said when the editor knows the
 * steps, and a key only against real data: a design-time sample is often
 * partial, and a chip must never cry wolf.
 */
export function isStale(source: MappingSource, groups: readonly GroupLike[] | null | undefined, sample: Sample): boolean {
    // `trigger.<key>` without `.output` reads the trigger's own metadata; any
    // other key there reads nothing at run time, whatever the editor knows.
    if (source.root === 'run') return !TRIGGER_RUN_KEYS.includes(String(source.path[0]));
    if (!groups || !groups.length) return false;
    const base = baseOf(source);
    const group = groups.find(g => g.basePath === base);
    if ((source.root === 'steps' || source.root === 'loop') && !group) return true;
    if (!group?.hasRealData || (source.root !== 'steps' && source.root !== 'trigger')) return false;
    const first = source.path[0];
    const data = sample ? sourceBase(source, sample) : undefined;
    return typeof first === 'string' && isRecord(data) && !Object.prototype.hasOwnProperty.call(data, first);
}

/** Can a field that holds only the legacy spelling store this option? (lowerPick has no bulleted text, no per item.) */
export function lowerable(option: PickIntent): boolean {
    return option.take !== 'each' && !(option.take === 'all' && option.as === 'text' && option.join === 'bullets');
}

/**
 * Is a source read off a list on its way (a column of a table, a key of each
 * order)? What its name says ("Product of all lines" or "Tags of …").
 * Undefined without data to tell.
 */
export function crossesList(source: MappingSource, sample: Sample): boolean | undefined {
    if (!sample) return undefined;
    for (let n = 0; n < source.path.length; n++) {
        const shape = shapeAt({ ...source, path: source.path.slice(0, n) } as MappingSource, sample);
        if (shape === 'list' || shape === 'table') return true;
        if (shape === 'missing') return undefined;
    }
    return false;
}
