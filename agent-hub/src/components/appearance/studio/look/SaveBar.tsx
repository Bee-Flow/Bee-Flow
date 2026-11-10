import { Check, Save, Loader2, AlertCircle } from 'lucide-react';
import React from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { PRIMARY_BTN } from '@/components/mcpLibrary/ui';

/**
 * SaveBar — sticky bottom action bar for the Look editor. Status pill on the
 * left, Discard + Reload + Save on the right.
 *
 * Stays opaque even when the editor is rendering under Glass via `data-surface
 * ="opaque"` so it's always legible.
 */
interface Props {
    dirty: boolean;
    saving: boolean;
    error: string;
    onSave: () => void;
    onDiscard: () => void;
    onReload: () => void;
}

export default function SaveBar({
    dirty,
    saving,
    error,
    onSave,
    onDiscard,
    onReload,
}: Props) {
    const { t } = useTranslation();
    return (
        <div
            data-surface="opaque"
            className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t border-[var(--border-default)] bg-[var(--bg-card)] px-6 py-3"
        >
            <StatusPill dirty={dirty} saving={saving} error={error} />
            <div className="ml-auto flex items-center gap-2">
                <button
                    type="button"
                    onClick={onDiscard}
                    disabled={!dirty || saving}
                    className="px-3 py-2 rounded-lg text-sm font-medium border transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-40 border-[var(--border-default)] text-[var(--text-secondary)]"
                >
                    {t('appearance.save_bar_discard', 'Discard')}
                </button>
                <button
                    type="button"
                    onClick={onReload}
                    disabled={saving}
                    className="px-3 py-2 rounded-lg text-sm font-medium border transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-40 border-[var(--border-default)] text-[var(--text-secondary)]"
                    title={t('appearance.save_bar_re_fetch_the_saved_theme_from_the', 'Re-fetch the saved theme from the server')}
                >
                    {t('appearance.save_bar_reload', 'Reload')}
                </button>
                <button
                    type="button"
                    onClick={onSave}
                    disabled={saving || !dirty}
                    className={PRIMARY_BTN}
                >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    {saving ? 'Saving…' : 'Save as server default'}
                </button>
            </div>
        </div>
    );
}

function StatusPill({ dirty, saving, error }: Pick<Props, 'dirty' | 'saving' | 'error'>) {
    const { t } = useTranslation();
    if (error) {
        return (
            <span
                className="text-xs inline-flex items-center gap-1.5 text-[var(--error-ink)]"
            >
                <AlertCircle className="w-3.5 h-3.5" /> {error}
            </span>
        );
    }
    if (saving) {
        return (
            <span
                className="text-xs inline-flex items-center gap-1.5 text-[var(--text-tertiary)]"
            >
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t('appearance.save_bar_saving', 'Saving…')}
            </span>
        );
    }
    if (dirty) {
        return (
            <span
                className="text-xs inline-flex items-center gap-1.5 text-[var(--warning-ink)]"
            >
                <span
                    className="w-1.5 h-1.5 rounded-full bg-[var(--warning)]"
                />
                {t('appearance.save_bar_unsaved_changes', 'Unsaved changes')}
            </span>
        );
    }
    return (
        <span
            className="text-xs inline-flex items-center gap-1.5 text-[var(--text-tertiary)]"
        >
            <Check className="w-3.5 h-3.5 text-[var(--success)]" /> {t('appearance.save_bar_all_changes_saved', 'All changes saved')}
        </span>
    );
}
