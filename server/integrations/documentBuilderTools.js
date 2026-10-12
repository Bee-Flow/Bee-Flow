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
const documentFeed = require('../core/documents/documentFeed');
const { applyFindReplace } = require('../core/text/findReplace');
const { wordStats } = require('../stores/lib/documentText');
const { canEditAs } = require('../stores/lib/projectRole');
const log = require('../telemetry/log');
const { NOT_SHARED } = require('../core/documents/aiDocumentScope');
const { shouldSuggest } = require('../core/documents/suggestions/policy');

/**
 * A reader who may see this document but not change it: a project viewer.
 * Asked BEFORE any write, because a page edited live is written through the
 * live layer, which takes an actor and no role (the stored-body path would
 * have refused them in updateDocument; the live one would not).
 */
const readOnlyFor = (doc) => !!doc.projectRole && !canEditAs(doc.projectRole);
const READ_ONLY = { error: 'Document is read-only.' };
// A spreadsheet's cells are in a datatable, not in the body slots.
const sheetTools = () => require('./sheetDocumentTools');

// A page edited live has no stored revision that says what the model read: the
// live state moves with every keystroke. document_read hands out a versionId
// that also names the live update it read (`<versionId>@live:<seq>`), and a
// full write is applied only while that is still the newest.
const LIVE_MARK = '@live:';
const liveToken = (versionId, seq) => `${versionId || ''}${LIVE_MARK}${seq}`;
function parseExpected(value) {
    const text = typeof value === 'string' ? value : '';
    const at = text.lastIndexOf(LIVE_MARK);
    if (at < 0) return { versionId: text || null, seq: null };
    const seq = Number(text.slice(at + LIVE_MARK.length));
    return { versionId: text.slice(0, at) || null, seq: Number.isInteger(seq) && seq >= 0 ? seq : null };
}

/** The live state of a page and the update it is at (seq null when the facade cannot say). */
async function readLive(live, id) {
    if (typeof live.read === 'function') {
        const state = await live.read('document', id);
        if (state) return { html: state.html ?? '', seq: Number.isInteger(state.seq) ? state.seq : null };
    }
    return { html: typeof live.readHtml === 'function' ? await live.readHtml('document', id) : null, seq: null };
}

/**
 * Run `fn({ html, fragment })` on what people see now: the live state of a
 * co-edited page, opened once so anchors get relative positions into the very
 * fragment the editors hold, or the stored body (fragment null).
 */
async function withCurrentBody(live, id, storedHtml, fn) {
    const stored = { html: storedHtml || '', fragment: null };
    if (!live) return fn(stored);
    if (typeof live.withFragment === 'function') {
        const out = await live.withFragment('document', id, ({ html, fragment }) => fn({ html: typeof html === 'string' ? html : stored.html, fragment }));
        return out === null ? fn(stored) : out;
    }
    const current = (await readLive(live, id)).html;
    return fn({ html: typeof current === 'string' ? current : stored.html, fragment: null });
}

// What an AI edit is in the history: its own version, marked as the AI's,
// made for the person whose chat asked for it (never folded into their typing).
const aiRevision = (userId, summary) => ({
    source: 'ai', summary: typeof summary === 'string' && summary.trim() ? summary.trim().slice(0, 500) : 'AI edit',
    contributors: [{ userId, kind: 'ai' }],
});

const MAX_OPEN_SUGGESTIONS_LISTED = 50;

/**
 * Does an AI change to this page wait for a human (suggestions)? Direct only for
 * a page this chat made, private, unfiled and not live
 * (core/documents/suggestions/policy.js).
 */
const mustSuggest = (doc, ctx, live) => doc.docType === 'page' && shouldSuggest({
    doc, createdInThisChat: !!(ctx.documentScope && typeof ctx.documentScope.createdInChat === 'function' && ctx.documentScope.createdInChat(doc.id)),
    liveSession: !!live,
});

const suggestionStoreOf = (ctx) => ctx.suggestionStore || require('../stores/documentSuggestionStore');

/**
 * Turn "the body the model wants" into stored suggestions instead of a write:
 * one per run of changed blocks, for the person to accept. Nothing is changed.
 * `currentHtml` is what people see now (the live state for a live page).
 */
