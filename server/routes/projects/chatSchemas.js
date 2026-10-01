// @typecheck
'use strict';
/**
 * What the team chat routes accept (routes/projects/chats.js).
 *
 * Every body and query is closed: a misspelled key is a 400 naming it, not a
 * 200 that ignored it — `askAI: true` must not quietly post without asking.
 * Every refusal is a sentence (core/http/schemaParts.js).
 */

const { z, worded, bodyOf, queryOf, choice, flag, wholeNumber } = require('../../core/http/schemaParts');

const TITLE_MAX = 200;
const CONTENT_MAX = 20000;
const CLIENT_MSG_ID_MAX = 64;
const ID_MAX = 200;
const MAX_MENTIONS = 50;
const MAX_REFS = 10;
const MAX_PAGE = 200;

const AI_MODE_TEXT = 'aiMode is off, mention, auto or always.';
const aiMode = choice(['off', 'mention', 'auto', 'always'], AI_MODE_TEXT);

const TITLE_TEXT = `title is a name of at most ${TITLE_MAX} characters.`;
// On create an empty title means "name it for me"; on a rename it means
// nothing, so a rename must say something.
const optionalTitle = worded(TITLE_TEXT).trim().max(TITLE_MAX, TITLE_TEXT);
const RENAME_TEXT = `title is a name of 1 to ${TITLE_MAX} characters.`;
const renameTitle = worded(RENAME_TEXT).trim().min(1, RENAME_TEXT).max(TITLE_MAX, RENAME_TEXT);

const AGENT_TEXT = 'agentId is the id of an agent you can use, or null for none.';
const agentId = worded(AGENT_TEXT).trim().min(1, AGENT_TEXT).max(ID_MAX, AGENT_TEXT).nullable();

const CONTENT_TEXT = `content is the message text, 1 to ${CONTENT_MAX} characters.`;
const content = worded(CONTENT_TEXT)
    .refine((v) => v.trim().length > 0, CONTENT_TEXT)
    .refine((v) => v.length <= CONTENT_MAX, CONTENT_TEXT);

const FIRST_MESSAGE_TEXT = `message is the first message of the chat, at most ${CONTENT_MAX} characters.`;
const firstMessage = worded(FIRST_MESSAGE_TEXT).max(CONTENT_MAX, FIRST_MESSAGE_TEXT);

const UpdateChatBody = bodyOf({
    title: renameTitle.optional(),
    aiMode: aiMode.optional(),
    agentId: agentId.optional(),
    archived: flag('archived is true or false.').optional(),
}, 'Changing a team chat');

const ListChatsQuery = queryOf({
    archived: choice(['0', '1'], 'archived is 1 for archived chats, 0 for the others.').optional(),
}, 'The chat list');

const MessagesQuery = queryOf({
    after: wholeNumber('after is the seq of the newest message you already have.', { min: 0 }).optional(),
    before: wholeNumber('before is the seq of the oldest message you already have.', { min: 1 }).optional(),
    limit: wholeNumber(`limit is a whole number from 1 to ${MAX_PAGE}.`, { min: 1, max: MAX_PAGE }).optional(),
}, 'The message list');

const CLIENT_MSG_ID_TEXT = `clientMsgId is your own id for this message, 1 to ${CLIENT_MSG_ID_MAX} characters.`;
const REPLY_TEXT = 'replyTo is the id of a message in this chat.';
const MENTIONS_TEXT = `mentions is a list of at most ${MAX_MENTIONS} member ids.`;

const THREAD_TEXT = 'threadId is the id of a message in this chat that starts the thread.';
const REFS_TEXT = `refs is a list of at most ${MAX_REFS} objects like {"kind":"document","id":"..."} (kind is document, notebook, meeting or task).`;
const ref = z.object({
    kind: choice(['document', 'notebook', 'meeting', 'task'], REFS_TEXT),
    id: worded(REFS_TEXT).trim().min(1, REFS_TEXT).max(ID_MAX, REFS_TEXT),
}, { invalid_type_error: REFS_TEXT }).strict();

const CreateChatBody = bodyOf({
    title: optionalTitle.optional(),
    aiMode: aiMode.optional(),
    agentId: agentId.optional(),
    message: firstMessage.optional(),
    refs: z.array(ref, { invalid_type_error: REFS_TEXT }).max(MAX_REFS, REFS_TEXT).optional(),
}, 'Starting a team chat');

const TIER_TEXT = 'modelTier is the name of a model tier, such as auto, fast or thinking.';

const PostMessageBody = bodyOf({
    content,
    clientMsgId: worded(CLIENT_MSG_ID_TEXT).trim().min(1, CLIENT_MSG_ID_TEXT).max(CLIENT_MSG_ID_MAX, CLIENT_MSG_ID_TEXT).optional(),
    replyTo: worded(REPLY_TEXT).trim().min(1, REPLY_TEXT).max(ID_MAX, REPLY_TEXT).nullish(),
    mentions: z.array(worded(MENTIONS_TEXT).trim().min(1, MENTIONS_TEXT).max(ID_MAX, MENTIONS_TEXT), {
        invalid_type_error: MENTIONS_TEXT,
    }).max(MAX_MENTIONS, MENTIONS_TEXT).optional(),
    threadId: worded(THREAD_TEXT).trim().min(1, THREAD_TEXT).max(ID_MAX, THREAD_TEXT).nullish(),
    refs: z.array(ref, { invalid_type_error: REFS_TEXT }).max(MAX_REFS, REFS_TEXT).optional(),
    modelTier: worded(TIER_TEXT).trim().min(1, TIER_TEXT).max(100, TIER_TEXT).nullish(),
    askAi: flag('askAi is true to ask the AI assistant to answer, or false.').optional(),
}, 'Posting a message');

const EditMessageBody = bodyOf({ content }, 'Editing a message');

const ReadBody = bodyOf({
    seq: wholeNumber('seq is the seq of the last message you have read.', { min: 0 }),
}, 'Marking a chat as read');

// Only "not helpful" changes anything (it feeds the back-off), but a clear
// "helpful" is a fair thing to say too; either way the key is required.
const FeedbackBody = bodyOf({
    helpful: flag('helpful is false for "not helpful", or true.'),
}, 'Feedback on an answer');

module.exports = {
    TITLE_MAX,
    CONTENT_MAX,
    CLIENT_MSG_ID_MAX,
    MAX_MENTIONS,
    MAX_REFS,
    CreateChatBody,
    UpdateChatBody,
    ListChatsQuery,
    MessagesQuery,
    PostMessageBody,
    EditMessageBody,
    ReadBody,
    FeedbackBody,
};
