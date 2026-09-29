#!/usr/bin/env node
/**
 * Dutch for the Datatables Studio section (2026-08, widened 2026-09).
 *
 * It started as the two keys the shared chrome renders, on the stated grounds
 * that "the section's own body copy is English, like Solutions and App Studio:
 * those surfaces do not go through t() at all". That was true and is no longer:
 * the six components now call t() throughout, so the keys below cover the list,
 * the create dialog, the column designer, the row browser, the spreadsheet
 * import, the sharing panel and both destructive confirmations.
 *
 * WHY THIS SECTION AND NOT ANOTHER: the copy here is consent- and
 * record-flavoured — "this sentence goes into your organisation's processing
 * record", "everyone in your organisation will be able to read every row",
 * "type the table's name to confirm". A person cannot give an informed answer
 * to a question they are reading in a second language, and this is a Dutch
 * privacy product.
 *
 * Terminology follows the node catalogue that shipped with the datatable step
 * (add-nl-routines-nodes-translations.js): a datatable is a "datatabel", a
 * routine stays a "routine", an organisation is an "organisatie". And "dit
 * account", never "jij": on a self-hosted install the built-in `admin` login is
 * routinely shared between several human operators, so "alleen jij kunt dit
 * zien" would be a promise the product cannot keep.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated its
 * own wording keeps it. ADD, NEVER RENAME — a renamed key is a screen that
 * silently falls back to English. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-datatables-translations.js
 */

