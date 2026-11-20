// @typecheck
/**
 * Render a stored Studio Document, filled with a run's values, to a PDF.
 *
 * THE ONE PLACE three surfaces meet. The Documents editor downloads a PDF
 * (routes/studioDocuments.js), an automation step renders one per run
 * (core/automationRunner/execFillDocument.js) and an app action renders one
 * per click (appStudio/actionExecutor/documentStep.js). Each of those keeps
 * the bytes somewhere different — a response, the run's file ledger, the app's
 * attachment store — but what makes the bytes must be identical, or the
 * invoice a customer receives from an automation is not the invoice the person
 * proof-read in the editor.
 *
 * The pipeline, in order, and each step is somebody else's module:
 *   documentTemplate.fillDocumentBody  the placeholders → this run's values
 *   documentHouseStyle                 the org's letterhead, unless opted out
 *   documentCompose.composeDocument    the two slots → one sanitised document
 *   documentRenderer.renderStyledHtmlToPdf  → Chromium (fallback is rejected)
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: load the document (the caller
 * owns the access decision — documentStore.getDocument is owner-scoped and the
 * caller knows WHOSE it is), decide the AI-content marking (that is a policy
 * lookup per surface), or store anything.
 */

'use strict';

const { featureModule } = require('../featureModules');
const { prepareDocument, assertFinal } = require('./documentContract');
const houseStyle = require('./documentHouseStyle');

/**
 * The two dependencies a test replaces (`_setDepsForTests`) so a render runs
 * without Chromium or a database: the PDF renderer and the house-style read.
 * The composer and the deck renderer are feature modules, which a test swaps
 * through core/featureModules. null means the real modules.
 * @typedef {{ renderStyledHtmlToPdf?: typeof import('./render/documentRenderer').renderStyledHtmlToPdf,
 *   getHouseStyle?: typeof houseStyle.getHouseStyle }} RenderDeps
 * @type {RenderDeps | null}
 */
let depsOverride = null;

/** @param {RenderDeps | null} [over]  null puts the real modules back */
function _setDepsForTests(over = null) {
    depsOverride = over;
}

/**
 * What the house-style lookup reads of a document.
 * @typedef {{ docType?: string | null, organizationId?: string | null,
 *   settings?: { houseStyle?: unknown, resolvedHouseStyleCss?: unknown } | null } | null | undefined} HouseStyleDoc
 */

/**
 * The copy of the house style the document last saw on save, or null.
 * @param {HouseStyleDoc} doc
 */
function storedHouseStyleCss(doc) {
    const css = doc?.settings?.resolvedHouseStyleCss;
    return typeof css === 'string' ? css : null;
}

/**
 * The CSS layer a document wears, or ''.
 *
 * `settings.houseStyle === false` is the opt-out, and it is checked STRICTLY:
 * an absent key means "nobody decided", which is the default ON — a document
 * made before the letterhead existed must not lose it by having no opinion.
 *
 * CURRENT, NOT FROZEN. A document that uses the house style follows the
 * organisation's house style as it is NOW, read at render time, exactly like a
 * presentation's deck theme: change the letterhead and every document, page,
 * preview, download, automation PDF and app render follows it.
 * `getHouseStyle` keeps a short per-org cache, the same one the deck path
 * reads, so this is not a query per render.
 *
 * `settings.resolvedHouseStyleCss` (written on save by stores/documentStore.js)
 * is the style the document last saw. It is read ONLY when there is no
 * organisation to ask (neither the caller nor the document names one) or the
 * read itself fails. It is NOT used when the organisation switched its house
 * style off: the documents follow that too, as decks do, or "I turned the
 * letterhead off" would leave the old logo on every older document.
 * @param {HouseStyleDoc} doc
 * @param {string | null | undefined} orgId  the caller's organisation; the document's own when absent
 */
async function houseStyleCssFor(doc, orgId) {
    if (doc?.settings?.houseStyle === false) return '';
    // A presentation wears the house style as a resolved deck THEME at render
    // time (core/documents/deckDocument.js), never as a CSS layer.
    if (doc?.docType === 'presentation') return '';
    const stored = storedHouseStyleCss(doc);
    const org = orgId || doc?.organizationId || null;
    if (!org) return stored ?? '';
    try {
        const getHouseStyle = depsOverride?.getHouseStyle || houseStyle.getHouseStyle;
        return houseStyle.houseStyleCss(await getHouseStyle(org));
    } catch (e) {
        if (stored !== null) return stored;
        throw Object.assign(new Error('Document house styling is unavailable. Please retry.'), {
            status: 503, errorClass: 'document_style_unavailable', cause: e,
        });
    }
}

