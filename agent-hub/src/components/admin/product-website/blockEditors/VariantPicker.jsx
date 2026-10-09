import React from 'react';
import { BLOCK_VARIANTS } from './catalogue';
import { useTranslation } from '../../../../hooks/useTranslation';

// Human labels for variant slugs; unknown slugs fall back to the slug.
function variantLabels(t) {
    return {
        classic: t('cms_site.blocks.variant_picker.classic', 'Classic'),
        panel: t('cms_site.blocks.variant_picker.panel', 'Panel'),
        split: t('cms_site.blocks.variant_picker.split', 'Split'),
        video: t('cms_site.blocks.variant_picker.video', 'Video'),
        bento: t('cms_site.blocks.variant_picker.bento', 'Bento'),
        chapters: t('cms_site.blocks.variant_picker.chapters', 'Chapters'),
        ledger: t('cms_site.blocks.variant_picker.ledger', 'Ledger'),
        numbers: t('cms_site.blocks.variant_picker.numbers', 'Numbers'),
        quotes: t('cms_site.blocks.variant_picker.quotes', 'Quotes'),
        case: t('cms_site.blocks.variant_picker.case', 'Case'),
        spotlight: t('cms_site.blocks.variant_picker.spotlight', 'Spotlight'),
        chips: t('cms_site.blocks.variant_picker.chips', 'Chips'),
        detailed: t('cms_site.blocks.variant_picker.detailed', 'Detailed'),
        single: t('cms_site.blocks.variant_picker.single', 'Single'),
        pair: t('cms_site.blocks.variant_picker.pair', 'Pair'),
        'code-ui': t('cms_site.blocks.variant_picker.code_ui', 'Code + UI'),
    };
}

/**
 * Layout-variant selector — the FIRST control in a block editor whose type
 * has entries in BLOCK_VARIANTS. Writes `content.variant`; an absent or
 * unknown value renders as the type's first (legacy) variant, so this
 * control is always safe to show.
 */
export default function VariantPicker({ type, value, onChange }) {
    const { t } = useTranslation();
    const variants = BLOCK_VARIANTS[type];
    if (!Array.isArray(variants) || variants.length < 2) return null;
    const active = variants.includes(value) ? value : variants[0];
    return (
        <div className="mb-3">
            <div className="text-[11px] font-medium text-[var(--text-muted)] mb-1.5">{t('cms_site.blocks.variant_picker.layout', 'Layout')}</div>
            <div className="inline-flex flex-wrap gap-1 rounded-lg bg-[var(--bg-tertiary)] p-1">
                {variants.map(v => (
                    <button
                        key={v}
                        type="button"
                        onClick={() => onChange(v)}
                        aria-pressed={v === active}
                        className={
                            v === active
                                ? 'px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm'
                                : 'px-2.5 py-1 rounded-md text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                        }
                    >
                        {variantLabels(t)[v] || v}
                    </button>
                ))}
            </div>
        </div>
    );
}
