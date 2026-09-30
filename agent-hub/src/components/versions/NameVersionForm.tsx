// "Name this version" and "Rename": one short field, Save and Cancel.
// Enter saves, Escape cancels. When renaming, an empty name clears it (the
// version goes back to its automatic label), which is said on the button.

import React, { useEffect, useRef, useState } from 'react';
import { VERSION_NAME_MAX } from '../../api/queries/versions';
import useTranslation from '../../hooks/useTranslation';

export interface NameVersionFormProps {
    /** The name to start from (renaming); empty for a new name. */
    initialName?: string | null;
    /** When renaming, an empty field clears the name; a new name must not be empty. */
    allowClear?: boolean;
    busy?: boolean;
    error?: string | null;
    onSubmit: (name: string | null) => void;
    onCancel: () => void;
    testId?: string;
}

/** What Save would do with this value: save a name, clear it, or nothing yet. */
function formState(value: string, initialName: string | null | undefined, allowClear: boolean, busy: boolean) {
    const trimmed = value.trim();
    const before = (initialName || '').trim();
    const clearing = allowClear && !trimmed && !!before;
    const canSave = !busy && (trimmed.length > 0 || clearing) && trimmed !== before;
    return { trimmed, clearing, canSave };
}

function Footer({ error, length, errorId }: { error?: string | null; length: number; errorId: string }) {
    return (
        <div className="flex items-start justify-between gap-2">
            {error
                ? <p id={errorId} role="alert" className="m-0 text-[11.5px] text-[var(--error-ink)]">{error}</p>
                : <span />}
            {length > VERSION_NAME_MAX * 0.8 && (
                <span className="text-[11px] tabular-nums text-[var(--text-tertiary)]">{length}/{VERSION_NAME_MAX}</span>
            )}
        </div>
    );
}

export default function NameVersionForm({ initialName, allowClear = false, busy = false, error, onSubmit, onCancel, testId = 'version-name-form' }: NameVersionFormProps) {
    const { t } = useTranslation();
    const [value, setValue] = useState(initialName || '');
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
    const { trimmed, clearing, canSave } = formState(value, initialName, allowClear, busy);

    const submit = (e?: React.FormEvent) => {
        e?.preventDefault();
        if (canSave) onSubmit(trimmed || null);
    };

    return (
        <form onSubmit={submit} className="space-y-1.5" data-testid={testId} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
            <label className="block text-[11.5px] font-medium text-[var(--text-secondary)]" htmlFor={`${testId}-input`}>
                {t('versions.name.label', 'Version name')}
            </label>
            <div className="flex items-center gap-1.5">
                <input
                    id={`${testId}-input`}
                    ref={input}
                    value={value}
                    maxLength={VERSION_NAME_MAX}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={t('versions.name.placeholder', 'For example: Sent to the board')}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${testId}-error` : undefined}
                    disabled={busy}
                    className="flex-1 min-w-0 h-8 px-2.5 rounded-lg text-[13px] border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]"
                />
                <button
                    type="submit"
                    disabled={!canSave}
                    className="h-8 px-3 rounded-[10px] text-xs font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] hover:bg-[var(--accent-primary-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid={`${testId}-save`}
                >
                    {clearing ? t('versions.name.clear', 'Remove name') : t('versions.name.save', 'Save')}
                </button>
                <button
                    type="button"
                    onClick={onCancel}
                    className="h-8 px-2.5 rounded-lg text-[12.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]"
                >
                    {t('versions.cancel', 'Cancel')}
                </button>
            </div>
            <Footer error={error} length={value.length} errorId={`${testId}-error`} />
        </form>
    );
}
