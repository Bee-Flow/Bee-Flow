/**
 * Presentation Tools — the chat's way to hand the user a real .pptx.
 *
 * One tool, `create_presentation`, on the same footing as create_document: a
 * first-party artefact tool, injected for every signed-in user by
 * core/integrations/integrationTools.js (both chat runtimes build their tool
 * stack there) and dispatched by core/tools/toolDispatcher.js. It is NOT a
 * catalog integration — those are off for every org until an admin turns
 * them on, and "make me a deck" is not a connection to a third party.
 *
 * WHERE THE FILE GOES. The deck is uploaded under the caller's own storage
 * prefix (`users/<id>/presentations/`) and served by the existing storage
 * proxy, which already enforces the session, the prefix and a traversal guard
 * and sends the bytes as an attachment. No ledger row and no expiry: the
 * download link is what the model writes into the assistant message, exactly
 * like a generated image, and a link in the chat history that stops working
 * a week later would be worse than a few hundred kilobytes kept. Saving into
 * Nextcloud instead is the sibling tool `nextcloud_create_presentation`
 * (integrations/nextcloudFiles/officeDocuments.js).
 *
 * The deck grammar and every cap live in core/documents/deckModel.js; the
 * rendering in services/presentationRenderer.js. This file only owns the
 * tool schema, the storage key and the message back to the model.
 */

const crypto = require('crypto');
const { DECK_INPUT_PROPERTIES } = require('../core/documents/deckModel');
const { DECK_THEME_INPUT_SCHEMA } = require('../core/documents/deckThemeOptions');
const log = require('../telemetry/log');

const PRESENTATION_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'create_presentation',
            description: 'Build a REAL PowerPoint deck (.pptx) in the organisation\'s house style — it opens in PowerPoint, Keynote, LibreOffice and Nextcloud Office. Use it whenever the user wants "a presentation", "slides", "a deck", "a pitch". Give the content as `slides` (structured, preferred: 3–6 bullets per slide plus speaker notes) or as `markdown` (an outline: "# " title once, "## " per slide, "- " bullets). Returns { downloadUrl, filename, slideCount } — END YOUR REPLY with a markdown link [filename](downloadUrl) so the user can download it. WHEN THE USER WANTS THE DECK IN NEXTCLOUD (names Nextcloud or a folder like /Presentations): pass `nextcloudPath` — the deck is saved THERE (parent folders are created; do not create them yourself) and the result has `webUrl` to give as "Open in Nextcloud Office". Do NOT call create_presentation without nextcloudPath and then look for the file in Nextcloud. Images: only a Bee Flow storage URL (e.g. the imageUrl from generate_image) or a data: URL can be placed on a slide; remote pictures are not fetched. Cards: `cards` ({title, text, icon?} × 2–6; icons are Lucide names such as shield, users, workflow, chart-line, lock, cloud-off, rocket). Visuals: a slide may carry a `chart` (bar/column/line/area/pie/donut from labels + series, or rows), `stats` (up to four KPI tiles), `steps` (a timeline) or `style:"accent"` for an emphasis slide; `theme` sets the look (preset, colours, font, logo, footer) only when the user asks for another brand.',
            parameters: {
                type: 'object',
                properties: {
                    ...DECK_INPUT_PROPERTIES,
                    fileName: { type: 'string', description: 'Optional file name, e.g. "q3-review.pptx". Derived from the title when omitted.' },
                    nextcloudPath: { type: 'string', description: 'Save into the user\'s Nextcloud at this path — a folder ("/Presentations") or a file path ("/Presentations/q3-review.pptx"). Use it whenever the user mentions Nextcloud or a folder.' },
                    templatePath: { type: 'string', description: 'With nextcloudPath: a .pptx in Nextcloud whose first two slides carry a design (a conference or client template) — the deck is built on its backgrounds and logo.' },
                    houseStyle: { type: 'boolean', description: "Defaults to TRUE — the organisation's colours, font, logo and footer. Pass false ONLY when the user explicitly asks for another brand or an unbranded deck." },
                    saveToLibrary: { type: 'boolean', description: 'Defaults to TRUE: the deck is also kept in Studio → Documents as an editable presentation the user can open in Bee Flow (the result has documentUrl). Pass false only when the user asks for a throwaway file.' },
                    theme: DECK_THEME_INPUT_SCHEMA,
                },
                required: ['title'],
            },
        },
    },
];

const PRESENTATION_TOOL_NAMES = new Set(PRESENTATION_TOOLS.map((t) => t.function.name));

function isPresentationTool(toolName) {
    return PRESENTATION_TOOL_NAMES.has(toolName);
}

/**
 * A file name that is safe on disk, in a storage key and in a
 * Content-Disposition header. ASCII only: the proxy route derives the header
 * from the key, and a non-ASCII byte there is a header-encoding bug.
 */
