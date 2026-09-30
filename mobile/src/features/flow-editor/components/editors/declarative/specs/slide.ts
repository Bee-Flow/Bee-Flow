/**
 * Slide — the web's SlideFields (actionEditors/slideFields.jsx): one slide as
 * a value. The visual picker is a view over the stored fields (formState
 * derives it), so a slide the AI built with a chart opens on "Chart"; the
 * patch keeps exactly one visual.
 */

import type { FormDraft } from '@/features/flow-editor/formState';

import { msg, type EditorSpec, type OptionSpec } from '../spec';
import { FOR_EACH, repeatsOrRetries, retryIsSet, RETRY } from './common';

/** The web's SLIDE_LAYOUT_OPTIONS, in its order. */
export const SLIDE_LAYOUTS: readonly OptionSpec[] = [
    { value: 'auto', label: msg('mobile.flow.slide.layout_auto', 'Pick from the content') },
    { value: 'bullets', label: msg('mobile.flow.slide.layout_bullets', 'Title + bullets') },
    { value: 'section', label: msg('mobile.flow.slide.layout_section', 'Section divider (title only)') },
    { value: 'two_column', label: msg('mobile.flow.slide.layout_two_column', 'Two columns') },
    { value: 'cards', label: msg('mobile.flow.slide.layout_cards', 'Cards (3–4 sub-headings)') },
    { value: 'table', label: msg('mobile.flow.slide.layout_table', 'Table') },
    { value: 'image', label: msg('mobile.flow.slide.layout_image', 'Image') },
    { value: 'quote', label: msg('mobile.flow.slide.layout_quote', 'Quote') },
    { value: 'chart', label: msg('mobile.flow.slide.layout_chart', 'Chart') },
    { value: 'stats', label: msg('mobile.flow.slide.layout_stats', 'KPI tiles') },
    { value: 'timeline', label: msg('mobile.flow.slide.layout_timeline', 'Timeline / steps') },
    { value: 'title', label: msg('mobile.flow.slide.layout_title', 'Title slide') },
    { value: 'closing', label: msg('mobile.flow.slide.layout_closing', 'Closing slide') },
];

/** The web's SLIDE_VISUAL_OPTIONS. */
export const SLIDE_VISUALS: readonly OptionSpec[] = [
    { value: 'none', label: msg('mobile.flow.slide.visual_none', 'None — text only') },
    { value: 'chart', label: msg('mobile.flow.slide.visual_chart', 'Chart') },
    { value: 'stats', label: msg('mobile.flow.slide.visual_stats', 'KPI tiles') },
    { value: 'image', label: msg('mobile.flow.slide.visual_image', 'Image') },
    { value: 'timeline', label: msg('mobile.flow.slide.visual_timeline', 'Timeline / steps') },
];

/** The web's CHART_TYPE_OPTIONS. */
export const CHART_TYPES: readonly OptionSpec[] = [
    { value: 'column', label: msg('mobile.flow.slide.chart_column', 'Column') },
    { value: 'bar', label: msg('mobile.flow.slide.chart_bar', 'Bar (horizontal)') },
    { value: 'line', label: msg('mobile.flow.slide.chart_line', 'Line') },
    { value: 'area', label: msg('mobile.flow.slide.chart_area', 'Area') },
    { value: 'pie', label: msg('mobile.flow.slide.chart_pie', 'Pie') },
    { value: 'donut', label: msg('mobile.flow.slide.chart_donut', 'Donut') },
];

const visual = (draft: FormDraft) => String(draft.visual || 'none');
const chart = (draft: FormDraft) => visual(draft) === 'chart';

