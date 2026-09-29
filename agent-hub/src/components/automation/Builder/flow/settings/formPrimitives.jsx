// §WS5 — shared form primitives extracted verbatim from SettingsForm.jsx
// (the "Chrome helpers" group). Used by SettingsForm and the per-type editors.
//
// The class strings themselves live in ./formStyles (pure, React-free) so that
// CollapsibleSection — which App Studio's inspector also renders — can share
// them without importing FieldHint. Everything is re-exported here so existing
// importers keep working unchanged.
import React from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import FieldHint from '../FieldHint';
import { humanizeIssueText } from '../displayHelpers';
import { useVariablePickerContext } from '../../mapping/VariablePickerContext';
import {
    fieldLabelClass, hintTextClass, optionalMarkClass, requiredChipClass,
} from './formStyles';

export {
    sectionHeaderClass, fieldLabelClass, subLabelClass, disclosureClass,
    bandClass, railClass, cardClass, requiredMarkClass, FOCUS_RING, FOCUS_RING_INSET,
    inputClass, textareaClass, denseInputClass, rowInputClass, controlSurfaceClass,
    hintTextClass, requiredChipClass, optionalMarkClass, actionButtonClass,
    listBadgeClass, AMBER_NOTE,
} from './formStyles';

/**
 * Labelled field row.
 *
 * `required` renders the word "Required" as a chip — an asterisk is
 * developer-form convention, not universal knowledge, and the ~12 fields the
 * validator actually blocks on used to look exactly as optional as "Max input
 * items". `optional` is the quiet counterpart for the rare field worth
 * reassuring about. Both render as SIBLINGS of the label span, never inside
 * it, so `getByText('URL')`-style queries keep matching the label alone.
 *
 * `htmlFor` upgrades the label span to a real <label>: clicking it focuses the
 * control and screen readers announce the association. Optional because most
 * existing rows wrap composite editors with no single focusable control.
 */
export function FormRow({ label, hint, required = false, optional = false, htmlFor = null, children }) {
    const LabelTag = htmlFor ? 'label' : 'span';
    return (
        <div>
            <div className="flex items-center gap-1.5 mb-1">
                <LabelTag htmlFor={htmlFor || undefined} className={fieldLabelClass()}>{label}</LabelTag>
                {required && <span className={requiredChipClass()}>Required</span>}
                {!required && optional && <span className={optionalMarkClass()}>optional</span>}
                <FieldHint title={label}>{hint}</FieldHint>
            </div>
            {children}
        </div>
    );
}

/**
 * One validation record. The machine code (`BF-1042`) used to open the
 * sentence — the least useful token in the message for the person reading it.
 * It now lives in the tooltip of a small marker dot, so support can still ask
 * for it, and the sentence starts with the words.
 *
 * The sentence itself gets the same treatment the canvas validation pill has
 * always given it: known step ids swapped for the names the author typed
 * (`humanizeIssueText`, flow/displayHelpers.js). Without that, one failure
 * spoke two languages — the pill said `Step "Is it urgent?": unknown type`,
 * the drawer said `Step cond_a3f91b: unknown type` — so an author who clicked
 * the pill BECAUSE it named their step landed here on a sentence about a hex
 * id and read it as a second, unrelated problem.
 *
 * The label map comes from the picker context the node drawer already
 * provides (NodeDetailView builds it with `buildStepLabelMap`, the same call
 * FloatingValidationPill makes) rather than from a second map of our own:
 * duplicating it is exactly how the two panes drifted apart. Outside that
 * provider the context default is an empty Map and the message is left
 * untouched, which is what it did before.
 *
 * And because humanising REWRITES the server's sentence, the sentence as it
 * was sent goes on the row's tooltip whenever a swap actually happened —
 * demoted, not dropped. Two validators word the id as something to copy
 * rather than as prose: `<type>.field_name_unbindable` spells out the path
 * that will not resolve (`steps.<id>.output.<key>`), and
 * `<type>.id_unbindable` exists ONLY to report that the id itself is illegal
 * (a hyphen reads as minus) — see server/automation/validate/fieldChecks.js.
 * Swapping the id for a quoted label inside those leaves `steps."Is it
 * urgent?".output.…`: a path that cannot be copied, reporting a token the
 * reader can no longer see. The words stay on screen for everyone; the
 * literal record is one hover away for whoever needs to act on it.
 */
export function ValidationLine({ record }) {
    const isErr = record.severity === 'error';
    const { stepLabelById } = useVariablePickerContext();
    const message = humanizeIssueText(record.message, stepLabelById);
    const hint = record.hint ? humanizeIssueText(record.hint, stepLabelById) : null;
    // Only when humanising changed something: otherwise the tooltip would
    // repeat the line it sits on, which is noise for a pointer and for a
    // screen reader alike.
    const swapped = message !== record.message || (!!record.hint && hint !== record.hint);
    const verbatim = swapped
        ? [record.message, record.hint && `→ ${record.hint}`].filter(Boolean).join('\n')
        : undefined;
    return (
        <div
            title={verbatim}
            className={`text-xs ${isErr ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'} mb-1`}
        >
            {record.code && (
                <span
                    title={record.code}
                    aria-label={`Code ${record.code}`}
                    className="inline-block w-1.5 h-1.5 rounded-full bg-current mr-1.5 align-middle opacity-70"
                />
            )}
            {message}
            {hint && <div className={`${hintTextClass()} mt-0.5`}>→ {hint}</div>}
        </div>
    );
}

/**
 * A short standing note inside a form section — replaces the hand-rolled
 * `text-amber-600 dark:text-amber-400` paragraphs that had drifted across the
 * step editors. `tone`:
 *   'info' — neutral explanation ("These run once per item, top to bottom.")
 *   'warn' — advisory ("A list here will probably fail when it runs.")
 */
export function SectionNote({ tone = 'info', children }) {
    const warn = tone === 'warn';
    const Icon = warn ? AlertTriangle : Info;
    return (
        <p className={`flex items-start gap-1.5 ${hintTextClass()} ${warn ? 'text-amber-600 dark:text-amber-400' : ''}`}>
            <Icon size={12} className="shrink-0 mt-0.5 opacity-80" aria-hidden="true" />
            <span className="min-w-0">{children}</span>
        </p>
    );
}

/** The consistent "nothing here yet" line for an empty section body. */
export function EmptySectionNote({ children }) {
    return <p className={`${hintTextClass()} italic text-[var(--text-tertiary)]`}>{children}</p>;
}
