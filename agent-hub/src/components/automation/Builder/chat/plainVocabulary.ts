/**
 * The plain vocabulary of the automation builder's assistant column (design
 * point 8, F17): the table the panel reads the builder's own terms through,
 * and the helpers that name references, fields and steps in words.
 */
import { humanizeExpression, humanizeIssueText, humanizeTemplate } from '../flow/displayHelpers';
import { nodeTypeLabel } from '../flow/nodeDefs';
import { humanizeFieldKey } from '../mapping/core';
import { classifyRef, fieldTailLabel } from '../mapping/refTokens';
import type { Translator } from './toolCallDisplay';

interface Verb {
    key: string;
    en: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/* ── The plain vocabulary (design point 8) ─────────────────────────────────
 *
 * The builder's own words — trigger, binding, ref, dry run, proposal, apply,
 * finalize — are the runtime's, and they leaked into the panel: a proposal
 * listed `settings › to` changing from `trigger.output.sender` to
 * `steps.ai_9f3e.output.email`. Everything the person READS in the assistant
 * column goes through this table; the raw ids and paths stay one click away
 * behind a "details" disclosure for whoever needs them. Step types are named
 * by the palette's own label (nodeTypeLabel), never by their type key.
 */
const PLAIN_TERMS = {
    trigger: { key: 'handover.vocab.trigger', en: 'how it starts' },
    trigger_title: { key: 'handover.vocab.trigger_title', en: 'How it starts' },
    uses_from: { key: 'handover.vocab.uses_from', en: 'uses {field} from {source}' },
    uses_all_from: { key: 'handover.vocab.uses_all_from', en: 'uses what {source} gave' },
    field_from: { key: 'handover.vocab.field_from', en: '{field} from {source}' },
    each_item: { key: 'handover.vocab.each_item', en: 'each item' },
    each_named: { key: 'handover.vocab.each_named', en: 'each {item}' },
    a_step: { key: 'handover.vocab.a_step', en: 'an earlier step' },
    formula: { key: 'handover.vocab.formula', en: 'calculated: {text}' },
    dry_run: { key: 'handover.vocab.dry_run', en: 'test run' },
    proposal: { key: 'handover.vocab.proposal', en: 'preview' },
    apply: { key: 'handover.vocab.apply', en: 'make the change' },
    finalize: { key: 'handover.vocab.finalize', en: 'saved, not switched on yet' },
} as const satisfies Record<string, Verb>;

export type PlainTerm = keyof typeof PLAIN_TERMS;

/** One builder term in the person's words; `{x}` placeholders filled from `params`. */
export function plainTerm(term: PlainTerm, t: Translator | null = null, params?: Record<string, unknown>): string {
    const { key, en } = PLAIN_TERMS[term];
    if (t) return t(key, en, params);
    return en.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));
}

/** Step id → the label the canvas shows. */
export type StepLabels = Map<string, string>;

/**
 * The labels of a definition's trigger(s) and steps, by id: what the panel
 * says instead of an id. A step without a label is named by its type's
 * palette label; a trigger is "How it starts".
 */
export function stepLabelsOf(def: { trigger?: unknown; triggers?: unknown; steps?: unknown } | null | undefined, t: Translator | null = null): StepLabels {
    const out: StepLabels = new Map();
    const triggers = [def?.trigger, ...(Array.isArray(def?.triggers) ? def.triggers : [])];
    for (const node of [...triggers, ...(Array.isArray(def?.steps) ? def.steps : [])]) {
        if (!isPlainObject(node) || !str(node.id)) continue;
        const isTrigger = triggers.includes(node);
        out.set(node.id as string, str(node.label) || (isTrigger ? plainTerm('trigger_title', t) : (nodeTypeLabel(str(node.type), t) || plainTerm('a_step', t))));
    }
    return out;
}

