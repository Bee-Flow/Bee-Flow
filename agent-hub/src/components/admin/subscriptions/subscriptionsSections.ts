// The sections of the Subscriptions console. The id is the URL segment
// (admin/subscriptions/<id>), so a section can be linked to and Back works;
// admin/subscriptions alone opens Plans.

import { Building2, CreditCard, KeyRound, Package, ScrollText, ShieldCheck, Tag } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type SubscriptionsSectionId = 'plans' | 'organizations' | 'grants' | 'access' | 'promos' | 'settings' | 'audit';

export const SUBSCRIPTIONS_SECTIONS: readonly { id: SubscriptionsSectionId; icon: LucideIcon; labelKey: string; label: string }[] = [
    { id: 'plans', icon: Package, labelKey: 'admin_subscriptions.shell_plans', label: 'Plans' },
    { id: 'organizations', icon: Building2, labelKey: 'admin_subscriptions.shell_orgs', label: 'Orgs' },
    { id: 'grants', icon: KeyRound, labelKey: 'admin_subscriptions.shell_grants', label: 'Grants' },
    { id: 'access', icon: ShieldCheck, labelKey: 'admin_subscriptions.shell_access', label: 'Access' },
    { id: 'promos', icon: Tag, labelKey: 'admin_subscriptions.shell_promos', label: 'Promos' },
    { id: 'settings', icon: CreditCard, labelKey: 'admin_subscriptions.shell_stripe', label: 'Stripe' },
    { id: 'audit', icon: ScrollText, labelKey: 'admin_subscriptions.shell_audit', label: 'Audit' },
];

const DEFAULT_SUBSCRIPTIONS_SECTION: SubscriptionsSectionId = 'plans';

/** The section a URL segment names, or the default one when it is missing or unknown. */
export function subscriptionsSectionOf(segment: string | undefined): SubscriptionsSectionId {
    const hit = SUBSCRIPTIONS_SECTIONS.find(s => s.id === segment);
    return hit ? hit.id : DEFAULT_SUBSCRIPTIONS_SECTION;
}

export const subscriptionsPath = (section: SubscriptionsSectionId) => `admin/subscriptions/${section}`;
