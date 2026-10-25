// @typecheck noImplicitAny
/**
 * Per-tool handlers of the Nextcloud Deck executor (nextcloudDeckTools.js).
 * Each takes (args, { api, ncFetch, authError, baseUrl, toolName }) and answers
 * what the tool returns to the model; HANDLERS maps tool names to them.
 */

const { nextcloudHttpError } = require('./nextcloudHttpError');
const { toUtcIso, keepDue } = require('./nextcloudDeckDates');

/**
 * Tool arguments of every Deck tool (each reads its own subset).
 * @typedef {object} DeckArgs
 * @property {number | string} [boardId]
 * @property {number | string} [stackId]
 * @property {number | string} [cardId]
 * @property {number | string} [targetStackId]
 * @property {number | string} [labelId]
 * @property {string} [title]
 * @property {string} [description]
 * @property {string} [type]
 * @property {string | number} [duedate]
 * @property {number} [order]
 * @property {boolean} [archived]
 * @property {boolean} [includeArchived]
 * @property {string} [labelTitle]
 * @property {string} [query]
 * @property {string} [assignedUid]
 * @property {string} [dueBefore]
 * @property {string} [dueAfter]
 * @property {number} [limit]
 * @property {string} [message]
 * @property {number} [parentId]
 */
/**
 * What the executor hands every handler.
 * @typedef {{ api: string, ncFetch: import('./nextcloudClient.types').NcAuth['fetch'], authError: string, baseUrl: string, toolName: string }} DeckCtx
 */
/** @typedef {{ id?: number, title?: string, color?: string }} DeckLabel */
/** @typedef {{ uid?: string, participant?: { uid?: string } }} DeckAssignee */

// ─── Helpers ──────────────────────────────────────────────────────

/** @param {string} baseUrl */
function deckRoot(baseUrl) {
    return `${baseUrl}/index.php/apps/deck/api/v1.0`;
}

/** @param {string} baseUrl */
function commentsRoot(baseUrl) {
    return `${baseUrl}/ocs/v2.php/apps/deck/api/v1.0`;
}

/** @param {Response} res */
async function readJsonSafe(res) {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text); } catch { return text; }
}

/**
 * @param {DeckCtx['ncFetch']} ncFetch
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: unknown }} [options]
 */
async function deckJson(ncFetch, url, options = {}) {
    const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json', ...(options.headers || {}) };
    const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    return ncFetch(url, { ...options, headers, body });
}

/**
 * @param {string | number | Date} iso
 * @param {string | number | Date} opIso
 * @param {string} op
 */
function compareDates(iso, opIso, op) {
    if (!iso || !opIso) return false;
    const a = new Date(iso).getTime();
    const b = new Date(opIso).getTime();
    if (isNaN(a) || isNaN(b)) return false;
    return op === 'lte' ? a <= b : a >= b;
}

// ─── Tool execution ──────────────────────────────────────────────

// Deck splits its surface across two URL families:
//   - REST  /index.php/apps/deck/api/v1.0/...  → no OCS-APIRequest header
//   - OCS   /ocs/v2.php/apps/deck/api/v1.0/... → OCS-APIRequest required
// Sending OCS-APIRequest on the REST family triggers a 401 in some Nextcloud
// versions because NC's framework switches to the OCS auth middleware mid-flight.
const REST_HEADERS = { 'Accept': 'application/json' };
const OCS_HEADERS  = { 'Accept': 'application/json', 'OCS-APIRequest': 'true' };

/**
 * @param {DeckArgs} args
 * @param {DeckCtx} ctx
 */
async function listBoards(args, { api, ncFetch, authError }) {
    const url = `${api}/boards${args.includeArchived ? '?details=true' : ''}`;
    const res = await ncFetch(url, { headers: REST_HEADERS });
    if (res.status === 401) return { error: authError };
    if (!res.ok) return { error: `Deck boards list failed (${res.status})` };
    const boards = await readJsonSafe(res);
    const list = Array.isArray(boards)
        ? boards.filter(b => args.includeArchived || !b.archived).map(b => ({
            id: b.id, title: b.title, color: b.color, archived: b.archived,
            labels: (b.labels || []).map((/** @type {DeckLabel} */ l) => ({ id: l.id, title: l.title, color: l.color })),
            permissions: b.permissions, owner: b.owner?.uid || b.owner,
        }))
        : [];
    return { count: list.length, boards: list };
}

