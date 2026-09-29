import React from 'react';
import { PRESETS } from './answersRange';
import { useTranslation } from '../../../../../hooks/useTranslation';
import SegmentedControl from '../../../../shared/SegmentedControl';

const INPUT = 'px-2 py-1 rounded-lg text-xs border outline-none focus:ring-2';

/** The period presets, plus two date fields when "custom" is chosen. */
export default function RangeBar({ range, onChange, updatedLabel = null }) {
    const { t } = useTranslation();
    const labels = {
        today: t('forms.answers.range_today', 'Today'),
        '7d': t('forms.answers.range_7d', '7 days'),
        '30d': t('forms.answers.range_30d', '30 days'),
        '90d': t('forms.answers.range_90d', '90 days'),
        all: t('forms.answers.range_all', 'All'),
        custom: t('forms.answers.range_custom', 'Custom'),
    };
    return (
        <div className="flex flex-wrap items-center gap-3" data-testid="answers-range">
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('forms.answers.range_label', 'Period')}</span>
            <SegmentedControl
                size="sm"
                ariaLabel={t('forms.answers.range_label', 'Period')}
                value={range.preset}
                onChange={(preset) => onChange({ ...range, preset })}
                options={PRESETS.map(p => ({ value: p, label: labels[p] }))}
            />
            {range.preset === 'custom' && (
                <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    <label className="inline-flex items-center gap-1">
                        {t('forms.answers.range_from', 'From')}
                        <input type="date" value={range.from || ''} onChange={(e) => onChange({ ...range, from: e.target.value })} className={INPUT} style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }} />
                    </label>
                    <label className="inline-flex items-center gap-1">
                        {t('forms.answers.range_to', 'To')}
                        <input type="date" value={range.to || ''} onChange={(e) => onChange({ ...range, to: e.target.value })} className={INPUT} style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }} />
                    </label>
                </span>
            )}
            {updatedLabel && <span className="ml-auto text-[11px]" style={{ color: 'var(--text-tertiary)' }} data-testid="answers-updated">{updatedLabel}</span>}
        </div>
    );
}
