#!/usr/bin/env node
/**
 * Dutch for the automation BUILDER redesign (Track R of the 2026-09 Studio
 * programme) — the canvas, the step drawer and the mapping surfaces.
 *
 * The design for this round was written IN DUTCH (the `Bee Flow Builder` and
 * `Editor` artboards); the English catalogue is itself a translation of it. So
 * where the artboard has a word, that word is the source of truth here and the
 * English is the paraphrase — "Komt binnen", "Gaat verder", "hele groep
 * gebruiken", "Alles achter elkaar, elk op een nieuwe regel", "Rij 1 · stap
 * 1–5", "→ rij 2 · stap 6", "1 van 4", "draait 4× · één per bank", "1 veld nog
 * leeg", "Formulier openen".
 *
 * WHY THIS MATTERS MORE THAN MOST UI COPY: these strings are how the builder
 * explains what a value IS and what it will do with it. "is a list of 3, this
 * needs one text. What do you want?" is the sentence that stops somebody
 * silently binding an array into an e-mail subject. Half-translated, the
 * question is the one thing on the screen a Dutch author skips.
 *
 * TWO PLACES THE ARTBOARD WORDS ARE DELIBERATELY GENERALISED:
 *   - "Voor elk item een eigen vraag" (2a) is written for the approval step it
 *     was drawn on. The key it maps to is used by every step type, so the
 *     Dutch is "Voor elk item een aparte run".
 *   - "Cijfers inlezen (3)" style step kickers are per-routine content, not
 *     copy, and have no key.
 *
 * `automations.kind.choice` is NOT here: the `choice` kind arrived with the
 * datatables track (T1/T2), and its Dutch ships in that track's own migration.
 * One key, one owner — two migrations racing to seed the same key would make
 * the wording depend on boot order.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated its
 * own wording keeps it. ADD, NEVER RENAME — a renamed key is a screen that
 * silently falls back to English. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-builder-redesign-translations.js
 */

