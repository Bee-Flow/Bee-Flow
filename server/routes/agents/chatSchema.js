// @typecheck strict
'use strict';
/**
 * What a caller may send to the agent chat routes (./chat.js): the bodies
 * their `validate` middleware checks. Split out of chat.js; unchanged.
 */

const { z, typeError } = require('../../utils/zod');
const { worded } = require('../../core/http/schemaParts');

// -- What a caller may send ------------------------------------------
//
// The turn body is the widest on the server, and it was read key by key with
// no vocabulary anywhere. Three of those reads decided something:
//
//   - `test: 'true'` (the string) is not `=== true`, which is what
//     `wantsTestChat` asks. The turn therefore ran against the PUBLISHED
//     agent instead of the concept, was WRITTEN TO THE REAL HISTORY and
//     counted in the usage tab -- the three things a test chat exists to
//     avoid, all under a 200. It is a boolean now: a truthy word is refused
//     by name, and still never becomes a test chat.
//   - a misspelled `modelTier` fell back to the agent's own model, so an
//     override the composer offered did nothing and said nothing.
//   - a misspelled key anywhere in the body -- `converstionId`,
//     `memoryWrite` -- was dropped, and the turn answered as though the
//     thing it asked for had happened.
//
// THREE KEYS ARE ACCEPTED AND NOT READ, and they are named here on purpose:
// `agentId` and `stream` (both clients put them in the body -- the mobile
// client's AgentTurnPayload types them) and `isHidden` (the SPA sends it).
// `.strict()` without them would have 400'd every turn from Agent Hub and
// from the Android app.

/**
 * A body that also accepts no body at all: Express 5 leaves `req.body` undefined then.
 * @template {import('zod').ZodRawShape} S
 * @param {S} shape
 */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

/**
 * @param {string} name
 */
const text = (name) => worded(`${name} must be text.`).optional();
/**
 * @param {string} name
 */
const id = (name) => worded(`${name} must be an id.`).trim().min(1, `${name} must be an id.`).nullish();
/**
 * @param {string} name
 */
const flag = (name) => z.boolean({ error: typeError({ invalid: `${name} is true or false.` }) }).optional();

const MESSAGE_TEXT = 'Message is required';

/**
 * One turn of a client-supplied `history`. Everything but `content` is the
 * runtime's to read, so the rest stays open (`passthrough`). `content` is
 * narrowed to what a provider accepts -- text, a list of content blocks, or
 * nothing -- because an object here is replayed verbatim on every later turn
 * and comes back as the provider's 400 "messages[N].content ... got an object".
 */
const HISTORY_TURN_TEXT = 'Each history turn is an object whose content is text, a list of content blocks or empty.';
const HistoryTurn = z.object({
    content: z.union([z.string(), z.array(z.unknown()), z.null()], { error: () => HISTORY_TURN_TEXT }).optional(),
}, { error: typeError({ invalid: HISTORY_TURN_TEXT }) }).passthrough();

const TurnBody = bodyOf({
    message: worded(MESSAGE_TEXT).min(1, MESSAGE_TEXT),
    // Read by the runtime, not here: their shape belongs to the turn, and
    // `attachments` carries inline data URLs the uploader already bounds.
    // Only a history turn's `content` is checked (see HistoryTurn).
    history: z.array(HistoryTurn, { error: typeError({ invalid: 'history is a list of turns.' }) }).optional(),
    attachments: z.array(z.unknown(), { error: typeError({ invalid: 'attachments is a list.' }) }).optional(),
    messageId: id('messageId'),
    parentId: id('parentId'),
    conversationId: id('conversationId'),
    projectId: id('projectId'),
    ephemeral: flag('ephemeral'),
    modelTier: worded('modelTier is the name of a model tier.').trim().min(1, 'modelTier is the name of a model tier.').optional(),
    activeSkillIds: z.array(worded('activeSkillIds is a list of skill ids.'), { error: typeError({ invalid: 'activeSkillIds is a list of skill ids.' }) }).optional(),
    reasoningEffort: worded('reasoningEffort is the name of a thinking effort.').trim().min(1, 'reasoningEffort is the name of a thinking effort.').optional(),
    timezone: text('timezone'),
    memoryWriteEnabled: flag('memoryWriteEnabled'),
    memoryReadEnabled: flag('memoryReadEnabled'),
    webSearchEnabled: flag('webSearchEnabled'),
    // The notebook and the side panel: what the person has open beside the
    // chat. `notebookspaceContent: ''` means "open but blank" and is NOT the
    // same as absent, so there is no `.min(1)` here.
    notebookspaceAvailable: flag('notebookspaceAvailable'),
    notebookspaceContent: text('notebookspaceContent'),
    notebookspaceSelection: text('notebookspaceSelection'),
    sidePanelWebpage: z.record(z.string(), z.unknown()).nullish(),
    // The Studio document open next to the chat; shape-checked in core/documents/aiDocumentScope.js.
    sidePanelDocument: z.unknown().optional(),
    // Test chat (A4) + "Test as, group X" (A1c).
    test: z.boolean({ error: typeError({ invalid: 'test is true or false.' }) }).optional(),
    testSessionId: text('testSessionId'),
    // LEFT OPEN one level down, on purpose: `normaliseToolDecisions` keeps
    // only an entry whose key is hex and whose decision is approve/decline,
    // and drops the rest. Dropping is the SAFE direction here -- a malformed
    // entry is an approval NOT granted -- and refusing the whole turn over
    // one bad card would cost the person the message they were writing.
    toolDecisions: z.array(z.record(z.string(), z.unknown()), { error: typeError({ invalid: 'toolDecisions is a list of decisions.' }) }).optional(),
    // LEFT OPEN, like `toolDecisions`: `gateTestAsRequest` refuses a group
    // that is not a usable id with its own codes (`test_as_invalid_group`,
    // `test_as_group_not_found`), which the composer reads. A shape check
    // here would answer `invalid_request` first and take those away.
    asGroup: z.unknown().optional(),
    // Sent by both clients, read by neither. Named so `.strict()` does not
    // refuse the requests they have always made.
    agentId: z.unknown().optional(),
    stream: z.unknown().optional(),
    isHidden: z.unknown().optional(),
    // Chat signals (core/privacy/chatSignals.js): the notice marker a chat
    // sends when it showed the chat-signals line for exactly this
    // configuration (`agent@<version>`, `agent_public@<version>` from the
    // embed), and the person's "don't count" switch. A turn without the
    // marker is not counted.
    chatSignalsNotice: worded('chatSignalsNotice must be text.').max(120, 'chatSignalsNotice is at most 120 characters.').optional(),
    chatSignalsOptOut: flag('chatSignalsOptOut'),
    // Incognito: implies `ephemeral`, nothing of the conversation is stored
    // (core/conversation/incognito.mts). The client sends `testSessionId`
    // and the whole `history` every turn.
    incognito: flag('incognito'),
});

/**
 * The legacy non-streaming turn. It has only ever read `message` -- a
 * `conversationId` sent here was dropped, and the reply that did not continue
 * the thread was the only sign. It says so now.
 */
const PlainTurnBody = bodyOf({ message: worded(MESSAGE_TEXT).min(1, MESSAGE_TEXT) });

const TITLE_TEXT = 'Content is required';
const TitleBody = bodyOf({ content: worded(TITLE_TEXT).min(1, TITLE_TEXT) });
const CODE_TEXT = 'Code is required';
const DescribeBody = bodyOf({ code: worded(CODE_TEXT).min(1, CODE_TEXT) });

module.exports = { TurnBody, PlainTurnBody, TitleBody, DescribeBody };