function safePresentationFileName(raw, fallback = 'presentation') {
    const base = String(raw || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\.pptx$/i, '')
        .replace(/[^A-Za-z0-9._ -]+/g, ' ')
        .replace(/\.{2,}/g, '.')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/ /g, '-')
        .replace(/^[-.]+/, '')
        .replace(/[-.]+$/, '')
        .slice(0, 80);
    return `${base || fallback}.pptx`;
}

/**
 * @param {object} args   tool arguments
 * @param {{ userId: string, orgId?: string|null, session?: object }} ctx
 */
async function executePresentationTool(args = {}, ctx = {}) {
    const userId = ctx.userId;
    if (!userId) return { error: 'No user context for the presentation tool.' };

    const hasSlides = Array.isArray(args.slides) && args.slides.length > 0;
    const hasMarkdown = typeof args.markdown === 'string' && args.markdown.trim().length > 0;
    if (!hasSlides && !hasMarkdown) {
        return { error: 'Give the deck content as `slides` (an array of { title, bullets, notes }) or as `markdown` (an outline with "## " per slide).' };
    }
    const title = typeof args.title === 'string' ? args.title.trim().slice(0, 200) : '';

    const storageStore = require('../stores/storageStore');
    if (typeof storageStore.isAvailable === 'function' && !storageStore.isAvailable()) {
        return { error: 'File storage is not available on this server, so the deck cannot be kept. Ask an administrator to configure storage, or save the deck into Nextcloud with nextcloud_create_presentation.' };
    }

    // Art. 50(2): a chat deck is model output by definition; whether the org
    // marks it is the compliance feature's answer through the core port.
    let marking = null;
    try {
        const { resolveMarking } = require('../core/automationRunner/documentMarking');
        marking = await resolveMarking(ctx.orgId || null, { automationId: null, aiStepIds: [], provider: ctx.provider || 'chat' });
    } catch (e) {
        log.warn(`[PresentationTools] marking unavailable, rendering unmarked: ${e.message}`);
    }

    const { renderPresentation, makeUserImageResolver } = require('../services/presentationRenderer');
    let out;
    try {
        out = await renderPresentation({
            deck: hasSlides ? { title, subtitle: args.subtitle, slides: args.slides } : { title, subtitle: args.subtitle, markdown: args.markdown },
            title,
            orgId: ctx.orgId || null,
            houseStyle: args.houseStyle !== false,
            theme: args.theme && typeof args.theme === 'object' ? args.theme : null,
            marking,
            resolveImage: makeUserImageResolver(userId),
        });
    } catch (e) {
        if (e && e.errorClass) return { error: e.message };
        throw e;
    }

    const filename = safePresentationFileName(args.fileName || title);
    const stamp = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const key = storageStore.buildKey(userId, 'presentations', `${stamp}_${filename}`);
    await storageStore.uploadFile(key, out.buffer, out.contentType);
    const downloadUrl = storageStore.buildProxyUrl(key);

    // The same deck in the library, as a presentation document: openable in
    // Bee Flow without a download, editable, and rebuildable in another look.
    const kept = args.saveToLibrary === false ? null : await require('../core/documents/deckDocument').keepDeckInLibrary({
        userId, deck: out.deck, title: title || filename.replace(/\.pptx$/i, ''),
        theme: args.theme && typeof args.theme === 'object' ? args.theme : null, houseStyle: args.houseStyle !== false, source: 'create_presentation',
    });

    const warn = out.warnings.length ? ` Notes: ${out.warnings.slice(0, 5).join('; ')}.` : '';
    return {
        success: true,
        downloadUrl,
        filename,
        size: out.buffer.length,
        slideCount: out.slideCount,
        houseStyle: out.houseStyle,
        marking: out.marking,
        warnings: out.warnings,
        ...(kept ? { documentId: kept.documentId, documentUrl: kept.url } : {}),
        // The card the chat shows under the reply, whatever the model writes.
        file: { kind: 'presentation', name: filename, mimeType: out.contentType, size: out.buffer.length, slideCount: out.slideCount, url: downloadUrl, source: 'create_presentation', ...(kept ? { documentId: kept.documentId, documentUrl: kept.url } : {}) },
        message: `Presentation "${title || filename}" built with ${out.slideCount} slides.${kept ? ` It is also in Studio → Documents: reply with [${kept.name}](${kept.url}) so the user can open the slides in Bee Flow, and with` : ' Reply with'} the download link [${filename}](${downloadUrl}).${warn}`,
    };
}

module.exports = {
    PRESENTATION_TOOLS,
    isPresentationTool,
    executePresentationTool,
    safePresentationFileName,
};
