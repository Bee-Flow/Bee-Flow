/**
 * Builder tools — the steps that produce a FILE the author keeps: a rendered
 * document (generate_document), a designed one filled with this run's values
 * (fill_document), one slide, and the deck those slides become
 * (presentation) with its look.
 */

const { newId, appendAfter } = require('../draftGraph');
const { sanitizeForEach } = require('../bindings');
const { bindingToTemplate } = require('./inputBindings');

/**
 * Render upstream text into a PDF or Word file.
 *
 * The default label MUST stay in step with nodeDefs.js's `defaultLabel` for
 * this type — nodeDefs.serverLabels.test.js reads both and compares them, so a
 * node added here and named differently on the canvas fails the build.
 */
function applyAddGenerateDocument(draft, args) {
    // No forEach: validate.js's FOREACH_ALLOWED does not include this type, so
    // accepting one here would mint a step the validator immediately rejects.
    // Per-row documents go in a loop body.
    if (!args.content || typeof args.content !== 'string') {
        return { error: 'content is required — bind it to the text an earlier step produced, e.g. {{steps.ai_1.output.text}}' };
    }
    const format = args.format === 'docx' ? 'docx' : 'pdf';
    const step = {
        id: newId('doc'),
        type: 'generate_document',
        content: args.content,
        contentFormat: args.contentFormat === 'html' ? 'html' : 'markdown',
        format,
        // 'slides' renders the PDF as a landscape deck (h1 = cover, each h2 a
        // slide). Absent/anything-else = the linear document every existing
        // step already produces.
        ...(args.layout === 'slides' ? { layout: 'slides' } : {}),
        title: typeof args.title === 'string' ? args.title : '',
        fileName: typeof args.fileName === 'string' ? args.fileName : '',
        expiresInDays: Number.isFinite(Number(args.expiresInDays)) ? clampDocumentTtl(args.expiresInDays) : 7,
        label: args.label || 'Make a document',
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step };
}

/**
 * Fill a DESIGNED document (an invoice, a quote, a letter on letterhead) with
 * this run's values and keep the PDF.
 *
 * The gate mirrors applyAddDatatable's: with a catalog (draftWrap._documents,
 * the "Documents you may fill" block) the id must name a real document of this
 * user's, and the keys in `values` are checked against the placeholders that
 * document actually has. Without a catalog (null — the store could not tell)
 * the args are kept as sent, the same permissive posture every other gate
 * takes when it cannot tell.
 *
 * An unknown key is a NOTE, not an error: a template the person edits by hand
 * can gain a placeholder a minute after the catalog was read, and refusing the
 * whole step over a name would cost the build. A key nobody can use simply
 * fills nothing, and `fill_document`'s output reports the holes that stayed
 * empty — which is where a wrong name actually becomes visible.
 *
 * The default label MUST stay in step with nodeDefs.js's `defaultLabel` for
 * this type — nodeDefs.serverLabels.test.js reads both and compares them.
 */
function applyAddFillDocument(draft, args, draftWrap) {
    const documentId = typeof args.documentId === 'string' ? args.documentId.trim() : '';
    if (!documentId) {
        return { error: 'documentId is required — pick one of the documents in the "Documents you may fill" block. If the user has none, tell them to design it in Studio → Documents first (or use builder_add_generate_document for plain text).' };
    }
    const notes = [];
    const catalog = draftWrap?._documents;
    if (Array.isArray(catalog)) {
        if (!catalog.length) {
            return { error: 'This user has no designed documents, so there is nothing to fill. Tell them to design one in Studio → Documents first, or use builder_add_generate_document to render plain text into a PDF. Do not retry.' };
        }
        const doc = catalog.find(d => d && d.id === documentId);
        if (!doc) {
            return { error: `No document with id "${documentId}". Use one of: ${catalog.map(d => `${d.id} ("${d.name}")`).join(', ')}.` };
        }
        const holes = new Set((doc.parameters || doc.placeholders || []).map(p => p.key));
        for (const key of Object.keys(args.values || {})) {
            if (!holes.has(key)) notes.push(`"${key}" is not a placeholder in "${doc.name}" — it will not appear in the document. Its placeholders are: ${[...holes].join(', ') || '(none)'}.`);
        }
        for (const p of (doc.placeholders || [])) {
            if (!Object.hasOwn(args.values || {}, p.key)) notes.push(`"${p.key}" has no value bound, so it prints blank in "${doc.name}".`);
        }
    }

    const values = {};
    if (args.values && typeof args.values === 'object' && !Array.isArray(args.values)) {
        for (const [k, v] of Object.entries(args.values)) {
            // Values are template strings or bindings, exactly as everywhere
            // else; a binding object is flattened to the {{…}} form the step
            // resolves, so the editor shows one vocabulary.
            values[k] = v && typeof v === 'object' && v.kind ? bindingToTemplate(v) : v;
        }
    }

    // The document's NAME rides along when the catalog knows it: the canvas
    // card and the editor header read it, so an AI-built step is labelled the
    // same way a hand-built one is. Advisory only — the runner resolves the id.
    const documentName = Array.isArray(catalog) ? (catalog.find(d => d && d.id === documentId)?.name || '') : '';

    const step = {
        id: newId('fdoc'),
        type: 'fill_document',
        documentId,
        documentVersionId: args.documentVersionId || draftWrap?._documentContracts?.[documentId]?.versionId || catalog?.find(d => d.id === documentId)?.versionId,
        ...(args.sectionOverrides ? { sectionOverrides: args.sectionOverrides } : {}),
        ...(documentName ? { documentName } : {}),
        values,
        fileName: typeof args.fileName === 'string' ? args.fileName : '',
        expiresInDays: Number.isFinite(Number(args.expiresInDays)) ? clampDocumentTtl(args.expiresInDays) : 7,
        ...(args.saveCopy === true ? { saveCopy: true } : {}),
        ...(args.format === 'pdf' || args.format === 'pptx' ? { format: args.format } : {}),
        label: args.label || 'Fill a document',
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step, ...(notes.length ? { _warnings: notes } : {}) };
}

