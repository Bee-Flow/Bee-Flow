#!/usr/bin/env node
/**
 * Dutch for the builder's VALUE editor — the second half of Track R.
 *
 * `add-nl-builder-redesign-translations.js` translated the canvas, the step
 * drawer and the mismatch box. It left 77 `routines.builder.*` keys behind,
 * and its own test wrote the reason down as "translated elsewhere". That was
 * not true: nothing translated them. This migration is the correction, and
 * the test beside it takes over the coverage direction for the whole prefix so
 * the claim can never again be a comment instead of an assertion.
 *
 * WHAT IS IN HERE, AND WHY IT IS NOT DECORATION: the list chooser. When an
 * author drops a list of e-mail addresses onto a field that takes one value,
 * this is the vocabulary of the box that opens — "Hoe moet dit veld het
 * gebruiken?", "Alleen de eerste", "Alles achter elkaar, als één tekst",
 * "Deze stap één keer per rij draaien". Half-translated, that box is a page of
 * English in a Dutch workspace on the one control whose job is to stop a
 * silent array-into-scalar binding. The author clicks past it, and the
 * routine fails hours later inside a provider — or worse, does not fail and
 * mails "[object Object]" to a customer.
 *
 * WORDING IS SHARED WITH THE MISMATCH BOX ON PURPOSE. `routines.mismatch.*`
 * and `routines.builder.*` are two renderers of the same five answers
 * (MismatchResolver over mismatch.js, ListPickChooser over listShape.js). The
 * English drifted between them ("Only the first" vs "Just the first one"); the
 * Dutch deliberately does not — "Alleen de eerste" is the same act whichever
 * box asks it, and a user who learns it in one place must recognise it in the
 * other. The test asserts that overlap rather than leaving it to luck.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME — a renamed key is a screen that
 * silently falls back to English. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-builder-values-translations.js
 */

