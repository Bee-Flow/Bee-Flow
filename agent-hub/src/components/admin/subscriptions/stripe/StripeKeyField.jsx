import { Save, Trash2, CheckCircle } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { Button } from '../../../shared/Button';
import { Field } from '../ui/Input';

export function StripeKeyField({ label, type = 'password', placeholderConfigured, placeholderEmpty, configured, value, onChange, onSave, onClear, busy }) {
    const { t } = useTranslation();
    return (
        <Field
            label={
                <span className="inline-flex items-center gap-2">
                    {label}
                    {configured && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-emerald-400">
                            <CheckCircle className="w-3 h-3" /> {t('admin_subscriptions.stripe_key_saved', 'saved')}
                        </span>
                    )}
                </span>
            }
            className="mb-3"
        >
            <div className="flex items-center gap-2">
                <input
                    type={type}
                    value={value}
                    onChange={e => onChange(e.target.value)}
                    placeholder={configured ? placeholderConfigured : placeholderEmpty}
                    className="flex-1 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[12.5px] font-mono placeholder:text-[var(--text-muted)] outline-none focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20"
                />
                {value ? (
                    <Button icon={Save} onClick={onSave} busy={busy} size="md">{t('admin_subscriptions.stripe_key_save', 'Save')}</Button>
                ) : configured && onClear ? (
                    <Button icon={Trash2} variant="danger" onClick={onClear} busy={busy} size="md" />
                ) : null}
            </div>
        </Field>
    );
}
