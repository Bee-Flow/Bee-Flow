import { useMemo } from 'react';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';
import { humanizeKey, labelParts, sourceFromPath } from '@shared/mapping/index.mjs';
import type { LabelPart, MappingSource, Take } from '@shared/mapping/index.mjs';

/**
 * The name a picked value goes by in the editor: "E-mail adres of klant",
 * "Product of all orderregels", "The first orderregel". Never a path, a
 * bracket or a `[*]`.
 *
 * The words come from i18n (namespace `mapping`, keys `mapping.slot.label.*`);
 * the parts they are built from are language-free: the keys from the
 * source's base to the value, with a list position as `{ index }` and the
 * legacy `[*]` as `{ each: true }`. The source panel hands those parts over
 * with the value it picked; without them the parts are read from the pick's
 * Source, and a pick's stored `label` (a display cache) is used as it is.
 */

export type { LabelPart };
export { humanizeKey };

/** The label parts of a Source's path (core labelParts: keys, positions, a legacy [*]). */
export function partsFromSource(source: Partial<MappingSource> | null | undefined): LabelPart[] {
    return labelParts(source && Array.isArray(source.path) ? source.path : []);
}

/** A name inside a sentence: "Klant" → "klant", but "IBAN" and "API key" stay. */
function lowerFirst(text: string): string {
    if (/^[A-Z]{2}/.test(text)) return text;
    return text.charAt(0).toLowerCase() + text.slice(1);
}

export interface PickLike {
    from?: Partial<MappingSource> | null;
    take?: Take | string;
    label?: string;
}

export interface PickLabelContext {
    /** The parts the source panel gave the picked value (label.mjs labelParts). */
    labelParts?: LabelPart[] | null;
    /** The display name of the step (or trigger) the value comes from. */
    groupLabel?: string | null;
    /**
     * Is the value read off a list on its way ("Product" of the order LINES)?
     * False words "all" as a plain "of": a list that IS the value ("Tags of
     * Bestelling ontvangen", its count on the chip) is not "of all" anything.
     * Unknown (undefined): the parent is taken to be the list when it is a key.
     */
    crossesList?: boolean;
}

type KeyPart = { key: string; text: string };
const isKey = (p: LabelPart): p is KeyPart => 'key' in p;
const isIndex = (p: LabelPart): p is { index: number } => 'index' in p;

type Phrase = readonly [key: string, english: string];

/** "{field} … {parent}" per take, for a value inside something with a name. */
const WITH_PARENT: Readonly<Record<string, Phrase>> = {
    one: ['mapping.slot.label.of', '{field} of {parent}'],
    all: ['mapping.slot.label.of_all', '{field} of all {parent}'],
    first: ['mapping.slot.label.of_first', '{field} of the first {parent}'],
    last: ['mapping.slot.label.of_last', '{field} of the last {parent}'],
    each: ['mapping.slot.label.of_current', '{field} (of this {parent})'],
};

/**
 * "{field} … {step}" per take, for a value at the top of a step's output: the
 * step's name is a name, so it keeps its capitals ("Tags from Bestelling
 * ontvangen", not "tags of bestelling ontvangen").
 */
const FROM_STEP: Readonly<Record<string, Phrase>> = {
    one: ['mapping.slot.label.from', '{field} from {step}'],
    first: ['mapping.slot.label.from_first', 'The first {field} from {step}'],
    last: ['mapping.slot.label.from_last', 'The last {field} from {step}'],
    each: ['mapping.slot.label.from_current', '{field} (this one, from {step})'],
};

/** Roots whose group is a step's own name; the others ("Current row") are words. */
const NAMED_ROOTS = new Set(['steps', 'trigger', 'run']);

/** A list on its own, per take: "The first tags". */
const ALONE: Readonly<Record<string, Phrase>> = {
    first: ['mapping.slot.label.first', 'The first {parent}'],
    last: ['mapping.slot.label.last', 'The last {parent}'],
};

const say = (t: TranslateFn, [key, english]: Phrase, params: Record<string, unknown>) => t(key, english, params);

