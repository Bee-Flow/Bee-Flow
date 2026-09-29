// @typecheck
/**
 * A presentation as a Studio Document.
 *
 * A document in the library is two text slots and a settings bag
 * (stores/documentStore.js). For `docType: 'presentation'` the body slot holds
 * the deck OUTLINE — the markdown grammar of core/documents/deckModel.js, one
 * `## ` per slide, ```chart / ```stats blocks, `### ` cards — and the `css`
 * slot is unused, because slides are painted by the deck engine (a resolved
 * theme → pptxgenjs or the PDF/HTML slide renderer), never by a stylesheet
 * the author wrote. What a document keeps of its look is `settings.deck`: the
 * per-deck overrides of deckThemeOptions.js (preset, colours, typefaces,
 * cover and table style, logo, footer, a template deck), each one optional,
 * layered on the organisation's house style at render time — so changing the
 * house style restyles every presentation that did not choose otherwise, the
 * way it restyles every invoice. `settings.houseStyle === false` is the same
 * per-document opt-out documents have.
 *
 * WHY THE OUTLINE AND NOT THE NORMALISED DECK. The outline is what a person
 * edits and what a model writes; it round-trips through deckToMarkdown, it
 * takes `{{placeholders}}` like any other document, and it is small. The
 * normalised deck is derived from it on every render, exactly as a document's
 * HTML is composed on every render.
 *
 * PLACEHOLDERS FILL AS TEXT. documentTemplate escapes values for markup; an
 * outline is markdown the deck renderer escapes itself when it paints, so the
 * fill here runs with escaping OFF (documentContract passes that through for
 * this type). A value with a `## ` in it therefore becomes a heading — which
 * is the honest reading of "put this text on the slide".
 *
 * ONE RENDER PATH for three surfaces: the editor's viewer (`html`), the
 * download (`pptx`/`pdf`), a routine's fill_document and an app's
 * fill_document all go through renderDeckDocument → presentationRenderer, so
 * what the person previews is what the routine mails out.
 */

'use strict';

const { normalizeDeck, DECK_LIMITS } = require('./deckModel');
const { normaliseDeckOverrides } = require('./deckThemeOptions');
const log = require('../../telemetry/log');

const DECK_DOC_TYPE = 'presentation';

/** Whether this library document is a presentation (its body is an outline). */
function isDeckDocument(doc) {
    return !!doc && typeof doc === 'object' && doc.docType === DECK_DOC_TYPE;
}

/** The look this document chose for itself — only the keys it actually set. */
function deckOverridesOf(doc) {
    return normaliseDeckOverrides(doc && doc.settings && doc.settings.deck);
}

/**
 * The outline → a normalised deck. `fill` is documentContract's report for
 * the placeholders (missing names, validation issues); with `values` absent
 * the outline is rendered as written, tokens and all — that is what the
 * editor shows, the way a document's preview shows its tokens.
 *
 * The cover title is the outline's `# ` line; a document whose outline has
 * none is titled after itself.
 */
function deckFromDocument(doc, values = null, { sectionOverrides = {} } = {}) {
    if (!isDeckDocument(doc)) {
        throw Object.assign(new Error('This document is not a presentation.'), { errorClass: 'document_not_deck', status: 422 });
    }
    let outline = String(doc.bodyHtml || '');
    let fill = null;
    if (values !== null && values !== undefined) {
        const { prepareDocument } = require('./documentContract');
        fill = prepareDocument(doc, values, sectionOverrides);
        outline = fill.bodyHtml;
    }
    if (!outline.trim()) {
        throw Object.assign(
            new Error(`The presentation "${doc.name || 'presentation'}" has no slides yet.`),
            { errorClass: 'document_empty', status: 400 },
        );
    }
    const deck = normalizeDeck({ markdown: outline });
    if (!deck.title) deck.title = String(doc.name || 'Presentation').trim().slice(0, DECK_LIMITS.maxTitleChars);
    return { deck, fill };
}

