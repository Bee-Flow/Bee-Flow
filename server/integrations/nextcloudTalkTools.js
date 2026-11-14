// @typecheck
/**
 * Nextcloud Talk Tools — chat rooms, messages, reactions.
 *
 * APIs:
 *   v4: /ocs/v2.php/apps/spreed/api/v4/   — rooms (conversations)
 *   v1: /ocs/v2.php/apps/spreed/api/v1/   — chat, reactions, read state
 *
 * Auth handled by ./nextcloudClient (Bearer for OAuth users, app-password
 * Basic otherwise — same dual-mode pattern as the file/calendar/contacts
 * tools).
 */

const ncClient = require('./nextcloudClient');
const { mapRoom, mapParticipant } = require('./nextcloudTalkMappers');
const {
    normalizeFolder, folderPrefix, RECORDING_SUBFOLDER,
} = require('../core/meetingNotes/talkRecordingPaths');
const { readJsonSafe, v4, v1, COMMON_HEADERS } = require('./nextcloudTalkHttp');
const { readNextcloudCapabilities } = require('./nextcloudCapabilities.mts');
const {
    listMessages, searchMessages, sendMessage, deleteMessage, reactToMessage,
    createPoll, getPoll, votePoll, closePoll,
} = require('./nextcloudTalkChat');

const NEXTCLOUD_TALK_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_list_rooms',
            description: 'List the user\'s Nextcloud Talk conversations (rooms). Returns token, type, name, last message preview, unread count.',
            parameters: {
                type: 'object',
                properties: {
                    includeStatus: { type: 'boolean', description: 'Include presence info (default false).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_get_room',
            description: 'Fetch detailed information about a single Talk room.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string', description: 'Room token (from list_rooms).' }
                },
                required: ['token']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_create_room',
            description: 'Create a new Talk room. The user has approved this. roomType: 1 = one-to-one, 2 = group, 3 = public, 4 = changelog.',
            parameters: {
                type: 'object',
                properties: {
                    roomType: { type: 'integer', description: '1=one-to-one, 2=group, 3=public, 4=changelog (default 2).' },
                    invite: { type: 'string', description: 'For roomType=1: target uid. For roomType=2: group id (optional).' },
                    roomName: { type: 'string', description: 'Display name (required for group/public rooms).' },
                    objectType: { type: 'string', description: 'Optional: link the room to an object type (e.g. "file", "deck-board").' },
                    objectId: { type: 'string', description: 'Optional: id of the linked object.' }
                },
                required: ['roomType']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_list_participants',
            description: 'List the participants of a Talk room (display names, actor ids, participant type, in-call flags). Use to attribute speakers or check who is a moderator.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string', description: 'Room token.' }
                },
                required: ['token']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_start_recording',
            description: 'Start recording the active call in a Talk room. Moderator/owner only; requires the recording backend. status: 2 = audio-only, 1 = video.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string', description: 'Room token.' },
                    status: { type: 'integer', description: '2 = audio-only (default), 1 = video.' }
                },
                required: ['token']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_stop_recording',
            description: 'Stop the active call recording in a Talk room. Moderator/owner only.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string', description: 'Room token.' }
                },
                required: ['token']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_list_messages',
            description: 'Fetch the most recent messages from a Talk room. Returns id, actor, message text, mentions, reactions, parent (for replies), timestamp. Reaction system messages are omitted (reactions are on the target message).',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string', description: 'Room token.' },
                    limit: { type: 'integer', description: 'Number of messages (default 50, max 200).' },
                    lookIntoFuture: { type: 'integer', description: '0 = past messages (default), 1 = wait for new ones (long-poll, not recommended for tools).' }
                },
                required: ['token']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_search_messages',
            description: 'Search Talk messages across all rooms by case-insensitive substring.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    limit: { type: 'integer', description: 'Max results (default 25, max 100).' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_send_message',
            description: 'Post a message to a Talk room. The user has approved sending this message — go ahead. Use replyTo to reply to a specific message; use silent=true to suppress notifications.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string', description: 'Room token.' },
                    message: { type: 'string', description: 'Message text. Mentions use @"username" syntax.' },
                    replyTo: { type: 'integer', description: 'Optional message id to reply to.' },
                    silent: { type: 'boolean', description: 'Suppress notifications for this message (default false).' }
                },
                required: ['token', 'message']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_delete_message',
            description: 'Delete (soft-delete) a Talk message you sent. Always confirm with the user before calling.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string' },
                    messageId: { type: 'integer' }
                },
                required: ['token', 'messageId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_add_reaction',
            description: 'Add an emoji reaction to a message.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string' },
                    messageId: { type: 'integer' },
                    reaction: { type: 'string', description: 'Single emoji (e.g. "👍", "❤️", "🎉").' }
                },
                required: ['token', 'messageId', 'reaction']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_remove_reaction',
            description: 'Remove your own emoji reaction from a message.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string' },
                    messageId: { type: 'integer' },
                    reaction: { type: 'string' }
                },
                required: ['token', 'messageId', 'reaction']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_mark_read',
            description: 'Mark a Talk room as read up to the given message id.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string' },
                    lastReadMessage: { type: 'integer', description: 'Message id; the room will be marked read up to and including this.' }
                },
                required: ['token']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_create_poll',
            description: 'Create a poll in a Talk conversation. Use this to collect a decision from a group instead of parsing free-text replies.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string', description: 'Conversation token (from nextcloud_talk_list_rooms).' },
                    question: { type: 'string', description: 'The poll question.' },
                    options: { type: 'array', items: { type: 'string' }, description: 'Answer options, in order. Referenced later by 0-based index.' },
                    resultMode: { type: 'integer', description: '0 = results public as votes come in (default), 1 = hidden until the poll closes.' },
                    maxVotes: { type: 'integer', description: 'Max options one person may pick. 0 = unlimited (default), 1 = single choice.' }
                },
                required: ['token', 'question', 'options']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_get_poll',
            description: 'Read a poll\'s question, options and current results.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string', description: 'Conversation token.' },
                    pollId: { type: 'integer', description: 'Poll id (returned by create_poll, or found in a message\'s parameters).' }
                },
                required: ['token', 'pollId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_vote_poll',
            description: 'Cast a vote on a Talk poll, as the connected user.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string', description: 'Conversation token.' },
                    pollId: { type: 'integer', description: 'Poll id.' },
                    optionIds: { type: 'array', items: { type: 'integer' }, description: '0-based indexes of the chosen options.' }
                },
                required: ['token', 'pollId', 'optionIds']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_close_poll',
            description: 'Close a poll so no further votes are accepted and the final result is published.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string', description: 'Conversation token.' },
                    pollId: { type: 'integer', description: 'Poll id.' }
                },
                required: ['token', 'pollId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_talk_share_file',
            description: 'Share a file from Nextcloud Files into a Talk conversation, so it appears as an attachment rather than a link.',
            parameters: {
                type: 'object',
                properties: {
                    token: { type: 'string', description: 'Conversation token.' },
                    path: { type: 'string', description: 'Path of the file in the user\'s Files, e.g. "/Reports/Q3.pdf".' }
                },
                required: ['token', 'path']
            }
        }
    },
];

