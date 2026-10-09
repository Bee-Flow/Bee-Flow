#!/usr/bin/env node
/**
 * Dutch for keys that still read English in a Dutch workspace (2026-10).
 *
 * Twelve keys were shipped by an earlier catalogue as the English text itself ("Solutions" for the Studio
 * rail, "Secret key", "Webpages", ...): their sameAsEnglish list was too generous, and because every add-nl
 * catalogue only fills MISSING keys, the later Dutch ("Oplossingen") never replaced them. Six compliance keys
 * had no Dutch in any catalogue.
 *
 * This migration sets the Dutch when the stored value is missing OR still equals the English default: a
 * workspace that curated its own wording for one of these keys keeps it. The data is in
 * data/fix-english-2026-10-nl.json. Idempotent. Auto-runs from server boot (boot/bootMigrations.js).
 * Manual usage: node server/migrations/add-nl-fix-english-2026-10-translations.js
 */

const path = require('node:path');

const DATA = require(path.join(__dirname, 'data', 'fix-english-2026-10-nl.json'));

/** sha256 of data/fix-english-2026-10-nl.json: a data change is a change to this file, so the boot ledger re-runs it. */
const DATA_SHA256 = '70deb4310cd3766f2483938903abb5d999527b65474bbfbab0233b1088b95843';

/** Exported under its own name: these keys are owned by other catalogues; this one only corrects their value. */
const NL_FIXES = Object.freeze({ ...DATA.translations });

/**
 * The mutation itself, on a copy of the 'nl' blob. Pure, so the store's mutator may run it more than once.
 * `english`: the English defaults (a stored value equal to its English default is a shipped value, not a choice).
 */
function applyNl(merged, english) {
    let changed = 0;
    for (const [key, value] of Object.entries(NL_FIXES)) {
        const current = merged[key];
        if (current === value) continue;
        if (!current || current === english[key]) {
            merged[key] = value;
            changed++;
        }
    }
    return { merged, changed };
}

async function up() {
    const languageStore = require('../stores/languageStore');
    const { GUI_DEFAULTS } = require('../i18n/defaults/en');
    let changed = 0;
    await languageStore.mutateGUITranslations('nl', (current) => {
        const result = applyNl(current, GUI_DEFAULTS);
        changed = result.changed;
        return result.merged;
    });
    if (changed > 0) {
        console.log(`[Migration] add-nl-fix-english-2026-10-translations applied (${changed} keys set)`);
    }
    return { changed };
}

module.exports = { up, applyNl, NL_FIXES, DATA_SHA256 };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
