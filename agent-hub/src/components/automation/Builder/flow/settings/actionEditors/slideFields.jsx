// The slide editor: one slide as a value — its title and content, the visual
// it carries (chart, KPI tiles, image or timeline) and its layout.
import TemplateField from '../../../mapping/TemplateField';
import AccordionSection from '../../AccordionSection';
import { ForEachSection, RetrySection, retryIsSet } from '../collectionEditors';
import { FormRow, inputClass, SectionNote } from '../formPrimitives';
import { useTranslation } from '../../../../../../hooks/useTranslation';

const SLIDE_LAYOUT_OPTIONS = [
    ['auto', 'Pick from the content'],
    ['bullets', 'Title + bullets'],
    ['section', 'Section divider (title only)'],
    ['two_column', 'Two columns'],
    ['cards', 'Cards (3–4 sub-headings)'],
    ['table', 'Table'],
    ['image', 'Image'],
    ['quote', 'Quote'],
    ['chart', 'Chart'],
    ['stats', 'KPI tiles'],
    ['timeline', 'Timeline / steps'],
    ['title', 'Title slide'],
    ['closing', 'Closing slide'],
];

const SLIDE_VISUAL_OPTIONS = [
    ['none', 'None — text only'],
    ['chart', 'Chart'],
    ['stats', 'KPI tiles'],
    ['image', 'Image'],
    ['timeline', 'Timeline / steps'],
];
const CHART_TYPE_OPTIONS = [
    ['column', 'Column'],
    ['bar', 'Bar (horizontal)'],
    ['line', 'Line'],
    ['area', 'Area'],
    ['pie', 'Pie'],
    ['donut', 'Donut'],
];

/**
 * The slide's visual — one of chart / KPI tiles / image / timeline. The
 * picker is a view over the stored fields (formState derives it), so a
 * slide the AI built with a chart opens on "Chart".
 */
