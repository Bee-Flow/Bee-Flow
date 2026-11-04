import React, { useId, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { FORM_CSS_MAX, sanitizeFormCssClient } from '@/components/forms/formStyleVars';
import { FORM_CLASS_LIST } from './formClassList';
import { removedLabel } from './removedLabels';

/** A warning line naming what the sanitiser takes out. */
export function RemovedWarning({ removed, title, testId = 'form-style-css-removed' }: { removed: string[]; title: string; testId?: string }) {
    const { t } = useTranslation();
    if (!removed.length) return null;
    return (
        <div className="flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px] leading-snug border border-[var(--warning,#b45309)]/40 bg-[var(--warning,#b45309)]/10 text-[var(--text-primary)]" role="status" data-testid={testId}>
            <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[var(--warning,#b45309)]" aria-hidden="true" />
            <span>
                {title}{' '}
                {removed.map((r, i) => (
                    <React.Fragment key={r}>{i ? ', ' : ''}<code className="font-mono">{removedLabel(r, t)}</code></React.Fragment>
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
 * The custom CSS field: monospace, with a character count against the limit,
 * the class names as a cheat sheet, and a warning for whatever the sanitiser
 * would take out (the same rules the form runs before it applies anything).
 */
export default function CustomCssEditor({ value, onChange }: { value: string; onChange: (css: string) => void }) {
    const { t } = useTranslation();
    const id = useId();
    const [sheetOpen, setSheetOpen] = useState(false);
    const removed = useMemo(() => sanitizeFormCssClient(value).removed, [value]);
    return (
        <div className="space-y-1">
            <label htmlFor={`${id}-css`} className="block text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">{t('forms.style.custom_css', 'Custom CSS')}</label>
            <textarea
                id={`${id}-css`}
                rows={8}
                spellCheck={false}
                value={value}
                maxLength={FORM_CSS_MAX}
                placeholder=".bf-form__title { letter-spacing: 0.02em; }"
                aria-describedby={`${id}-css-hint`}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
                className="w-full px-2 py-1.5 rounded-md text-[11px] leading-snug font-mono border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)]"
            />
            <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--text-tertiary)]">
                <span id={`${id}-css-hint`}>{t('forms.style.custom_css_hint', 'Applies to this form only. Target the class names below.')}</span>
                <span className="shrink-0 tabular-nums" data-testid="form-style-css-count">
                    {t('forms.style.css_count', '{count} / {max}', { count: value.length.toLocaleString(), max: FORM_CSS_MAX.toLocaleString() })}
                </span>
            </div>
            <RemovedWarning removed={removed} title={t('forms.style.removed_title', 'Left out when the form is shown:')} />
            <button
                type="button"
                onClick={() => setSheetOpen(o => !o)}
                aria-expanded={sheetOpen}
                aria-controls={`${id}-sheet`}
                className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
                {sheetOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                {t('forms.style.cheat_sheet', 'Class names you can style')}
            </button>
            {sheetOpen ? <CheatSheet id={`${id}-sheet`} /> : null}
        </div>
    );
}
