// @typecheck
'use strict';
/**
 * What a direct-chat turn (POST /ai/chat/direct/stream) may carry.
 *
 * TYPED, NOT CLOSED — deliberately. The chat engine builds this body from
 * its host's extras (`getNotebookPayload()`, `directMode.getExtraPayload()`)
 * and posts the SAME bag to a host's own endpoint when it has one
 * (`customEndpoint`: the notebook and webpage chats). A key one endpoint does
 * not read is therefore expected here, not a typo; refusing it would break a
 * host the moment it adds an extra for its own endpoint. What this schema
 * does is make every key the turn DOES read the type the turn assumes:
 *
 *   - `webSearchEnabled: "false"` searched the web (the text is truthy), and
 *     `memoryWriteEnabled: "false"` wrote the turn to memory (only the boolean
 *     false stopped it). Both now read "false" as false; anything else that is
 *     not a boolean is a 400.
 *   - a `history` or `attachments` that is not a list reached `.length` and
 *     `.map` inside the turn, after the SSE headers had gone out.
 *
 * Shared with routes/ai/notebookChat.js and routes/ai/webpageChat.js, which
 * take the same engine's bag.
 */

const { z, worded, orEmpty, flag, onUnknownKeys, typeError } = require('../../../core/http/schemaParts');

const text = (name, max) => worded(`${name} is text.`).max(max, `${name} is at most ${max} characters.`);
const list = (name) => z.array(z.unknown(), { error: typeError({ invalid: `${name} is a list.` }) });
const bag = (name) => z.record(z.string(), z.unknown(), { error: typeError({ invalid: `${name} is an object.` }) });
const onOff = (name) => flag(`${name} is true or false.`);

/** The keys every chat-engine turn shares, typed. */
const TURN_SHAPE = {
    message: text('message', 1_000_000).nullish(),
    conversationId: text('conversationId', 200).nullish(),
    modelTier: text('modelTier', 100).nullish(),
    history: list('history').nullish(),
    attachments: list('attachments').nullish(),
    timezone: text('timezone', 100).nullish(),
    reasoningEffort: text('reasoningEffort', 40).nullish(),
    webSearchEnabled: onOff('webSearchEnabled').nullish(),
    memoryWriteEnabled: onOff('memoryWriteEnabled').nullish(),
    memoryReadEnabled: onOff('memoryReadEnabled').nullish(),
    disabledMedia: bag('disabledMedia').nullish(),
};

/** The direct chat's own additions. */
const DirectTurnBody = orEmpty(z.object({
    ...TURN_SHAPE,
    imageGenSettings: bag('imageGenSettings').nullish(),
    nanoBananaSettings: bag('nanoBananaSettings').nullish(),
    notebookspaceContent: text('notebookspaceContent', 5_000_000).nullish(),
    notebookspaceSelection: text('notebookspaceSelection', 1_000_000).nullish(),
    notebookspaceAvailable: onOff('notebookspaceAvailable').nullish(),
    projectId: text('projectId', 200).nullish(),
    // The Studio document open next to the chat. Shape is checked again in
    // core/documents/aiDocumentScope.js; a bad value is ignored, not refused.
    sidePanelDocument: z.unknown().optional(),
    systemPrompt: text('systemPrompt', 200_000).nullish(),
    activeSkillIds: list('activeSkillIds').nullish(),
    activatedSessionSkillIds: list('activatedSessionSkillIds').nullish(),
    knowledgeBaseIds: list('knowledgeBaseIds').nullish(),
    // Chat signals (core/privacy/chatSignals.js): the notice marker the
    // composer sends when it showed the chat-signals line for exactly this
    // configuration (`direct@<version>`), and the person's "don't count my
    // chat turns" switch. A turn without the marker is not counted.
    chatSignalsNotice: text('chatSignalsNotice', 120).nullish(),
    chatSignalsOptOut: onOff('chatSignalsOptOut').nullish(),
}, { error: typeError({ invalid: 'A chat turn is a JSON object.' }) }).passthrough());

/**
 * The editor selection a bubble-menu action (Rewrite, Shorten, Expand, Ask)
 * sends with its turn. It was declared as text while the page sent this object
 * and the handler read `.text`, so every one of those actions was refused
 * with a 400. Closed: it is one shape, written by one caller.
 */
const SELECTION_TEXT = 'notebookSelection is { text, from?, to?, action? }.';
const position = (name) => z.number({ error: typeError({ invalid: `${name} is a position in the document.` }) })
    .int(`${name} is a position in the document.`).min(0, `${name} is a position in the document.`);
const NotebookSelection = z.object({
    text: text('notebookSelection.text', 1_000_000),
    from: position('notebookSelection.from').nullish(),
    to: position('notebookSelection.to').nullish(),
    action: z.enum(['rewrite', 'shorten', 'expand', 'ask'], { error: () => 'notebookSelection.action is rewrite, shorten, expand or ask.' }).nullish(),
}, { error: onUnknownKeys(SELECTION_TEXT, typeError({ invalid: SELECTION_TEXT })) }).strict();

/** A turn about a notebook (routes/ai/notebookChat.js). */
const NotebookTurnBody = orEmpty(z.object({
    ...TURN_SHAPE,
    notebookId: text('notebookId', 200).nullish(),
    documentContent: text('documentContent', 5_000_000).nullish(),
    notebookSelection: NotebookSelection.nullish(),
    // The document version the page has loaded: an AI edit is written only
    // over that version, never blindly over a newer save.
    docVersion: z.number({ error: typeError({ invalid: 'docVersion is the whole-number version you loaded.' }) })
        .int('docVersion is the whole-number version you loaded.')
        .min(0, 'docVersion is the whole-number version you loaded.').nullish(),
}, { error: typeError({ invalid: 'A chat turn is a JSON object.' }) }).passthrough());

/**
 * A turn about a webpage (routes/ai/webpageChat.js). `chatMode` fell back to
 * `auto` for anything it did not know, so a typo in `plan` — propose, change
 * nothing — made the builder edit the page straight away.
 */
const WebpageTurnBody = orEmpty(z.object({
    ...TURN_SHAPE,
    webpageId: text('webpageId', 200).nullish(),
    htmlContent: text('htmlContent', 10_000_000).nullish(),
    cssContent: text('cssContent', 10_000_000).nullish(),
    jsContent: text('jsContent', 10_000_000).nullish(),
    webpageSelection: z.unknown().optional(),
    planExecution: z.unknown().optional(),
    chatMode: z.enum(['ask', 'auto', 'plan'], { error: () => 'chatMode is ask, auto or plan.' }).nullish(),
}, { error: typeError({ invalid: 'A chat turn is a JSON object.' }) }).passthrough());

module.exports = { TURN_SHAPE, DirectTurnBody, NotebookTurnBody, NotebookSelection, WebpageTurnBody };