/**
 * Render a presentation document.
 *
 * @param {object} args
 * @param {object}  args.document   a documentStore document (docType 'presentation')
 * @param {object|null} [args.values]  placeholder values; null = render the outline as written
 * @param {'pptx'|'pdf'|'html'} [args.format]  html = the on-screen slide viewer
 * @param {string|null} [args.orgId]   whose house style
 * @param {object|null} [args.marking] AI-content marking, or null
 * @param {Function} [args.resolveImage] how image references become bytes (presentationRenderer.makeUserImageResolver)
 * @param {object} [args.draft]  unsaved settings to preview with (the editor's look tab), merged over the stored ones
 * @param {Record<string, any>} [args.sectionOverrides]  per-section overrides for this render
 * @param {boolean} [args.assertFilled]  refuse to render with unfilled required placeholders (default true)
 * @returns {Promise<object>} presentationRenderer's result plus `fill` and `deck`
 */
async function renderDeckDocument({
    document: doc, values = null, sectionOverrides = {}, format = 'pptx', orgId = null, marking = null,
    resolveImage = null, draft = null, assertFilled = true,
} = /** @type {any} */ ({})) {
    const source = draft && typeof draft === 'object'
        ? { ...doc, ...(typeof draft.bodyHtml === 'string' ? { bodyHtml: draft.bodyHtml } : {}), settings: { ...(doc.settings || {}), ...(draft.settings || {}) } }
        : doc;
    const { deck, fill } = deckFromDocument(source, values, { sectionOverrides });
    if (fill && assertFilled) require('./documentContract').assertFinal(fill);

    const { renderPresentation } = require('../../services/presentationRenderer');
    const out = await renderPresentation({
        deck,
        format,
        title: deck.title,
        orgId,
        houseStyle: source.settings && source.settings.houseStyle === false ? false : true,
        theme: deckOverridesOf(source),
        marking,
        resolveImage,
    });
    return { ...out, fill, deck };
}

/** Where a library document opens in the app. */
function deckDocumentUrl(id) {
    return `/app/studio/documents/${id}`;
}

/**
 * Keep a deck that was just built (by the chat, by a routine) in the library
 * as a presentation document, so it can be opened in Bee Flow, edited and
 * rebuilt later. Best effort: the file the caller made already exists, and a
 * library hiccup must not turn "here is your deck" into an error.
 *
 * @param {object} args
 * @param {string} [args.userId]  the library owner
 * @param {string} [args.title]
 * @param {string} [args.description]
 * @param {string} [args.source]
 * @param {object} args.deck      a normalised deck (renderPresentation returns it)
 * @param {object} [args.theme]   the per-deck look overrides it was built with
 * @param {boolean} [args.houseStyle]  false = built without the house style
 * @returns {Promise<{documentId:string, url:string, name:string}|null>}
 */
async function keepDeckInLibrary({ userId, deck, title = '', theme = null, houseStyle = true, description = '', source = '' } = /** @type {any} */ ({})) {
    if (!userId || !deck) return null;
    try {
        const { deckToMarkdown } = require('./deckModel');
        const documentStore = require('../../stores/documentStore');
        const outline = deckToMarkdown(deck);
        const name = String(title || deck.title || 'Presentation').trim().slice(0, 200) || 'Presentation';
        const doc = await documentStore.createDocument({
            userId, name, docType: DECK_DOC_TYPE, description: String(description || '').slice(0, 2000), kind: 'document',
            bodyHtml: outline, css: '',
            settings: {
                ...(houseStyle === false ? { houseStyle: false } : {}),
                deck: theme && typeof theme === 'object' ? theme : {},
                ...(source ? { generatedFrom: { source, at: new Date().toISOString() } } : {}),
            },
        });
        return { documentId: doc.id, url: deckDocumentUrl(doc.id), name: doc.name };
    } catch (e) {
        log.warn(`[deckDocument] the deck could not be kept in the library: ${e.message}`);
        return null;
    }
}

module.exports = { DECK_DOC_TYPE, isDeckDocument, deckOverridesOf, deckFromDocument, renderDeckDocument, keepDeckInLibrary, deckDocumentUrl };
