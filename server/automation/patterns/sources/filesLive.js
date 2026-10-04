// @typecheck
'use strict';
/**
 * Pattern source: files the user created or changed, read live at scan time.
 *
 * The SERVER picks every call and every argument:
 *   nextcloud     nextcloud_activity_list with filter 'self' (the user's own
 *                 actions only), capped at 200, file rows only, filtered to
 *                 the window here. Its `since` is an activity-id cursor, not a
 *                 time, so it is not used.
 *   onedrive      onedrive_list_recent since the window start, capped at 200,
 *                 without the files someone else changed last
 *   google_drive  drive_list_recent since the window start, capped at 200,
 *                 kept only where Drive says the user made the last change
 *
 * Each file becomes an event the moment it is read: the name turns into a
 * template (filenameStem) and the parent folder into an opaque key. Paths,
 * activity subjects (which name the actor), ids and links are never copied.
 * A file that appeared inside the window is `file.created`, an older file the
 * user worked on `file.changed`.
 */

const { makeEvent } = require('../events');
const { filenameStem } = require('../templating');
const { checkToolResult, throwIfAborted, toMs, inWindow, opaqueKey } = require('./common');

const NC_ACTIVITY_CAP = 200;
const RECENT_CAP = 200;

/** @typedef {import('./common').LiveCtx & { nextcloudUid?: string|null }} FilesCtx */

/**
 * @param {{ app: string, verb: 'file.created'|'file.changed', ts: number, name: any, folder: any }} f
 * @param {{ since: number, now: number }} win
 */
function fileEvent(f, win) {
    const name = String(f.name ?? '').trim();
    if (!name || !inWindow(f.ts, win)) return null;
    const folder = f.folder == null ? '' : String(f.folder).trim();
    return makeEvent({
        ts: f.ts,
        source: 'files',
        objectType: 'file',
        app: f.app,
        verb: f.verb,
        template: filenameStem(name),
        sessionKey: folder ? opaqueKey('folder', `${f.app}|${folder.toLowerCase()}`) : null,
    });
}

// Nextcloud reports a move, copy or rename INTO a folder as file_changed with
// that verb in the subject (EN and NL, the connector locales): for the folder
// it is a new file. Same reading as automation/triggerBus.js.
const ARRIVAL_SUBJECT_RE = /\b(?:moved|renamed|copied|restored|verplaatst|hernoemd|gekopieerd|teruggezet)\b/i;

/**
 * @param {any} type
 * @param {any} subject
 * @returns {'file.created'|'file.changed'|null}
 */
function classifyActivity(type, subject) {
    const t = String(type || '').toLowerCase();
    const s = String(subject || '').toLowerCase();
    if (t === 'file_created' || t === 'file_restored' || (t === 'files' && s.includes('created'))) return 'file.created';
    if ((t === 'file_changed' || t === 'files') && ARRIVAL_SUBJECT_RE.test(s)) return 'file.created';
    if (t === 'file_changed' || t === 'file_updated' || (t === 'files' && (s.includes('changed') || s.includes('updated')))) {
        return 'file.changed';
    }
    return null;
}

/** "/Reports/Week 41.xlsx" → { name: "Week 41.xlsx", folder: "/Reports" }; folders give null. */
function splitPath(path) {
    const p = String(path || '');
    if (!p || p.endsWith('/')) return null;
    const parts = p.split('/').filter(Boolean);
    const name = parts.pop() || '';
    // The activity feed sends files and folders alike; a name without an
    // extension is most likely a folder.
    if (!/\.[\p{L}\p{N}]{1,8}$/u.test(name)) return null;
    return { name, folder: `/${parts.join('/')}` };
}

/**
 * @param {FilesCtx} ctx
 * @returns {Promise<import('../events').WorkEvent[]>}
 */
async function collectNextcloudFiles(ctx) {
    throwIfAborted(ctx.signal);
    const res = checkToolResult(
        await ctx.executeTool('nextcloud_activity_list', { filter: 'self', limit: NC_ACTIVITY_CAP }), 'nextcloud_activity_list');
    const out = [];
    for (const a of res.activities || []) {
        if (String(a?.objectType || '').toLowerCase() !== 'files') continue;
        // 'self' already means "my own actions"; when the caller knows the
        // Nextcloud uid, a row by anyone else is dropped as well.
        if (ctx.nextcloudUid && a.actor && a.actor !== ctx.nextcloudUid) continue;
        const verb = classifyActivity(a.type, a.subject);
        const file = verb ? splitPath(a.objectName) : null;
        if (!verb || !file) continue;
        const ev = fileEvent({ app: 'nextcloud', verb, ts: toMs(a.datetime), name: file.name, folder: file.folder }, ctx);
        if (ev) out.push(ev);
    }
    return out;
}

/**
 * Created inside the window → created then; otherwise changed at its last
 * modification.
 * @returns {{ verb: 'file.created'|'file.changed', ts: number }}
 */
function createdOrChanged(created, modified, since, mayBeNew = true) {
    if (mayBeNew && Number.isFinite(created) && created >= since) return { verb: 'file.created', ts: created };
    return { verb: 'file.changed', ts: modified };
}

/**
 * @param {FilesCtx} ctx
 * @returns {Promise<import('../events').WorkEvent[]>}
 */
async function collectOneDrive(ctx) {
    throwIfAborted(ctx.signal);
    const res = checkToolResult(await ctx.executeTool('onedrive_list_recent', {
        since: new Date(ctx.since).toISOString(), maxResults: RECENT_CAP,
    }), 'onedrive_list_recent');
    const out = [];
    for (const it of res.items || []) {
        // A colleague's edit in the user's drive is not the user's work. Only
        // a known "no" drops an item: unknown (no /me answer) is kept.
        if (it?.modifiedByMe === false) continue;
        const { verb, ts } = createdOrChanged(toMs(it?.created), toMs(it?.lastModified), ctx.since);
        const ev = fileEvent({ app: 'onedrive', verb, ts, name: it?.name, folder: it?.parentId || it?.parentPath }, ctx);
        if (ev) out.push(ev);
    }
    return out;
}

/**
 * @param {FilesCtx} ctx
 * @returns {Promise<import('../events').WorkEvent[]>}
 */
async function collectGoogleDrive(ctx) {
    throwIfAborted(ctx.signal);
    const res = checkToolResult(await ctx.executeTool('drive_list_recent', {
        since: new Date(ctx.since).toISOString(), maxResults: RECENT_CAP,
    }), 'drive_list_recent');
    const out = [];
    for (const f of res.results || []) {
        // Someone else's edit to a shared file is not the user's work.
        if (f?.modifiedByMe !== true) continue;
        const { verb, ts } = createdOrChanged(toMs(f.createdTime), toMs(f.modifiedTime), ctx.since, f.ownedByMe === true);
        const ev = fileEvent({ app: 'google_drive', verb, ts, name: f.name, folder: f.parentId }, ctx);
        if (ev) out.push(ev);
    }
    return out;
}

module.exports = { collectNextcloudFiles, collectOneDrive, collectGoogleDrive, classifyActivity, splitPath };
