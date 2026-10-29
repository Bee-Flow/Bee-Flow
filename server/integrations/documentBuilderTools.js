// @typecheck noImplicitAny
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
const { DOCUMENT_TOOLS, DOCUMENT_TOOL_NAMES } = require('./documentBuilderToolDefs');

/**
 * A reader who may see this document but not change it: a project viewer.
 * Asked BEFORE any write, because a page edited live is written through the
 * live layer, which takes an actor and no role (the stored-body path would
 * have refused them in updateDocument; the live one would not).
 */
/**
 * @typedef {import('../stores/documentStore').DocumentView} DocView
 * @typedef {Parameters<typeof executeDocumentTool>[2]} DocToolCtx
 * The live co-editing facade (core/collab) as this file uses it; every method may be missing.
 * @typedef {{ read?: (type: string, id: string) => Promise<{ html?: string, seq?: number } | null>,
 *   readHtml?: (type: string, id: string) => Promise<string | null>,
 *   withFragment?: <R>(type: string, id: string, fn: (state: { html: unknown, fragment: unknown }) => R) => Promise<R | null>,
 *   applyServerEdit?: (type: string, id: string, actor: { origin: string, actorId: string },
 *     edit: { replaceWith: { html: string }, expectSeq?: number }) => Promise<{ stale?: boolean, applied?: boolean, seq?: number } | null> }} LiveCollab
 * @typedef {ReturnType<typeof applyFindReplace>} FindReplaceResult
 */

/** @param {DocView} doc */
const readOnlyFor = (doc) => !!doc.projectRole && !canEditAs(doc.projectRole);
const READ_ONLY = { error: 'Document is read-only.' };
// A spreadsheet's cells are in a datatable, not in the body slots.
const sheetTools = () => require('./sheetDocumentTools');
// A page edited live has no stored revision that says what the model read: the live state
// moves with every keystroke. document_read hands out a versionId that also names the live
// update it read (`<versionId>@live:<seq>`); a full write is applied only while that is newest.
const LIVE_MARK = '@live:';
/** @param {string | null | undefined} versionId @param {number} seq */
const liveToken = (versionId, seq) => `${versionId || ''}${LIVE_MARK}${seq}`;
/** @param {unknown} value */
function parseExpected(value) {
    const text = typeof value === 'string' ? value : '';
    const at = text.lastIndexOf(LIVE_MARK);
    if (at < 0) return { versionId: text || null, seq: null };
    const seq = Number(text.slice(at + LIVE_MARK.length));
    return { versionId: text.slice(0, at) || null, seq: Number.isInteger(seq) && seq >= 0 ? seq : null };
}

/** The live state of a page and the update it is at (seq null when the facade cannot say). */
/**
 * @param {LiveCollab} live
 * @param {string} id
 * @returns {Promise<{ html: string | null, seq: number | null }>}
 */
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
 *
 * @template R
 * @param {LiveCollab | null} live
 * @param {string} id
 * @param {string | undefined} storedHtml
 * @param {(body: { html: string, fragment: unknown }) => R} fn
 */
