/**
 * Names a model reaches for that are NOT App Studio component types, mapped
 * to the type it means. Read by the batch normaliser (definitionTools) and by
 * the live tool-draft scanner (routes/ai/appStudioBuilder/toolDraft.js), so a
 * card being typed previews as the type it will land as.
 *
 * Only names that are not real types may appear here — `table` IS a type
 * (a static table) and must never be folded into data_grid. The guard test
 * checks every alias against componentSpecs.
 */

'use strict';

const COMPONENT_TYPE_ALIASES = Object.freeze({
    datatable: 'data_grid', data_table: 'data_grid', grid: 'data_grid', datagrid: 'data_grid', records: 'data_grid',
    textbox: 'input_text', text_input: 'input_text', textfield: 'input_text', input: 'input_text', text_field: 'input_text',
    textarea: 'input_textarea',
    dropdown: 'input_select', select: 'input_select',
    checkbox: 'input_checkbox',
    number: 'input_number', number_input: 'input_number', input_num: 'input_number',
    date: 'input_date', datepicker: 'input_date', date_input: 'input_date',
    kpi: 'stat', metric: 'stat', tile: 'stat', counter: 'stat', stat_tile: 'stat', statistic: 'stat',
    title: 'heading', h1: 'heading', h2: 'heading', h3: 'heading', header: 'heading',
    paragraph: 'text', label: 'text', body: 'text',
    bar_chart: 'chart', line_chart: 'chart', pie_chart: 'chart', graph: 'chart',
    detail: 'record_detail', record: 'record_detail',
    filters: 'filter_bar', filter: 'filter_bar', search_bar: 'filter_bar',
    section_header: 'page_header', page_title: 'page_header',
    panel: 'card', box: 'card',
    // The names a model uses for "put these together". A `container` with a
    // title is promoted to `card` by the normaliser right after this, so both
    // readings land: measured 2026-09-16, type "section" refused three whole
    // batches in one dashboard build.
    section: 'container', group: 'container', row: 'container', stack: 'container', wrapper: 'container', div: 'container', region: 'container',
    rich_text: 'input_richtext',
});

/**
 * The real type for a model-supplied type name (alias or not); null for
 * nothing usable. A name written with spaces or hyphens ("data grid",
 * "page-header") is the underscore type it spells — a small model reads the
 * catalog's `data_grid` and writes it back as prose.
 */
function canonicalComponentType(raw) {
    if (typeof raw !== 'string') return null;
    const t = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!t) return null;
    return COMPONENT_TYPE_ALIASES[t] || t;
}

module.exports = { COMPONENT_TYPE_ALIASES, canonicalComponentType };
