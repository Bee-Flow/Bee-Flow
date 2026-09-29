/**
 * "3 gedetecteerd · 1 door jou toegevoegd" strip above the reviewed content,
 * with one category chip per distinct category found — category + color,
 * same rule as everywhere else in this review UI (never a raw score).
 */
import React, { useMemo } from 'react';
import DlpCategoryBadge from './DlpCategoryBadge';
import { useTranslation } from '../../../hooks/useTranslation';

export default function DlpFindingsSummaryBar({ spans }) {
    const { t } = useTranslation();
    const autoCount = spans.filter(s => s.source !== 'manual').length;
    const manualCount = spans.filter(s => s.source === 'manual').length;

    const categories = useMemo(() => {
        const seen = new Map();
        for (const s of spans) {
            if (!seen.has(s.category)) seen.set(s.category, { category: s.category, source: s.source, confidenceBand: s.confidenceBand });
        }
        return [...seen.values()];
    }, [spans]);

    if (spans.length === 0) {
        return (
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('dlp.summary_none_found', 'No personal data detected. Do you see something anyway? Select it below.')}
            </p>
        );
    }

    return (
        <div className="flex flex-col gap-2">
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {manualCount > 0
                    ? t('dlp.summary_with_manual', '{auto} detected · {manual} added by you', { auto: autoCount, manual: manualCount })
                    : t('dlp.summary_auto_only', '{count} detected', { count: autoCount })}
            </p>
            <div className="flex flex-wrap gap-1.5">
                {categories.map(c => (
                    <DlpCategoryBadge key={c.category} categoryId={c.category} source={c.source} confidenceBand={c.confidenceBand} compact />
                ))}
            </div>
        </div>
    );
}
