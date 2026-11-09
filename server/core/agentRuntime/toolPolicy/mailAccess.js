// @typecheck strict
/**
 * THE MAILBOX PRESET: `config.tools.<gmail|outlook>.mailAccess`.
 *
 *   read        every tool of the app that only reads
 *   draft       read + the app's create-draft tool (the person sends it themselves)
 *   send_reply  draft + the app's reply-in-thread tool (an answer in the SAME thread
 *               as the mail that started a mail-triggered run, never a new address)
 *
 * It RESOLVES to an `actions` list, so the grant readers (`isToolAllowed`) and the
 * picker see ordinary actions; this file is the one place that knows which names a
 * level means. An unreadable level is the narrow reading (`read`), never "everything".
 */

'use strict';

const { effectOf } = require('../../automationModel/sideEffectMap');
const { _plainObject, MAIL_ACCESS_LEVELS } = require('./configShape');
const { actionsOfApp } = require('./appIndex');

/** appId → the two tools above `read`. */
const MAIL_APPS = Object.freeze({
    gmail: Object.freeze({ draft: 'gmail_create_draft', reply: 'gmail_reply_in_thread' }),
    outlook: Object.freeze({ draft: 'outlook_create_draft', reply: 'outlook_reply_in_thread' }),
});

/** The reply-in-thread tool names (the only sends a mail-triggered run may make unattended). */
/** @type {readonly string[]} */
const REPLY_IN_THREAD_TOOLS = Object.freeze(Object.values(MAIL_APPS).map(a => a.reply));

/** @param {string} appId */
function isMailApp(appId) {
    return typeof appId === 'string' && Object.prototype.hasOwnProperty.call(MAIL_APPS, appId);
}

/**
 * The stored level of an app entry: a valid level, 'read' for an unreadable one on a mail app, or
 * null when the entry has no `mailAccess` (or the app is not a mail app).
 * @param {string} appId
 * @param {unknown} entry
 * @returns {'read' | 'draft' | 'send_reply' | null}
 */
function mailAccessOf(appId, entry) {
    if (!isMailApp(appId) || !_plainObject(entry)) return null;
    const v = /** @type {Record<string, unknown>} */ (entry).mailAccess;
    if (v === undefined || v === null) return null;
    return MAIL_ACCESS_LEVELS.includes(/** @type {string} */ (v)) ? /** @type {'read' | 'draft' | 'send_reply'} */ (v) : 'read';
}

/**
 * The action names a level grants for a mail app.
 * @param {string} appId
 * @param {string} level
 * @returns {string[]}
 */
function actionsForMailAccess(appId, level) {
    if (!isMailApp(appId)) return [];
    const names = MAIL_APPS[/** @type {'gmail' | 'outlook'} */ (appId)];
    const reads = actionsOfApp(appId).filter((/** @type {string} */ a) => effectOf(a) === 'reads');
    if (level === 'draft') return [...reads, names.draft];
    if (level === 'send_reply') return [...reads, names.draft, names.reply];
    return reads;
}

module.exports = { MAIL_APPS, REPLY_IN_THREAD_TOOLS, isMailApp, mailAccessOf, actionsForMailAccess };
