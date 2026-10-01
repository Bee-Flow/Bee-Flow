/**
 * The one rule for Microsoft Graph ids and well-known folder names that end up
 * interpolated into a Graph path (`/me/messages/${id}/reply`, ...).
 *
 * Graph ids are long, opaque and base64url-ish; well-known folder names are
 * plain words. Both are covered without letting a path separator through: a
 * model-supplied `x/../../users/someone@corp.com/messages/<id>` would
 * otherwise be normalised by fetch into a different Graph resource, and in an
 * unattended autoSend run there is no approval step to catch it.
 *
 * Shared by integrations/outlookTools.js (the tool path) and
 * routes/integrations/outlook.js (the approval-card route).
 */

'use strict';

const GRAPH_ID_RE = /^[A-Za-z0-9_=-]{1,512}$/;
const MESSAGE_ID_TEXT = 'That is not an Outlook message id.';
const FOLDER_TEXT = 'folder is a mail folder name (inbox, sentitems, drafts, …) or a folder id.';

/** Throws `message` unless `value` is a string matching GRAPH_ID_RE. */
function assertGraphId(value, message) {
    if (typeof value !== 'string' || !GRAPH_ID_RE.test(value)) {
        throw new Error(message);
    }
    return value;
}

module.exports = { GRAPH_ID_RE, MESSAGE_ID_TEXT, FOLDER_TEXT, assertGraphId };
