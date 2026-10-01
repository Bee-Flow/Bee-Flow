/**
 * The steps that produce a FILE a person opens: a generated document, a
 * template filled with values, a single slide, and the presentation that
 * collects slides into a deck.
 *
 * They share a download link with a time to live, and the deck and the filled
 * document share a format vocabulary — which is why `fill_document` reads the
 * presentation's list rather than a copy of it.
 */

const { isObject, hasText } = require('../helpers');
const {
    GENERATE_DOCUMENT_FORMATS, GENERATE_DOCUMENT_CONTENT_FORMATS,
    GENERATE_DOCUMENT_MIN_TTL_DAYS, GENERATE_DOCUMENT_MAX_TTL_DAYS,
    FILL_DOCUMENT_MAX_VALUES,
    PRESENTATION_FORMATS, SLIDE_LAYOUTS, PRESENTATION_MAX_SLIDES,
    PRESENTATION_PRESETS, PRESENTATION_COVER_STYLES, PRESENTATION_TABLE_STYLES,
    PRESENTATION_FONTS, PRESENTATION_LOGO_PLACEMENTS,
    SLIDE_CHART_TYPES, SLIDE_STYLES, SLIDE_MAX_STATS,
} = require('../constants');

function checkGenerateDocument(ctx, step, at) {
    const { pushE } = ctx;
    if (step.type === 'generate_document') {
        if (!step.content || !(typeof step.content === 'string' || hasText(step.content))) {
            pushE({ code: 'generate_document.content_missing', severity: 'error', path: at + '.content', message: `Step ${step.id}: there is no text to put in the document.`, hint: 'Point this at the text an earlier step produced, e.g. {{steps.ai_1.output.text}}.' });
        }
        if (step.format !== undefined && !GENERATE_DOCUMENT_FORMATS.has(step.format)) {
            pushE({ code: 'generate_document.format', severity: 'error', path: at + '.format', message: `Step ${step.id}: "${step.format}" is not a document format.`, hint: `Use one of: ${[...GENERATE_DOCUMENT_FORMATS].join(', ')}.` });
        }
        if (step.contentFormat !== undefined && !GENERATE_DOCUMENT_CONTENT_FORMATS.has(step.contentFormat)) {
            pushE({ code: 'generate_document.content_format', severity: 'error', path: at + '.contentFormat', message: `Step ${step.id}: contentFormat must be "markdown" or "html".`, hint: 'Most steps produce markdown; pick html only if the text upstream is already markup.' });
        }
        if (step.layout !== undefined && step.layout !== 'document' && step.layout !== 'slides') {
            pushE({ code: 'generate_document.layout', severity: 'error', path: at + '.layout', message: `Step ${step.id}: layout must be "document" or "slides".`, hint: '"slides" turns a PDF into a landscape deck: the h1 becomes the cover, every h2 its own slide. Word output stays a linear document either way.' });
        }
        if (step.expiresInDays !== undefined) {
            const d = Number(step.expiresInDays);
            if (!Number.isFinite(d) || d < GENERATE_DOCUMENT_MIN_TTL_DAYS || d > GENERATE_DOCUMENT_MAX_TTL_DAYS) {
                pushE({ code: 'generate_document.expiry_range', severity: 'error', path: at + '.expiresInDays', message: `Step ${step.id}: expiresInDays must be ${GENERATE_DOCUMENT_MIN_TTL_DAYS}..${GENERATE_DOCUMENT_MAX_TTL_DAYS}.`, hint: 'How long the download link keeps working. The file is deleted after that.' });
            }
        }
    }
}

function checkFillDocument(ctx, step, at) {
    const { pushE } = ctx;
    if (step.type === 'fill_document') {
        if (!step.documentId || typeof step.documentId !== 'string') {
            pushE({ code: 'fill_document.document_missing', severity: 'error', path: at + '.documentId', message: `Step ${step.id}: no document is selected, so there is nothing to fill.`, hint: 'Pick one of your documents from Studio → Documents; design it there first if it does not exist yet.' });
        }
        if (step.values !== undefined && (typeof step.values !== 'object' || step.values === null || Array.isArray(step.values))) {
            pushE({ code: 'fill_document.values_shape', severity: 'error', path: at + '.values', message: `Step ${step.id}: values must be an object of placeholder → value.`, hint: 'e.g. {"customer.name": "{{steps.extract.output.naam}}"}.' });
        }
        if (step.values && typeof step.values === 'object' && !Array.isArray(step.values)) {
            if (Object.keys(step.values).length > FILL_DOCUMENT_MAX_VALUES) {
                pushE({ code: 'fill_document.values_too_many', severity: 'error', path: at + '.values', message: `Step ${step.id}: ${Object.keys(step.values).length} values is more than the ${FILL_DOCUMENT_MAX_VALUES} a document may be filled with.`, hint: 'A document is a page of paper — if this many values belong together, they are probably a list placeholder.' });
            }
        }
        if (step.expiresInDays !== undefined) {
            const d = Number(step.expiresInDays);
            if (!Number.isFinite(d) || d < GENERATE_DOCUMENT_MIN_TTL_DAYS || d > GENERATE_DOCUMENT_MAX_TTL_DAYS) {
                pushE({ code: 'fill_document.expiry_range', severity: 'error', path: at + '.expiresInDays', message: `Step ${step.id}: expiresInDays must be ${GENERATE_DOCUMENT_MIN_TTL_DAYS}..${GENERATE_DOCUMENT_MAX_TTL_DAYS}.`, hint: 'How long the download link keeps working. The file is deleted after that.' });
            }
        }
        // The format only matters for a presentation document (pptx or the
        // PDF deck); a page document ignores it. The vocabulary is the
        // presentation step's.
        if (step.format !== undefined && step.format !== '' && !PRESENTATION_FORMATS.has(step.format)) {
            pushE({ code: 'fill_document.format', severity: 'error', path: at + '.format', message: `Step ${step.id}: "${step.format}" is not a document format.`, hint: `Use one of: ${[...PRESENTATION_FORMATS].join(', ')} — only a presentation document takes it.` });
        }
    }
}