/** A whole step or trigger output, named after it. */
function wholeOutputLabel(t: TranslateFn, from: PickLike['from'], group: string): string {
    const root = from?.root;
    if (root === 'steps') return t('mapping.slot.label.output_of', 'Output of {step}', { step: group || (from as { id?: string }).id || '' });
    if (root === 'trigger' || root === 'run') return group || t('mapping.slot.label.trigger', 'Incoming data');
    return group || t('mapping.slot.label.value', 'Value');
}

/** A position in a list: "The first orderregel", "Orderregels, row 3". */
function positionLabel(t: TranslateFn, index: number, parentKey: KeyPart | undefined, group: string): string {
    if (index === 0) return say(t, ALONE.first, { parent: lowerFirst(parentKey ? parentKey.text : group) });
    return t('mapping.slot.label.row', '{parent}, row {row}', { parent: parentKey ? parentKey.text : group, row: index + 1 });
}

/** The label of a pick, worded with `t`. Pure: see usePickLabel for the hook. */
export function pickLabel(t: TranslateFn, pick: PickLike | null | undefined, ctx: PickLabelContext = {}): string {
    if (!pick) return '';
    if (!ctx.labelParts && typeof pick.label === 'string' && pick.label.trim()) return pick.label.trim();
    const all = ctx.labelParts || partsFromSource(pick.from);
    const parts = all.filter(p => !('each' in p));
    const group = ctx.groupLabel || '';
    if (!parts.length) return wholeOutputLabel(t, pick.from, group);

    const last = parts[parts.length - 1];
    const before = parts.slice(0, -1);
    const parentKey = [...before].reverse().find(isKey);
    if (isIndex(last)) return positionLabel(t, last.index, parentKey, group);

    const field = (last as KeyPart).text;
    if (!parentKey && isStepGroup(pick, group)) return stepFieldLabel(t, field, group, pick.take);
    const parent = lowerFirst(parentKey ? parentKey.text : group);
    let take = wordedTake(pick.take, all, before[before.length - 1], !!parent);
    // "of all" names the list the value comes from: the group (a step) is none.
    if (take === 'all' && (ctx.crossesList === false || (!parentKey && ctx.crossesList === undefined))) take = 'one';
    return fieldLabel(t, field, parent, take);
}

/** Is the group a step's (or the trigger's) own name? */
const isStepGroup = (pick: PickLike, group: string) => !!group && NAMED_ROOTS.has(String(pick.from?.root));

/** A value at the top of a step's output, named with the step. */
function stepFieldLabel(t: TranslateFn, field: string, step: string, take: string | undefined): string {
    if (take === 'count') return t('mapping.slot.label.count_of', 'Number of {parent}', { parent: lowerFirst(field) });
    const phrase = FROM_STEP[take || 'one'] || FROM_STEP.one;
    return say(t, phrase, { field: take === 'first' || take === 'last' ? lowerFirst(field) : field, step });
}

/**
 * The take a label is worded for: a legacy [*] on the way reads as "all"
 * (one value of it is all of them), a first row on the way as "first"
 * ("ID of the first order").
 */
function wordedTake(take: string | undefined, all: LabelPart[], prev: LabelPart | undefined, hasParent: boolean): string {
    if (prev && isIndex(prev) && prev.index === 0 && hasParent) return 'first';
    const worded = take || 'one';
    return worded === 'one' && all.some(p => 'each' in p) ? 'all' : worded;
}

/** A field, worded for its take, inside its parent when it has one. */
function fieldLabel(t: TranslateFn, field: string, parent: string, take: string): string {
    if (take === 'count') return t('mapping.slot.label.count_of', 'Number of {parent}', { parent: lowerFirst(field) });
    if (!parent) return ALONE[take] ? say(t, ALONE[take], { parent: lowerFirst(field) }) : field;
    return say(t, WITH_PARENT[take] || WITH_PARENT.one, { field, parent });
}

/**
 * A list's legacy path as a person reads it, for a list picker's rows: "Lines
 * of all orders" for a column (`orders[*].lines`), "Orders" for a list. The
 * raw path belongs in a title attribute; the path itself when it names no
 * value at all.
 */
