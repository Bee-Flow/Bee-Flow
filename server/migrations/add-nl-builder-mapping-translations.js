#!/usr/bin/env node
/**
 * Dutch for the nested-data mapping work: per-item steps over lists inside
 * lists, the AI fallback of "Automatisch koppelen", JSON text read as the
 * structure it encodes, the run's "koppelingen die niets vonden", and the
 * "Gaat verder" table that opens a nested list one level at a time.
 *
 * WHY THESE WORDS MATTER: two of these screens exist only to stop a silent
 * wrong mapping. The "nu één keer per {item}" note says that a step moved to
 * an inner list (a mail's attachments) and which fields followed it; the run
 * block says which input was left empty and why. Half-translated, both read as
 * English noise in a Dutch workspace, and the author clicks past the one
 * sentence that explains why a mail went out without a subject.
 *
 * Vocabulary follows the existing catalogues: "Automatisch koppelen" for the
 * wand (add-nl-*: automations.ndv.tables_row.automap), "Geavanceerd", "Formule",
 * "Vorige stap", "item" and "rij" as in the list chooser.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-builder-mapping-translations.js
 */

const NL_TRANSLATIONS = {
    // ── Een stap per item, ook voor een lijst binnen een lijst ──────────────
    'automations.builder.run_for_each': 'Deze stap uitvoeren voor elk…',
    'automations.builder.item_word': 'item',
    'automations.builder.list_changed_runs': 'Draait nu één keer per {item}.',
    'automations.builder.list_changed_kept': 'Velden die elk {item} lezen, blijven dat doen.',
    'automations.builder.list_changed_moved': 'Leest nu het nieuwe item: {fields}.',
    'automations.builder.list_changed_orphans': 'Het nieuwe item heeft niets voor {fields} — kies ze opnieuw.',
    'automations.builder.lists_to_repeat_over': 'Lijsten om over te herhalen',
    'automations.builder.n_items': '{n} items',
    'automations.builder.one_item': '1 item',
    'automations.builder.no_upstream_lists': 'Geen lijsten in eerdere stappen gevonden — open Geavanceerd om er zelf een in te vullen.',
    'automations.builder.name_each_item': 'Geef elk item een naam',
    'automations.builder.each_item_available_as': 'Elk item is voor de volgende stappen beschikbaar als',
    'automations.builder.advanced': 'Geavanceerd',
    'automations.builder.list_path_expression': 'Pad naar de lijst (formule)',
    'automations.builder.previous_step': 'Vorige stap',
    'automations.builder.each_named': 'Elk {name}',
    'automations.builder.trigger_word': 'Trigger',
    'automations.builder.variable_word': 'Variabele',
    'automations.builder.inside_each_row': '{label} (binnen elke rij)',
    'automations.builder.choice_foreach_inner': 'Deze stap één keer per {item} uitvoeren',
    'automations.builder.choice_foreach_inner_detail': 'De stap draait {n} keer — één keer per {item}, over alle rijen heen. Dit veld krijgt de waarde van dat {item}.',
    'automations.ndv.runs_n_times_per_item': 'draait {n}× · één keer per {item}',

    // ── De waarde-editor: gestructureerde gegevens en een pad als tekst ─────
    'automations.builder.json_not_saved': 'Deze waarde is gestructureerde data: je wijziging wordt opgeslagen zodra het weer geldige JSON is.',
    'automations.builder.clear_it': 'Leegmaken',
    'automations.builder.path_as_text': 'Dit verstuurt het pad zelf als tekst, niet de waarde waar het naar wijst.',
    'automations.builder.use_its_value': 'De waarde gebruiken',

    // ── Automatisch koppelen, met AI als vangnet ────────────────────────────
    'automations.builder.auto_mapped_ai': 'auto · AI',
    'automations.builder.auto_mapped_ai_title': 'Door AI gekoppeld vanuit een eerdere stap — controleer het, pas het aan om het te overschrijven',
    'automations.builder.automap.nothing': 'Niets om automatisch te koppelen: geen veld uit de stappen hierboven past bij de lege invoer.',
    'automations.builder.automap.mapped_one': '1 invoer automatisch gekoppeld',
    'automations.builder.automap.mapped_other': '{count} invoeren automatisch gekoppeld',
    'automations.builder.automap.with_ai': '{summary} ({ai} met AI)',

    // ── JSON-tekst gelezen als de structuur die erin staat ──────────────────
    'automations.kind.json_record': '· JSON met {n} velden',
    'automations.kind.json_record_one': '· JSON met 1 veld',
    'automations.kind.json_list': '· JSON, een lijst van {n}',
    'automations.kind.json': 'JSON',
    'automations.kind.group_field': '· 1 veld',
    'automations.output.group_field': 'groep · 1 veld',
    'automations.output.one_row': '1 rij',
    'automations.output.n_rows': '{count} rijen',
    'automations.output.one_column': '1 kolom',
    'automations.output.n_columns': '{count} kolommen',

    // ── Koppelingen die in een run niets vonden ─────────────────────────────
    'automations.output.binding_misses_title': 'Koppelingen die niets vonden',
    'automations.output.binding_misses_more': 'Nog {n} tonen',
    'automations.output.binding_misses_hint': 'Deze invoer bleef leeg. Kies het veld opnieuw in de instellingen van de stap, of controleer of de eerdere stap het teruggaf.',
    'automations.output.binding_why_missing': 'daar stond niets',
    'automations.output.binding_why_not_run': 'die stap is niet uitgevoerd',
    'automations.output.binding_why_bad_path': 'geen geldig pad',
    'automations.output.binding_why_bad_formula': 'geen geldige formule',
    'automations.output.binding_why_error': 'de formule gaf een fout',
    'automations.output.binding_any_input': 'Een koppeling',
    'automations.output.binding_formula': 'Een formule',
    'runs.timeline.binding_misses_one': '1 koppeling vond niets',
    'runs.timeline.binding_misses_many': '{n} koppelingen vonden niets',

    // ── "Gaat verder": een stap per item als tabel, en lijsten openen ───────
    'automations.output.col_result': 'Resultaat',
    'automations.output.col_problem': 'Probleem',
    'automations.output.open_rows': '{count} rijen openen',
    'automations.output.open_row_one': '1 rij openen',
    'automations.output.show_all_rows': 'Alle {count} rijen tonen',
    'automations.output.show_all_columns': 'Alle {count} kolommen tonen',
    'automations.output.trail': 'Waar je bent',
    'automations.output.crumb_row': '{title} (rij {n})',
    'automations.output.each_all_worked': '{count} keer uitgevoerd · alles gelukt',
    'automations.output.each_one_worked': '1 keer uitgevoerd · gelukt',
    'automations.output.each_some_failed': '{count} keer uitgevoerd · {failed} niet gelukt',
    'automations.output.each_capped': 'Gestopt bij de limiet: {done} van {total} gedaan',
};

// Words that are the same in Dutch: the product says "Trigger", "JSON" and
// "auto · AI" in both languages. Listed so the test can tell them apart from
// a key that was copied over untranslated.
const SAME_IN_DUTCH = new Set([
    'automations.builder.trigger_word',
    'automations.builder.item_word',
    'automations.builder.n_items',
    'automations.builder.one_item',
    'automations.builder.auto_mapped_ai',
    'automations.kind.json',
]);

async function up() {
    const languageStore = require('../stores/languageStore');
    // Existing values win; only missing keys are added.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-builder-mapping-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS, SAME_IN_DUTCH };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-builder-mapping-translations failed:', e.message);
        process.exit(1);
    });
}
