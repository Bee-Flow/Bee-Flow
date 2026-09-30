/** The dashboard's one range control (the web's RangeControl, without Custom). */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { FilterPills } from '@/shared/ui';

import type { RangePreset } from '../model/range';

export function RangePills({ value, onChange }: { value: RangePreset; onChange: (next: RangePreset) => void }) {
    const t = useTranslation();
    return (
        <FilterPills
            value={value}
            onChange={onChange}
            scroll
            accessibilityLabel={t('usage.range', 'Range')}
            testID="range"
            options={[
                { value: 'today', label: t('usage.range_today', 'Today') },
                { value: '24h', label: t('usage.range_24h', '24h') },
                { value: '7d', label: t('usage.range_7d', '7d') },
                { value: '30d', label: t('usage.range_30d', '30d') },
                { value: '90d', label: t('usage.range_90d', '90d') },
                { value: 'all', label: t('usage.range_all', 'All') },
            ]}
        />
    );
}
