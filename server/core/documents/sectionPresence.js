// @typecheck
/**
 * Who has a designed document open, and which section they are typing in:
 * the "Anna is editing Pricing" of a document that is not co-edited live.
 *
 * A designed document (a letter, a report, a quote) is edited in the frame as
 * one body and saved with a revision check; two people typing at once is
 * resolved by the three-way merge (sectionMerge.js). What makes that rare is
 * knowing the other is there: every open editor sends a heartbeat with the
 * section its caret is in, and this registry answers who else is around.
 * A SOFT lock: nothing is refused because somebody else is in a section; the
 * editor shows it, and the merge is the safety net.
 *
 * In memory, per process, and deliberately forgetful: an entry lives
 * PRESENCE_TTL_MS after its last heartbeat. Across replicas the same beats
 * travel as transient project events (the route publishes them), so a live
 * editor learns of a peer on another replica from the stream; the answer here
 * is the fallback for an editor without one. No content is ever held: user
 * id, a client id, a section id, a state and a time.
 */

'use strict';

const PRESENCE_TTL_MS = 45_000;
const MAX_CLIENTS_PER_DOCUMENT = 64;
const MAX_DOCUMENTS = 5_000;

/** @typedef {{ userId: string, clientId: string, sectionId: string|null, state: 'viewing'|'editing', since: number, at: number }} PresenceEntry */

/** @type {Map<string, Map<string, PresenceEntry>>} */
const documents = new Map();

/** @param {Map<string, PresenceEntry>} clients @param {number} now */
function sweep(clients, now) {
    for (const [clientId, entry] of clients) if (now - entry.at > PRESENCE_TTL_MS) clients.delete(clientId);
}

/**
 * Record one heartbeat. A client that changes section starts a new `since`.
 *
 * @param {string} documentId
 * @param {{ userId: string, clientId: string, sectionId?: string|null, state?: 'viewing'|'editing' }} beat
 * @param {number} [now]
 */
function beat(documentId, { userId, clientId, sectionId = null, state = 'viewing' }, now = Date.now()) {
    let clients = documents.get(documentId);
    if (!clients) {
        if (documents.size >= MAX_DOCUMENTS) pruneAll(now);
        if (documents.size >= MAX_DOCUMENTS) return;
        clients = new Map();
        documents.set(documentId, clients);
    }
    sweep(clients, now);
    const previous = clients.get(clientId);
    if (!previous && clients.size >= MAX_CLIENTS_PER_DOCUMENT) return;
    // A client id belongs to the user who first used it; another user sending
    // it does not take the entry over.
    if (previous && previous.userId !== userId) return;
    const same = previous && previous.sectionId === sectionId && previous.state === state;
    clients.set(clientId, { userId, clientId, sectionId, state, since: same ? previous.since : now, at: now });
}

/**
 * @param {string} documentId
 * @param {string} clientId
 * @param {string} userId  only the user who holds the client id can end it
 */
function leave(documentId, clientId, userId) {
    const clients = documents.get(documentId);
    const entry = clients?.get(clientId);
    if (!clients || !entry || entry.userId !== userId) return;
    clients.delete(clientId);
    if (!clients.size) documents.delete(documentId);
}

/**
 * Everybody present on a document now, oldest arrival first.
 *
 * @param {string} documentId
 * @param {number} [now]
 * @returns {PresenceEntry[]}
 */
function list(documentId, now = Date.now()) {
    const clients = documents.get(documentId);
    if (!clients) return [];
    sweep(clients, now);
    if (!clients.size) { documents.delete(documentId); return []; }
    return [...clients.values()].sort((a, b) => a.since - b.since).map((e) => ({ ...e }));
}

/** @param {number} now */
function pruneAll(now) {
    for (const [id, clients] of documents) {
        sweep(clients, now);
        if (!clients.size) documents.delete(id);
    }
}

function _reset() { documents.clear(); }

module.exports = { PRESENCE_TTL_MS, beat, leave, list, _reset };
