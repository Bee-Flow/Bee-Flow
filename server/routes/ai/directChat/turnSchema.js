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

const { z, worded, orEmpty, flag } = require('../../../core/http/schemaParts');

const text = (name, max) => worded(`${name} is text.`).max(max, `${name} is at most ${max} characters.`);
const list = (name) => z.array(z.unknown(), { invalid_type_error: `${name} is a list.` });
const bag = (name) => z.record(z.unknown(), { invalid_type_error: `${name} is an object.` });
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
    systemPrompt: text('systemPrompt', 200_000).nullish(),
    activeSkillIds: list('activeSkillIds').nullish(),
    activatedSessionSkillIds: list('activatedSessionSkillIds').nullish(),
    knowledgeBaseIds: list('knowledgeBaseIds').nullish(),
}, { invalid_type_error: 'A chat turn is a JSON object.' }).passthrough());

/** A turn about a notebook (routes/ai/notebookChat.js). */
const NotebookTurnBody = orEmpty(z.object({
    ...TURN_SHAPE,
    notebookId: text('notebookId', 200).nullish(),
    documentContent: text('documentContent', 5_000_000).nullish(),
    notebookSelection: text('notebookSelection', 1_000_000).nullish(),
}, { invalid_type_error: 'A chat turn is a JSON object.' }).passthrough());

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
    webpageSelection: z.unknown(),
    planExecution: z.unknown(),
    chatMode: z.enum(['ask', 'auto', 'plan'], { errorMap: () => ({ message: 'chatMode is ask, auto or plan.' }) }).nullish(),
}, { invalid_type_error: 'A chat turn is a JSON object.' }).passthrough());

module.exports = { TURN_SHAPE, DirectTurnBody, NotebookTurnBody, WebpageTurnBody };
