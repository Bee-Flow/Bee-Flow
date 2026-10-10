/**
 * The pane's first row: which period this is, and the range.
 *
 * No sentence under the period: what is logged (the shield writes a row when
 * it ACTS on a message, and every call to an outside service) is what the
 * filter bar's count and the log's columns already say.
 */

import React from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import SegmentedControl from '../../../../../../shared/SegmentedControl';

export type RangePreset = '7d' | '30d' | '90d';

interface Props {
    period: string;
    preset: string;
    onPreset: (preset: RangePreset) => void;
    t: TranslateFn;
}

export function ActivityHeader({ period, preset, onPreset, t }: Props) {
    const options = [
        { value: '7d' as RangePreset, label: t('shield_activity.range_7d', '7 days') },
        { value: '30d' as RangePreset, label: t('shield_activity.range_30d', '30 days') },
        { value: '90d' as RangePreset, label: t('shield_activity.range_90d', '90 days') },
    ];
    return (
        <div className="flex flex-wrap items-center gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                {period && <h2 className="m-0 text-base font-semibold text-[var(--text-primary)]">{period}</h2>}
            </div>
            <SegmentedControl
                size="sm"
                value={preset as RangePreset}
                onChange={onPreset}
                options={options}
                ariaLabel={t('shield_activity.range_label', 'Period')}
            />
        </div>
    );
}