/**
 * @param {DeckArgs} args
 * @param {DeckCtx} ctx
 */
async function getBoard(args, { api, ncFetch, authError }) {
    if (!args.boardId) return { error: 'boardId is required' };
    const res = await ncFetch(`${api}/boards/${args.boardId}`, { headers: REST_HEADERS });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Board not found: ${args.boardId}` };
    if (!res.ok) return { error: `Deck board fetch failed (${res.status})` };
    return await readJsonSafe(res);
}

/**
 * @param {DeckArgs} args
 * @param {DeckCtx} ctx
 */
async function listStacks(args, { api, ncFetch, authError }) {
    if (!args.boardId) return { error: 'boardId is required' };
    const res = await ncFetch(`${api}/boards/${args.boardId}/stacks`, { headers: REST_HEADERS });
    if (res.status === 401) return { error: authError };
    if (!res.ok) return { error: `Stack list failed (${res.status})` };
    const stacks = await readJsonSafe(res);
    return Array.isArray(stacks)
        ? { count: stacks.length, stacks: stacks.map(s => ({ id: s.id, title: s.title, order: s.order, cardCount: (s.cards || []).length })) }
        : stacks;
}

/**
 * @param {DeckArgs} args
 * @param {DeckCtx} ctx
 */
async function createStack(args, { api, ncFetch, authError }) {
    if (!args.boardId || !args.title) return { error: 'boardId and title are required' };
    const res = await deckJson(ncFetch, `${api}/boards/${args.boardId}/stacks`, {
        method: 'POST',
        headers: REST_HEADERS,
        body: {
            title: String(args.title),
            order: args.order !== undefined ? Number(args.order) : 999,
        },
    });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Board not found: ${args.boardId}` };
    if (!res.ok) {
        const detail = await readJsonSafe(res);
        return { error: `Stack create failed (${res.status})`, detail };
    }
    const stack = await readJsonSafe(res);
    return {
        success: true,
        stack: { id: stack.id, title: stack.title, order: stack.order, boardId: args.boardId },
    };
}

/**
 * @param {DeckArgs} args
 * @param {DeckCtx} ctx
 */
async function updateStack(args, { api, ncFetch, authError }) {
    if (!args.boardId || !args.stackId) return { error: 'boardId and stackId are required' };
    // Deck's PUT is a replace — fetch current then merge.
    const listRes = await ncFetch(`${api}/boards/${args.boardId}/stacks`, { headers: REST_HEADERS });
    if (listRes.status === 401) return { error: authError };
    if (!listRes.ok) return { error: `Could not load stacks for update (${listRes.status})` };
    const stacks = await readJsonSafe(listRes);
    const current = Array.isArray(stacks) ? stacks.find(s => s.id === Number(args.stackId)) : null;
    if (!current) return { error: `Stack not found: ${args.stackId}` };

    const merged = {
        title: args.title !== undefined ? String(args.title) : current.title,
        order: args.order !== undefined ? Number(args.order) : current.order,
    };
    const putRes = await deckJson(ncFetch, `${api}/boards/${args.boardId}/stacks/${args.stackId}`, {
        method: 'PUT',
        headers: REST_HEADERS,
        body: merged,
    });
    if (!putRes.ok) {
        const detail = await readJsonSafe(putRes);
        return { error: `Stack update failed (${putRes.status})`, detail };
    }
    const updated = await readJsonSafe(putRes);
    return { success: true, stack: { id: updated.id, title: updated.title, order: updated.order } };
}

/**
 * @param {DeckArgs} args
 * @param {DeckCtx} ctx
 */
