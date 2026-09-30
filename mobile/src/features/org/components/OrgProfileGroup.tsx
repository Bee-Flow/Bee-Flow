/**
 * What a member (not an org admin) sees of the organisation: its name, the
 * plan it runs on, and a line saying the rest belongs to an administrator.
 * The header above already carries the name and the member's role; an admin
 * reads the profile through the Organisation Info row instead.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { TierBadgeRow, type LicenseStatus } from '@/features/usage';
import { Group, InfoRow, NoteRow } from '@/shared/ui';

export function OrgProfileGroup({ name, license }: { name: string; license: LicenseStatus | null | undefined }) {
    const t = useTranslation();
    return (
        <Group title={t('mobile.org.profile_title', 'Profile')}>
            <InfoRow label={t('common.name', 'Name')} value={name} />
            <TierBadgeRow label={t('mobile.org.licence_tier', 'Licence tier')} license={license} />
            <NoteRow>
                {t(
                    'mobile.org.profile_members_note',
                    'The full organisation profile is visible to administrators. Your own membership is shown above.',
                )}
            </NoteRow>
        </Group>
    );
}