const NL_TRANSLATIONS = {
    // ── De variabelenkiezer ─────────────────────────────────────────────────
    'automations.picker.fields_of': 'Velden van {step}',
    'automations.picker.all_steps': 'Alle stappen',
    'automations.picker.search_in': 'Zoek in {step}…',

    // ── Wat een veld IS, in gewone woorden (artboard 2c) ────────────────────
    // Nooit "string", "array" of "object": de hele tabel van 2c bestaat omdat
    // die woorden niets zeggen tegen wie geen programmeur is.
    'automations.kind.text': 'tekst',
    'automations.kind.number': 'getal',
    'automations.kind.yesno': 'ja/nee',
    'automations.kind.date': 'datum',
    'automations.kind.list': 'lijst',
    'automations.kind.group': 'groep',
    'automations.kind.table': 'tabel',
    'automations.kind.file': 'bestand',
    'automations.kind.unknown': 'nog niet gezien',
    'automations.kind.unknown_short': 'nog niet gezien',
    'automations.kind.unknown_hint': 'nog niet gezien — draai de stap hierboven',
    'automations.kind.list_of_kind': 'van {kind}',
    'automations.kind.list_of_n': 'van {n}',
    'automations.kind.list_of_n_kind': 'van {n} · {kind}',
    'automations.kind.list_empty': '· leeg',
    'automations.kind.group_fields': '· {n} velden',
    'automations.kind.row': '{n} rij',
    'automations.kind.rows': '{n} rijen',
    'automations.kind.column': '{n} kolom',
    'automations.kind.columns': '{n} kolommen',
    'automations.kind.paragraphs': '· {n} alinea’s',
    'automations.kind.words': '· {n} woorden',

    // ── Kolom "Komt binnen" (artboard 2a/2b) ────────────────────────────────
    'automations.mapping.per_step': 'Per stap',
    'automations.mapping.all': 'Alles',
    'automations.mapping.view_group': 'Velden groeperen',
    'automations.mapping.search': 'Zoek een veld…',
    'automations.mapping.search_all': 'Zoek in alle stappen…',
    'automations.mapping.step_n': 'Stap {n}',
    'automations.mapping.one_field': '1 veld',
    'automations.mapping.n_fields': '{n} velden',
    'automations.mapping.in_use': '{n} in gebruik',
    'automations.mapping.in_use_tag': 'in gebruik',
    'automations.mapping.in_use_title': 'Deze stap gebruikt dit veld al',
    'automations.mapping.current_item': 'huidig item van de lus',
    'automations.mapping.iteration_of': '{n} van {total}',
    'automations.mapping.use_whole_group': 'hele groep gebruiken',
    'automations.mapping.no_upstream': 'Nog geen gegevens uit eerdere stappen. Verbind deze stap met een vorige om de uitvoer hier te zien.',
    'automations.mapping.hint_top': 'Sleep een veld naar een instelling, of klik ‹kies› ernaast. Voorbeeldwaarden komen uit de laatste run.',
    'automations.mapping.hint_bottom': 'Open Tabel om een hele kolom of één cel te koppelen. Een lijst op een plek waar één waarde past, vraagt wat je bedoelt in plaats van te weigeren.',
    // Zoeken, de tabelweergave en de lege staat van de kolom. "Koppelen" is
    // het werkwoord van deze kolom (zie hint_top/hint_bottom) — nooit "mappen".
    'automations.mapping.iteration_of_capped': '{n} van {total} · {skipped} niet verwerkt',
    'automations.mapping.search_fields': 'Zoek in invoervelden',
    'automations.mapping.clear_search': 'Zoekopdracht wissen',
    'automations.mapping.no_matches': 'Geen resultaten.',
    'automations.mapping.drag_whole_output': 'Sleep om de hele uitvoer te gebruiken ({path})',
    'automations.mapping.open_table': 'Open {label} als tabel',
    'automations.mapping.open_table_title': 'Open {label} als tabel — koppel een hele kolom of één cel',
    'automations.mapping.no_named_fields': 'Geen benoemde velden — open {table} om vanuit de ruwe uitvoer te koppelen.',
    'automations.mapping.not_run_fields': 'Nog niet uitgevoerd: test deze stap om te zien wat hij doorgeeft.',
    'automations.mapping.technical_meta_one': '1 veld · {names}',
    'automations.mapping.table': 'Tabel',
    'automations.mapping.fields': 'Velden',
    'automations.mapping.no_data_yet': 'Nog geen gegevens — draai de stap ervoor om ze vast te leggen.',

    // ── "Het past niet één-op-één" (artboard 2a/2c) ─────────────────────────
    'automations.mismatch.title': 'Dit veld en de waarde die je koos passen niet één-op-één',
    'automations.mismatch.more': 'meer',
    'automations.mismatch.list_into_one': 'is een {actual}, hier past één {expected}. Wat wil je?',
    'automations.mismatch.list_into_one_n': 'is een {actual} van {n}, hier past één {expected}. Wat wil je?',
    'automations.mismatch.group_into_one': 'is een {actual}, hier past één {expected}. Kies een veld erin.',
    'automations.mismatch.table_into_one': 'is een {actual}, hier past één {expected}. Het kan als tabel mee.',
    'automations.mismatch.table_into_one_n': 'is een {actual} van {n} rijen, hier past één {expected}. Het kan als tabel mee.',
    'automations.mismatch.choice_lines': 'Alles achter elkaar, elk op een nieuwe regel',
    'automations.mismatch.choice_comma': 'Alles achter elkaar, met komma',
    'automations.mismatch.choice_first': 'Alleen de eerste',
    'automations.mismatch.choice_last': 'Alleen de laatste',
    'automations.mismatch.choice_count': 'Alleen het aantal ({n})',
    'automations.mismatch.choice_each': 'De hele lijst behouden',
    'automations.mismatch.choice_foreach': 'Voor elk item een aparte run',
    'automations.mismatch.choice_summary': 'De hele groep, als leesbaar overzicht',
    'automations.mismatch.choice_whole_group': 'De hele groep gebruiken zoals hij is',
    'automations.mismatch.choice_as_table': 'Als tabel',
    'automations.mismatch.choice_rows': 'Alleen hoeveel rijen ({n})',
    'automations.mismatch.choice_first_row': 'Alleen de eerste rij',
    'automations.mismatch.choice_foreach_row': 'Voor elke rij een aparte run',
    'automations.mismatch.choice_summary_rows': 'Eén leesbaar blok per rij',
    'automations.mismatch.choice_keep_table': 'De hele tabel behouden',
    'automations.mismatch.fewer': 'minder',
    'automations.mismatch.options_generic': 'Opties',
    'automations.mismatch.options_group': 'Veldopties',
    'automations.mismatch.options_list': 'Lijstopties',
    'automations.mismatch.options_table': 'Tabelopties',

    // ── Kaartbadges op het canvas (artboard 1g) ─────────────────────────────
    'automations.card.badge_running': 'draait',
    'automations.card.badge_done': 'klaar',
    'automations.card.badge_failed': 'mislukt',
    'automations.card.badge_recovered': 'hersteld',
    'automations.card.badge_waiting': 'wacht',
    'automations.card.badge_pinned': 'vastgezet',
    'automations.card.source': 'bron',

    // ── Rijen en terugloop (artboard 1a) ────────────────────────────────────
    'automations.canvas.row_label': 'Rij {n}',
    'automations.canvas.row_steps': 'stap {first}–{last}',
    'automations.canvas.row_step': 'stap {n}',
    'automations.canvas.wrap_chip': '→ rij {row} · stap {step}',
    'automations.canvas.wrap_chip_row': '→ rij {row}',

    // ── Zoomen, legenda en samenvatting (artboard 1a) ───────────────────────
    'automations.canvas.zoom_in': 'Inzoomen',
    'automations.canvas.zoom_out': 'Uitzoomen',
    'automations.canvas.zoom_reset': 'Zoom naar 100%',
    'automations.canvas.zoom_fit': 'Pas de hele flow op het scherm',
    'automations.canvas.fullscreen_on': 'Canvas op volledig scherm',
    'automations.canvas.fullscreen_off': 'Volledig scherm verlaten',
    'automations.canvas.legend_toggle': 'Wat de tekens op het canvas betekenen',
    'automations.canvas.legend_title': 'Legenda',
    'automations.canvas.legend_data': 'gegevens die over de lijn meegaan',
    'automations.canvas.legend_branch': 'een taklabel — de run volgt alleen labels',
    'automations.canvas.legend_wrap': 'de lijn terug naar het begin van de volgende rij',
    'automations.canvas.legend_pii': 'een lijn met persoonsgegevens',
    'automations.canvas.legend_tool': 'de toolpoort van een AI-stap',
    'automations.canvas.summary_empty': 'Nieuwe automatisering · nog geen trigger',
    'automations.canvas.summary_step': '{n} stap',
    'automations.canvas.summary_steps': '{n} stappen',
    'automations.canvas.summary_branch': '{n} tak',
    'automations.canvas.summary_branches': '{n} takken',
    'automations.canvas.summary_loop': '{n} lus',
    'automations.canvas.summary_loops': '{n} lussen',

    // ── De zuidbalk: run, selectie, hint (artboard 1a/1d) ───────────────────
    'automations.canvas.run_failed': 'Run mislukt bij',
    'automations.canvas.run_show': 'Ga naar stap',
    'automations.canvas.run_waiting_form': 'wacht op formulier',
    'automations.canvas.open_form': 'Formulier openen',
    // De bouwbanner en het lege canvas tijdens een bouw (het bouwen als
    // film, 2026-09): wat de assistent zojuist DEED, hoe lang het al duurt,
    // en het einde. Het geestkaartje op het canvas draagt de gedachten; de
    // banner dus niet.
    'automations.canvas.build_live': 'Bezig met bouwen',
    'automations.canvas.build_skipped': 'Overgeslagen: {reason}',
    'automations.canvas.build_plan': 'stap {n} van {total}',
    'automations.canvas.build_adding': '{n} stappen toevoegen…',
    'automations.canvas.build_reviewing': 'De automatisering wordt nagekeken…',
    'automations.canvas.build_done': 'Gebouwd · {n} stappen · {t}',
    'automations.canvas.build_stopped': 'Gestopt — concept bewaard',
    'automations.canvas.build_follow': 'Volg het bouwen',
    'automations.canvas.build_next': 'Bezig met de volgende stap…',
    'automations.canvas.build_trigger_next': 'Een trigger kiezen…',
    'automations.canvas.selected_one': '1 stap geselecteerd',
    'automations.canvas.selected_many': '{n} stappen geselecteerd',
    'automations.canvas.selected_hint_one': 'ctrl-klik om er meer bij te nemen · R D U P Del werken erop',
    'automations.canvas.selected_hint_many': 'sleep om ze samen te verplaatsen',
    'automations.canvas.delete': 'Verwijderen',
    'automations.canvas.hint': 'Sleep om te selecteren · spatie of middelste muisknop om te slepen · Tab springt naar de volgende stap',
    'automations.canvas.arrange': 'Ordenen',
    'automations.canvas.arrange_rows': 'Rijen die op het scherm passen',
    'automations.canvas.arrange_compact': 'Eén strakke lijn',
    'automations.canvas.arrange_roomy': 'Ruim, met flowlets open',
    // De containerkop op het canvas: "Lus · per bank · 2 stappen" (1a).
    // Het middenstuk noemt de eigen itemnaam van de lus — het woord waar de
    // stappen erin tegen binden.
    'automations.canvas.loop_body_step': '{n} stap',
    'automations.canvas.loop_body_step_plural': '{n} stappen',
    'automations.canvas.loop_each_item': 'Elk item',
    'automations.canvas.loop_each_batch': 'Elke groep van {n}',
    // De luskaart zelf: poorten, de samenvattingsregel en uit-/invouwen.
    // `loop.{item}` is het pad waar de stappen erin tegen binden en blijft
    // dus letterlijk staan; alleen de woorden eromheen zijn Nederlands.
    'automations.canvas.loop_port_done': 'Klaar',
    'automations.canvas.loop_port_on_error': 'Bij fout',
    'automations.canvas.loop_over': 'over: {list} · als loop.{item}',
    'automations.canvas.loop_over_batched': 'over: {list} · als loop.{item} · ×{batch}',
    'automations.canvas.loop_no_list': 'nog geen lijst · als loop.{item}',
    'automations.canvas.loop_body_inside': '{n} stap erin',
    'automations.canvas.loop_body_inside_plural': '{n} stappen erin',
    'automations.canvas.loop_body_title': 'Stappen die per item draaien — vouw de kaart uit om ze te zien',
    'automations.canvas.loop_max_title': 'Maximaal aantal herhalingen',
    'automations.canvas.loop_expand': 'Uitvouwen — toon de stappen die per item draaien hier op het canvas',
    'automations.canvas.loop_collapse': 'Invouwen — terug naar één kaart',
    'automations.canvas.loop_over_summary': 'over {list} · als loop.{item} · ≤{max}',
    'automations.canvas.loop_over_summary_batched': 'over {list} · als loop.{item} · ×{batch} · ≤{max}',
    'automations.canvas.loop_not_recorded': 'stappen per item worden niet vastgelegd',
    'automations.canvas.loop_not_recorded_title': 'Stappen in een lus worden niet één voor één vastgelegd — de lus zelf draagt de runstatus.',
    'automations.canvas.editing_chip': 'Stap {n} van {total} · Esc sluit · Alt+←/→ vorige/volgende',

    // ── Het bouwen als film, deel 2 (2026-09-11) ───────────────────────────
    // De wachtkaart in de chatkolom tijdens de lange stilte voordat een lokaal
    // model iets zegt; het geestkaartje dat de stap toont die het model op dat
    // moment TYPT; de motorregel in de zuidbalk ("op deze machine, leest 148
    // tok/s"); de resultaatchips als de testrun wordt afgespeeld; en de
    // presentatiemodus voor een beamer. "Onthouden" is hier het woord voor de
    // prompt-cache: wat het model van de vorige beurt niet opnieuw hoeft te
    // lezen — dat is precies wat de zaal moet zien.
    'automations.builder.act.add_steps': '{n} stappen toegevoegd',
    'automations.builder.act.add_step_one': '1 stap toegevoegd',
    'automations.builder.thinking': 'Aan het denken…',
    'automations.builder.wait.title': 'Wachten op het model',
    'automations.builder.wait.sent': 'Verzoek verstuurd',
    'automations.builder.wait.session': 'Sessie geopend',
    'automations.builder.wait.reading': 'Het model leest je verzoek',
    'automations.builder.wait.first': 'Eerste antwoord',
    'automations.builder.wait.first_time': 'Een lokaal model heeft de eerste keer een paar minuten nodig om het verzoek te lezen',
    'automations.builder.wait.usually': 'Meestal ongeveer {t}',
    'automations.builder.wait.longer': 'Duurt langer dan gewoonlijk ({t})',
    'automations.builder.wait.prompt_size': 'Leest ongeveer {k}k tokens',
    'automations.builder.wait.heartbeats': 'verbinding leeft · {n} hartslagen',
    'automations.builder.wait.progress': 'Leest {done} van {total} tokens',
    'automations.builder.wait.remembered': '{n} al onthouden van de vorige keer',
    'automations.builder.wait.writing': 'De eerste stap wordt geschreven…',
    'automations.canvas.engine.local': 'Op deze machine',
    'automations.canvas.engine.offline': 'niets naar buiten gestuurd',
    'automations.canvas.engine.reading': 'leest {done} van {total} tokens',
    'automations.canvas.engine.remembered': '{n} onthouden',
    'automations.canvas.engine.reads': 'leest {n} tok/s',
    'automations.canvas.engine.writes': 'schrijft {n} tok/s',
    'automations.canvas.engine.writing': 'aan het schrijven…',
    'automations.canvas.draft.step_of': 'Stap {i} van {n}',
    'automations.canvas.draft.step_from': 'Stap {i}+',
    'automations.canvas.draft.placing': '{app} wordt geplaatst…',
    'automations.canvas.draft.typing': 'De volgende stap wordt geschreven…',
    'automations.canvas.draft.inspecting': 'Kijkt naar {app}…',
    'automations.canvas.draft.inspecting_many': 'Kijkt naar {n} apps…',
    'automations.canvas.draft.testing': 'Een test wordt gedraaid…',
    'automations.canvas.draft.planning': 'Het plan wordt geschreven…',
    'automations.canvas.draft.summarising': 'De automatisering wordt samengevat…',
    'automations.canvas.draft.finalizing': 'De automatisering wordt opgeslagen…',
    'automations.canvas.draft.wiring': 'De fouttak wordt aangesloten…',
    'automations.canvas.draft.editing': 'Een stap wordt aangepast…',
    'automations.canvas.result.files': '{n} bestanden',
    'automations.canvas.result.rows': '{n} rijen',
    'automations.canvas.result.chars': '{n} tekens',
    'automations.canvas.result.ok': 'klaar',
    'automations.canvas.result.empty': 'niets',
    'automations.canvas.result.failed': 'mislukt',
    'automations.canvas.result.skipped': 'overgeslagen',
    'automations.canvas.replay.title': 'De testrun wordt afgespeeld',
    'automations.canvas.present.on': 'Presentatiemodus',
    'automations.canvas.present.off': 'Presentatiemodus verlaten',
    'automations.canvas.present.hint': 'Grotere kaarten en tekst voor een beamer — Shift+P',
    // ── Gegevens uitlezen + de rij-editor voor Nextcloud Tables (2026-09-12) ──
    // Het instellingenpaneel van het nieuwe steptype `data_extraction`, en de
    // kolombewuste editor die een Tables-rij per kolom laat invullen in plaats
    // van als kale JSON. `automations.ndv.` is van deze migratie, dus hier.
    'automations.ndv.extraction.source': 'Tekst om te lezen',
    'automations.ndv.extraction.fields': 'Velden om uit te lezen',
    'automations.ndv.extraction.add_field': 'Veld toevoegen',
    'automations.ndv.extraction.field_name': 'Naam',
    'automations.ndv.extraction.field_desc': 'Waar te zoeken',
    'automations.ndv.extraction.required': 'Verplicht',
    'automations.ndv.extraction.instructions': 'Extra aanwijzingen',
    'automations.ndv.extraction.model_note': 'Draait op het extractiemodel dat je beheerder heeft ingesteld',
    'automations.ndv.extraction.count': '{n} velden',
    'automations.ndv.tables_row.add_columns': 'Kolommen toevoegen',
    'automations.ndv.tables_row.automap': 'Automatisch koppelen',
    'automations.ndv.tables_row.automap_mapped': '{n} kolommen gevuld.',
    'automations.ndv.tables_row.automap_title': 'Vul lege kolommen vanuit {source} — alleen namen die kloppen als je spellingverschillen negeert',
    'automations.ndv.tables_row.automap_unmatched': 'Geen kolom met die naam: {fields}.',
    'automations.ndv.tables_row.leave_empty': 'laat leeg om {column} over te slaan',
    'automations.ndv.tables_row.load_failed': 'De kolommen van tabel {id} konden niet gelezen worden ({error}). Typ de kolomtitels precies zoals ze in Nextcloud staan, of probeer opnieuw.',
    'automations.ndv.tables_row.loading': 'Kolommen van tabel {id} worden gelezen…',
    'automations.ndv.tables_row.map_from': 'Koppel vanuit',
    'automations.ndv.tables_row.no_columns': 'Deze tabel heeft nog geen kolommen — voeg er eerst een paar toe in Nextcloud.',
    'automations.ndv.tables_row.not_a_column': 'Geen kolom in deze tabel — de rij mislukt zolang deze niet verwijderd of hernoemd zijn',
    'automations.ndv.tables_row.remove_key': '{key} verwijderen',
    'automations.ndv.tables_row.required': 'Verplicht',
    'automations.ndv.tables_row.retry': 'Opnieuw proberen',
    'automations.ndv.tables_row.split': 'Vul de kolommen liever één voor één in',
    'automations.ndv.tables_row.table_bound': 'De tabel wordt gekozen terwijl de automatisering draait, dus de kolommen zijn hier niet op te halen. Typ de kolomtitels precies zoals ze in Nextcloud staan.',
    'automations.ndv.tables_row.titles_label': 'Kolomtitels',
    'automations.ndv.tables_row.titles_placeholder': 'Kolomtitels, gescheiden door komma’s — bijv. Bedrijf, Excl. btw',
    'automations.ndv.tables_row.type_text': 'tekst',
    'automations.ndv.tables_row.type_number': 'getal',
    'automations.ndv.tables_row.type_datetime': 'datum & tijd',
    'automations.ndv.tables_row.type_selection': 'keuze',
    'automations.ndv.tables_row.type_usergroup': 'gebruiker / groep',
    'automations.ndv.tables_row.type_unknown': 'type onbekend',
    'automations.ndv.tables_row.whole_bound': 'De hele rij komt uit één eerdere waarde — die moet al een map van kolomtitel naar waarde zijn.',
    'automations.ndv.tables_row.whole_label': 'Rijwaarden',
    // ── Het lege canvas (artboard 1e) ───────────────────────────────────────
    'automations.canvas.empty_title': 'Waarmee begint deze automatisering?',
    'automations.canvas.empty_sub': 'Elke automatisering heeft precies één trigger. Kies er een, of laat de assistent de automatisering schrijven.',
    'automations.canvas.empty_static': 'Begin met een trigger.',
    'automations.canvas.empty_describe': 'Of beschrijf de automatisering:',
    'automations.canvas.empty_example': '“jaarrekening via een formulier → analyse per bank → memorandum”',
    'automations.canvas.empty_assistant': 'Assistent',
    'automations.canvas.empty_hint': '…of kies er een uit de balk hierboven, of sleep hem op het canvas.',

    // ── De stappenlade (artboard 1h/2a/2b) ──────────────────────────────────
    'automations.ndv.incoming': 'Komt binnen',
    'automations.ndv.settings': 'Instellingen',
    'automations.ndv.continues': 'Gaat verder',
    'automations.ndv.from_step': 'uit {step}',
    'automations.ndv.from_steps': 'uit {n} eerdere stappen',
    'automations.ndv.step_of': 'Stap {n} van {total}',
    'automations.ndv.used_next': 'Stappen {steps} gebruiken deze velden',
    'automations.ndv.output_word': 'uitvoer',
    'automations.ndv.output_empty_record': 'Een leeg record — er kwamen geen velden uit.',
    'automations.ndv.out': 'Uit',
    'automations.ndv.not_run_yet': 'nog niet gedraaid',
    'automations.ndv.runs_n_times': 'draait {n}×',
    'automations.ndv.runs_n_times_per': 'draait {n}× · één per {list}',
    // De werkbalk van de lade en de uitvoer-editor. "Vastzetten" volgt de
    // kaartbadge ('vastgezet'); "stap" waar het Engels "node" zegt, omdat de
    // rest van dit canvas nooit "node" tegen de gebruiker zegt.
    'automations.ndv.output': 'Uitvoer',
    'automations.ndv.output_json': 'Uitvoer-JSON',
    'automations.ndv.show_input': 'Invoer tonen',
    'automations.ndv.hide_input': 'Invoer verbergen',
    'automations.ndv.show_output': 'Uitvoer tonen',
    'automations.ndv.hide_output': 'Uitvoer verbergen',
    'automations.ndv.edit': 'Bewerken',
    'automations.ndv.edited': 'Bewerkt',
    'automations.ndv.edit_step': '{name} bewerken',
    'automations.ndv.clear': 'Wissen',
    'automations.ndv.pin': 'Vastzetten',
    'automations.ndv.pinned': 'Vastgezet',
    'automations.ndv.pin_title': 'Zet deze uitvoer vast (slaat het live draaien over en hergebruikt de laatste uitvoer)',
    'automations.ndv.unpin_title': 'Uitvoer losmaken (live draaien weer aan)',
    'automations.ndv.disable': 'Uitschakelen',
    'automations.ndv.disabled': 'Uitgeschakeld',
    'automations.ndv.disable_title': 'Schakel deze stap uit (wordt tijdens de run overgeslagen)',
    'automations.ndv.reenable_title': 'Schakel deze stap weer in',
    'automations.ndv.execute': 'Uitvoeren',
    'automations.ndv.execute_title': 'Voer alleen deze stap uit (gebruikt herhaalde of vastgezette gegevens van eerdere stappen)',
    'automations.ndv.retry': 'Opnieuw proberen',
    'automations.ndv.retry_title': 'Probeer deze stap opnieuw en ga vanaf hier verder',
    'automations.ndv.duplicate': 'Dupliceren',
    'automations.ndv.duplicate_title': 'Dupliceer deze stap met zijn instellingen',
    'automations.ndv.delete_title': 'Verwijder deze stap (de buren worden weer verbonden)',
    'automations.ndv.more_options': 'Meer opties',
    'automations.ndv.more_options_n': 'Meer opties ({n})',
    'automations.ndv.prev_step': 'Vorige stap',
    'automations.ndv.prev_step_title': 'Vorige stap in de flow (Alt+←)',
    'automations.ndv.next_step': 'Volgende stap',
    'automations.ndv.next_step_title': 'Volgende stap in de flow (Alt+→)',
    'automations.ndv.expand_full': 'Vergroot naar de volledige weergave',
    'automations.ndv.expand_full_title': 'Open de volledige weergave — invoer en uitvoer naast elkaar',
    'automations.ndv.shrink_quick': 'Verklein naar het kleine venster',
    'automations.ndv.drawer_columns': 'Kolommen van de lade',
    'automations.ndv.resize_column': 'Kolombreedte aanpassen',
    'automations.ndv.resize_editor': 'Grootte van de stapeditor aanpassen',
    // Uitvoer met de hand schrijven: een vervanger voor echte gegevens, zodat
    // de stappen erna gebouwd en getest kunnen worden vóór de eerste run.
    'automations.ndv.edit_output_hint': 'Schrijf de uitvoer van deze stap met de hand, zodat de stappen erna gebouwd en getest kunnen worden voordat deze ooit heeft gedraaid',
    'automations.ndv.output_editor_hint': 'Wat de stappen na deze moeten zien. Wordt met de automatisering opgeslagen en afgespeeld in plaats van deze stap te draaien — een vervanger voor echte gegevens dus, geen notitie.',
    'automations.ndv.save_output': 'Uitvoer opslaan',
    'automations.ndv.save_failed': 'Opslaan mislukt',
    'automations.ndv.use_empty_answers': 'Lege antwoorden gebruiken',
    'automations.ndv.empty_answers_title': 'Vul elke gedeclareerde vraag met een leeg antwoord — de set sleutels die een inzending heeft voordat iemand iets typt',
    'automations.ndv.err_invalid_json': 'Ongeldige JSON: {message}',
    'automations.ndv.err_not_json': 'Die waarde kan niet als JSON worden opgeslagen.',
    'automations.ndv.err_nothing_to_save': 'Niets om op te slaan — gebruik {remove} om de opgeslagen uitvoer te wissen.',
    'automations.ndv.err_truncated_placeholder': 'Dat is de tijdelijke tekst “uitvoer te groot” van de server, geen gegevens. Vervang hem door de vorm die de volgende stappen moeten zien.',
    'automations.ndv.err_too_big': 'Te groot om op te slaan: {size} KB, de grens is {limit} KB. Houd een of twee representatieve records — de stappen erna koppelen tegen de vorm, niet tegen de hoeveelheid.',
    'automations.ndv.set_source_unresolved': 'Deze lijst zat niet in de laatste gegevens, dus deze stap had niets om doorheen te werken. Kies de lijst opnieuw, of draai de stap die hem maakt opnieuw.',

    // ── De voettekst van het instellingenformulier (artboard 2b) ────────────
    'automations.builder.one_field_empty': '1 veld nog leeg',
    'automations.builder.n_fields_empty': '{n} velden nog leeg',
    // Als de toolgegevens van een stap niet laden kan de voettekst de velden
    // niet tellen; dat zegt hij dan, in plaats van "0 velden nog leeg".
    'automations.builder.fields_unknown': 'De velden kunnen niet worden gecontroleerd',
    'automations.builder.fields_unknown_hint': 'De toolgegevens van deze stap konden niet worden geladen, dus de verplichte velden zijn niet te controleren. Laad de pagina opnieuw om het nog eens te proberen.',

    // ── Opmaak van een waarde in tekst (artboard 2c) ────────────────────────
    'automations.builder.number_style': 'Getoond als',
    'automations.builder.date_notation': 'Geschreven als',
    'automations.builder.yes_says': 'Bij ja staat er',
    'automations.builder.no_says': 'bij nee',

    // ── Het lint en de stapgroepen (artboard 1f) ────────────────────────────
    'automations.ribbon.frequent': 'Vaak gebruikt',
    'automations.ribbon.search': 'Zoek een stap…',
    'automations.ribbon.show_all': 'Toon alle commando’s',
    'automations.ribbon.hide_all': 'Verberg alle commando’s',
    'automations.ribbon.change_or_add': 'Wijzigen of toevoegen',
    'automations.ribbon.more_apps': 'Meer apps',
    'automations.node.group.people': 'Mensen & wachten',
    'automations.node.group.integrations': 'Integraties',
    'automations.node.group.flow_control': 'Flowbesturing',
    'automations.node.group.data': 'Gegevens',
    'automations.node.group.lists': 'Lijsten',
    'automations.node.group.data_lists': 'Gegevens & lijsten',
};

