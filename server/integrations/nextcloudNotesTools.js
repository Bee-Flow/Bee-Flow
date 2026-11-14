// @typecheck strict
/**
 * Nextcloud Notes Tools — JSON CRUD on /index.php/apps/notes/api/v1/notes.
 *
 * Auth handled by ./nextcloudClient. Notes are simple plain-text/markdown
 * documents with title, content, category, favorite flag — useful as an
 * AI scratchpad or personal knowledge store.
 */

const ncClient = require('./nextcloudClient');
const { appendToNote } = require('./nextcloudNotesAppend');
const { NEXTCLOUD_NOTES_TOOLS } = require('./nextcloudNotesToolDefs.mts');

const MAX_CONTENT_BYTES = 200 * 1024;


/** @param {string} baseUrl */
function notesApi(baseUrl) {
    return `${baseUrl}/index.php/apps/notes/api/v1/notes`;
}

/** @param {Response} res */
async function readJsonSafe(res) {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text); } catch { return text; }
}

/** @param {string | null | undefined} content */
function trimContent(content) {
    if (!content) return content;
    if (content.length <= MAX_CONTENT_BYTES) return content;
    return content.slice(0, MAX_CONTENT_BYTES) + '\n\n... [truncated — note too large]';
}

/**
 * @param {{ id: number, title?: string, category?: string, modified?: number, favorite?: boolean, content?: string }} note
 */
function summarise(note) {
    /** @type {{ id: number, title?: string, category?: string, modified?: number, favorite?: boolean, excerpt?: string }} */
    const out = {
        id: note.id,
        title: note.title,
        category: note.category,
        modified: note.modified,
        favorite: note.favorite,
    };
    // A listing is fetched without content (exclude=content); an empty excerpt
    // there would claim the note is empty, so the key is left out.
    if (typeof note.content === 'string') out.excerpt = note.content.slice(0, 200);
    return out;
}

/**
 * @typedef {{ id?: number | string, title?: string, content?: string, category?: string, favorite?: boolean, query?: string, limit?: number }} NotesArgs
 * @typedef {{ api: string, ncFetch: import('./nextcloudClient.types').NcAuth['fetch'], authError: string,
 *   baseHeaders: Record<string, string> }} NotesCtx
 * @typedef {(args: NotesArgs, c: NotesCtx) => Promise<Record<string, any>>} NotesHandler
 */

/** @type {NotesHandler} */
async function listNotes(args, { api, ncFetch, authError, baseHeaders }) {
    const params = new URLSearchParams();
    if (args.category !== undefined) params.set('category', args.category);
    if (args.favorite !== undefined) params.set('favorite', args.favorite ? 'true' : 'false');
    params.set('exclude', 'content'); // Keep payload small for list view.
    const url = `${api}${params.toString() ? '?' + params.toString() : ''}`;
    const res = await ncFetch(url, { headers: baseHeaders });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: 'Notes app is not installed/enabled on this Nextcloud server.' };
    if (!res.ok) return { error: `Notes list failed (${res.status})` };
    const data = await readJsonSafe(res);
    const limit = Math.min(Math.max(args.limit || 100, 1), 500);
    const list = Array.isArray(data) ? data.slice(0, limit).map(summarise) : [];
    return { count: list.length, notes: list };
}

/**
 * Push the notes of one chunk whose title or content holds `q`, up to `limit`.
 * @param {any[]} data @param {string} q @param {number} limit @param {ReturnType<typeof summarise>[]} matches
 */
function collectMatches(data, q, limit, matches) {
    for (const note of data) {
        const haystack = `${note.title || ''}\n${note.content || ''}`.toLowerCase();
        if (haystack.includes(q)) {
            matches.push(summarise(note));
            if (matches.length >= limit) break;
        }
    }
}

