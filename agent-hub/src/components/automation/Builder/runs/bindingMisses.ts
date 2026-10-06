/**
 * The mappings that found nothing while a step ran, as the run views show
 * them: the run-step row's `bindingWarnings` (the runner's binding log,
 * stored by server/stores/automationStore/bindingWarnings.js) turned into one
 * line per input, "To · Read the purchasing inbox ▸ Contact ▸ E-mail · nothing
 * there".
 *
 * Never the path syntax on the line itself: the source field is named the way
 * the editor's chips name it (listPathLabel), and the exact path plus the
 * server's own sentence stay one click away for whoever needs them.
 */
import { isValidPath } from '@shared/expr/path.mjs';
import { humanizeFieldKey } from '../flow/displayHelpers';
import { listPathLabel } from '../mapping/listPathLabel';
import type { TranslateFn } from '../../../../hooks/useTranslation';

export type BindingMissReason = 'missing' | 'not_run' | 'syntax' | 'error';
export type BindingMissKind = 'ref' | 'template' | 'expr';

/** One input whose mapping found nothing (or could not be read). */
export interface BindingWarning {
    /** The input it was for, nested inputs dotted ('values.Datum'); null when unknown. */
    field: string | null;
    kind: BindingMissKind | null;
    /** The path it read, or a formula's text. */
    path: string;
    reason: BindingMissReason;
    /** How many times it missed in this step (a loop over items misses per item). */
    count: number;
    /** The server's sentence for it. Absent on a row stored before it was added. */
    description: string | null;
    /** A formula's own error message. */
    message: string | null;
}

const REASONS = new Set<string>(['missing', 'not_run', 'syntax', 'error']);
const KINDS = new Set<string>(['ref', 'template', 'expr']);

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Keeps well-formed entries; the server sends null when nothing was missed. */
export function bindingWarningsOf(value: unknown): BindingWarning[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((e): BindingWarning[] => {
        const o = e && typeof e === 'object' ? e as Record<string, unknown> : null;
        const path = o ? str(o.path) : null;
        if (!o || !path) return [];
        const count = typeof o.count === 'number' && Number.isInteger(o.count) && o.count > 0 ? o.count : 1;
        return [{
            field: str(o.field),
            kind: typeof o.kind === 'string' && KINDS.has(o.kind) ? o.kind as BindingMissKind : null,
            path,
            reason: typeof o.reason === 'string' && REASONS.has(o.reason) ? o.reason as BindingMissReason : 'missing',
            count,
            description: str(o.description),
            message: str(o.message),
        }];
    });
}

/**
 * The list off a run-step row of any shape: the Runs tab's typed record and
 * the builder's loose one both carry it as `bindingWarnings`.
 */
export function stepBindingWarnings(step: unknown): BindingWarning[] {
    return step && typeof step === 'object' ? bindingWarningsOf((step as { bindingWarnings?: unknown }).bindingWarnings) : [];
}

/** One warning as the run views print it. */
export interface BindingWarningLine {
    /** "To", "Values ▸ Datum", or "A mapping". */
    input: string;
    /** "Read the purchasing inbox ▸ Contact ▸ E-mail", or "A formula". */
    source: string;
    /** Why, in a few plain words. */
    why: string;
    count: number;
    /** The server's sentence (or the formula's message): shown on hover and on open. */
    detail: string;
    /** The path or formula exactly as written. */
    raw: string;
}

function whyText(t: TranslateFn, w: BindingWarning): string {
    switch (w.reason) {
        case 'not_run': return t('automations.output.binding_why_not_run', 'that step did not run');
        case 'syntax': return w.kind === 'expr'
            ? t('automations.output.binding_why_bad_formula', 'not a valid formula')
            : t('automations.output.binding_why_bad_path', 'not a valid path');
        case 'error': return t('automations.output.binding_why_error', 'the formula failed');
        default: return t('automations.output.binding_why_missing', 'nothing there');
    }
}

function inputText(t: TranslateFn, field: string | null): string {
    const parts = (field || '').split('.').map(humanizeFieldKey).filter(Boolean);
    return parts.length ? parts.join(' ▸ ') : t('automations.output.binding_any_input', 'A mapping');
}

function sourceText(t: TranslateFn, w: BindingWarning, labelById: Map<string, string> | null): string {
    // A formula's text is not a field: name it as one and keep the text for
    // the detail. A path that does not parse has no friendlier reading than
    // itself.
    if (w.kind === 'expr' && !isValidPath(w.path)) return t('automations.output.binding_formula', 'A formula');
    if (!isValidPath(w.path)) return w.path;
    return listPathLabel(w.path, labelById, t);
}

export function bindingWarningLine(t: TranslateFn, w: BindingWarning, labelById: Map<string, string> | null = null): BindingWarningLine {
    return {
        input: inputText(t, w.field),
        source: sourceText(t, w, labelById),
        why: whyText(t, w),
        count: w.count,
        detail: w.description || w.message || w.path,
        raw: w.path,
    };
}
