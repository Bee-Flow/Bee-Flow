/**
 * The presentation pair: `slide` (one slide, an object) and `presentation`
 * (slides in, a .pptx or PDF deck out, kept like a generate_document file).
 *
 * THE ONE RULE THAT MAKES `slides` FLEXIBLE: a string that is exactly one
 * `{{path}}` resolves to the REAL value at that path — an object stays an
 * object, an array stays an array. `interpolateTemplate` JSON-stringifies
 * objects, so without this rule `["{{steps.s1.output.slide}}"]` would arrive
 * as a list of JSON strings and every slide would print as one line of
 * braces. It is the same rule execFillDocument applies to a list placeholder,
 * applied recursively here because `slides` may be a list of such strings,
 * or objects whose values are. Mixed text ("Slide {{n}}") keeps the ordinary
 * interpolation.
 *
 * Everything the resolved value can be — an outline, a JSON deck, a list of
 * slide outputs, a loop's results, datatable rows — is one collector's job:
 * core/documents/deckCollect.js. The executor resolves bindings and keeps the
 * file; it never decides what a slide is.
 */

const { interpolateTemplate, walkPath, resolveValue } = require('../../automation/bind');
const { normalizeDeck, normalizeSlide } = require('../documents/deckModel');
const { collectDeck } = require('../documents/deckCollect');
const {
    safeDocumentName, keepGeneratedFile, resolveDocumentMarking, markingOutcome, orgOf,
    DOCUMENT_TTL_MIN_DAYS, DOCUMENT_TTL_MAX_DAYS, DOCUMENT_TTL_DEFAULT_DAYS,
} = require('./execDocument');
const log = require('../../telemetry/log');

const PRESENTATION_FORMATS = new Set(['pptx', 'pdf']);
const PRESENTATION_CONTENT_TYPES = Object.freeze({
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    pdf: 'application/pdf',
});
const SLIDE_LAYOUTS = new Set(['title', 'section', 'bullets', 'two_column', 'cards', 'table', 'image', 'quote', 'chart', 'stats', 'timeline', 'closing']);
const SLIDE_STYLES = new Set(['accent', 'dark']);
/** The presentation node's look fields that are templates (a colour, a logo reference, a footer line). */
const LOOK_TEMPLATE_FIELDS = ['accent', 'background', 'logo', 'footerText'];
/** The look fields that are closed choices — passed as-is when set. */
const LOOK_CHOICE_FIELDS = ['preset', 'font', 'titleFont', 'coverStyle', 'tableStyle', 'logoPlacement', 'template'];

/** A string that is exactly one `{{path}}` and nothing else. */
const SOLE_TOKEN_RE = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/;

/**
 * One bound value: a sole `{{path}}` keeps its real type, a binding wrapper
 * goes through resolveValue, mixed text is interpolated, anything else passes.
 */
function resolveBound(raw, runState) {
    if (raw === null || raw === undefined) return raw;
    if (typeof raw === 'object' && !Array.isArray(raw) && typeof raw.kind === 'string') return resolveValue(raw, runState);
    if (typeof raw !== 'string') return raw;
    const sole = SOLE_TOKEN_RE.exec(raw);
    if (sole) return walkPath(sole[1], runState);
    return interpolateTemplate(raw, runState);
}

/** `slides`, resolved recursively: strings by the sole-token rule, lists and objects element-wise. */
function resolveSlidesInput(raw, runState, depth = 0) {
    if (depth > 6) return raw;
    if (Array.isArray(raw)) return raw.map((x) => resolveSlidesInput(x, runState, depth + 1));
    if (raw && typeof raw === 'object') {
        if (typeof raw.kind === 'string') return resolveValue(raw, runState);
        const out = {};
        for (const [k, v] of Object.entries(raw)) out[k] = resolveSlidesInput(v, runState, depth + 1);
        return out;
    }
    return resolveBound(raw, runState);
}

// ── slide ───────────────────────────────────────────────────────────────

/**
 * One slide of a presentation. Pure: it produces an object, never a file, so
 * a dry run and a live run are the same run, and a forEach over rows costs
 * nothing but the slide objects the deck then collects.
 */