/**
 * Classify a recording start/stop OCS response into a stable result shape.
 * Verified error semantics: 403 → not a moderator; 400 with OCS message
 * `config` → recording backend not enabled; `call` → no active call.
 */
async function classifyRecordingResponse(res, authError, okExtra = {}) {
    if (res.status === 401) return { error: 'unauthorized', message: authError };
    if (res.status === 403) return { error: 'not_moderator', message: 'Only a moderator/owner can control recording.' };
    if (res.status === 404) return { error: 'room_not_found' };
    if (res.status === 400) {
        const body = await readJsonSafe(res);
        const msg = body?.ocs?.meta?.message || '';
        if (msg === 'config') return { error: 'recording_backend_unavailable', message: 'The Nextcloud recording backend is not configured.' };
        if (msg === 'call') return { error: 'no_active_call', message: 'There is no active call to record.' };
        return { error: 'bad_request', message: msg || 'Recording request rejected.', detail: body };
    }
    if (!res.ok && res.status !== 200 && res.status !== 201) {
        const body = await readJsonSafe(res);
        return { error: `recording_failed_${res.status}`, detail: body };
    }
    return { success: true, ...okExtra };
}

// The capabilities read and its cache live in ./nextcloudCapabilities.mts: per
// user (the payload carries `config.attachments.folder`, a per-user
// preference), and a non-2xx answer is held only briefly, so the next scanner
// tick after an outage asks again.

const CAP_UNAVAILABLE = Object.freeze({
    recordingEnabled: false,
    apiAvailable: false,
    backendConfigured: false,
    features: [],
    attachmentFolder: null,
    recordingFolder: null,
});

