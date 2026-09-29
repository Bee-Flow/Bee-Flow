/**
 * A push from a storage → the spreadsheet mirror(s) it is about, marked
 * stale and kicked. Never patched in place: a file event carries no row.
 *
 * ── NEXTCLOUD FILES ─────────────────────────────────────────────────
 * The connector forwards `file.changed|new|deleted|renamed|restored|copied`
 * to /api/automation/events/nextcloud (HMAC-signed, org resolved from the
 * instance id) with a payload `{ id, path, name, oldPath?, sourceId?,
 * actor, … }` — `id` is the Nextcloud file id, `path` is relative to the
 * ACTOR's files root, and `id` is null on a delete (documented upstream:
 * NodeDeletedEvent has no node id). A mirror stores that file id under
 * `source.file.id` (idx_datatables_source_file) and the linker's path under
 * `source.file.path`, so:
 *
 *   - an event WITH an id finds its mirrors by id (a rename or a move does
 *     not change it);
 *   - a delete finds them by path — best effort: the path is the actor's,
 *     which equals the linker's only when the file is in the linker's own
 *     tree. A mirror the delete did not reach is caught by the next probe
 *     (404 → `spreadsheet_not_found`, status 'error', backoff; the copy
 *     stays readable);
 *   - a rename by the LINKER re-points `source.file.path` before the kick,
 *     because the new path is exactly the linker's view. A rename by anyone
 *     else is not trusted for the path (a shared folder is mounted under a
 *     different name in every account): the mirror is only marked stale,
 *     the pass answers 404 on the old path, and the owner re-points via
 *     relink. Identity by path is the v1 Nextcloud contract (there is no
 *     WebDAV search-by-fileid resolver yet).
 *
 * The event says the file changed; the pass decides what to do with it. A
 * stale mark makes the pass read the file even when the marker did not
 * move (mustFetch) — right for an event that names the file — and lets the
 * kick through when the last success was a moment ago (a pulse).
 *
 * ── ONEDRIVE ────────────────────────────────────────────────────────
 * A Graph drive subscription exists only when the linker has a routine
 * with a OneDrive `file.*` trigger, and its notification names no file
 * (it is about the drive). `onProviderHint` marks every mirror that account
 * linked at that provider stale and kicks it: the probe is one metadata
 * call and the download cache (60 s) absorbs the re-read of a file whose
 * cTag did not move. Best effort — the 5 s pulse and the 1-minute ticker
 * are the guarantees. Google Drive has no push at all (changes.watch needs
 * a verified domain); ticker and pulse only.
 *
 * Never throws. Runs behind the 202 the connector or Graph already got.
 */

'use strict';

const datatableStore = require('../../../../stores/datatableStore');
const { KIND } = require('./index');

const PROVIDER = 'nextcloud_files';
const FILE_EVENTS = new Set(['file.changed', 'file.new', 'file.deleted', 'file.renamed', 'file.restored', 'file.copied']);

/**
 * @param {{ orgId:string, event:string, payload:object, actorUserId?:string|null }} args
 *   `actorUserId` is the Bee Flow user the route already resolved from the
 *   event's `ncUid`; without it the payload's `actor` is resolved here.
 * @returns {Promise<{ kicked:number, moved:number }>}
 */
async function onFileEvent({ orgId, event, payload, actorUserId = null }) {
    const out = { kicked: 0, moved: 0 };
    if (!orgId || !FILE_EVENTS.has(event)) return out;
    const p = payload && typeof payload === 'object' ? payload : {};

    let mirrors = [];
    try { mirrors = await mirrorsOf(orgId, event, p); } catch { return out; }
    if (!mirrors.length) return out;

    const actor = event === 'file.renamed' ? await actorOf(orgId, p, actorUserId) : null;
    for (const mirror of mirrors) {
        try {
            if (actor && mirror.source && actor === mirror.source.linkedByUserId) {
                if (await repoint(mirror, p)) out.moved += 1;
            }
            await stale(mirror, 'event');
            out.kicked += 1;
        } catch { /* the ticker will */ }
    }
    return out;
}

/**
 * The mirrors an event is about, in the organisation it came from — by the
 * file id when the payload has one, by the path when it cannot (a delete),
 * and by the OLD path for a rename whose source node carried no id. One
 * entry per mirror.
 */
async function mirrorsOf(orgId, event, p) {
    const byId = new Map();
    const add = (list) => { for (const m of list || []) if (m && !byId.has(m.id)) byId.set(m.id, m); };
    const id = p.id !== null && p.id !== undefined && p.id !== '' ? String(p.id) : null;
    if (id) add(await datatableStore.listSourceMirrorsByRef(orgId, { kind: KIND, provider: PROVIDER, fileId: id }));
    if (event === 'file.deleted' && typeof p.path === 'string' && p.path) {
        add(await datatableStore.listSourceMirrorsByPath(orgId, { kind: KIND, provider: PROVIDER, path: p.path }));
    }
    if (event === 'file.renamed' && typeof p.oldPath === 'string' && p.oldPath) {
        add(await datatableStore.listSourceMirrorsByPath(orgId, { kind: KIND, provider: PROVIDER, path: p.oldPath }));
    }
    return [...byId.values()];
}

/** The Bee Flow user behind the event's actor, or null when unknown. */
async function actorOf(orgId, p, actorUserId) {
    if (actorUserId) return String(actorUserId);
    if (!p.actor) return null;
    try {
        const user = await require('../../../../stores/userStore').getUserByNcUid(orgId, String(p.actor));
        return user && user.id ? String(user.id) : null;
    } catch {
        return null;
    }
}

/**
 * A rename by the linker: the file block follows the new path and name.
 * The file id and its web link do not move on a rename, so only path and
 * name change. A path the file contract refuses (no leading slash) leaves
 * the block alone — the kick still happens, and the pass says what it finds.
 */
async function repoint(mirror, p) {
    if (typeof p.path !== 'string' || !p.path) return false;
    const source = mirror.source || {};
    const file = source.file || {};
    if (file.path === p.path) return false;
    let ref;
    try {
        ref = require('./reading').fileRefOf(PROVIDER, { path: p.path, name: p.name || null });
    } catch {
        return false;
    }
    await datatableStore.setSource(mirror.id, mirror.scope, {
        ...source,
        file: { ...file, path: ref.path, name: ref.name || file.name || null },
    });
    return true;
}

/** Mark the copy stale and refresh it in the background, now. */
async function stale(mirror, reason) {
    await datatableStore.markSourceStale(mirror.id, reason);
    const fresh = await datatableStore.getDatatable(mirror.id, mirror.scope);
    if (fresh) require('./sync').kickStale(fresh, { reason, delayMs: 0 });
}

/**
 * "Something changed in this account's drive" — every mirror that account
 * linked at that provider is probed.
 *
 * @param {{ provider:string, userId:string }} args
 * @returns {Promise<{ kicked:number }>}
 */
async function onProviderHint({ provider, userId }) {
    const out = { kicked: 0 };
    if (!provider || !userId) return out;
    let mirrors = [];
    try { mirrors = await datatableStore.listSourceMirrorsByLinker(String(userId), String(provider)); } catch { return out; }
    for (const mirror of mirrors) {
        if (!mirror || mirror.managedKind !== KIND) continue;
        try {
            await stale(mirror, 'event');
            out.kicked += 1;
        } catch { /* the ticker will */ }
    }
    return out;
}

module.exports = { onFileEvent, onProviderHint, FILE_EVENTS, PROVIDER };