export const SLIDE: EditorSpec = {
    type: 'slide',
    sections: [
        {
            key: 'content',
            title: msg('mobile.flow.slide.section', 'Slide'),
            defaultOpen: true,
            fields: [
                {
                    kind: 'template',
                    key: 'title',
                    required: true,
                    example: '{{loop.row.name}}',
                    label: msg('mobile.flow.slide.title', 'Title'),
                    hint: msg('mobile.flow.slide.title_hint', 'The slide heading.'),
                },
                {
                    kind: 'template',
                    key: 'content',
                    multiline: true,
                    example: '- Omzet: {{loop.row.omzet}}\n- Marge: {{loop.row.marge}}',
                    label: msg('mobile.flow.slide.content', 'Content'),
                    hint: msg(
                        'mobile.flow.slide.content_hint',
                        'Markdown: "- " bullets (two spaces in front = sub-point), a paragraph, a "|" table, a "> " quote. A list bound here becomes bullets.',
                    ),
                },
                {
                    kind: 'select',
                    key: 'visual',
                    label: msg('mobile.flow.slide.visual', 'Visual'),
                    hint: msg('mobile.flow.slide.visual_hint', 'A chart from data rows, headline figures as tiles, a picture, or the bullets as numbered steps.'),
                    options: SLIDE_VISUALS,
                },
                { kind: 'select', key: 'chartType', visibleWhen: chart, label: msg('mobile.flow.slide.chart_type', 'Chart type'), options: CHART_TYPES },
                {
                    kind: 'template',
                    key: 'chartData',
                    multiline: true,
                    required: true,
                    visibleWhen: chart,
                    example: '{{steps.query_1.output.rows}}',
                    label: msg('mobile.flow.slide.data', 'Data'),
                    hint: msg(
                        'mobile.flow.slide.data_hint',
                        'The rows of a datatable or query step, a "|" table, or "label: value" lines. Columns are picked automatically: the first text column labels, every number column becomes a series.',
                    ),
                },
                { kind: 'text', key: 'chartLabels', visibleWhen: chart, example: 'maand', label: msg('mobile.flow.slide.labels', 'Label column'), hint: msg('mobile.flow.slide.optional', 'Optional.') },
                {
                    kind: 'text',
                    key: 'chartValues',
                    visibleWhen: chart,
                    example: 'omzet, kosten',
                    label: msg('mobile.flow.slide.values', 'Value columns'),
                    hint: msg('mobile.flow.slide.values_hint', 'Optional, comma-separated.'),
                },
                { kind: 'text', key: 'chartUnit', visibleWhen: chart, example: '%', label: msg('mobile.flow.slide.unit', 'Unit'), hint: msg('mobile.flow.slide.unit_hint', 'Shown on the axis, e.g. % or €.') },
                { kind: 'toggle', key: 'chartStacked', visibleWhen: chart, label: msg('mobile.flow.slide.stacked', 'Stack the series') },
                {
                    kind: 'template',
                    key: 'stats',
                    multiline: true,
                    required: true,
                    visibleWhen: (draft) => visual(draft) === 'stats',
                    example: '{{steps.totals.output.revenue}} | Omzet | +12%\n{{steps.totals.output.customers}} | Klanten',
                    label: msg('mobile.flow.slide.tiles', 'Tiles'),
                    hint: msg('mobile.flow.slide.tiles_hint', 'One tile per line: value | label | change (change is optional). At most four.'),
                },
                {
                    kind: 'template',
                    key: 'image',
                    visibleWhen: (draft) => visual(draft) === 'image',
                    example: '{{steps.image_1.output.imageUrl}}',
                    label: msg('mobile.flow.slide.image', 'Image'),
                    hint: msg('mobile.flow.slide.image_hint', 'The image URL a Generate image step produced, or a data: URL. Remote pictures are not fetched.'),
                },
                {
                    kind: 'note',
                    id: 'timeline',
                    visibleWhen: (draft) => visual(draft) === 'timeline',
                    hint: msg('mobile.flow.slide.timeline_note', 'The bullets in the content become numbered steps — write each as “Title — what happens”. Up to six.'),
                },
            ],
        },
        {
            key: 'options',
            title: msg('mobile.flow.section.options', 'Options'),
            defaultOpen: repeatsOrRetries,
            hasContent: (draft) =>
                !!draft.forEach || retryIsSet(draft) || !!draft.notes || !!draft.style || (!!draft.layout && draft.layout !== 'auto'),
            fields: [
                {
                    kind: 'template',
                    key: 'notes',
                    multiline: true,
                    label: msg('mobile.flow.slide.notes', 'Speaker notes'),
                    hint: msg('mobile.flow.slide.notes_hint', 'What the presenter says — shown in the notes pane, not on the slide.'),
                },
                { kind: 'select', key: 'layout', label: msg('mobile.flow.slide.layout', 'Layout'), options: SLIDE_LAYOUTS },
                {
                    kind: 'select',
                    key: 'style',
                    label: msg('mobile.flow.slide.style', 'Slide style'),
                    hint: msg('mobile.flow.slide.style_hint', 'Paint this one slide in the accent colour or dark — for a key message. The deck’s look stays as it is.'),
                    options: [
                        { value: '', label: msg('mobile.flow.slide.style_deck', 'Like the deck') },
                        { value: 'accent', label: msg('mobile.flow.slide.style_accent', 'Accent colour') },
                        { value: 'dark', label: msg('mobile.flow.slide.style_dark', 'Dark') },
                    ],
                },
                FOR_EACH,
                RETRY,
            ],
        },
    ],
};
