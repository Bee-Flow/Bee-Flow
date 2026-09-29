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
const {
    normalizeFolder, folderPrefix, RECORDING_SUBFOLDER,
} = require('../core/meetingNotes/talkRecordingPaths');

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
            description: 'Fetch the most recent messages from a Talk room. Returns id, actor, message text, mentions, reactions, parent (for replies), timestamp.',
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

async function readJsonSafe(res) {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text); } catch { return text; }
}

function v4(baseUrl) { return `${baseUrl}/ocs/v2.php/apps/spreed/api/v4`; }
function v1(baseUrl) { return `${baseUrl}/ocs/v2.php/apps/spreed/api/v1`; }

const COMMON_HEADERS = {
    'OCS-APIRequest': 'true',
    'Accept': 'application/json',
};

function mapRoom(r) {
    return {
        token: r.token,
        type: r.type,
        name: r.displayName || r.name,
        description: r.description,
        unreadMessages: r.unreadMessages,
        unreadMention: r.unreadMention,
        lastActivity: r.lastActivity,
        lastMessage: r.lastMessage ? { id: r.lastMessage.id, actor: r.lastMessage.actorDisplayName, message: r.lastMessage.message, timestamp: r.lastMessage.timestamp } : null,
        participantType: r.participantType,   // 1=owner, 2=moderator (may start recording)
        canStartCall: r.canStartCall,
        readOnly: r.readOnly,
        // Call + recording state (used by auto-record). callRecording: 0 none,
        // 1 video, 2 audio, 3 starting-video, 4 starting-audio.
        hasCall: !!r.hasCall,
        callFlag: r.callFlag,
        callRecording: r.callRecording,
        callStartTime: r.callStartTime,
        // objectType 'event' (+ objectId '<startUnix>#<endUnix>') when the room
        // was created from a calendar event.
        objectType: r.objectType || '',
        objectId: r.objectId || '',
    };
}

function mapParticipant(p) {
    return {
        attendeeId: p.attendeeId,
        actorType: p.actorType,
        actorId: p.actorId,
        displayName: p.displayName || p.actorId,
        participantType: p.participantType,   // 1 owner, 2 moderator
        // inCall bitmask: 1 in-call, 2 provides audio, 4 provides video, 8 SIP.
        inCall: p.inCall,
        lastPing: p.lastPing,
    };
}

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

// Capability cache. Keyed by baseUrl + uid, NOT baseUrl alone: the payload also
// carries `config.attachments.folder`, which is a per-user preference.
const _capCache = new Map(); // `${baseUrl}|${uid}` → { ts, val }
const CAP_TTL_MS = 10 * 60 * 1000;

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
    let ctx;
    try { ctx = await ncClient.resolveAuth(session, userId); }
    catch (_) { return { ...CAP_UNAVAILABLE }; }
    const baseUrl = ctx.baseUrl;
    const cacheKey = `${baseUrl}|${ctx.uid || ''}`;
    const cached = _capCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < CAP_TTL_MS) return cached.val;
    try {
        const res = await ctx.fetch(`${baseUrl}/ocs/v2.php/cloud/capabilities?format=json`, { headers: COMMON_HEADERS });
        if (!res.ok) {
            const val = { ...CAP_UNAVAILABLE };
            _capCache.set(cacheKey, { ts: Date.now(), val });
            return val;
        }
        const data = await readJsonSafe(res);
        const spreed = data?.ocs?.data?.capabilities?.spreed || {};
        const features = Array.isArray(spreed.features) ? spreed.features : [];
        const apiAvailable = features.includes('recording-v1');
        const backendConfigured = spreed?.config?.call?.recording === true;
        const attachmentFolder = typeof spreed?.config?.attachments?.folder === 'string'
            ? spreed.config.attachments.folder
            : null;
        const val = {
            recordingEnabled: apiAvailable && backendConfigured,
            apiAvailable,
            backendConfigured,
            features,
            attachmentFolder,
            recordingFolder: attachmentFolder
                ? normalizeFolder(`${folderPrefix(normalizeFolder(attachmentFolder))}${RECORDING_SUBFOLDER}`)
                : null,
        };
        _capCache.set(cacheKey, { ts: Date.now(), val });
        return val;
    } catch (_) {
        return { ...CAP_UNAVAILABLE };
    }
}

function mapMessage(m) {
    return {
        id: m.id,
        actor: m.actorDisplayName || m.actorId,
        actorId: m.actorId,
        actorType: m.actorType,
        timestamp: m.timestamp,
        message: m.message,
        messageParameters: m.messageParameters,
        systemMessage: m.systemMessage || null,
        parent: m.parent ? mapMessage(m.parent) : null,
        reactions: m.reactions || {},
    };
}

