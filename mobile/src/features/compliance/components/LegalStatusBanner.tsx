/**
 * The top of More frameworks (web ComplianceHeader legalStatusChip and the
 * frameworks summary pill): when the legal register was last checked
 * against the official texts, in warning tone once due for review or never
 * recorded; the hint that this is not legal advice; and the counts.
 */

import React from 'react';
import { View } from 'react-native';

import { useLocale, useTranslation } from '@/core/i18n';
import { Banner, Text } from '@/shared/ui';

import type { FrameworkList } from '../api/hubReaders';
import { formatCalDate } from '../model/calendarMath';
import { frameworkSummary, legalStatusOf } from '../model/frameworkCard';

export interface LegalStatusBannerProps {
    catalogue: FrameworkList['catalogue'];
    counts: { active: number | null; candidates: number | null; recent: number | null };
}

export function LegalStatusBanner({ catalogue, counts }: LegalStatusBannerProps) {
    const t = useTranslation();
    const { locale } = useLocale();
    const status = legalStatusOf(catalogue, t, (d) => formatCalDate(d, { locale }) || d);
    const summary = frameworkSummary(counts, t);
    return (
        <Banner tone={status.tone} icon={status.tone === 'info' ? 'CalendarClock' : undefined}>
            <View testID={`legal-status-${status.tone}`}>
                <Text variant="caption" weight="semibold">
                    {status.text}
                </Text>
                <Text variant="label" tone="secondary">
                    {t('compliance.hdr_fw_checked_hint', 'The frameworks, dates and milestones here were checked against the official texts. Each framework lists its sources under Timeline. Not legal advice.')}
                </Text>
                {summary ? (
                    <Text variant="label" tone="tertiary" testID="frameworks-summary">
                        {summary}
                    </Text>
                ) : null}
            </View>
        </Banner>
    );
}
