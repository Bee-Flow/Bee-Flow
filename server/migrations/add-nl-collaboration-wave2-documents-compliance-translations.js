#!/usr/bin/env node
// @typecheck
/**
 * Dutch for the second collaboration round (2026-09), part two: the
 * documents product (the library with folders, categories and the archive,
 * starting a document, pages written together, designed documents and
 * presentations with their tools panel, presence, "compare and choose" when
 * two saves cross, find, outline, recovery, shortcuts) and the compliance
 * checks for collaborative projects (the checks themselves, the decision on
 * a finding, the hint a project owner sees, projects in the processing
 * register, the kinds of personal data, portability and data-subject
 * discovery).
 *
 * The keys this round added to `documents` and `compliance`. Editing
 * together, versions, comments, "what changed", the AI that joins by itself
 * and notebooks are in part one,
 * add-nl-collaboration-wave2-editor-versions-translations.js.
 *
 * Terminology follows the existing Dutch catalogues: a template is a
 * sjabloon and the house style the huisstijl; slides are dia’s and a deck's
 * outline its opzet (as in the Presentation step of the automation builder);
 * a designed document is a vormgegeven document and a page a pagina. The
 * compliance words are the Compliance Center's: Vraagt aandacht,
 * Verwerkingsregister, grondslag, bewaartermijn, betrokkene (the data
 * subject), bevinding, DPIA; "Collaborative projects" is
 * Samenwerkingsprojecten wherever the admin sees it as a heading. The
 * designed-document tools panel reuses the Dutch its authors proposed, with
 * the dia’s/opzet terminology applied.
 *
 * SAME_AS_ENGLISH lists the keys whose Dutch is the English text itself
 * (Team, Label, Parameters, Document, Project). They are not seeded: t()
 * already falls back to English, and a seeded copy could not be told apart
 * from a forgotten translation if the English is reworded later.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-collaboration-wave2-documents-compliance-translations.js
 */

