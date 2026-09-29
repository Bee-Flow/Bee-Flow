/**
 * Document Builder Tools — the chat's way to author a rendered document.
 *
 * The shape deliberately mirrors integrations/webpageBuilderTools.js (a
 * DOCUMENT_TOOLS array plus an executeDocumentTool dispatcher, dispatched from
 * routes/ai/directChat/toolExec.js) so there is one pattern to learn. What it
 * does NOT mirror is the surface: a webpage project has six tools across three
 * slots, extra files, assets and a framework switch. A document has two slots
 * and no runtime, so it has three tools and no way to write script.
 *
 * WHY TOOLS AND NOT A ```fence```. The predecessor to this feature asked the
 * model to emit a ```quote``` block holding a JSON object, which the frontend
 * turned into a fixed layout. That capped every document at the shapes the
 * renderer had been taught, put the whole document in the conversation (paid
 * for on every subsequent turn), and left nothing behind once the chat was
 * gone. Writing to a stored document instead means the model designs the
 * layout in CSS, the user keeps the artefact, and editing turn five does not
 * mean re-emitting the whole invoice.
 */

const documentStore = require('../stores/documentStore');
const houseStyle = require('../core/documents/documentHouseStyle');
const { applyFindReplace } = require('../core/text/findReplace');
const log = require('../telemetry/log');

const APP_PATH = 'app/studio/documents';

function documentUrl(id) {
    return `/${APP_PATH}/${id}`;
}