async function execSlide(step, ctx, runState) {
    const title = interpolateTemplate(step.title || '', runState).trim();
    // A list bound into the content becomes bullets rather than JSON — the
    // one place a routine author would otherwise have to write a loop.
    const content = interpolateTemplate(step.content || '', runState, { listAsMarkdown: true });
    const notes = interpolateTemplate(step.notes || '', runState).trim();
    const image = interpolateTemplate(step.image || '', runState).trim();
    const layout = SLIDE_LAYOUTS.has(step.layout) ? step.layout : null;

    // Visuals: chart.data and stats are bound by the sole-token rule so a
    // whole reference to rows stays rows; the collectors do the rest.
    let chart;
    if (step.chart && typeof step.chart === 'object' && !Array.isArray(step.chart)) {
        const c = step.chart;
        chart = { ...c };
        if (c.data !== undefined) chart.data = resolveSlidesInput(c.data, runState);
        for (const k of ['labels', 'values', 'unit']) if (typeof c[k] === 'string') chart[k] = interpolateTemplate(c[k], runState).trim();
        if (chart.data === undefined && !Array.isArray(chart.series)) chart = chart.type; // "chart the table" — a bare type
    } else if (typeof step.chart === 'string' && step.chart.trim()) {
        chart = step.chart.trim();
    }
    let stats;
    if (typeof step.stats === 'string' && step.stats.trim()) stats = resolveBound(step.stats, runState);
    else if (Array.isArray(step.stats) || (step.stats && typeof step.stats === 'object')) stats = resolveSlidesInput(step.stats, runState);
    const style = SLIDE_STYLES.has(step.style) ? step.style : undefined;

    const { slide, warnings } = normalizeSlide({
        title, content, notes: notes || undefined, layout: layout || undefined, image: image || undefined,
        ...(chart !== undefined ? { chart } : {}), ...(stats !== undefined ? { stats } : {}), ...(style ? { style } : {}),
    });
    return {
        output: {
            slide,
            ...(warnings.length ? { warnings } : {}),
        },
    };
}

// ── presentation ────────────────────────────────────────────────────────

/**
 * Turn whatever `slides` resolves to into a deck file and keep it for the
 * run. The output shape is generate_document's plus `slideCount`, so a form
 * page download field, an approval attachment and the Nextcloud/Drive upload
 * bridge take it unchanged.
 */
