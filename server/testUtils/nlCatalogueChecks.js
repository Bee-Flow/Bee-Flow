// @typecheck
/**
 * The rules every Dutch catalogue (migrations/add-nl-*) answers to, as one
 * suite a catalogue's own test file registers. They pin the silent failures
 * of a catalogue: a Dutch key that matches no English key (stored, never
 * read), an English key with no Dutch (one English sentence in a Dutch
 * workspace), an English value copied over as "Dutch", a placeholder that got
 * lost or renamed on the way (the sentence then shows a raw "{actor}" or
 * drops the name), two catalogues seeding the same key (whichever runs first
 * wins, so an edit to the other one silently never shows), and a catalogue
 * that is written but never registered in the boot ladder.
 *
 * Nothing here reaches into the module system: the catalogue's up() takes the
 * language store as a parameter, and the suite hands it a recorder.
 */

const test = require('node:test');
const assert = require('node:assert');

const { GUI_DEFAULTS } = require('../i18n/defaults/en');

/**
 * @typedef {object} NlCatalogue
 * @property {Readonly<Record<string, string>>} NL_TRANSLATIONS
 * @property {readonly string[]} SAME_AS_ENGLISH
 * @property {(deps?: { languageStore?: { addMissingGUITranslations: (locale: string, translations: Record<string, string>) => Promise<{ added: number }> } }) => Promise<{ added: number }>} up
 */

/** The `{name}` placeholders of a string, sorted, so two strings can be compared. */
const holes = (/** @type {unknown} */ s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();

/**
 * Registers the suite for one catalogue.
 *
 * @param {object} o
 * @param {string} o.name  the migration's name, as boot/bootMigrations.js lists it
 * @param {NlCatalogue} o.catalogue  the required migration module
 * @param {readonly string[]} o.mayHold  key prefixes the catalogue may hold keys from
 * @param {readonly string[]} o.mustCover  key prefixes where EVERY English key needs Dutch
 *   here: the families the catalogue owns outright, so a key added to them later without
 *   Dutch turns this red instead of reaching Dutch screens in English
 * @param {Record<string, string>} o.declaredFor  each SAME_AS_ENGLISH key with the English
 *   it was declared identical for
 */
function registerNlCatalogueChecks({ name, catalogue, mayHold, mustCover, declaredFor }) {
    const { NL_TRANSLATIONS, SAME_AS_ENGLISH } = catalogue;
    const keys = [...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH];
    const startsWithAny = (/** @type {string} */ k, /** @type {readonly string[]} */ prefixes) => prefixes.some((p) => k.startsWith(p));

    test(`${name}: every Dutch key exists in the English catalog`, () => {
        const orphans = keys.filter((k) => !(k in GUI_DEFAULTS));
        assert.deepStrictEqual(orphans, [], 'these Dutch keys have no English counterpart (removed or renamed?)');
    });

    test(`${name}: the catalogue only holds keys from its own namespaces`, () => {
        const strays = keys.filter((k) => !startsWithAny(k, mayHold));
        assert.deepStrictEqual(strays, [], 'move the key to the catalogue that owns its namespace');
    });

    test(`${name}: every English key of a family it owns has Dutch, or is declared identical`, () => {
        const covered = new Set(keys);
        const untranslated = Object.keys(GUI_DEFAULTS).filter((k) => startsWithAny(k, mustCover) && !covered.has(k));
        assert.deepStrictEqual(untranslated, []);
    });

    test(`${name}: no Dutch value is blank or the English copied over, and no key is both`, () => {
        for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
            assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
            assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k}: identical to English; move it to SAME_AS_ENGLISH if that is deliberate`);
        }
        assert.deepStrictEqual(SAME_AS_ENGLISH.filter((k) => k in NL_TRANSLATIONS), []);
        assert.strictEqual(new Set(SAME_AS_ENGLISH).size, SAME_AS_ENGLISH.length, 'SAME_AS_ENGLISH lists a key twice');
    });

    test(`${name}: a key declared identical still has the English it was declared for`, () => {
        // SAME_AS_ENGLISH keys are not seeded, so a Dutch reader sees the
        // English. That is only right while the English is the word Dutch
        // uses too; a reworded English string would otherwise reach Dutch
        // screens unnoticed.
        assert.deepStrictEqual([...SAME_AS_ENGLISH].sort(), Object.keys(declaredFor).sort());
        for (const k of SAME_AS_ENGLISH) {
            assert.strictEqual(GUI_DEFAULTS[k], declaredFor[k], `${k}: the English changed; translate it instead of declaring it identical`);
        }
    });

    test(`${name}: placeholders survive translation exactly`, () => {
        for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
            assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
        }
    });

    test(`${name}: no dashes are used as punctuation`, () => {
        for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
            assert.ok(!/[–—]/.test(v), `${k} (nl) uses a dash`);
        }
    });

    test(`${name}: no key is also claimed by another registered catalogue`, () => {
        // Requiring a registered catalogue is side-effect free (the boot
        // ladder test pins that). The few older ones that do not export
        // their table cannot be compared and are skipped.
        const { NL_TRANSLATIONS: bootList } = require('../boot/bootMigrations');
        for (const other of bootList.filter((/** @type {string} */ n) => n !== name)) {
            const mod = require(`../migrations/${other}`);
            if (!mod.NL_TRANSLATIONS) continue;
            const theirs = new Set([...Object.keys(mod.NL_TRANSLATIONS), ...(mod.SAME_AS_ENGLISH || [])]);
            assert.deepStrictEqual(keys.filter((k) => theirs.has(k)), [], `these keys are also in ${other}`);
        }
    });

    test(`${name}: up() seeds exactly this catalogue into the Dutch strings, never the identical ones`, async () => {
        /** @type {{ locale: string, translations: Record<string, string> }[]} */
        const calls = [];
        const languageStore = {
            addMissingGUITranslations: async (/** @type {string} */ locale, /** @type {Record<string, string>} */ translations) => {
                calls.push({ locale, translations });
                return { added: 0 };
            },
        };
        assert.deepStrictEqual(await catalogue.up({ languageStore }), { added: 0 });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].locale, 'nl');
        assert.deepStrictEqual({ ...calls[0].translations }, { ...NL_TRANSLATIONS });
        assert.ok(SAME_AS_ENGLISH.every((k) => !(k in calls[0].translations)));
    });

    test(`${name}: the migration is registered, or it never runs`, () => {
        const { NL_TRANSLATIONS: bootList } = require('../boot/bootMigrations');
        assert.ok(bootList.includes(name), 'add it to the NL_TRANSLATIONS list in boot/bootMigrations.js');
    });
}

module.exports = { registerNlCatalogueChecks };
