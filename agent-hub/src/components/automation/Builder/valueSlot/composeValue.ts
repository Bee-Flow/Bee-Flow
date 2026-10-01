import { evaluate } from '@shared/expr/index.mjs';
import * as parse from '@shared/expr/parse.mjs';
import {
    createResolver, defaultIntent, describeSource, humanizeKey, isCompose, isPick, MAPPING_VERSION, parseLegacyPath, RUNTIME_ROOTS,
    pickForLegacyPath, pickProblems, composeProblems, sameSource, shapeOf, slotShape, sourceFromPath, sourceProblems,
    templateToCompose, textAsTemplate, textSitesOf, walkSource,
} from '@shared/mapping/index.mjs';
import type {
    ComposeBinding, MappingSource, PickBinding, PickIntent, PickPart, Shape, Slot,
} from '@shared/mapping/index.mjs';
import { previewValue, walkPath } from '../../../../utils/bindingHelpers';

/**
 * The model behind ComposeField: a text field's stored value as PIECES the
 * editor shows (typed text, value pills, legacy `{{ }}` pills), and the
 * pieces back as the value the field stores. Pure, so the rules can be
 * tested without a DOM.
 *
 * A text field stores one of:
 *   - a plain string: text, or a legacy `{{ }}` template;
 *   - a compose binding (v1): text with picks in it, rendered by the run as
 *     readable text (a list one per line, never JSON);
 *   - a pick (v1), only in a fill_document value that is one value and
 *     nothing else (`sole`): its real type is kept there.
 *
 * Which one is written follows the shared sites table (sites.mjs): a text
 * whose executor takes a compose (`compose`) and whose `{{ }}` text may be
 * turned into one (`lift`) is written as a compose. A legacy template there
 * is shown as pills and stays the string it is until the person changes the
 * field; then it is lifted, whole or not at all, by the shared rule
 * (template.mjs templateToCompose, the rule the AI builder uses too). A
 * placeholder that does not lift (an expression, `secrets.x`, an input
 * name) keeps the whole text a template, but only when every value already
 * in it can be written as a placeholder that reads the same value; a text
 * that cannot (all of a list, a value of the run) is not stored at all until
 * one of the two is removed (valueFromPieces returns null). A text that
 * takes plain text only is always written as `{{ }}` text.
 */

/** One piece of a text field: typed text, a pick, or a legacy placeholder (`{{ … }}`, verbatim). */
export type SlotPiece = string | { part: PickPart } | { raw: string };

/** What a field stores. */
export type TextValue = string | ComposeBinding | PickBinding;

export interface ComposeSite {
    /** The executor renders a compose here. */
    compose: boolean;
    /** A `{{ }}` text here may be lifted to a compose. */
    lift: boolean;
    /** A value that is one value and nothing else is stored as a pick of it (fill_document values). */
    sole: boolean;
    /** What the text wants of a value in it (a list one per line, or with commas). */
    slot: Slot;
}

// The runtime's placeholder (legacy.mjs interpolateTemplate): at least one
// character inside, no `}`. The raw match is kept byte for byte.
const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Where a field sits in the sites table (`values.<key>` of a fill_document is the site `values`). */
export function composeSite(stepType?: string | null, field?: string | null): ComposeSite {
    const type = typeof stepType === 'string' ? stepType : '';
    const name = typeof field === 'string' ? field : '';
    const sites = type ? textSitesOf(type) : [];
    const head = name.split('.')[0];
    const site = sites.find(s => s.field === name) || sites.find(s => s.each && s.field === head) || null;
    const sole = type === 'fill_document' && head === 'values' && name !== 'values';
    const base = sole ? 'values' : name;
    const shaped = slotShape(null, { stepType: type, field: base });
    const slot: Slot = shaped.as === 'native' ? { as: 'text', multiLine: shaped.multiLine } : shaped;
    return { compose: !!site?.compose, lift: !!site?.compose && site.lift !== false, sole, slot };
}

/** The name a value goes by when nothing else names it: its last key ("replyText" → "Reply text"). */
export function partLabel(from: Partial<MappingSource> | null | undefined): string | undefined {
    const path = from && Array.isArray(from.path) ? from.path : [];
    for (let i = path.length - 1; i >= 0; i--) {
        const seg = path[i];
        if (typeof seg === 'string' && seg.trim()) return humanizeKey(seg) || undefined;
    }
    return undefined;
}