function SlideVisualFields({ draft, set, onFocusField, previewSample }) {
    const { t } = useTranslation();
    const visual = draft.visual || 'none';
    return (
        <>
            <FormRow label={t('automations.slide_fields.visual', 'Visual')} hint={t('automations.slide_fields.a_chart_from_data_rows_headline', 'A chart from data rows, headline figures as tiles, a picture, or the bullets as numbered steps.')}>
                <select value={visual} onChange={(e) => set('visual', e.target.value)} className={inputClass()} data-testid="slide-visual">
                    {SLIDE_VISUAL_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
            </FormRow>
            {visual === 'chart' && (
                <>
                    <FormRow label={t('automations.slide_fields.chart_type', 'Chart type')}>
                        <select value={draft.chartType || 'column'} onChange={(e) => set('chartType', e.target.value)} className={inputClass()} data-testid="slide-chart-type">
                            {CHART_TYPE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                    </FormRow>
                    <FormRow label={t('automations.slide_fields.data', 'Data')} required hint={'The rows of a datatable or query step, a "|" table, or "label: value" lines. Columns are picked automatically: the first text column labels, every number column becomes a series.'}>
                        <TemplateField
                            value={draft.chartData || ''}
                            onChange={(next) => set('chartData', next)}
                            rows={3}
                            onFocusField={onFocusField}
                            previewSample={previewSample}
                            placeholder={'{{steps.query_1.output.rows}}'}
                        />
                    </FormRow>
                    <div className="grid grid-cols-2 gap-2">
                        <FormRow label={t('automations.slide_fields.label_column', 'Label column')} hint="Optional.">
                            <input value={draft.chartLabels || ''} onChange={(e) => set('chartLabels', e.target.value)} className={inputClass()} placeholder={t('automations.slide_fields.maand', 'maand')} data-testid="slide-chart-labels" />
                        </FormRow>
                        <FormRow label={t('automations.slide_fields.value_columns', 'Value columns')} hint={t('automations.slide_fields.optional_comma_separated', 'Optional, comma-separated.')}>
                            <input value={draft.chartValues || ''} onChange={(e) => set('chartValues', e.target.value)} className={inputClass()} placeholder={t('automations.slide_fields.omzet_kosten', 'omzet, kosten')} data-testid="slide-chart-values" />
                        </FormRow>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <FormRow label={t('automations.slide_fields.unit', 'Unit')} hint={t('automations.slide_fields.shown_on_the_axis_e_g', 'Shown on the axis, e.g. % or €.')}>
                            <input value={draft.chartUnit || ''} onChange={(e) => set('chartUnit', e.target.value)} className={inputClass()} placeholder="%" />
                        </FormRow>
                        <FormRow label={t('automations.slide_fields.stacked', 'Stacked')}>
                            <label className="inline-flex items-center gap-2 text-sm h-9">
                                <input type="checkbox" checked={!!draft.chartStacked} onChange={(e) => set('chartStacked', e.target.checked)} />
                                <span>{t('automations.slide_fields.stack_the_series', 'Stack the series')}</span>
                            </label>
                        </FormRow>
                    </div>
                </>
            )}
            {visual === 'stats' && (
                <FormRow label={t('automations.slide_fields.tiles', 'Tiles')} required hint={'One tile per line: value | label | change (change is optional). At most four.'}>
                    <TemplateField
                        value={draft.stats || ''}
                        onChange={(next) => set('stats', next)}
                        rows={4}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder={'{{steps.totals.output.revenue}} | Omzet | +12%\n{{steps.totals.output.customers}} | Klanten'}
                    />
                </FormRow>
            )}
            {visual === 'image' && (
                <FormRow label={t('automations.slide_fields.image', 'Image')} hint={t('automations.slide_fields.the_image_url_a_generate_image', 'The image URL a Generate image step produced, or a data: URL. Remote pictures are not fetched.')}>
                    <TemplateField
                        value={draft.image || ''}
                        onChange={(next) => set('image', next)}
                        rows={1}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder="{{steps.image_1.output.imageUrl}}"
                    />
                </FormRow>
            )}
            {visual === 'timeline' && (
                <SectionNote>{t('automations.slide_fields.the_bullets_in_the_content_become', 'The bullets in the content become numbered steps — write each as “Title — what happens”. Up to six.')}</SectionNote>
            )}
        </>
    );
}

/**
 * Slide — one slide as a value. Title and content are templates; the layout
 * is picked from what the content contains unless the author forces one.
 * "One per item" (forEach) is the shape this step exists for.
 */
function SlideFields({ draft, set, groups = [], onFocusField, previewSample, errorSections = new Set() }) {
    const { t } = useTranslation();
    return (
        <>
            <AccordionSection stepType="slide" sectionKey="content" title={t('automations.slide_fields.slide', 'Slide')} defaultOpen forceOpen={errorSections.has('content')}>
                <FormRow label={t('automations.slide_fields.title', 'Title')} required hint={t('automations.slide_fields.the_slide_heading_click_a_value', 'The slide heading. Click a value in the right panel to insert it.')}>
                    <TemplateField
                        value={draft.title || ''}
                        onChange={(next) => set('title', next)}
                        rows={1}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder="{{loop.row.name}}"
                    />
                </FormRow>
                <FormRow label={t('automations.slide_fields.content', 'Content')} hint={'Markdown: "- " bullets (two spaces in front = sub-point), a paragraph, a "|" table, a "> " quote. A list bound here becomes bullets.'}>
                    <TemplateField
                        value={draft.content || ''}
                        onChange={(next) => set('content', next)}
                        rows={5}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder={'- Omzet: {{loop.row.omzet}}\n- Marge: {{loop.row.marge}}'}
                        listAs="markdown"
                    />
                </FormRow>
                <SlideVisualFields draft={draft} set={set} onFocusField={onFocusField} previewSample={previewSample} />
            </AccordionSection>

            <AccordionSection stepType="slide" sectionKey="options" title={t('automations.slide_fields.options', 'Options')} defaultOpen={!!draft.forEach || retryIsSet(draft)} forceOpen={errorSections.has('options')} hasContent={!!draft.forEach || retryIsSet(draft) || !!draft.notes || !!draft.style || (draft.layout && draft.layout !== 'auto')}>
                <FormRow label={t('automations.slide_fields.speaker_notes', 'Speaker notes')} hint={t('automations.slide_fields.what_the_presenter_says_shown_in', 'What the presenter says — shown in the notes pane, not on the slide.')}>
                    <TemplateField
                        value={draft.notes || ''}
                        onChange={(next) => set('notes', next)}
                        rows={2}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                    />
                </FormRow>
                <FormRow label={t('automations.slide_fields.layout', 'Layout')}>
                    <select value={draft.layout || 'auto'} onChange={(e) => set('layout', e.target.value)} className={inputClass()}>
                        {SLIDE_LAYOUT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                </FormRow>
                <FormRow label={t('automations.slide_fields.slide_style', 'Slide style')} hint={t('automations.slide_fields.paint_this_one_slide_in_the', 'Paint this one slide in the accent colour or dark — for a key message. The deck\'s look stays as it is.')}>
                    <select value={draft.style || ''} onChange={(e) => set('style', e.target.value)} className={inputClass()} data-testid="slide-style">
                        <option value="">{t('automations.slide_fields.like_the_deck', 'Like the deck')}</option>
                        <option value="accent">{t('automations.slide_fields.accent_colour', 'Accent colour')}</option>
                        <option value="dark">{t('automations.slide_fields.dark', 'Dark')}</option>
                    </select>
                </FormRow>
                <ForEachSection draft={draft} set={set} groups={groups} onFocusField={onFocusField} />
                <RetrySection draft={draft} set={set} />
            </AccordionSection>
        </>
    );
}

export { SlideFields };
