import { ArrowRight, Package } from 'lucide-react';
import CeilingReadOnly from './CeilingReadOnly';
import { useTranslation } from '@/hooks/useTranslation';
import { useResource } from '../../subscriptions/hooks/useApi';
import { subscriptionsPath } from '../../subscriptions/subscriptionsSections';
import type { PlanRecord } from '../../subscriptions/plans/usePlanForm';
import { SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import Spinner from '@/components/shared/Spinner';
import { CHIP } from '@/components/shared/adminUi';
import { Button } from '@/components/shared/Button';
import { useShellProps } from '@/authedApp/useShellProps';

/**
 * CloudCeilingEditor — the cloud-mode ceiling, read-only. On cloud the ceiling
 * of an organisation is its subscription plan. Which plan it is on, and what a
 * plan holds, are changed in one place only, Whole server > Subscriptions
 * (the organisations section): this shows the plan as a chip and links there,
 * so a plan never has two editors. Below it, what the plan lets the
 * organisation use.
 */

/** One org's subscription row: only the plan it is on is read here. */
interface OrgSubscription {
    organization_id?: string;
    plan_id?: string | null;
}

interface CloudCeilingEditorProps {
    orgId: string | null | undefined;
    orgName: string | null | undefined;
}

/** The organisation's plan: its id ('' for none) and the plan record when the list has it. */
function planOf(plans: readonly PlanRecord[], subs: readonly OrgSubscription[], orgId: string | null | undefined) {
    const currentPlanId = subs.find(s => s.organization_id === orgId)?.plan_id || '';
    return { currentPlanId, plan: plans.find(p => p.id === currentPlanId) || null };
}

export default function CloudCeilingEditor({ orgId, orgName }: CloudCeilingEditorProps) {
    const { t } = useTranslation();
    const { onNavigate } = useShellProps({});
    const plansRes = useResource<PlanRecord[]>('/api/subscriptions/plans', { initial: [] });
    const subsRes = useResource<OrgSubscription[]>('/api/subscriptions/orgs', { initial: [] });

    const plans = Array.isArray(plansRes.data) ? plansRes.data : [];
    const subs = Array.isArray(subsRes.data) ? subsRes.data : [];
    const { currentPlanId, plan } = planOf(plans, subs, orgId);

    if (plansRes.loading || subsRes.loading) return <div className="p-6"><Spinner size="sm" /></div>;

    const org = orgName || t('admin_org.ceiling_this_org', 'this organisation');
    const planName = currentPlanId ? (plan?.name || currentPlanId) : t('admin_platform.ceiling_no_plan', 'No plan');

    return (
        <div className="flex flex-col gap-6">
            <SettingsGroup
                title={t('admin_org.ceiling_cloud_title', 'Subscription plan')}
                description={t('admin_platform.ceiling_plan_readonly_intro', 'The plan of {org} is its capability ceiling. Plans are assigned and changed under Subscriptions; distribute what the plan includes to members and groups under Grants.', { org })}
            >
                <SettingsList>
                    <SettingRow icon={<Package className="h-4 w-4" />} label={t('admin_org.ceiling_plan', 'Plan')}>
                        <div className="flex flex-wrap items-center gap-2 @[40rem]/srow:justify-end">
                            <span className={CHIP} data-testid="ceiling-plan-chip">{planName}</span>
                            <Button
                                variant="secondary"
                                size="sm"
                                iconRight={<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />}
                                onClick={() => onNavigate?.(subscriptionsPath('organizations'))}
                                disabled={!onNavigate}
                            >
                                {t('admin_platform.ceiling_open_subscriptions', 'Manage in Subscriptions')}
                            </Button>
                        </div>
                    </SettingRow>
                </SettingsList>
            </SettingsGroup>

            {/* Resulting ceiling (read-through) */}
            {currentPlanId ? <CeilingReadOnly orgId={orgId} key={`${orgId}:${currentPlanId}`} /> : null}
        </div>
    );
}
