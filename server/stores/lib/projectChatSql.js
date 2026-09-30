// @typecheck
/**
 * SQL the chat store shares between its delete paths.
 */

'use strict';

/**
 * Back to "no title yet" for the chats whose title was taken from one of
 * these messages ($1, text[]). Stored empty, because this store holds no key
 * to seal the default with; the route serves an empty title as "New chat".
 */
const RESET_DERIVED_TITLES = `
    UPDATE project_chats SET title = '', title_from_message_id = NULL, updated_at = NOW()
     WHERE title_from_message_id = ANY($1::text[])`;

/**
 * The trace of an answer holds the message it answered as written, so it goes
 * with that message ($1, text[]: deleted or erased ids), and with the answer
 * itself when that is deleted.
 */
const DROP_TRACES = `
    UPDATE project_chat_messages SET ai_trace = NULL
     WHERE ai_trace IS NOT NULL AND (id = ANY($1::text[]) OR reply_to = ANY($1::text[]))`;

module.exports = { RESET_DERIVED_TITLES, DROP_TRACES };