async function withCurrentBody(live, id, storedHtml, fn) {
    /** @type {{ html: string, fragment: unknown }} */
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
/** @param {string} userId @param {string | undefined} summary */
const aiRevision = (userId, summary) => ({
    source: 'ai', summary: typeof summary === 'string' && summary.trim() ? summary.trim().slice(0, 500) : 'AI edit',
    contributors: [{ userId, kind: 'ai' }],
});

const MAX_OPEN_SUGGESTIONS_LISTED = 50;

/**
 * Does an AI change to this page wait for a human (suggestions)? Direct only for
 * a page this chat made, private, unfiled and not live
 * (core/documents/suggestions/policy.js).
 *
 * @param {DocView} doc
 * @param {DocToolCtx} ctx
 * @param {LiveCollab | null} live
 */
const mustSuggest = (doc, ctx, live) => doc.docType === 'page' && shouldSuggest({
    doc, createdInThisChat: !!(ctx.documentScope && typeof ctx.documentScope.createdInChat === 'function' && ctx.documentScope.createdInChat(doc.id)),
    liveSession: !!live,
});

/** @param {DocToolCtx} ctx */
const suggestionStoreOf = (ctx) => ctx.suggestionStore || require('../stores/documentSuggestionStore');

/**
 * Turn "the body the model wants" into stored suggestions instead of a write:
 * one per run of changed blocks, for the person to accept. Nothing is changed.
 * `currentHtml` is what people see now (the live state for a live page).
 *
 * @param {{ doc: DocView, userId: string, ctx: DocToolCtx, currentHtml: string, proposedHtml: string,
 *   baseToken?: string, summary?: string, fragment?: unknown }} params
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
/** @param {string} id */
function documentUrl(id) {
    return `/${APP_PATH}/${id}`;
}

/**
 * The organisation's house style facts for a new document, or null when none
 * can be read (logged; the document is made without them).
 * @param {string | undefined} orgId
 */
async function houseFactsFor(orgId) {
    try {
        return houseStyle.houseStyleFacts(await houseStyle.getHouseStyle(orgId));
    } catch (e) {
        log.warn('[DocumentTools] House style unavailable:', /** @type {Error} */ (e).message);
        return null;
    }
}

/**
 * What create_document tells the model to do next: write the outline of a
 * presentation, or fill a document — with the house style to use when there is one.
 * @param {{ id: string, name: string, docType: string }} doc
 * @param {ReturnType<typeof houseStyle.houseStyleFacts> | null} house
 * @returns {string[]}
 */
function createdDocumentLines(doc, house) {
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
    return lines;
}

/** @param {string} toolName */
function isDocumentTool(toolName) {
    return DOCUMENT_TOOL_NAMES.has(toolName);
}

/**
 * @typedef {{ documentId?: string, name?: string, settings?: import('../stores/documentStore').DocSettings, useHouseStyle?: boolean, docType?: string,
 *   description?: string, kind?: string, expectedVersionId?: string, bodyHtml?: string, outline?: string,
 *   css?: string, summary?: string, slot?: string, find_text?: string, replace_text?: string,
 *   replace_all?: boolean, format?: string, tab?: string, mode?: string, range?: string }} DocumentToolArgs
 */

/**
 * @param {string} toolName
 * @param {DocumentToolArgs} args
 * @param {{userId?: string, orgId?: string, conversationId?: string, agentId?: string, documentScope?: {has(id: string): boolean, add(id: string): void, markCreated?(id: string): void, createdInChat?(id: string): boolean}, suggestionStore?: any, announceSuggestions?: Function, engine?: any}} [ctx]
 */
async function executeDocumentTool(toolName, args = {}, ctx = {}) {
    const userId = ctx.userId;
    if (!userId) return { error: 'No user context for document tools.' };

    // The AI touches only documents the person pointed at (core/documents/aiDocumentScope.js),
    // checked BEFORE any lookup: the answer never says whether an id exists; no scope, no access.
    const scope = ctx.documentScope;
    if (outsideScope(toolName, args, scope)) return { error: NOT_SHARED };

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
        const house = args.useHouseStyle !== false ? await houseFactsFor(ctx.orgId) : null;
        const lines = createdDocumentLines(doc, house);

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

    if (toolName === 'document_download') {
        const doc = await documentStore.getDocument(String(args.documentId || ''), userId);
        return doc ? require('./sheetDownloadTool').downloadSheetDocument(doc, args, { userId }) : { error: 'Document not found.' };
    }
    if (toolName === 'document_read') {
        const doc = await documentStore.getDocument(String(args.documentId || ''), userId);
        if (!doc) return { error: 'Document not found.' };
        if (doc.docType === 'spreadsheet') return sheetTools().readSheetDocument(doc, {}, args);
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
        const openSuggestions = doc.docType === 'page' ? await openSuggestionsOf(doc, ctx) : undefined;
        const message = readMessage(doc, { deck, live: !!live, readOnly, openSuggestions });
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
        if (existing.docType === 'spreadsheet') return sheetTools().writeSheetDocument(existing, args, { actorUserId: userId });
        if (existing.versionId && (existing.bodyHtml || existing.css) && !args.expectedVersionId) return { error: 'Read document_read first and pass its versionId as expectedVersionId.' };
        const expected = parseExpected(args.expectedVersionId);

        const deck = existing.docType === 'presentation';
        const updates = writeUpdates(args, deck);
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

        const stored = await storeUpdate(documentId, userId, {
            ...updates, expectedVersionId: expected.versionId || existing.versionId, ...aiRevision(userId, args.summary),
        });
        if ('error' in stored) return stored;
        const { updated } = stored;

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
        const edit = findReplaceFor(args, documentId, label);

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

        const stored = await storeUpdate(documentId, userId, {
            [field]: out.content, expectedVersionId: parseExpected(args.expectedVersionId).versionId || doc.versionId, ...aiRevision(userId, args.summary),
        });
        if ('error' in stored) return stored;
        const { updated } = stored;

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

/**
 * The open suggestions already proposed on a page (at most
 * MAX_OPEN_SUGGESTIONS_LISTED), so the model does not propose them again;
 * undefined when they cannot be listed (logged).
 * @param {{ id: string }} doc
 * @param {DocToolCtx} ctx
 * @returns {Promise<Array<{ id: string, summary: string | null }> | undefined>}
 */
async function openSuggestionsOf(doc, ctx) {
    try {
        return (await suggestionStoreOf(ctx).list('document', doc.id, { status: 'open' }))
            .slice(0, MAX_OPEN_SUGGESTIONS_LISTED).map((/** @type {import('../stores/documentSuggestionStore').SuggestionRow} */ x) => ({ id: x.id, summary: x.summary }));
    } catch (e) {
        log.warn('[DocumentTools] open suggestions not listed:', /** @type {Error} */ (e).message);
        return undefined;
    }
}

/**
 * Whether a tool that names a document names one outside what the person
 * pointed the AI at (core/documents/aiDocumentScope.js). No scope, no access.
 * @param {string} toolName
 * @param {DocumentToolArgs} args
 * @param {DocToolCtx['documentScope']} scope
 */
function outsideScope(toolName, args, scope) {
    return toolName !== 'create_document' && ['document_read', 'document_write', 'document_edit', 'document_download'].includes(toolName)
        && !(scope && typeof scope.has === 'function' && scope.has(String(args.documentId || '')));
}

/**
 * document_edit's change as a function of the slot's current text: the
 * find/replace the model asked for, which is also the concurrency guard (a
 * snippet that no longer matches says the user changed that part).
 * @param {DocumentToolArgs} args
 * @param {string} documentId
 * @param {string} label  what the slot is called in the answer
 */
function findReplaceFor(args, documentId, label) {
    /** @param {string} text */
    return (text) => applyFindReplace(text, {
        findText: args.find_text,
        replaceText: args.replace_text ?? '',
        replaceAll: args.replace_all === true,
        label,
        readHint: `Call document_read({ documentId: "${documentId}" })`,
    });
}

/**
 * What document_read tells the model about the document it read.
 * @param {{ name: string }} doc
 * @param {{ deck: boolean, live: boolean, readOnly: boolean, openSuggestions?: unknown[] }} state
 */
function readMessage(doc, { deck, live, readOnly, openSuggestions }) {
    let message = deck ? `Read the outline of "${doc.name}" (a presentation: bodyHtml is the slide outline, there is no css).` : `Read "${doc.name}".`;
    if (live) message += ' This page is being edited live by others: prefer document_edit; a full document_write is refused once anybody has typed since this read.';
    if (readOnly) message += ' You may read this document but not change it (the user is a viewer of its project).';
    if (openSuggestions?.length) message += ` ${openSuggestions.length} suggestion(s) are already proposed and waiting (openSuggestions); do not propose them again.`;
    return message;
}

/**
 * The fields a document_write changes. A presentation has no stylesheet: its
 * look is settings.deck, painted by the deck engine, so a css write would be
 * stored and never read; its body may come as `outline`.
 * @param {DocumentToolArgs} args
 * @param {boolean} deck  the document is a presentation
 * @returns {{ settings?: DocumentToolArgs['settings'], bodyHtml?: string, css?: string }}
 */
function writeUpdates(args, deck) {
    /** @type {{ settings?: DocumentToolArgs['settings'], bodyHtml?: string, css?: string }} */
    const updates = {};
    if (args.settings) updates.settings = args.settings;
    if (typeof args.bodyHtml === 'string') updates.bodyHtml = args.bodyHtml;
    else if (deck && typeof args.outline === 'string') updates.bodyHtml = args.outline;
    if (typeof args.css === 'string' && !deck) updates.css = args.css;
    return updates;
}

/**
 * Store a document update. A document too large or changed since it was read
 * is the tool's error; any other failure is thrown.
 * @param {string} documentId
 * @param {string} userId
 * @param {Parameters<typeof documentStore.updateDocument>[2]} changes
 * @returns {Promise<{ updated: Awaited<ReturnType<typeof documentStore.updateDocument>> } | { error: string }>}
 */
async function storeUpdate(documentId, userId, changes) {
    try {
        return { updated: await documentStore.updateDocument(documentId, userId, changes) };
    } catch (e) {
        if (e.errorClass === 'document_too_large' || e.errorClass === 'document_conflict') return { error: /** @type {Error} */ (e).message };
        throw e;
    }
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
 *
 * @param {DocView} doc
 * @param {string} userId
 * @param {string} html
 * @param {LiveCollab | null} live
 * @param {number | undefined} expectSeq
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
 *
 * @param {DocView} doc
 * @param {string} userId
 * @param {LiveCollab} live
 * @param {(text: string) => FindReplaceResult} edit
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

/**
 * Tell the project's change feed about an AI edit to a filed document.
 * @param {DocView} before
 * @param {DocView} after
 * @param {string} userId
 */
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
