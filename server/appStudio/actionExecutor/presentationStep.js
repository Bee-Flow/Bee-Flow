/**
 * App Studio action executor — generate_presentation: slides in, a PowerPoint
 * (or PDF deck) in the owner's house style out, as an app attachment.
 *
 * THE THIRD SIBLING of generate_file and fill_document, with the same tail
 * (shared.js storeStudioAttachment) and the same `studio_attachment`
 * descriptor, so file_preview, download_file, send_email.attachments and a
 * file-column record write take a deck without learning anything new.
 *
 * `slides` is resolved WHOLE — a records binding arrives as an array, an
 * ai_generate result as its text — and handed to the same collector the
 * automation step uses (core/documents/deckCollect.js): a markdown outline, a
 * JSON deck, rows with a title and content, all become one deck. The house
 * style is the app OWNER's organisation's, like a filled document's
 * letterhead: an app prints on the company's paper.
 */

'use strict';

const { buildServerScope, resolveBinding, storeStudioAttachment } = require('./shared');
const log = require('../../telemetry/log');

/** Safe as a download attribute, a Content-Disposition value and a MIME header. */
function sanitizeFileName(name, fallback) {
    const flat = String(name == null ? '' : name).replace(/[/\\\r\n\0"<>|?*:;]/g, '').replace(/\.(pptx|pdf)$/i, '').trim().slice(0, 120);
    return flat || fallback;
}

async function generatePresentationStep(app, model, step, ctx) {
    const scope = buildServerScope(ctx);
    const slidesRaw = resolveBinding(step.slides, ctx, scope);
    const title = String(resolveBinding(step.title, ctx, scope) ?? '').trim();
    const subtitle = String(resolveBinding(step.subtitle, ctx, scope) ?? '').trim();
    const format = step.format === 'pdf' ? 'pdf' : 'pptx';

    const { collectDeck } = require('../../core/documents/deckCollect');
    const { normalizeDeck } = require('../../core/documents/deckModel');
    let deck;
    try {
        const { deckInput, warnings } = collectDeck(slidesRaw, { title, subtitle });
        deck = normalizeDeck(deckInput);
        deck.warnings.unshift(...warnings);
    } catch (e) {
        if (e && (e.errorClass === 'presentation_empty' || e.errorClass === 'deck_empty')) {
            return { ok: false, error: 'There are no slides to put in the presentation' };
        }
        if (e && e.errorClass) return { ok: false, error: e.message, code: e.errorClass };
        throw e;
    }

    // The look the author set on the step; blank = the house style decides.
    const theme = {};
    for (const k of ['preset', 'font', 'coverStyle', 'tableStyle', 'logoPlacement']) if (typeof step[k] === 'string' && step[k]) theme[k] = step[k];
    for (const k of ['accent', 'background', 'footerText']) {
        const v = resolveBinding(step[k], ctx, scope);
        if (typeof v === 'string' && v.trim()) theme[k] = v.trim();
    }

    const { renderPresentation } = require('../../services/presentationRenderer');
    let rendered;
    try {
        rendered = await renderPresentation({
            deck,
            format,
            title: title || deck.title,
            // The app's organisation decides the house style — an app prints
            // on the company's paper, not on the viewer's.
            orgId: app.organizationId || ctx.orgId || null,
            houseStyle: step.houseStyle !== false,
            theme: Object.keys(theme).length ? theme : null,
            // Like fill_document: no per-run AI marking resolution here (the
            // app's own compliance posture is the org's), and no image
            // resolver — a viewer's storage is not the app's.
            marking: null,
            resolveImage: null,
        });
    } catch (e) {
        if (e && e.errorClass === 'document_empty') return { ok: false, error: 'There are no slides to put in the presentation' };
        if (e && e.errorClass) return { ok: false, error: e.message, code: e.errorClass };
        throw e;
    }

    const fileName = `${sanitizeFileName(resolveBinding(step.fileName, ctx, scope) || title || deck.title, 'presentation')}.${format}`;
    const stored = await storeStudioAttachment({
        app, step, ctx, scope, buffer: rendered.buffer, contentType: rendered.contentType, fileName,
        extra: {
            slideCount: rendered.slideCount,
            format,
            ...(rendered.warnings && rendered.warnings.length ? { warnings: rendered.warnings } : {}),
            ...(rendered.degraded ? { degraded: true } : {}),
        },
    });
    if (stored.ok && rendered.degraded) {
        log.warn(`[generate_presentation] app ${app.id}: rendered without a browser — the PDF deck uses the plain fallback layout.`);
    }
    return stored;
}

module.exports = { generatePresentationStep, _test: { sanitizeFileName } };