/** A pick or compose part as a compose part (no kind, no version). */
function asPart(p: PickPart | PickBinding): PickPart {
    const { from, take, as } = p;
    const part: PickPart = { from, take, as };
    if (p.join !== undefined) part.join = p.join;
    if (p.label !== undefined) part.label = p.label;
    if (p.required !== undefined) part.required = p.required;
    return part;
}

/** Text with `{{ }}` placeholders as pieces: text and raw placeholders. */
export function tokenizeText(text: string): SlotPiece[] {
    const out: SlotPiece[] = [];
    let last = 0;
    for (const m of text.matchAll(PLACEHOLDER_RE)) {
        const at = m.index ?? 0;
        if (at > last) out.push(text.slice(last, at));
        out.push({ raw: m[0] });
        last = at + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
}

/** A stored value as the pieces the editor shows. Never "[object Object]". */
export function piecesFromValue(value: unknown): SlotPiece[] {
    if (typeof value === 'string') return tokenizeText(value);
    if (isCompose(value)) return value.parts.map(p => (typeof p === 'string' ? p : { part: asPart(p) }));
    if (isPick(value)) return [{ part: asPart(value) }];
    // A legacy binding object where a text belongs (an old import): its text.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const b = value as { kind?: unknown; value?: unknown; path?: unknown };
        if ((b.kind === 'template' || b.kind === 'literal') && typeof b.value === 'string') return tokenizeText(b.value);
        if (b.kind === 'ref' && typeof b.path === 'string') return [{ raw: `{{${b.path}}}` }];
    }
    return [];
}

/**
 * A text field as one line of plain text for a summary (a canvas card, a
 * tooltip): a string as it is, a compose or pick with each value as its
 * name in ‹ ›. Never "[object Object]", and never a crash on `.trim()`.
 */
export function textForDisplay(value: unknown): string {
    if (typeof value === 'string') return value;
    return piecesFromValue(value).map((p) => {
        if (typeof p === 'string') return p;
        if ('raw' in p) return p.raw;
        return `‹${p.part.label || partLabel(p.part.from) || '…'}›`;
    }).join('');
}

/**
 * The grey example in an empty field as a person reads it: each `{{ }}` in
 * it as the name of the value in ‹ › ("Budget exceeded by ‹Delta›"), never
 * a path. The sites' examples are written as templates; this is the one
 * place they are worded for the screen.
 */
export function readablePlaceholder(text: string): string {
    return String(text || '').replace(PLACEHOLDER_RE, (_full: string, inner: string) => {
        const keys = inner.split(/[.[\]\s]+/).filter(k => k && k !== '*' && !/^\d+$/.test(k) && !/[^\w$-]/.test(k));
        const name = keys.length ? humanizeKey(keys[keys.length - 1]) : '';
        return `‹${name || '…'}›`;
    });
}

/** Pieces with their text re-read for placeholders typed by hand, adjacent text merged. */
export function normalizePieces(pieces: SlotPiece[]): SlotPiece[] {
    const out: SlotPiece[] = [];
    for (const piece of pieces) {
        for (const p of typeof piece === 'string' ? tokenizeText(piece) : [piece]) {
            if (p === '') continue;
            const prev = out[out.length - 1];
            if (typeof p === 'string' && typeof prev === 'string') out[out.length - 1] = prev + p;
            else out.push(p);
        }
    }
    return out;
}

/** What a legacy placeholder reads, for its pill. */
export type PlaceholderKind =
    | { kind: 'value'; from: MappingSource; take: 'one' | 'all' }
    | { kind: 'name'; name: string }
    | { kind: 'formula' };

/** The path inside a placeholder. */
export function placeholderPath(raw: string): string {
    return String(raw || '').replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '').trim();
}

/**
 * A legacy placeholder as a pill: a value from an earlier step (named like a
 * chip), a name (an AI step's `{{emails}}` reads its own input), or a
 * formula (anything else: shown, kept verbatim, never rewritten).
 */
export function classifyPlaceholder(raw: string): PlaceholderKind {
    const inner = placeholderPath(raw);
    const lifted = pickForLegacyPath(inner);
    if (lifted) return { kind: 'value', from: lifted.from, take: lifted.take };
    const from = sourceFromPath(inner);
    if (from) return { kind: 'value', from, take: /\[\s*\*\s*\]/.test(inner) ? 'all' : 'one' };
    if (NAME_RE.test(inner)) return { kind: 'name', name: inner };
    return { kind: 'formula' };
}