/** @type {NotesHandler} */
async function searchNotes(args, { api, ncFetch, authError, baseHeaders }) {
    const q = String(args.query || '').toLowerCase().trim();
    if (!q) return { error: 'query is required' };
    const limit = Math.min(Math.max(args.limit || 25, 1), 100);
    // Notes API has no native search endpoint, but it supports chunked
    // pagination (Notes app v1.2+) — page through with chunkSize=50 and
    // break as soon as `limit` matches are found. Keeps any single
    // response under ~2 MB even for accounts with thousands of notes.
    /** @type {ReturnType<typeof summarise>[]} */
    const matches = [];
    let cursor = null;
    const MAX_CHUNKS = 40; // Safety net: scans up to 2000 notes if no match.
    let chunks = 0;
    while (chunks < MAX_CHUNKS && matches.length < limit) {
        const params = new URLSearchParams();
        params.set('chunkSize', '50');
        if (cursor) params.set('chunkCursor', cursor);
        const res = await ncFetch(`${api}?${params.toString()}`, { headers: baseHeaders });
        if (res.status === 401) return { error: authError };
        if (!res.ok) return { error: `Notes search failed (${res.status})` };
        const data = await readJsonSafe(res);
        if (!Array.isArray(data)) return { error: 'Unexpected Notes response' };
        collectMatches(data, q, limit, matches);
        cursor = res.headers.get('X-Notes-Chunk-Cursor');
        const pending = res.headers.get('X-Notes-Chunk-Pending');
        chunks += 1;
        // No cursor → server returned everything in one chunk (Notes < v1.2 or small store).
        if (!cursor || pending === '0' || pending === null) break;
    }
    return { query: args.query, count: matches.length, notes: matches };
}

/** @type {NotesHandler} */
async function getNote(args, { api, ncFetch, authError, baseHeaders }) {
    if (!args.id) return { error: 'id is required' };
    const res = await ncFetch(`${api}/${encodeURIComponent(args.id)}`, { headers: baseHeaders });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Note not found: ${args.id}` };
    if (!res.ok) return { error: `Note fetch failed (${res.status})` };
    const note = await readJsonSafe(res);
    if (!note || typeof note !== 'object') return { error: 'Unexpected Notes response' };
    const truncated = (note.content || '').length > MAX_CONTENT_BYTES;
    return {
        id: note.id,
        title: note.title,
        category: note.category,
        modified: note.modified,
        favorite: note.favorite,
        etag: note.etag,
        truncated,
        content: trimContent(note.content || ''),
    };
}

/** @type {NotesHandler} */
async function createNote(args, { api, ncFetch, authError, baseHeaders }) {
    if (!args.title || args.content === undefined) return { error: 'title and content are required' };
    const body = {
        title: args.title,
        content: args.content,
        category: args.category || '',
        favorite: !!args.favorite,
        modified: Math.floor(Date.now() / 1000),
    };
    const res = await ncFetch(api, {
        method: 'POST',
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (res.status === 401) return { error: authError };
    if (!res.ok) {
        const err = await readJsonSafe(res);
        return { error: `Note create failed (${res.status})`, detail: err };
    }
    const note = await readJsonSafe(res);
    return { success: true, note: summarise(note) };
}

/**
 * Notes' PUT does a partial update — only the fields the LLM provided.
 * @param {NotesArgs} args
 */
function partialNote(args) {
    /** @type {{ title?: string, content?: string, category?: string, favorite?: boolean, modified?: number }} */
    const body = {};
    if (args.title !== undefined) body.title = args.title;
    if (args.content !== undefined) body.content = args.content;
    if (args.category !== undefined) body.category = args.category;
    if (args.favorite !== undefined) body.favorite = !!args.favorite;
    return body;
}

/** @type {NotesHandler} */
async function updateNote(args, { api, ncFetch, authError, baseHeaders }) {
    if (!args.id) return { error: 'id is required' };
    const body = partialNote(args);
    if (Object.keys(body).length === 0) return { error: 'no fields to update' };
    body.modified = Math.floor(Date.now() / 1000);

    const res = await ncFetch(`${api}/${encodeURIComponent(args.id)}`, {
        method: 'PUT',
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Note not found: ${args.id}` };
    if (!res.ok) {
        const err = await readJsonSafe(res);
        return { error: `Note update failed (${res.status})`, detail: err };
    }
    const note = await readJsonSafe(res);
    return { success: true, note: summarise(note) };
}

