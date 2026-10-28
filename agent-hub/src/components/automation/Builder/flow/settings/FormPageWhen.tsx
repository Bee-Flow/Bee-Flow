import { useState, type ComponentType } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import type { OnFocusField } from '../../mapping/focusField.types';
import ConditionBuilder from '../../mapping/ConditionBuilder';
import { hintTextClass, subLabelClass } from './formPrimitives';

interface Props {
    /** The stored condition ('' = always show the page). */
    when: string;
    onChange: (next: string) => void;
    onFocusField?: OnFocusField | null;
    previewSample?: unknown;
}

// The builder is a JavaScript component whose props TypeScript infers from its defaults.
const Builder = ConditionBuilder;

/**
 * "Only show this page when…": a condition on what the automation knows when
 * it reaches the page (the form's earlier answers, an earlier step's result).
 * When it is not met the page is skipped: nobody sees it, the run goes
 * straight on, and the page's answers stay empty. Opt-in and collapsed, since
 * most pages are always shown.
 */
export default function FormPageWhen({ when, onChange, onFocusField = null, previewSample = null }: Props) {
    const { t } = useTranslation();
    // Once open it stays open until "Always show it": emptying the value box
    // makes the stored condition '' for a moment, and that must not close the builder.
    const [opened, setOpened] = useState(!!when);
    if (!when && !opened) {
        return (
            <button
                type="button"
                onClick={() => setOpened(true)}
                className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline underline-offset-2 transition"
            >
                + {t('automations.form_wizard.page_when_add', 'Only show this page when…')}
            </button>
        );
    }
    return (
        <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
                <span className={subLabelClass()}>{t('automations.form_wizard.page_when_label', 'Only show this page when')}</span>
                <button
                    type="button"
                    onClick={() => { setOpened(false); onChange(''); }}
                    className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline underline-offset-2 transition"
                >
                    {t('automations.form_wizard.page_when_clear', 'Always show it')}
                </button>
            </div>
            <Builder
                value={when}
                onChange={onChange}
                onFocusField={onFocusField}
                previewSample={previewSample}
                context="condition"
                showSerialized={false}
            />
            <p className={hintTextClass()}>
                {t('automations.form_wizard.page_when_hint', 'Checked when the automation reaches this page. When it is not met, the page is skipped and its answers stay empty.')}
            </p>
        </div>
    );
}
