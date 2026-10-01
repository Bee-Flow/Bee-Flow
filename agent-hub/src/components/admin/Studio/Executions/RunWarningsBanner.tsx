import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';

interface RunWithWarnings { warnings?: unknown }

/**
 * One warning as the run row stores it (server runWarnings.js), the shape of
 * the run's outcome. `params` hold paths, labels, input names, step ids and
 * counts, never a value from the run; `text` is the server's English.
 */
export interface RunWarning {
    code: string;
    params: Record<string, string | number>;
    text: string;
}

/** The warnings the run row carries (automation-run-warnings-2026-10). */
export function runWarnings(run: RunWithWarnings | null | undefined): RunWarning[] {
    const list = run && Array.isArray(run.warnings) ? run.warnings : [];
    const out: RunWarning[] = [];
    for (const w of list) {
        if (!w || typeof w !== 'object' || Array.isArray(w)) continue;
        const { code, params, text } = w as Partial<RunWarning>;
        if (typeof code !== 'string' || !code) continue;
        out.push({
            code,
            params: params && typeof params === 'object' && !Array.isArray(params) ? params : {},
            text: typeof text === 'string' ? text : '',
        });
    }
    return out;
}

type Params = Record<string, string | number>;
type Words = (t: TranslateFn, p: Params) => string;

const AS_WORDS: Record<string, string> = { number: 'number', date: 'date', yesno: 'yes or no' };

/** What a pick warning names: the label the author gave it, else its path. */
function nameOf(t: TranslateFn, p: Params): string {
    if (p.label) return `"${p.label}"`;
    return p.path ? String(p.path) : t('mapping.run_warning.a_value', 'a mapped value');
}

/** A pick warning, worded with its name and whatever else it carries. */
function pick(code: string, english: string): Words {
    return (t, p) => t(`mapping.run_warning.${code}`, english, { ...p, name: nameOf(t, p) });
}

/**
 * One phrasing per code. A code this build does not know shows the server's
 * English (`text`), as runOutcome.ts does for an outcome.
 */
const BY_CODE: Record<string, Words> = {
    template_missing: (t, p) => t('mapping.run_warning.template_missing', '{placeholder} resolved to nothing', { placeholder: `{{${p.path ?? ''}}}` }),
    ref_missing: (t, p) => t('mapping.run_warning.ref_missing', '{path} resolved to nothing', { path: p.path || '(empty path)' }),
    expr_missing: (t, p) => t('mapping.run_warning.expr_missing', 'expression "{expr}" resolved to nothing', p),
    expr_error: (t, p) => t('mapping.run_warning.expr_error', 'expression "{expr}" failed: {message}', p),
    mapping_invalid: (t, p) => (p.path
        ? t('mapping.run_warning.mapping_invalid_at', 'a {kind} binding on {path} is not valid and gave no value', p)
        : t('mapping.run_warning.mapping_invalid', 'a {kind} binding is not valid and gave no value', p)),
    pick_missing: pick('pick_missing', '{name} was empty'),
    pick_missing_required: pick('pick_missing_required', '{name} was empty, and the step needs it'),
    pick_many_for_one: pick('pick_many_for_one', '{name} held {count} values; only the first was used'),
    pick_holes_dropped: pick('pick_holes_dropped', '{name}: {count} item(s) without this field were left out'),
    pick_parse_failed: (t, p) => {
        const as = String(p.as ?? '');
        const word = AS_WORDS[as] ? t(`mapping.run_warning.as_${as}`, AS_WORDS[as]) : as;
        return t('mapping.run_warning.pick_parse_failed', '{name} could not be read as a {as}', { ...p, name: nameOf(t, p), as: word });
    },
    pick_each_outside_repeat: pick('pick_each_outside_repeat', '{name} reads the current item, but this step does not repeat over that list'),
    branch_no_edge: (t, p) => t('mapping.run_warning.branch_no_edge', '{stepType} {step} routed to "{branch}" but no edge carries that branch — downstream steps did not run', p),
    branch_replayed_unrecorded: (t, p) => t('mapping.run_warning.branch_replayed_unrecorded', '{stepType} {step} was replayed without a recorded branch — nothing downstream of it ran', p),
    guard_unwired: (t, p) => t('mapping.run_warning.guard_unwired', 'guard {step} found personal data but nothing is wired to its "personal data" branch — no alert was sent', p),
    app_effect_ignored: (t, p) => t('mapping.run_warning.app_effect_ignored', 'return_to_app {step}: ignored "{field}" — {reason}', p),
    more: (t, p) => t('mapping.run_warning.more', '…and {count} more warning(s)', p),
};

// The codes a binding leaves: prefixed with the input they were on, when known.
const ON_INPUT = new Set([
    'ref_missing', 'expr_missing', 'expr_error', 'mapping_invalid', 'pick_missing', 'pick_missing_required',
    'pick_many_for_one', 'pick_holes_dropped', 'pick_parse_failed', 'pick_each_outside_repeat',
]);

/** One warning in the viewer's language; the server's English for a code this build does not know. */
export function runWarningText(t: TranslateFn, w: RunWarning): string {
    const words = BY_CODE[w.code];
    if (!words) return w.text || w.code;
    const warning = words(t, w.params);
    const input = w.params.input;
    if (!ON_INPUT.has(w.code) || input === undefined || input === '') return warning;
    return t('mapping.run_warning.on_input', 'input "{input}": {warning}', { input, warning });
}

/**
 * What a run noticed about the values it was given, under its bar: "this run
 * finished with 2 warning(s)", and the sentences one click away. A run used
 * to collect these (an empty field, a list that went into a field for one
 * value, a branch with no edge) and drop them, so a green run with an empty
 * e-mail address said nothing at all.
 */
export default function RunWarningsBanner({ run }: { run: RunWithWarnings | null }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const list = runWarnings(run);
    if (!list.length) return null;

    return (
        <div
            className="flex-shrink-0 border-b border-[var(--border-default)] text-xs bg-[color-mix(in_srgb,var(--warning)_6%,transparent)]"
            data-testid="run-warnings-banner"
        >
            <div className="flex items-start gap-2 px-4 py-2">
                <AlertTriangle size={14} aria-hidden className="shrink-0 mt-px text-[var(--warning-ink)]" />
                <span className="min-w-0 flex-1 text-[var(--warning-ink)]">
                    {t('mapping.run_warnings_title', 'This run finished with {n} warning(s)', { n: list.length })}
                </span>
                <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpen(v => !v)}
                    className="shrink-0 text-[var(--text-tertiary)] underline hover:text-[var(--text-primary)]"
                >
                    {open ? t('mapping.run_warnings_hide', 'Hide') : t('mapping.run_warnings_show', 'Show')}
                </button>
            </div>
            {open && (
                <div className="px-4 pb-2">
                    <p className="mb-1 text-[var(--text-secondary)]">
                        {t('mapping.run_warnings_hint', 'The run carried on. A field may have been empty, or held something other than you expected.')}
                    </p>
                    <ul className="list-disc pl-5 space-y-0.5 text-[var(--text-secondary)] max-h-40 overflow-auto custom-scrollbar">
                        {list.map((w, i) => <li key={i} className="break-words">{runWarningText(t, w)}</li>)}
                    </ul>
                </div>
            )}
        </div>
    );
}
