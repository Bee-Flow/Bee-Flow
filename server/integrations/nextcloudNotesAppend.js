// @typecheck noImplicitAny
'use strict';
/**
 * notes_append: add text to the note with this title, or create it.
 * Kept apart from nextcloudNotesTools.js, which only dispatches.
 */

/**
 * A title the way Notes stores it. Notes derives the file name from the title
 * and strips what a file name cannot hold, so the stored title differs from
 * the one that was sent. Both sides of a comparison go through this.
 * @param {string} title
 */
function titleKey(title) {
    return String(title ?? '')
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/^[#\s]+/, '')
        .slice(0, 100)
        .trim()
        .toLowerCase();
}

/**
 * The note an append targets: same title as stored (see titleKey). With
 * several matches, one in the requested category wins, then the lowest id, so
 * the choice is the same on every run.
 * @param {Array<{ id: number | string, title?: string, category?: string }> | null | undefined} all
 * @param {string} title
 * @param {string | undefined} category
 */
function findAppendTarget(all, title, category) {
    if (!Array.isArray(all)) return null;
    const wanted = titleKey(title);
    if (!wanted) return null;
    const hits = all.filter(n => titleKey(n.title) === wanted);
    if (!hits.length) return null;
    const inCategory = category ? hits.filter(n => (n.category || '') === category) : [];
    const pool = inCategory.length ? inCategory : hits;
    return pool.reduce((best, n) => (Number(n.id) < Number(best.id) ? n : best));
}

/**
 * @param {{ api: string, ncFetch: Function, authError: string, baseHeaders: Record<string,string>,
 *   readJsonSafe: Function, summarise: Function, trimContent: Function }} deps
 * @param {{ title?: string, content?: string, category?: string, separator?: string }} args
 */
async function appendToNote(deps, args) {
    const { api, ncFetch, authError, baseHeaders, readJsonSafe, summarise, trimContent } = deps;
    if (!args.title || args.content === undefined) return { error: 'title and content are required' };
    const sep = args.separator !== undefined ? String(args.separator) : '\n';
    // Find an existing note with this exact title (case-insensitive).
    const listRes = await ncFetch(`${api}?exclude=content`, { headers: baseHeaders });
    if (listRes.status === 401) return { error: authError };
    if (listRes.status === 404) return { error: 'Notes app is not installed/enabled on this Nextcloud server.' };
    if (!listRes.ok) return { error: `Notes list failed (${listRes.status})` };
    const all = await readJsonSafe(listRes);
    const existing = findAppendTarget(all, args.title, args.category);

    if (existing) {
        // Fetch current content, append, and PUT it back.
        const getRes = await ncFetch(`${api}/${encodeURIComponent(existing.id)}`, { headers: baseHeaders });
        if (getRes.status === 401) return { error: authError };
        if (!getRes.ok) return { error: `Note fetch failed (${getRes.status})` };
        const cur = await readJsonSafe(getRes);
        const prev = cur && typeof cur.content === 'string' ? cur.content : '';
        const merged = trimContent(`${prev}${prev ? sep : ''}${args.content}`);
        const putRes = await ncFetch(`${api}/${encodeURIComponent(existing.id)}`, {
            method: 'PUT',
            headers: { ...baseHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: merged, modified: Math.floor(Date.now() / 1000) }),
        });
        if (putRes.status === 401) return { error: authError };
        if (!putRes.ok) { const err = await readJsonSafe(putRes); return { error: `Note append failed (${putRes.status})`, detail: err }; }
        const updated = await readJsonSafe(putRes);
        return { success: true, appended: true, note: summarise(updated) };
    }

    // No existing note with that title → create it.
    const createRes = await ncFetch(api, {
        method: 'POST',
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: args.title, content: args.content, category: args.category || '', favorite: false, modified: Math.floor(Date.now() / 1000) }),
    });
    if (createRes.status === 401) return { error: authError };
    if (!createRes.ok) { const err = await readJsonSafe(createRes); return { error: `Note create failed (${createRes.status})`, detail: err }; }
    const created = await readJsonSafe(createRes);
    return { success: true, appended: false, created: true, note: summarise(created) };
}

module.exports = { appendToNote, titleKey, findAppendTarget };