/** A placeholder as a compose part, labelled, or null when it does not lift. */
export function liftPlaceholder(raw: string, stepType?: string | null, field?: string | null): PickPart | null {
    const compose = templateToCompose(raw, { stepType: stepType || undefined, field: field || undefined });
    if (!compose || compose.kind !== 'compose' || compose.parts.length !== 1) return null;
    const [only] = compose.parts;
    if (typeof only === 'string') return null;
    const label = partLabel(only.from);
    return label ? { ...only, label } : only;
}

/**
 * A compose part as the `{{ }}` placeholder the legacy walk reads the SAME
 * value with, or null when there is none: all of a list (its Source no longer
 * says where the `[*]` went, and `items.name` reads nothing where
 * `items[*].name` read the names), a value of the run or the current item
 * (`trigger.x` and `item.x` read another place), or a path that does not
 * lift back to this very Source.
 */
export function legacyPlaceholderOf(part: PickPart): string | null {
    if (part.take !== 'one' || (part.as !== 'text' && part.as !== 'native')) return null;
    const path = describeSource(part.from);
    if (!path || !parseLegacyPath(path)) return null;
    const back = pickForLegacyPath(path);
    return back && back.take === 'one' && sameSource(back.from, part.from) ? `{{${path}}}` : null;
}

/** Pieces as `{{ }}` text: a pick as the placeholder of the path it reads (reads.mjs textAsTemplate). */
export function piecesAsTemplate(pieces: SlotPiece[]): string {
    return pieces.map((p) => {
        if (typeof p === 'string') return p;
        if ('raw' in p) return p.raw;
        return textAsTemplate({ kind: 'pick', v: MAPPING_VERSION, ...p.part });
    }).join('');
}

/**
 * Pieces as `{{ }}` text that reads every value the pieces read, or null when
 * a value in them has no such placeholder (legacyPlaceholderOf).
 */
export function piecesAsLegacyTemplate(pieces: SlotPiece[]): string | null {
    let out = '';
    for (const p of pieces) {
        if (typeof p === 'string') { out += p; continue; }
        if ('raw' in p) { out += p.raw; continue; }
        const raw = legacyPlaceholderOf(p.part);
        if (raw === null) return null;
        out += raw;
    }
    return out;
}

const BLANK_RE = /^\s*$/;

/**
 * A fill_document value that is one value as a pick of the value itself, so
 * a list stays a list there (template.mjs `sole`); null when it is a text.
 * Blank text around the value does not make it one: the run reads ` {{x}} `
 * as the value itself (execFillDocument SOLE_TOKEN_RE, template.mjs SOLE_RE),
 * and so is a pill with a space or a new line after it.
 */
function solePick(parts: Array<string | PickPart>): PickBinding | null {
    const core = parts.filter((p, i) => !(typeof p === 'string' && (i === 0 || i === parts.length - 1) && BLANK_RE.test(p)));
    const only = core.length === 1 ? core[0] : null;
    if (!only || typeof only === 'string') return null;
    const pick: PickBinding = { kind: 'pick', v: MAPPING_VERSION, ...only, as: only.as === 'text' ? 'native' : only.as };
    if (pick.as === 'native') delete pick.join;
    return pickProblems(pick).length ? null : pick;
}

export interface ValueContext {
    stepType?: string | null;
    field?: string | null;
    site: ComposeSite;
    /** The field held a compose or a pick before this edit: it stays one where the run takes it. */
    wasMapping?: boolean;
}

/**
 * The editor's pieces as the value the field stores (see the header). Only
 * ever called for an edit: the stored value is never rewritten on display.
 * Null when the pieces cannot be stored as they are: a placeholder that does
 * not lift next to a value no placeholder reads the same way. The caller
 * keeps the value it had and says why.
 */