async function executeNextcloudTalkTool(toolName, args, userId, session) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const { baseUrl, fetch: ncFetch, authError } = ctx;

    switch (toolName) {
        case 'nextcloud_talk_list_rooms': {
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

        case 'nextcloud_talk_get_room': {
            if (!args.token) return { error: 'token is required' };
            const res = await ncFetch(`${v4(baseUrl)}/room/${encodeURIComponent(args.token)}?format=json`, { headers: COMMON_HEADERS });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Room not found: ${args.token}` };
            if (!res.ok) return { error: `Talk room fetch failed (${res.status})` };
            const data = await readJsonSafe(res);
            return data?.ocs?.data ? mapRoom(data.ocs.data) : data;
        }

        case 'nextcloud_talk_create_room': {
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

        case 'nextcloud_talk_list_participants': {
            if (!args.token) return { error: 'token is required' };
            const res = await ncFetch(`${v4(baseUrl)}/room/${encodeURIComponent(args.token)}/participants?format=json`, { headers: COMMON_HEADERS });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Room not found: ${args.token}` };
            if (!res.ok) return { error: `Talk participants fetch failed (${res.status})` };
            const data = await readJsonSafe(res);
            const participants = Array.isArray(data?.ocs?.data) ? data.ocs.data.map(mapParticipant) : [];
            return { token: args.token, count: participants.length, participants };
        }

        case 'nextcloud_talk_start_recording': {
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

        case 'nextcloud_talk_stop_recording': {
            if (!args.token) return { error: 'token is required' };
            const res = await ncFetch(`${v1(baseUrl)}/recording/${encodeURIComponent(args.token)}?format=json`, {
                method: 'DELETE',
                headers: COMMON_HEADERS,
            });
            return classifyRecordingResponse(res, authError, { stopped: true });
        }

        case 'nextcloud_talk_list_messages': {
            if (!args.token) return { error: 'token is required' };
            const limit = Math.min(Math.max(args.limit || 50, 1), 200);
            const url = `${v1(baseUrl)}/chat/${encodeURIComponent(args.token)}?lookIntoFuture=${args.lookIntoFuture || 0}&limit=${limit}&format=json`;
            const res = await ncFetch(url, { headers: COMMON_HEADERS });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Room not found: ${args.token}` };
            if (res.status === 304) return { token: args.token, count: 0, messages: [] };
            if (!res.ok) return { error: `Talk message fetch failed (${res.status})` };
            const data = await readJsonSafe(res);
            const messages = Array.isArray(data?.ocs?.data) ? data.ocs.data.map(mapMessage) : [];
            return { token: args.token, count: messages.length, messages };
        }

        case 'nextcloud_talk_search_messages': {
            const q = String(args.query || '').trim();
            if (!q) return { error: 'query is required' };
            const limit = Math.min(Math.max(args.limit || 25, 1), 100);
            const url = `${baseUrl}/ocs/v2.php/search/providers/talk-message/search?term=${encodeURIComponent(q)}&limit=${limit}&format=json`;
            const res = await ncFetch(url, { headers: COMMON_HEADERS });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Talk search failed (${res.status})` };
            const data = await readJsonSafe(res);
            const entries = data?.ocs?.data?.entries || [];
            return {
                query: q,
                count: entries.length,
                messages: entries.slice(0, limit).map(e => ({
                    title: e.title,
                    subline: e.subline,
                    resourceUrl: e.resourceUrl,
                    icon: e.icon,
                    attributes: e.attributes,
                    // The conversation each hit belongs to, promoted to a
                    // first-class field. Talk's provider puts it in
                    // attributes.conversation; the resourceUrl (/call/<token>)
                    // is the fallback. Without it a hit cannot be placed in a
                    // room, which is why this tool used to be refused outright
                    // whenever a user had narrowed Talk to specific rooms.
                    token: e.attributes?.conversation
                        ?? (/\/call\/([A-Za-z0-9]+)/.exec(e.resourceUrl || '')?.[1] ?? null),
                })),
            };
        }

        case 'nextcloud_talk_send_message': {
            if (!args.token || !args.message) return { error: 'token and message are required' };
            const body = {
                message: args.message,
                replyTo: args.replyTo || 0,
                silent: !!args.silent,
            };
            const res = await ncFetch(`${v1(baseUrl)}/chat/${encodeURIComponent(args.token)}?format=json`, {
                method: 'POST',
                headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Room not found: ${args.token}` };
            if (res.status === 413) return { error: 'Message too long.' };
            if (!res.ok && res.status !== 201) {
                const err = await readJsonSafe(res);
                return { error: `Talk send failed (${res.status})`, detail: err };
            }
            const data = await readJsonSafe(res);
            return data?.ocs?.data ? { success: true, message: mapMessage(data.ocs.data) } : { success: true };
        }

        case 'nextcloud_talk_delete_message': {
            if (!args.token || !args.messageId) return { error: 'token and messageId are required' };
            const res = await ncFetch(`${v1(baseUrl)}/chat/${encodeURIComponent(args.token)}/${encodeURIComponent(args.messageId)}?format=json`, {
                method: 'DELETE',
                headers: COMMON_HEADERS,
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Message not found: ${args.messageId}` };
            if (res.status === 405) return { error: 'Message cannot be deleted (too old or not your own).' };
            if (!res.ok && res.status !== 200 && res.status !== 202) return { error: `Talk delete failed (${res.status})` };
            return { success: true, messageId: args.messageId };
        }

        case 'nextcloud_talk_add_reaction':
        case 'nextcloud_talk_remove_reaction': {
            if (!args.token || !args.messageId || !args.reaction) return { error: 'token, messageId, reaction required' };
            const method = toolName === 'nextcloud_talk_add_reaction' ? 'POST' : 'DELETE';
            const res = await ncFetch(`${v1(baseUrl)}/reaction/${encodeURIComponent(args.token)}/${encodeURIComponent(args.messageId)}?format=json`, {
                method,
                headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
                body: JSON.stringify({ reaction: args.reaction }),
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok && res.status !== 200 && res.status !== 201) {
                const err = await readJsonSafe(res);
                return { error: `Reaction ${method} failed (${res.status})`, detail: err };
            }
            return { success: true };
        }

        case 'nextcloud_talk_create_poll': {
            if (!args.token) return { error: 'token is required' };
            if (!args.question) return { error: 'question is required' };
            const options = Array.isArray(args.options) ? args.options.map(String).filter(Boolean) : [];
            if (options.length < 2) return { error: 'options must contain at least two choices' };
            const res = await ncFetch(`${v1(baseUrl)}/poll/${encodeURIComponent(args.token)}?format=json`, {
                method: 'POST',
                headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    question: args.question,
                    options,
                    resultMode: Number(args.resultMode || 0),
                    maxVotes: Number(args.maxVotes || 0),
                }),
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Create poll failed (${res.status})` };
            const data = await res.json().catch(() => null);
            const poll = data?.ocs?.data || {};
            return { success: true, pollId: poll.id ?? null, question: poll.question || args.question, options };
        }

        case 'nextcloud_talk_get_poll': {
            if (!args.token) return { error: 'token is required' };
            if (args.pollId === undefined) return { error: 'pollId is required' };
            const res = await ncFetch(
                `${v1(baseUrl)}/poll/${encodeURIComponent(args.token)}/${encodeURIComponent(args.pollId)}?format=json`,
                { headers: COMMON_HEADERS },
            );
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Poll ${args.pollId} not found in that conversation.` };
            if (!res.ok) return { error: `Get poll failed (${res.status})` };
            const data = await res.json().catch(() => null);
            const p = data?.ocs?.data || {};
            return {
                pollId: p.id ?? args.pollId,
                question: p.question || '',
                options: p.options || [],
                // `votes` is keyed "option-<index>"; `numVoters` is the headcount.
                votes: p.votes || {},
                numVoters: p.numVoters ?? null,
                // 0 = open, 1 = closed.
                status: p.status === 1 ? 'closed' : 'open',
                resultMode: p.resultMode ?? null,
            };
        }

        case 'nextcloud_talk_vote_poll': {
            if (!args.token) return { error: 'token is required' };
            if (args.pollId === undefined) return { error: 'pollId is required' };
            const optionIds = Array.isArray(args.optionIds) ? args.optionIds.map(Number).filter(n => Number.isFinite(n)) : [];
            if (!optionIds.length) return { error: 'optionIds must contain at least one 0-based option index' };
            const res = await ncFetch(
                `${v1(baseUrl)}/poll/${encodeURIComponent(args.token)}/${encodeURIComponent(args.pollId)}?format=json`,
                {
                    method: 'POST',
                    headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ optionIds }),
                },
            );
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Vote failed (${res.status})` };
            return { success: true, pollId: args.pollId, optionIds };
        }

        case 'nextcloud_talk_close_poll': {
            if (!args.token) return { error: 'token is required' };
            if (args.pollId === undefined) return { error: 'pollId is required' };
            const res = await ncFetch(
                `${v1(baseUrl)}/poll/${encodeURIComponent(args.token)}/${encodeURIComponent(args.pollId)}?format=json`,
                { method: 'DELETE', headers: COMMON_HEADERS },
            );
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Close poll failed (${res.status})` };
            return { success: true, pollId: args.pollId, status: 'closed' };
        }

        case 'nextcloud_talk_share_file': {
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

        case 'nextcloud_talk_mark_read': {
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

        default:
            return { error: `Unknown Nextcloud Talk tool: ${toolName}` };
    }
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
