/** The licence tier, where it came from, and until when. */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Group, InfoRow } from '@/shared/ui';

import { TierBadgeRow } from './TierBadgeRow';
import { licenceSource } from '../model/licence';
import type { LicenseStatus } from '../model/types';

export function LicenceGroup({ license }: { license: LicenseStatus | null | undefined }) {
    const t = useTranslation();
    const expiresAt = license?.license?.expiresAt;
    return (
        <Group
            title={t('mobile.usage.licence', 'Licence')}
            footer={t('mobile.usage.licence_footer', 'Your tier decides which features are available, independently of how much you use.')}
        >
            <TierBadgeRow label={t('mobile.usage.tier', 'Tier')} license={license} />
            <InfoRow label={t('license.source', 'Source')} value={licenceSource(license?.source, t)} />
            {expiresAt ? (
                <InfoRow label={t('license.expires_on', 'Expires on')} value={new Date(expiresAt).toLocaleDateString()} />
            ) : null}
        </Group>
    );
}
