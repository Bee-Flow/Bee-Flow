import { ArrowLeft, Tag, Percent, Euro, Save } from 'lucide-react';
import React, { useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { Button } from '../../../shared/Button';
import { toast } from '../../../shared/Toast';
import { apiJson } from '../hooks/useApi';
import { Banner } from '../ui/Banner';
import { ChoiceCards } from '../ui/Choice';
import { IconButton } from '../ui/IconButton';
import { Field, Input, Select, NumberInput } from '../ui/Input';
import { Toggle } from '../ui/Toggle';

export function PromoEditor({ onBack, onCreated }) {
    const { t } = useTranslation();
    const [form, setForm] = useState({
        code: '', discountType: 'percent', discountValue: '', currency: 'EUR',
        duration: 'once', durationMonths: 3, maxRedemptions: '', expiresAt: '',
        firstTimeOnly: false, minAmount: '', name: '',
    });
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const update = (key, val) => setForm(f => ({ ...f, [key]: val }));

    const handleCreate = async () => {
        setError('');
        if (!form.code.trim()) { setError(t('admin_subscriptions.promos_code_required', 'Promo code is required')); return; }
        if (!form.discountValue || parseFloat(form.discountValue) <= 0) {
            setError(t('admin_subscriptions.promos_value_required', 'Discount value is required')); return;
        }
        setSaving(true);
        try {
            const body = {
                code: form.code.trim(),
                discountType: form.discountType,
                discountValue: form.discountType === 'percent'
                    ? parseFloat(form.discountValue)
                    : Math.round(parseFloat(form.discountValue) * 100),
                currency: form.currency,
                duration: form.duration,
                durationMonths: form.duration === 'repeating' ? parseInt(form.durationMonths) || 3 : undefined,
                maxRedemptions: form.maxRedemptions ? parseInt(form.maxRedemptions) : undefined,
                expiresAt: form.expiresAt || undefined,
                firstTimeOnly: form.firstTimeOnly,
                minAmount: form.minAmount ? Math.round(parseFloat(form.minAmount) * 100) : undefined,
                name: form.name || undefined,
            };
            await apiJson('/api/stripe/promo-codes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            toast.success(t('admin_subscriptions.promos_created', 'Promo code created.'));
            onCreated();
        } catch (e) {
            setError(e.message || t('admin_subscriptions.promos_create_failed', 'Failed to create'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="absolute inset-0 flex flex-col bg-[var(--bg-primary)]">
            <header className="shrink-0 flex items-center gap-3 px-6 py-3 border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
                <IconButton icon={ArrowLeft} size="sm" onClick={onBack} title={t('admin_subscriptions.promos_back', 'Back to promo codes')} />
                <div className="min-w-0">
                    <div className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] font-semibold">{t('admin_subscriptions.promos_new', 'New promotion code')}</div>
                    <h1 className="text-[16px] font-bold text-[var(--text-primary)] truncate">
                        {form.code || t('admin_subscriptions.promos_untitled', 'Untitled code')}
                    </h1>
                </div>
            </header>

            <div className="flex-1 overflow-y-auto">
                <div className="max-w-xl mx-auto px-6 py-6 pb-32 space-y-5">
                    {error && <Banner tone="danger">{error}</Banner>}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                        <Field label={t('admin_subscriptions.promos_code_label', 'Promo code *')}>
                            <Input
                                value={form.code}
                                onChange={e => update('code', e.target.value.toUpperCase().replace(/\s+/g, ''))}
                                placeholder={t('admin_subscriptions.promos_code_placeholder', 'e.g. LAUNCH20')}
                                className="font-mono font-bold tracking-widest"
                                autoFocus
                            />
                        </Field>
                        <Field label={t('admin_subscriptions.promos_internal_name', 'Internal name')} hint={t('admin_subscriptions.promos_internal_name_hint', 'for your team, not shown to customers')}>
                            <Input
                                value={form.name}
                                onChange={e => update('name', e.target.value)}
                                placeholder={t('admin_subscriptions.promos_internal_name_placeholder', 'e.g. Launch campaign 2026')}
                            />
                        </Field>
                    </div>

                    <Field label={t('admin_subscriptions.promos_discount_type', 'Discount type')}>
                        <ChoiceCards
                            value={form.discountType}
                            onChange={v => update('discountType', v)}
                            options={[
                                { value: 'percent', label: t('admin_subscriptions.promos_percentage', 'Percentage'), description: t('admin_subscriptions.promos_percentage_desc', '% off the price'), icon: Percent, accent: 'blue' },
                                { value: 'fixed',   label: t('admin_subscriptions.promos_fixed', 'Fixed amount'), description: t('admin_subscriptions.promos_fixed_desc', 'currency off'), icon: Euro,    accent: 'emerald' },
                            ]}
                        />
                    </Field>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                        <Field label={form.discountType === 'percent' ? t('admin_subscriptions.promos_percent_off_label', 'Percentage off (1-100)') : t('admin_subscriptions.promos_amount_off_label', 'Amount off ({currency})', { currency: form.currency })}>
                            <Input
                                type="number"
                                min="0"
                                max={form.discountType === 'percent' ? 100 : undefined}
                                step={form.discountType === 'percent' ? 1 : 0.01}
                                value={form.discountValue}
                                onChange={e => update('discountValue', e.target.value)}
                                placeholder={form.discountType === 'percent' ? '20' : '5.00'}
                            />
                        </Field>
                        {form.discountType === 'fixed' && (
                            <Field label={t('admin_subscriptions.promos_currency', 'Currency')}>
                                <Select value={form.currency} onChange={e => update('currency', e.target.value)}>
                                    <option value="EUR">{t('admin_subscriptions.promos_eur', 'EUR (€)')}</option>
                                    <option value="USD">{t('admin_subscriptions.promos_usd', 'USD ($)')}</option>
                                    <option value="GBP">{t('admin_subscriptions.promos_gbp', 'GBP (£)')}</option>
                                </Select>
                            </Field>
                        )}
                        <Field label={t('admin_subscriptions.promos_duration', 'Duration')}>
                            <Select value={form.duration} onChange={e => update('duration', e.target.value)}>
                                <option value="once">{t('admin_subscriptions.promos_duration_once', 'Once (first invoice)')}</option>
                                <option value="repeating">{t('admin_subscriptions.promos_duration_repeating', 'Repeating (N months)')}</option>
                                <option value="forever">{t('admin_subscriptions.promos_duration_forever', 'Forever')}</option>
                            </Select>
                        </Field>
                        {form.duration === 'repeating' && (
                            <Field label={t('admin_subscriptions.promos_duration_months', 'Duration (months)')}>
                                <NumberInput
                                    value={form.durationMonths}
                                    onChange={v => update('durationMonths', v || 3)}
                                    min={1}
                                    max={36}
                                />
                            </Field>
                        )}
                        <Field label={t('admin_subscriptions.promos_max_redemptions', 'Max redemptions')} hint={t('admin_subscriptions.promos_max_redemptions_hint', 'leave empty for unlimited')}>
                            <Input
                                type="number"
                                min="1"
                                value={form.maxRedemptions}
                                onChange={e => update('maxRedemptions', e.target.value)}
                                placeholder={t('admin_subscriptions.promos_unlimited', 'Unlimited')}
                            />
                        </Field>
                        <Field label={t('admin_subscriptions.promos_expires_at', 'Expires at')}>
                            <Input
                                type="datetime-local"
                                value={form.expiresAt}
                                onChange={e => update('expiresAt', e.target.value)}
                            />
                        </Field>
                    </div>

                    <Toggle
                        checked={form.firstTimeOnly}
                        onChange={v => update('firstTimeOnly', v)}
                        label={t('admin_subscriptions.promos_first_time', 'First-time customers only')}
                        description={t('admin_subscriptions.promos_first_time_desc', 'Restrict this code to customers who haven\'t subscribed before.')}
                    />
                </div>
            </div>

            <footer className="shrink-0 border-t border-[var(--border-default)] bg-[var(--bg-secondary)] px-6 py-3 flex items-center justify-end gap-2">
                <Button variant="ghost" onClick={onBack}>{t('admin_subscriptions.promos_cancel', 'Cancel')}</Button>
                <Button variant="success" icon={Save} onClick={handleCreate} busy={saving}>
                    {saving ? t('admin_subscriptions.promos_creating', 'Creating…') : t('admin_subscriptions.promos_create', 'Create code')}
                </Button>
            </footer>
        </div>
    );
}