/** Same window validate.js enforces (1..90 days). */
function clampDocumentTtl(v) {
    return Math.min(90, Math.max(1, Math.round(Number(v))));
}

// The slide vocabulary the validator accepts (validate/constants.js
// SLIDE_LAYOUTS); 'auto' is the absence of a choice and is not stored.
const SLIDE_LAYOUT_CHOICES = new Set(['title', 'section', 'bullets', 'two_column', 'cards', 'table', 'image', 'quote', 'chart', 'stats', 'timeline', 'closing']);

const COLOUR_OR_TEMPLATE = (v) => typeof v === 'string' && v.trim() && (/\{\{/.test(v) || /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim())) ? v.trim() : undefined;

/** The deck-look fields of a presentation step, each only when valid. */
function deckLookFields(args) {
    const { DECK_PRESET_IDS, COVER_STYLES, TABLE_STYLES, DECK_FONTS, LOGO_PLACEMENTS } = require('../../../core/documents/deckThemeOptions');
    const font = (v) => (typeof v === 'string' ? DECK_FONTS.find((x) => x.toLowerCase() === v.trim().toLowerCase()) : undefined);
    const out = {};
    if (DECK_PRESET_IDS.includes(args.preset)) out.preset = args.preset;
    const accent = COLOUR_OR_TEMPLATE(args.accent); if (accent) out.accent = accent;
    const background = COLOUR_OR_TEMPLATE(args.background); if (background) out.background = background;
    const f = font(args.font); if (f) out.font = f;
    const tf = font(args.titleFont); if (tf) out.titleFont = tf;
    if (Object.prototype.hasOwnProperty.call(COVER_STYLES, args.coverStyle)) out.coverStyle = args.coverStyle;
    if (Object.prototype.hasOwnProperty.call(TABLE_STYLES, args.tableStyle)) out.tableStyle = args.tableStyle;
    if (Object.prototype.hasOwnProperty.call(LOGO_PLACEMENTS, args.logoPlacement)) out.logoPlacement = args.logoPlacement;
    if (typeof args.logo === 'string' && args.logo.trim()) out.logo = args.logo.trim();
    if (typeof args.footerText === 'string' && args.footerText.trim()) out.footerText = args.footerText.trim();
    if (typeof args.slideNumbers === 'boolean') out.slideNumbers = args.slideNumbers;
    if (args.template === 'none' || args.template === false) out.template = 'none';
    return out;
}

/**
 * The visual fields of a slide step: `chart` {type, data, labels?, values?,
 * stacked?, unit?} (data kept as given — a template, a binding, rows), `stats`
 * (lines, a list, or a binding) and `style`. Each only when it holds something.
 */
function slideVisualFields(args) {
    const { CHART_TYPES, SLIDE_STYLES } = require('../../../core/documents/deckChart');
    const out = {};
    const c = args.chart;
    if (c && typeof c === 'object' && !Array.isArray(c)) {
        const type = typeof c.type === 'string' && CHART_TYPES.includes(c.type.trim().toLowerCase()) ? c.type.trim().toLowerCase() : 'column';
        let data = c.data;
        if (data && typeof data === 'object' && !Array.isArray(data) && data.kind) data = bindingToTemplate(data);
        const hasData = data !== undefined && data !== null && !(typeof data === 'string' && !data.trim()) && !(Array.isArray(data) && !data.length);
        if (hasData || Array.isArray(c.series)) {
            out.chart = { type, ...(hasData ? { data } : { series: c.series, ...(Array.isArray(c.labels) ? { labels: c.labels } : {}) }) };
            if (typeof c.labels === 'string' && c.labels.trim()) out.chart.labels = c.labels.trim();
            if (typeof c.values === 'string' && c.values.trim()) out.chart.values = c.values.trim();
            else if (Array.isArray(c.values) && c.values.length) out.chart.values = c.values.map(String).join(',');
            if (c.stacked === true) out.chart.stacked = true;
            if (typeof c.unit === 'string' && c.unit.trim()) out.chart.unit = c.unit.trim().slice(0, 12);
        }
    } else if (typeof c === 'string' && c.trim() && CHART_TYPES.includes(c.trim().toLowerCase())) {
        // "chart the table in the content"
        out.chart = { type: c.trim().toLowerCase() };
    }
    const st = args.stats;
    if (st && typeof st === 'object' && !Array.isArray(st) && st.kind) out.stats = bindingToTemplate(st);
    else if ((typeof st === 'string' && st.trim()) || (Array.isArray(st) && st.length)) out.stats = st;
    if (SLIDE_STYLES.includes(args.style)) out.style = args.style;
    return out;
}

/**
 * One slide of a presentation — an object, never a file. forEach IS allowed
 * (validate.js's FOREACH_ALLOWED lists 'slide'): "one slide per row" is the
 * shape this step exists for.
 *
 * The default label MUST stay in step with nodeDefs.js's `defaultLabel` for
 * this type — nodeDefs.serverLabels.test.js reads both and compares them.
 */
function applyAddSlide(draft, args) {
    const title = typeof args.title === 'string' ? args.title : '';
    const content = typeof args.content === 'string' ? args.content : '';
    const image = typeof args.image === 'string' ? args.image.trim() : '';
    const visuals = slideVisualFields(args);
    if (!title.trim() && !content.trim() && !image && !visuals.chart && !visuals.stats) {
        return { error: 'A slide needs a title or some content — e.g. title:"{{steps.extract.output.name}}", content:"- {{steps.extract.output.point}}".' };
    }
    const { forEach, error: feErr } = sanitizeForEach(args.forEach, draft);
    if (feErr) return { error: feErr };
    const step = {
        id: newId('slide'),
        type: 'slide',
        title,
        content,
        notes: typeof args.notes === 'string' ? args.notes : '',
        ...(SLIDE_LAYOUT_CHOICES.has(args.layout) ? { layout: args.layout } : {}),
        ...(image ? { image } : {}),
        ...visuals,
        label: args.label || 'Slide',
        ...(forEach ? { forEach } : {}),
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step };
}

/**
 * Turn slides into a .pptx (or a PDF deck) and keep the file. `slides` is kept
 * exactly as given — a template string or a list — because the executor's
 * collector (core/documents/deckCollect.js) is what gives it its three
 * meanings; flattening it here would take one of them away.
 *
 * No forEach: like generate_document, one deck per run. Per-row DECKS go in a
 * loop body; per-row SLIDES are a slide step with forEach.
 *
 * The default label MUST stay in step with nodeDefs.js's `defaultLabel`.
 */
function applyAddPresentation(draft, args) {
    const slides = args.slides;
    const blank = slides === undefined || slides === null
        || (typeof slides === 'string' && !slides.trim())
        || (Array.isArray(slides) && slides.length === 0);
    if (blank) {
        return { error: 'slides is required — bind it to the outline an ai_step wrote ({{steps.write.output.text}}), to a list of slide references, or to a loop\'s results.' };
    }
    if (typeof slides !== 'string' && !Array.isArray(slides) && !(slides && typeof slides === 'object')) {
        return { error: 'slides must be a template string or a list.' };
    }
    const step = {
        id: newId('deck'),
        type: 'presentation',
        title: typeof args.title === 'string' ? args.title : '',
        subtitle: typeof args.subtitle === 'string' ? args.subtitle : '',
        slides: slides && typeof slides === 'object' && !Array.isArray(slides) && slides.kind ? bindingToTemplate(slides) : slides,
        fileName: typeof args.fileName === 'string' ? args.fileName : '',
        format: args.format === 'pdf' ? 'pdf' : 'pptx',
        houseStyle: args.houseStyle !== false,
        // The look: only what was given AND valid lands on the step; the
        // house style fills the rest at run time.
        ...deckLookFields(args),
        ...(args.saveCopy === true ? { saveCopy: true } : {}),
        expiresInDays: Number.isFinite(Number(args.expiresInDays)) ? clampDocumentTtl(args.expiresInDays) : 7,
        label: args.label || 'Presentation',
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step };
}

module.exports = {
    applyAddGenerateDocument,
    applyAddFillDocument,
    clampDocumentTtl,
    deckLookFields,
    slideVisualFields,
    applyAddSlide,
    applyAddPresentation,
};
