#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for the AI Act register's "Removed" filter (Compliance Center → AI Act
 * → per automation): the Current / Removed switch, the "In trash" tag and the
 * names a row shows when its automation or agent no longer exists.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. Auto-runs from server boot (boot/bootMigrations.js).
 * Manual usage:
 *   node server/migrations/add-nl-ai-act-register-2026-11-translations.js
 */

const NL_TRANSLATIONS = Object.freeze({
    'compliance.fw_pa_view_aria': 'Welke beoordelingen je ziet',
    'compliance.fw_pa_view_current': 'Actueel',
    'compliance.fw_pa_view_removed': 'Verwijderd',
    'compliance.fw_pa_untitled': 'Naamloos',
    'compliance.fw_pa_deleted_automation': 'Verwijderde automatisering',
    'compliance.fw_pa_deleted_agent': 'Verwijderde agent',
    'compliance.fw_pa_state_trashed': 'In prullenbak',
});

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomic across replicas (advisory lock in mutateConfig); existing values
    // win, only missing keys are added.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-ai-act-register-2026-11-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-ai-act-register-2026-11-translations failed:', e.message);
        process.exit(1);
    });
}