/** @type {NotesHandler} */
async function deleteNote(args, { api, ncFetch, authError, baseHeaders }) {
    if (!args.id) return { error: 'id is required' };
    const res = await ncFetch(`${api}/${encodeURIComponent(args.id)}`, {
        method: 'DELETE',
        headers: baseHeaders,
    });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Note not found: ${args.id}` };
    if (!res.ok && res.status !== 200 && res.status !== 204) return { error: `Note delete failed (${res.status})` };
    return { success: true, id: args.id };
}

/** @type {NotesHandler} */
async function listCategories(_args, { api, ncFetch, authError, baseHeaders }) {
    const res = await ncFetch(api + '?exclude=content', { headers: baseHeaders });
    if (res.status === 401) return { error: authError };
    if (!res.ok) return { error: `Notes fetch failed (${res.status})` };
    const data = await readJsonSafe(res);
    if (!Array.isArray(data)) return { error: 'Unexpected Notes response' };
    const counts = new Map();
    for (const note of data) {
        const cat = note.category || '';
        counts.set(cat, (counts.get(cat) || 0) + 1);
    }
    // Notes without a category sit in the root; that is not a category to list.
    const categories = [...counts.entries()]
        .filter(([category]) => category !== '')
        .map(([category, count]) => ({ category, count }));
    categories.sort((a, b) => a.category.localeCompare(b.category));
    return { count: categories.length, categories };
}

/** @type {Record<string, NotesHandler>} */
const HANDLERS = {
    nextcloud_notes_list: listNotes,
    nextcloud_notes_search: searchNotes,
    nextcloud_notes_get: getNote,
    nextcloud_notes_create: createNote,
    nextcloud_notes_append: (args, { api, ncFetch, authError, baseHeaders }) =>
        appendToNote({ api, ncFetch, authError, baseHeaders, readJsonSafe, summarise, trimContent }, args),
    nextcloud_notes_update: updateNote,
    nextcloud_notes_delete: deleteNote,
    nextcloud_notes_list_categories: listCategories,
};

/**
 * The Notes API's controller methods are #[CORS]-annotated, which forces
 * Nextcloud to demand HTTP Basic auth even when an OAuth session is active
 * (the CORS middleware logs the Bearer session out before checking creds —
 * see CORSMiddleware::beforeController). So we must use the user's saved app
 * password, never the Bearer token.
 * Connector sessions are the exception: they impersonate via the AppAPI
 * shared secret rather than a Bearer session, so CORSMiddleware never fires.
 * Preferring a saved app password there would silently route Notes outside
 * the connector.
 * @param {string} userId
 * @param {Partial<Express.Session>} session
 */
async function notesAuth(userId, session) {
    if (ncClient.isConnectorSession(session)) return ncClient.resolveAuth(session, userId);
    const basic = await ncClient.resolveBasicAuthOrNull(userId);
    if (basic) return basic;
    // No app password saved. If they're on OAuth, give them a CORS-specific
    // hint; otherwise, fall through to the generic resolveAuth which will
    // surface a "not connected" error.
    if (ncClient.isNextcloudOAuthSession(session)) return null;
    return ncClient.resolveAuth(session, userId);
}

/**
 * @param {string} toolName
 * @param {NotesArgs} args
 * @param {string} userId
 * @param {Partial<Express.Session>} session
 */
async function executeNextcloudNotesTool(toolName, args, userId, session) {
    const ctx = await notesAuth(userId, session);
    if (!ctx) return { error: ncClient.CORS_AUTH_ERROR };
    const handler = Object.hasOwn(HANDLERS, toolName) ? HANDLERS[toolName] : null;
    if (!handler) return { error: `Unknown Nextcloud notes tool: ${toolName}` };
    return handler(args, { api: notesApi(ctx.baseUrl), ncFetch: ctx.fetch, authError: ctx.authError, baseHeaders: { 'Accept': 'application/json' } });
}

/** @param {unknown} toolName */
function isNextcloudNotesTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_notes_');
}

module.exports = {
    NEXTCLOUD_NOTES_TOOLS,
    executeNextcloudNotesTool,
    isNextcloudNotesTool,
};
