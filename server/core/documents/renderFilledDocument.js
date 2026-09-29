// @typecheck
/**
 * Render a stored Studio Document, filled with a run's values, to a PDF.
 *
 * THE ONE PLACE three surfaces meet. The Documents editor downloads a PDF
 * (routes/studioDocuments.js), a routine step renders one per run
 * (core/automationRunner/execFillDocument.js) and an app action renders one
 * per click (appStudio/actionExecutor/documentStep.js). Each of those keeps
 * the bytes somewhere different — a response, the run's file ledger, the app's
 * attachment store — but what makes the bytes must be identical, or the
 * invoice a customer receives from a routine is not the invoice the person
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

const { prepareDocument, assertFinal } = require('./documentContract');
const houseStyle = require('./documentHouseStyle');

/**
 * The CSS layer a document wears, or ''.
 *
 * `settings.houseStyle === false` is the opt-out, and it is checked STRICTLY:
 * an absent key means "nobody decided", which is the default ON — a document
 * made before the letterhead existed must not lose it by having no opinion.
 *
 * A failed lookup is actionable: freezing an empty style after a transient
 * failure would permanently change a reviewed document's printed layout.
 */
async function houseStyleCssFor(doc, orgId) {
    if (doc?.settings?.houseStyle === false) return '';
    // A presentation wears the house style as a resolved deck THEME at render
    // time (core/documents/deckDocument.js), never as a CSS layer; there is
    // nothing to freeze on it.
    if (doc?.docType === 'presentation') return '';
    if (typeof doc?.settings?.resolvedHouseStyleCss === 'string') return doc.settings.resolvedHouseStyleCss;
    if (!orgId) return '';
    try {
        return houseStyle.houseStyleCss(await houseStyle.getHouseStyle(orgId));
    } catch (e) {
        throw Object.assign(new Error('Document house styling is unavailable. Please retry.'), {
            status: 503, errorClass: 'document_style_unavailable', cause: e,
        });
    }
}

/**
 * Fill a document and render it.
 *
 * @param {object} args
 * @param {object}  args.document  a documentStore document (both slots)
 * @param {object}  [args.values]  the run's data for the placeholders
 * @param {string}  [args.orgId]   whose letterhead applies
 * @param {object}  [args.marking] resolved AI-content marking, or null
 * @param {Record<string, any>} [args.sectionOverrides]
 * @param {'pptx'|'pdf'|'html'|null} [args.format]  a presentation's output format
 * @param {Function} [args.resolveImage]
 * @returns {Promise<{buffer: Buffer, contentType: string, degraded: boolean,
 *                    marking: object|null, fill: object, empty?: boolean, extension?: string}>}
 *
 * `fill` is documentTemplate's report — which placeholders had no value, which
 * asked for a list and got something else. It rides back to the caller rather
 * than being logged here, because only the caller knows where a person will
 * read it: a run log line, a step output, a toast.
 */
async function renderFilledDocument({ document: doc, values = {}, orgId = null, marking = null, sectionOverrides = {}, format = null, resolveImage = null }) {
    if (!doc || typeof doc !== 'object') {
        throw Object.assign(new Error('There is no document to render.'), { errorClass: 'document_missing' });
    }
    // A presentation renders through the deck engine: a .pptx unless the
    // caller asks for the PDF. Same fill, same marking, same result shape
    // (plus `slideCount`), so a routine's fill_document step does not care
    // which kind of document it was handed.
    if (doc.docType === 'presentation') {
        const { renderDeckDocument } = require('./deckDocument');
        const out = await renderDeckDocument({
            document: doc, values, sectionOverrides, orgId, marking, resolveImage,
            format: format === 'pdf' ? 'pdf' : 'pptx',
        });
        return { ...out, extension: out.format === 'pdf' ? 'pdf' : 'pptx' };
    }
    const fill = prepareDocument(doc, values, sectionOverrides);
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

    const { composeDocument } = require('../../services/documentCompose');
    const { renderStyledHtmlToPdf } = require('../../services/documentRenderer');

    const html = composeDocument(
        { ...doc, bodyHtml: fill.bodyHtml },
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
    const ext = /^[a-z0-9]{1,8}$/i.test(String(extension || '')) ? String(extension).toLowerCase() : 'pdf';
    return `${(cleaned || fallback).replace(new RegExp(`\\.${ext}$`, 'i'), '')}.${ext}`;
}

module.exports = { renderFilledDocument, houseStyleCssFor, documentFileName };