async function suggestBody({ doc, userId, ctx, currentHtml, proposedHtml, baseToken, summary, fragment = null }) {
    const engine = ctx.engine || require('../core/documents/suggestions/engine').engine();
    let { hunks } = engine.hunksFrom(engine.htmlToAst(currentHtml || ''), engine.htmlToAst(proposedHtml || ''));
    // A live page: anchors also get relative positions into the shared fragment.
    if (fragment && hunks.length && typeof engine.anchorsForFragment === 'function') hunks = engine.anchorsForFragment(fragment, hunks);
    if (!hunks.length) {
        return { suggested: 0, documentId: doc.id, url: documentUrl(doc.id), name: doc.name, message: `Nothing to propose: "${doc.name}" already reads like that.` };
    }
    const { batchId, suggestions } = await suggestionStoreOf(ctx).createBatch({
        targetType: 'document', targetId: doc.id, projectId: doc.projectId || null, organizationId: doc.organizationId || null,
        conversationId: ctx.conversationId || null, authorKind: 'ai', authorUserId: userId, agentId: ctx.agentId || null,
        kind: 'text', baseToken: baseToken || doc.versionId || null, hunks,
        resource: require('../stores/lib/documentCrypto').resourceOfDocument(doc),
    });
    const open = await suggestionStoreOf(ctx).countOpen('document', doc.id);
    await (ctx.announceSuggestions || require('../core/documents/suggestions/events').announceSuggestions)({
        documentId: doc.id, projectId: doc.projectId || null, batchId, open,
    });
    const n = suggestions.length;
    return {
        suggested: n, batchId, documentId: doc.id, url: documentUrl(doc.id), name: doc.name,
        ...(summary ? { note: String(summary).slice(0, 500) } : {}),
        message: `Proposed ${n} change${n === 1 ? '' : 's'} to "${doc.name}"; they wait for the user to accept them in the document. Do not claim they are applied.`,
    };
}

const APP_PATH = 'app/studio/documents';

function documentUrl(id) {
    return `/${APP_PATH}/${id}`;
}

