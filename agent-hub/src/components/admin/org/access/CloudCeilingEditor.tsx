import { AlertTriangle, Loader2, Pencil } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import CeilingReadOnly from './CeilingReadOnly';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { useEntitlements } from '@/components/licensing/EntitlementsContext';
import { useResource, apiJson } from '../../subscriptions/hooks/useApi';
import { PlanEditor } from '../../subscriptions/plans/PlanEditor';
import type { PlanForm, PlanRecord } from '../../subscriptions/plans/usePlanForm';
import { AccessStatus } from './AccessParts';
import { FIELD_INPUT, SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import Spinner from '@/components/shared/Spinner';
import { ALERT_WARNING } from '@/components/shared/adminUi';
import { Button } from '@/components/shared/Button';
import { ServerWideMark } from '@/components/admin/dashboard/serverWideNav';

/**
 * CloudCeilingEditor — the cloud-mode ceiling. On cloud the ceiling for an org
 * is its subscription plan, so a super-admin (a) assigns which plan the org is
 * on and (b) edits that plan's allow-lists (beta / integrations / features)
 * in place via the existing PlanEditor. Reuses the subscriptions endpoints.
 *
 * Editing a plan changes the ceiling for EVERY org on that plan: the button
 * says so, a warning above it counts the organisations on the plan, and the
 * full-screen plan editor keeps that warning on top while it is open. Plans
 * themselves are managed under Whole server > Subscriptions.
 */

/** One org's subscription row: only the plan it is on is read here. */
interface OrgSubscription {
    organization_id?: string;
    plan_id?: string | null;
}

interface CloudCeilingEditorProps {
    orgId: string | null | undefined;
    orgName: string | null | undefined;
    onCeilingChanged: (() => void) | undefined;
}

/** What editing a plan reaches: every organisation on it (their number), or, alone on it, whoever is put on it later. */
function planSharedWarning(t: TranslateFn, plan: string, orgsOnPlan: number, org: string): string {
    return orgsOnPlan > 1
        ? t('admin_platform.ceiling_plan_shared', 'Editing {plan} changes the ceiling for all {count} organisations on this plan, not only for {org}.', { plan, count: orgsOnPlan, org })
        : t('admin_platform.ceiling_plan_shared_one', 'Editing {plan} changes the plan itself: every organisation put on it later gets the same ceiling as {org}.', { plan, org });
}

/** The organisation's plan, and how many organisations it applies to (this one included). */
function planOf(plans: readonly PlanRecord[], subs: readonly OrgSubscription[], orgId: string | null | undefined) {
    const currentPlanId = subs.find(s => s.organization_id === orgId)?.plan_id || '';
    return {
        currentPlanId,
        selectedPlan: plans.find(p => p.id === currentPlanId) || null,
        orgsOnPlan: currentPlanId ? subs.filter(s => s.plan_id === currentPlanId).length : 0,
    };
}

/** The full-screen plan editor, with the warning that the plan is shared kept on top. */
function PlanEditorOverlay({ warning, children }: { warning: string | null; children: ReactNode }) {
    return (
        <div className="fixed inset-0 z-[1500] flex flex-col bg-[var(--bg-primary)]">
            <p role="note" className={`${ALERT_WARNING} m-3 mb-0`} data-testid="plan-editor-shared-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{warning}</span>
            </p>
            <div className="relative min-h-0 flex-1">{children}</div>
        </div>
    );
}

export default function CloudCeilingEditor({ orgId, orgName, onCeilingChanged }: CloudCeilingEditorProps) {
    const { t } = useTranslation();
    const entitlements = useEntitlements();
    const plansRes = useResource<PlanRecord[]>('/api/subscriptions/plans', { initial: [] });
    const subsRes = useResource<OrgSubscription[]>('/api/subscriptions/orgs', { initial: [] });

    const [assigning, setAssigning] = useState(false);
    const [savingPlan, setSavingPlan] = useState(false);
    const [editing, setEditing] = useState(false);
    const [message, setMessage] = useState<{ type: string; text: string; } | null>(null);

    const plans = useMemo(() => Array.isArray(plansRes.data) ? plansRes.data : [], [plansRes.data]);
    const subs = Array.isArray(subsRes.data) ? subsRes.data : [];
    const { currentPlanId, selectedPlan, orgsOnPlan } = planOf(plans, subs, orgId);

    const loading = plansRes.loading || subsRes.loading;

    const flash = (type: string, text: string) => { setMessage({ type, text }); setTimeout(() => setMessage(null), 3000); };

    const assignPlan = async (planId: string) => {
        if (!orgId) return;
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
            flash('error', (e as Error).message || t('admin_org.ceiling_assign_plan_failed', 'Failed to assign plan'));
        } finally { setAssigning(false); }
    };

    const savePlan = async (form: PlanForm) => {
        if (!selectedPlan?.id) return;
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
            flash('error', (e as Error).message || t('admin_org.ceiling_save_plan_failed', 'Failed to save plan'));
        } finally { setSavingPlan(false); }
    };

    if (loading) return <div className="p-6"><Spinner size="sm" /></div>;

    const everyOrgWarning = selectedPlan ? planSharedWarning(t, selectedPlan.name ?? '', orgsOnPlan, orgName || t('admin_org.ceiling_this_org', 'this organisation')) : null;

    // Full-screen overlay for the (absolute inset-0) PlanEditor, under the same warning.
    if (editing && selectedPlan) {
        return (
            <PlanEditorOverlay warning={everyOrgWarning}>
                <PlanEditor plan={selectedPlan} isNew={false} saving={savingPlan} onSave={savePlan} onBack={() => setEditing(false)} />
            </PlanEditorOverlay>
        );
    }

    return (
        <div className="flex flex-col gap-6">
            <SettingsGroup
                title={t('admin_org.ceiling_cloud_title', 'Subscription plan')}
                description={<>
                    {t('admin_org.ceiling_cloud_intro_a', 'The plan assigned to')} <strong>{orgName || t('admin_org.ceiling_this_org', 'this organisation')}</strong> {t('admin_org.ceiling_cloud_intro_b', 'is its capability ceiling. Pick a plan, then distribute its features to members and groups under')} <strong>{t('admin_org.ceiling_grants', 'Grants')}</strong>.
                </>}
                actions={<AccessStatus message={message} />}
            >
                <SettingsList>
                    <SettingRow label={t('admin_org.ceiling_plan', 'Plan')} htmlFor="access-ceiling-plan">
                        <div className="flex items-center gap-2">
                            <select
                                id="access-ceiling-plan"
                                value={currentPlanId}
                                disabled={assigning}
                                onChange={e => assignPlan(e.target.value)}
                                className={FIELD_INPUT}
                            >
                                <option value="">{t('admin_org.ceiling_no_plan', 'No plan (custom / no ceiling)')}</option>
                                {plans.map(p => (
                                    <option key={p.id} value={p.id}>{p.name}{p.is_default ? ' ★' : ''}</option>
                                ))}
                            </select>
                            {assigning ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-tertiary)]" aria-hidden="true" /> : null}
                            {selectedPlan ? (
                                <Button variant="secondary" size="sm" icon={Pencil} className="shrink-0" onClick={() => setEditing(true)} iconRight={<ServerWideMark />}>
                                    {/* The plan is shared by every organisation on it: this edit is server-wide, under an organisation heading. */}
                                    {t('admin_platform.ceiling_edit_plan_all', 'Edit plan for all its organisations')}
                                </Button>
                            ) : null}
                        </div>
                    </SettingRow>
                </SettingsList>

                {selectedPlan ? (
                    <p className={ALERT_WARNING}>
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>{everyOrgWarning}</span>
                    </p>
                ) : null}
            </SettingsGroup>

            {/* Resulting ceiling (read-through) */}
            {currentPlanId ? <CeilingReadOnly orgId={orgId} key={`${orgId}:${currentPlanId}`} /> : null}
        </div>
    );
}
