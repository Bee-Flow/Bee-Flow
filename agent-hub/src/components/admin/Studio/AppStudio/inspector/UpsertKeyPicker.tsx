import useTranslation from '@/hooks/useTranslation';

interface UpsertKeyPickerProps {
    /** The columns the step writes (the mapping's targets and the constants). */
    columns: { key: string; name?: string }[];
    value: string[] | undefined;
    onChange: (next: string[] | undefined) => void;
    disabled?: boolean;
}

/** At most this many key columns (server LIMITS.MAX_UPSERT_KEY_COLUMNS). */
const MAX_KEY_COLUMNS = 5;

/**
 * writeTo.upsertKey: the columns that together identify a row. A row with the same values in
 * these columns is updated instead of added, so running the step twice does not double the table.
 * No column checked = always insert (the key is removed).
 */
export default function UpsertKeyPicker({ columns, value, onChange, disabled }: UpsertKeyPickerProps) {
    const { t } = useTranslation();
    const picked = Array.isArray(value) ? value : [];
    const toggle = (key: string, on: boolean) => {
        const next = on ? [...picked.filter((k) => k !== key), key] : picked.filter((k) => k !== key);
        onChange(next.length ? next.slice(0, MAX_KEY_COLUMNS) : undefined);
    };
    if (!columns.length) return null;
    return (
        <fieldset className="flex flex-col gap-1" disabled={disabled}>
            <legend className="text-xs font-medium text-[var(--text-secondary)]">
                {t('studio_apps_insp.ai_actions.upsert_key', 'Update rows with the same key')}
            </legend>
            <p className="text-xs text-[var(--text-tertiary)]">
                {t('studio_apps_insp.ai_actions.upsert_key_hint', 'Pick the columns that identify a row. Running the step again updates those rows instead of adding new ones.')}
            </p>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
                {columns.map((c) => {
                    const on = picked.includes(c.key);
                    return (
                        <label key={c.key} className="flex items-center gap-1 text-xs text-[var(--text-primary)]">
                            <input
                                type="checkbox"
                                checked={on}
                                disabled={disabled || (!on && picked.length >= MAX_KEY_COLUMNS)}
                                onChange={(e) => toggle(c.key, e.target.checked)}
                            />
                            {c.name || c.key}
                        </label>
                    );
                })}
            </div>
        </fieldset>
    );
}
