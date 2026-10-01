/**
 * The name a picked value goes by on the phone: "E-mail of customer",
 * "Product of all orderregels", "The first orderregel". Never a path, a
 * bracket or a `[*]`. The web's Builder/valueSlot/usePickLabel.ts words a
 * pick the same way with the same keys (namespace `mapping`, borrowed here),
 * so a value is called the same on both, pinned by valueSlot.lockstep.test.ts
 * (differential); the parts the words are built from are the shared core's
 * (label.mjs labelParts, humanizeKey).
 *
 * A pick's stored `label` (a display cache the AI builder or the web writes)
 * is used as it is; without one the label is read from the pick's Source.
 * Pure: the caller hands in `t`.
 */

import type { TranslateFn } from '@/core/i18n';
import { humanizeKey, labelParts, singularLabel, sourceFromPath, type LabelPart, type MappingSource } from '@/shared/mapping';

export interface PickLike {
    from?: Partial<MappingSource> | null;
    take?: string;
    label?: string;
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

const say = (t: TranslateFn, [key, english]: Phrase, params: Record<string, string | number>) => t(key, english, params);

/** A name inside a sentence: "Klant" → "klant", but "IBAN" and "API key" stay. */
function lowerFirst(text: string): string {
    if (/^[A-Z]{2}/.test(text)) return text;
    return text.charAt(0).toLowerCase() + text.slice(1);
}

/** A whole step or trigger output, named after it. */
function wholeOutputLabel(t: TranslateFn, from: PickLike['from'], group: string): string {
    const root = from?.root;
    const id = from && 'id' in from && typeof from.id === 'string' ? from.id : '';
    if (root === 'steps') return t('mapping.slot.label.output_of', 'Output of {step}', { step: group || id });
    if (root === 'trigger' || root === 'run') return group || t('mapping.slot.label.trigger', 'Incoming data');
    return group || t('mapping.slot.label.value', 'Value');
}

/** A position in a list: "The first orderregel", "Orderregels, row 3". */
function positionLabel(t: TranslateFn, index: number, parentKey: KeyPart | undefined, group: string): string {
    if (index === 0) return say(t, ALONE.first as Phrase, { parent: lowerFirst(parentKey ? parentKey.text : group) });
    return t('mapping.slot.label.row', '{parent}, row {row}', { parent: parentKey ? parentKey.text : group, row: index + 1 });
}

/**
 * The take a label is worded for: a first row on the way reads as "first"
 * ("ID of the first order"), a legacy [*] on the way as "all".
 */
function wordedTake(take: string | undefined, all: LabelPart[], prev: LabelPart | undefined, hasParent: boolean): string {
    if (prev && isIndex(prev) && prev.index === 0 && hasParent) return 'first';
    const worded = take || 'one';
    return worded === 'one' && all.some((p) => 'each' in p) ? 'all' : worded;
}

/** A field, worded for its take, inside its parent when it has one. */
function fieldLabel(t: TranslateFn, field: string, parent: string, take: string): string {
    if (take === 'count') return t('mapping.slot.label.count_of', 'Number of {parent}', { parent: lowerFirst(field) });
    const alone = ALONE[take];
    if (!parent) return alone ? say(t, alone, { parent: lowerFirst(field) }) : field;
    // One row of the list: "ID of the first order", not "of the first orders" (as on the web).
    const one = take === 'first' || take === 'last';
    return say(t, WITH_PARENT[take] ?? (WITH_PARENT.one as Phrase), { field, parent: one ? singularLabel(parent) : parent });
}

/**
 * The item a value of the CURRENT item is read from, by name, or null when
 * the value is not one: an `each` pick (the caller's item name, else the key
 * it sits in read as one item, "orderregels" → "orderregel"), or a key
 * straight under a loop item (`loop.line.email`: "Line"). As the web's.
 */
function currentItemName(pick: PickLike, parentKey: KeyPart | undefined, itemNoun: string | null | undefined): string | null {
    if (pick.take === 'each') return itemNoun || (parentKey ? singularLabel(parentKey.text) : null);
    const from = pick.from as { root?: string; id?: unknown } | null | undefined;
    if (from?.root !== 'loop' || parentKey) return null;
    return itemNoun || humanizeKey(from.id) || null;
}

/**
 * "E-mail (of this orderregel)" for a value of the current item; "Current
 * tag" for the item itself (a list of plain values), as the source panel
 * calls it. Null for any other value.
 */
function currentItemLabel(t: TranslateFn, pick: PickLike, { field, parentKey, itemNoun }: KeyContext): string | null {
    const item = currentItemName(pick, parentKey, itemNoun);
    if (!item) return null;
    if (!parentKey && singularLabel(field) === item) return t('mapping.slot.label.current_item', 'Current {item}', { item: lowerFirst(item) });
    return say(t, WITH_PARENT.each as Phrase, { field, parent: lowerFirst(item) });
}

/**
 * The label of a pick (or a compose part), worded with `t`. `groupLabel` is
 * the display name of the step or trigger the value comes from; `itemNoun`
 * the name of the step's current item when the value reads it (core
 * currentItemNoun).
 */
export function pickLabel(t: TranslateFn, pick: PickLike | null | undefined, groupLabel = '', itemNoun: string | null = null): string {
    if (!pick) return '';
    if (typeof pick.label === 'string' && pick.label.trim()) return pick.label.trim();
    const all = labelParts(Array.isArray(pick.from?.path) ? pick.from.path : []);
    const parts = all.filter((p) => !('each' in p));
    if (!parts.length) return wholeOutputLabel(t, pick.from, groupLabel);

    const last = parts[parts.length - 1] as LabelPart;
    const before = parts.slice(0, -1);
    const parentKey = [...before].reverse().find(isKey);
    if (isIndex(last)) return positionLabel(t, last.index, parentKey, groupLabel);

    return keyLabel(t, pick, { field: (last as KeyPart).text, parentKey, all, before, groupLabel, itemNoun });
}

/** What a value named by a key is worded from. */
interface KeyContext {
    field: string;
    parentKey: KeyPart | undefined;
    all: LabelPart[];
    before: LabelPart[];
    groupLabel: string;
    itemNoun: string | null;
}

/** A value named by its key: of the current item, at the top of a step, or inside its parent. */
function keyLabel(t: TranslateFn, pick: PickLike, ctx: KeyContext): string {
    const { field, parentKey, all, before, groupLabel } = ctx;
    const ofItem = currentItemLabel(t, pick, ctx);
    if (ofItem) return ofItem;
    if (!parentKey && groupLabel && NAMED_ROOTS.has(String(pick.from?.root))) return stepFieldLabel(t, field, groupLabel, pick.take);
    const parent = lowerFirst(parentKey ? parentKey.text : groupLabel);
    return fieldLabel(t, field, parent, keyTake(pick.take, all, before, { key: !!parentKey, any: !!parent }));
}

/** wordedTake, except that "of all" names the list the value comes from: the group (a step) is none. */
function keyTake(take: string | undefined, all: LabelPart[], before: LabelPart[], parent: { key: boolean; any: boolean }): string {
    const worded = wordedTake(take, all, before[before.length - 1], parent.any);
    return worded === 'all' && !parent.key ? 'one' : worded;
}

/** A value at the top of a step's output, named with the step. */
function stepFieldLabel(t: TranslateFn, field: string, step: string, take: string | undefined): string {
    if (take === 'count') return t('mapping.slot.label.count_of', 'Number of {parent}', { parent: lowerFirst(field) });
    const phrase = FROM_STEP[take || 'one'] ?? (FROM_STEP.one as Phrase);
    return say(t, phrase, { field: take === 'first' || take === 'last' ? lowerFirst(field) : field, step });
}

// ── Formula summaries ────────────────────────────────────────────────────
// A binding the core cannot lift to a pick shows as a grey "Formula" chip
// with a one-line summary that names values the way a chip does: no
// `steps.`, no `.output`, no `[*]`, no `{{ }}`.

const PARSE_JSON_RE = /^\s*parseJson\(\s*([^,()]+?)\s*,\s*"([^"\\]*)"\s*\)\s*$/;
const PATH_RE = /\b(?:steps|trigger|loop|vars|item)(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[(?:\d+|\*|"[^"]*"|'[^']*')\])+/g;
const STRING_RE = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/;

/** One legacy path as words: "‹Orders ophalen › Items › Email›". */
function pathWords(t: TranslateFn, path: string, stepLabelById?: Pick<Map<string, string>, 'get'> | null): string {
    const source = sourceFromPath(path);
    if (!source) {
        const tail = path.replace(/\[[^\]]*\]/g, '').split('.').filter(Boolean);
        return `‹${humanizeKey(tail[tail.length - 1] || path)}›`;
    }
    const id = 'id' in source && typeof source.id === 'string' ? source.id : '';
    let head = '';
    if (source.root === 'steps') head = stepLabelById?.get(id) || humanizeKey(id);
    else if (source.root === 'trigger' || source.root === 'run') head = t('mapping.slot.label.trigger', 'Incoming data');
    const segs = source.path.map((seg) => (typeof seg === 'number' ? `#${seg + 1}` : humanizeKey(seg)));
    return `‹${[head, ...segs].filter(Boolean).join(' › ')}›`;
}

function wordsOutsideStrings(t: TranslateFn, text: string, stepLabelById?: Pick<Map<string, string>, 'get'> | null): string {
    return text
        .split(STRING_RE)
        .map((chunk, i) => (i % 2 === 1 ? chunk : chunk.replace(PATH_RE, (p) => pathWords(t, p, stepLabelById))))
        .join('');
}

/**
 * A one-line summary of a binding shown as a Formula: an expression with its
 * paths in words, a template with its placeholders in words, a ref as its
 * value's name.
 */
export function formulaSummary(
    t: TranslateFn,
    binding: unknown,
    stepLabelById?: Pick<Map<string, string>, 'get'> | null,
): string {
    if (!binding || typeof binding !== 'object') return '';
    const b = binding as { kind?: unknown; value?: unknown; path?: unknown };
    let out = '';
    const fromText = b.kind === 'expr' && typeof b.value === 'string' ? PARSE_JSON_RE.exec(b.value) : null;
    if (fromText) {
        // A value read out of a JSON text ("Pick fields from it"), in words.
        out = t('mapping.slot.formula.from_text', '{value}, read from the text: {path}', {
            value: pathWords(t, fromText[1] as string, stepLabelById), path: fromText[2] as string,
        });
    } else if (b.kind === 'ref' && typeof b.path === 'string') out = pathWords(t, b.path, stepLabelById);
    else if (b.kind === 'expr' && typeof b.value === 'string') out = wordsOutsideStrings(t, b.value, stepLabelById);
    else if (b.kind === 'template' && typeof b.value === 'string') {
        out = b.value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, p: string) => pathWords(t, p.trim(), stepLabelById));
    }
    return out.replace(/\s+/g, ' ').trim();
}
