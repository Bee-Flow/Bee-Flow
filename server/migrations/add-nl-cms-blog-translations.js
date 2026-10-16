#!/usr/bin/env node
/**
 * Dutch for the website blog (cms_blog.*): the Blog entry of the product
 * website editor (post list, post inspector, Markdown toolbar, blog page
 * settings, the "Latest posts" block editor) and the VISITOR-facing labels of
 * the public blog (cms_blog.public.*), which the server sends with every
 * /nl/blog page (stores/cms/blogEffective.js blogLabels).
 *
 * The Dutch itself is in data/cms-blog-nl.json. SAME_AS_ENGLISH lists keys
 * whose Dutch is the English word itself; they are not seeded.
 *
 * Idempotent: only fills keys that are missing. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-cms-blog-translations.js
 */

const path = require('node:path');

const DATA = require(path.join(__dirname, 'data', 'cms-blog-nl.json'));

/**
 * sha256 of data/cms-blog-nl.json. The boot ledger re-runs a
 * migration when THIS FILE's checksum changes and knows nothing about the data
 * file, so pinning the hash here makes every data change a change to this file.
 */
const DATA_SHA256 = 'ff35cb3dea54438a71c2dedb649f16b33d35abc07a85129a5357ddecc587c826';

const NL_TRANSLATIONS = Object.freeze({ ...DATA.translations });

/** Keys whose Dutch is the English text itself; deliberately not seeded. */
const SAME_AS_ENGLISH = Object.freeze([...DATA.sameAsEnglish]);

/** The mutation itself, on a copy of the 'nl' blob. Pure, so the store's mutator may run it more than once. */
function applyNl(merged) {
    let added = 0;
    for (const [key, value] of Object.entries(NL_TRANSLATIONS)) {
        if (!merged[key]) {
            merged[key] = value;
            added++;
        }
    }
    return { merged, added };
}

async function up() {
    const languageStore = require('../stores/languageStore');
    let added = 0;
    await languageStore.mutateGUITranslations('nl', (current) => {
        const result = applyNl(current);
        added = result.added;
        return result.merged;
    });
    if (added > 0) {
        console.log(`[Migration] add-nl-cms-blog-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, applyNl, NL_TRANSLATIONS, SAME_AS_ENGLISH, DATA_SHA256 };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