async function deleteStack(args, { api, ncFetch, authError }) {
    if (!args.boardId || !args.stackId) return { error: 'boardId and stackId are required' };
    const res = await ncFetch(`${api}/boards/${args.boardId}/stacks/${args.stackId}`, {
        method: 'DELETE',
        headers: REST_HEADERS,
    });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Stack not found: ${args.stackId}` };
    if (!res.ok && res.status !== 200 && res.status !== 204) {
        return { error: `Stack delete failed (${res.status})` };
    }
    return { success: true, stackId: args.stackId };
}

/**
 * @param {DeckArgs} args
 * @param {DeckCtx} ctx
 */
async function listCards(args, { api, ncFetch, authError, toolName }) {
    if (!args.boardId) return { error: 'boardId is required' };
    const res = await ncFetch(`${api}/boards/${args.boardId}/stacks${args.includeArchived ? '/archived' : ''}`, {
        headers: REST_HEADERS,
    });
    if (res.status === 401) return { error: authError };
    if (!res.ok) return { error: `Card list failed (${res.status})` };
    const stacks = await readJsonSafe(res);
    if (!Array.isArray(stacks)) return { error: 'Unexpected Deck response shape' };

    const labelFilter = args.labelTitle ? args.labelTitle.toLowerCase() : null;
    const queryFilter = args.query ? args.query.toLowerCase() : null;
    /** @type {Array<Record<string, unknown>>} */
    const cards = [];
    for (const stack of stacks) {
        if (args.stackId && stack.id !== args.stackId) continue;
        for (const c of (stack.cards || [])) {
            if (queryFilter) {
                const haystack = `${c.title || ''} ${c.description || ''}`.toLowerCase();
                if (!haystack.includes(queryFilter)) continue;
            }
            if (labelFilter && !(c.labels || []).some((/** @type {DeckLabel} */ l) => (l.title || '').toLowerCase().includes(labelFilter))) continue;
            if (args.assignedUid && !(c.assignedUsers || []).some((/** @type {DeckAssignee} */ u) => (u.participant?.uid || u.uid) === args.assignedUid)) continue;
            if (args.dueBefore && !compareDates(c.duedate, args.dueBefore, 'lte')) continue;
            if (args.dueAfter && !compareDates(c.duedate, args.dueAfter, 'gte')) continue;
            cards.push({
                id: c.id, stackId: stack.id, stackTitle: stack.title,
                title: c.title, description: c.description, duedate: c.duedate,
                labels: (c.labels || []).map((/** @type {DeckLabel} */ l) => ({ id: l.id, title: l.title, color: l.color })),
                assignedUsers: (c.assignedUsers || []).map((/** @type {DeckAssignee} */ u) => u.participant?.uid || u.uid),
                archived: c.archived, order: c.order, type: c.type,
            });
        }
    }
    const limit = Math.min(Math.max(args.limit || (toolName === 'nextcloud_deck_search_cards' ? 50 : 200), 1), toolName === 'nextcloud_deck_search_cards' ? 200 : 1000);
    return { boardId: args.boardId, count: Math.min(cards.length, limit), cards: cards.slice(0, limit) };
}

/**
 * @param {DeckArgs} args
 * @param {DeckCtx} ctx
 */
async function getCard(args, { api, ncFetch, authError }) {
    if (!args.boardId || !args.stackId || !args.cardId) return { error: 'boardId, stackId, cardId required' };
    const res = await ncFetch(`${api}/boards/${args.boardId}/stacks/${args.stackId}/cards/${args.cardId}`, {
        headers: REST_HEADERS,
    });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Card not found: ${args.cardId}` };
    if (!res.ok) return { error: `Card fetch failed (${res.status})` };
    return await readJsonSafe(res);
}

/**
 * @param {DeckArgs} args
 * @param {DeckCtx} ctx
 */
async function createCard(args, { api, ncFetch, authError }) {
    if (!args.boardId || !args.stackId || !args.title) return { error: 'boardId, stackId, title required' };
    const due = toUtcIso(args.duedate);
    if ('error' in due) return due;
    const res = await deckJson(ncFetch, `${api}/boards/${args.boardId}/stacks/${args.stackId}/cards`, {
        method: 'POST',
        headers: REST_HEADERS,
        body: {
            title: args.title,
            type: args.type || 'plain',
            order: 999,
            description: args.description || '',
            duedate: due.iso,
        },
    });
    if (res.status === 401) return { error: authError };
    if (!res.ok) {
        const body = await readJsonSafe(res);
        return { error: `Card create failed (${res.status})`, detail: body };
    }
    return await readJsonSafe(res);
}

/**
 * @param {DeckArgs} args
 * @param {DeckCtx} ctx
 */
