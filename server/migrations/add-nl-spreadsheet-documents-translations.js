#!/usr/bin/env node
// @typecheck
/**
 * Dutch for spreadsheets in Documents (2026-10): the Spreadsheet document type
 * in the library and the gallery (`documents.sheet.*`,
 * `documents.type.spreadsheet`) and its grid editor (`spreadsheet.*`: the
 * formula bar, saving, the CSV download and what each formula error means)
 * and its assistant panel (`spreadsheet.assistant.*`).
 *
 * Terminology follows the existing Dutch catalogues: a spreadsheet is a
 * spreadsheet (the word Dutch uses), a cell a cel, a formula a formule, a
 * datatable a datatabel, a routine a routine.
 *
 * SAME_AS_ENGLISH lists the keys whose Dutch is the English text itself.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-spreadsheet-documents-translations.js
 */

/** @type {Readonly<Record<string, string>>} */
const NL_TRANSLATIONS = Object.freeze({
    // ── Documents: a spreadsheet in the library ─────────────────────
    'documents.sheet.new_hint': 'Rijen en kolommen met formules zoals =SUM(A1:A9). De cellen zijn een datatabel die routines en apps kunnen lezen.',
    'documents.sheet.untitled': 'Naamloze spreadsheet',

    // ── The grid editor ─────────────────────────────────────────────
    'spreadsheet.add_rows': '50 rijen toevoegen',
    'spreadsheet.cell_input': 'Cel {cell}',
    'spreadsheet.download_csv': 'CSV downloaden',
    'spreadsheet.download_failed': 'De CSV kon niet worden gedownload.',
    'spreadsheet.empty_hint': 'Typ een waarde of een formule zoals =SUM(A1:A5)',
    'spreadsheet.error.cycle': 'De formule hangt af van haar eigen uitkomst (een kringverwijzing).',
    'spreadsheet.error.div0': 'Deling door nul.',
    'spreadsheet.error.generic': 'Deze formule kan niet worden berekend: {error}',
    'spreadsheet.error.name': 'De formule gebruikt een functie of naam die niet bekend is.',
    'spreadsheet.error.na': 'Er is geen waarde beschikbaar.',
    'spreadsheet.error.num': 'De uitkomst is geen geldig getal.',
    'spreadsheet.error.ref': 'De formule verwijst naar een cel die niet bestaat.',
    'spreadsheet.error.syntax': 'De formule is niet goed geschreven.',
    'spreadsheet.error.value': 'De formule kreeg een waarde van de verkeerde soort, zoals tekst waar een getal nodig is.',
    'spreadsheet.formula_bar': 'Formulebalk',
    'spreadsheet.functions': 'Functies',
    'spreadsheet.load_failed': 'De spreadsheet kon niet worden geladen.',
    'spreadsheet.loading': 'De spreadsheet wordt geladen…',
    'spreadsheet.name_box': 'Geselecteerde cel',
    'spreadsheet.rename_failed': 'De naam van de spreadsheet kon niet worden gewijzigd.',
    'spreadsheet.retry': 'Opnieuw proberen',
    'spreadsheet.save_failed': 'Je wijzigingen konden niet worden opgeslagen.',
    'spreadsheet.too_large': 'Deze spreadsheet is te groot om nog meer cellen te bevatten.',
    'spreadsheet.view_only': 'Alleen lezen',
    // ── The spreadsheet assistant ───────────────────────────────────
    'spreadsheet.assistant.changed_one': '1 cel gewijzigd',
    'spreadsheet.assistant.changed_other': '{count} cellen gewijzigd',
    'spreadsheet.assistant.chip_errors': 'Fouten zoeken en herstellen',
    'spreadsheet.assistant.chip_explain': 'De geselecteerde formule uitleggen',
    'spreadsheet.assistant.chip_summarise': 'Deze sheet samenvatten',
    'spreadsheet.assistant.chip_total': 'Een totaalrij toevoegen',
    'spreadsheet.assistant.close': 'De assistent sluiten',
    'spreadsheet.assistant.conversation': 'Gesprek',
    'spreadsheet.assistant.empty_hint': 'Ik kan je cellen lezen, formules uitleggen en de wijzigingen maken die je vraagt.',
    'spreadsheet.assistant.empty_title': 'Vraag iets over deze sheet',
    'spreadsheet.assistant.failed': 'De assistent kon geen antwoord geven.',
    'spreadsheet.assistant.hint': 'Enter om te versturen, Shift+Enter voor een nieuwe regel',
    'spreadsheet.assistant.input_label': 'Bericht aan de assistent',
    'spreadsheet.assistant.open': 'Assistent',
    'spreadsheet.assistant.placeholder': 'Stel een vraag of beschrijf een wijziging',
    'spreadsheet.assistant.placeholder_read_only': 'Stel een vraag over deze sheet',
    'spreadsheet.assistant.read_only': 'Alleen lezen: ik kan vragen beantwoorden maar geen cellen wijzigen.',
    'spreadsheet.assistant.selection': 'Selectie: {range}',
    'spreadsheet.assistant.send': 'Versturen',
    'spreadsheet.assistant.stop': 'Stoppen',
    'spreadsheet.assistant.stopped': 'Gestopt. De sheet is opnieuw geladen voor het geval er al wijzigingen waren opgeslagen.',
    'spreadsheet.assistant.title': 'Assistent',
    'spreadsheet.assistant.undo': 'Ongedaan maken',
    'spreadsheet.assistant.undone': 'Ongedaan gemaakt',
    'spreadsheet.assistant.working': 'Bezig met je sheet…',
});

/**
 * Keys whose Dutch IS the English string: "Spreadsheet" and "Spreadsheets"
 * are the Dutch words too.
 */
const SAME_AS_ENGLISH = Object.freeze([
    'documents.sheet.new',
    'documents.sheet.type_filter',
    'documents.type.spreadsheet',
    'spreadsheet.grid_label',
]);

/**
 * Seeds the catalogue into the Dutch strings. The store is a parameter so the
 * test can hand in a recorder; the boot ladder calls up() without arguments
 * and gets the real one.
 *
 * @param {{ languageStore?: { addMissingGUITranslations: (locale: string, translations: Record<string, string>) => Promise<{ added: number }> } }} [deps]
 * @returns {Promise<{ added: number }>}
 */
async function up({ languageStore = require('../stores/languageStore') } = {}) {
    // Atomic across replicas (advisory lock in mutateConfig); existing values
    // win, only missing keys are added.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-spreadsheet-documents-translations: added ${added} NL keys`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS, SAME_AS_ENGLISH };

if (require.main === module) {
    up().then(({ added }) => {
        console.log(`Done (${added} added).`);
        process.exit(0);
    }).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
