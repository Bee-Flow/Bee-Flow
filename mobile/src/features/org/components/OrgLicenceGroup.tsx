/**
 * The licence this organisation runs under: tier, expiry, refresh and — for an
 * org admin — the refresher and dunning health (/api/license/health). What
 * used to be the operator dashboard's licence card, kept where org admins are.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { TierBadgeRow, type LicenseStatus } from '@/features/usage';
import { absoluteDate, humanise } from '@/shared/lib/display';
import { Group, InfoRow, NoteRow } from '@/shared/ui';

import { LicenceHealthRows } from './LicenceHealthRows';
import { expiringSoon } from '../model/licence';
import type { LicenseHealth } from '../model/types';

export function OrgLicenceGroup({
    license,
    health,
}: {
    license: LicenseStatus | null | undefined;
    health: LicenseHealth | null | undefined;
}) {
    const t = useTranslation();
    const expiresAt = license?.license?.expiresAt;
    const refreshStatus = license?.license?.refreshStatus;
    return (
        <Group title={t('mobile.org.licence_title', 'Licence')}>
            <TierBadgeRow label={t('mobile.org.licence_tier', 'Licence tier')} license={license} />
            {expiresAt ? (
                <InfoRow
                    label={t('mobile.org.licence_expires', 'Expires')}
                    value={absoluteDate(expiresAt)}
                    tone={expiringSoon(expiresAt) ? 'warning' : 'tertiary'}
                />
            ) : null}
            {refreshStatus ? (
                <InfoRow
                    label={t('mobile.org.licence_refreshed', 'Last refresh')}
                    value={humanise(refreshStatus)}
                    tone={refreshStatus === 'ok' ? 'success' : 'warning'}
                />
            ) : null}
            {health ? <LicenceHealthRows health={health} /> : null}
            {license?.serverOverride ? (
                <NoteRow>
                    {t(
                        'mobile.org.licence_server_wide',
                        'This installation is covered by a server-wide licence, so every organisation on it shares that tier.',
                    )}
                </NoteRow>
            ) : null}
        </Group>
    );
}