const NL_TRANSLATIONS = {
    'studio.tab.datatables': 'Datatabellen',
    'studio.tab.datatables_desc': 'Rijen die je routines tussen runs bewaren',

    // ── De lijst ────────────────────────────────────────────────────────────
    'datatables.title': 'Datatabellen',
    'datatables.intro': 'Rijen die blijven staan nadat een run klaar is. Een routine kan teruglezen wat een eerdere run schreef, en andere routines kunnen dezelfde tabel gebruiken.',
    'datatables.new': 'Nieuwe tabel',
    'datatables.search': 'Zoek tabellen op naam, sleutel of doel…',
    'datatables.search_empty': 'Geen tabel komt daarmee overeen.',
    'datatables.not_available': 'Die tabel is niet voor jou beschikbaar.',
    'datatables.empty_title': 'Nog geen datatabellen',
    'datatables.empty_can_create': 'Maak er een zodra een routine iets tussen runs moet onthouden — een lijst klanten die al gemaild zijn, een lopend totaal, rijen die een tweede routine oppakt.',
    'datatables.empty_cannot_create': 'Tabellen in deze organisatie worden door een beheerder gemaakt. Zodra er een met je gedeeld is verschijnt hij hier, en kunnen je routines hem gebruiken.',
    'datatables.scope_notice_personal': 'Nieuwe tabellen hier zijn persoonlijk — alleen dit account kan ze zien, en ze kunnen niet gedeeld worden.',
    'datatables.scope_notice_org': 'Nieuwe tabellen hier horen bij je organisatie. Je kiest daarna wie ze mag lezen of wijzigen.',
    'datatables.no_description': 'Geen omschrijving',
    'datatables.one_row': '1 rij',
    'datatables.n_rows': '{n} rijen',
    'datatables.audience_personal': 'Persoonlijk',
    'datatables.audience_org': 'Hele organisatie',
    'datatables.audience_groups': 'Gedeeld met groepen',
    'datatables.audience_private': 'Privé',
    'datatables.grade_owner': 'Jij bent eigenaar van deze tabel',
    'datatables.grade_editor': 'Je kunt rijen lezen en wijzigen',
    'datatables.grade_viewer': 'Je kunt rijen lezen',
    'datatables.grade_shared': 'Met je gedeeld',
    'datatables.err_list': 'Kon je datatabellen niet laden',

    // ── Nieuwe tabel ────────────────────────────────────────────────────────
    'datatables.new_title': 'Nieuwe datatabel',
    'datatables.new_kind': 'Wat voor tabel?',
    'datatables.kind_plain': 'Een gewone tabel',
    'datatables.kind_plain_blurb': 'Jij bepaalt de kolommen. Routines lezen en schrijven de rijen.',
    'datatables.kind_http_cache': 'Antwoorden van webdiensten',
    'datatables.kind_http_cache_blurb': 'Voor het vinkje “antwoorden onthouden in een tabel” op een stap Roep een webdienst aan. De kolommen liggen vast, omdat een routine ze op naam wegschrijft.',
    'datatables.field_name': 'Naam',
    'datatables.field_key': 'Sleutel',
    'datatables.field_key_help': 'Kleine letters, cijfers en liggende streepjes. Later hernoemen betekent de gegevens verplaatsen, dus het is nu even nadenken waard.',
    'datatables.field_purpose': 'Waar is het voor?',
    'datatables.field_purpose_help': 'Verplicht — deze zin komt in het verwerkingsregister van je organisatie.',
    'datatables.field_purpose_managed': 'Hier optioneel — laat je hem leeg, dan brengt dit soort tabel zijn eigen zin voor het verwerkingsregister mee.',
    'datatables.first_columns': 'Kolommen (optioneel)',
    'datatables.field_audience': 'Voor wie is het?',
    'datatables.scope_org': 'Je organisatie',
    'datatables.scope_org_blurb': 'Je bepaalt daarna wie de rijen mag lezen of wijzigen. Routines van je collega’s kunnen hem gebruiken.',
    'datatables.scope_org_not_permitted': 'Eén voor de hele organisatie maken vereist een recht dat dit account niet heeft — een beheerder geeft het onder Organisatie → Rollen.',
    'datatables.scope_personal': 'Alleen dit account',
    'datatables.scope_personal_blurb': 'Alleen dit account kan de rijen zien — geen collega’s, geen beheerders. Later delen kan niet.',
    'datatables.create': 'Aanmaken',
    'datatables.cancel': 'Annuleren',
    'datatables.created_title': 'De tabel staat klaar',
    'datatables.created_managed': 'Routines kunnen hun vinkje “antwoorden onthouden in een tabel” er nu op richten.',
    'datatables.created_open': 'Open de tabel',
    'datatables.err_key_taken': 'Er is al een tabel met deze sleutel. Kies een andere.',
    'datatables.err_no_org': 'Dit account zit niet in een organisatie en kan dus alleen een persoonlijke tabel maken.',
    'datatables.err_quota': 'Je hebt de limiet op tabellen hier bereikt.',
    'datatables.err_bad_scope': 'Kies of de tabel voor je organisatie of voor dit account is.',
    'datatables.err_unknown_kind': 'Deze werkomgeving weet niet hoe zo’n tabel gevuld moet worden.',
    'datatables.err_create': 'Kon de tabel niet aanmaken',

    // ── Eén tabel ───────────────────────────────────────────────────────────
    'datatables.back': 'Alle datatabellen',
    'datatables.key_hint': 'De sleutel waar de Datatabel-stap van een routine naar verwijst',
    'datatables.tabs_label': 'Deze datatabel',
    'datatables.tab_columns': 'Kolommen',
    'datatables.tab_rows': 'Rijen',
    'datatables.tab_data': 'Gegevens & bewaartermijn',
    'datatables.tab_sharing': 'Delen',
    'datatables.tab_usage': 'Gebruikt door',
    'datatables.loading': 'Laden…',

    // ── Gegevens & bewaartermijn ────────────────────────────────────────────
    'datatables.managed_plaintext': 'Rijen hier bevatten wat een externe dienst antwoordde, in leesbare tekst, te lezen en te exporteren door iedereen met toegang tot deze tabel.',
    'datatables.retention_on': 'Rijen worden {n} dagen na hun {field} verwijderd.',
    'datatables.retention_off': 'Rijen blijven staan tot iets ze verwijdert — een automation-stap, of jijzelf.',
    'datatables.retention_managed': 'Voor deze tabel is die termijn het hele verhaal: hij bepaalt wanneer een onthouden antwoord verloopt, zodat een routine de dienst opnieuw vraagt. Er is geen tweede, verborgen klok.',
    'datatables.retention_runs': 'Een run die deze rijen las bewaart zijn eigen kopie in de runhistorie, die op de bewaartermijn van runs verloopt.',

    // ── Kolommen ────────────────────────────────────────────────────────────
    'datatables.columns_readonly': 'Je kunt de kolommen zien maar niet wijzigen. De eigenaar van de tabel, of een beheerder, kan dat wel.',
    'datatables.columns_managed': 'De vergrendelde kolommen worden automatisch gevuld en kunnen niet verwijderd, hernoemd of van type veranderd worden. Eigen kolommen mag je er wel naast zetten.',
    'datatables.columns_empty': 'Nog geen kolommen. Elke tabel heeft al id, created_at, updated_at en created_by — voeg daar de kolommen aan toe die je routine nodig heeft.',
    'datatables.column_add': 'Een kolom toevoegen',
    'datatables.column_name': 'Kolomnaam',
    'datatables.column_type': 'Kolomtype',
    'datatables.column_generic': 'kolom',
    'datatables.column_remove': 'Deze kolom verwijderen',
    'datatables.column_remove_named': '{name} verwijderen',
    'datatables.column_move_up': '{name} omhoog',
    'datatables.column_move_down': '{name} omlaag',
    'datatables.column_locked': 'Wordt automatisch gevuld — deze kolom kan niet verwijderd, hernoemd of van type veranderd worden.',
    'datatables.column_options': 'Opties voor {name}',
    'datatables.column_options_ph': 'Optie een, Optie twee, Optie drie',
    'datatables.column_used_one': 'gebruikt door 1 routine',
    'datatables.column_used_many': 'gebruikt door {n} routines',
    'datatables.columns_save': 'Kolommen opslaan',
    'datatables.columns_saved': 'Kolommen opgeslagen.',
    'datatables.discard': 'Verwerpen',
    'datatables.err_columns_load': 'Kon de kolommen niet laden',
    'datatables.err_columns_save': 'Kon de kolommen niet opslaan',
    'datatables.err_breaking': 'Een routine gebruikt nog een kolom die je weghaalt. Kijk bij “gebruikt door” en bevestig de wijziging.',
    'datatables.err_conflict': 'Iemand anders heeft deze kolommen gewijzigd terwijl jij bezig was. Hun versie staat nu op het scherm — maak je wijziging opnieuw.',
    'datatables.managed_missing': '“{key}” hoort bij hoe deze tabel automatisch gevuld wordt. Verwijderen of hernoemen kan niet.',
    'datatables.managed_retyped': '“{key}” wordt automatisch gevuld en moet een {type}-kolom blijven.',
    'datatables.managed_unique': '“{key}” moet uniek blijven — zonder dat zou elke verversing een tweede rij toevoegen in plaats van de eerste te vervangen.',
    'datatables.managed_required': '“{key}” moet verplicht blijven — de kolom wordt automatisch gevuld.',

    // ── Wat een opslag weggooit ─────────────────────────────────────────────
    'datatables.destructive_title': 'Hiermee gooi je gegevens weg',
    'datatables.destructive_removed_one': '{keys} weghalen verwijdert de waarde in die 1 rij.',
    'datatables.destructive_removed': '{keys} weghalen verwijdert de waarden in alle {n} rijen.',
    'datatables.destructive_retyped': 'Het type van {keys} wijzigen herschrijft elke bestaande waarde, en alles wat niet in het nieuwe type past gaat verloren.',
    'datatables.destructive_readers_one': '1 routine leest een van deze kolommen en stopt met werken: {names}.',
    'datatables.destructive_readers': '{n} routines lezen een van deze kolommen en stoppen met werken: {names}.',
    'datatables.destructive_keep': 'Laat ze staan',
    'datatables.destructive_confirm': 'Toch opslaan',

    // ── Rijen ───────────────────────────────────────────────────────────────
    'datatables.rows_recent': 'de {n} meest recente van {total}',
    'datatables.refresh': 'Vernieuwen',
    'datatables.export_csv': 'CSV exporteren',
    'datatables.import': 'Importeren',
    'datatables.add_row': 'Een rij toevoegen',
    'datatables.add_row_submit': 'Rij toevoegen',
    'datatables.rows_search': 'Zoek in de tekstkolommen…',
    'datatables.rows_search_label': 'Zoek in de rijen',
    'datatables.clear': 'Wissen',
    'datatables.rows_no_columns': 'Deze tabel heeft nog geen kolommen — voeg ze eerst toe op het tabblad Kolommen.',
    'datatables.rows_no_match': 'Geen rij komt overeen met die zoekopdracht.',
    'datatables.rows_empty': 'Nog geen rijen. Een routine met een Datatabel-stap die naar deze tabel schrijft vult hem, of je voegt er hier zelf een toe.',
    'datatables.sort_by': 'Sorteer op {name}',
    'datatables.sort_by_added': 'Sorteer op wanneer het is toegevoegd',
    'datatables.col_added': 'Toegevoegd',
    'datatables.row_actions': 'Acties',
    'datatables.row_edit': 'Deze rij bewerken',
    'datatables.row_save': 'Deze rij opslaan',
    'datatables.row_stop_edit': 'Stoppen met bewerken',
    'datatables.row_delete': 'Deze rij verwijderen',
    'datatables.row_delete_title': 'Deze rij verwijderen?',
    'datatables.row_delete_body': 'Hij is definitief weg, en elke routine die hem op id leest vindt hem niet meer.',
    'datatables.row_delete_confirm': 'Verwijder de rij',
    'datatables.load_more': 'Meer laden',
    'datatables.err_rows': 'Kon de rijen niet lezen',
    'datatables.err_next_page': 'Kon de volgende pagina niet lezen',
    'datatables.err_row_add': 'Kon de rij niet toevoegen',
    'datatables.err_row_save': 'Kon de rij niet opslaan',
    'datatables.err_row_delete': 'Kon de rij niet verwijderen',
    'datatables.err_row_conflict': 'Iemand anders heeft deze rij gewijzigd terwijl jij hem open had — de lijst is ververst.',
    'datatables.err_export': 'Kon de rijen niet exporteren',

    // ── Plakken uit een spreadsheet ─────────────────────────────────────────
    'datatables.import_title': 'Plakken uit een spreadsheet',
    'datatables.import_back': 'Terug naar de rijen',
    'datatables.import_help': 'Kopieer de rijen in Excel of Google Sheets — inclusief de kopregel — en plak ze hier.',
    'datatables.import_textarea': 'Geplakte rijen',
    'datatables.import_mapping': 'Waar gaat elke kolom heen?',
    'datatables.import_column_n': 'Kolom {n}',
    'datatables.import_column_target': 'Waar gaat “{name}” heen?',
    'datatables.import_skip_column': 'Deze niet importeren',
    'datatables.import_one': '1 rij importeren',
    'datatables.import_n': '{n} rijen importeren',
    'datatables.import_unmapped': 'Richt eerst minstens één kolom op een veld.',
    'datatables.import_done_one': '1 rij geïmporteerd',
    'datatables.import_done': '{n} rijen geïmporteerd',
    'datatables.import_skipped': '{n} overgeslagen',
    'datatables.import_line': 'Regel {n}',
    'datatables.import_again': 'Nog een blok plakken',
    'datatables.err_import': 'Kon deze rijen niet importeren',

    // ── Delen ───────────────────────────────────────────────────────────────
    'datatables.share_personal_title': 'Deze tabel kan niet gedeeld worden',
    'datatables.share_personal_body': 'Hij hoort bij dit account alleen. Niemand anders kan de rijen lezen of wijzigen — geen collega’s, geen beheerders — en er is geen instelling die dat verandert. Wil je gegevens met de rest van je organisatie delen, maak dan een organisatietabel.',
    'datatables.share_legend': 'Wie deze tabel mag lezen',
    'datatables.share_private': 'Privé',
    'datatables.share_private_desc': 'Alleen jij en de mensen die je uitnodigt.',
    'datatables.share_org': 'Hele organisatie',
    'datatables.share_org_desc': 'Iedereen kan lezen; alleen uitgenodigde mensen kunnen wijzigen.',
    'datatables.share_groups': 'Bepaalde groepen',
    'datatables.share_groups_desc': 'Alleen leden van de groepen die je kiest.',
    'datatables.share_groups_pending': 'Er is nog niets veranderd — een groep kiezen is wat de tabel deelt.',
    'datatables.loading_groups': 'Groepen laden…',
    'datatables.share_no_directory': 'Je kunt de groepenlijst van de organisatie niet zien, dus de groepen staan er op id.',
    'datatables.share_write_toggle': 'Laat iedereen die hem mag lezen hem ook wijzigen',
    'datatables.share_write_help': 'Standaard uit. Staat dit uit, dan kunnen alleen de mensen die je hieronder uitnodigt rijen toevoegen, wijzigen of verwijderen.',
    'datatables.and_write': ', en toe te voegen, te wijzigen en te verwijderen',
    'datatables.confirm_org': 'Iedereen in je organisatie kan straks elke rij van “{name}” lezen{write}.',
    'datatables.confirm_groups': 'Leden van {groups} kunnen straks elke rij van “{name}” lezen{write}.',
    'datatables.confirm_write': '{who} kan straks rijen toevoegen, wijzigen en verwijderen, niet alleen lezen.',
    'datatables.share_confirm_title': 'Meer mensen toegang geven?',
    'datatables.share_confirm_yes': 'Deel hem',
    'datatables.share_confirm_no': 'Laat het zoals het is',
    'datatables.can_read_every_row': 'kan elke rij lezen.',
    'datatables.rows_changed_by': 'Rijen kunnen worden toegevoegd, gewijzigd en verwijderd door',
    'datatables.widest_setting': 'Dat is de ruimste instelling die er is: iedereen in je organisatie kan elke rij verwijderen, en elke routine die zij draaien ook.',
    'datatables.share_paywalled': 'Een datatabel met collega’s delen hoort bij een betaald plan. Je eigen tabellen, en elke tabel die al met je gedeeld is, blijven precies werken zoals nu.',
    'datatables.grants_title': 'Mensen en teams',
    'datatables.grants_empty': 'Nog niemand.',
    'datatables.ai_title': 'Bouwen met AI',
    'datatables.ai_intro': 'Beschrijf wat de rijen moeten bevatten, of plak waarop de kolommen gebaseerd moeten zijn — de kopregel van een spreadsheet, een e-mail, een lijst. De velden hieronder worden ingevuld om na te lezen.',
    'datatables.ai_intro_revise': 'Zeg wat er anders moet. Kolommen die blijven, blijven zoals ze zijn — en hun rijen ook. Er wordt niets opgeslagen tot er op Opslaan wordt gedrukt.',
    'datatables.ai_placeholder': 'bijv. Leveranciersfacturen: leverancier, factuurnummer, datum, bedrag excl. btw, btw %, totaal, status (nieuw / goedgekeurd / afgewezen)',
    'datatables.ai_placeholder_revise': 'bijv. voeg een telefoonnummer toe, hernoem Fase naar Status, maak Bedrag verplicht',
    'datatables.ai_allow': 'Sta toe dat kolommen voor dit verzoek worden verwijderd of van type veranderen',
    'datatables.ai_allow_help': 'Uit: de AI kan alleen kolommen toevoegen en hernoemen; een kolom die hij weglaat wordt teruggezet. Aan: een verwijderde of hertypte kolom vraagt nog steeds om bevestiging voor het opslaan — en noemt de rijen die het kost.',
    'datatables.ai_run': 'Kolommen opstellen',
    'datatables.ai_run_revise': 'Kolommen aanpassen',
    'datatables.ai_running': 'Bezig met opstellen…',
    'datatables.ai_undo': 'Ongedaan maken',
    'datatables.ai_done_create': '{count} kolommen opgesteld — lees ze hieronder na en maak dan de tabel.',
    'datatables.ai_done_none': 'Er is niets veranderd.',
    'datatables.ai_changes_added': '{n} toegevoegd',
    'datatables.ai_changes_renamed': '{n} hernoemd',
    'datatables.ai_changes_retyped': '{n} van type veranderd',
    'datatables.ai_changes_removed': '{n} verwijderd',
    'datatables.ai_err_no_model': 'Er is nog geen AI-model ingesteld voor deze werkruimte.',
    'datatables.ai_err_unusable': 'De AI gaf geen bruikbare tabel terug. Probeer het opnieuw, of beschrijf het concreter.',
    'datatables.ai_err_locked': 'De kolommen van deze tabel zijn hier niet aan te passen.',
    'datatables.ai_err_no_text': 'Typ of plak eerst iets.',
    'datatables.ai_err_rate': 'Te veel concepten in één minuut — wacht even en probeer het opnieuw.',
    'datatables.ai_err_failed': 'De kolommen konden niet worden opgesteld.',
    'datatables.menu_rename': 'Tabel hernoemen',
    'datatables.menu_duplicate': 'Dupliceren',
    'datatables.menu_duplicate_hint': 'alleen de kolommen, geen rijen',
    'datatables.menu_delete': 'Deze tabel verwijderen…',
    'datatables.menu_unlink': 'Deze tabel ontkoppelen…',
    'datatables.duplicate_name': '{name} (kopie)',
    'datatables.err_duplicate': 'De tabel kon niet worden gedupliceerd',
    'datatables.one_column': '1 kolom',
    'datatables.n_columns': '{n} kolommen',
    'datatables.columns_hint': 'Sleep aan het handvat om te herordenen. Kolommen waar een automation naar schrijft zijn gemarkeerd; zo’n kolom verwijderen breekt die stap tot hij daar is aangepast.',
    'datatables.column_reorder': '{name} herordenen — slepen, of de pijltjestoetsen',
    'datatables.column_reorder_hint': 'Slepen om te herordenen · ↑ ↓',
    'datatables.column_written_by': 'Een automation schrijft naar deze kolom',
    'datatables.column_read_by': 'Een automation leest deze kolom',
    'datatables.column_options_edit': 'De keuzes van {name} bewerken',
    'datatables.cell_no_choice': 'nog geen {name}',
    'datatables.share_read_title': 'Wie de rijen kan lezen',
    'datatables.grants_caption': 'op naam uitgenodigd',
    'datatables.grade_can_read': 'kan rijen lezen',
    'datatables.grade_can_write': 'kan rijen wijzigen',
    'datatables.grant_remove': '{name} verwijderen',
    'datatables.grantee_person': 'Een persoon',
    'datatables.grantee_group': 'Een groep',
    'datatables.pick_person': 'Kies iemand…',
    'datatables.pick_group': 'Kies een groep…',
    'datatables.share_button': 'Delen',
    'datatables.err_grants': 'Kon niet laden met wie dit gedeeld is',
    'datatables.err_sharing': 'Kon het delen niet bijwerken',
    'datatables.err_grant_add': 'Kon de tabel niet delen',
    'datatables.err_grant_remove': 'Kon het delen niet ongedaan maken',

    // ── Gebruikt door ───────────────────────────────────────────────────────
    'datatables.usage_empty': 'Nog geen routine gebruikt deze tabel. Voeg een Datatabel-stap toe aan een routine en kies deze tabel.',
    'datatables.usage_read': 'Leest rijen',
    'datatables.usage_write': 'Leest en wijzigt rijen',
    'datatables.usage_columns': 'gebruikt {cols}',
    'datatables.usage_someone_else': 'routine van iemand anders',
    'datatables.err_usage': 'Kon niet laden wie deze tabel gebruikt',

    // ── Verwijderen ─────────────────────────────────────────────────────────
    'datatables.delete_open': 'Deze tabel verwijderen',
    'datatables.delete_question': '“{name}” en zijn {n} rij(en) verwijderen?',
    'datatables.delete_dependents_one': '1 routine gebruikt deze tabel en gaat falen: {names}.',
    'datatables.delete_dependents': '{n} routines gebruiken deze tabel en gaan falen: {names}.',
    'datatables.and_more': '+{n} meer',
    'datatables.delete_type_name': 'Typ de naam van de tabel ter bevestiging.',
    'datatables.delete_confirm': 'Definitief verwijderen',
    'datatables.err_delete': 'Kon de tabel niet verwijderen',

    // ═══ De verbreding van 2026-09 ══════════════════════════════════════════
    // Filters, bewaartermijn-editor, bulk-selectie, gezondheidscontrole en de
    // uitnodigingsdialoog kwamen ná de eerste catalogus. Deze sectie dicht dat
    // gat in één keer; de coverage-test hieronder houdt hem vanaf nu dicht.

    // ── Filteren ───────────────────────────────────────────────────────────────
    'datatables.all_options': 'Alle opties',
    'datatables.filter_add': 'Voorwaarde toevoegen',
    'datatables.filter_all': 'alle voorwaarden',
    'datatables.filter_any': 'een van de voorwaarden',
    'datatables.filter_apply': 'Toepassen',
    'datatables.filter_apply_n': '{n} voorwaarden toepassen',
    'datatables.filter_clear': 'Wissen',
    'datatables.filter_empty': 'Nog geen voorwaarden.',
    'datatables.filter_field': 'Kolom om op te filteren',
    'datatables.filter_match': 'Aan alle of aan één voorwaarde voldoen',
    'datatables.filter_remove': 'Deze voorwaarde verwijderen',
    'datatables.filter_rows_that': 'Toon rijen die voldoen aan',
    'datatables.filter_test': 'Toets om toe te passen',
    'datatables.filter_value': 'Waarde om mee te vergelijken',
    'datatables.filter_value_list': 'waarde, waarde',
    'datatables.filter_value_one': 'waarde',
    'datatables.op_between': 'ligt tussen',
    'datatables.op_contains': 'bevat',
    'datatables.op_ends_with': 'eindigt op',
    'datatables.op_gt': 'is meer dan',
    'datatables.op_gte': 'is minstens',
    'datatables.op_in': 'is een van',
    'datatables.op_is_not_null': 'is ingevuld',
    'datatables.op_is_null': 'is leeg',
    'datatables.op_lt': 'is minder dan',
    'datatables.op_lte': 'is hoogstens',
    'datatables.op_neq': 'is niet',
    'datatables.op_not_contains': 'bevat niet',
    'datatables.op_not_in': 'is geen van',
    'datatables.op_starts_with': 'begint met',

    // ── Selectie en bulk-verwijderen ───────────────────────────────────────────
    'datatables.bulk_delete_body': 'Ze zijn definitief weg, in één keer — en elke routine die ze op id leest, vindt ze niet meer.',
    'datatables.bulk_delete_confirm': 'Verwijder ze',
    'datatables.bulk_delete_title': '{n} rijen verwijderen?',
    'datatables.bulk_partial': '{n} van {asked} rijen verwijderd — de rest was al weg.',
    'datatables.bulk_too_many': 'Je kunt hoogstens {limit} rijen tegelijk verwijderen.',
    'datatables.err_bulk_delete': 'Kon die rijen niet verwijderen',
    'datatables.select_all': 'Selecteer elke rij op deze pagina',
    'datatables.select_row': 'Selecteer deze rij',
    'datatables.selected_n': '{n} rijen geselecteerd',
    'datatables.selected_one': '1 rij geselecteerd',
    'datatables.selection_clear': 'Selectie wissen',
    'datatables.selection_delete': 'Selectie verwijderen',

    // ── Bewaartermijn-editor en verloop ────────────────────────────────────────
    'datatables.chip_retention': '{n} dagen bewaard',
    'datatables.col_expires': 'Verloopt',
    'datatables.err_retention': 'Kon de bewaartermijn niet wijzigen',
    'datatables.expiring_body': 'rijen verlopen in de komende {n} dagen',
    'datatables.expiring_counted_from': 'Geteld vanaf {field}.',
    'datatables.expiring_failed': 'Kon niet nagaan wat er bijna verloopt.',
    'datatables.expiring_none_set': 'rijen — er verloopt niets vanzelf',
    'datatables.expiring_title': 'Verloopt binnenkort',
    'datatables.expiry_due': 'moet weg',
    'datatables.expiry_in_days': 'over {n} dagen',
    'datatables.expiry_today': 'vandaag',
    'datatables.retention_apply': 'Toepassen',
    'datatables.retention_counted_from': 'Geteld vanaf',
    'datatables.retention_custom_label': 'Dagen',
    'datatables.retention_days': '{n} dagen',
    'datatables.retention_field': 'Datumkolom waar de leeftijd vanaf telt',
    'datatables.retention_field_required': 'Kies de datumkolom waar de leeftijd vanaf telt.',
    'datatables.retention_last_run': 'Laatst opgeruimd {when}.',
    'datatables.retention_never': 'Nooit',
    'datatables.retention_no_date_column': 'Deze tabel heeft nog geen datumkolom, dus er is niets om een leeftijd vanaf te tellen. Voeg er eerst een toe op het tabblad Kolommen.',
    'datatables.retention_no_field': 'geen kolom',
    'datatables.retention_other': 'Anders…',
    'datatables.retention_pick_field': 'Kies een datumkolom…',
    'datatables.retention_saved': 'Opgeslagen. Rijen worden {n} dagen na hun {field} verwijderd.',
    'datatables.retention_saved_off': 'Rijen blijven staan tot iets ze verwijdert.',
    'datatables.retention_title': 'Rijen worden verwijderd na',

    // ── Gezondheid en herstel ──────────────────────────────────────────────────
    'datatables.check_repair': 'Controleren & herstellen',
    'datatables.err_health': 'Kon deze tabel niet controleren',
    'datatables.err_repair': 'Kon deze tabel niet herstellen',
    'datatables.health_missing_columns': '{n} kolom(men) staan in het model maar niet in de opslag: {keys}.',
    'datatables.health_missing_table': 'De opslag voor deze tabel is nog niet aangemaakt.',
    'datatables.health_ok': 'Alles klopt: de tabel en elke kolom die erbij hoort zijn er.',
    'datatables.health_repair_blurb': 'Herstellen draait de eigen “maak aan als het ontbreekt”-statements van deze tabel opnieuw. Het voegt alleen toe — een kolom laten vallen of een rij aanraken kan het niet.',
    'datatables.health_repaired': 'Rechtgezet — de tabel en zijn kolommen zijn er nu allemaal.',
    'datatables.repair': 'Herstel het',

    // ── Uitleg bij beheerde kolommen ───────────────────────────────────────────
    'datatables.managed_hint.cache_key': 'vast · waaraan een latere run het antwoord terugvindt',
    'datatables.managed_hint.fetched_at': 'vast · de bewaartermijn telt vanaf hier',
    'datatables.managed_hint.other': 'vast · automatisch ingevuld',
    'datatables.managed_hint.request_host': 'vast · welke service is bevraagd',
    'datatables.managed_hint.request_method': 'vast · hoe het gevraagd is',
    'datatables.managed_hint.request_path': 'vast · wat er gevraagd is',
    'datatables.managed_hint.response_body': 'vast · wat de service terugstuurde',
    'datatables.managed_hint.response_headers': 'vast · wat de service over zijn antwoord meegaf',
    'datatables.managed_hint.response_status': 'vast · de antwoordcode die de service gaf',

    // ── Paginering ─────────────────────────────────────────────────────────────
    'datatables.page_next': 'Volgende pagina',
    'datatables.page_prev': 'Vorige pagina',
    'datatables.rows_page': 'pagina {p} · {n} van {total}',
    'datatables.rows_updated': 'bijgewerkt {when}',

    // ── Delen: uitnodigingsdialoog ─────────────────────────────────────────────
    'datatables.grant_add_open': 'Persoon of team toevoegen',
    'datatables.grant_grade_for': 'Wat {name} mag',
    'datatables.grantee_grade': 'Wat ze mogen',
    'datatables.grantee_kind': 'Een persoon of een groep',
    'datatables.grantee_who': 'Met wie delen',
    'datatables.group_members': '{n} mensen',
    'datatables.owner_grade': 'Eigenaar',
    'datatables.owner_row': 'eigenaar',
    'datatables.owner_unknown': 'De eigenaar',

    // ── Kolomdesigner en losse chrome ──────────────────────────────────────────
    'datatables.close': 'Sluiten',
    'datatables.col_changed': 'Gewijzigd',
    'datatables.col_head_column': 'Kolom',
    'datatables.col_head_example': 'Voorbeeld',
    'datatables.col_head_kind': 'Soort',
    'datatables.column_no_example': 'nog leeg',
    'datatables.column_own': 'je eigen kolom',
    'datatables.columns_unsaved': 'Niet-opgeslagen kolomwijzigingen',
    'datatables.detail_level': 'Hoeveel te tonen',
    'datatables.export_csv_menu': 'Exporteren (CSV)',
    'datatables.first_columns_hint': 'optioneel · kan ook later nog',
    'datatables.heading': 'Tabellen',
    'datatables.kind_word': 'tabel',
    'datatables.kindchip_http_cache': 'antwoorden van een webservice',
    'datatables.kindchip_plain': 'gewone tabel',
    'datatables.managed_status': 'De antwoordcode die de service gaf',
    'datatables.scope_word_org': 'organisatie',
    'datatables.scope_word_personal': 'alleen dit account',
    'datatables.search_short': 'Zoek een tabel…',
    'datatables.simple': 'Eenvoudig',
    'datatables.table_menu': 'Meer over deze tabel',
    'datatables.technical_name': 'Technische naam:',
    'datatables.technical_name_hint': 'aanpasbaar onder Alle opties',
    'datatables.usage_count': 'gebruikt door {n}',
    'datatables.usage_count_one': 'gebruikt door 1',
    'datatables.usage_hint': 'Nog een routine koppelen: voeg daar een Tabel-stap toe en kies deze tabel.',
    'datatables.usage_none_short': 'nog niet gebruikt',
    // Licence refusals for retention and sharing (enterprise split, 2026-10).
    'datatables.retention_locked': 'Een bewaartermijn instellen of verlengen kan met een hoger abonnement. Een termijn verkorten of uitzetten kan altijd.',
    'datatables.retention_locked_not_granted': 'Een bewaartermijn instellen of verlengen staat niet aan voor je organisatie. Vraag een beheerder. Een termijn verkorten of uitzetten kan altijd.',
    'datatables.share_not_granted': 'Een datatabel delen met collega\'s staat niet aan voor je organisatie. Vraag een beheerder. Een tabel weer privé maken kan altijd.',
};

/**
 * Keys whose Dutch IS the English string, kept out of NL_TRANSLATIONS on
 * purpose (same reasoning as add-nl-builder-redesign-translations.js): a
 * stored identical value cannot be told apart from an untranslated one, and
 * t() already falls back to English. "Filter" and "is" are the same words in
 * Dutch; "{n}+" is a placeholder with no words in it at all.
 */
const SAME_AS_ENGLISH = [
    'datatables.column_used_one_pill',
    'datatables.column_used_many_pill',
    'datatables.expiring_at_least',
    'datatables.filter',
    'datatables.filter_n',
    'datatables.op_eq'
];

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-datatables-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS, SAME_AS_ENGLISH };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-datatables-translations failed:', e.message);
        process.exit(1);
    });
}
