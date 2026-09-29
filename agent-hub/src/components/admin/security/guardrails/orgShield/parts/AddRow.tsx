import React, { useId, useState } from 'react';

/**
 * Input + Add button + inline error, with Enter as a first-class submit.
 *
 * Shared by the list editors because "type a value, press Enter, see why
 * it was refused" is the only thing they genuinely have in common. The lists
 * themselves differ (chips, sentences), and forcing those into one component
 * with a `variant` flag would be worse than a few small honest ones.
 *
 * `onAdd` returns an error string to refuse the value, or null/undefined to
 * accept it. Validation therefore lives with the list that knows the rules,
 * and this component never has to guess.
 */
export function AddRow({
    onAdd, placeholder, addLabel, disabled = false, mono = false,
}: {
    onAdd: (value: string) => string | null | undefined;
    /** Also the input's accessible name: the row has no visible label. */
    placeholder: string;
    addLabel: string;
    disabled?: boolean;
    mono?: boolean;
}) {
    const [value, setValue] = useState('');
    const [error, setError] = useState<string | null>(null);
    const errorId = useId();

    const submit = () => {
        const trimmed = value.trim();
        if (!trimmed) return;
        const err = onAdd(trimmed);
        if (err) { setError(err); return; }
        setValue('');
        setError(null);
    };

    return (
        <div>
            <div className="flex gap-2">
                <input
                    type="text"
                    value={value}
                    disabled={disabled}
                    aria-label={placeholder}
                    aria-invalid={error ? 'true' : undefined}
                    aria-describedby={error ? errorId : undefined}
                    onChange={e => { setValue(e.target.value); if (error) setError(null); }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
                    placeholder={placeholder}
                    className={'flex-1 min-w-0 h-[34px] px-2.5 rounded-[8px] border text-xs border-[var(--border-default)] bg-[var(--bg-card)] '
                        + 'text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] disabled:opacity-50 '
                        + (mono ? 'font-mono' : '')}
                />
                <button
                    type="button"
                    onClick={submit}
                    disabled={disabled || !value.trim()}
                    className="h-[34px] px-3 rounded-[8px] border text-xs font-semibold cursor-pointer border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                    {addLabel}
                </button>
            </div>
            {error && (
                <p id={errorId} role="alert" className="text-[11px] mt-1.5 mb-0 text-[var(--error-ink)]">
                    {error}
                </p>
            )}
        </div>
    );
}

export default AddRow;