const DOCUMENT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'create_document',
            description: 'Create a new rendered Document (an invoice, quote, letter, report or similar) owned by the current user. Returns { documentId, url, name, message }.\n\nCall this FIRST when the user asks for a NEW document; do not call it to edit an existing one. A document has exactly TWO slots — `bodyHtml` (the body markup) and `css` (the stylesheet) — which you fill with document_write immediately afterwards.\n\nUse a Document, not a Webpage, whenever the thing is meant to be PRINTED or sent as a PDF: invoices, quotes, order confirmations, letters, certificates, reports. Use a Webpage when it is meant to be interactive or visited in a browser.\n\nA PRESENTATION in the library is `docType: "presentation"`: its body slot is a slide OUTLINE (markdown: "# " title, "## " per slide, "- " bullets, "### " cards, ```chart / ```stats blocks) and it has no css — the house style paints it. It opens as a slide viewer in Bee Flow and downloads as .pptx or PDF. Prefer create_presentation when the user just wants a deck now; use this when they want a reusable slide TEMPLATE with {{placeholders}} for routines.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'A short human-readable title, e.g. "Factuur 2026-014 — Van Dijk Groep".',
                    },
                    docType: {
                        type: 'string',
                        enum: [...documentStore.DOC_TYPES],
                        description: 'What kind of document this is. Used for the icon and grouping in the Documents list; it does not change how the document renders.',
                    },
                    description: {
                        type: 'string',
                        description: 'Optional one-sentence description.',
                    },
                    useHouseStyle: {
                        type: 'boolean',
                        description: "Whether this document wears the organisation's letterhead (logo, brand colour, fonts). Defaults to TRUE and you should almost always leave it alone. Pass false ONLY when the user explicitly asks for a document in someone else's branding, or for a plain unbranded one — never because you think the design would look better without it.",
                    },
                },
                required: ['name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'document_read',
            description: 'Read a document\'s current slots. Returns { name, docType, bodyHtml, css }.\n\nUse it before editing a document you did not write this turn — including one the user has since changed by hand, which is the common case: they moved a line or corrected an amount and are now asking you to change something else. Writing without reading would silently revert their edit.',
            parameters: {
                type: 'object',
                properties: {
                    documentId: { type: 'string', description: 'The document to read.' },
                },
                required: ['documentId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'document_write',
            description: 'Replace a WHOLE slot. Use this to fill a new document, or for a redesign that rewrites the stylesheet from scratch.\n\nFor any change to a document that already has content — a corrected amount, an extra line, a different colour — use `document_edit` instead. A full rewrite costs the entire document in output tokens and, worse, silently discards whatever the user changed by hand since you last read it.\n\nPass `bodyHtml`, `css`, or both; an omitted slot is left exactly as it is.\n\n`bodyHtml` is BODY MARKUP ONLY — no <html>, <head>, <body> or <style> tags, and no <script> (scripts are stripped: a document does not run). `css` is the full stylesheet, and it owns the paper: set `@page { size: A4; margin: 18mm 16mm; }` (or whatever the document needs) there.\n\nWrite semantic markup with classes — <table class="lines">, <div class="totals"> — and do the layout in `css`. That is what lets the user hand-edit the text afterwards without the layout coming apart.',
            parameters: {
                type: 'object',
                properties: {
                    documentId: { type: 'string', description: 'The document to write to.' },
                    bodyHtml: { type: 'string', description: 'The document body markup. Omit to leave the current body untouched.' },
                    css: { type: 'string', description: 'The document stylesheet. Omit to leave the current stylesheet untouched.' },
                    summary: { type: 'string', description: 'A short note for the version history, e.g. "Added VAT row".' },
                },
                required: ['documentId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'document_edit',
            description: 'PREFERRED tool for changing an existing document. Replaces a specific snippet inside ONE slot and leaves everything else exactly as it was.\n\nUse it for both of the things people ask for most:\n  • TEXT — "change the amount to 1.320", "add a line for transport", "fix the address". Edit `slot: "body"`.\n  • STYLING ONLY — "make the header green", "bigger totals", "more space above the table". Edit `slot: "css"`; the text is not touched at all.\n\nWorkflow: `document_read` FIRST to see the exact current content, then copy find_text verbatim from what you read. find_text must match EXACTLY ONCE by default; on several matches the tool refuses and lists the line numbers, so either narrow the snippet or pass replace_all: true.\n\nINSERT by anchoring on a stable nearby snippet and repeating it in replace_text. DELETE by passing replace_text: "".\n\nPrefer several small edits over one rewrite — each one shows the user exactly what changed, and an edit that no longer matches tells you the user has hand-edited that part rather than silently overwriting them.',
            parameters: {
                type: 'object',
                properties: {
                    documentId: { type: 'string', description: 'The document to edit.' },
                    slot: {
                        type: 'string',
                        enum: ['body', 'css'],
                        description: '"body" for the markup and its text, "css" for the stylesheet. Editing one never touches the other.',
                    },
                    find_text: { type: 'string', description: 'The exact text to find, copied verbatim from document_read. Whitespace-normalized matching is a fallback when verbatim fails.' },
                    replace_text: { type: 'string', description: 'What to put in its place. Empty string deletes.' },
                    replace_all: { type: 'boolean', description: 'When true, replace every occurrence. Default false — a single match is required.' },
                    summary: { type: 'string', description: 'A short note for the version history, e.g. "Corrected the VAT total".' },
                },
                required: ['documentId', 'slot', 'find_text', 'replace_text'],
            },
        },
    },
];

for (const tool of DOCUMENT_TOOLS) {
    const props = tool.function.parameters.properties;
    if (tool.function.name === 'create_document') {
        props.kind = { type:'string',enum:['document','template','section'] };
        props.settings = { type:'object',description:'Document settings including contract:{instructions,parameters:[{key,type,label,required,summary,instructions,example,default,fields}],sections:[{id,title,summary,condition}]}, and design controls. Section IDs correspond to data-doc-section attributes. Types: text, number, boolean, date, choice, list.' };
    }
    if (['document_write','document_edit'].includes(tool.function.name)) props.expectedVersionId = {type:'string',description:'versionId returned by document_read; protects concurrent edits.'};
    if (tool.function.name === 'document_write') props.settings = {type:'object',description:'Settings including the typed document contract. Preserve unrelated settings from document_read.'};
}

const DOCUMENT_TOOL_NAMES = new Set(DOCUMENT_TOOLS.map(t => t.function.name));

function isDocumentTool(toolName) {
    return DOCUMENT_TOOL_NAMES.has(toolName);
}

/**
 * @param {string} toolName
 * @param {object} args
 * @param {{userId: string}} ctx
 */
async function executeDocumentTool(toolName, args = {}, ctx = {}) {
    const userId = ctx.userId;
    if (!userId) return { error: 'No user context for document tools.' };

    if (toolName === 'create_document') {
        const name = typeof args.name === 'string' && args.name.trim()
            ? args.name.trim().slice(0, 200)
            : 'Untitled document';
        // Only record a DECISION. An absent key means "nobody decided", which
        // reads as the default ON — so a document made before the house style
        // existed picks the letterhead up the moment one is configured.
        const settings = { ...(args.settings || {}), ...(args.useHouseStyle === false ? {houseStyle:false} : {}) };
        const doc = await documentStore.createDocument({
            userId,
            name,
            docType: args.docType,
            description: typeof args.description === 'string' ? args.description.slice(0, 2000) : '',
            settings, kind: args.kind,
        });

        // The letterhead, handed over at the one moment it is useful: the model
        // is about to write the markup. Styling arrives as CSS variables the
        // composer injects (nothing to do); the FACTS are content, so they have
        // to be written into the body — which is also what lets the user
        // correct them by hand on this one invoice afterwards.
        let house = null;
        if (args.useHouseStyle !== false) {
            try {
                house = houseStyle.houseStyleFacts(await houseStyle.getHouseStyle(ctx.orgId));
            } catch (e) {
                log.warn('[DocumentTools] House style unavailable:', e.message);
            }
        }

        const deck = doc.docType === 'presentation';
        const lines = deck
            ? [`Created presentation "${doc.name}". Now write its outline with document_write({ documentId: "${doc.id}", bodyHtml: <outline> }) — markdown: "# Title" once, "## " per slide, "- " bullets, "### Card {icon: name}" blocks (2–6 per slide), \`\`\`chart and \`\`\`stats blocks, "<!-- layout: timeline|closing -->", "Notes: …" for speaker notes, {{placeholders}} where a routine fills values. No HTML, no css: the house style (colours, fonts, logo) is applied automatically. Reply with a clickable link "[${doc.name}](${documentUrl(doc.id)})" — it opens the slides in Bee Flow.`]
            : [`Created document "${doc.name}". Now fill it with document_write({ documentId: "${doc.id}", bodyHtml, css }).`];
        if (house && !deck) {
            lines.push(
                'This organisation has a house style. Its colours and fonts are already applied as CSS'
                + ' custom properties — use `var(--doc-accent)`, `var(--doc-ink)`, `var(--doc-muted)` in your'
                + ' stylesheet rather than inventing hex codes.'
                + (house.hasLogo ? ' A logo is configured: put `<div class="doc-logo"></div>` where it belongs and the composer fills it in.' : '')
                + ' Write these company details into the document itself:',
                JSON.stringify(house),
            );
        }

        return {
            documentId: doc.id, versionId: doc.versionId,
            url: documentUrl(doc.id),
            name: doc.name,
            docType: doc.docType,
            houseStyle: house,
            message: lines.join('\n'),
        };
    }

    if (toolName === 'document_read') {
        const doc = await documentStore.getDocument(String(args.documentId || ''), userId);
        if (!doc) return { error: 'Document not found.' };
        const deck = doc.docType === 'presentation';
        return {
            documentId: doc.id,
            name: doc.name,
            docType: doc.docType,
            versionId: doc.versionId, settings: doc.settings, contract: require('../core/documents/documentContract').getContract(doc),
            bodyHtml: doc.bodyHtml,
            ...(deck ? { outline: doc.bodyHtml } : { css: doc.css }),
            message: deck ? `Read the outline of "${doc.name}" (a presentation: bodyHtml is the slide outline, there is no css).` : `Read "${doc.name}".`,
        };
    }

    if (toolName === 'document_write') {
        const documentId = String(args.documentId || '');
        const existing = await documentStore.getDocument(documentId, userId);
        if (!existing) return { error: 'Document not found.' };
        if (existing.versionId && (existing.bodyHtml || existing.css) && !args.expectedVersionId) return { error: 'Read document_read first and pass its versionId as expectedVersionId.' };

        const updates = {};
        const deck = existing.docType === 'presentation';
        if (args.settings) updates.settings = args.settings;
        if (typeof args.bodyHtml === 'string') updates.bodyHtml = args.bodyHtml;
        else if (deck && typeof args.outline === 'string') updates.bodyHtml = args.outline;
        // A presentation has no stylesheet: its look is settings.deck, painted
        // by the deck engine. A css write would be stored and never read.
        if (typeof args.css === 'string' && !deck) updates.css = args.css;
        if (Object.keys(updates).length === 0) {
            return { error: deck ? 'Nothing to write — pass bodyHtml (the slide outline). A presentation has no css.' : 'Nothing to write — pass bodyHtml, css, or both.' };
        }

        // Snapshot the state being replaced. Same rule as the PATCH route: the
        // user's hand-edits are what this most often overwrites, so the undo
        // has to exist before the write, not after.
        try {
            await documentStore.snapshotVersion(documentId, userId, args.summary || 'Before AI edit');
        } catch (e) {
            log.warn('[DocumentTools] Version snapshot failed:', e.message);
        }

        let updated;
        try {
            updated = await documentStore.updateDocument(documentId, userId, { ...updates, expectedVersionId: args.expectedVersionId || existing.versionId });
        } catch (e) {
            if (e.errorClass === 'document_too_large') return { error: e.message };
            throw e;
        }

        if (!updated) return { error: 'Document is read-only.' };
        return {
            documentId,
            url: documentUrl(documentId),
            name: updated?.name, versionId: updated?.versionId,
            wrote: Object.keys(updates),
            message: `Updated ${Object.keys(updates).join(' and ')} on "${updated.name}". Reply with a clickable link of the form "[${updated.name}](${documentUrl(documentId)})".`,
        };
    }

    if (toolName === 'document_edit') {
        const documentId = String(args.documentId || '');
        const slot = args.slot;
        if (slot !== 'body' && slot !== 'css') {
            return { error: 'slot must be "body" (the markup) or "css" (the stylesheet).' };
        }
        const doc = await documentStore.getDocument(documentId, userId);
        if (!doc) return { error: 'Document not found.' };
        if (slot === 'css' && doc.docType === 'presentation') return { error: 'A presentation has no stylesheet — edit slot "body" (the slide outline); its look is settings.deck.' };

        const field = slot === 'body' ? 'bodyHtml' : 'css';
        if (doc.versionId && !args.expectedVersionId) return { error: 'Read document_read first and pass its versionId as expectedVersionId.' };
        const label = slot === 'body' ? (doc.docType === 'presentation' ? 'The slide outline' : 'The document body') : 'The stylesheet';

        // The find/replace IS the concurrency guard. A full-slot write would
        // overwrite a hand-edit without noticing; a snippet that no longer
        // matches tells the model the user has changed that part, and the hint
        // says what is there now.
        const out = applyFindReplace(doc[field] || '', {
            findText: args.find_text,
            replaceText: args.replace_text ?? '',
            replaceAll: args.replace_all === true,
            label,
            readHint: `Call document_read({ documentId: "${documentId}" })`,
        });
        if (out.error) return { error: out.error };

        try {
            await documentStore.snapshotVersion(documentId, userId, args.summary || 'Before AI edit');
        } catch (e) {
            log.warn('[DocumentTools] Version snapshot failed:', e.message);
        }

        let updated;
        try {
            updated = await documentStore.updateDocument(documentId, userId, { [field]: out.content, expectedVersionId: args.expectedVersionId || doc.versionId });
        } catch (e) {
            if (e.errorClass === 'document_too_large') return { error: e.message };
            throw e;
        }

        if (!updated) return { error: 'Document is read-only.' };
        return {
            documentId,
            url: documentUrl(documentId),
            name: updated?.name, versionId: updated?.versionId,
            slot,
            message: out.message,
        };
    }

    return { error: `Unknown document tool: ${toolName}` };
}

module.exports = {
    DOCUMENT_TOOLS,
    isDocumentTool,
    executeDocumentTool,
    documentUrl,
};