/** Where a reference reads from, in words: a step's label, "how it starts", "each line". */
function sourceWords(ref: NonNullable<ReturnType<typeof classifyRef>>, labels: StepLabels | null, t: Translator | null) {
    if (ref.source === 'trigger') return plainTerm('trigger', t);
    if (ref.source === 'loop') return ref.itemVar ? plainTerm('each_named', t, { item: humanizeFieldKey(ref.itemVar).toLowerCase() }) : plainTerm('each_item', t);
    const label = ref.stepId ? labels?.get(ref.stepId) : null;
    return label ? `"${label}"` : plainTerm('a_step', t);
}

/** A binding as it is stored: `{ kind, path?, value? }`, or a bare value. */
interface BindingLike { kind?: string; path?: string; value?: unknown }

/**
 * A field's value in the person's words. A reference reads "uses Email from
 * "Read the form"", never `steps.read_1.output.email`; a template and a
 * formula name their references the same way; a fixed value is itself.
 * The raw binding belongs in the details, not here.
 */
export function describeBinding(binding: unknown, labels: StepLabels | null = null, t: Translator | null = null): string {
    if (binding === undefined || binding === null) return '—';
    if (typeof binding === 'string') return textWords(binding, labels);
    if (!isPlainObject(binding)) return JSON.stringify(binding);
    const b = binding as BindingLike;
    switch (b.kind) {
        case 'ref': return refWords(b.path, labels, t);
        case 'template': return textWords(String(b.value ?? ''), labels);
        case 'expr': return plainTerm('formula', t, { text: humanizeExpression(String(b.value ?? b.path ?? ''), labels) });
        default: return 'value' in b ? valueWords(b.value) : JSON.stringify(binding);
    }
}

/** Text with `{{…}}` references, each named the way its pill names it. */
function textWords(text: string, labels: StepLabels | null): string {
    return humanizeTemplate(text, labels) || text || '—';
}

/** A reference path as "uses <field> from <source>". */
function refWords(path: unknown, labels: StepLabels | null, t: Translator | null): string {
    const ref = classifyRef(path);
    if (!ref) return str(path) || '—';
    const source = sourceWords(ref, labels, t);
    const field = ref.fieldPath ? fieldTailLabel(ref.fieldPath) : '';
    return field ? plainTerm('uses_from', t, { field, source }) : plainTerm('uses_all_from', t, { source });
}

/** A fixed value as itself; nothing as a dash. */
function valueWords(v: unknown): string {
    if (v === undefined || v === null || v === '') return '—';
    return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * The name of a changed field: `['settings', 'to']` → "To",
 * `['input', 'from', 'emailAddress']` → "From › Email address". The first
 * segment (settings / input) is where the runtime keeps it, not a word for
 * the person.
 */
export function fieldPathLabel(path: readonly string[]): string {
    return path.slice(1).map((seg) => humanizeFieldKey(seg) || seg).join(' › ') || humanizeFieldKey(path[0]) || '';
}

/**
 * Text the server wrote for the model (a refusal, a fix hint) as the panel
 * shows it: known step ids become their labels and references read in
 * words. Unknown ids stay — there is no name to put in their place.
 */
export function plainText(text: string | null, labels: StepLabels | null, t: Translator | null = null): string | null {
    if (!text || !labels?.size) return text;
    // Only `steps.<id>.output…` is rewritten as a reference: the bare word
    // "trigger" is ordinary prose in these sentences.
    const refs = text.replace(/`?steps\.([A-Za-z0-9_-]+)\.output((?:\.[A-Za-z0-9_]+|\[[^\]]*\])*)`?/g, (whole, id: string, tail: string) => {
        const label = labels.get(id);
        if (!label) return whole;
        const field = tail ? fieldTailLabel(tail.replace(/^\./, '')) : '';
        return field ? plainTerm('field_from', t, { field, source: `"${label}"` }) : `"${label}"`;
    });
    return humanizeIssueText(refs, labels) || refs;
}
