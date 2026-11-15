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
import { useShellProps } from '@/authedApp/useShellProps';
import { SubscriptionsTitledContext } from './ui/titledContext';

interface SubscriptionsPanelProps {
    /** The section from the URL (admin/subscriptions/<section>); Plans when missing or unknown. */
    activeSection?: string;
    onNavigate?: (path: string) => void;
    /**
     * false: no section column (a host whose own navigation lists the
     * sections, SUBSCRIPTIONS_SECTIONS, as rows, and draws the page heading).
     * The section still comes from `activeSection`; the views then show their
     * description and actions without a title of their own.
     */
    nav?: boolean;
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

function SubscriptionsPanel({ activeSection, onNavigate: onNavigateProp, nav = true }: SubscriptionsPanelProps) {
    const { t } = useTranslation();
    // Inside the app shell the navigation comes from context; a host outside
    // it (a test, a kit) still hands it as a prop.
    const { onNavigate } = useShellProps({ onNavigate: onNavigateProp });
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
    const body = (
        <div className="relative h-full">
            <div className="absolute inset-0 overflow-y-auto">
                <SubscriptionsTitledContext.Provider value={nav}>
                    <View />
                </SubscriptionsTitledContext.Provider>
            </div>
        </div>
    );
    if (!nav) return body;
    return (
        <StudioShell responsive sidebarTitle={title} sidebar={sidebar}>
            {body}
        </StudioShell>
    );
}

export default SubscriptionsPanel;
