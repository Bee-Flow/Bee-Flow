// @typecheck
/**
 * What the server checks in the bytes a client sends: Yjs updates, state
 * vectors and awareness updates. All of it is untrusted input.
 *
 *   updates    base64 → bytes, size caps, a full decode (a truncated or
 *              random buffer is refused before it reaches the log), and the
 *              client ids + clocks it carries (for the author binding in
 *              stores/collabDocStore.js).
 *   awareness  y-protocols awareness update: re-encoded with `user.id` set
 *              from the SESSION (whatever the client claimed), each state
 *              capped in size and limited to the posting client's own id.
 *
 * Awareness holds ids, colours and relative positions, never document text,
 * which is why it may travel through the event bus (and Redis) as it is.
 */

'use strict';

const Y = require('yjs');
const decoding = require('lib0/decoding');
const encoding = require('lib0/encoding');

class CollabWireError extends Error {
    /** @param {string} code @param {string} message @param {number} [status] */
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'CollabWireError';
        this.code = code;
        this.status = status;
    }
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Strict base64 (standard alphabet, padded). `Buffer.from(x, 'base64')`
 * silently skips junk, which would turn a garbled body into a different,
 * shorter update instead of a refusal.
 * @param {unknown} s @param {string} what
 * @returns {Uint8Array}
 */
function decodeB64(s, what) {
    if (typeof s !== 'string' || s.length % 4 !== 0 || !B64.test(s)) {
        throw new CollabWireError('INVALID_ENCODING', `${what} is not base64.`);
    }
    const buf = Buffer.from(s, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** @param {Uint8Array} bytes */
const toB64 = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');

/**
 * Decode and measure one update. Throws for anything Yjs cannot read.
 * @param {Uint8Array} update
 * @returns {{ clients: Map<number, number>, empty: boolean }} end clock per client id with structs
 */
function inspectUpdate(update) {
    try {
        const decoded = Y.decodeUpdate(update);
        const meta = Y.parseUpdateMeta(update);
        const empty = decoded.structs.length === 0 && decoded.ds.clients.size === 0;
        return { clients: meta.to, empty };
    } catch (_) {
        throw new CollabWireError('INVALID_UPDATE', 'An update could not be read.');
    }
}

/**
 * Validate a batch and merge it into one update.
 *
 * @param {unknown[]} encoded base64 updates
 * @param {{ maxUpdateBytes: number, maxBatchBytes: number }} caps
 * @returns {{ merged: Uint8Array, byteLen: number, clients: Array<{ clientId: number, to: number }>, empty: boolean }}
 */
function readUpdateBatch(encoded, { maxUpdateBytes, maxBatchBytes }) {
    let total = 0;
    const updates = [];
    const clients = new Map();
    let allEmpty = true;
    for (const item of encoded) {
        const u = decodeB64(item, 'An update');
        if (u.length > maxUpdateBytes) {
            throw new CollabWireError('UPDATE_TOO_LARGE', `One change is larger than ${Math.round(maxUpdateBytes / 1024)} KB.`, 413);
        }
        total += u.length;
        if (total > maxBatchBytes) {
            throw new CollabWireError('UPDATE_TOO_LARGE', `These changes together are larger than ${Math.round(maxBatchBytes / 1024)} KB.`, 413);
        }
        const info = inspectUpdate(u);
        if (!info.empty) allEmpty = false;
        for (const [client, to] of info.clients) clients.set(client, Math.max(clients.get(client) || 0, to));
        updates.push(u);
    }
    const merged = updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
    return {
        merged,
        byteLen: merged.length,
        clients: [...clients].map(([clientId, to]) => ({ clientId, to })),
        empty: allEmpty,
    };
}

/**
 * A client's state vector, validated.
 * @param {unknown} encoded base64, '' for "I have nothing"
 * @param {number} maxBytes
 */
function readStateVector(encoded, maxBytes) {
    if (encoded === '' || encoded === undefined || encoded === null) return Y.encodeStateVector(new Y.Doc());
    const sv = decodeB64(encoded, 'The state vector');
    if (sv.length > maxBytes) throw new CollabWireError('INVALID_STATE_VECTOR', 'The state vector is too large.');
    try {
        Y.decodeStateVector(sv);
    } catch (_) {
        throw new CollabWireError('INVALID_STATE_VECTOR', 'The state vector could not be read.');
    }
    return sv;
}

/**
 * Decode an awareness update into its entries.
 * @param {Uint8Array} update
 * @returns {Array<{ clientId: number, clock: number, state: Record<string, any>|null }>}
 */
function decodeAwareness(update) {
    try {
        const decoder = decoding.createDecoder(update);
        const len = decoding.readVarUint(decoder);
        if (len > 64) throw new Error('too many entries');
        const out = [];
        for (let i = 0; i < len; i += 1) {
            const clientId = decoding.readVarUint(decoder);
            const clock = decoding.readVarUint(decoder);
            const state = JSON.parse(decoding.readVarString(decoder));
            if (state !== null && (typeof state !== 'object' || Array.isArray(state))) throw new Error('state is not an object');
            out.push({ clientId, clock, state });
        }
        if (decoding.hasContent(decoder)) throw new Error('trailing bytes');
        return out;
    } catch (_) {
        throw new CollabWireError('INVALID_AWARENESS', 'The presence update could not be read.');
    }
}

/**
 * @param {Array<{ clientId: number, clock: number, state: Record<string, any>|null }>} entries
 * @returns {Uint8Array}
 */
function encodeAwareness(entries) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, entries.length);
    for (const e of entries) {
        encoding.writeVarUint(encoder, e.clientId);
        encoding.writeVarUint(encoder, e.clock);
        encoding.writeVarString(encoder, JSON.stringify(e.state));
    }
    return encoding.toUint8Array(encoder);
}

/**
 * Re-stamp a client's awareness update with the session's user id and cap
 * it. A client publishes its own state only, so exactly one entry is
 * accepted.
 *
 * @param {Uint8Array} update
 * @param {{ userId: string, maxStateBytes: number }} opts
 * @returns {{ update: Uint8Array, clientId: number, clock: number, removed: boolean }}
 */
function stampAwareness(update, { userId, maxStateBytes }) {
    const entries = decodeAwareness(update);
    if (entries.length !== 1) throw new CollabWireError('INVALID_AWARENESS', 'A presence update carries exactly one state.');
    const [entry] = entries;
    let state = entry.state;
    if (state) {
        const claimedUser = state.user && typeof state.user === 'object' && !Array.isArray(state.user) ? state.user : {};
        state = { ...state, user: { ...claimedUser, id: userId } };
        if (Buffer.byteLength(JSON.stringify(state), 'utf8') > maxStateBytes) {
            throw new CollabWireError('AWARENESS_TOO_LARGE', 'The presence state is too large.', 413);
        }
    }
    return {
        update: encodeAwareness([{ clientId: entry.clientId, clock: entry.clock, state }]),
        clientId: entry.clientId,
        clock: entry.clock,
        removed: state === null,
    };
}

/**
 * "This client left": a null state one clock past the last one this server
 * saw. Peers drop the cursor; without a known clock the 30-second awareness
 * timeout still removes it.
 * @param {number} clientId @param {number} lastClock
 */
function leaveAwareness(clientId, lastClock) {
    return encodeAwareness([{ clientId, clock: lastClock + 1, state: null }]);
}

module.exports = {
    CollabWireError,
    decodeB64,
    toB64,
    inspectUpdate,
    readUpdateBatch,
    readStateVector,
    decodeAwareness,
    encodeAwareness,
    stampAwareness,
    leaveAwareness,
};
