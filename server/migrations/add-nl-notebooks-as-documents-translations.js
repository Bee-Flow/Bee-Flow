#!/usr/bin/env node
// @typecheck
/**
 * Dutch for notebooks as a document type (2026-10): a notebook is listed,
 * started, filtered, filed and deleted in Studio → Documents, next to pages,
 * designed documents and presentations (`documents.notebook.*`,
 * `documents.type.notebook`), and the notebook workspace that opens there got
 * the Studio header and a rebuilt sources rail (the new `notebooks.*` keys:
 * back to Documents, the four ways to add a source, the source types, the URL
 * hint, the preview that failed).
 *
 * Its own catalogue, not lines added to the wave-2 documents catalogue: that
 * one already ran on upgraded servers (the boot ladder runs each file once),
 * so keys added to it would never reach them.
 *
 * Terminology follows the existing Dutch catalogues: a notebook is a
 * notitieboek, a source a bron, a page a pagina, a designed document a
 * vormgegeven document, the house style the huisstijl.
 *
 * SAME_AS_ENGLISH lists the keys whose Dutch is the English text itself (the
 * file-type names PDF, Word, Excel, CSV, URL, Drive, OneDrive, and the URL
 * placeholder). They are not seeded: t() already falls back to English.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-notebooks-as-documents-translations.js
 */

/** @type {Readonly<Record<string, string>>} */
const NL_TRANSLATIONS = Object.freeze({
    // ── Documents: a notebook in the library ────────────────────────
    'documents.type.notebook': 'Notitieboek',
    'documents.notebook.new': 'Notitieboek',
    'documents.notebook.new_hint': 'Voeg bestanden, websites en notities toe als bronnen; de assistent antwoordt op basis daarvan en helpt je schrijven.',
    'documents.notebook.untitled': 'Naamloos notitieboek',
    'documents.notebook.loading': 'Het notitieboek wordt geopend…',
    'documents.notebook.library_subtitle': 'Pagina’s, notitieboeken, vormgegeven documenten en presentaties. Schrijf met je bronnen bij de hand; één keer ontwerpen, voor elke klant aanpassen.',
    'documents.notebook.type_filter': 'Notitieboeken',
    'documents.notebook.source_one': '1 bron',
    'documents.notebook.sources': '{count} bronnen',
    'documents.notebook.delete': '{name} verwijderen',
    'documents.notebook.delete_title': 'Dit notitieboek verwijderen?',
    'documents.notebook.delete_desc': '"{name}" wordt definitief verwijderd, met zijn bronnen, zijn chat en zijn versies. Een notitieboek kan niet worden teruggezet.',
    'documents.notebook.delete_confirm': 'Notitieboek verwijderen',

    // ── The notebook workspace ──────────────────────────────────────
    'notebooks.back_to_documents': 'Documenten',
    'notebooks.close_panel': 'Sluiten',
    'notebooks.view_toggles': 'Panelen',
    'notebooks.loading': 'Laden…',
    'notebooks.add_source_group': 'Een bron toevoegen',
    'notebooks.add_opt_file': 'Bestand uploaden',
    'notebooks.add_opt_text': 'Tekst plakken',
    'notebooks.add_opt_meeting': 'Vergadering',
    'notebooks.sources_empty_hint2': 'Bronnen voeden de AI-chat en de bronvermeldingen. Sleep hier een bestand naartoe, of kies hierboven een soort.',
    'notebooks.url_hint': 'De tekst van de pagina wordt opgehaald en geïndexeerd. Pagina’s achter een inlog kunnen niet worden gelezen.',
    'notebooks.select_source': '{name} selecteren',
    'notebooks.rename_source': 'Naam van de bron',
    'notebooks.preview_failed': 'Het voorbeeld kon niet worden geladen. Probeer het zo nog eens.',
    'notebooks.src_type_text': 'Tekst',
    'notebooks.src_type_file': 'Bestand',
    'notebooks.src_type_meeting': 'Vergadering',
});

/**
 * Keys whose Dutch IS the English string: file-type and service names, and
 * the example address in the URL field. Kept out of NL_TRANSLATIONS on
 * purpose; the test uses this list to tell "deliberately identical" from
 * "forgotten".
 */
const SAME_AS_ENGLISH = Object.freeze([
    'notebooks.add_opt_url',
    'notebooks.src_type_pdf',
    'notebooks.src_type_word',
    'notebooks.src_type_excel',
    'notebooks.src_type_csv',
    'notebooks.src_type_url',
    'notebooks.src_type_drive',
    'notebooks.src_type_onedrive',
    'notebooks.url_placeholder',
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
        console.log(`[Migration] add-nl-notebooks-as-documents-translations: added ${added} NL keys`);
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