export function listPathLabel(t: TranslateFn, path: string, stepLabelById?: ReadonlyMap<string, string> | null): string {
    const source = sourceFromPath(path);
    if (!source) return path;
    const groupLabel = source.root === 'steps'
        ? (stepLabelById?.get((source as { id: string }).id) || humanizeKey((source as { id: string }).id))
        : source.root === 'trigger' || source.root === 'run' ? lowerFirst(t('mapping.slot.label.trigger', 'Incoming data')) : '';
    return pickLabel(t, { from: source, take: path.includes('[*]') ? 'all' : 'one' }, { groupLabel });
}

/** pickLabel in the current language, recomputed only when its inputs change. */
export function usePickLabel(pick: PickLike | null | undefined, ctx: PickLabelContext = {}): string {
    const { t } = useTranslation();
    const { labelParts, groupLabel, crossesList } = ctx;
    return useMemo(() => pickLabel(t, pick, { labelParts, groupLabel, crossesList }), [t, pick, labelParts, groupLabel, crossesList]);
}

// ── Formula summaries ────────────────────────────────────────────────────
// A binding that does not lift to a pick shows as a grey "Formula" chip with
// a one-line summary. The summary names values the way a chip does: no
// `steps.`, no `.output`, no `[*]`, no `{{ }}`.

const PARSE_JSON_RE = /^\s*parseJson\(\s*([^,()]+?)\s*,\s*"([^"\\]*)"\s*\)\s*$/;
const PATH_RE = /\b(?:steps|trigger|loop|vars|item)(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[(?:\d+|\*|"[^"]*"|'[^']*')\])+/g;
const STRING_RE = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/;

/** One legacy path as words: "‹Orders ophalen › Items › Email›". */
function pathWords(t: TranslateFn, path: string, stepLabelById?: ReadonlyMap<string, string> | null): string {
    const source = sourceFromPath(path);
    if (!source) {
        const tail = path.replace(/\[[^\]]*\]/g, '').split('.').filter(Boolean);
        return `‹${humanizeKey(tail[tail.length - 1] || path)}›`;
    }
    const head = source.root === 'steps'
        ? (stepLabelById?.get(source.id) || humanizeKey(source.id))
        : source.root === 'trigger' || source.root === 'run' ? t('mapping.slot.label.trigger', 'Incoming data') : '';
    const segs = source.path.map(seg => (typeof seg === 'number' ? `#${seg + 1}` : humanizeKey(seg)));
    return `‹${[head, ...segs].filter(Boolean).join(' › ')}›`;
}

function wordsOutsideStrings(t: TranslateFn, text: string, stepLabelById?: ReadonlyMap<string, string> | null): string {
    return text
        .split(STRING_RE)
        .map((chunk, i) => (i % 2 === 1 ? chunk : chunk.replace(PATH_RE, p => pathWords(t, p, stepLabelById))))
        .join('');
}

/**
 * A one-line summary of a binding shown as a Formula: an expression with its
 * paths in words, a template with its placeholders in words, a ref as its
 * value's name.
 */
export function formulaSummary(
    t: TranslateFn,
    binding: { kind?: string; value?: unknown; path?: unknown } | null | undefined,
    stepLabelById?: ReadonlyMap<string, string> | null,
): string {
    if (!binding || typeof binding !== 'object') return '';
    let out = '';
    const fromText = binding.kind === 'expr' && typeof binding.value === 'string' ? PARSE_JSON_RE.exec(binding.value) : null;
    if (fromText) {
        // A value read out of a JSON text ("Pick fields from it"), in words.
        out = t('mapping.slot.formula.from_text', '{value}, read from the text: {path}', {
            value: pathWords(t, fromText[1], stepLabelById), path: fromText[2],
        });
    } else if (binding.kind === 'ref' && typeof binding.path === 'string') out = pathWords(t, binding.path, stepLabelById);
    else if (binding.kind === 'expr' && typeof binding.value === 'string') out = wordsOutsideStrings(t, binding.value, stepLabelById);
    else if (binding.kind === 'template' && typeof binding.value === 'string') {
        out = binding.value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, p: string) => pathWords(t, p.trim(), stepLabelById));
    }
    return out.replace(/\s+/g, ' ').trim();
}
