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

import { translate } from '@/core/i18n';
import { describeDataPath, isDataPath, type StepLabelMap } from '@/features/flow-editor/bindings';
import { chipLabel, chipsIn, type TextChip } from '@/features/flow-editor/components/fields/bindingText';
import { describeRuleExpr, humanizeExpression, type Summary, type Translate } from '@/features/flow-editor/model';
import { humanizeFieldTail } from '@/features/flow-editor/model/displayHelpers';
import { pickLabel } from '@/features/flow-editor/valueSlot/pickLabel';
import { isCompose } from '@/shared/mapping';

const TOKEN_RE = /\{\{([^}]*)\}\}/g;

/** One reference, as a line of text names it: "‹gmail search ▸ Body›". */
export function refWords(chip: Pick<TextChip, 'name' | 'suffix'>): string {
    return `‹${chipLabel(chip)}›`;
}

const within = (c: TextChip, a: number, b: number) => c.start >= a && c.end <= b;

/**
 * A composed text (the v2 mapping: `{ kind: 'compose', parts }`) as a line of
 * text — its words, each value named between ‹ › the way its pill names it:
 * "Beste ‹Naam of klant›". Null for anything else.
 */
export function composeWords(value: unknown, labels: StepLabelMap = null): string | null {
    if (!isCompose(value)) return null;
    return value.parts
        .map((p) => (typeof p === 'string' ? p : `‹${pickLabel(translate, p, p.from.root === 'steps' ? labels?.get?.(p.from.id) ?? '' : '')}›`))
        .join('');
}

/**
 * The references in a text, named. Every `{{path}}` is one; a bare path is
 * one in an expression, or inside a `{{ … }}` that holds more than a path
 * (`{{ upper(steps.a.output.name) }}`). Everything else stays as written.
 */
export function readableText(text: unknown, labels: StepLabelMap = null, { expression = false }: { expression?: boolean } = {}): string {
    const words = composeWords(text, labels);
    if (words !== null) return words;
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

const WILDCARD = '[*]';

/**
 * A column path (one value from each row, `results[*].subject`) named:
 * "gmail search ▸ Subject (inside each row)", never an internal step id.
 */
function describeColumnPath(raw: string, labels: StepLabelMap, t: Translate | null): string {
    const at = raw.indexOf(WILDCARD);
    const step = describeDataPath(raw.slice(0, at), labels).name;
    const field = humanizeFieldTail(raw.slice(at + WILDCARD.length));
    return t ? t('routines.builder.column_path_label', '{step} ▸ {field} (inside each row)', { step, field }) : `${step} ▸ ${field} (inside each row)`;
}

/**
 * A path a step reads — the list a loop works through, the value a check
 * scans — named: "‹gmail search ▸ Results›", a column "‹gmail search ▸
 * Subject (inside each row)›". A trailing `[*]` is the list itself. Anything
 * that is not one path is read as an expression. '' when there is none.
 */
export function readablePath(path: unknown, labels: StepLabelMap = null, t: Translate | null = null): string {
    const raw = (typeof path === 'string' ? path : '').trim().replace(/(?:\[\*\])+$/, '');
    if (!raw) return '';
    if (!isDataPath(raw)) return readableText(raw, labels, { expression: true });
    return `‹${raw.includes(WILDCARD) ? describeColumnPath(raw, labels, t) : chipLabel(describeDataPath(raw, labels))}›`;
}

/**
 * A rule as a sentence ("Subject contains “isv”", the web's describeRuleExpr)
 * — and, where that sentence falls back to the expression itself, the
 * expression with its references named.
 */
export function readableRule(expr: unknown, labels: Map<string, string> | null = null): string {
    const src = (typeof expr === 'string' ? expr : '').trim();
    if (!src) return '';
    const sentence = describeRuleExpr(src, labels);
    return sentence === humanizeExpression(src, labels) ? readableText(src, labels, { expression: true }) : sentence;
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
