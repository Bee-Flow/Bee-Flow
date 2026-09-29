import { X } from 'lucide-react';
import React, { useId } from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import AddRow from '../../parts/AddRow';
import { helpClass, labelClass } from './fieldStyles';

/**
 * A list of short values as chips, with an add field. Used for a type's
 * words and for its examples. Refusals are said inline by AddRow, so a
 * duplicate or an over-long value is never silently dropped.
 */
export function ChipList({
    label, help, values, onChange, max, maxLen, placeholder, caseSensitive = false, mono = false, disabled = false, t,
}: {
    label: string;
    help?: React.ReactNode;
    values: string[];
    onChange: (next: string[]) => void;
    max: number;
    maxLen: number;
    placeholder: string;
    caseSensitive?: boolean;
    mono?: boolean;
    disabled?: boolean;
    t: TranslateFn;
}) {
    const labelId = useId();
    const same = (a: string, b: string) => (caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase());

    const add = (value: string): string | null => {
        if (value.length > maxLen) return t('shield_data.chip_too_long', 'Keep it under {n} characters.', { n: maxLen });
        if (values.some(v => same(v, value))) return t('shield_data.chip_duplicate', 'That is already on the list.');
        if (values.length >= max) return t('shield_data.chip_full', 'The list is full ({n}).', { n: max });
        onChange([...values, value]);
        return null;
    };

    return (
        <div role="group" aria-labelledby={labelId}>
            <p id={labelId} className={labelClass}>{label}</p>
            {values.length > 0 && (
                <ul className="flex flex-wrap gap-1.5 list-none p-0 m-0 mb-2">
                    {values.map(v => (
                        <li
                            key={v}
                            className={`inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] ${mono ? 'font-mono' : ''}`}
                        >
                            {v}
                            <button
                                type="button"
                                disabled={disabled}
                                onClick={() => onChange(values.filter(x => x !== v))}
                                aria-label={t('shield_data.chip_remove', 'Remove {value}', { value: v })}
                                className="p-0.5 rounded-full hover:bg-[var(--bg-card-hover)] text-[var(--text-tertiary)]"
                            >
                                <X className="w-3 h-3" aria-hidden="true" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <AddRow onAdd={add} placeholder={placeholder} addLabel={t('shield_data.chip_add', 'Add')} disabled={disabled} mono={mono} />
            {help && <p className={helpClass}>{help}</p>}
        </div>
    );
}

export default ChipList;