export function valueFromPieces(pieces: SlotPiece[], { stepType, field, site, wasMapping = false }: ValueContext): TextValue | null {
    const norm = normalizePieces(pieces);
    if (!site.compose || !(site.lift || wasMapping)) return piecesAsTemplate(norm);
    // The text cannot be a compose: a template, but never one that reads a
    // value differently from the compose part it was (a list read as '').
    const asTemplate = () => piecesAsLegacyTemplate(norm);

    const parts: Array<string | PickPart> = [];
    for (const piece of norm) {
        if (typeof piece === 'string') { parts.push(piece); continue; }
        if ('part' in piece) { parts.push(piece.part); continue; }
        const lifted = liftPlaceholder(piece.raw, stepType, field);
        // One placeholder that does not lift keeps the whole text a template.
        if (!lifted) return asTemplate();
        parts.push(lifted);
    }
    if (parts.every(p => typeof p === 'string')) return parts.join('');

    const sole = site.sole ? solePick(parts) : null;
    if (sole) return sole;
    const compose: ComposeBinding = { kind: 'compose', v: MAPPING_VERSION, parts };
    return composeProblems(compose).length ? asTemplate() : compose;
}

/** Does a stored value hold a v2 mapping (a compose, or a sole pick)? */
export function isMappingValue(value: unknown): boolean {
    return isCompose(value) || isPick(value);
}

const resolver = createResolver({ evaluate, parse });

/** The shape a Source has in the sample, or 'unknown' without one. */
export function sourceShape(from: MappingSource, sample: object | null | undefined): Shape {
    if (!sample) return 'unknown';
    try { return shapeOf(walkSource(from, sample)); } catch { return 'unknown'; }
}

/** How many values a list holds in the sample, or null when it is not a list there. */
export function sourceCount(from: MappingSource, sample: object | null | undefined): number | null {
    if (!sample) return null;
    const shape = sourceShape(from, sample);
    if (shape !== 'list' && shape !== 'table') return null;
    const all = resolver.resolveValue({ kind: 'pick', v: MAPPING_VERSION, from, take: 'all', as: 'list' }, sample, { silent: true });
    return Array.isArray(all) ? all.length : null;
}

/** What the source panel (or the picker) hands a field: a legacy path, and the Source when it has one. */
export interface InsertRequest {
    path?: string | null;
    source?: MappingSource | null;
    /** The shape the panel saw, when it knows it better than the sample. */
    shape?: Shape | null;
    /** A value of the step's current item (source panel): the part takes `each`. */
    take?: 'each' | null;
}

/**
 * The compose part a picked value becomes in this field: its Source, how it
 * is used by default for this text (core defaultIntent: all of a list, one
 * per line in a multi-line text, with commas in a one-line one) and its
 * label. Null when the value names no Source.
 */
export function partForInsert(req: InsertRequest, slot: Slot, sample?: object | null): PickPart | null {
    const path = typeof req.path === 'string' ? req.path : null;
    const lifted = path ? pickForLegacyPath(path) : null;
    const given = req.source && !sourceProblems(req.source).length ? req.source : null;
    const from = given || lifted?.from || (path ? sourceFromPath(path) : null);
    if (!from) return null;
    // A value of the current item is shaped as one item holds it (the panel's shape), not as the whole list.
    let shape: Shape = req.shape || (req.take === 'each' ? 'unknown' : sourceShape(from, sample));
    // No sample to look at: a `[*]` in the path says it is a list.
    if ((shape === 'unknown' || shape === 'missing') && lifted?.take === 'all' && req.take !== 'each') shape = 'list';
    const { take, as, join }: PickIntent & { warning?: string } = defaultIntent(shape, slot);
    // A value of the current item: that one item's value, written into the text.
    const part: PickPart = { from, take: req.take === 'each' ? 'each' : take, as };
    if (join) part.join = join;
    const label = partLabel(from);
    if (label) part.label = label;
    return pickProblems(part, { part: true }).length ? null : part;
}

/** The placeholder a picked value becomes in a text that takes `{{ }}` text only. */
export function placeholderForInsert(req: InsertRequest): string | null {
    // `{{ }}` text has no way to read the current item: its path reads the whole list.
    if (req.take === 'each') return null;
    if (typeof req.path === 'string' && req.path.trim()) return `{{${req.path.trim()}}}`;
    const path = req.source ? describeSource(req.source) : '';
    return path ? `{{${path}}}` : null;
}

/** A part with a new use (PickOptions), its Source and label kept. */
export function withIntent(part: PickPart, intent: PickIntent): PickPart {
    const next: PickPart = { from: part.from, take: intent.take, as: intent.as };
    if (intent.join) next.join = intent.join;
    if (part.label !== undefined) next.label = part.label;
    if (part.required !== undefined) next.required = part.required;
    return next;
}