async function execPresentation(step, ctx, runState, mode) {
    const title = interpolateTemplate(step.title || '', runState).trim();
    const subtitle = interpolateTemplate(step.subtitle || '', runState).trim();
    const nameBinding = interpolateTemplate(step.fileName || '', runState).trim();
    const format = PRESENTATION_FORMATS.has(step.format) ? step.format : 'pptx';
    const mimeType = PRESENTATION_CONTENT_TYPES[format];
    const days = Number.isFinite(Number(step.expiresInDays)) ? Number(step.expiresInDays) : DOCUMENT_TTL_DEFAULT_DAYS;
    const ttlDays = Math.min(DOCUMENT_TTL_MAX_DAYS, Math.max(DOCUMENT_TTL_MIN_DAYS, Math.round(days)));

    // Collect and normalise FIRST, in every mode: a dry run that reports the
    // wiring works must have proven the slides actually resolve to a deck.
    const slidesRaw = resolveSlidesInput(step.slides, runState);
    let deck;
    try {
        const { deckInput, warnings } = collectDeck(slidesRaw, { title, subtitle });
        deck = normalizeDeck(deckInput);
        deck.warnings.unshift(...warnings);
    } catch (e) {
        const cls = e && e.errorClass;
        throw Object.assign(
            new Error(`presentation: ${e.message}`),
            { errorClass: cls === 'deck_empty' || cls === 'presentation_empty' ? 'presentation_empty' : (cls || 'presentation_invalid'), cause: e },
        );
    }

    const base = safeDocumentName(nameBinding || title || deck.title, 'presentation');
    const filename = `${base}.${format}`;
    const slideCount = deck.slides.length + 1;

    if (mode === 'dry_run') {
        return {
            output: {
                fileId: 'dry-run', filename, mimeType, size: 0, format, slideCount, degraded: false,
                marked: false, marking: markingOutcome(null, null),
                sourceHandle: { kind: 'generated_file', fileId: 'dry-run' },
                ...(deck.warnings.length ? { warnings: deck.warnings } : {}),
                _dryRun: true,
            },
            dryRunSynthesised: true,
        };
    }

    const storageStore = require('../../stores/storageStore');
    if (typeof storageStore.isAvailable === 'function' && !storageStore.isAvailable()) {
        throw Object.assign(
            new Error('presentation: file storage is not available, so the deck cannot be kept.'),
            { errorClass: 'storage_unavailable' },
        );
    }

    // Art. 50(2): mark the deck when model output went into it and the org marks.
    const marking = await resolveDocumentMarking(step, ctx, runState, 'presentation');

    // The look the author chose on the node, each field only when set; the
    // colours, the logo and the footer are templates so a routine can take
    // them from a record ("the client's brand").
    const theme = {};
    for (const k of LOOK_CHOICE_FIELDS) if (typeof step[k] === 'string' && step[k]) theme[k] = step[k];
    for (const k of LOOK_TEMPLATE_FIELDS) {
        if (typeof step[k] !== 'string' || !step[k].trim()) continue;
        const v = resolveBound(step[k], runState);
        if (typeof v === 'string' && v.trim()) theme[k] = v.trim();
    }
    if (typeof step.slideNumbers === 'boolean') theme.slideNumbers = step.slideNumbers;

    const { renderPresentation, makeUserImageResolver } = require('../../services/presentationRenderer');
    const rendered = await renderPresentation({
        deck,
        format,
        title: title || deck.title,
        orgId: orgOf(ctx),
        houseStyle: step.houseStyle !== false,
        theme: Object.keys(theme).length ? theme : null,
        marking,
        resolveImage: makeUserImageResolver(ctx.userId),
    });

    const outcome = markingOutcome(marking, rendered.marking);
    if (outcome.requested && !outcome.visible) {
        log.warn(`[presentation] ${step.id}: AI content marking was resolved but the renderer wrote no marking — the deck is NOT marked.`);
    } else if (outcome.requested && !outcome.metadata) {
        log.warn(`[presentation] ${step.id}: AI marking footer written but the file metadata could not be.`);
    }

    const row = await keepGeneratedFile({
        ctx, step, buffer: rendered.buffer, contentType: rendered.contentType, filename, ttlDays, stepLabel: 'presentation',
    });

    if (rendered.degraded) {
        log.warn(`[presentation] ${step.id}: rendered without a browser — the PDF uses the plain fallback layout.`);
    }

    // Optionally keep the deck in Studio → Documents as a presentation, so a
    // person can open it in Bee Flow, fix a slide and rebuild it. Off by
    // default — a nightly routine would otherwise mint a document a day — and
    // a failure never fails the step: the file already exists.
    let savedCopy = null;
    if (step.saveCopy === true) {
        const copyName = interpolateTemplate(step.copyName || '', runState).trim() || `${title || deck.title || 'Presentation'} — ${new Date().toISOString().slice(0, 10)}`;
        savedCopy = await require('../documents/deckDocument').keepDeckInLibrary({
            userId: ctx.userId, deck: rendered.deck || deck, title: copyName, theme: Object.keys(theme).length ? theme : null,
            houseStyle: step.houseStyle !== false, source: 'routine', description: `Built by the routine on ${new Date().toISOString().slice(0, 10)}.`,
        });
    }

    return {
        output: {
            fileId: row.id,
            filename,
            mimeType: rendered.contentType,
            size: rendered.buffer.length,
            format,
            slideCount: rendered.slideCount || slideCount,
            degraded: !!rendered.degraded,
            marked: outcome.visible && outcome.metadata,
            marking: outcome,
            sourceHandle: { kind: 'generated_file', fileId: row.id },
            ...(rendered.warnings && rendered.warnings.length ? { warnings: rendered.warnings } : {}),
            ...(savedCopy ? { savedDocumentId: savedCopy.documentId, savedDocumentUrl: savedCopy.url } : {}),
        },
    };
}

module.exports = {
    execSlide,
    execPresentation,
    PRESENTATION_FORMATS,
    PRESENTATION_CONTENT_TYPES,
    SLIDE_LAYOUTS,
    LOOK_TEMPLATE_FIELDS,
    LOOK_CHOICE_FIELDS,
    _test: { resolveBound, resolveSlidesInput },
};
