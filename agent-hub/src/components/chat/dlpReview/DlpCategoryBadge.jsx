/**
 * Category + color badge for a DLP finding — category and a non-numeric
 * certainty word, never a raw confidence percentage (see
 * config/dlpCategoryColors.ts for why).
 */
import React from 'react';
import { categoryStyle, confidenceLabel } from '../../../config/dlpCategoryColors';
import { piiCategoryById } from '../../../config/piiCategories';
import { useTranslation } from '../../../hooks/useTranslation';

export default function DlpCategoryBadge({ categoryId, source = 'pii', confidenceBand = null, label, compact = false }) {
    const { t } = useTranslation();
    const style = categoryStyle(categoryId, confidenceBand);
    const def = piiCategoryById(categoryId);
    const displayLabel = label || (def ? t(def.i18nKey, def.fallback) : categoryId);
    const Icon = def?.Icon;

    return (
        <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border"
            style={{ background: style.background, borderColor: style.borderColor, color: style.color }}
        >
            {Icon && <Icon className="w-2.5 h-2.5 shrink-0" />}
            <span className="truncate max-w-[9rem]">{displayLabel}</span>
            {!compact && (
                <span className="opacity-75">· {confidenceLabel(source, confidenceBand, t)}</span>
            )}
        </span>
    );
}