/** @type {Readonly<Record<string, string>>} */
const NL_TRANSLATIONS = Object.freeze({
    // ── Documents: the library ───────────────────────────────────────
    'documents.new_button': 'Nieuw document',
    'documents.library.subtitle': 'Pagina’s, vormgegeven documenten en presentaties. Eén keer ontwerpen, voor elke klant aanpassen.',
    'documents.library.views': 'Weergaven van de bibliotheek',
    'documents.library.all': 'Alle documenten',
    'documents.library.documents': 'Documenten',
    'documents.library.templates': 'Sjablonen',
    'documents.library.sections': 'Herbruikbare onderdelen',
    'documents.library.archived': 'Gearchiveerd',
    'documents.library.folders': 'Mappen',
    'documents.library.root': 'Niet in een map',
    'documents.library.up': 'Omhoog',
    'documents.library.search': 'Documenten zoeken',
    'documents.library.search_placeholder': 'Documenten zoeken…',
    'documents.library.type': 'Soort document',
    'documents.library.type_all': 'Alle soorten',
    'documents.library.type_pages': 'Pagina’s',
    'documents.library.type_designed': 'Vormgegeven documenten',
    'documents.library.type_presentations': 'Presentaties',
    'documents.library.visibility': 'Zichtbaarheid',
    'documents.library.visibility_all': 'Privé en team',
    'documents.library.visibility_private': 'Privé',
    'documents.library.category': 'Categorie',
    'documents.library.category_placeholder': 'Filteren op categorie',
    'documents.library.categories': 'Categorieën',
    'documents.library.categories_placeholder': 'Categorieën, gescheiden door komma’s',
    'documents.library.set_categories': 'Categorieën instellen',
    'documents.library.sort': 'Sorteren',
    'documents.library.sort_name': 'Naam',
    'documents.library.sort_updated': 'Onlangs bijgewerkt',
    'documents.library.select': '{name} selecteren',
    'documents.library.selected': '{count} geselecteerd',
    'documents.library.clear_selection': 'Selectie wissen',
    'documents.library.edited_by': 'bewerkt door {name}',
    'documents.library.duplicate': 'Een kopie maken van {name}',
    'documents.library.move': 'Naar map verplaatsen',
    'documents.library.move_to': 'Verplaatsen naar…',
    'documents.library.new_folder': 'Nieuwe map',
    'documents.library.new_folder_name': 'Naam van de nieuwe map',
    'documents.library.create_folder': 'Map maken',
    'documents.library.delete_folder': 'Map {name} verwijderen',
    'documents.library.delete_folder_title': 'Deze map verwijderen?',
    'documents.library.delete_folder_desc': 'De documenten en mappen in “{name}” gaan één niveau omhoog. Verder wordt er niets verwijderd.',
    'documents.library.delete_folder_confirm': 'Map verwijderen',
    'documents.library.archive': '{name} archiveren',
    'documents.library.archive_title': 'Dit document archiveren?',
    'documents.library.archive_desc': '“{name}” verdwijnt uit je bibliotheek en uit elk project waarin het staat. Je kunt het terugzetten vanuit Gearchiveerd; automatiseringen die een opgeslagen versie gebruiken, blijven werken.',
    'documents.library.archive_confirm': 'Archiveren',
    'documents.library.archive_empty': 'Niets gearchiveerd',
    'documents.library.archive_empty_desc': 'Documenten die je archiveert, wachten hier tot je ze terugzet.',
    'documents.library.unarchive': '{name} terugzetten',
    'documents.library.empty_title': 'Hier nog geen documenten',
    'documents.library.empty_desc': 'Begin met een sjabloon, schrijf een pagina, of vraag de assistent in een chat om er een op te stellen.',
    'documents.library.no_matches': 'Niets komt overeen met deze filters.',
    'documents.library.loading': 'Documenten laden…',
    'documents.library.load_failed': 'De documenten konden niet worden geladen.',
    'documents.library.action_failed': 'Dat is niet gelukt. Probeer het opnieuw.',

    // ── Documents: starting one, kinds, in a project ─────────────────
    'documents.new.title': 'Een document beginnen',
    'documents.new.page': 'Pagina',
    'documents.new.page_hint': 'Vrij schrijven, in een project samen in realtime. Wordt afgedrukt in de huisstijl.',
    'documents.new.blank_designed': 'Leeg vormgegeven document',
    'documents.new.designed_hint': 'Een opgemaakt document met velden die een automatisering kan invullen.',
    'documents.new.blank_deck': 'Lege presentatie',
    'documents.new.presentations': 'Presentaties',
    'documents.new.presentations_hint': 'Dia’s in de huisstijl: een opzet die je typt, hier bekeken en gedownload als PowerPoint of PDF.',
    'documents.new.templates': 'Vanuit een sjabloon',
    'documents.new.parameters': '{count} velden om in te vullen',
    'documents.new.loading': 'Sjablonen laden…',
    'documents.new.load_failed': 'De sjablonen konden niet worden geladen.',
    'documents.type.page': 'Pagina',
    'documents.type.presentation': 'Presentatie',
    'documents.type.security': 'Beveiligingsverklaring',
    'documents.untitled_page': 'Naamloze pagina',
    'documents.untitled_deck': 'Naamloze presentatie',
    'documents.project.type_page': 'Pagina',
    'documents.project.type_page_desc': 'Samen schrijven in realtime. Wordt afgedrukt in de huisstijl.',
    'documents.project.type_designed': 'Vormgegeven document',
    'documents.project.type_designed_desc': 'Een opgemaakte brief, rapport of offerte, met velden die een automatisering kan invullen.',
    'documents.project.type_deck_desc': 'Dia’s in de huisstijl, getypt als opzet.',
    'documents.project.col_changed': 'Laatst gewijzigd',
    'documents.project.unread': 'Gewijzigd sinds je laatst keek',

    // ── Documents: opening, saving, reading along ────────────────────
    'documents.loading': 'Het document wordt geopend…',
    'documents.load_failed': 'Het document kon niet worden geladen.',
    'documents.retry': 'Opnieuw proberen',
    'documents.canvas.loading': 'Het document wordt geladen…',
    'documents.canvas.no_answer': 'De editor reageerde niet. Probeer het opnieuw.',
    'documents.read_only': 'Je kunt dit document lezen. Alleen de eigenaar en de bewerkers van het project kunnen het wijzigen.',
    'documents.page.placeholder': 'Begin met schrijven. Typ # en een spatie voor een kop, - voor een lijst.',
    'documents.page.live_hint': 'Iedereen in het project ziet wijzigingen terwijl ze worden getypt.',
    'documents.page.live_kept': 'Deze pagina werd live bewerkt terwijl je tekst werd opgeslagen. Wat je typte, is bewaard in de versiegeschiedenis.',
    'documents.page.live_kept_open': 'Geschiedenis openen',
    'documents.page.live_reload': 'Deze pagina wordt nu live bewerkt. Laad haar opnieuw om mee te doen; wat je typte, is bewaard in de versiegeschiedenis.',
    'documents.edit_hint_short': 'Geplakte tekst komt binnen als platte tekst, zodat de indeling intact blijft.',
    'documents.mode.label': 'Modus',
    'documents.mode.viewing': 'Bekijken',
    'documents.mode.editing': 'Bewerken',
    'documents.mode.editing_outline': 'Opzet',
    'documents.save.saving': 'Opslaan…',
    'documents.save.saved_ago': 'Opgeslagen {time}',
    'documents.save.unsaved': 'Niet-opgeslagen wijzigingen',
    'documents.save.failed_retry': 'Niet opgeslagen: opnieuw proberen',
    'documents.save.needs_choice': 'Door iemand anders gewijzigd: kies',
    'documents.status.words': '{count} woorden',
    'documents.status.one_page': 'ongeveer 1 pagina',
    'documents.status.pages': 'ongeveer {count} pagina’s',
    'documents.status.slides': '{count} dia’s',
    'documents.print': 'Afdrukken',
    'documents.print_hint': 'Opent de PDF met zijn pagina-einden, klaar om af te drukken',
    'documents.comments': 'Opmerkingen',
    'documents.history_title': 'Versiegeschiedenis',

    // ── Documents: presence and two saves that cross ─────────────────
    'documents.presence.label': 'Ook hier',
    'documents.presence.someone': 'Iemand',
    'documents.presence.viewing': '{name} kijkt mee',
    'documents.presence.editing': '{name} is aan het bewerken',
    'documents.presence.editing_section': '{name} bewerkt {section}',
    'documents.presence.frame_label': '{name} is aan het bewerken',
    'documents.presence.same_section': '{name} bewerkt ook {section}. Typ gewoon door: je wijzigingen worden samengevoegd als je opslaat, en als jullie allebei dezelfde zin wijzigen, kies je welke je houdt.',
    'documents.person.you': 'Jij',
    'documents.person.former': 'Voormalig lid',
    'documents.merged': 'Wijzigingen die iemand anders intussen had opgeslagen, zijn samengevoegd met die van jou.',
    'documents.merged_show': 'Tonen',
    'documents.conflict.title': 'Vergelijken en kiezen',
    'documents.conflict.open': 'Vergelijken en kiezen',
    'documents.conflict.notice': 'Iemand anders heeft hetzelfde deel gewijzigd terwijl jij typte. Er gaat niets verloren: vergelijk de twee en kies.',
    'documents.conflict.intro': 'Iemand anders heeft wijzigingen in hetzelfde deel opgeslagen terwijl jij aan het bewerken was. Al het andere is samengevoegd. Kies per deel welke tekst je houdt.',
    'documents.conflict.untitled_part': 'Een deel van het document',
    'documents.conflict.yours': 'Jouw versie',
    'documents.conflict.theirs': 'Intussen opgeslagen',
    'documents.conflict.removed': 'Verwijderd',
    'documents.conflict.all_mine': 'Alles van mij houden',
    'documents.conflict.all_theirs': 'Alles van de ander overnemen',
    'documents.conflict.discard_mine': 'Mijn wijzigingen weggooien',
    'documents.conflict.save': 'Mijn keuzes opslaan',
    'documents.recovery.found': 'Wijzigingen die niet waren opgeslagen, zijn bewaard.',
    'documents.recovery.found_at': 'Niet-opgeslagen wijzigingen van {time} zijn bewaard.',
    'documents.recovery.restore': 'Terugzetten',
    'documents.recovery.compare': 'Vergelijken',
    'documents.recovery.discard': 'Weggooien',

    // ── Documents: find, outline, shortcuts ──────────────────────────
    'documents.find.label': 'Zoeken in document',
    'documents.find.placeholder': 'Zoeken in document…',
    'documents.find.count': '{index} van {count}',
    'documents.find.none': 'Geen resultaten',
    'documents.find.previous': 'Vorig resultaat',
    'documents.find.next': 'Volgend resultaat',
    'documents.find.close': 'Zoeken sluiten',
    'documents.outline.title': 'Structuur',
    'documents.outline.empty': 'Koppen en onderdelen verschijnen hier terwijl je ze schrijft.',
    'documents.outline.untitled': 'Naamloos onderdeel',
    'documents.outline.close': 'De structuur sluiten',
    'documents.shortcuts.title': 'Sneltoetsen',
    'documents.shortcuts.save': 'Nu opslaan',
    'documents.shortcuts.find': 'Zoeken in het document',
    'documents.shortcuts.comment': 'Opmerking bij de selectie plaatsen',
    'documents.shortcuts.history': 'Versiegeschiedenis',
    'documents.shortcuts.escape': 'Zoeken sluiten, of stoppen met bewerken',
    'documents.shortcuts.help': 'Deze lijst',

    // ── Documents: writing a presentation outline ────────────────────
    // The syntax on the left of the cheat sheet (type:, labels:, closing,
    // cards, dark, <!-- chart: bar -->) is what the parser reads, so it
    // stays as it is; only the explanation is Dutch.
    'documents.deck.outline_label': 'Opzet van de dia’s',
    'documents.deck.how_to': 'Zo schrijf je dia’s',
    'documents.deck.placeholder_title': 'Titel',
    'documents.deck.placeholder_slide': 'Eerste dia',
    'documents.deck.placeholder_point': 'een punt',
    'documents.deck.row_title': 'titel van het voorblad (één keer)',
    'documents.deck.row_slide': 'één dia per kop',
    'documents.deck.row_bullet': 'opsommingstekens; twee spaties = subpunt',
    'documents.deck.row_card': '2 tot 6 kaarten per dia, met een Lucide-pictogram',
    'documents.deck.row_chart': 'type: bar · labels: Q1, Q2 · Omzet: 10, 20',
    'documents.deck.row_stats': 'één KPI-tegel per regel: waarde | label | verschil',
    'documents.deck.row_table': 'een tabel (ook als grafiek: <!-- chart: bar -->)',
    'documents.deck.row_quote': 'een citaatdia',
    'documents.deck.row_layout': 'opsommingstekens als stappen; ook closing, cards',
    'documents.deck.row_style': 'een nadrukdia (of dark)',
    'documents.deck.row_notes': 'sprekersnotities bij de dia',
    'documents.deck.row_placeholder': 'een placeholder die een automatisering invult',

    // ── Designed documents: the tools panel ──────────────────────────
    'documents.tools.label': 'Documenthulpmiddelen',
    'documents.tools.sections': 'Onderdelen',
    'documents.tools.look': 'Uiterlijk',
    'documents.tools.design': 'Vormgeving',
    'documents.tools.assistant': 'AI-assistent',
    'documents.tools.preview': 'Klantvoorbeeld',
    'documents.workspace.sections': 'Onderdelen',
    'documents.workspace.look': 'Uiterlijk',
    'documents.workspace.design': 'Vormgeving',
    'documents.workspace.ai_assistant': 'AI-assistent',
    'documents.workspace.customer_preview': 'Klantvoorbeeld',
    'documents.workspace.close': 'Sluiten',

    // ── Designed documents: parameters and conditions ────────────────
    'documents.workspace.add_parameter': 'Parameter toevoegen',
    'documents.workspace.new_parameter': 'Nieuwe parameter',
    'documents.workspace.remove_parameter': 'Parameter verwijderen',
    'documents.workspace.parameter_key': 'Parametersleutel',
    'documents.workspace.type': 'Soort',
    'documents.workspace.required_when_applicable': 'Verplicht indien van toepassing',
    'documents.workspace.short_explanation': 'Korte uitleg',
    'documents.workspace.instructions_for_people_and_ai': 'Instructies voor mensen en AI',
    'documents.workspace.choices_one_per_line': 'Keuzes (één per regel)',
    'documents.workspace.example': 'Voorbeeld',
    'documents.workspace.default_optional': 'Standaardwaarde (optioneel)',
    'documents.workspace.yes': 'Ja',
    'documents.workspace.no': 'Nee',
    'documents.workspace.add_list_field': 'Lijstveld toevoegen',
    'documents.workspace.remove_row': 'Rij verwijderen',
    'documents.workspace.row': 'Rij',
    'documents.workspace.insert_into_document': 'Invoegen in document',
    'documents.workspace.add_condition': 'Voorwaarde toevoegen',
    'documents.workspace.remove_condition': 'Voorwaarde verwijderen',
    'documents.workspace.condition_group': 'Voorwaardengroep',
    'documents.workspace.all_conditions': 'Alle voorwaarden',
    'documents.workspace.any_condition': 'Minstens één voorwaarde',
    'documents.workspace.rule': 'Regel',
    'documents.workspace.group': 'Groep',
    'documents.workspace.condition_parameter': 'Voorwaardeparameter',
    'documents.workspace.choose_parameter': 'Kies een parameter',
    'documents.workspace.comparison': 'Vergelijking',
    'documents.workspace.equals': 'Is gelijk aan',
    'documents.workspace.does_not_equal': 'Is niet gelijk aan',
    'documents.workspace.contains': 'Bevat',
    'documents.workspace.greater_than': 'Groter dan',
    'documents.workspace.less_than': 'Kleiner dan',
    'documents.workspace.is_set': 'Is ingevuld',

    // ── Designed documents: sections, instructions, library ──────────
    'documents.workspace.instructions': 'Instructies',
    'documents.workspace.document_instructions': 'Documentinstructies',
    'documents.workspace.instructions_need_review': 'Instructies moeten worden gecontroleerd',
    'documents.workspace.choose_when_each_section_applies': 'Bepaal wanneer elk onderdeel van toepassing is. Onbekende klantgegevens moeten vóór de definitieve PDF worden ingevuld.',
    'documents.workspace.find_in_document': 'Tonen in document',
    'documents.workspace.title': 'Titel',
    'documents.workspace.summary': 'Samenvatting',
    'documents.workspace.new_section': 'Nieuw onderdeel',
    'documents.workspace.add_section': 'Onderdeel toevoegen',
    'documents.workspace.write_your_content_here': 'Schrijf hier de inhoud.',
    'documents.workspace.choose_section': 'Kies een onderdeel…',
    'documents.workspace.insert_reusable_content': 'Herbruikbare inhoud invoegen',
    'documents.workspace.save_to_section_library': 'Opslaan in onderdelenbibliotheek',
    'documents.workspace.section_saved_to_your_library': 'Onderdeel opgeslagen in je bibliotheek',
    'documents.workspace.linked_revision': 'Gekoppelde versie',
    'documents.workspace.update_available': 'Update beschikbaar',
    'documents.workspace.review_changes': 'Wijzigingen bekijken',
    'documents.workspace.automatic_rules': 'Automatisch (regels)',
    'documents.workspace.include': 'Opnemen',
    'documents.workspace.exclude': 'Weglaten',
    'documents.workspace.included': 'Opgenomen',
    'documents.workspace.excluded': 'Weggelaten',
    'documents.workspace.needs_input': 'Invoer nodig',
    'documents.workspace.library_type': 'Bibliotheektype',
    'documents.workspace.presentation': 'Presentatie',
    'documents.workspace.template': 'Sjabloon',
    'documents.workspace.reusable_section': 'Herbruikbaar onderdeel',
    'documents.workspace.visibility': 'Zichtbaarheid',
    'documents.workspace.private': 'Privé',
    'documents.workspace.team_library': 'Teambibliotheek',
    'documents.workspace.save_a_copy_as_template': 'Kopie opslaan als sjabloon',
    'documents.workspace.template_saved': 'Sjabloon opgeslagen',

    // ── Designed documents: look, design, preview ────────────────────
    'documents.workspace.every_choice_here_applies_to_this': 'Elke keuze hier geldt alleen voor deze presentatie; wat op “Huisstijl” blijft staan, volgt de stijl van de organisatie. De dia’s worden opnieuw getekend terwijl je kiest.',
    'documents.workspace.preset': 'Voorinstelling',
    'documents.workspace.accent_color': 'Accentkleur',
    'documents.workspace.text_color': 'Tekstkleur',
    'documents.workspace.font': 'Lettertype',
    'documents.workspace.font_size': 'Lettergrootte',
    'documents.workspace.line_spacing': 'Regelafstand',
    'documents.workspace.page_margins_mm': 'Paginamarges (mm)',
    'documents.workspace.logo_width_mm': 'Logobreedte (mm)',
    'documents.workspace.paper_size': 'Papierformaat',
    'documents.workspace.logo_position': 'Logopositie',
    'documents.workspace.show_header': 'Koptekst tonen',
    'documents.workspace.show_footer': 'Voettekst tonen',
    'documents.workspace.preview_design_changes': 'Wijzigingen in de vormgeving bekijken',
    'documents.workspace.for_custom_layouts_ask_the_ai': 'Vraag de AI-assistent bij een eigen opmaak om de stylesheet om te zetten naar deze instellingen. Bekijk het voorbeeld voordat je het toepast.',
    'documents.workspace.customer_values_are_stored_on_this': 'Klantgegevens worden opgeslagen in dit privédocument.',
    'documents.workspace.sample_data_is_used_only_for_this': 'Voorbeeldgegevens worden alleen voor dit voorbeeld gebruikt en nooit in een gedeeld sjabloon opgeslagen.',
    'documents.workspace.validate_preview': 'Controleren en bekijken',
    'documents.workspace.open_preview': 'Voorbeeld openen',
    'documents.workspace.ready_to_generate': 'Klaar om te genereren',
    'documents.workspace.draft_input_required': 'Concept: invoer nodig',
    'documents.workspace.unsaved_settings_recovered_review': 'Niet-opgeslagen instellingen hersteld. Controleer ze voordat je opslaat.',
    'documents.workspace.save_recovered_copy': 'Herstelde kopie opslaan',
    'documents.workspace.recovered_copy_saved': 'Herstelde kopie opgeslagen',
    'documents.workspace.discard_recovered_changes': 'Herstelde wijzigingen weggooien',

    // ── Designed documents: the AI assistant ─────────────────────────
    'documents.workspace.what_would_you_like_to_change': 'Wat wil je aanpassen?',
    'documents.workspace.make_this_more_professional_with_a': 'Maak dit professioneler, met een duidelijk voorblad en compacte tabellen…',
    'documents.workspace.assistant_mode': 'Assistentmodus',
    'documents.workspace.look_only': 'Alleen uiterlijk',
    'documents.workspace.design_only': 'Alleen vormgeving',
    'documents.workspace.slides_and_outline': 'Dia’s en opzet',
    'documents.workspace.content_and_template': 'Inhoud en sjabloon',
    'documents.workspace.suggest_applicable_sections': 'Toepasselijke onderdelen voorstellen',
    'documents.workspace.prepare_a_proposal': 'Voorstel maken',
    'documents.workspace.review_proposal': 'Voorstel controleren',
    'documents.workspace.proposed_document': 'Voorgesteld document',
    'documents.workspace.apply_reviewed_changes': 'Gecontroleerde wijzigingen toepassen',
    'documents.workspace.save_changes': 'Wijzigingen opslaan',

    // ── Compliance: the project checks ───────────────────────────────
    'compliance.checks.gdpr_project_access.title': 'Projectleden horen bij de organisatie',
    'compliance.checks.gdpr_project_access.desc': 'Elk lid en elke groep van een samenwerkingsproject kan de chats, documenten, notitieboeken en bestanden ervan lezen. Het moeten actuele accounts en groepen van de eigen organisatie van het project zijn: een lid uit een andere organisatie, een account dat is vertrokken of een groep die niet meer bestaat, is toegang waar niemand op let.',
    'compliance.checks.gdpr_project_access.fix': 'Open de pagina Leden van het betreffende project en verwijder de lidmaatschappen die hier worden genoemd. De automatische fix verwijdert alleen lidmaatschappen waarvan het account of de groep niet meer bestaat; over een geschorst account en een lid uit een andere organisatie beslis je zelf.',
    'compliance.checks.gdpr_project_personal_data.title': 'Projecten met persoonsgegevens hebben een verwerkingsregistratie',
    'compliance.checks.gdpr_project_personal_data.desc': 'Projecten waarin het Privacy Shield persoonsgegevens vond (in bestanden, notitieboeken, gedeelde chats, AI-aanroepen of een scan van hun documenten) zijn verwerkingsactiviteiten. Voor elk ervan moeten een doel en een grondslag zijn vastgelegd, en bij bijzondere persoonsgegevens (gezondheid, identiteitsnummers) des te meer. Om dit te bepalen wordt geen projectinhoud gelezen.',
    'compliance.checks.gdpr_project_personal_data.fix': 'Open Compliance → Verwerkingsregister, zoek het project onder Samenwerkingsprojecten en leg het doel, de grondslag en de bewaartermijn vast.',
    'compliance.checks.iso_project_orphaned_content.title': 'Projecten en hun inhoud hebben een eigenaar die er nog is',
    'compliance.checks.iso_project_orphaned_content.desc': 'Alleen de eigenaar van een project beheert wie er toegang heeft. Vertrekt de eigenaar, dan kan niemand het project meer besturen. Chats die in een project zijn gedeeld en projectnotitieboeken van mensen die zijn vertrokken, zijn kleinere vormen van hetzelfde probleem.',
    'compliance.checks.iso_project_orphaned_content.fix': 'Activeer de vertrokken eigenaar lang genoeg om het project over te dragen, of archiveer het project. Een chat die is gedeeld door iemand die is vertrokken, is versleuteld met diens sleutel: die kan niet aan iemand anders worden gegeven, alleen worden gearchiveerd of verwijderd.',
    'compliance.checks.gdpr_project_retention.title': 'Ongebruikte projecten met persoonsgegevens worden niet eeuwig bewaard',
    'compliance.checks.gdpr_project_retention.desc': 'Een project met persoonsgegevens dat langer niet is gebruikt dan je organisatie projectgegevens bewaart, hoort te worden gearchiveerd, geëxporteerd of verwijderd, of de reden om het te bewaren moet zijn vastgelegd. De termijn komt uit de eigen verwerkingsregistratie van het project, anders uit de instelling voor de bewaartermijn van projecten, anders is het 365 dagen.',
    'compliance.checks.gdpr_project_retention.fix': 'Archiveer, exporteer of verwijder het project, of bevestig deze bevinding met een reden (bijvoorbeeld een juridische bewaarplicht) en een datum voor herbeoordeling. Stel de termijn in onder Compliance → Instellingen.',
    'compliance.checks.gdpr_project_files_unscanned.title': 'Projectbestanden zijn gecontroleerd op persoonsgegevens',
    'compliance.checks.gdpr_project_files_unscanned.desc': 'Bestanden die in een project worden geüpload, worden gescand door het Privacy Shield. Een bestand waarvan de scan niet kon worden afgerond, blijft bewaard en wordt gemarkeerd als niet gecontroleerd. Een upload wordt later niet opnieuw ververst, dus zo blijft het, terwijl de AI van elk lid eruit kan citeren.',
    'compliance.checks.gdpr_project_files_unscanned.fix': 'Voer de automatische fix uit om die bestanden opnieuw te scannen zodra de detector voor persoonsgegevens beschikbaar is. Hij werkt per keer een begrensde hoeveelheid af.',
    'compliance.checks.gdpr_project_ai_participation.title': 'AI die uit zichzelf meedoet in projectgesprekken is beoordeeld',
    'compliance.checks.gdpr_project_ai_participation.desc': 'Waar de AI uit zichzelf antwoordt (altijd, of wanneer hij dat zelf besluit), leest hij wat leden schrijven zonder dat het hem wordt gevraagd. In een project met gezondheids- of identiteitsgegevens vraagt die verwerking om een gegevensbeschermingseffectbeoordeling (DPIA), en zonder het Privacy Shield leest hij onbewerkte persoonsgegevens.',
    'compliance.checks.gdpr_project_ai_participation.fix': 'Leg een DPIA vast voor de agent van het gesprek, voor het project of voor autonome AI in projecten als geheel, of zet het gesprek op “AI antwoordt bij vermelding” (de automatische fix doet dat voor de teamchats die niet voldoen).',
    'compliance.checks.aia_project_ai_edits.title': 'Wijzigingen die de AI in projecten schreef, worden aan de AI toegeschreven',
    'compliance.checks.aia_project_ai_edits.desc': 'De versiegeschiedenis van projectdocumenten en notitieboeken legt vast wie elke versie schreef. Een versie die de AI schreef, moet de AI bij de bijdragers noemen, zodat machinaal geschreven tekst nooit wordt gepresenteerd als tekst van een persoon.',
    'compliance.checks.aia_project_ai_edits.fix': 'Niets in te stellen: dit is een garantie van het product. Faalt deze check, meld het dan: de versiegeschiedenis heeft een wijziging van de AI vastgelegd zonder de auteur ervan.',
    'compliance.settings.project_retention_days': 'Projectbewaartermijn (dagen)',
    'compliance.settings.project_retention_days_hint': 'Hoe lang een samenwerkingsproject ongebruikt mag blijven terwijl het persoonsgegevens bevat. Leeg betekent 365 dagen.',
    'compliance.settings.project_owner_hints_enabled': 'Projecteigenaren één vriendelijke tip tonen waar ze iets mee kunnen',
    'compliance.settings.project_owner_hints_enabled_hint': 'Hooguit één suggestie per project, die ze kunnen verbergen: leden van buiten, accounts die weg zijn, niet gecontroleerde bestanden. Nooit over persoonsgegevens in het project; dat blijft bij jou.',

    // ── Compliance: deciding about a finding ─────────────────────────
    'compliance.finding_state.heading': 'Jouw besluit',
    'compliance.finding_state.group_aria': 'Beslissen over deze bevinding',
    'compliance.finding_state.explain': 'Haalt deze bevinding uit Vraagt aandacht zolang ze precies hetzelfde blijft. Ze komt terug als ze verandert.',
    'compliance.finding_state.acknowledge': 'Bevestigen',
    'compliance.finding_state.acknowledged': 'Bevestigd',
    'compliance.finding_state.accept_risk': 'Risico accepteren…',
    'compliance.finding_state.accepted_risk': 'Risico geaccepteerd',
    'compliance.finding_state.snooze_7': '7 dagen uitstellen',
    'compliance.finding_state.snooze_30': '30 dagen uitstellen',
    'compliance.finding_state.snooze': 'Uitstellen',
    'compliance.finding_state.snooze_7_short': '7 dagen',
    'compliance.finding_state.snooze_30_short': '30 dagen',
    'compliance.finding_state.snoozed': 'Uitgesteld tot {date}',
    'compliance.finding_state.lapsed': 'Je besluit geldt niet meer: de bevinding is veranderd',
    'compliance.finding_state.reopen': 'Heropenen',
    'compliance.finding_state.reason_label': 'Waarom wordt dit risico geaccepteerd?',
    'compliance.finding_state.reason_placeholder': 'Bijvoorbeeld: juridische bewaarplicht tot de zaak is afgerond',
    'compliance.finding_state.reason_short': 'Schrijf een reden van minstens 3 tekens.',
    'compliance.finding_state.reason': 'Reden: {reason}',
    'compliance.finding_state.review_by': 'Herbeoordelen vóór (optioneel)',
    'compliance.finding_state.review_by_range': 'Kies een dag tussen morgen en een jaar vanaf vandaag.',
    'compliance.finding_state.save': 'Risico accepteren',
    'compliance.finding_state.saving': 'Opslaan…',
    'compliance.finding_state.cancel': 'Annuleren',
    'compliance.finding_state.failed': 'Het besluit kon niet worden opgeslagen.',
    'compliance.finding_state.error_not_open': 'Deze bevinding staat niet meer open, dus er valt niets te besluiten. De lijst toont de huidige stand.',
    'compliance.finding_state.error_framework_off': 'Deze controle hoort bij een raamwerk dat niet actief is voor je organisatie.',
    'compliance.finding_state.error_unknown_check': 'Deze controle bestaat niet meer.',
    'compliance.finding_state.error_invalid': 'Het besluit is geweigerd. Controleer de reden en kies een datum tussen morgen en een jaar vanaf vandaag om te herbeoordelen.',
    'compliance.finding_state.error_forbidden': 'Alleen een compliancebeheerder kan over bevindingen besluiten.',
    'compliance.tbl_open_subject': 'Het betreffende item openen',
    'compliance.attention_subjects': '{n} getroffen',
    'compliance.attention_open_subject': 'Openen',

    // ── Compliance: the hint a project owner sees ────────────────────
    'compliance.project_hint.aria': 'Suggestie voor dit project',
    'compliance.project_hint.project_foreign_members': 'Leden van buiten je organisatie ({count})',
    'compliance.project_hint.project_dangling_members': 'Lidmaatschappen van accounts of groepen die niet meer bestaan ({count})',
    'compliance.project_hint.project_orphaned_content': 'Items van mensen die zijn vertrokken ({count})',
    'compliance.project_hint.project_files_unscanned': 'Bestanden die nog niet op persoonsgegevens zijn gecontroleerd ({count})',
    'compliance.project_hint.review': 'Bekijken',
    'compliance.project_hint.snooze_7': 'Herinner me over 7 dagen',
    'compliance.project_hint.snooze_30': 'Herinner me over 30 dagen',
    'compliance.project_hint.dismiss': 'Verbergen',
    'compliance.project_hint.failed': 'Dat is niet opgeslagen. Probeer het opnieuw.',

    // ── Compliance: projects in the processing register ──────────────
    'compliance.ropa_projects.title': 'Samenwerkingsprojecten',
    'compliance.ropa_projects.desc': 'Projecten waarin signalen op persoonsgegevens wijzen, en elk project met een registratie. Leg het doel, de grondslag en de bewaartermijn vast; vastgelegde projecten verschijnen in het register hierboven.',
    'compliance.ropa_projects.loading': 'Projecten lezen…',
    'compliance.ropa_projects.failed': 'De projecten konden niet worden gelezen.',
    'compliance.ropa_projects.partial': 'Sommige signalen konden niet worden gelezen, dus deze lijst is mogelijk onvolledig.',
    'compliance.ropa_projects.empty': 'Volgens de laatste signalen bevat geen enkel project persoonsgegevens.',
    'compliance.ropa_projects.col_kinds': 'Persoonsgegevens',
    'compliance.ropa_projects.col_record': 'Verwerkingsregistratie',
    'compliance.ropa_projects.no_record': 'Nog geen',
    'compliance.ropa_projects.special': 'Bijzondere categorie',
    'compliance.ropa_projects.record': 'Vastleggen',
    'compliance.ropa_projects.edit': 'Bewerken',
    'compliance.ropa_projects.form_aria': 'Verwerkingsregistratie voor {name}',
    'compliance.ropa_projects.purpose': 'Doel',
    'compliance.ropa_projects.lawful_basis': 'Grondslag',
    'compliance.ropa_projects.choose_basis': 'Kies een grondslag',
    'compliance.ropa_projects.retention': 'Bewaren gedurende (dagen, optioneel)',
    'compliance.ropa_projects.save': 'Registratie opslaan',
    'compliance.ropa_projects.saving': 'Opslaan…',
    'compliance.ropa_projects.remove': 'Registratie verwijderen',
    'compliance.ropa_projects.cancel': 'Annuleren',
    'compliance.ropa_projects.save_failed': 'De registratie kon niet worden opgeslagen.',
    'compliance.ropa_projects.confirmed': '{basis} · bevestigd {date}',
    'compliance.pd_kind.name': 'Namen',
    'compliance.pd_kind.email': 'E-mailadressen',
    'compliance.pd_kind.phone': 'Telefoonnummers',
    'compliance.pd_kind.address': 'Adressen',
    'compliance.pd_kind.id_number': 'Identiteitsnummers',
    'compliance.pd_kind.financial': 'Bank- en betaalgegevens',
    'compliance.pd_kind.birth': 'Geboortedata',
    'compliance.pd_kind.health': 'Gezondheidsgegevens',
    'compliance.pd_kind.online_id': 'Online-identificatoren',
    'compliance.pd_kind.supplier': 'Contactpersonen van leveranciers',
    'compliance.pd_kind.personal': 'Persoonsgegevens',

    // ── Compliance: portability and data-subject discovery ───────────
    'compliance.pf_kind_team_chats': 'Teamchats',
    'compliance.pf_kind_project_files': 'Projectbestanden',
    'compliance.pf_kind_studio_documents': 'Documenten',
    'compliance.pf_kind_project_workspaces': 'Projectwerkruimtes',
    'compliance.pf_kind_project_comments': 'Opmerkingen in projecten',
    'compliance.pf_kind_notebook_versions': 'Versiegeschiedenis van notitieboeken',
    'compliance.pf_gap_team_chats': 'Nog geen exportroute: teamchats kunnen niet worden meegenomen.',
    'compliance.pf_gap_project_files': 'Nog geen bulkexport: bestanden die in projecten zijn geüpload, kunnen niet samen worden meegenomen.',
    'compliance.pf_gap_studio_documents': 'Er bestaat alleen een PDF-weergave, en een weergave is geen overdraagbare export.',
    'compliance.pf_gap_project_workspaces': 'Er bestaat nog geen export van een heel project (leden, instructies, activiteit).',
    'compliance.pf_gap_project_comments': 'Nog geen exportroute: opmerkingen bij notitieboeken en documenten in projecten kunnen niet worden meegenomen.',
    'compliance.pf_gap_notebook_versions': 'Alleen het huidige notitieboek kan worden geëxporteerd; de eerdere versies ervan kunnen niet worden meegenomen.',
    'compliance.dsr_discovery_project_participation': 'Samenwerkingsprojecten',
    'compliance.dsr_discovery_project_memberships': 'Projectlidmaatschappen',
    'compliance.dsr_discovery_project_owned_projects': 'Projecten waarvan de betrokkene eigenaar is',
    'compliance.dsr_discovery_project_shared_chats': 'Chats die de betrokkene in een project heeft gedeeld',
    'compliance.dsr_discovery_project_project_notebooks': 'Projectnotitieboeken van de betrokkene',
    'compliance.dsr_discovery_project_project_documents': 'Projectdocumenten van de betrokkene',
    'compliance.dsr_discovery_project_project_comments': 'Opmerkingen die de betrokkene in projecten schreef',
    'compliance.dsr_discovery_not_scanned_team_chats': 'Teamchatberichten worden niet doorzocht op deze persoon: ze zijn verzegeld met de projectsleutel. Het aantal telt de berichten die de betrokkene schreef.',
    'compliance.dsr_discovery_not_scanned_project_comments': 'Opmerkingen in projecten worden niet doorzocht op deze persoon: ze zijn verzegeld met de projectsleutel. Het aantal telt de opmerkingen die de betrokkene schreef.',
    'compliance.dsr_discovery_not_scanned_co_edited_documents': 'Samen bewerkte projectdocumenten en notitieboeken worden niet doorzocht op deze persoon.',
    'compliance.dsr_found_team_chat': '{n} teamchatberichten die de betrokkene schreef',
    'compliance.dsr_found_projects': '{n} projectitems',
});

