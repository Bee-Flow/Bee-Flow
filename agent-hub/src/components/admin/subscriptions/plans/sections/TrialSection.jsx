import { CalendarPlus, AlertTriangle } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { LIMIT_FIELDS, CURRENCY_SYMBOL } from '../../constants';
import { Banner } from '../../ui/Banner';
import { Card } from '../../ui/Card';
import { Field, NumberInput } from '../../ui/Input';
import { StatGrid, StatRow } from '../../ui/StatRow';
import { Toggle } from '../../ui/Toggle';

export function TrialSection({ form, update }) {
    const { t } = useTranslation();
    const trialEnabled = (form.trial_days || 0) > 0;
    const meteredBlocked = form.billing_model === 'metered';

    return (
        <div className="space-y-5">
            <div>
                <h3 className="text-[15px] font-bold text-[var(--text-primary)] mb-1">{t('admin_subscriptions.trial_section_title', 'Trial')}</h3>
                <p className="text-[12px] text-[var(--text-muted)]">{t('admin_subscriptions.trial_section_desc', 'Offer a free trial period that converts to the paid plan when it ends.')}</p>
            </div>

            <Banner tone="teal" icon={CalendarPlus}>
                {t('admin_subscriptions.trial_section_banner', 'Trial of {name} inherits all limits and features from the paid plan: admin only sets how long it lasts. After the trial ends, the same plan continues as paid.', { name: form.name || t('admin_subscriptions.trial_section_this_plan', 'this plan') })}
            </Banner>

            {meteredBlocked && (
                <Banner tone="warning" icon={AlertTriangle}>
                    {t('admin_subscriptions.trial_section_metered', "Trials aren't available for pay-as-you-go plans: Stripe requires a payment method up front.")}
                </Banner>
            )}

            <Toggle
                checked={trialEnabled}
                disabled={meteredBlocked}
                onChange={checked => update('trial_days', checked ? (form.trial_days > 0 ? form.trial_days : 14) : 0)}
                icon={CalendarPlus}
                iconClass="text-emerald-400"
                label={t('admin_subscriptions.trial_section_offer', 'Offer a free trial for this plan')}
                description={meteredBlocked ? t('admin_subscriptions.trial_section_offer_blocked', 'Pay-as-you-go plans cannot offer a trial.') : t('admin_subscriptions.trial_section_offer_desc', 'Stripe will hold off charging until the trial period ends.')}
            />

            {trialEnabled && !meteredBlocked && (
                <>
                    <Field label={t('admin_subscriptions.trial_section_duration', 'Trial duration (days)')} hint={t('admin_subscriptions.trial_section_duration_hint', 'length of the free period before Stripe starts charging')}>
                        <NumberInput
                            value={form.trial_days}
                            onChange={v => update('trial_days', v == null ? 0 : Math.max(1, v))}
                            min={1}
                            max={365}
                            placeholder="14"
                        />
                    </Field>

                    <Card className="!p-4">
                        <div className="text-[12px] font-bold text-[var(--text-secondary)] mb-2">{t('admin_subscriptions.trial_section_limits', 'Limits during trial (inherited)')}</div>
                        <StatGrid>
                            {LIMIT_FIELDS.map(f => (
                                <StatRow
                                    key={f.key}
                                    label={f.label}
                                    value={form[f.key]}
                                    unit={f.type === 'currency' ? (CURRENCY_SYMBOL[form.currency] || '€') : ''}
                                />
                            ))}
                        </StatGrid>
                        <div className="mt-3 text-[11px] text-[var(--text-muted)]">
                            {t('admin_subscriptions.trial_section_change', 'To change these, jump to the Pricing section.')}
                        </div>
                    </Card>

                    <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                        {form.plan_type === 'consumer'
                            ? t('admin_subscriptions.trial_section_auto_consumer', 'To auto-grant this trial on every new personal account signup, pick this plan in the Trial offers panel on the Plans list. Each user can only use a trial once.')
                            : t('admin_subscriptions.trial_section_auto_org', 'To auto-grant this trial on every new organization signup, pick this plan in the Trial offers panel on the Plans list. Each org can only use a trial once.')}
                    </p>
                </>
            )}
        </div>
    );
}
