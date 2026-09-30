/**
 * The licence refresher and dunning counts, for an org admin. One fragment on
 * purpose: the Group draws no dividers between these three.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { InfoRow } from '@/shared/ui';

import type { LicenseHealth } from '../model/types';

export function LicenceHealthRows({ health }: { health: LicenseHealth }) {
    const t = useTranslation();
    const { refresher, dunning } = health;
    return (
        <>
            <InfoRow
                label={t('mobile.org.licence_refresher', 'Refresher')}
                value={
                    refresher.enabled
                        ? t('mobile.org.licence_running', 'Running')
                        : t('common.off', 'Off')
                }
                tone={refresher.enabled ? 'success' : 'tertiary'}
            />
            <InfoRow
                label={t('mobile.org.licence_past_due', 'Accounts past due')}
                value={String(dunning.past_due_count)}
                tone={dunning.past_due_count > 0 ? 'warning' : 'tertiary'}
            />
            <InfoRow
                label={t('mobile.org.licence_suspended', 'Accounts suspended')}
                value={String(dunning.suspended_count)}
                tone={dunning.suspended_count > 0 ? 'error' : 'tertiary'}
            />
        </>
    );
}
