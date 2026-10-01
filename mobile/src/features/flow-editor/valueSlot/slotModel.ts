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
    createResolver,
    defaultIntent,
    inlineText,
    isCompose,
    isPick,
    liftLegacy,
    makePick,
    renderText,
    shapeAt,
    slotShape,
    sourceFromPath,
    type ComposeBinding,
    type MappingSource,
    type PickBinding,
    type PickIntent,
    type PickPart,
    type Slot,
    type SlotGroupLike,
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
// shapeAt, countAt, makePick, manyForOne, groupLabelOf and isStale are the
// shared core's (mapping/slotView.mjs), the very functions the web's
// valueSlot uses: no port here to drift from it.

export { countAt, groupLabelOf, isStale, makePick, manyForOne, shapeAt } from '@/shared/mapping';

/** What the variable picker knows of an upstream step (bindings VariableGroup). */
export type GroupLike = SlotGroupLike;