const NL_TRANSLATIONS = {
    // ── Een pad kiezen dat een lijst moet zijn (LoopOverPicker, PathField) ──
    'routines.builder.path_placeholder': 'Kies een veld met de knop { }',
    'routines.builder.node_generic': 'Stap',
    'routines.builder.path_example_title': 'Of typ zelf een pad, zoals {path}',
    'routines.builder.path_not_list': 'Dit is geen lijst in de voorbeeldgegevens — kies een veld dat meerdere items bevat.',
    'routines.builder.path_no_sample': 'Geen voorbeeldgegevens op dit pad — controleer het na een testrun.',
    'routines.builder.path_column_merges': 'Dit pad neemt één waarde uit elke rij en voegt ze samen tot één lijst.',
    'routines.builder.path_literal_date': 'Vaste datum',

    // ── Gegevens invoegen (InsertDataButton, VariablePicker) ────────────────
    'routines.builder.insert_from_step': 'Gegevens uit een eerdere stap invoegen',
    'routines.builder.act.building': 'Bezig met bouwen',
    'routines.builder.act.built': 'Gebouwd',
    'routines.builder.act.trigger': 'Trigger ingesteld',
    'routines.builder.act.remove': 'Stap verwijderd',
    'routines.builder.act.update': 'Stap aangepast',
    'routines.builder.act.replace': 'Stap vervangen',
    'routines.builder.act.move': 'Stap verplaatst',
    'routines.builder.act.error_branch': 'Terugvaloptie toegevoegd voor als het misgaat',
    'routines.builder.act.metadata': 'Routine benoemd',
    'routines.builder.act.inspect': 'Opgezocht hoe een app werkt',
    'routines.builder.act.summarise': 'Routine nagelopen',
    'routines.builder.act.dry_run': 'Routine getest',
    'routines.builder.act.dry_run_live': 'Routine wordt getest…',
    'routines.builder.act.finalize': 'Afgerond en opgeslagen',
    'routines.builder.act.plan': 'Plan bijgewerkt',
    'routines.builder.act.create_datatable': 'Tabel aangemaakt',
    'routines.builder.edits_locked': 'De AI bouwt deze routine — bewerken kan pas als hij klaar is.',
    'routines.builder.insert_data_word': 'Gegevens invoegen',
    'routines.builder.example': 'voorbeeld',
    'routines.builder.lists_detected': 'Lijsten gevonden in eerdere stappen',

    // ── Een veld binnen elk lus-item (FieldKeyCombobox) ─────────────────────
    'routines.builder.fields_of_items': 'Velden van elk item',
    'routines.builder.field_key_dot': 'Geneste paden kunnen hier niet — kies een veld dat direct in elk item zit.',
    'routines.builder.field_key_unknown': 'Niet gezien in de voorbeelditems — controleer de schrijfwijze.',

    // ── De rauwe waarde-editor: tekst of expressie (BindingField) ───────────
    'routines.builder.mode_group': 'Soort waarde',
    'routines.builder.mode_text': 'Gewone tekst — typ een waarde. Gebruik {{ }} om gegevens uit een eerdere stap in te voegen.',
    'routines.builder.mode_expression': 'Expressie — bereken de waarde, bijvoorbeeld steps.s1.output.total > 100',
    'routines.builder.mode_text_word': 'Tekst',
    'routines.builder.mode_formula_word': 'Formule',
    'routines.builder.what_can_i_write': 'Wat kan ik hier schrijven?',
    'routines.builder.syntax_help': 'Hulp bij de schrijfwijze',
    'routines.builder.expr_invalid': 'Nog niet geldig',

    // ── Hoeveel van een stap je ziet (SettingsForm, artboard 2b) ────────────
    'routines.builder.mode_simple': 'Eenvoudig',
    'routines.builder.mode_all_options': 'Alle opties',
    'routines.builder.mode_toggle_label': 'Hoeveel van deze stap je ziet',
    'routines.builder.show_all_options': 'Toon alle opties',
    'routines.builder.show_all_options_n': 'Toon alle opties ({count})',
    'routines.builder.show_fewer_options': 'Toon minder opties',
    'routines.builder.see_data_in_out': 'Bekijk wat er binnenkomt en wat eruit gaat',

    // ── De voettekst van de lade (artboard 1h/2b) ───────────────────────────
    'routines.builder.fix_before_run': 'Los dit op voordat de routine kan draaien:',
    'routines.builder.worth_checking': 'Even nakijken:',
    'routines.builder.autosave_note': 'Wijzigingen worden vanzelf opgeslagen.',
    'routines.builder.undo_changes': 'Wijzigingen ongedaan maken',

    // ── Wat er in een slot zit, en wat het slot wil (artboard 2b/2c) ────────
    // "nog leeg" en "verwacht:" staan naast het veldlabel. Ze zijn kort omdat
    // ze op één regel naast de naam passen moeten — geen zin, een etiket.
    'routines.builder.still_empty': 'nog leeg',
    'routines.builder.expects_kind': 'verwacht: {kind}',
    'routines.builder.how_it_looks': 'Zo ziet het eruit:',
    'routines.builder.pick_n_fit': 'kies ▸ {n} passen',
    'routines.builder.use_it_as': 'Gebruik het als:',

    // ── De knoppen en labels van de visuele waarde-editor zelf ─────────────
    // Ze stonden allemaal als Engelse letterlijke tekst in ValueBuilder.jsx:
    // de i18nguard controleert t()-aanroepen, dus een string zónder t() bleef
    // onzichtbaar voor elke test én voor elke vertaler.
    'routines.builder.type_a_value': 'Typ een waarde…',
    'routines.builder.value_word': 'Waarde',
    'routines.builder.value_of': 'waarde van {field}',
    'routines.builder.pick_data': 'Kies gegevens uit een stap',
    'routines.builder.pick_data_for': 'Kies gegevens voor {field}',
    'routines.builder.add_text': 'Tekst toevoegen',
    'routines.builder.add_data': 'Gegevens toevoegen',
    'routines.builder.use_data_from_step': 'Gegevens uit een stap gebruiken',
    'routines.builder.change_word': 'wijzigen',
    'routines.builder.remove_text': 'Deze tekst verwijderen',
    'routines.builder.remove_value': 'Deze waarde verwijderen',
    'routines.builder.from_the_json': '· uit de JSON',
    'routines.builder.custom_formula': 'Eigen formule',
    'routines.builder.edit_formula': 'Formule bewerken',
    'routines.builder.replace_it': 'Vervangen',
    'routines.builder.back_to_simple': 'Terug naar de eenvoudige editor',
    'routines.builder.write_as_formula': 'Deze waarde als formule schrijven',
    'routines.builder.adjust_it': 'Pas het aan:',
    'routines.builder.adjust_aria': 'De waarde aanpassen',
    'routines.builder.use_as_is': 'gebruik het zoals het is',

    // ── "Dit is een lijst" in badge-vorm ────────────────────────────────────
    'routines.builder.list_word': 'lijst',
    'routines.builder.list_of_n': 'lijst van {n}',
    'routines.builder.badge_list_items': 'Een lijst — {n} items',
    'routines.builder.badge_list_records': 'Een lijst — {n} records',
    'routines.builder.badge_list_plain': 'Een lijst',
    'routines.builder.badge_column': 'Eén waarde per rij',

    // ── Uitleg onder een gekozen lijst of kolom ─────────────────────────────
    'routines.builder.explain_list': '“{field}” is een lijst van {n} items.',
    'routines.builder.explain_list_no_sample': 'Dit is een lijst. Draai de stap hierboven om te zien hoeveel er echt in zit.',
    'routines.builder.explain_column': 'Eén waarde uit elk van de {rows} rijen — {n} waarden in totaal.',
    'routines.builder.explain_column_nested': 'Deze lijst zit in elke rij. Er doorheen lopen voegt de items van alle rijen samen tot één lijst — {n} in totaal.',
    'routines.builder.column_path_label': '{step} ▸ {field} (in elke rij)',
    'routines.builder.list_empty_sample': 'Hier staat niets in de voorbeeldgegevens — controleer de veldnaam, of draai de stap hierboven voor echte gegevens.',

    // ── DE VRAAG: een lijst op een plek waar één waarde past ────────────────
    // Dit is het scherm dat iemand tegenhoudt die een lijst adressen in een
    // e-mailonderwerp bindt. De woorden zijn dezelfde als in de mismatch-doos
    // (routines.mismatch.*) — twee renderers, één vocabulaire.
    'routines.builder.list_chooser_title': 'Hoe moet dit veld het gebruiken?',
    'routines.builder.list_chooser_list': '“{field}” is een lijst van {n} items.',
    'routines.builder.list_chooser_column': '“{field}” is één waarde uit elk van de {rows} rijen.',
    'routines.builder.list_into_scalar': 'Dit veld verwacht één waarde; een lijst gaat bij het draaien waarschijnlijk mis.',
    'routines.builder.list_wants_one': 'Dit veld wil één waarde, maar je gaf het een lijst van {n}.',
    'routines.builder.choose_list_use': 'Kies hoe de lijst gebruikt wordt',

    'routines.builder.choice_first': 'Alleen de eerste',
    'routines.builder.choice_last': 'Alleen de laatste',
    'routines.builder.choice_join': 'Alles achter elkaar, als één tekst',
    'routines.builder.choice_join_detail': 'Zet elke waarde in één stuk tekst.',
    'routines.builder.choice_count': 'Hoeveel het er zijn',
    'routines.builder.choice_each': 'De hele lijst behouden',
    'routines.builder.choice_each_detail': 'Stuurt alle {n} waarden als lijst mee.',
    'routines.builder.choice_each_scalar_warn': 'Stuurt alle {n} waarden als lijst mee. Alleen velden die een lijst aankunnen werken hiermee.',
    'routines.builder.choice_foreach_row': 'Deze stap één keer per rij draaien',
    'routines.builder.choice_foreach_item': 'Deze stap één keer per item draaien',
    'routines.builder.choice_foreach_detail': 'De stap draait {n}× — één keer per rij. Dit veld krijgt de waarde van die rij.',
    'routines.builder.foreach_blocked_nested': 'Elke rij bevat hier zelf nog een lijst — kies liever één waarde binnen de rij.',
    'routines.builder.foreach_set_note': 'Deze stap draait nu één keer per rij — {n} runs.',

    'routines.builder.separated_by': 'Gescheiden door',
    'routines.builder.sep_comma_space': 'een komma en een spatie',
    'routines.builder.sep_comma': 'een komma',
    'routines.builder.sep_semicolon': 'een puntkomma',
    'routines.builder.sep_space': 'een spatie',
    'routines.builder.sep_newline': 'een nieuwe regel',
    'routines.builder.sep_custom': 'iets anders…',

    'routines.builder.alt_bypass_tip': 'Tip: houd Alt ingedrukt bij klikken of slepen om dit over te slaan en de lijst ongewijzigd in te voegen.',
    'routines.builder.cancel': 'Annuleren',
    'routines.builder.undo': 'Ongedaan maken',

    // ── What a list in a text slot turns into (TemplateField) ──────────────
    // "Gegevens bewerken" is the Dutch name of the `set` step
    // (add-nl-routines-nodes-translations) and "Formule" that of expression
    // mode (mode_formula_word above). One name, every place it appears.
    'routines.builder.template_array_json': 'De lijst gaat als JSON mee: {preview}',
    'routines.builder.template_array_text': 'Deze lijst gaat als JSON-tekst mee: {preview}. Wil je gewone tekst, voeg hem dan eerst samen: een stap Gegevens bewerken met een Formule-veld {expr}.',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-builder-values-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-builder-values-translations failed:', e.message);
        process.exit(1);
    });
}
