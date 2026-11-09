import type { ComponentType } from 'react';
import { PlansView } from './plans/PlansView';
import { OrgsView } from './orgs/OrgsView';
import { GrantsView } from './grants/GrantsView';
import { AccessView } from './access/AccessView';
import { PromosView } from './promos/PromosView';
import { StripeView } from './stripe/StripeView';
import { AuditView } from './audit/AuditView';
import { SUBSCRIPTIONS_SECTIONS, subscriptionsPath, subscriptionsSectionOf } from './subscriptionsSections';
import type { SubscriptionsSectionId } from './subscriptionsSections';
import SectionNav from '@/components/shared/SectionNav';
import StudioShell from '@/components/shared/StudioShell';
import { useTranslation } from '@/hooks/useTranslation';

interface SubscriptionsPanelProps {
    /** The section from the URL (admin/subscriptions/<section>); Plans when missing or unknown. */
    activeSection?: string;
    onNavigate?: (path: string) => void;
}

const VIEWS: Record<SubscriptionsSectionId, ComponentType> = {
    plans: PlansView,
    organizations: OrgsView,
    grants: GrantsView,
    access: AccessView,
    promos: PromosView,
    settings: StripeView,
    audit: AuditView,
};

function SubscriptionsPanel({ activeSection, onNavigate }: SubscriptionsPanelProps) {
    const { t } = useTranslation();
    const section = subscriptionsSectionOf(activeSection);
    const View = VIEWS[section];
    const title = t('admin_subscriptions.shell_title', 'Subscriptions');

    const sidebar = (
        <SectionNav
            label={title}
            items={SUBSCRIPTIONS_SECTIONS.map(({ id, icon, labelKey, label }) => ({ id, icon, label: t(labelKey, label) }))}
            activeId={section}
            onSelect={(id) => onNavigate?.(subscriptionsPath(id as SubscriptionsSectionId))}
        />
    );

    // The editors (plan, org, promo, grant wizard) cover the pane with an
    // absolute inset-0 layer, so the content area is the positioned box.
    return (
        <StudioShell responsive sidebarTitle={title} sidebar={sidebar}>
            <div className="relative h-full">
                <div className="absolute inset-0 overflow-y-auto">
                    <View />
                </div>
            </div>
        </StudioShell>
    );
}

export default SubscriptionsPanel;
