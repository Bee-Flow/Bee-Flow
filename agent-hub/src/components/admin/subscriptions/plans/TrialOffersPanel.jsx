import { CalendarPlus, Building2, Users, Save } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { Button } from '../../../shared/Button';
import { toast } from '../../../shared/Toast';
import { apiJson } from '../hooks/useApi';
import { Card, CardHeader } from '../ui/Card';
import { Field, Select } from '../ui/Input';

export function TrialOffersPanel({ plans }) {
    const { t } = useTranslation();
    const [cfg, setCfg] = useState({ default_org_trial_plan_id: '', default_consumer_trial_plan_id: '' });
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const data = await apiJson('/api/subscriptions/trial-config');
                if (!alive) return;
                setCfg({
                    default_org_trial_plan_id:      data.default_org_trial_plan_id      || '',
                    default_consumer_trial_plan_id: data.default_consumer_trial_plan_id || '',
                });
            } catch (e) {
                console.warn('Failed to load trial config:', e);
            } finally {
                if (alive) setLoaded(true);
            }
        })();
        return () => { alive = false; };
    }, []);

    const eligible = (planType) => plans.filter(p =>
        (p.plan_type || 'organization') === planType
        && p.trial_days > 0
        && !!p.stripe_price_id
    );
    const orgOptions      = eligible('organization');
    const consumerOptions = eligible('consumer');

    const orgPlan      = plans.find(p => p.id === cfg.default_org_trial_plan_id);
    const consumerPlan = plans.find(p => p.id === cfg.default_consumer_trial_plan_id);

    const save = async () => {
        setBusy(true);
        try {
            await apiJson('/api/subscriptions/trial-config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cfg),
            });
            toast.success(t('admin_subscriptions.trial_saved', 'Trial offers saved.'));
        } catch (e) {
            toast.error(e.message || t('admin_subscriptions.trial_save_failed', 'Save failed'));
        } finally {
            setBusy(false);
        }
    };

    if (!loaded) return null;

    return (
        <Card className="!p-5 mb-6" accent="emerald">
            <CardHeader
                icon={CalendarPlus}
                iconClass="text-emerald-400"
                title={t('admin_subscriptions.trial_title', 'Trial offers')}
                subtitle={t('admin_subscriptions.trial_subtitle', 'Pick the plans that new organizations and personal accounts get as a free trial on signup. Trial length comes from the plan itself. Each org / user can only use a trial once.')}
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                <Field
                    label={
                        <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--text-secondary)]">
                            <Building2 className="w-3.5 h-3.5 text-sky-400" /> {t('admin_subscriptions.trial_org_label', 'Organization trial plan')}
                        </span>
                    }
                >
                    <Select
                        value={cfg.default_org_trial_plan_id}
                        onChange={e => setCfg(c => ({ ...c, default_org_trial_plan_id: e.target.value }))}
                    >
                        <option value="">{t('admin_subscriptions.trial_org_none', 'No auto-trial for new orgs')}</option>
                        {orgOptions.map(p => (
                            <option key={p.id} value={p.id}>{p.name} · {t('admin_subscriptions.trial_days', '{days}d trial', { days: p.trial_days })}</option>
                        ))}
                    </Select>
                    {orgPlan && (
                        <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                            {t('admin_subscriptions.trial_org_receive', 'New orgs receive a {days}-day trial of {name}.', { days: orgPlan.trial_days, name: orgPlan.name })}
                        </p>
                    )}
                    {orgOptions.length === 0 && (
                        <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                            {t('admin_subscriptions.trial_org_none_eligible', 'No org plans with trial_days > 0 and a Stripe price yet. Edit a plan to enable.')}
                        </p>
                    )}
                </Field>

                <Field
                    label={
                        <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--text-secondary)]">
                            <Users className="w-3.5 h-3.5 text-emerald-400" /> {t('admin_subscriptions.trial_consumer_label', 'Personal-account trial plan')}
                        </span>
                    }
                >
                    <Select
                        value={cfg.default_consumer_trial_plan_id}
                        onChange={e => setCfg(c => ({ ...c, default_consumer_trial_plan_id: e.target.value }))}
                    >
                        <option value="">{t('admin_subscriptions.trial_consumer_none', 'No auto-trial for new personal accounts')}</option>
                        {consumerOptions.map(p => (
                            <option key={p.id} value={p.id}>{p.name} · {t('admin_subscriptions.trial_days', '{days}d trial', { days: p.trial_days })}</option>
                        ))}
                    </Select>
                    {consumerPlan && (
                        <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                            {t('admin_subscriptions.trial_consumer_receive', 'New personal accounts receive a {days}-day trial of {name}.', { days: consumerPlan.trial_days, name: consumerPlan.name })}
                        </p>
                    )}
                    {consumerOptions.length === 0 && (
                        <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                            {t('admin_subscriptions.trial_consumer_none_eligible', 'No consumer plans with trial_days > 0 and a Stripe price yet.')}
                        </p>
                    )}
                </Field>
            </div>

            <Button onClick={save} busy={busy} icon={Save} variant="secondary">
                {busy ? t('admin_subscriptions.trial_saving', 'Saving…') : t('admin_subscriptions.trial_save', 'Save trial offers')}
            </Button>
        </Card>
    );
}