/**
 * Fill a document and render it.
 *
 * @param {{ document: import('../../stores/documentStore').DocumentView, values?: Record<string, unknown>, orgId?: string | null,
 *   marking?: import('./render/documentRenderer').AiMarking | null, sectionOverrides?: Record<string, any>, format?: 'pptx'|'pdf'|'html'|null,
 *   resolveImage?: ((ref: unknown) => Promise<string|null>) | null, placeholders?: boolean }} args  `document` is a documentStore
 *   document (both slots); `values` the run's data for the placeholders; `orgId` whose letterhead applies;
 *   `marking` the resolved AI-content marking, or null; `format` a presentation's output format;
 *   `placeholders` prints a value nobody gave as its label in brackets instead of refusing (the
 *   editor's download of a TEMPLATE only, core/documents/templatePlaceholders.mts)
 * @returns {Promise<{buffer: Buffer, contentType: string, degraded: boolean,
 *                    marking: any|null, fill: any, empty?: boolean, extension?: string}>}
 *
 * `fill` is documentTemplate's report — which placeholders had no value, which
 * asked for a list and got something else. It rides back to the caller rather
 * than being logged here, because only the caller knows where a person will
 * read it: a run log line, a step output, a toast.
 */
async function renderFilledDocument({ document: doc, values = {}, orgId = null, marking = null, sectionOverrides = {}, format = null, resolveImage = null, placeholders = false }) {
    if (!doc || typeof doc !== 'object') {
        throw Object.assign(new Error('There is no document to render.'), { errorClass: 'document_missing' });
    }
    // A presentation renders through the deck engine: a .pptx unless the
    // caller asks for the PDF. Same fill, same marking, same result shape
    // (plus `slideCount`), so an automation's fill_document step does not care
    // which kind of document it was handed.
    if (doc.docType === 'presentation') {
        const { renderDeckDocument } = require('./deckDocument');
        const out = await renderDeckDocument({
            document: doc, values, sectionOverrides, orgId, marking, resolveImage, placeholders,
            format: format === 'pdf' ? 'pdf' : 'pptx',
        });
        return { ...out, extension: out.format === 'pdf' ? 'pdf' : 'pptx' };
    }
    const fill = placeholders
        ? require('./templatePlaceholders.mts').prepareTemplateForDownload(doc, values, sectionOverrides)
        : prepareDocument(doc, values, sectionOverrides);
    assertFinal(fill);

    // An empty template renders an empty page — a PDF nobody wants and every
    // consumer (an email attachment, a file column) then carries around. The
    // renderer refuses empty content too, but its message is about content
    // where this one is about the document.
    if (!fill.bodyHtml.trim()) {
        throw Object.assign(
            new Error(`The document "${doc.name || 'document'}" is empty, so there is nothing to render.`),
            { errorClass: 'document_empty' },
        );
    }

    const { composeDocument } = featureModule('services/documentCompose');
    const renderStyledHtmlToPdf = depsOverride?.renderStyledHtmlToPdf || require('./render/documentRenderer').renderStyledHtmlToPdf;

    // A page has no stylesheet of its own; it prints with the page sheet
    // (core/documents/pageDocument.js) under the same house style.
    const html = composeDocument(
        require('./pageDocument').forCompose({ ...doc, bodyHtml: fill.bodyHtml }),
        { mode: 'print', houseStyleCss: await houseStyleCssFor(doc, orgId) },
    );
    const out = await renderStyledHtmlToPdf({ html, title: doc.name || '', marking, allowFallback:false });
    if (out.degraded) throw Object.assign(new Error('Styled PDF rendering is unavailable. Please retry when the renderer is available.'), { status: 503, errorClass: 'document_renderer_unavailable' });
    return { ...out, extension: 'pdf', fill };
}

/**
 * Turn a document name into something safe as a filename and as a
 * `Content-Disposition` value — this string reaches an HTTP header and a MIME
 * part, where a stray quote or newline is an injection, not a cosmetic issue.
 * @param {string} [fallback]
 * @param {string} [extension]
 */
function documentFileName(raw, fallback = 'document', extension = 'pdf') {
    const cleaned = String(raw || '')
        .normalize('NFKD')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/[\\/:*?"<>|;]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+/, '')
        .slice(0, 120)
        .trim();
    // Letters and digits only, up to 12 (`bftemplate`, Bee Flow's template file, is 10).
    const ext = /^[a-z0-9]{1,12}$/i.test(String(extension || '')) ? String(extension).toLowerCase() : 'pdf';
    return `${(cleaned || fallback).replace(new RegExp(`\\.${ext}$`, 'i'), '')}.${ext}`;
}

module.exports = { renderFilledDocument, houseStyleCssFor, documentFileName, _setDepsForTests };