function checkSlide(ctx, step, at) {
    const { pushE } = ctx;
    if (step.type === 'slide') {
        const hasTitle = hasText(step.title);
        const hasContent = hasText(step.content);
        const hasImage = hasText(step.image);
        const hasVisual = (step.chart && typeof step.chart === 'object') || (typeof step.stats === 'string' && step.stats.trim()) || (Array.isArray(step.stats) && step.stats.length) || (step.stats && typeof step.stats === 'object' && typeof step.stats.kind === 'string');
        if (!hasTitle && !hasContent && !hasImage && !hasVisual) {
            pushE({ code: 'slide.content_missing', severity: 'error', path: at + '.content', message: `Step ${step.id}: the slide has no title, text or image yet.`, hint: 'Give it a title and some content — bullets ("- "), a paragraph, a "|" table, a "> " quote — bound to earlier steps, e.g. {{steps.extract.output.name}}.' });
        }
        if (step.layout !== undefined && !SLIDE_LAYOUTS.has(step.layout)) {
            pushE({ code: 'slide.layout', severity: 'error', path: at + '.layout', message: `Step ${step.id}: "${step.layout}" is not a slide layout.`, hint: `Use one of: ${[...SLIDE_LAYOUTS].join(', ')} — or leave it out to pick one from the content.` });
        }
        // Visuals: a chart names its data (rows, a table, "label: value"
        // lines — any binding); tiles are lines or a list; style is a tint.
        if (step.chart !== undefined && step.chart !== null && step.chart !== '') {
            const c = step.chart;
            if (!isObject(c)) {
                pushE({ code: 'slide.chart_shape', severity: 'error', path: at + '.chart', message: `Step ${step.id}: chart must be an object {type, data}.`, hint: 'E.g. {type:"bar", data:"{{steps.query.output.rows}}", labels:"maand", values:"omzet"}.' });
            } else {
                if (c.type !== undefined && c.type !== '' && !SLIDE_CHART_TYPES.has(String(c.type).toLowerCase())) {
                    pushE({ code: 'slide.chart_type', severity: 'error', path: at + '.chart.type', message: `Step ${step.id}: "${c.type}" is not a chart type.`, hint: `Use one of: ${[...SLIDE_CHART_TYPES].join(', ')}.` });
                }
                const d = c.data;
                const noData = d === undefined || d === null || (typeof d === 'string' && !d.trim()) || (Array.isArray(d) && !d.length);
                // A bare type may chart the table written in `content`.
                const tableInContent = typeof step.content === 'string' && /^\s*\|.*\|\s*$/m.test(step.content);
                if (noData && !Array.isArray(c.series) && !Array.isArray(c.labels) && !tableInContent) {
                    pushE({ code: 'slide.chart_data_missing', severity: 'error', path: at + '.chart.data', message: `Step ${step.id}: the chart has no data yet.`, hint: 'Bind chart.data to the rows of a datatable or query step ({{steps.query.output.rows}}), a markdown table, or "label: value" lines.' });
                }
            }
        }
        if (step.stats !== undefined && step.stats !== null && step.stats !== '' && typeof step.stats !== 'string' && !Array.isArray(step.stats) && !isObject(step.stats)) {
            pushE({ code: 'slide.stats_shape', severity: 'error', path: at + '.stats', message: `Step ${step.id}: stats must be lines "value | label | delta", a list, or a binding.`, hint: `At most ${SLIDE_MAX_STATS} tiles fit on a slide.` });
        }
        if (step.style !== undefined && step.style !== '' && !SLIDE_STYLES.has(step.style)) {
            pushE({ code: 'slide.style', severity: 'error', path: at + '.style', message: `Step ${step.id}: "${step.style}" is not a slide style.`, hint: `Use one of: ${[...SLIDE_STYLES].join(', ')} — or leave it out for the deck's normal look.` });
        }
    }
}