async function updateCard(args, { api, ncFetch, authError }) {
    if (!args.boardId || !args.stackId || !args.cardId) return { error: 'boardId, stackId, cardId required' };
    const due = toUtcIso(args.duedate);
    if ('error' in due) return due;
    // Deck's PUT replaces the card — fetch first and merge.
    const cardRes = await ncFetch(`${api}/boards/${args.boardId}/stacks/${args.stackId}/cards/${args.cardId}`, {
        headers: REST_HEADERS,
    });
    if (cardRes.status === 401) return { error: authError };
    if (cardRes.status === 404) return { error: `Card not found: ${args.cardId}` };
    if (!cardRes.ok) return { error: `Could not load card for update (${cardRes.status})` };
    const current = await readJsonSafe(cardRes);

    const moving = Boolean(args.targetStackId) && String(args.targetStackId) !== String(args.stackId);
    const target = Number(args.targetStackId);
    const targetStack = Number.isNaN(target) ? args.targetStackId : target;
    const merged = {
        title: args.title !== undefined ? args.title : current.title,
        description: args.description !== undefined ? args.description : current.description,
        // Deck's PUT replaces the card, so an unchanged due date is sent again (as UTC).
        duedate: args.duedate !== undefined ? due.iso : keepDue(current.duedate),
        type: current.type || 'plain',
        owner: current.owner?.uid || current.owner,
        order: args.order !== undefined ? args.order : (moving ? 0 : current.order),
        ...(moving ? { stackId: targetStack } : {}),
    };
    // Deck takes the card's stack from the URL of this PUT, not from the body, and its
    // /reorder endpoint only changes the order inside the current stack. So a move is
    // this same PUT addressed to the TARGET stack (the way archive_card has always moved it).
    const putStack = moving ? args.targetStackId : args.stackId;
    const putRes = await deckJson(ncFetch, `${api}/boards/${args.boardId}/stacks/${putStack}/cards/${args.cardId}`, {
        method: 'PUT',
        headers: REST_HEADERS,
        body: merged,
    });
    if (putRes.status === 401) return { error: authError };
    if (!putRes.ok) {
        const body = await readJsonSafe(putRes);
        return { error: `Card update failed (${putRes.status})`, detail: body };
    }
    const updated = await readJsonSafe(putRes);

    if (moving) {
        // Deck can answer 200 without moving the card: look where it is now.
        const movedRes = await ncFetch(`${api}/boards/${args.boardId}/stacks/${args.targetStackId}/cards/${args.cardId}`, { headers: REST_HEADERS });
        if (!movedRes.ok && movedRes.status !== 404) {
            return { success: true, updated, moveError: `Card updated, but the move could not be verified (${movedRes.status}).` };
        }
        const moved = movedRes.ok ? await readJsonSafe(movedRes) : null;
        if (!moved || (moved.stackId !== undefined && String(moved.stackId) !== String(args.targetStackId))) {
            return { success: true, updated, moveError: `Card updated, but it did not move to stack ${args.targetStackId}.` };
        }
        return { success: true, card: moved };
    }
    return { success: true, card: updated };
}

/**
 * @param {DeckArgs} args
 * @param {DeckCtx} ctx
 */
async function archiveCard(args, { api, ncFetch }) {
    if (!args.boardId || !args.stackId || !args.cardId) return { error: 'boardId, stackId, cardId required' };
    const archived = args.archived === false ? false : true;
    const cardRes = await ncFetch(`${api}/boards/${args.boardId}/stacks/${args.stackId}/cards/${args.cardId}`, {
        headers: REST_HEADERS,
    });
    if (!cardRes.ok) return { error: `Could not load card (${cardRes.status})` };
    const current = await readJsonSafe(cardRes);
    const putRes = await deckJson(ncFetch, `${api}/boards/${args.boardId}/stacks/${args.stackId}/cards/${args.cardId}`, {
        method: 'PUT',
        headers: REST_HEADERS,
        body: {
            title: current.title,
            description: current.description || '',
            duedate: keepDue(current.duedate),
            type: current.type || 'plain',
            owner: current.owner?.uid || current.owner,
            order: current.order,
            archived,
        },
    });
    if (!putRes.ok) {
        const body = await readJsonSafe(putRes);
        return { error: `Archive toggle failed (${putRes.status})`, detail: body };
    }
    return { success: true, archived };
}

/**
 * @param {DeckArgs} args
 * @param {DeckCtx} ctx
 */
