// @typecheck strict
/**
 * The store schemas of the module "meetingNotes" (part of
 * firstParty/meetingNotes.js, see modules/firstParty/parts.js). The rows were
 * the module's entries of storeModules.js STORE_MODULES; their order stays the
 * core's (modules/firstParty/order.json).
 */

'use strict';

/** @type {import('../modules/firstParty/contract').StoreRow[]} */
const stores = [
    { name: 'transcriptionStore', file: './stores/transcriptionStore' },
    { name: 'teamsImportStore', file: './stores/teamsImportStore' },
    { name: 'gmeetImportStore', file: './stores/gmeetImportStore' },
    // meeting_prefs (M5): the per-meeting recording choice. Alongside its
    // DDL it also carries the one-off backfill from the old exclusion lists, so it belongs
    // AFTER configStore — it reads from that for this.
    { name: 'meetingPrefsStore', file: './stores/meetingPrefsStore' },
    { name: 'summaryTemplateStore', file: './stores/summaryTemplateStore' },
];

module.exports = { stores };
