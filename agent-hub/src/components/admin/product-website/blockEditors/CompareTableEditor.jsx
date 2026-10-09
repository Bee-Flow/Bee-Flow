import React from 'react';
import { TextField, RepeatableList } from '../fields';
import { InlineHint } from '../primitives';
import { set, SectionHeaderFields } from './shared';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── Comparison table ──────────────────────────────────────────────────
//
// Rows are { aspect, left, right } and `left` is always our side
// (leftLabel), so neither the renderer nor a translator has to guess
// which column belongs to the product.

export function CompareTableEditor({ data = {}, onChange }) {
    const { t } = useTranslation();
    return (
        <>
            <InlineHint>{t('cms_site.blocks.compare_table.left_column_is_your_product_right', 'Left column is your product; right column is the one being compared.')}</InlineHint>
            <SectionHeaderFields data={data} onChange={onChange} persistScope="compare-table" />
            <TextField
                label={t('cms_site.blocks.compare_table.left_column_heading', 'Left column heading')}
                value={data.leftLabel || ''}
                onChange={v => onChange(set(data, 'leftLabel', v))}
                placeholder="Bee Flow"
            />
            <TextField
                label={t('cms_site.blocks.compare_table.right_column_heading', 'Right column heading')}
                value={data.rightLabel || ''}
                onChange={v => onChange(set(data, 'rightLabel', v))}
                placeholder={t('cms_site.blocks.compare_table.the_other_product', 'The other product')}
            />
            <RepeatableList
                label={t('cms_site.blocks.compare_table.rows', 'Rows')}
                items={data.rows || []}
                onChange={v => onChange(set(data, 'rows', v))}
                makeNew={() => ({ aspect: '', left: '', right: '' })}
                itemLabel={(item) => item.aspect || t('cms_site.blocks.compare_table.no_aspect', '(no aspect)')}
                renderItem={(item, update) => (
                    <>
                        <TextField
                            label={t('cms_site.blocks.compare_table.aspect', 'Aspect')}
                            value={item.aspect || ''}
                            onChange={v => update({ ...item, aspect: v })}
                            placeholder={t('cms_site.blocks.compare_table.e_g_deployment', 'e.g. Deployment')}
                        />
                        <TextField
                            label={t('cms_site.blocks.compare_table.left_cell_us', 'Left cell (us)')}
                            value={item.left || ''}
                            onChange={v => update({ ...item, left: v })}
                            placeholder={t('cms_site.blocks.compare_table.what_we_do', 'What we do')}
                        />
                        <TextField
                            label={t('cms_site.blocks.compare_table.right_cell_them', 'Right cell (them)')}
                            value={item.right || ''}
                            onChange={v => update({ ...item, right: v })}
                            placeholder={t('cms_site.blocks.compare_table.what_they_do_their_docs_are', 'What they do — their docs are authoritative')}
                        />
                    </>
                )}
                addLabel={t('cms_site.blocks.compare_table.add_row', 'Add row')}
            />
            <TextField
                label={t('cms_site.blocks.compare_table.footnote', 'Footnote')}
                value={data.footnote || ''}
                onChange={v => onChange(set(data, 'footnote', v))}
                placeholder={t('cms_site.blocks.compare_table.e_g_their_column_is_drawn', 'e.g. Their column is drawn from public documentation.')}
            />
        </>
    );
}
