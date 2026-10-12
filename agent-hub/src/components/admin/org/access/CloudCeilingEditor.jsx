import { Loader2, Check, AlertTriangle, Crown, Pencil, Info } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import CeilingReadOnly from './CeilingReadOnly';
import { useTranslation } from '../../../../hooks/useTranslation';
import { useEntitlements } from '../../../licensing/EntitlementsContext';
import { useResource, apiJson } from '../../subscriptions/hooks/useApi';
import { PlanEditor } from '../../subscriptions/plans/PlanEditor';

/**
 * CloudCeilingEditor — the cloud-mode ceiling. On cloud the ceiling for an org
 * is its subscription plan, so a super-admin (a) assigns which plan the org is
 * on and (b) edits that plan's allow-lists (beta / integrations / features)
 * in place via the existing PlanEditor. Reuses the subscriptions endpoints.
 *
 * Editing a plan changes the ceiling for EVERY org on that plan — surfaced with
 * a warning. Emerald + blue only.
 */

const EMERALD = '#10b981';
const BLUE = '#3b82f6';

export default function CloudCeilingEditor({ orgId, orgName, onCeilingChanged }) {
    const { t } = useTranslation();
    const entitlements = useEntitlements();
    const plansRes = useResource('/api/subscriptions/plans', { initial: [] });
    const subsRes = useResource('/api/subscriptions/orgs', { initial: [] });

    const [assigning, setAssigning] = useState(false);
    const [savingPlan, setSavingPlan] = useState(false);
    const [editing, setEditing] = useState(false);
    const [message, setMessage] = useState(null);

    const plans = Array.isArray(plansRes.data) ? plansRes.data : [];
    const subs = Array.isArray(subsRes.data) ? subsRes.data : [];
    const sub = subs.find(s => s.organization_id === orgId) || null;
    const currentPlanId = sub?.plan_id || '';
    const selectedPlan = useMemo(() => plans.find(p => p.id === currentPlanId) || null, [plans, currentPlanId]);

    const loading = plansRes.loading || subsRes.loading;

    const flash = (type, text) => { setMessage({ type, text }); setTimeout(() => setMessage(null), 3000); };

    const assignPlan = async (planId) => {
        setAssigning(true);
        try {
            await apiJson(`/api/subscriptions/orgs/${encodeURIComponent(orgId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ plan_id: planId || null, status: 'active' }),
            });
            await subsRes.reload();
            flash('ok', t('admin_org.ceiling_plan_assigned', 'Plan assigned'));
            entitlements?.reload?.();
            onCeilingChanged?.();
        } catch (e) {
            flash('error', e.message || t('admin_org.ceiling_assign_plan_failed', 'Failed to assign plan'));
        } finally { setAssigning(false); }
    };

    const savePlan = async (form) => {
        if (!selectedPlan) return;
        setSavingPlan(true);
        try {
            await apiJson(`/api/subscriptions/plans/${encodeURIComponent(selectedPlan.id)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(form),
            });
            await plansRes.reload();
            setEditing(false);
            flash('ok', t('admin_org.ceiling_plan_updated', 'Plan updated'));
            entitlements?.reload?.();
            onCeilingChanged?.();
        } catch (e) {
            flash('error', e.message || t('admin_org.ceiling_save_plan_failed', 'Failed to save plan'));
        } finally { setSavingPlan(false); }
    };

    if (loading) return <div className="p-6"><Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-muted)' }} /></div>;

    // Full-screen overlay for the (absolute inset-0) PlanEditor.
    if (editing && selectedPlan) {
        return (
            <div className="fixed inset-0 z-[1500]" style={{ background: 'var(--bg-primary)' }}>
                <PlanEditor
                    plan={selectedPlan}
                    isNew={false}
                    saving={savingPlan}
                    onSave={savePlan}
                    onBack={() => setEditing(false)}
                />
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Assignment card */}
            <section className="rounded-2xl p-5" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}>
                <header className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <Crown className="w-5 h-5" style={{ color: BLUE }} />
                        <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t('admin_org.ceiling_cloud_title', 'Subscription plan')}</h2>
                    </div>
                    {message ? (
                        <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: message.type === 'ok' ? EMERALD : '#dc2626' }}>
                            {message.type === 'ok' ? <Check className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}{message.text}
                        </span>
                    ) : null}
                </header>
                <p className="text-sm mb-4" style={{ color: 'var(--text-muted)', maxWidth: 720 }}>
                    {t('admin_org.ceiling_cloud_intro_a', 'The plan assigned to')} <strong>{orgName || t('admin_org.ceiling_this_org', 'this organisation')}</strong> {t('admin_org.ceiling_cloud_intro_b', 'is its capability ceiling. Pick a plan, then distribute its features to members and groups under')} <strong>{t('admin_org.ceiling_grants', 'Grants')}</strong>.
                </p>

                <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                    <label className="text-sm flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>{t('admin_org.ceiling_plan', 'Plan')}</label>
                    <select
                        value={currentPlanId}
                        disabled={assigning}
                        onChange={e => assignPlan(e.target.value)}
                        className="text-sm rounded-lg px-3 py-2 outline-none flex-1 max-w-sm"
                        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
                    >
                        <option value="">{t('admin_org.ceiling_no_plan', 'No plan (custom / no ceiling)')}</option>
                        {plans.map(p => (
                            <option key={p.id} value={p.id}>{p.name}{p.is_default ? ' ★' : ''}</option>
                        ))}
                    </select>
                    {assigning ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--text-muted)' }} /> : null}
                    {selectedPlan ? (
                        <button
                            onClick={() => setEditing(true)}
                            className="inline-flex items-center gap-1.5 text-sm rounded-lg px-3 py-2 font-medium transition-colors"
                            style={{ background: `${EMERALD}1a`, color: EMERALD, border: `1px solid ${EMERALD}` }}
                        >
                            <Pencil className="w-3.5 h-3.5" /> {t('admin_org.ceiling_edit_plan', 'Edit plan')}
                        </button>
                    ) : null}
                </div>

                {selectedPlan ? (
                    <div className="mt-3 flex items-start gap-2 text-[12px] rounded-lg px-3 py-2" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
                        <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: BLUE }} />
                        <span>{t('admin_org.ceiling_editing_a', 'Editing')} <strong>{selectedPlan.name}</strong> {t('admin_org.ceiling_editing_b', 'changes the ceiling for')} <em>{t('admin_org.ceiling_editing_every', 'every')}</em> {t('admin_org.ceiling_editing_c', 'organisation on this plan.')}</span>
                    </div>
                ) : null}
            </section>

            {/* Resulting ceiling (read-through) */}
            {currentPlanId ? <CeilingReadOnly orgId={orgId} key={`${orgId}:${currentPlanId}`} /> : null}
        </div>
    );
}
