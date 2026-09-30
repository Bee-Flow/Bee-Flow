/** The licence tier as a badge row: accented for anything above Community. */

import React from 'react';

import { Badge, BadgeRow } from '@/shared/ui';

import { tierBadge } from '../model/licence';
import type { LicenseStatus } from '../model/types';

export function TierBadgeRow({
    label,
    license,
}: {
    label: string;
    license: LicenseStatus | null | undefined;
}) {
    const badge = tierBadge(license);
    return (
        <BadgeRow label={label}>
            <Badge label={badge.label} tone={badge.tone} />
        </BadgeRow>
    );
}
