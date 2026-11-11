import React, { useId, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { FORM_CSS_MAX, sanitizeFormCssClient } from '@/components/forms/formStyleVars';
import { FORM_CLASS_LIST } from './formClassList';
import { removedLabel } from './removedLabels';

type Tr = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

/** A warning line naming what the sanitiser takes out. `labelOf` words a label; the form's own wording by default. */
export function RemovedWarning({ removed, title, testId = 'form-style-css-removed', labelOf = removedLabel }: { removed: string[]; title: string; testId?: string; labelOf?: (label: string, t: Tr) => string }) {
    const { t } = useTranslation();
    if (!removed.length) return null;
    return (
        <div className="flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px] leading-snug border border-[var(--warning,#b45309)]/40 bg-[var(--warning,#b45309)]/10 text-[var(--text-primary)]" role="status" data-testid={testId}>
            <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[var(--warning,#b45309)]" aria-hidden="true" />
            <span>
                {title}{' '}
                {removed.map((r, i) => (
                    <React.Fragment key={r}>{i ? ', ' : ''}<code className="font-mono">{labelOf(r, t)}</code></React.Fragment>
                ))}
            </span>
        </div>
    );
}

/** The class names, one line each, for the author writing CSS by hand. */
function CheatSheet({ id }: { id: string }) {
    const { t } = useTranslation();
    return (
        <dl id={id} className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[10px] leading-snug" data-testid="form-style-cheat-sheet">
            {FORM_CLASS_LIST.map(entry => (
                <React.Fragment key={entry.name}>
                    <dt className="font-mono text-[var(--text-primary)]">.{entry.name}</dt>
                    <dd className="text-[var(--text-secondary)]">{t(entry.key, entry.fallback)}</dd>
                </React.Fragment>
            ))}
        </dl>
    );
}

/**
 * What another surface that reuses the field (an app's stylesheet) says and checks instead of
 * the form's own: its sanitiser and limit, its texts, and its own list of what can be styled.
 * Everything left out is the form's.
 */
export interface CustomCssEditorVariant {
    sanitize?: (css: string) => { removed: string[] };
    max?: number;
    placeholder?: string;
    label?: string;
    hint?: string;
    removedTitle?: string;
    labelOf?: (label: string, t: Tr) => string;
    sheetTitle?: string;
    /** Shown in place of the form's class names when the list is opened. */
    sheet?: React.ReactNode;
    disabled?: boolean;
}

/** What the field checks with and says: the variant's, and the form's own for whatever it leaves out. */
function resolveVariant(variant: CustomCssEditorVariant | undefined, t: Tr) {
    return {
        sanitize: variant?.sanitize ?? sanitizeFormCssClient,
        max: variant?.max ?? FORM_CSS_MAX,
        texts: {
            label: variant?.label ?? t('forms.style.custom_css', 'Custom CSS'),
            placeholder: variant?.placeholder ?? '.bf-form__title { letter-spacing: 0.02em; }',
            hint: variant?.hint ?? t('forms.style.custom_css_hint', 'Applies to this form only. Target the class names below.'),
            removedTitle: variant?.removedTitle ?? t('forms.style.removed_title', 'Left out when the form is shown:'),
            sheetTitle: variant?.sheetTitle ?? t('forms.style.cheat_sheet', 'Class names you can style'),
        },
    };
}

/** The opened list: the variant's own, else the form's class names. */
function Sheet({ id, own }: { id: string; own?: React.ReactNode }) {
    return own ? <div id={id}>{own}</div> : <CheatSheet id={id} />;
}

/**
 * The custom CSS field: monospace, with a character count against the limit,
 * the class names as a cheat sheet, and a warning for whatever the sanitiser
 * would take out (the same rules the form runs before it applies anything).
 */
export default function CustomCssEditor({ value, onChange, variant }: { value: string; onChange: (css: string) => void; variant?: CustomCssEditorVariant }) {
    const { t } = useTranslation();
    const id = useId();
    const [sheetOpen, setSheetOpen] = useState(false);
    const { sanitize, max, texts } = resolveVariant(variant, t);
    const removed = useMemo(() => sanitize(value).removed, [sanitize, value]);
    return (
        <div className="space-y-1">
            <label htmlFor={`${id}-css`} className="block text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">{texts.label}</label>
            <textarea
                id={`${id}-css`}
                rows={8}
                spellCheck={false}
                value={value}
                maxLength={max}
                disabled={variant?.disabled}
                placeholder={texts.placeholder}
                aria-describedby={`${id}-css-hint`}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
                className="w-full px-2 py-1.5 rounded-md text-[11px] leading-snug font-mono border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)]"
            />
            <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--text-tertiary)]">
                <span id={`${id}-css-hint`}>{texts.hint}</span>
                <span className="shrink-0 tabular-nums" data-testid="form-style-css-count">
                    {t('forms.style.css_count', '{count} / {max}', { count: value.length.toLocaleString(), max: max.toLocaleString() })}
                </span>
            </div>
            <RemovedWarning removed={removed} title={texts.removedTitle} labelOf={variant?.labelOf} />
            <button
                type="button"
                onClick={() => setSheetOpen(o => !o)}
                aria-expanded={sheetOpen}
                aria-controls={`${id}-sheet`}
                className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
                {sheetOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                {texts.sheetTitle}
            </button>
            {sheetOpen ? <Sheet id={`${id}-sheet`} own={variant?.sheet} /> : null}
        </div>
    );
}
