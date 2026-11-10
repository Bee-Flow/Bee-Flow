#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for the automation wording round (Nov 2026). Six English texts say
 * plainly what happens:
 *   - "Change it right away": what undo covers, and that a table the assistant
 *     creates stays (builderTools/datatableCreate.js: a side effect outside the draft).
 *   - "Run live (test, real actions)" is "Run for real (sends and writes)",
 *     the words its own confirm dialog uses.
 *   - The row menu says "View runs" and "Export", not "View executions" and
 *     "Export JSON".
 *   - The dialog that moves an automation to the trash asks exactly that.
 *   - "personal data found" also says what was done with it: the scan masks
 *     it before the model sees a pattern (automation/patterns/templating.js).
 *
 * NL_REWORDED: replaced only while a workspace still has the OLD shipped Dutch
 * (`was`), so an admin's own wording stays. The catalogues that shipped it are
 * unchanged files, so the boot ledger would not re-run them; the new Dutch
 * reaches existing and new installs from here. Idempotent. Auto-runs from
 * server boot (boot/bootMigrations.js). Manual:
 *   node server/migrations/update-nl-automation-wording-2026-11.js
 */

/** @type {Readonly<Record<string, { was: string[], now: string }>>} */
const NL_REWORDED = Object.freeze({
    'automations.assistant.mode.right_away_hint': {
        was: ['Voert de wijzigingen meteen door. Je kunt ze ongedaan maken.'],
        now: 'Past de stappen meteen aan. Dat kun je ongedaan maken. Een tabel die hij aanmaakt blijft bestaan.',
    },
    'automation_testing.header.run_live': {
        was: ['Echt draaien (test, echte acties)'],
        now: 'Echt draaien (verstuurt en schrijft weg)',
    },
    'studio_misc.menu.view_runs': {
        was: ['Uitvoeringen bekijken'],
        now: 'Runs bekijken',
    },
    'studio_misc.menu.export_json': {
        was: ['JSON exporteren'],
        now: 'Exporteren',
    },
    'automations.library.deleteTitle': {
        was: ['"{title}" verwijderen?'],
        now: '"{title}" naar de prullenbak?',
    },
    'automations.repeating.personalData': {
        was: ['persoonsgegevens gevonden: {categories}'],
        now: 'persoonsgegevens gevonden ({categories}); afgeschermd voordat de AI ze zag',
    },
});

/**
 * The mutation itself, on a copy of the 'nl' blob. Pure, so the store's mutator may run it more than once.
 * @param {Record<string, string>} merged
 */
function applyNl(merged) {
    let reworded = 0;
    for (const [key, { was, now }] of Object.entries(NL_REWORDED)) {
        // Missing -> write the current text; still the old shipped text ->
        // replace; anything else is the workspace's own wording and stays.
        if (!merged[key] || was.includes(merged[key])) {
            if (merged[key] !== now) reworded++;
            merged[key] = now;
        }
    }
    return { merged, reworded };
}

async function up() {
    const languageStore = require('../stores/languageStore');
    let reworded = 0;
    await languageStore.mutateGUITranslations('nl', (/** @type {Record<string, string>} */ current) => {
        const result = applyNl(current);
        reworded = result.reworded;
        return result.merged;
    });
    if (reworded > 0) {
        console.log(`[Migration] update-nl-automation-wording-2026-11 applied (${reworded} reworded)`);
    }
    return { reworded };
}

module.exports = { up, applyNl, NL_REWORDED };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
