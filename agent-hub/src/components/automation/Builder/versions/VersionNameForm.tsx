import { useState } from 'react';
import useTranslation from '../../../../hooks/useTranslation';

interface Props {
    initial: string;
    busy: boolean;
    error: string | null;
    onSave: (name: string | null) => void;
    onCancel: () => void;
}

/** Inline "Name it" form: a name makes the version a milestone; clearing it undoes that. */
export default function VersionNameForm({ initial, busy, error, onSave, onCancel }: Props) {
    const { t } = useTranslation();
    const [value, setValue] = useState(initial);
    const label = t('routines.versions.nameLabel', 'Milestone name');
    return (
        <form
            className="flex flex-wrap items-center gap-2 text-[12px]"
            onSubmit={(e) => { e.preventDefault(); onSave(value.trim() || null); }}
        >
            <input
                aria-label={label}
                placeholder={t('routines.versions.namePlaceholder', 'For example: Approval above 1,000')}
                value={value}
                maxLength={80}
                autoFocus
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
                className="flex-1 min-w-[200px] px-2.5 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
            />
            <button
                type="submit"
                disabled={busy}
                className="px-3 py-1.5 rounded-lg bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] font-semibold disabled:opacity-60"
            >
                {t('routines.versions.saveName', 'Save name')}
            </button>
            {initial && (
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => onSave(null)}
                    className="px-3 py-1.5 rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] disabled:opacity-60"
                >
                    {t('routines.versions.removeName', 'Remove milestone')}
                </button>
            )}
            <button type="button" onClick={onCancel} className="px-2 py-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                {t('common.cancel', 'Cancel')}
            </button>
            {error && <span role="alert" className="basis-full text-[var(--error)]">{error}</span>}
        </form>
    );
}