const DOCUMENT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'create_document',
            description: 'Create a new rendered Document (an invoice, quote, letter, report or similar) owned by the current user. Returns { documentId, url, name, message }.\n\nCall this FIRST when the user asks for a NEW document; do not call it to edit an existing one. A document has exactly TWO slots — `bodyHtml` (the body markup) and `css` (the stylesheet) — which you fill with document_write immediately afterwards.\n\nUse a Document, not a Webpage, whenever the thing is meant to be PRINTED or sent as a PDF: invoices, quotes, order confirmations, letters, certificates, reports. Use a Webpage when it is meant to be interactive or visited in a browser. When the user asks for a WORD file (.docx) to edit in Word, use create_word_document instead.\n\nA PRESENTATION in the library is `docType: "presentation"`: its body slot is a slide OUTLINE (markdown: "# " title, "## " per slide, "- " bullets, "### " cards, ```chart / ```stats blocks) and it has no css — the house style paints it. It opens as a slide viewer in Bee Flow and downloads as .pptx or PDF. Prefer create_presentation when the user just wants a deck now; use this when they want a reusable slide TEMPLATE with {{placeholders}} for automations.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'A short human-readable title, e.g. "Factuur 2026-014 — Van Dijk Groep".',
                    },
                    docType: {
                        type: 'string',
                        // A page is written in the rich-text editor and made from a
                        // project; what the chat creates is designed (body + css).
                        enum: documentStore.DOC_TYPES.filter((t) => t !== 'page' && t !== 'spreadsheet'),
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
            description: 'Read a document\'s current slots. Returns { name, docType, bodyHtml, css }.\n\nFor a PAGE it also returns openSuggestions: [{ id, summary }], changes already proposed and not yet accepted, so you do not propose the same thing twice.\n\nUse it before editing a document you did not write this turn — including one the user has since changed by hand, which is the common case: they moved a line or corrected an amount and are now asking you to change something else. Writing without reading would silently revert their edit.',
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
            description: 'Replace a WHOLE slot. Use this to fill a new document, or for a redesign that rewrites the stylesheet from scratch.\n\nFor any change to a document that already has content — a corrected amount, an extra line, a different colour — use `document_edit` instead. A full rewrite costs the entire document in output tokens and, worse, silently discards whatever the user changed by hand since you last read it.\n\nPass `bodyHtml`, `css`, or both; an omitted slot is left exactly as it is.\n\n`bodyHtml` is BODY MARKUP ONLY — no <html>, <head>, <body> or <style> tags, and no <script> (scripts are stripped: a document does not run). `css` is the full stylesheet, and it owns the paper: set `@page { size: A4; margin: 18mm 16mm; }` (or whatever the document needs) there.\n\nWrite semantic markup with classes — <table class="lines">, <div class="totals"> — and do the layout in `css`. That is what lets the user hand-edit the text afterwards without the layout coming apart.\n\nA PAGE that is not yours alone (filed in a project, shared, or open for others) is never changed directly: your body becomes SUGGESTIONS the user accepts one by one, and the result says { suggested, batchId }. Do not claim they are applied.',
            parameters: {
                type: 'object',
                properties: {
                    documentId: { type: 'string', description: 'The document to write to.' },
                    bodyHtml: { type: 'string', description: 'The document body markup. Omit to leave the current body untouched.' },
                    css: { type: 'string', description: 'The document stylesheet. Omit to leave the current stylesheet untouched.' },
                    summary: { type: 'string', description: 'A short note for the version history, e.g. "Added VAT row".' },
                    cells: { type: 'object', additionalProperties: { type: 'string' }, description: 'SPREADSHEETS ONLY (docType "spreadsheet", which has no bodyHtml or css): the cells to set, e.g. { "A1": "Rent", "B1": "1200", "B3": "=SUM(B1:B2)" }. Columns A–Z, rows from 1; "" clears a cell. At most 500 cells per call.' },
                },
                required: ['documentId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'document_edit',
            description: 'PREFERRED tool for changing an existing document. Replaces a specific snippet inside ONE slot and leaves everything else exactly as it was.\n\nUse it for both of the things people ask for most:\n  • TEXT — "change the amount to 1.320", "add a line for transport", "fix the address". Edit `slot: "body"`.\n  • STYLING ONLY — "make the header green", "bigger totals", "more space above the table". Edit `slot: "css"`; the text is not touched at all.\n\nWorkflow: `document_read` FIRST to see the exact current content, then copy find_text verbatim from what you read. find_text must match EXACTLY ONCE by default; on several matches the tool refuses and lists the line numbers, so either narrow the snippet or pass replace_all: true.\n\nINSERT by anchoring on a stable nearby snippet and repeating it in replace_text. DELETE by passing replace_text: "".\n\nPrefer several small edits over one rewrite — each one shows the user exactly what changed, and an edit that no longer matches tells you the user has hand-edited that part rather than silently overwriting them.\n\nOn a PAGE that is not yours alone the edit becomes a SUGGESTION the user accepts in the document ({ suggested, batchId } in the result); do not claim it is applied.',
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
 * @param {{userId: string, orgId?: string, conversationId?: string, agentId?: string, documentScope?: {has(id: string): boolean, add(id: string): void, markCreated?(id: string): void, createdInChat?(id: string): boolean}, suggestionStore?: any, announceSuggestions?: Function, engine?: any}} ctx
 */
async function executeDocumentTool(toolName, args = {}, ctx = {}) {
    const userId = ctx.userId;
    if (!userId) return { error: 'No user context for document tools.' };

    // The AI touches only documents the person pointed at (side panel, made in
    // this chat, linked in their own message): core/documents/aiDocumentScope.js.
    // Checked BEFORE any lookup, so the answer never says whether an id exists,
    // and no scope at all (another caller) means no access.
    const scope = ctx.documentScope;
    if (toolName !== 'create_document' && ['document_read', 'document_write', 'document_edit'].includes(toolName)
        && !(scope && typeof scope.has === 'function' && scope.has(String(args.documentId || '')))) {
        return { error: NOT_SHARED };
    }

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
            ? [`Created presentation "${doc.name}". Now write its outline with document_write({ documentId: "${doc.id}", bodyHtml: <outline> }) — markdown: "# Title" once, "## " per slide, "- " bullets, "### Card {icon: name}" blocks (2–6 per slide), \`\`\`chart and \`\`\`stats blocks, "<!-- layout: timeline|closing -->", "Notes: …" for speaker notes, {{placeholders}} where an automation fills values. No HTML, no css: the house style (colours, fonts, logo) is applied automatically. Reply with a clickable link "[${doc.name}](${documentUrl(doc.id)})" — it opens the slides in Bee Flow.`]
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

        // Made in this chat: the model may carry on with it for the rest of the turn.
        if (scope && typeof scope.markCreated === 'function') scope.markCreated(doc.id);
        else if (scope && typeof scope.add === 'function') scope.add(doc.id);

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
        if (doc.docType === 'spreadsheet') return sheetTools().readSheetDocument(doc);
        // A page edited live: what people see now is the live state, and the
        // versionId names the live update it was read at.
        const live = await documentFeed.liveCollabFor(doc);
        let versionId = doc.versionId;
        if (live) {
            const state = await readLive(live, doc.id);
            if (typeof state.html === 'string') doc.bodyHtml = state.html;
            if (state.seq != null) versionId = liveToken(doc.versionId, state.seq);
        }
        const deck = doc.docType === 'presentation';
        const readOnly = readOnlyFor(doc);
        let message = deck ? `Read the outline of "${doc.name}" (a presentation: bodyHtml is the slide outline, there is no css).` : `Read "${doc.name}".`;
        if (live) message += ' This page is being edited live by others: prefer document_edit; a full document_write is refused once anybody has typed since this read.';
        if (readOnly) message += ' You may read this document but not change it (the user is a viewer of its project).';
        let openSuggestions;
        if (doc.docType === 'page') {
            try {
                openSuggestions = (await suggestionStoreOf(ctx).list('document', doc.id, { status: 'open' }))
                    .slice(0, MAX_OPEN_SUGGESTIONS_LISTED).map((x) => ({ id: x.id, summary: x.summary }));
            } catch (e) {
                log.warn('[DocumentTools] open suggestions not listed:', e.message);
            }
        }
        if (openSuggestions?.length) message += ` ${openSuggestions.length} suggestion(s) are already proposed and waiting (openSuggestions); do not propose them again.`;
        return {
            documentId: doc.id,
            name: doc.name,
            docType: doc.docType,
            ...(openSuggestions ? { openSuggestions } : {}),
            versionId, settings: doc.settings, contract: require('../core/documents/documentContract').getContract(doc),
            bodyHtml: doc.bodyHtml,
            ...(deck ? { outline: doc.bodyHtml } : { css: doc.css }),
            ...(readOnly ? { readOnly: true } : {}),
            message,
        };
    }

    if (toolName === 'document_write') {
        const documentId = String(args.documentId || '');
        const existing = await documentStore.getDocument(documentId, userId);
        if (!existing) return { error: 'Document not found.' };
        if (readOnlyFor(existing)) return READ_ONLY;
        if (existing.docType === 'spreadsheet') return sheetTools().writeSheetDocument(existing, args);
        if (existing.versionId && (existing.bodyHtml || existing.css) && !args.expectedVersionId) return { error: 'Read document_read first and pass its versionId as expectedVersionId.' };
        const expected = parseExpected(args.expectedVersionId);

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

        // A page has no stylesheet, and a page edited live is written through
        // the live layer, so every open editor shows the change at once.
        if (existing.docType === 'page') {
            delete updates.css;
            if (Object.keys(updates).length === 0) return { error: 'A page has no stylesheet — pass bodyHtml.' };
            const live = await documentFeed.liveCollabFor(existing);
            // Not the AI's own private page: the body becomes suggestions.
            if (mustSuggest(existing, ctx, live)) {
                if (Object.keys(updates).some((k) => k !== 'bodyHtml')) return { error: 'A page can only be proposed changes to its body — pass only bodyHtml.' };
                return withCurrentBody(live, documentId, existing.bodyHtml, ({ html, fragment }) => suggestBody({
                    doc: existing, userId, ctx, currentHtml: html, fragment,
                    proposedHtml: updates.bodyHtml, baseToken: args.expectedVersionId, summary: args.summary,
                }));
            }
            if (live) {
                if (Object.keys(updates).some((k) => k !== 'bodyHtml')) return { error: 'This page is being edited live — write only bodyHtml.' };
                // A whole-body write makes the page equal to what the model
                // wrote: only from the live state it read, never over what
                // somebody typed since.
                if (expected.seq == null) return { error: `This page is being edited live. Call document_read({ documentId: "${documentId}" }) and pass its versionId as expectedVersionId, or change it with document_edit.` };
                const liveOut = await writeLive(existing, userId, updates.bodyHtml, live, expected.seq);
                if (liveOut) return liveOut;
            }
        }

        let updated;
        try {
            updated = await documentStore.updateDocument(documentId, userId, {
                ...updates, expectedVersionId: expected.versionId || existing.versionId, ...aiRevision(userId, args.summary),
            });
        } catch (e) {
            if (e.errorClass === 'document_too_large' || e.errorClass === 'document_conflict') return { error: e.message };
            throw e;
        }

        if (updated) await reportAiEdit(existing, updated, userId);
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
        if (readOnlyFor(doc)) return READ_ONLY;
        if (doc.docType === 'spreadsheet') return sheetTools().SHEET_EDIT_REFUSAL;
        if (slot === 'css' && doc.docType === 'presentation') return { error: 'A presentation has no stylesheet — edit slot "body" (the slide outline); its look is settings.deck.' };

        const field = slot === 'body' ? 'bodyHtml' : 'css';
        if (doc.versionId && !args.expectedVersionId) return { error: 'Read document_read first and pass its versionId as expectedVersionId.' };
        const label = slot === 'body' ? (doc.docType === 'presentation' ? 'The slide outline' : 'The document body') : 'The stylesheet';
        const edit = (text) => applyFindReplace(text, {
            findText: args.find_text,
            replaceText: args.replace_text ?? '',
            replaceAll: args.replace_all === true,
            label,
            readHint: `Call document_read({ documentId: "${documentId}" })`,
        });

        // The find/replace IS the concurrency guard. A full-slot write would
        // overwrite a hand-edit without noticing; a snippet that no longer
        // matches tells the model the user has changed that part, and the hint
        // says what is there now.
        const live = slot === 'body' ? await documentFeed.liveCollabFor(doc) : null;
        if (slot === 'body' && mustSuggest(doc, ctx, live)) {
            return withCurrentBody(live, documentId, doc.bodyHtml, ({ html, fragment }) => {
                const proposed = edit(html);
                if (proposed.error) return { error: proposed.error };
                return suggestBody({ doc, userId, ctx, currentHtml: html, fragment, proposedHtml: proposed.content, baseToken: args.expectedVersionId, summary: args.summary });
            });
        }
        if (live) {
            const liveOut = await editLive(doc, userId, live, edit);
            if (liveOut) return liveOut.error ? liveOut : { ...liveOut, slot };
        }
        const out = edit(doc[field] || '');
        if (out.error) return { error: out.error };

        let updated;
        try {
            updated = await documentStore.updateDocument(documentId, userId, {
                [field]: out.content, expectedVersionId: parseExpected(args.expectedVersionId).versionId || doc.versionId, ...aiRevision(userId, args.summary),
            });
        } catch (e) {
            if (e.errorClass === 'document_too_large' || e.errorClass === 'document_conflict') return { error: e.message };
            throw e;
        }

        if (updated) await reportAiEdit(doc, updated, userId);
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

const LIVE_STALE = 'Somebody changed this page since you read it. Call document_read again and make your change with document_edit, so what they typed stays.';
// A find/replace re-reads the live state, so a keystroke landing between that
// read and the write is simply read again; after this many, it gives up.
const LIVE_EDIT_ATTEMPTS = 3;

/**
 * Write a page's body through the live layer when the page is being edited
 * live: the change reaches every open editor, and the live layer's checkpoint
 * records it as the AI's. `expectSeq` is the live update the body was made
 * from: when anybody typed since, nothing is written and the answer says so
 * (`{ error }`), because the body would undo what they typed. Null when the
 * page is not live (the caller then saves the stored body with its revision
 * check).
 */
async function writeLive(doc, userId, html, live, expectSeq) {
    if (!live || typeof live.applyServerEdit !== 'function') return null;
    const out = await live.applyServerEdit('document', doc.id, { origin: 'ai', actorId: userId }, { replaceWith: { html }, expectSeq });
    if (out?.stale) return { error: LIVE_STALE };
    if (!out?.applied) return null;
    return {
        documentId: doc.id,
        url: documentUrl(doc.id),
        name: doc.name,
        versionId: Number.isInteger(out.seq) ? liveToken(doc.versionId, out.seq) : doc.versionId,
        wrote: ['bodyHtml'],
        message: `Updated the page "${doc.name}" for everyone who has it open. Reply with a clickable link of the form "[${doc.name}](${documentUrl(doc.id)})".`,
    };
}

/**
 * A find/replace on a page edited live: applied to the live state and written
 * only from the update it was computed on. Null when the page turns out not to
 * be live (the caller edits the stored body).
 */
async function editLive(doc, userId, live, edit) {
    for (let attempt = 0; attempt < LIVE_EDIT_ATTEMPTS; attempt += 1) {
        const state = await readLive(live, doc.id);
        if (typeof state.html !== 'string') return null;
        const out = edit(state.html);
        if (out.error) return { error: out.error };
        const written = await writeLive(doc, userId, out.content, live, state.seq ?? undefined);
        if (!written) return null;
        if (!written.error) return { ...written, message: out.message };
    }
    return { error: LIVE_STALE };
}

/** Tell the project's change feed about an AI edit to a filed document. */
async function reportAiEdit(before, after, userId) {
    if (after.versionId === before.versionId) return;
    await documentFeed.recordContentChange(after, {
        actorId: userId, source: 'ai', versionId: after.versionId,
        contributors: [{ userId, kind: 'ai' }], stats: wordStats(before.bodyHtml, after.bodyHtml),
    });
}

module.exports = {
    DOCUMENT_TOOLS,
    isDocumentTool,
    executeDocumentTool,
    documentUrl,
};