/**
 * Keys whose Dutch IS the English string. Kept out of NL_TRANSLATIONS on
 * purpose: writing "Live run": "Live run" into the nl store pins a value that
 * cannot be told apart from an untranslated one, and t() already falls back to
 * English for a missing key. The test uses this list to distinguish
 * "deliberately identical" from "forgotten".
 *
 * "Live run" and "Flowlets" are the words the Dutch artboards themselves use;
 * `choice_field` is a bare `{field}` placeholder with no words in it at all,
 * and the In/Uit toggle's "In" is the same two letters in both languages.
 * "AI" and "Trigger" are the ribbon cluster captions: both are the ordinary
 * Dutch words for those things too — the rest of this catalogue already writes
 * "trigger" in Dutch sentences ("Nieuwe routine · nog geen trigger").
 */
const SAME_AS_ENGLISH = [
    'automations.canvas.run_live',
    'automations.canvas.flowlets',
    'automations.mismatch.choice_field',
    'automations.ndv.in',
    'automations.ribbon.ai',
    'automations.ribbon.trigger',
    // "Apps" — het lintkopje naast Vaak gebruikt. Nederlands gebruikt
    // hetzelfde woord, dus een seed hier is niet van onvertaald te
    // onderscheiden.
    'automations.ribbon.apps',
    // "Lus · per bank · 2 stappen" — the artboard's own middle clause. Dutch
    // uses the same preposition, so seeding it would pin a value nobody can
    // tell apart from an untranslated one.
    'automations.canvas.loop_per_item',
    // "{n} items" — the resultaatchip on a card after a test run; "items" is
    // the ordinary Dutch word too, so there is nothing to translate.
    'automations.canvas.result.items',
    // "Plan 3/7" in the zuidbalk — a word and two numbers, the same in both.
    'automations.canvas.plan_progress',
    // The word is the same in Dutch — pinning it would hide an untranslated key.
    'automations.ndv.extraction.field_type',
];

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-builder-redesign-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS, SAME_AS_ENGLISH };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-builder-redesign-translations failed:', e.message);
        process.exit(1);
    });
}
