#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for Studio documents inside App Studio apps (2026-10): the document
 * viewer, the document picker and the document compare (namespace
 * studio_app_documents, server/i18n/defaults/en/studio_app_documents.js). The
 * wording follows the PDF compare and Version history where they say the same
 * thing ("Naast elkaar", "In de tekst", "Alleen wijzigingen").
 *
 * One namespace, one owner: this catalogue. Idempotent: only fills keys that
 * are missing, so a workspace that curated its own wording keeps it. Auto-runs
 * from server boot (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-app-studio-documents-2026-10-translations.js
 */

const NL_TRANSLATIONS = Object.freeze({
    'studio_app_documents.after': 'Na',
    'studio_app_documents.before': 'Voor',
    'studio_app_documents.cells_changed': '{n} cellen gewijzigd',
    'studio_app_documents.cells_changed_one': '{n} cel gewijzigd',
    'studio_app_documents.columns_added': '{n} kolommen toegevoegd',
    'studio_app_documents.columns_added_one': '{n} kolom toegevoegd',
    'studio_app_documents.columns_removed': '{n} kolommen verwijderd',
    'studio_app_documents.columns_removed_one': '{n} kolom verwijderd',
    'studio_app_documents.compare_empty': 'Geen documenten om te vergelijken.',
    'studio_app_documents.compare_with': 'Vergelijken met',
    'studio_app_documents.comparing': 'Vergelijken…',
    'studio_app_documents.cover': 'Voorblad',
    'studio_app_documents.earlier_version': 'Eerdere versie',
    'studio_app_documents.error.load_failed': 'Het document kon niet worden geladen.',
    'studio_app_documents.error.no_access': 'Dit deel van de app is niet beschikbaar voor jouw rol.',
    'studio_app_documents.error.not_comparable': 'Een spreadsheet kan alleen met een andere spreadsheet worden vergeleken.',
    'studio_app_documents.error.not_found': 'Dit document is niet beschikbaar in deze app.',
    'studio_app_documents.error.not_published': 'Deze app heeft nog geen gepubliceerde versie.',
    'studio_app_documents.error.sheet_versions': 'Een spreadsheet bewaart geen eerdere versies om te tonen.',
    'studio_app_documents.formula_tip': 'Formule: {before} → {after}',
    'studio_app_documents.layout_changed': 'De indeling van de dia is veranderd.',
    'studio_app_documents.loading': 'Document laden…',
    'studio_app_documents.look.accent': 'Accentkleur',
    'studio_app_documents.look.background': 'Achtergrond',
    'studio_app_documents.look.body_font': 'Lettertype tekst',
    'studio_app_documents.look.brand_on_slides': 'Merk op de dia’s',
    'studio_app_documents.look.cover_style': 'Voorblad',
    'studio_app_documents.look.footer_text': 'Voettekst',
    'studio_app_documents.look.house_style': 'Huisstijl',
    'studio_app_documents.look.logo_placement': 'Plaats van het logo',
    'studio_app_documents.look.preset': 'Ontwerp',
    'studio_app_documents.look.slide_numbers': 'Dianummers',
    'studio_app_documents.look.table_style': 'Tabellen',
    'studio_app_documents.look.template': 'Sjabloonpresentatie',
    'studio_app_documents.look.text': 'Tekstkleur',
    'studio_app_documents.look.title_font': 'Lettertype titels',
    'studio_app_documents.look_changed': 'stijl gewijzigd',
    'studio_app_documents.look_title': 'Stijl',
    'studio_app_documents.look_value.custom': 'Eigen',
    'studio_app_documents.look_value.default': 'Uit de huisstijl',
    'studio_app_documents.look_value.off': 'Uit',
    'studio_app_documents.look_value.on': 'Aan',
    'studio_app_documents.look_value.replaced': 'Een andere',
    'studio_app_documents.mode_inline': 'In de tekst',
    'studio_app_documents.mode_side': 'Naast elkaar',
    'studio_app_documents.more_rows': 'Nog {n} rijen worden niet getoond.',
    'studio_app_documents.next_change': 'Volgende wijziging',
    'studio_app_documents.no_differences': 'Geen verschillen',
    'studio_app_documents.no_versions': 'Dit document heeft nog geen eerdere versie.',
    'studio_app_documents.only_changes': 'Alleen wijzigingen',
    'studio_app_documents.op_added': 'Toegevoegd',
    'studio_app_documents.op_changed': 'Gewijzigd',
    'studio_app_documents.op_removed': 'Verwijderd',
    'studio_app_documents.op_same': 'Gelijk',
    'studio_app_documents.paragraphs_added': '{n} alinea’s toegevoegd',
    'studio_app_documents.paragraphs_added_one': '{n} alinea toegevoegd',
    'studio_app_documents.paragraphs_changed': '{n} alinea’s gewijzigd',
    'studio_app_documents.paragraphs_changed_one': '{n} alinea gewijzigd',
    'studio_app_documents.paragraphs_removed': '{n} alinea’s verwijderd',
    'studio_app_documents.paragraphs_removed_one': '{n} alinea verwijderd',
    'studio_app_documents.picker_design': 'Documenten kies je zodra de app draait.',
    'studio_app_documents.picker_none': 'Geen documenten om uit te kiezen.',
    'studio_app_documents.picker_search': 'Documenten zoeken…',
    'studio_app_documents.prev_change': 'Vorige wijziging',
    'studio_app_documents.row': 'Rij',
    'studio_app_documents.rows_added': '{n} rijen toegevoegd',
    'studio_app_documents.rows_added_one': '{n} rij toegevoegd',
    'studio_app_documents.rows_hidden': '{n} ongewijzigde rijen worden niet getoond.',
    'studio_app_documents.rows_removed': '{n} rijen verwijderd',
    'studio_app_documents.rows_removed_one': '{n} rij verwijderd',
    'studio_app_documents.sheet_empty': 'Dit tabblad is leeg.',
    'studio_app_documents.slide_missing': 'Niet in {side}',
    'studio_app_documents.slide_no_text': 'Deze dia heeft geen tekst.',
    'studio_app_documents.slides': 'Dia’s',
    'studio_app_documents.slides_added': '{n} dia’s toegevoegd',
    'studio_app_documents.slides_added_one': '{n} dia toegevoegd',
    'studio_app_documents.slides_changed': '{n} dia’s gewijzigd',
    'studio_app_documents.slides_changed_one': '{n} dia gewijzigd',
    'studio_app_documents.slides_removed': '{n} dia’s verwijderd',
    'studio_app_documents.slides_removed_one': '{n} dia verwijderd',
    'studio_app_documents.slides_same': 'Alle dia’s zijn gelijk.',
    'studio_app_documents.tab_same': 'Op dit tabblad is niets veranderd.',
    'studio_app_documents.tabs': 'Tabbladen',
    'studio_app_documents.tabs_added': '{n} tabbladen toegevoegd',
    'studio_app_documents.tabs_added_one': '{n} tabblad toegevoegd',
    'studio_app_documents.tabs_removed': '{n} tabbladen verwijderd',
    'studio_app_documents.tabs_removed_one': '{n} tabblad verwijderd',
    'studio_app_documents.text_same': 'De tekst is gelijk.',
    'studio_app_documents.text_too_large': 'Deze documenten zijn te lang om alinea voor alinea te vergelijken. De samenvatting hierboven laat zien hoeveel er is veranderd.',
    'studio_app_documents.toolbar': 'Documentvergelijking',
    'studio_app_documents.try_again': 'Opnieuw proberen',
    'studio_app_documents.untitled_slide': 'Dia {n}',
    'studio_app_documents.viewer_design': 'Het document verschijnt hier zodra de app draait.',
    'studio_app_documents.viewer_empty': 'Geen document gekozen.',
});

/** Keys whose Dutch is the English word itself; deliberately not seeded. */
const SAME_AS_ENGLISH = Object.freeze([
    'studio_app_documents.look.logo',
    'studio_app_documents.picker_label',
]);

/**
 * The mutation itself, on a copy of the 'nl' blob. Pure, so the store's mutator may run it more than once.
 * @param {Record<string, string>} merged
 */
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
    await languageStore.mutateGUITranslations('nl', (/** @type {Record<string, string>} */ current) => {
        const result = applyNl(current);
        added = result.added;
        return result.merged;
    });
    if (added > 0) {
        console.log(`[Migration] add-nl-app-studio-documents-2026-10-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, applyNl, NL_TRANSLATIONS, SAME_AS_ENGLISH };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