function checkPresentation(ctx, step, at) {
    const { pushE } = ctx;
    if (step.type === 'presentation') {
        const s = step.slides;
        const blank = s === undefined || s === null || (typeof s === 'string' && !s.trim()) || (Array.isArray(s) && s.length === 0);
        if (blank) {
            pushE({ code: 'presentation.slides_missing', severity: 'error', path: at + '.slides', message: `Step ${step.id}: there are no slides to put in the presentation yet.`, hint: 'Bind `slides` to the outline an ai_step wrote ({{steps.write.output.text}}), to a list of slide steps, or to a loop\'s results.' });
        } else if (typeof s !== 'string' && !Array.isArray(s) && !isObject(s)) {
            pushE({ code: 'presentation.slides_shape', severity: 'error', path: at + '.slides', message: `Step ${step.id}: slides must be a text binding, a list, or an object.`, hint: 'A markdown outline, a JSON deck, a list of {{steps.<slide>.output.slide}} references, or a loop output.' });
        } else if (Array.isArray(s) && s.length > PRESENTATION_MAX_SLIDES) {
            pushE({ code: 'presentation.slides_too_many', severity: 'error', path: at + '.slides', message: `Step ${step.id}: ${s.length} slides is more than the ${PRESENTATION_MAX_SLIDES} a presentation may hold.`, hint: 'A deck is something a person sits through — split it, or bind to fewer rows.' });
        }
        if (step.format !== undefined && !PRESENTATION_FORMATS.has(step.format)) {
            pushE({ code: 'presentation.format', severity: 'error', path: at + '.format', message: `Step ${step.id}: "${step.format}" is not a presentation format.`, hint: `Use one of: ${[...PRESENTATION_FORMATS].join(', ')}.` });
        }
        // The LOOK: each is optional (the house style decides), each a closed
        // list except `accent`, which is a template ("#RRGGBB" or a binding).
        for (const [key, table, label] of [['preset', PRESENTATION_PRESETS, 'style'], ['coverStyle', PRESENTATION_COVER_STYLES, 'cover style'], ['tableStyle', PRESENTATION_TABLE_STYLES, 'table style'], ['font', PRESENTATION_FONTS, 'typeface'], ['titleFont', PRESENTATION_FONTS, 'title typeface'], ['logoPlacement', PRESENTATION_LOGO_PLACEMENTS, 'logo placement']]) {
            if (step[key] !== undefined && step[key] !== '' && !table.has(step[key])) {
                pushE({ code: `presentation.${key}`, severity: 'error', path: `${at}.${key}`, message: `Step ${step.id}: "${step[key]}" is not a deck ${label}.`, hint: `Use one of: ${[...table].join(', ')} — or leave it out to follow the house style.` });
            }
        }
        for (const key of ['accent', 'background']) {
            if (step[key] !== undefined && step[key] !== '' && typeof step[key] === 'string' && !/\{\{/.test(step[key]) && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(step[key].trim())) {
                pushE({ code: `presentation.${key}`, severity: 'error', path: `${at}.${key}`, message: `Step ${step.id}: "${step[key]}" is not a colour.`, hint: 'Write it as #RRGGBB (e.g. #1A73E8), bind it to a value, or leave it out to follow the house style.' });
            }
        }
        if (step.logo !== undefined && step.logo !== '' && typeof step.logo !== 'string') {
            pushE({ code: 'presentation.logo', severity: 'error', path: at + '.logo', message: `Step ${step.id}: logo must be text — an image URL, a data: URL, or "none".`, hint: 'A Bee Flow storage URL (the imageUrl of a generate_image step), a data: URL, or "none" to leave the house-style logo off.' });
        }
        if (step.template !== undefined && step.template !== '' && step.template !== 'none') {
            pushE({ code: 'presentation.template', severity: 'error', path: at + '.template', message: `Step ${step.id}: template must be "none" or left out.`, hint: 'Leave it out to build on the house-style template deck; "none" gives plain slides.' });
        }
        if (step.slideNumbers !== undefined && step.slideNumbers !== '' && typeof step.slideNumbers !== 'boolean') {
            pushE({ code: 'presentation.slide_numbers', severity: 'error', path: at + '.slideNumbers', message: `Step ${step.id}: slideNumbers must be true or false.`, hint: 'Leave it out to follow the house style.' });
        }
        if (step.expiresInDays !== undefined) {
            const d = Number(step.expiresInDays);
            if (!Number.isFinite(d) || d < GENERATE_DOCUMENT_MIN_TTL_DAYS || d > GENERATE_DOCUMENT_MAX_TTL_DAYS) {
                pushE({ code: 'presentation.expiry_range', severity: 'error', path: at + '.expiresInDays', message: `Step ${step.id}: expiresInDays must be ${GENERATE_DOCUMENT_MIN_TTL_DAYS}..${GENERATE_DOCUMENT_MAX_TTL_DAYS}.`, hint: 'How long the download link keeps working. The file is deleted after that.' });
            }
        }
    }
}

module.exports = { checkGenerateDocument, checkFillDocument, checkSlide, checkPresentation };
