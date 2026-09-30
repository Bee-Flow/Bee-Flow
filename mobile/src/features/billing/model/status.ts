/**
 * A subscription's status in words. The web prints the server's enum as is
 * (OrgLicenseSection.jsx, uppercased); the phone says it, and falls back to
 * the enum made readable for a status it does not know yet.
 */

import type { TranslateFn } from '@/core/i18n';
import { humanise } from '@/shared/lib/display';

export function subscriptionStatusLabel(status: string, t: TranslateFn): string {
    switch (status) {
        case 'active':
            return t('routines.active', 'Active');
        case 'trialing':
            return t('mobile.billing.status_trialing', 'Trial');
        case 'past_due':
            return t('mobile.billing.status_past_due', 'Payment overdue');
        case 'suspended':
            return t('mobile.billing.status_suspended', 'Suspended');
        case 'cancelled':
        case 'canceled':
            return t('mobile.billing.status_cancelled', 'Cancelled');
        case 'pending':
            return t('mobile.billing.status_pending', 'Pending');
        default:
            return humanise(status);
    }
}
