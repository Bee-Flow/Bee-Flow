#!/usr/bin/env node
/**
 * Dutch for the Compliance Center redesign (2026-09-14): the 300 px rail, the
 * section headers and their tabs, the overview cards, the check table, the
 * DSR/SoA registers and drawers, the frameworks page and its regulatory
 * calendar, the AI Act ladder, the inline setup, the phone frame, and the
 * titles/descriptions/fixes of every check the seven new frameworks bring.
 *
 * The design (the `Compliance` artboards) was written IN DUTCH; the English
 * catalogue is its paraphrase. So the artboard word is the source of truth
 * here — "Vraagt aandacht", "Termijnen", "Bewijsketen intact · 2.053 rijen ·
 * SHA-256", "Afhandelen en betrokkene mailen", "zelf verklaard", "Kaders" —
 * and the Dutch for the check copy was written by the stream that wrote the
 * check.
 *
 * DATA-DRIVEN, ON PURPOSE. Twenty-odd parallel streams each dropped their keys
 * in `.claude/handoff/compliance/keys/<stream>.json` as `{ en, nl }`;
 * `server/scripts/mergeComplianceKeys.mjs` folds the English into both
 * dictionaries and writes the Dutch to `migrations/data/compliance-center-nl.json`.
 * This file reads that map, so re-running the merge after a late stream
 * never means editing a second copy by hand. The test beside it holds the map
 * to the same rules as every hand-written catalogue.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-compliance-center-translations.js
 */
const fs = require('fs');
const path = require('path');

const MAP_PATH = path.join(__dirname, 'data', 'compliance-center-nl.json');

function loadMap() {
    try { return JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')); }
    catch (e) {
        console.warn(`[Migration] add-nl-compliance-center-translations: no NL map at ${MAP_PATH} (${e.message}) — nothing to seed`);
        return {};
    }
}

/**
 * Keys whose Dutch IS the English word — proper names and terms the product
 * already writes the same in Dutch sentences (NIS2, CRA, DORA, SoA, DPO,
 * Status, Export, Controls, Registers, Checks). Listed so the test can tell
 * "identical because it is the same word" from "identical because nobody
 * translated it".
 */
const SAME_AS_ENGLISH = Object.freeze(Object.entries(loadMap())
    .filter(([, v]) => typeof v === 'string')
    .map(([k]) => k)
    .filter((k) => {
        const map = loadMap();
        const en = require('../i18n/defaults/en').GUI_DEFAULTS[k];
        return en !== undefined && map[k] === en;
    }));

// The seeded translations: every mapped key whose Dutch differs from the English.
const NL_TRANSLATIONS = Object.freeze(Object.fromEntries(
    Object.entries(loadMap()).filter(([k, v]) => typeof v === 'string' && v.trim() && !SAME_AS_ENGLISH.includes(k)),
));

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomic across replicas (advisory lock in mutateConfig); existing values
    // win — only missing keys are added.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-compliance-center-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS, SAME_AS_ENGLISH, MAP_PATH };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-compliance-center-translations failed:', e.message);
        process.exit(1);
    });
}
