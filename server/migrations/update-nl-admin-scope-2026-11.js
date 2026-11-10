#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for the admin dashboard scope labels (Nov 2026). Every admin section
 * now says whether it is about the whole server, one organisation, or the
 * viewer's own account (chip in the dashboard shell), and three texts that
 * named the wrong scope were corrected:
 *   - the Look editor says the look is what everyone on this server sees;
 *   - the integration defaults are copied into organisations created in the
 *     admin and followed live by organisations without a list of their own
 *     (core/integrations/enabledIntegrations.js).
 *
 * NL_TRANSLATIONS: keys this work added; written when a workspace does not
 * have them yet, so a workspace's own wording is kept.
 * NL_REWORDED: replaced only while a workspace still has the OLD shipped
 * Dutch (`was`), so an admin's own wording stays. The catalogue that shipped it
 * (hardcoded-integrations-agents-2026-10, a data file) is unchanged, so the boot
 * ledger would not re-run it; the new Dutch reaches existing and new installs
 * from here. Idempotent. Auto-runs from server boot (boot/bootMigrations.js).
 * Manual:
 *   node server/migrations/update-nl-admin-scope-2026-11.js
 */

/** @type {Readonly<Record<string, string>>} */
const NL_TRANSLATIONS = Object.freeze({
    'admin.scope_instance': 'Hele server',
    'admin.scope_instance_hint': 'Geldt voor alle organisaties op deze server',
    'admin.scope_org': 'Jouw organisatie',
    'admin.scope_org_named': 'Organisatie: {name}',
    'admin.scope_org_hint': 'Geldt alleen voor jouw organisatie',
    'admin.scope_org_view_hint': 'Toont alleen jouw organisatie',
    'admin.scope_all_orgs': 'Alle organisaties',
    'admin.scope_all_orgs_hint': 'Toont alle organisaties op deze server',
    'admin.scope_your_orgs': 'Jouw organisaties',
    'admin.scope_your_orgs_hint': 'Toont de organisaties waartoe je behoort',
    'admin.scope_user': 'Persoonlijk',
    'admin.scope_user_hint': 'Geldt alleen voor je eigen account',
});

/** @type {Readonly<Record<string, { was: string[], now: string }>>} */
const NL_REWORDED = Object.freeze({
    'appearance.look_editor_set_the_look_that_everyone_in_your': {
        was: ['Stel het uiterlijk in dat iedereen in je organisatie standaard ziet. Wijzigingen verschijnen direct in het voorbeeld rechts.'],
        now: 'Stel het uiterlijk in dat iedereen op deze server standaard ziet. Wijzigingen verschijnen direct in het voorbeeld rechts.',
    },
    'integ.global_defaults_default_integrations_for_new': {
        was: ['Standaardintegraties voor nieuwe organisaties. Wijzigingen hier hebben geen invloed op bestaande organisaties.'],
        now: 'Nieuwe organisaties starten met een kopie hiervan. Een organisatie zonder eigen lijst volgt deze direct, ook bestaande.',
    },
    'integ.global_defaults_the_defaults_above_only_seed': {
        was: ['. De standaarden hierboven zetten alleen integraties klaar voor nieuw aangemaakte organisaties.'],
        now: '. Nieuwe organisaties starten met een kopie van de standaarden hierboven; een organisatie zonder eigen integratielijst volgt ze direct, ook bestaande.',
    },
});

/**
 * The mutation itself, on a copy of the 'nl' blob. Pure, so the store's mutator may run it more than once.
 * @param {Record<string, string>} merged
 */
function applyNl(merged) {
    let added = 0;
    let reworded = 0;
    for (const [key, value] of Object.entries(NL_TRANSLATIONS)) {
        if (!merged[key]) {
            merged[key] = value;
            added++;
        }
    }
    for (const [key, { was, now }] of Object.entries(NL_REWORDED)) {
        // Missing -> write the current text; still the old shipped text ->
        // replace; anything else is the workspace's own wording and stays.
        if (!merged[key] || was.includes(merged[key])) {
            if (merged[key] !== now) reworded++;
            merged[key] = now;
        }
    }
    return { merged, added, reworded };
}

async function up() {
    const languageStore = require('../stores/languageStore');
    let added = 0;
    let reworded = 0;
    await languageStore.mutateGUITranslations('nl', (/** @type {Record<string, string>} */ current) => {
        const result = applyNl(current);
        added = result.added;
        reworded = result.reworded;
        return result.merged;
    });
    if (added > 0 || reworded > 0) {
        console.log(`[Migration] update-nl-admin-scope-2026-11 applied (+${added} keys, ${reworded} reworded)`);
    }
    return { added, reworded };
}

module.exports = { up, applyNl, NL_TRANSLATIONS, NL_REWORDED };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
