#!/usr/bin/env node
/**
 * One-time migration: carry the stored translations along when the "routine"
 * keys became "automation" keys (routines.* → automations.*, routine_editor.*
 * → automation_editor.*, and every key elsewhere with a routine segment), and
 * say "automatisering" where the Dutch said "routine".
 *
 * Every locale's GUI blob (i18n_gui_<code>) is visited:
 *   - a key whose renamed form exists in the English dictionary moves there,
 *     unless the blob already holds the new key (a catalogue or an admin got
 *     there first, and that value wins); the old key is removed either way;
 *   - the keys of the agent builder's schedules panel go to agent_schedules.*
 *     instead (data/agent-schedules-key-map.json): that panel is Cowork now;
 *   - Dutch only: a value is reworded routine → automatisering ONLY while it is
 *     still exactly what a catalogue shipped (data/routine-nl-shipped.json).
 *     Wording a workspace curated itself is left as it is.
 *
 * Runs after every Dutch catalogue (the ladder is sequential), so on a fresh
 * install the catalogues have already seeded the new keys and this finds
 * nothing to do. Idempotent: a second run finds no old key and no shipped
 * routine wording left.
 *
 * Usage:  node server/migrations/rename-routine-i18n-2026-10.js
 */

const SHIPPED_NL = require('./data/routine-nl-shipped.json');
const PANEL_KEYS = require('./data/agent-schedules-key-map.json');

/** The key a stored key has now, the same mapping the code rename used. */
function renameKey(key) {
    if (Object.prototype.hasOwnProperty.call(PANEL_KEYS, key)) return PANEL_KEYS[key];
    return key
        .replace(/(?<![A-Z])Routine(s?)(?![a-z])/g, 'Automation$1')
        .replace(/(?<![A-Za-z])routine(s?)(?![a-z])/g, 'automation$1');
}

/** Dutch wording: the same rules the catalogues were rewritten with. */
function rewordNl(value) {
    return String(value)
        .replace(/routine-bouwer/g, 'automatiseringsbouwer')
        .replace(/Routine-uitvoering/g, 'Uitvoering van de automatisering')
        .replace(/(?<![A-Za-z])Routines(?![a-z])/g, 'Automatiseringen')
        .replace(/(?<![A-Za-z])routines(?![a-z])/g, 'automatiseringen')
        .replace(/(?<![A-Za-z])Routine(?![a-z])/g, 'Automatisering')
        .replace(/(?<![A-Za-z])routine(?![a-z])/g, 'automatisering');
}

/**
 * The blob after the rename. Pure, so the test pins it without a database.
 * @param {Record<string, string>} blob
 * @param {{ locale: string, english: Record<string, string> }} opts
 */
function renameBlob(blob, { locale, english }) {
    const out = { ...blob };
    let moved = 0;
    let reworded = 0;
    for (const [key, value] of Object.entries(blob)) {
        const shipped = locale === 'nl' && Object.prototype.hasOwnProperty.call(SHIPPED_NL, key) && SHIPPED_NL[key] === value;
        const next = renameKey(key);
        if (next !== key) {
            delete out[key];
            if (Object.prototype.hasOwnProperty.call(english, next) && !out[next]) {
                out[next] = shipped ? rewordNl(value) : value;
                moved += 1;
            }
        } else if (shipped && /routine/i.test(String(value))) {
            out[key] = rewordNl(value);
            reworded += 1;
        }
    }
    return { blob: out, moved, reworded };
}

async function up() {
    const languageStore = require('../stores/languageStore');
    const { GUI_DEFAULTS } = require('../i18n/defaults/en');
    const locales = await languageStore.getAvailableLocales();
    const summary = {};
    for (const { code } of locales) {
        if (!code) continue;
        let counts = { moved: 0, reworded: 0 };
        await languageStore.mutateGUITranslations(code, (current) => {
            const r = renameBlob(current, { locale: code, english: GUI_DEFAULTS });
            counts = { moved: r.moved, reworded: r.reworded };
            return r.blob;
        });
        if (counts.moved || counts.reworded) summary[code] = counts;
    }
    if (Object.keys(summary).length) {
        console.log(`[Migration] rename-routine-i18n-2026-10 applied: ${JSON.stringify(summary)}`);
    }
    return summary;
}

module.exports = { up, renameKey, rewordNl, renameBlob };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error('Migration failed:', err);
        process.exit(1);
    });
}
