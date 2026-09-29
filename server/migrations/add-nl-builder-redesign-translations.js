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
 * `routines.kind.choice` is NOT here: the `choice` kind arrived with the
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
    'routines.picker.fields_of': 'Velden van {step}',
    'routines.picker.all_steps': 'Alle stappen',
    'routines.picker.search_in': 'Zoek in {step}…',

    // ── Wat een veld IS, in gewone woorden (artboard 2c) ────────────────────
    // Nooit "string", "array" of "object": de hele tabel van 2c bestaat omdat
    // die woorden niets zeggen tegen wie geen programmeur is.
    'routines.kind.text': 'tekst',
    'routines.kind.number': 'getal',
    'routines.kind.yesno': 'ja/nee',
    'routines.kind.date': 'datum',
    'routines.kind.list': 'lijst',
    'routines.kind.group': 'groep',
    'routines.kind.table': 'tabel',
    'routines.kind.file': 'bestand',
    'routines.kind.unknown': 'nog niet gezien',
    'routines.kind.unknown_short': 'nog niet gezien',
    'routines.kind.unknown_hint': 'nog niet gezien — draai de stap hierboven',
    'routines.kind.list_of_kind': 'van {kind}',
    'routines.kind.list_of_n': 'van {n}',
    'routines.kind.list_of_n_kind': 'van {n} · {kind}',
    'routines.kind.list_empty': '· leeg',
    'routines.kind.group_fields': '· {n} velden',
    'routines.kind.row': '{n} rij',
    'routines.kind.rows': '{n} rijen',
    'routines.kind.column': '{n} kolom',
    'routines.kind.columns': '{n} kolommen',
    'routines.kind.paragraphs': '· {n} alinea’s',
    'routines.kind.words': '· {n} woorden',

    // ── Kolom "Komt binnen" (artboard 2a/2b) ────────────────────────────────
    'routines.mapping.per_step': 'Per stap',
    'routines.mapping.all': 'Alles',
    'routines.mapping.view_group': 'Velden groeperen',
    'routines.mapping.search': 'Zoek een veld…',
    'routines.mapping.search_all': 'Zoek in alle stappen…',
    'routines.mapping.step_n': 'Stap {n}',
    'routines.mapping.one_field': '1 veld',
    'routines.mapping.n_fields': '{n} velden',
    'routines.mapping.in_use': '{n} in gebruik',
    'routines.mapping.in_use_tag': 'in gebruik',
    'routines.mapping.in_use_title': 'Deze stap gebruikt dit veld al',
    'routines.mapping.current_item': 'huidig item van de lus',
    'routines.mapping.iteration_of': '{n} van {total}',
    'routines.mapping.use_whole_group': 'hele groep gebruiken',
    'routines.mapping.no_upstream': 'Nog geen gegevens uit eerdere stappen. Verbind deze stap met een vorige om de uitvoer hier te zien.',
    'routines.mapping.hint_top': 'Sleep een veld naar een instelling, of klik ‹kies› ernaast. Voorbeeldwaarden komen uit de laatste run.',
    'routines.mapping.hint_bottom': 'Open Tabel om een hele kolom of één cel te koppelen. Een lijst op een plek waar één waarde past, vraagt wat je bedoelt in plaats van te weigeren.',
    // Zoeken, de tabelweergave en de lege staat van de kolom. "Koppelen" is
    // het werkwoord van deze kolom (zie hint_top/hint_bottom) — nooit "mappen".
    'routines.mapping.iteration_of_capped': '{n} van {total} · {skipped} niet verwerkt',
    'routines.mapping.search_fields': 'Zoek in invoervelden',
    'routines.mapping.clear_search': 'Zoekopdracht wissen',
    'routines.mapping.no_matches': 'Geen resultaten.',
    'routines.mapping.drag_whole_output': 'Sleep om de hele uitvoer te gebruiken ({path})',
    'routines.mapping.open_table': 'Open {label} als tabel',
    'routines.mapping.open_table_title': 'Open {label} als tabel — koppel een hele kolom of één cel',
    'routines.mapping.no_named_fields': 'Geen benoemde velden — open {table} om vanuit de ruwe uitvoer te koppelen.',
    'routines.mapping.table': 'Tabel',
    'routines.mapping.fields': 'Velden',
    'routines.mapping.no_data_yet': 'Nog geen gegevens — draai de stap ervoor om ze vast te leggen.',

    // ── "Het past niet één-op-één" (artboard 2a/2c) ─────────────────────────
    'routines.mismatch.title': 'Dit veld en de waarde die je koos passen niet één-op-één',
    'routines.mismatch.more': 'meer',
    'routines.mismatch.list_into_one': 'is een {actual}, hier past één {expected}. Wat wil je?',
    'routines.mismatch.list_into_one_n': 'is een {actual} van {n}, hier past één {expected}. Wat wil je?',
    'routines.mismatch.group_into_one': 'is een {actual}, hier past één {expected}. Kies een veld erin.',
    'routines.mismatch.table_into_one': 'is een {actual}, hier past één {expected}. Het kan als tabel mee.',
    'routines.mismatch.table_into_one_n': 'is een {actual} van {n} rijen, hier past één {expected}. Het kan als tabel mee.',
    'routines.mismatch.choice_lines': 'Alles achter elkaar, elk op een nieuwe regel',
    'routines.mismatch.choice_comma': 'Alles achter elkaar, met komma',
    'routines.mismatch.choice_first': 'Alleen de eerste',
    'routines.mismatch.choice_last': 'Alleen de laatste',
    'routines.mismatch.choice_count': 'Alleen het aantal ({n})',
    'routines.mismatch.choice_each': 'De hele lijst behouden',
    'routines.mismatch.choice_foreach': 'Voor elk item een aparte run',
    'routines.mismatch.choice_summary': 'De hele groep, als leesbaar overzicht',
    'routines.mismatch.choice_whole_group': 'De hele groep gebruiken zoals hij is',
    'routines.mismatch.choice_as_table': 'Als tabel',
    'routines.mismatch.choice_rows': 'Alleen hoeveel rijen ({n})',
    'routines.mismatch.choice_first_row': 'Alleen de eerste rij',
    'routines.mismatch.choice_foreach_row': 'Voor elke rij een aparte run',
    'routines.mismatch.choice_summary_rows': 'Eén leesbaar blok per rij',
    'routines.mismatch.choice_keep_table': 'De hele tabel behouden',

    // ── Kaartbadges op het canvas (artboard 1g) ─────────────────────────────
    'routines.card.badge_running': 'draait',
    'routines.card.badge_done': 'klaar',
    'routines.card.badge_failed': 'mislukt',
    'routines.card.badge_recovered': 'hersteld',
    'routines.card.badge_waiting': 'wacht',
    'routines.card.badge_pinned': 'vastgezet',
    'routines.card.source': 'bron',

    // ── Rijen en terugloop (artboard 1a) ────────────────────────────────────
    'routines.canvas.row_label': 'Rij {n}',
    'routines.canvas.row_steps': 'stap {first}–{last}',
    'routines.canvas.row_step': 'stap {n}',
    'routines.canvas.wrap_chip': '→ rij {row} · stap {step}',
    'routines.canvas.wrap_chip_row': '→ rij {row}',

    // ── Zoomen, legenda en samenvatting (artboard 1a) ───────────────────────
    'routines.canvas.zoom_in': 'Inzoomen',
    'routines.canvas.zoom_out': 'Uitzoomen',
    'routines.canvas.zoom_reset': 'Zoom naar 100%',
    'routines.canvas.zoom_fit': 'Pas de hele flow op het scherm',
    'routines.canvas.legend_toggle': 'Wat de tekens op het canvas betekenen',
    'routines.canvas.legend_title': 'Legenda',
    'routines.canvas.legend_data': 'gegevens die over de lijn meegaan',
    'routines.canvas.legend_branch': 'een taklabel — de run volgt alleen labels',
    'routines.canvas.legend_wrap': 'de lijn terug naar het begin van de volgende rij',
    'routines.canvas.legend_pii': 'een lijn met persoonsgegevens',
    'routines.canvas.legend_tool': 'de toolpoort van een AI-stap',
    'routines.canvas.summary_empty': 'Nieuwe routine · nog geen trigger',
    'routines.canvas.summary_step': '{n} stap',
    'routines.canvas.summary_steps': '{n} stappen',
    'routines.canvas.summary_branch': '{n} tak',
    'routines.canvas.summary_branches': '{n} takken',
    'routines.canvas.summary_loop': '{n} lus',
    'routines.canvas.summary_loops': '{n} lussen',

    // ── De zuidbalk: run, selectie, hint (artboard 1a/1d) ───────────────────
    'routines.canvas.run_failed': 'Run mislukt bij',
    'routines.canvas.run_show': 'Ga naar stap',
    'routines.canvas.run_waiting_form': 'wacht op formulier',
    'routines.canvas.open_form': 'Formulier openen',
    // De bouwbanner en het lege canvas tijdens een bouw (het bouwen als
    // film, 2026-09): wat de assistent zojuist DEED, hoe lang het al duurt,
    // en het einde. Het geestkaartje op het canvas draagt de gedachten; de
    // banner dus niet.
    'routines.canvas.build_live': 'Bezig met bouwen',
    'routines.canvas.build_skipped': 'Overgeslagen: {reason}',
    'routines.canvas.build_plan': 'stap {n} van {total}',
    'routines.canvas.build_adding': '{n} stappen toevoegen…',
    'routines.canvas.build_reviewing': 'De routine wordt nagekeken…',
    'routines.canvas.build_done': 'Gebouwd · {n} stappen · {t}',
    'routines.canvas.build_stopped': 'Gestopt — concept bewaard',
    'routines.canvas.build_follow': 'Volg het bouwen',
    'routines.canvas.build_next': 'Bezig met de volgende stap…',
    'routines.canvas.build_trigger_next': 'Een trigger kiezen…',
    'routines.canvas.selected_one': '1 stap geselecteerd',
    'routines.canvas.selected_many': '{n} stappen geselecteerd',
    'routines.canvas.selected_hint_one': 'ctrl-klik om er meer bij te nemen · R D U P Del werken erop',
    'routines.canvas.selected_hint_many': 'sleep om ze samen te verplaatsen',
    'routines.canvas.delete': 'Verwijderen',
    'routines.canvas.hint': 'Sleep om te selecteren · spatie of middelste muisknop om te slepen · Tab springt naar de volgende stap',
    'routines.canvas.arrange': 'Ordenen',
    'routines.canvas.arrange_rows': 'Rijen die op het scherm passen',
    'routines.canvas.arrange_compact': 'Eén strakke lijn',
    'routines.canvas.arrange_roomy': 'Ruim, met flowlets open',
    // De containerkop op het canvas: "Lus · per bank · 2 stappen" (1a).
    // Het middenstuk noemt de eigen itemnaam van de lus — het woord waar de
    // stappen erin tegen binden.
    'routines.canvas.loop_body_step': '{n} stap',
    'routines.canvas.loop_body_step_plural': '{n} stappen',
    'routines.canvas.loop_each_item': 'Elk item',
    'routines.canvas.loop_each_batch': 'Elke groep van {n}',
    // De luskaart zelf: poorten, de samenvattingsregel en uit-/invouwen.
    // `loop.{item}` is het pad waar de stappen erin tegen binden en blijft
    // dus letterlijk staan; alleen de woorden eromheen zijn Nederlands.
    'routines.canvas.loop_port_done': 'Klaar',
    'routines.canvas.loop_port_on_error': 'Bij fout',
    'routines.canvas.loop_over': 'over: {list} · als loop.{item}',
    'routines.canvas.loop_over_batched': 'over: {list} · als loop.{item} · ×{batch}',
    'routines.canvas.loop_no_list': 'nog geen lijst · als loop.{item}',
    'routines.canvas.loop_body_inside': '{n} stap erin',
    'routines.canvas.loop_body_inside_plural': '{n} stappen erin',
    'routines.canvas.loop_body_title': 'Stappen die per item draaien — vouw de kaart uit om ze te zien',
    'routines.canvas.loop_max_title': 'Maximaal aantal herhalingen',
    'routines.canvas.loop_expand': 'Uitvouwen — toon de stappen die per item draaien hier op het canvas',
    'routines.canvas.loop_collapse': 'Invouwen — terug naar één kaart',
    'routines.canvas.loop_over_summary': 'over {list} · als loop.{item} · ≤{max}',
    'routines.canvas.loop_over_summary_batched': 'over {list} · als loop.{item} · ×{batch} · ≤{max}',
    'routines.canvas.loop_not_recorded': 'stappen per item worden niet vastgelegd',
    'routines.canvas.loop_not_recorded_title': 'Stappen in een lus worden niet één voor één vastgelegd — de lus zelf draagt de runstatus.',
    'routines.canvas.editing_chip': 'Stap {n} van {total} · Esc sluit · Alt+←/→ vorige/volgende',

    // ── Het bouwen als film, deel 2 (2026-09-11) ───────────────────────────
    // De wachtkaart in de chatkolom tijdens de lange stilte voordat een lokaal
    // model iets zegt; het geestkaartje dat de stap toont die het model op dat
    // moment TYPT; de motorregel in de zuidbalk ("op deze machine, leest 148
    // tok/s"); de resultaatchips als de testrun wordt afgespeeld; en de
    // presentatiemodus voor een beamer. "Onthouden" is hier het woord voor de
    // prompt-cache: wat het model van de vorige beurt niet opnieuw hoeft te
    // lezen — dat is precies wat de zaal moet zien.
    'routines.builder.act.add_steps': '{n} stappen toegevoegd',
    'routines.builder.act.add_step_one': '1 stap toegevoegd',
    'routines.builder.thinking': 'Aan het denken…',
    'routines.builder.wait.title': 'Wachten op het model',
    'routines.builder.wait.sent': 'Verzoek verstuurd',
    'routines.builder.wait.session': 'Sessie geopend',
    'routines.builder.wait.reading': 'Het model leest je verzoek',
    'routines.builder.wait.first': 'Eerste antwoord',
    'routines.builder.wait.first_time': 'Een lokaal model heeft de eerste keer een paar minuten nodig om het verzoek te lezen',
    'routines.builder.wait.usually': 'Meestal ongeveer {t}',
    'routines.builder.wait.longer': 'Duurt langer dan gewoonlijk ({t})',
    'routines.builder.wait.prompt_size': 'Leest ongeveer {k}k tokens',
    'routines.builder.wait.heartbeats': 'verbinding leeft · {n} hartslagen',
    'routines.builder.wait.progress': 'Leest {done} van {total} tokens',
    'routines.builder.wait.remembered': '{n} al onthouden van de vorige keer',
    'routines.builder.wait.writing': 'De eerste stap wordt geschreven…',
    'routines.canvas.engine.local': 'Op deze machine',
    'routines.canvas.engine.offline': 'niets naar buiten gestuurd',
    'routines.canvas.engine.reading': 'leest {done} van {total} tokens',
    'routines.canvas.engine.remembered': '{n} onthouden',
    'routines.canvas.engine.reads': 'leest {n} tok/s',
    'routines.canvas.engine.writes': 'schrijft {n} tok/s',
    'routines.canvas.engine.writing': 'aan het schrijven…',
    'routines.canvas.draft.step_of': 'Stap {i} van {n}',
    'routines.canvas.draft.step_from': 'Stap {i}+',
    'routines.canvas.draft.placing': '{app} wordt geplaatst…',
    'routines.canvas.draft.typing': 'De volgende stap wordt geschreven…',
    'routines.canvas.draft.inspecting': 'Kijkt naar {app}…',
    'routines.canvas.draft.inspecting_many': 'Kijkt naar {n} apps…',
    'routines.canvas.draft.testing': 'Een test wordt gedraaid…',
    'routines.canvas.draft.planning': 'Het plan wordt geschreven…',
    'routines.canvas.draft.summarising': 'De routine wordt samengevat…',
    'routines.canvas.draft.finalizing': 'De routine wordt opgeslagen…',
    'routines.canvas.draft.wiring': 'De fouttak wordt aangesloten…',
    'routines.canvas.draft.editing': 'Een stap wordt aangepast…',
    'routines.canvas.result.files': '{n} bestanden',
    'routines.canvas.result.rows': '{n} rijen',
    'routines.canvas.result.chars': '{n} tekens',
    'routines.canvas.result.ok': 'klaar',
    'routines.canvas.result.empty': 'niets',
    'routines.canvas.result.failed': 'mislukt',
    'routines.canvas.result.skipped': 'overgeslagen',
    'routines.canvas.replay.title': 'De testrun wordt afgespeeld',
    'routines.canvas.present.on': 'Presentatiemodus',
    'routines.canvas.present.off': 'Presentatiemodus verlaten',
    'routines.canvas.present.hint': 'Grotere kaarten en tekst voor een beamer — Shift+P',
    // ── Gegevens uitlezen + de rij-editor voor Nextcloud Tables (2026-09-12) ──
    // Het instellingenpaneel van het nieuwe steptype `data_extraction`, en de
    // kolombewuste editor die een Tables-rij per kolom laat invullen in plaats
    // van als kale JSON. `routines.ndv.` is van deze migratie, dus hier.
    'routines.ndv.extraction.source': 'Tekst om te lezen',
    'routines.ndv.extraction.fields': 'Velden om uit te lezen',
    'routines.ndv.extraction.add_field': 'Veld toevoegen',
    'routines.ndv.extraction.field_name': 'Naam',
    'routines.ndv.extraction.field_desc': 'Waar te zoeken',
    'routines.ndv.extraction.required': 'Verplicht',
    'routines.ndv.extraction.instructions': 'Extra aanwijzingen',
    'routines.ndv.extraction.model_note': 'Draait op het extractiemodel dat je beheerder heeft ingesteld',
    'routines.ndv.extraction.count': '{n} velden',
    'routines.ndv.tables_row.add_columns': 'Kolommen toevoegen',
    'routines.ndv.tables_row.automap': 'Automatisch koppelen',
    'routines.ndv.tables_row.automap_mapped': '{n} kolommen gevuld.',
    'routines.ndv.tables_row.automap_title': 'Vul lege kolommen vanuit {source} — alleen namen die kloppen als je spellingverschillen negeert',
    'routines.ndv.tables_row.automap_unmatched': 'Geen kolom met die naam: {fields}.',
    'routines.ndv.tables_row.leave_empty': 'laat leeg om {column} over te slaan',
    'routines.ndv.tables_row.load_failed': 'De kolommen van tabel {id} konden niet gelezen worden ({error}). Typ de kolomtitels precies zoals ze in Nextcloud staan, of probeer opnieuw.',
    'routines.ndv.tables_row.loading': 'Kolommen van tabel {id} worden gelezen…',
    'routines.ndv.tables_row.map_from': 'Koppel vanuit',
    'routines.ndv.tables_row.no_columns': 'Deze tabel heeft nog geen kolommen — voeg er eerst een paar toe in Nextcloud.',
    'routines.ndv.tables_row.not_a_column': 'Geen kolom in deze tabel — de rij mislukt zolang deze niet verwijderd of hernoemd zijn',
    'routines.ndv.tables_row.remove_key': '{key} verwijderen',
    'routines.ndv.tables_row.required': 'Verplicht',
    'routines.ndv.tables_row.retry': 'Opnieuw proberen',
    'routines.ndv.tables_row.split': 'Vul de kolommen liever één voor één in',
    'routines.ndv.tables_row.table_bound': 'De tabel wordt gekozen terwijl de routine draait, dus de kolommen zijn hier niet op te halen. Typ de kolomtitels precies zoals ze in Nextcloud staan.',
    'routines.ndv.tables_row.titles_label': 'Kolomtitels',
    'routines.ndv.tables_row.titles_placeholder': 'Kolomtitels, gescheiden door komma’s — bijv. Bedrijf, Excl. btw',
    'routines.ndv.tables_row.type_text': 'tekst',
    'routines.ndv.tables_row.type_number': 'getal',
    'routines.ndv.tables_row.type_datetime': 'datum & tijd',
    'routines.ndv.tables_row.type_selection': 'keuze',
    'routines.ndv.tables_row.type_usergroup': 'gebruiker / groep',
    'routines.ndv.tables_row.type_unknown': 'type onbekend',
    'routines.ndv.tables_row.whole_bound': 'De hele rij komt uit één eerdere waarde — die moet al een map van kolomtitel naar waarde zijn.',
    'routines.ndv.tables_row.whole_label': 'Rijwaarden',
    // ── Het lege canvas (artboard 1e) ───────────────────────────────────────
    'routines.canvas.empty_title': 'Waarmee begint deze routine?',
    'routines.canvas.empty_sub': 'Elke routine heeft precies één trigger. Kies er een, of laat de assistent de routine schrijven.',
    'routines.canvas.empty_static': 'Begin met een trigger.',
    'routines.canvas.empty_describe': 'Of beschrijf de routine:',
    'routines.canvas.empty_example': '“jaarrekening via een formulier → analyse per bank → memorandum”',
    'routines.canvas.empty_assistant': 'Assistent',
    'routines.canvas.empty_hint': '…of kies er een uit de balk hierboven, of sleep hem op het canvas.',

    // ── De stappenlade (artboard 1h/2a/2b) ──────────────────────────────────
    'routines.ndv.incoming': 'Komt binnen',
    'routines.ndv.settings': 'Instellingen',
    'routines.ndv.continues': 'Gaat verder',
    'routines.ndv.from_step': 'uit {step}',
    'routines.ndv.from_steps': 'uit {n} eerdere stappen',
    'routines.ndv.step_of': 'Stap {n} van {total}',
    'routines.ndv.used_next': 'Stappen {steps} gebruiken deze velden',
    'routines.ndv.output_word': 'uitvoer',
    'routines.ndv.output_empty_record': 'Een leeg record — er kwamen geen velden uit.',
    'routines.ndv.out': 'Uit',
    'routines.ndv.not_run_yet': 'nog niet gedraaid',
    'routines.ndv.runs_n_times': 'draait {n}×',
    'routines.ndv.runs_n_times_per': 'draait {n}× · één per {list}',
    // De werkbalk van de lade en de uitvoer-editor. "Vastzetten" volgt de
    // kaartbadge ('vastgezet'); "stap" waar het Engels "node" zegt, omdat de
    // rest van dit canvas nooit "node" tegen de gebruiker zegt.
    'routines.ndv.output': 'Uitvoer',
    'routines.ndv.output_json': 'Uitvoer-JSON',
    'routines.ndv.show_input': 'Invoer tonen',
    'routines.ndv.hide_input': 'Invoer verbergen',
    'routines.ndv.show_output': 'Uitvoer tonen',
    'routines.ndv.hide_output': 'Uitvoer verbergen',
    'routines.ndv.edit': 'Bewerken',
    'routines.ndv.edited': 'Bewerkt',
    'routines.ndv.edit_step': '{name} bewerken',
    'routines.ndv.clear': 'Wissen',
    'routines.ndv.pin': 'Vastzetten',
    'routines.ndv.pinned': 'Vastgezet',
    'routines.ndv.pin_title': 'Zet deze uitvoer vast (slaat het live draaien over en hergebruikt de laatste uitvoer)',
    'routines.ndv.unpin_title': 'Uitvoer losmaken (live draaien weer aan)',
    'routines.ndv.disable': 'Uitschakelen',
    'routines.ndv.disabled': 'Uitgeschakeld',
    'routines.ndv.disable_title': 'Schakel deze stap uit (wordt tijdens de run overgeslagen)',
    'routines.ndv.reenable_title': 'Schakel deze stap weer in',
    'routines.ndv.execute': 'Uitvoeren',
    'routines.ndv.execute_title': 'Voer alleen deze stap uit (gebruikt herhaalde of vastgezette gegevens van eerdere stappen)',
    'routines.ndv.retry': 'Opnieuw proberen',
    'routines.ndv.retry_title': 'Probeer deze stap opnieuw en ga vanaf hier verder',
    'routines.ndv.duplicate': 'Dupliceren',
    'routines.ndv.duplicate_title': 'Dupliceer deze stap met zijn instellingen',
    'routines.ndv.delete_title': 'Verwijder deze stap (de buren worden weer verbonden)',
    'routines.ndv.more_options': 'Meer opties',
    'routines.ndv.more_options_n': 'Meer opties ({n})',
    'routines.ndv.prev_step': 'Vorige stap',
    'routines.ndv.prev_step_title': 'Vorige stap in de flow (Alt+←)',
    'routines.ndv.next_step': 'Volgende stap',
    'routines.ndv.next_step_title': 'Volgende stap in de flow (Alt+→)',
    'routines.ndv.expand_full': 'Vergroot naar de volledige weergave',
    'routines.ndv.expand_full_title': 'Open de volledige weergave — invoer en uitvoer naast elkaar',
    'routines.ndv.shrink_quick': 'Verklein naar het kleine venster',
    'routines.ndv.drawer_columns': 'Kolommen van de lade',
    'routines.ndv.resize_column': 'Kolombreedte aanpassen',
    'routines.ndv.resize_editor': 'Grootte van de stapeditor aanpassen',
    // Uitvoer met de hand schrijven: een vervanger voor echte gegevens, zodat
    // de stappen erna gebouwd en getest kunnen worden vóór de eerste run.
    'routines.ndv.edit_output_hint': 'Schrijf de uitvoer van deze stap met de hand, zodat de stappen erna gebouwd en getest kunnen worden voordat deze ooit heeft gedraaid',
    'routines.ndv.output_editor_hint': 'Wat de stappen na deze moeten zien. Wordt met de routine opgeslagen en afgespeeld in plaats van deze stap te draaien — een vervanger voor echte gegevens dus, geen notitie.',
    'routines.ndv.save_output': 'Uitvoer opslaan',
    'routines.ndv.save_failed': 'Opslaan mislukt',
    'routines.ndv.use_empty_answers': 'Lege antwoorden gebruiken',
    'routines.ndv.empty_answers_title': 'Vul elke gedeclareerde vraag met een leeg antwoord — de set sleutels die een inzending heeft voordat iemand iets typt',
    'routines.ndv.err_invalid_json': 'Ongeldige JSON: {message}',
    'routines.ndv.err_not_json': 'Die waarde kan niet als JSON worden opgeslagen.',
    'routines.ndv.err_nothing_to_save': 'Niets om op te slaan — gebruik {remove} om de opgeslagen uitvoer te wissen.',
    'routines.ndv.err_truncated_placeholder': 'Dat is de tijdelijke tekst “uitvoer te groot” van de server, geen gegevens. Vervang hem door de vorm die de volgende stappen moeten zien.',
    'routines.ndv.err_too_big': 'Te groot om op te slaan: {size} KB, de grens is {limit} KB. Houd een of twee representatieve records — de stappen erna koppelen tegen de vorm, niet tegen de hoeveelheid.',
    'routines.ndv.set_source_unresolved': 'Deze lijst zat niet in de laatste gegevens, dus deze stap had niets om doorheen te werken. Kies de lijst opnieuw, of draai de stap die hem maakt opnieuw.',

    // ── De voettekst van het instellingenformulier (artboard 2b) ────────────
    'routines.builder.one_field_empty': '1 veld nog leeg',
    'routines.builder.n_fields_empty': '{n} velden nog leeg',
    // Als de toolgegevens van een stap niet laden kan de voettekst de velden
    // niet tellen; dat zegt hij dan, in plaats van "0 velden nog leeg".
    'routines.builder.fields_unknown': 'De velden kunnen niet worden gecontroleerd',
    'routines.builder.fields_unknown_hint': 'De toolgegevens van deze stap konden niet worden geladen, dus de verplichte velden zijn niet te controleren. Laad de pagina opnieuw om het nog eens te proberen.',

    // ── Opmaak van een waarde in tekst (artboard 2c) ────────────────────────
    'routines.builder.number_style': 'Getoond als',
    'routines.builder.date_notation': 'Geschreven als',
    'routines.builder.yes_says': 'Bij ja staat er',
    'routines.builder.no_says': 'bij nee',

    // ── Het lint en de stapgroepen (artboard 1f) ────────────────────────────
    'routines.ribbon.frequent': 'Vaak gebruikt',
    'routines.ribbon.search': 'Zoek een stap…',
    'routines.ribbon.show_all': 'Toon alle commando’s',
    'routines.ribbon.hide_all': 'Verberg alle commando’s',
    'routines.ribbon.change_or_add': 'Wijzigen of toevoegen',
    'routines.ribbon.more_apps': 'Meer apps',
    'routines.node.group.people': 'Mensen & wachten',
    'routines.node.group.integrations': 'Integraties',
    'routines.node.group.flow_control': 'Flowbesturing',
    'routines.node.group.data': 'Gegevens',
    'routines.node.group.lists': 'Lijsten',
    'routines.node.group.data_lists': 'Gegevens & lijsten',
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
    'routines.canvas.run_live',
    'routines.canvas.flowlets',
    'routines.mismatch.choice_field',
    'routines.ndv.in',
    'routines.ribbon.ai',
    'routines.ribbon.trigger',
    // "Apps" — het lintkopje naast Vaak gebruikt. Nederlands gebruikt
    // hetzelfde woord, dus een seed hier is niet van onvertaald te
    // onderscheiden.
    'routines.ribbon.apps',
    // "Lus · per bank · 2 stappen" — the artboard's own middle clause. Dutch
    // uses the same preposition, so seeding it would pin a value nobody can
    // tell apart from an untranslated one.
    'routines.canvas.loop_per_item',
    // "{n} items" — the resultaatchip on a card after a test run; "items" is
    // the ordinary Dutch word too, so there is nothing to translate.
    'routines.canvas.result.items',
    // "Plan 3/7" in the zuidbalk — a word and two numbers, the same in both.
    'routines.canvas.plan_progress',
    // The word is the same in Dutch — pinning it would hide an untranslated key.
    'routines.ndv.extraction.field_type',
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