/**
 * Talk recording capability + the user's recording folder, from
 * `/ocs/v2.php/cloud/capabilities`.
 *
 * `recording-v1` is in spreed's STATIC `Capabilities::FEATURES` array, so it is
 * advertised by every Talk >= 26 whether or not an admin ever configured a
 * recording backend — testing it alone answered "is this Talk recent enough",
 * never "can this instance record". The real gate is
 * `config.call.recording`, which upstream computes from
 * `Config::isRecordingEnabled()`: signaling must not be internal (an HPB is
 * required), the `call_recording` app value must be 'yes', and a recording
 * secret must be set. `recordingEnabled` now means both.
 *
 * `config.attachments.folder` is the user's own Talk attachment folder, and
 * Talk stores recordings in its `Recording` subfolder — so it gives us the
 * real recording root instead of a guessed default.
 *
 * @returns {Promise<{recordingEnabled: boolean, apiAvailable: boolean,
 *   backendConfigured: boolean, features: string[],
 *   attachmentFolder: string|null, recordingFolder: string|null}>}
 */
async function getTalkRecordingCapability(session, userId) {
    try {
        const read = await readNextcloudCapabilities(session, userId);
        if (!read.ok) return { ...CAP_UNAVAILABLE };
        /** @type {{ features?: unknown, config?: { call?: { recording?: unknown }, attachments?: { folder?: unknown } } }} */
        const spreed = read.capabilities?.spreed || {};
        const features = Array.isArray(spreed.features) ? spreed.features : [];
        const apiAvailable = features.includes('recording-v1');
        const backendConfigured = spreed?.config?.call?.recording === true;
        const attachmentFolder = typeof spreed?.config?.attachments?.folder === 'string'
            ? spreed.config.attachments.folder
            : null;
        return {
            recordingEnabled: apiAvailable && backendConfigured,
            apiAvailable,
            backendConfigured,
            features,
            attachmentFolder,
            recordingFolder: attachmentFolder
                ? normalizeFolder(`${folderPrefix(normalizeFolder(attachmentFolder))}${RECORDING_SUBFOLDER}`)
                : null,
        };
    } catch (_) {
        return { ...CAP_UNAVAILABLE };
    }
}


async function listRooms(args, { baseUrl, fetch: ncFetch, authError }) {
    // `noStatusUpdate=1` — Talk otherwise marks the user online in
    // Nextcloud for every listing. Bee Flow reads rooms on the user's
    // behalf (assistant queries, and the auto-record poller once a
    // minute); neither is the user showing up for work, so we never
    // claim presence for them.
    const params = new URLSearchParams({ format: 'json', noStatusUpdate: '1' });
    if (args.includeStatus) params.set('includeStatus', 'true');
    const url = `${v4(baseUrl)}/room?${params.toString()}`;
    const res = await ncFetch(url, { headers: COMMON_HEADERS });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: 'Talk app is not installed/enabled on this Nextcloud server.' };
    if (!res.ok) return { error: `Talk room list failed (${res.status})` };
    const data = await readJsonSafe(res);
    const rooms = Array.isArray(data?.ocs?.data) ? data.ocs.data.map(mapRoom) : [];
    return { count: rooms.length, rooms };
}

async function getRoom(args, { baseUrl, fetch: ncFetch, authError }) {
    if (!args.token) return { error: 'token is required' };
    const res = await ncFetch(`${v4(baseUrl)}/room/${encodeURIComponent(args.token)}?format=json`, { headers: COMMON_HEADERS });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Room not found: ${args.token}` };
    if (!res.ok) return { error: `Talk room fetch failed (${res.status})` };
    const data = await readJsonSafe(res);
    return data?.ocs?.data ? mapRoom(data.ocs.data) : data;
}

async function createRoom(args, { baseUrl, fetch: ncFetch, authError }) {
    if (!args.roomType) return { error: 'roomType is required (1=one-to-one, 2=group, 3=public, 4=changelog)' };
    const body = {
        roomType: args.roomType,
        invite: args.invite || '',
        roomName: args.roomName || '',
        source: '',
        objectType: args.objectType || '',
        objectId: args.objectId || '',
    };
    const res = await ncFetch(`${v4(baseUrl)}/room?format=json`, {
        method: 'POST',
        headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (res.status === 401) return { error: authError };
    if (!res.ok) {
        const err = await readJsonSafe(res);
        return { error: `Room create failed (${res.status})`, detail: err };
    }
    const data = await readJsonSafe(res);
    return data?.ocs?.data ? { success: true, room: mapRoom(data.ocs.data) } : { success: true, raw: data };
}

async function listParticipants(args, { baseUrl, fetch: ncFetch, authError }) {
    if (!args.token) return { error: 'token is required' };
    const res = await ncFetch(`${v4(baseUrl)}/room/${encodeURIComponent(args.token)}/participants?format=json`, { headers: COMMON_HEADERS });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Room not found: ${args.token}` };
    if (!res.ok) return { error: `Talk participants fetch failed (${res.status})` };
    const data = await readJsonSafe(res);
    const participants = Array.isArray(data?.ocs?.data) ? data.ocs.data.map(mapParticipant) : [];
    return { token: args.token, count: participants.length, participants };
}

