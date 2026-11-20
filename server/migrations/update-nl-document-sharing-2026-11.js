#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for the sharing dialog of a document (Nov 2026). The dialog now lets
 * the owner choose whether recipients only read a document or also edit its
 * content, and says that sharing, type, folder and deleting stay the owner's.
 * The Dutch that add-nl-document-sharing-translations shipped still said that
 * recipients can only read it.
 *
 * The other sharing keys of that catalogue still say what the English says.
 *
 * NL_REWORDED: replaced only while a workspace still has the OLD shipped Dutch
 * (`was`), so an admin's own wording stays. Idempotent. Auto-runs from server
 * boot (boot/bootMigrations.js). Manual:
 *   node server/migrations/update-nl-document-sharing-2026-11.js
 */

/** @type {Readonly<Record<string, { was: string[], now: string }>>} */
const NL_REWORDED = Object.freeze({
    'documents.sharing.read_access': {
        was: ['Ontvangers kunnen dit document lezen. Bestaande bewerkrechten via projecten blijven gelden.'],
        now: 'Kies of ontvangers dit document alleen kunnen lezen of ook de inhoud mogen bewerken. Alleen jij kunt het delen, het type of de map wijzigen, of het verwijderen.',
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
        console.log(`[Migration] update-nl-document-sharing-2026-11 applied (${reworded} reworded)`);
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