async function deleteCard(args, { api, ncFetch, authError }) {
    if (!args.boardId || !args.stackId || !args.cardId) return { error: 'boardId, stackId, cardId required' };
    const res = await ncFetch(`${api}/boards/${args.boardId}/stacks/${args.stackId}/cards/${args.cardId}`, {
        method: 'DELETE',
        headers: REST_HEADERS,
    });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Card not found: ${args.cardId}` };
    if (!res.ok && res.status !== 200 && res.status !== 204) return { error: `Card delete failed (${res.status})` };
    return { success: true, cardId: args.cardId };
}

/**
 * @param {DeckArgs} args
 * @param {DeckCtx} ctx
 */
async function assignLabel(args, { api, ncFetch, authError, toolName }) {
    if (!args.boardId || !args.stackId || !args.cardId || !args.labelId) return { error: 'boardId, stackId, cardId, labelId required' };
    const op = toolName === 'nextcloud_deck_assign_label' ? 'assignLabel' : 'removeLabel';
    const res = await deckJson(ncFetch, `${api}/boards/${args.boardId}/stacks/${args.stackId}/cards/${args.cardId}/${op}`, {
        method: 'PUT',
        headers: REST_HEADERS,
        body: { labelId: args.labelId },
    });
    if (res.status === 401) return { error: authError };
    if (res.status === 403 || res.status === 404 || res.status >= 500) {
        return nextcloudHttpError(res, { authError, what: `${op} (check the board, stack, card and label ids)` });
    }
    if (!res.ok) {
        const body = await readJsonSafe(res);
        return { error: `${op} failed (${res.status})`, detail: body };
    }
    return { success: true };
}

/**
 * @param {DeckArgs} args
 * @param {DeckCtx} ctx
 */
async function addComment(args, { ncFetch, authError, baseUrl }) {
    if (!args.cardId || !args.message) return { error: 'cardId and message required' };
    // Deck comments live under OCS, not the v1.0 REST path.
    const url = `${commentsRoot(baseUrl)}/cards/${args.cardId}/comments`;
    const res = await deckJson(ncFetch, url, {
        method: 'POST',
        headers: OCS_HEADERS,
        body: {
            message: args.message,
            parentId: args.parentId || 0,
        },
    });
    if (res.status === 401) return { error: authError };
    if (!res.ok) {
        const body = await readJsonSafe(res);
        return { error: `Comment failed (${res.status})`, detail: body };
    }
    const data = await readJsonSafe(res);
    return { success: true, comment: data?.ocs?.data || data };
}

/**
 * @param {DeckArgs} args
 * @param {DeckCtx} ctx
 */
async function listComments(args, { ncFetch, authError, baseUrl }) {
    if (!args.cardId) return { error: 'cardId is required' };
    const limit = Math.min(Math.max(args.limit || 50, 1), 200);
    const url = `${commentsRoot(baseUrl)}/cards/${args.cardId}/comments?limit=${limit}`;
    const res = await ncFetch(url, { headers: OCS_HEADERS });
    if (res.status === 401) return { error: authError };
    if (!res.ok) return { error: `Comment list failed (${res.status})` };
    const data = await readJsonSafe(res);
    const list = data?.ocs?.data || data || [];
    return { count: Array.isArray(list) ? list.length : 0, comments: list };
}

/** @type {Record<string, (args: DeckArgs, ctx: DeckCtx) => Promise<unknown>>} */
const HANDLERS = {
    nextcloud_deck_list_boards: listBoards,
    nextcloud_deck_get_board: getBoard,
    nextcloud_deck_list_stacks: listStacks,
    nextcloud_deck_create_stack: createStack,
    nextcloud_deck_update_stack: updateStack,
    nextcloud_deck_delete_stack: deleteStack,
    nextcloud_deck_list_cards: listCards,
    nextcloud_deck_search_cards: listCards,
    nextcloud_deck_get_card: getCard,
    nextcloud_deck_create_card: createCard,
    nextcloud_deck_update_card: updateCard,
    nextcloud_deck_archive_card: archiveCard,
    nextcloud_deck_delete_card: deleteCard,
    nextcloud_deck_assign_label: assignLabel,
    nextcloud_deck_remove_label: assignLabel,
    nextcloud_deck_add_comment: addComment,
    nextcloud_deck_list_comments: listComments,
};

module.exports = { HANDLERS, deckRoot };
