import { CalendarPlus, CheckCircle, Clock, Gift } from 'lucide-react';
import React, { useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { Button } from '../../../shared/Button';
import { toast } from '../../../shared/Toast';
import { Banner } from '../ui/Banner';
import { Field, Select } from '../ui/Input';
import { Modal } from '../ui/Modal';

export function QuickAssignDialog({ org, plans, onClose, onSave, onStartTrial }) {
    const { t } = useTranslation();
    const [planId, setPlanId]     = useState(plans.find(p => p.is_default)?.id || '');
    const [status, setStatus]     = useState('active');
    const [trialBusy, setTrialBusy] = useState(false);
    const [busy, setBusy]         = useState(false);

    const selectedPlan = plans.find(p => p.id === planId);
    const trialEligible = !org.trial_used_at
        && selectedPlan
        && selectedPlan.trial_days > 0
        && !!selectedPlan.stripe_price_id;

    // The seeded €0 "Free" org plan — enables a one-click no-payment assign.
    const freePlan = plans.find(p =>
        (p.plan_type === 'organization' || !p.plan_type)
        && (p.name === 'Free' || Number(p.price) === 0)
    );

    const assignFree = async () => {
        if (!freePlan) return;
        setBusy(true);
        try {
            await onSave({ plan_id: freePlan.id, status: 'active' });
            toast.success(t('admin_subscriptions.quick_assign_free_done', 'Free plan assigned.'));
        } catch (e) {
            toast.error(e.message || t('admin_subscriptions.quick_assign_failed', 'Assign failed'));
        } finally {
            setBusy(false);
        }
    };

    const startTrial = async () => {
        if (!selectedPlan) return;
        setTrialBusy(true);
        try {
            await onStartTrial(selectedPlan.id);
            toast.success(t('admin_subscriptions.quick_assign_trial_started', 'Trial started.'));
        } catch (e) {
            toast.error(e.message || t('admin_subscriptions.quick_assign_trial_failed', 'Failed to start trial'));
        } finally {
            setTrialBusy(false);
        }
    };

    const handleAssign = async () => {
        setBusy(true);
        try {
            await onSave({ plan_id: planId || null, status });
            toast.success(t('admin_subscriptions.quick_assign_done', 'Subscription assigned.'));
        } catch (e) {
            toast.error(e.message || t('admin_subscriptions.quick_assign_failed', 'Assign failed'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            open
            onClose={busy || trialBusy ? undefined : onClose}
            title={t('admin_subscriptions.quick_assign_title', 'Assign subscription')}
            subtitle={<>{t('admin_subscriptions.quick_assign_for', 'for')} <strong className="text-[var(--text-primary)]">{org.name}</strong></>}
            width="max-w-md"
            footer={
                <>
                    <Button variant="ghost" onClick={onClose} disabled={busy || trialBusy}>{t('admin_subscriptions.quick_assign_cancel', 'Cancel')}</Button>
                    {freePlan && planId !== freePlan.id && (
                        <Button variant="secondary" icon={Gift} onClick={assignFree} busy={busy}>
                            {t('admin_subscriptions.quick_assign_free', 'Assign Free plan')}
                        </Button>
                    )}
                    {trialEligible && (
                        <Button variant="secondary" icon={CalendarPlus} onClick={startTrial} busy={trialBusy}>
                            {trialBusy ? t('admin_subscriptions.quick_assign_trial_starting', 'Starting…') : t('admin_subscriptions.quick_assign_trial_start', 'Start trial')}
                        </Button>
                    )}
                    <Button variant="primary" icon={CheckCircle} onClick={handleAssign} busy={busy}>
                        {busy ? t('admin_subscriptions.quick_assign_assigning', 'Assigning…') : t('admin_subscriptions.quick_assign_assign', 'Assign')}
                    </Button>
                </>
            }
        >
            <div className="space-y-3">
                <Field label={t('admin_subscriptions.quick_assign_plan', 'Plan')}>
                    <Select value={planId} onChange={e => setPlanId(e.target.value)}>
                        <option value="">{t('admin_subscriptions.quick_assign_no_plan', 'No plan (custom limits)')}</option>
                        {plans.map(p => (
                            <option key={p.id} value={p.id}>
                                {p.name}{p.is_default ? ' ★' : ''}{p.trial_days > 0 ? ` · ${t('admin_subscriptions.quick_assign_trial_days', '{days}d trial', { days: p.trial_days })}` : ''}
                            </option>
                        ))}
                    </Select>
                </Field>
                <Field label={t('admin_subscriptions.quick_assign_status', 'Status')}>
                    <Select value={status} onChange={e => setStatus(e.target.value)}>
                        <option value="active">{t('admin_subscriptions.quick_assign_active', 'Active')}</option>
                        <option value="suspended">{t('admin_subscriptions.quick_assign_suspended', 'Suspended')}</option>
                    </Select>
                </Field>

                {trialEligible && (
                    <Banner tone="teal" icon={CalendarPlus} title={t('admin_subscriptions.quick_assign_trial_available', '{days}-day Stripe trial available', { days: selectedPlan.trial_days })}>
                        {t('admin_subscriptions.quick_assign_trial_hint', 'One-time per organization. Use “Start trial” to activate via Stripe instead of a direct assign.')}
                    </Banner>
                )}
                {org.trial_used_at && (
                    <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                        <Clock className="w-3.5 h-3.5" /> {t('admin_subscriptions.quick_assign_trial_used', 'Trial used on {date}', { date: new Date(org.trial_used_at).toLocaleDateString() })}
                    </div>
                )}
            </div>
        </Modal>
    );
}
