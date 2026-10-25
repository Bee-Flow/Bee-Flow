// @typecheck noImplicitAny
/** Shapes and error text for the Talk tools (kept apart from the executor). */

const { nextcloudHttpError } = require('./nextcloudHttpError');

/**
 * Talk API objects as the OCS endpoints hand them over (only the fields read here).
 * @typedef {{ id?: number, actorId?: string, actorType?: string, actorDisplayName?: string, timestamp?: number,
 *   message?: string, messageParameters?: unknown, systemMessage?: string, parent?: RawTalkMessage,
 *   reactions?: Record<string, number> }} RawTalkMessage
 * @typedef {{ token?: string, type?: number, displayName?: string, name?: string, description?: string,
 *   unreadMessages?: number, unreadMention?: boolean, lastActivity?: number, lastMessage?: RawTalkMessage,
 *   participantType?: number, canStartCall?: boolean, readOnly?: number, hasCall?: boolean, callFlag?: number,
 *   callRecording?: number, callStartTime?: number, objectType?: string, objectId?: string }} RawTalkRoom
 * @typedef {{ attendeeId?: number, actorType?: string, actorId?: string, displayName?: string,
 *   participantType?: number, inCall?: number, lastPing?: number }} RawTalkParticipant
 * @typedef {{ id: number, actor: string, actorId: string, actorType: string, timestamp: number, message: string,
 *   messageParameters: unknown, systemMessage: string|null, parent: TalkMessage|null,
 *   reactions: Record<string, number> }} TalkMessage
 */

/** @param {RawTalkRoom} r */
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

/** @param {RawTalkParticipant} p */
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


/** @param {RawTalkMessage} m @returns {TalkMessage} */
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

// System messages that only announce a reaction. Talk posts one per reaction
// and embeds the whole parent; "reaction_revoked" even reads "you deleted a
// message". The reactions themselves are on the target message.
const REACTION_SYSTEM_MESSAGES = new Set(['reaction', 'reaction_deleted', 'reaction_revoked']);

/** Talk puts the reason of a poll refusal in `ocs.data.error` as a short code. */
/** @type {Record<string, string>} */
const POLL_ERROR_TEXT = {
    options: 'one of the optionIds is not a valid option of this poll',
    'max-votes': 'more options than this poll allows per voter',
    vote: 'this vote is not allowed (for example it exceeds the maximum votes per person)',
    poll: 'the poll was not found or is already closed',
    state: 'the poll is already closed',
    permission: 'only the poll creator or a moderator may do this',
};

/**
 * A failed poll call. Keeps Talk's own error code as a readable reason instead
 * of a bare status; everything else goes through the shared mapping.
 * @param {Response} res
 * @param {string} authError
 * @param {string} what
 */
async function pollError(res, authError, what) {
    const text = await res.text().catch(() => '');
    if (res.status >= 400 && res.status < 500 && res.status !== 401) {
        let code = '';
        try { code = JSON.parse(text)?.ocs?.data?.error; } catch (_) { code = ''; }
        if (typeof code === 'string' && POLL_ERROR_TEXT[code]) {
            return { error: `Poll ${what} refused (${res.status}): ${POLL_ERROR_TEXT[code]}.` };
        }
    }
    return nextcloudHttpError({ status: res.status, text: async () => text }, { authError, what: `poll ${what}`, app: 'Talk' });
}

/** "option-3" -> "3": the tools use bare 0-based indexes everywhere. */
/** @param {unknown} votes */
function bareVoteKeys(votes) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(votes && typeof votes === 'object' ? votes : {})) {
        out[String(k).replace(/^option-/, '')] = v;
    }
    return out;
}

module.exports = { mapRoom, mapParticipant, mapMessage, pollError, bareVoteKeys, REACTION_SYSTEM_MESSAGES };
