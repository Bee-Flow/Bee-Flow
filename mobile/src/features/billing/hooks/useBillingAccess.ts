/**
 * Who may open the License & Usage screens, on the web's terms: an org admin
 * (the lifecycle writes are org-admin only), on a cloud deployment (the web
 * hides the section on self-hosted, where licence keys take its place). A
 * server-wide licence keeps the screen but replaces the subscription with a
 * note, as OrgLicenseSection.jsx does.
 */

import { useAccess } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { useOrgContext } from '@/features/org';
import type { IconName } from '@/shared/ui';

export interface BillingAccess {
    orgId: string | null;
    allowed: boolean;
    /** The frame's notice when the deployment, not the person, rules it out. */
    denied: { icon: IconName; title: string; message: string } | undefined;
    serverOverride: boolean;
}

export function useBillingAccess(): BillingAccess {
    const t = useTranslation();
    const { orgId, isOrgAdmin, isSelfHosted } = useOrgContext();
    const access = useAccess();
    const selfHosted = isOrgAdmin && isSelfHosted;
    return {
        orgId,
        allowed: isOrgAdmin && Boolean(orgId) && !isSelfHosted,
        denied: selfHosted
            ? {
                  icon: 'KeyRound',
                  title: t('mobile.billing.cloud_only_title', 'Subscriptions are a Bee Flow Cloud feature'),
                  message: t(
                      'mobile.billing.cloud_only_message',
                      'This installation runs on a licence key instead, which the platform operator manages.',
                  ),
              }
            : undefined,
        serverOverride: Boolean(access.license?.serverOverride),
    };
}
