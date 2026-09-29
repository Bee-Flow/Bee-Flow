#!/usr/bin/env node
/**
 * Dutch for the chat's activity card (2026-09-19): the numbered timeline
 * above an answer that shows what the assistant did — the same shape the
 * routine and app builders show while they build, now in the ordinary chat.
 *
 * Four keys: the header while the turn runs ("Bezig"), the count of calls
 * the guard or the tool refused, and the two labels behind a row's chevron.
 * The finished header reuses `chat.msg.tools_used`, which already has its
 * Dutch; the rows themselves are named by the tool's own label.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-chat-activity-translations.js
 */

const NL_TRANSLATIONS = {
    'chat.act.working': 'Bezig',
    'chat.act.failed_count': '{n} mislukt',
    'chat.act.input': 'Invoer',
    'chat.act.result': 'Resultaat',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-chat-activity-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-chat-activity-translations failed:', e.message);
        process.exit(1);
    });
}