// ── The example under the field ──────────────────────────────────────────

export interface ListNote {
    /** The list as the run puts it in, clipped. */
    preview: string;
    /** The Edit data formula that joins it. */
    joinExpr: string;
}

export interface Example {
    text: string;
    /** The first list a template puts in as JSON (null for a compose: it renders lists readably). */
    list: ListNote | null;
}

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MARKDOWN_PREVIEW_ITEMS = 5;

/**
 * The Edit data Formula that turns this list into plain text. `join` writes
 * every element with String(), so a list of records would come out as
 * "[object Object], …": for records it joins one column instead, the first
 * one the example row has that a formula can name.
 */
function joinFormula(path: string, v: unknown[]): string {
    const first = v.find(x => x != null);
    if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
        const column = Object.keys(first as object).find(k => PLAIN_KEY.test(k)) || '<column>';
        return `join(${path}[*].${column}, ", ")`;
    }
    return `join(${path}, ", ")`;
}

/**
 * The bullet list interpolateTemplate's `listAsMarkdown` makes of a list of
 * plain values (same shape: a blank line first, one `- ` per value), clipped
 * for the example. Null for a list of records, which keeps its JSON there too.
 */
function markdownList(v: unknown[]): string | null {
    if (!v.length) return '';
    if (!v.every(x => x == null || ['string', 'number', 'boolean'].includes(typeof x))) return null;
    const shown = v.slice(0, MARKDOWN_PREVIEW_ITEMS).map(x => `- ${x == null ? '' : previewValue(String(x).trim(), 30)}`);
    if (v.length > MARKDOWN_PREVIEW_ITEMS) shown.push('- …');
    return `\n\n${shown.join('\n')}\n`;
}

/**
 * The sample as an ai_step's prompt sees it: the step's own inputs, resolved
 * on the sample, next to the run's roots by name (`{{toon}}`). The roots win,
 * as in the run (execAi.js aiPromptScope): an input cannot hide `trigger`.
 * The sample itself when there are no inputs.
 */
export function withNamedInputs(sample: object | null | undefined, inputs: unknown): object | null | undefined {
    if (!sample || !inputs || typeof inputs !== 'object' || !Object.keys(inputs).length) return sample;
    const named = resolver.resolveInputs(inputs, sample, { silent: true });
    const scope: Record<string, unknown> = { ...sample, ...named };
    for (const root of RUNTIME_ROOTS) {
        if (root in sample) scope[root] = (sample as Record<string, unknown>)[root];
        else delete scope[root];
    }
    return scope;
}

/**
 * The example of what the run makes of the field, on the sample. A compose
 * renders through the core, as the run does (a list one per line, a table
 * one row per line). A template shows exactly what the legacy rendering
 * gives: a list as JSON (or, where the run renders `listAsMarkdown`, a list
 * of plain values as bullets), and `list` carries the first list that went
 * in as JSON for the note under it. Null when there is nothing to fill in.
 */
export function exampleOf(value: unknown, sample: object | null | undefined, listAs: 'text' | 'json' | 'markdown' = 'text'): Example | null {
    if (isCompose(value) || isPick(value)) {
        if (!sample) return null;
        const text = isCompose(value)
            ? resolver.interpolateTemplate(value, sample)
            : String(resolver.resolveValue(value, sample, { silent: true }) ?? '');
        return { text, list: null };
    }
    if (typeof value !== 'string' || !value) return null;
    if (!/\{\{[^}]+\}\}/.test(value)) return null;
    if (!sample) return { text: value, list: null };
    let list: ListNote | null = null;
    const text = value.replace(PLACEHOLDER_RE, (full: string, expr: string) => {
        const path = expr.trim();
        const v = walkPath(path, sample);
        if (v === undefined) return full;
        if (Array.isArray(v)) {
            const bullets = listAs === 'markdown' ? markdownList(v) : null;
            if (bullets !== null) return bullets;
            let asText: string;
            try { asText = JSON.stringify(v); } catch { asText = String(v); }
            const clipped = asText.length > 60 ? `${asText.slice(0, 59)}…` : asText;
            if (!list) list = { preview: clipped, joinExpr: joinFormula(path, v) };
            return clipped;
        }
        return previewValue(v, 30);
    });
    return { text, list };
}
