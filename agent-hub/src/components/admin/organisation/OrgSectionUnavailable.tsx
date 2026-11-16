// The page of an Organisation section this viewer does not get, on its own
// address (an old link, a bookmark, a link someone shared): it says why the
// section is not there for this organisation instead of showing another
// section in its place. The reason comes from the section rules
// (orgSections orgSectionUnavailableReason), most of them from the chosen
// organisation's integration availability.

import { Lock } from 'lucide-react';
import EmptyState from '@/components/shared/EmptyState';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { availabilityReasonText } from '@/utils/integrationAvailability';
import type { OrgSectionUnavailableReason } from './orgSections';

/** The sentence for a reason. */
function orgSectionReasonText(t: TranslateFn, reason: OrgSectionUnavailableReason): string {
    switch (reason) {
        case 'self_hosted_licence': return t('admin_nav.unavailable_self_hosted_licence', 'On this server the licence is managed for the whole server, under Licence & features.');
        case 'nextcloud_sign_in': return t('admin_nav.unavailable_nextcloud_sign_in', 'This organisation signs in through its Nextcloud, so there is no sign-in method to choose here.');
        case 'no_permission': return t('admin_nav.unavailable_no_permission', 'Your account has no access to this page.');
        case 'unknown': return t('admin_nav.unavailable_unknown', 'This page does not apply to this organisation.');
        default: return availabilityReasonText(t, reason);
    }
}

export default function OrgSectionUnavailable({ section, reason }: { section: string; reason: OrgSectionUnavailableReason }) {
    const { t } = useTranslation();
    return (
        <div data-testid={`org-section-unavailable-${section}`} data-reason={reason}>
            <EmptyState
                icon={(
                    <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                        <Lock className="h-7 w-7" strokeWidth={2} aria-hidden="true" />
                    </span>
                )}
                title={<h3 className="m-0 text-base font-semibold">{t('admin_nav.unavailable_title', 'Not available for this organisation')}</h3>}
                description={orgSectionReasonText(t, reason)}
            />
        </div>
    );
}
