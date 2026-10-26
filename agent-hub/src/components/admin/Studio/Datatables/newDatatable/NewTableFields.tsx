import React from 'react';
import type { ReactNode } from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import { INPUT, INPUT_STYLE } from './constants';

interface NewTableFieldsProps {
    linking: boolean;
    managed: boolean;
    mode: string;
    name: string;
    setName: (name: string) => void;
    effectiveKey: string;
    setKey: (key: string) => void;
    setKeyTouched: (touched: boolean) => void;
    description: string;
    setDescription: (description: string) => void;
    firstColumns: ReactNode;
    t: TranslateFn;
}

export default function NewTableFields({ linking, managed, mode, name, setName, effectiveKey, setKey, setKeyTouched, description, setDescription, firstColumns, t }: NewTableFieldsProps) {
    return (
        <>
            {!linking && (
            <label className="block">
                <span className="block text-sm font-medium mb-1.5 text-[var(--text-primary)]">
                    {t('datatables.field_name', 'Name')}
                </span>
                <input
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('studio_misc.newtable.name_placeholder', 'Customers')}
                    className={INPUT}
                    style={INPUT_STYLE}
                />
            </label>
            )}

            {!linking && mode === 'advanced' && (
                <label className="block">
                    <span className="block text-sm font-medium mb-1.5 text-[var(--text-primary)]">
                        {t('datatables.field_key', 'Technical name')}
                    </span>
                    <input
                        value={effectiveKey}
                        onChange={(e) => { setKeyTouched(true); setKey(e.target.value); }}
                        placeholder={t('studio_misc.newtable.key_placeholder', 'customers')}
                        className={`${INPUT} font-mono`}
                        style={INPUT_STYLE}
                    />
                    <span className="block text-[11px] mt-1 text-[var(--text-tertiary)]">
                        {t('datatables.field_key_help', 'Lowercase letters, numbers and underscores. Renaming it later means moving the data, so it is worth a moment now.')}
                    </span>
                </label>
            )}

            {!linking && (
            <label className="block">
                <span className="block text-sm font-medium mb-1.5 text-[var(--text-primary)]">
                    {t('datatables.field_purpose', 'What is it for?')}
                </span>
                <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                    placeholder={t('studio_misc.newtable.purpose_placeholder', 'Customers we have already sent the onboarding e-mail to.')}
                    className={INPUT}
                    style={INPUT_STYLE}
                />
                <span className="block text-[11px] mt-1 text-[var(--text-tertiary)]">
                    {managed
                        ? t('datatables.field_purpose_managed', 'Optional here — left empty, this kind of table brings its own sentence for the processing record.')
                        : t('datatables.field_purpose_help', 'Required — this sentence goes into your organisation’s processing record.')}
                </span>
            </label>
            )}

            {!managed && !linking && firstColumns}
        </>
    );
}
