// @typecheck
'use strict';
/**
 * What the comment routes accept (routes/projects/comments.js).
 *
 * Every body and query is closed: a misspelled key is a 400 naming it, not a
 * 200 that ignored it — `askAI: true` must not quietly post without asking.
 * Every refusal is a sentence (core/http/schemaParts.js).
 *
 * The anchor is the client's description of the passage a thread is about:
 * the selected words (`quote`), a little text on either side to tell repeated
 * words apart, the index of the block they start in, and — while the item is
 * co-edited — Y relative positions that follow the passage through other
 * people's edits. A designed document adds the section it sits in. The server
 * never interprets it beyond these bounds; it is sealed as a whole.
 */

const { z, worded, bodyOf, queryOf, closedObject, choice, flag, wholeNumber } = require('../../core/http/schemaParts');

const ID_MAX = 200;
const CONTENT_MAX = 10000;
const QUOTE_MAX = 2000;
const CONTEXT_MAX = 200;
const REL_MAX = 2048;
const CLIENT_ID_MAX = 64;
const MAX_MENTIONS = 50;
const MAX_BLOCK_INDEX = 1_000_000;

const TARGET_TYPES = ['notebook', 'document'];
const AI_MODES = ['off', 'mention', 'auto'];

const targetType = choice(TARGET_TYPES, 'targetType is notebook or document.');
const TARGET_ID_TEXT = `targetId is the id of the notebook or document, 1 to ${ID_MAX} characters.`;
const targetId = worded(TARGET_ID_TEXT).trim().min(1, TARGET_ID_TEXT).max(ID_MAX, TARGET_ID_TEXT);
const aiMode = choice(AI_MODES, 'aiMode is off, mention or auto.');

const QUOTE_TEXT = `anchor.quote is the passage the comment is about, 1 to ${QUOTE_MAX} characters.`;
const contextText = (side) => `anchor.${side} is the text just ${side === 'prefix' ? 'before' : 'after'} the passage, at most ${CONTEXT_MAX} characters.`;
const REL_TEXT = `anchor.relStart and anchor.relEnd are encoded positions of at most ${REL_MAX} characters.`;
const SECTION_TEXT = `anchor.sectionId is the id of a document section, 1 to ${ID_MAX} characters.`;
const relPosition = worded(REL_TEXT).max(REL_MAX, REL_TEXT).regex(/^[A-Za-z0-9+/=_-]+$/, REL_TEXT);

const Anchor = closedObject({
    quote: worded(QUOTE_TEXT).refine((v) => v.trim().length > 0, QUOTE_TEXT).refine((v) => v.length <= QUOTE_MAX, QUOTE_TEXT),
    prefix: worded(contextText('prefix')).max(CONTEXT_MAX, contextText('prefix')).optional(),
    suffix: worded(contextText('suffix')).max(CONTEXT_MAX, contextText('suffix')).optional(),
    blockIndex: wholeNumber(`anchor.blockIndex is a whole number from 0 to ${MAX_BLOCK_INDEX}.`, { min: 0, max: MAX_BLOCK_INDEX }).optional(),
    relStart: relPosition.optional(),
    relEnd: relPosition.optional(),
    sectionId: worded(SECTION_TEXT).trim().min(1, SECTION_TEXT).max(ID_MAX, SECTION_TEXT).optional(),
}, 'The anchor');

const CONTENT_TEXT = `content is the comment text, 1 to ${CONTENT_MAX} characters.`;
const content = worded(CONTENT_TEXT)
    .refine((v) => v.trim().length > 0, CONTENT_TEXT)
    .refine((v) => v.length <= CONTENT_MAX, CONTENT_TEXT);

const MENTIONS_TEXT = `mentions is a list of at most ${MAX_MENTIONS} member ids.`;
const mentions = z.array(worded(MENTIONS_TEXT).trim().min(1, MENTIONS_TEXT).max(ID_MAX, MENTIONS_TEXT), {
    invalid_type_error: MENTIONS_TEXT,
}).max(MAX_MENTIONS, MENTIONS_TEXT);

const askAi = flag('askAi is true to ask the AI assistant to answer in the thread, or false.');
const clientId = (name) => {
    const text = `${name} is your own id for this ${name === 'clientThreadId' ? 'thread' : 'comment'}, 1 to ${CLIENT_ID_MAX} characters.`;
    return worded(text).trim().min(1, text).max(CLIENT_ID_MAX, text);
};
const REPLY_TEXT = 'replyTo is the id of a comment in this thread.';

const ListThreadsQuery = queryOf({
    targetType,
    targetId,
    status: choice(['open', 'resolved', 'all'], 'status is open, resolved or all.').optional(),
}, 'The comment list');

/** One page of a thread read whole: the comments before `before` (the latest when absent). */
const ThreadQuery = queryOf({
    before: wholeNumber('before is the seq of the oldest comment you hold of this thread.', { min: 1 }).optional(),
}, 'The thread');

const CreateThreadBody = bodyOf({
    targetType,
    targetId,
    anchor: Anchor.nullable().optional(),
    content,
    mentions: mentions.optional(),
    askAi: askAi.optional(),
    aiMode: aiMode.optional(),
    clientThreadId: clientId('clientThreadId').optional(),
}, 'Starting a comment thread');

const ReplyBody = bodyOf({
    content,
    mentions: mentions.optional(),
    askAi: askAi.optional(),
    replyTo: worded(REPLY_TEXT).trim().min(1, REPLY_TEXT).max(ID_MAX, REPLY_TEXT).nullish(),
    clientMsgId: clientId('clientMsgId').optional(),
}, 'Replying in a thread');

const EditCommentBody = bodyOf({
    content,
    mentions: mentions.optional(),
}, 'Editing a comment');

const UpdateThreadBody = bodyOf({ aiMode }, 'Changing a thread');

const FeedbackBody = bodyOf({
    helpful: flag('helpful is false for "not helpful", or true to take that back.'),
}, 'Feedback on an answer');

module.exports = {
    TARGET_TYPES,
    AI_MODES,
    CONTENT_MAX,
    QUOTE_MAX,
    MAX_MENTIONS,
    Anchor,
    ListThreadsQuery,
    ThreadQuery,
    CreateThreadBody,
    ReplyBody,
    EditCommentBody,
    UpdateThreadBody,
    FeedbackBody,
};