/**
 * Keys whose Dutch IS the English string: Team, Label, Parameters, Document
 * and Project are the Dutch words too, and "{time} · {name}" and
 * "In: {section}" are placeholders around punctuation. Kept out of
 * NL_TRANSLATIONS on purpose; the test uses this list to tell "deliberately
 * identical" from "forgotten".
 */
const SAME_AS_ENGLISH = Object.freeze([
    'documents.library.team',
    'documents.project.changed_by',
    'documents.status.in_section',
    'documents.tools.parameters',
    'documents.workspace.document',
    'documents.workspace.label',
    'documents.workspace.parameters',
    'compliance.ropa_projects.col_project',
]);

/**
 * Seeds the catalogue into the Dutch strings. The store is a parameter so the
 * test can hand in a recorder instead of reaching into the module system;
 * the boot ladder calls up() without arguments and gets the real one.
 *
 * @param {{ languageStore?: { addMissingGUITranslations: (locale: string, translations: Record<string, string>) => Promise<{ added: number }> } }} [deps]
 * @returns {Promise<{ added: number }>}
 */
async function up({ languageStore = require('../stores/languageStore') } = {}) {
    // Atomic across replicas (advisory lock in mutateConfig); existing values
    // win, only missing keys are added.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-collaboration-wave2-documents-compliance-translations: added ${added} NL keys`);
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
