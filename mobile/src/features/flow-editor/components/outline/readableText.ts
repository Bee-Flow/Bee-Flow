/**
 * References as a person reads them, in the plain lines the editor shows
 * around its fields: a card's summary, the loop box's header, an empty
 * field's example. A field draws a reference as a pill (fields/PillTextInput);
 * a line of plain text names the same thing, with the same words, between
 * ‹ ›, so `Summarise {{steps.act_4d4307a.output.body}}` reads
 * "Summarise ‹gmail search ▸ Body›".
 *
 * Display only, and applied at display time: the ported summaries
 * (model/nodeSummaries, displayHelpers) stay the web's, and nothing here is
 * ever stored.
 */

import { describeDataPath, describeListPath, isDataPath, type StepLabelMap } from '@/features/flow-editor/bindings';
import { listPathLabel } from '@/features/flow-editor/bindings/listPathLabel';
import { chipLabel, chipsIn, type TextChip } from '@/features/flow-editor/components/fields/bindingText';
import { describeRuleExpr, type Summary, type Translate } from '@/features/flow-editor/model';

const TOKEN_RE = /\{\{([^}]*)\}\}/g;

/** One reference, as a line of text names it: "‹gmail search ▸ Body›". */
export function refWords(chip: Pick<TextChip, 'name' | 'suffix'>): string {
    return `‹${chipLabel(chip)}›`;
}

const within = (c: TextChip, a: number, b: number) => c.start >= a && c.end <= b;

/**
 * The references in a text, named. Every `{{path}}` is one; a bare path is
 * one in an expression, or inside a `{{ … }}` that holds more than a path
 * (`{{ upper(steps.a.output.name) }}`). Everything else stays as written.
 */
export function readableText(text: unknown, labels: StepLabelMap = null, { expression = false }: { expression?: boolean } = {}): string {
    const src = typeof text === 'string' ? text : '';
    if (!src) return '';
    const wrapped = chipsIn(src, false, labels);
    const tokens = [...src.matchAll(TOKEN_RE)].map((m) => [m.index as number, (m.index as number) + m[0].length] as const);
    const bare = chipsIn(src, true, labels).filter(
        (c) => !wrapped.some((w) => within(c, w.start, w.end)) && (expression || tokens.some(([a, b]) => within(c, a, b))),
    );
    const chips = [...wrapped, ...bare].sort((a, b) => a.start - b.start);
    let out = '';
    let last = 0;
    for (const c of chips) {
        out += src.slice(last, c.start) + refWords(c);
        last = c.end;
    }
    return out + src.slice(last);
}

/**
 * A path a step reads — the list a loop works through, the value a check
 * scans — named: "‹gmail search ▸ Results›", a column "‹gmail search ▸
 * Subject (inside each row)›". A trailing `[*]` is the list itself. Anything
 * that is not one path is read as an expression. '' when there is none.
 *
 * A Condition's own outputs read the way the web's listPathLabel names them,
 * never by their internal keys: `matchesByCase.pdf` as "‹Split ▸ pdf›", its
 * `default` as "Otherwise", and what a list Condition keeps (`items`, when
 * `stepTypeById` says the step is one) as the Condition itself. `compact` is
 * the canvas card's form of a list inside each row ("‹Read many ▸ Attachments›").
 */
export function readablePath(path: unknown, labels: StepLabelMap = null, t: Translate | null = null, opts: ReadablePathOptions = {}): string {
    const raw = (typeof path === 'string' ? path : '').trim().replace(/(?:\[\*\])+$/, '');
    if (!raw) return '';
    if (!isDataPath(raw)) return readableText(raw, labels, { expression: true });
    if (opts.compact || isRouteOutput(raw, opts.stepTypeById ?? null)) {
        return `‹${listPathLabel(raw, labels, t as ListLabelT, { compact: !!opts.compact, stepTypeById: opts.stepTypeById ?? null })}›`;
    }
    return `‹${raw.includes('[*]') ? describeListPath(raw, labels, t) : chipLabel(describeDataPath(raw, labels))}›`;
}

export interface ReadablePathOptions {
    compact?: boolean;
    stepTypeById?: Map<string, string> | null;
}

/** listPathLabel's own translate type: the app's `t` with looser params. */
type ListLabelT = Parameters<typeof listPathLabel>[2];

const ROUTE_TYPES = new Set(['filter', 'switch']);

/** `steps.<id>.output.matchesByCase…`, or `steps.<id>.output.items…` of a Condition: a key the author never named. */
function isRouteOutput(path: string, stepTypeById: Map<string, string> | null): boolean {
    const m = /^steps\.([^.[]+)\.output\.(matchesByCase|items)(?=$|[.[])/.exec(path);
    if (!m) return false;
    return m[2] === 'matchesByCase' || ROUTE_TYPES.has(stepTypeById?.get(m[1] ?? '') ?? '');
}

/**
 * A rule as a sentence ("Subject contains “isv”", the web's describeRuleExpr)
 * — and, for a formula the rule rows cannot show, "Custom rule": a card never
 * shows code (C1, D6).
 */
export function readableRule(expr: unknown, labels: Map<string, string> | null = null, t: Translate | null = null): string {
    const src = (typeof expr === 'string' ? expr : '').trim();
    return src ? describeRuleExpr(src, labels, t) : '';
}

/** A card line with its references named; the muted "not yet" words are left as they are. */
export function readableSummary(summary: Summary, labels: StepLabelMap = null): Summary {
    return typeof summary === 'string' ? readableText(summary, labels) : summary;
}

/**
 * An empty field's example in the words its pill would use, so the example
 * teaches what the field will look like rather than the syntax under it:
 * `Offerte {{trigger.output.bedrijf}}` reads "Offerte ‹Trigger ▸ Bedrijf›",
 * `steps.step1.output.amount > 1000` "‹Previous step ▸ Amount› > 1000".
 */
export function readableExample(example: string, expression?: boolean): string;
export function readableExample(example: string | undefined, expression?: boolean): string | undefined;
export function readableExample(example: string | undefined, expression = false): string | undefined {
    return example === undefined ? undefined : readableText(example, null, { expression });
}
