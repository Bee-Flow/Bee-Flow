/**
 * What an org-admin screen shows someone the server would refuse: who can
 * open it, rather than a 403. OrgSettingsFrame renders it for a section's
 * form; a list screen of an org-* feature renders it on its own.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { EmptyState, Screen, ScreenHeader, type IconName } from '@/shared/ui';

export interface OrgDenied {
    icon: IconName;
    title: string;
    message: string;
}

/** The notice alone, for a screen that draws its own header. */
export function OrgLockedNotice({ denied }: { denied?: OrgDenied }) {
    const t = useTranslation();
    return (
        <EmptyState
            icon={denied?.icon ?? 'Lock'}
            title={denied?.title ?? t('mobile.org.admins_only_title', 'For organisation administrators')}
            message={
                denied?.message ??
                t('mobile.org.admins_only_message', 'Only an administrator of your organisation can change this setting.')
            }
        />
    );
}

export function OrgLockedScreen({ title, subtitle, denied }: { title: string; subtitle?: string; denied?: OrgDenied }) {
    return (
        <Screen edges={['top', 'bottom']} inset>
            <ScreenHeader title={title} subtitle={subtitle} />
            <OrgLockedNotice denied={denied} />
        </Screen>
    );
}