async function startRecording(args, { baseUrl, fetch: ncFetch, authError }) {
    if (!args.token) return { error: 'token is required' };
    // status: 2 = audio-only, 1 = video (Nextcloud's numbering — audio is
    // the higher value, intentionally not "fixed").
    const status = args.status === 1 ? 1 : 2;
    const res = await ncFetch(`${v1(baseUrl)}/recording/${encodeURIComponent(args.token)}?format=json`, {
        method: 'POST',
        headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
    });
    return classifyRecordingResponse(res, authError, { started: true, status });
}

async function stopRecording(args, { baseUrl, fetch: ncFetch, authError }) {
    if (!args.token) return { error: 'token is required' };
    const res = await ncFetch(`${v1(baseUrl)}/recording/${encodeURIComponent(args.token)}?format=json`, {
        method: 'DELETE',
        headers: COMMON_HEADERS,
    });
    return classifyRecordingResponse(res, authError, { stopped: true });
}

async function shareFile(args, { baseUrl, fetch: ncFetch, authError }) {
    if (!args.token) return { error: 'token is required' };
    if (!args.path) return { error: 'path is required' };
    // Talk file shares go through the normal sharing API with
    // shareType 10 (room) and the conversation token as the target.
    const params = new URLSearchParams({
        path: args.path,
        shareType: '10',
        shareWith: args.token,
    });
    const res = await ncFetch(`${baseUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`, {
        method: 'POST',
        headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
    });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `File not found: ${args.path}` };
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { error: `Sharing "${args.path}" to the conversation failed (${res.status}): ${text.slice(0, 160)}` };
    }
    const data = await res.json().catch(() => null);
    return { success: true, token: args.token, path: args.path, shareId: data?.ocs?.data?.id ?? null };
}

async function markRead(args, { baseUrl, fetch: ncFetch, authError }) {
    if (!args.token) return { error: 'token is required' };
    const body = args.lastReadMessage ? { lastReadMessage: args.lastReadMessage } : {};
    const res = await ncFetch(`${v1(baseUrl)}/chat/${encodeURIComponent(args.token)}/read?format=json`, {
        method: 'POST',
        headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (res.status === 401) return { error: authError };
    if (!res.ok) return { error: `Mark read failed (${res.status})` };
    return { success: true };
}

const HANDLERS = {
    nextcloud_talk_list_rooms: listRooms,
    nextcloud_talk_get_room: getRoom,
    nextcloud_talk_create_room: createRoom,
    nextcloud_talk_list_participants: listParticipants,
    nextcloud_talk_start_recording: startRecording,
    nextcloud_talk_stop_recording: stopRecording,
    nextcloud_talk_list_messages: listMessages,
    nextcloud_talk_search_messages: searchMessages,
    nextcloud_talk_send_message: sendMessage,
    nextcloud_talk_delete_message: deleteMessage,
    nextcloud_talk_add_reaction: (args, ctx) => reactToMessage('nextcloud_talk_add_reaction', args, ctx),
    nextcloud_talk_remove_reaction: (args, ctx) => reactToMessage('nextcloud_talk_remove_reaction', args, ctx),
    nextcloud_talk_create_poll: createPoll,
    nextcloud_talk_get_poll: getPoll,
    nextcloud_talk_vote_poll: votePoll,
    nextcloud_talk_close_poll: closePoll,
    nextcloud_talk_share_file: shareFile,
    nextcloud_talk_mark_read: markRead,
};

async function executeNextcloudTalkTool(toolName, args, userId, session) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const handler = Object.hasOwn(HANDLERS, toolName) ? HANDLERS[toolName] : null;
    if (!handler) return { error: `Unknown Nextcloud Talk tool: ${toolName}` };
    return handler(args, ctx);
}

function isNextcloudTalkTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_talk_');
}

module.exports = {
    NEXTCLOUD_TALK_TOOLS,
    executeNextcloudTalkTool,
    isNextcloudTalkTool,
    getTalkRecordingCapability,
};
