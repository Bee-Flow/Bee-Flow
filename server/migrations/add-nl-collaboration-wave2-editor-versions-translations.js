#!/usr/bin/env node
// @typecheck
/**
 * Dutch for the second collaboration round (2026-09), part one: editing
 * together in real time (presence, find and replace, links, keyboard
 * shortcuts, the organisation's co-editing switch), the shared version
 * history and "compare", comment threads on pages and notebooks, "since your
 * last visit" and the new activity sentences on a project, the AI that joins
 * team chats by itself (the chat modes, "joined because", the organisation
 * and personal settings), and the notebook screens this round rebuilt.
 *
 * Every key of the new `editor`, `versions`, `comments` and
 * `project_participation` namespaces, plus the keys this round added to
 * `project_home`, `project_chat` and `notebooks`. The documents product and
 * the compliance checks are in the second part,
 * add-nl-collaboration-wave2-documents-compliance-translations.js.
 *
 * Terminology follows the existing Dutch catalogues: a notebook is a
 * notitieboek, the roles are eigenaar, bewerker and lezer, restoring a
 * version is terugzetten (as in the automation builder), and product nouns
 * stay English (Solution, Studio, chat, meeting, Privacy Shield). A comment
 * is an opmerking and its thread a discussie; resolving one is oplossen. The
 * AI is "hij", as in the team chat catalogue. The team chat modes keep the
 * names the first round gave them (Uit, Bij vermelding, Altijd), and the new
 * one is Automatisch. Activity sentences use the simple past, so the verb is
 * right whether the actor is a name, "Jij" or "De AI".
 *
 * SAME_AS_ENGLISH lists the keys whose Dutch is the English text itself (AI,
 * Live, Offline, Document, ...). They are not seeded: t() already falls back
 * to English, and a seeded copy could not be told apart from a forgotten
 * translation if the English is reworded later.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-collaboration-wave2-editor-versions-translations.js
 */

/** @type {Readonly<Record<string, string>>} */
const NL_TRANSLATIONS = Object.freeze({
    // ── Editor: find and replace, links, images ──────────────────────
    'editor.cancel': 'Annuleren',
    'editor.find_close': 'Zoeken sluiten',
    'editor.find_count': '{current} van {total}',
    'editor.find_label': 'Zoeken in document',
    'editor.find_match_case': 'Hoofdlettergevoelig',
    'editor.find_next': 'Volgend resultaat',
    'editor.find_none': 'Geen resultaten',
    'editor.find_placeholder': 'Zoeken',
    'editor.find_previous': 'Vorig resultaat',
    'editor.find_toggle_replace': 'Vervangen tonen',
    'editor.replace_all': 'Alles vervangen',
    'editor.replace_label': 'Vervangen door',
    'editor.replace_one': 'Vervangen',
    'editor.replace_placeholder': 'Vervangen door',
    'editor.generating': '{what} wordt gegenereerd…',
    'editor.image_upload_failed': 'De afbeelding kon niet worden geüpload. Probeer het opnieuw, of gebruik een kleinere afbeelding.',
    'editor.link_address': 'Linkadres',
    'editor.link_apply': 'Link toepassen',
    'editor.link_edit': 'Link bewerken',
    'editor.link_invalid': 'Vul een webadres in, zoals example.com.',
    'editor.link_placeholder': 'example.com of https://…',
    'editor.link_remove': 'Link verwijderen',

    // ── Editor: editing together, presence ───────────────────────────
    'editor.collab_loading': 'Het live document wordt geopend…',
    'editor.drag_locked': 'Iemand is hier aan het bewerken; je kunt het verplaatsen als diegene klaar is',
    'editor.peer_unknown': 'Iemand',
    'editor.presence_connecting': 'Verbinden…',
    'editor.presence_connecting_title': 'Het live document wordt geopend',
    'editor.presence_error': 'Niet verbonden',
    'editor.presence_error_deleted': 'Dit item is verwijderd.',
    'editor.presence_error_generic': 'De live verbinding is verbroken. Laad de pagina opnieuw om verder te gaan.',
    'editor.presence_error_revoked': 'Je hebt geen toegang meer tot dit item.',
    'editor.presence_error_too_large': 'Deze wijziging is te groot om te delen, dus de live sessie is gestopt. Laad de pagina opnieuw om verder te gaan en voeg grote inhoud in kleinere delen toe.',
    'editor.presence_group': 'Mensen in dit document',
    'editor.presence_live_title': 'Wijzigingen worden gedeeld met iedereen in dit document terwijl je typt',
    'editor.presence_more': 'nog {count}',
    'editor.presence_offline_title': 'Je wijzigingen worden bewaard en verstuurd zodra de verbinding terug is',
    'editor.presence_person_editing': '{name} is aan het bewerken',
    'editor.presence_person_viewing': '{name} kijkt mee',
    'editor.presence_readonly': 'Alleen lezen',
    'editor.presence_readonly_title': 'Je kunt meelezen; om te bewerken heb je de rol bewerker nodig',

    // ── Editor: the organisation's co-editing switch ─────────────────
    'editor.org_collab_title': 'Samen bewerken in realtime',
    'editor.org_collab_intro': 'Of leden van een project tegelijk in hetzelfde notitieboek of dezelfde pagina kunnen typen.',
    'editor.org_collab_toggle': 'Leden notitieboeken en pagina’s in projecten samen laten bewerken',
    'editor.org_collab_toggle_desc': 'Iedereen in het project ziet wijzigingen terwijl ze worden getypt, met ieders cursor erbij. Staat dit uit, dan slaat één persoon tegelijk op; kruist een opslag een andere, dan wordt gevraagd welke versie je wilt houden.',
    'editor.org_collab_server_off': 'Voor deze server uitgezet door de serverbeheerder. Niemand kan samen bewerken tot de serverbeheerder het weer aanzet.',
    'editor.org_collab_forbidden': 'Alleen een beheerder van deze organisatie kan dit wijzigen.',
    'editor.org_collab_loading': 'Laden…',
    'editor.org_collab_load_failed': 'Deze instelling kon niet worden geladen.',
    'editor.org_collab_retry': 'Opnieuw proberen',
    'editor.org_collab_save_failed': 'Deze instelling kon niet worden opgeslagen. Probeer het opnieuw.',
    'editor.org_collab_saved': 'Opgeslagen.',
    'editor.org_collab_off_title': 'Stoppen met samen bewerken?',
    'editor.org_collab_off_desc': 'Notitieboeken en pagina’s die samen worden bewerkt, worden opgeslagen zoals ze zijn; daarna slaat weer één persoon tegelijk op. Er gaat niets verloren. Wie er een open heeft, krijgt dat te horen en kan gewoon doorwerken.',
    'editor.org_collab_off_confirm': 'Uitzetten',
    'editor.org_collab_cancel': 'Annuleren',

    // ── Editor: keyboard shortcuts ───────────────────────────────────
    'editor.shortcuts_title': 'Sneltoetsen',
    'editor.shortcuts_group_blocks': 'Blokken',
    'editor.shortcuts_group_text': 'Tekst',
    'editor.shortcut_bold': 'Vet',
    'editor.shortcut_bullet': 'Lijst met opsommingstekens',
    'editor.shortcut_code': 'Code in de tekst',
    'editor.shortcut_code_block': 'Codeblok',
    'editor.shortcut_find': 'Zoeken in document',
    'editor.shortcut_heading1': 'Kop 1',
    'editor.shortcut_heading2': 'Kop 2',
    'editor.shortcut_heading3': 'Kop 3',
    'editor.shortcut_indent': 'Een lijstitem laten inspringen',
    'editor.shortcut_italic': 'Cursief',
    'editor.shortcut_line_break': 'Nieuwe regel in dezelfde alinea',
    'editor.shortcut_link': 'Link toevoegen of bewerken',
    'editor.shortcut_ordered': 'Genummerde lijst',
    'editor.shortcut_outdent': 'Een lijstitem minder laten inspringen',
    'editor.shortcut_paragraph': 'Normale tekst',
    'editor.shortcut_quote': 'Citaat',
    'editor.shortcut_redo': 'Opnieuw',
    'editor.shortcut_sheet': 'Sneltoetsen tonen',
    'editor.shortcut_slash': 'Een blok invoegen',
    'editor.shortcut_strike': 'Doorhalen',
    'editor.shortcut_task': 'Takenlijst',
    'editor.shortcut_underline': 'Onderstrepen',
    'editor.shortcut_undo': 'Ongedaan maken',

    // ── Version history: list, names, sources, contributors ──────────
    'versions.title': 'Versiegeschiedenis',
    'versions.close': 'De geschiedenis sluiten',
    'versions.loading': 'De geschiedenis wordt geladen…',
    'versions.load_failed': 'De geschiedenis kon niet worden geladen.',
    'versions.loading_version': 'Deze versie wordt geladen…',
    'versions.retry': 'Opnieuw proberen',
    'versions.cancel': 'Annuleren',
    'versions.empty': 'Nog geen versies. Er wordt een versie bewaard na elke pauze in het bewerken, voor en na elke bewerking door de AI, en telkens wanneer iemand er een naam aan geeft.',
    'versions.pinned': 'Blijvend bewaard',
    'versions.name_current': 'Deze versie een naam geven',
    'versions.name_current_hint': 'Geeft de inhoud zoals die nu is een naam, zodat je hem makkelijk terugvindt en hij blijvend wordt bewaard.',
    'versions.named_notice': 'Versie benoemd.',
    'versions.restored_notice': 'Teruggezet. De inhoud die is vervangen, is als versie bewaard.',
    'versions.list.more': 'Oudere versies tonen',
    'versions.list.loading_more': 'Laden…',
    'versions.list.small_edits': '{n} kleine wijzigingen',
    'versions.day.today': 'Vandaag',
    'versions.day.yesterday': 'Gisteren',
    'versions.day.unknown': 'Datum onbekend',
    'versions.name.label': 'Versienaam',
    'versions.name.placeholder': 'Bijvoorbeeld: Naar het bestuur gestuurd',
    'versions.name.save': 'Opslaan',
    'versions.name.clear': 'Naam verwijderen',
    'versions.source.ai': 'Bewerking door AI',
    'versions.source.autosave': 'Automatisch opgeslagen',
    'versions.source.checkpoint': 'Wijzigingen opgeslagen',
    'versions.source.conflict': 'Opgeslagen tijdens een conflict',
    'versions.source.created': 'Aangemaakt',
    'versions.source.import': 'Geïmporteerd',
    'versions.source.legacy': 'Eerdere staat',
    'versions.source.named': 'Benoemde versie',
    'versions.source.pre_restore': 'Vóór het terugzetten',
    'versions.source.restore': 'Eerdere versie teruggezet',
    'versions.who.you': 'Jij',
    'versions.who.unknown': 'Onbekend',
    'versions.who.former': 'Voormalig lid',
    'versions.who.two': '{a} en {b}',
    'versions.who.many': '{a} en {n} anderen',
    'versions.who.and_ai': '{who} en AI',
    'versions.who.with_ai': '{who}, met AI',
    'versions.stats.added': '+{n} woorden',
    'versions.stats.removed': '−{n} woorden',
    'versions.stats.format_only': 'Opmaak of indeling',

    // ── Version history: one version, restore, compare ───────────────
    'versions.detail.back': 'Alle versies',
    'versions.detail.name': 'Naam',
    'versions.detail.rename': 'Naam wijzigen',
    'versions.detail.preview': 'Tonen zoals het eruitzag',
    'versions.detail.restore': 'Terugzetten',
    'versions.detail.compare_with': 'Vergelijken met',
    'versions.detail.with_current': 'de huidige inhoud',
    'versions.detail.with_previous': 'de versie ervoor',
    'versions.restore.title': 'Deze versie terugzetten?',
    'versions.restore.body': 'Deze versie wordt de huidige inhoud voor iedereen die eraan werkt. De huidige inhoud wordt eerst als versie bewaard, dus er gaat niets verloren en je kunt ernaar terug.',
    'versions.restore.confirm': 'Terugzetten',
    'versions.error.conflict': 'Dit is gewijzigd terwijl je ernaar keek. Vernieuw de geschiedenis en probeer het opnieuw.',
    'versions.error.forbidden': 'Je kunt de geschiedenis bekijken, maar alleen bewerkers kunnen haar wijzigen.',
    'versions.error.generic': 'Er ging iets mis. Probeer het opnieuw.',
    'versions.error.not_found': 'Deze versie is niet meer beschikbaar.',
    'versions.error.unavailable': 'De geschiedenis is nu niet beschikbaar. Probeer het zo opnieuw.',
    'versions.gone_pick': 'Die versie wordt niet meer bewaard. Kies een versie om mee te vergelijken.',
    'versions.gone_stand_in': 'Die versie wordt niet meer bewaard, dus dit vergelijkt vanaf de dichtstbijzijnde eerdere versie.',
    'versions.compare.label': 'Vergelijking',
    'versions.compare.view': 'Hoe de verschillen worden getoond',
    'versions.compare.inline': 'In de tekst',
    'versions.compare.side': 'Naast elkaar',
    'versions.compare.only_changes': 'Alleen wijzigingen',
    'versions.compare.before': 'Voor',
    'versions.compare.after': 'Na',
    'versions.compare.added': 'Toegevoegd',
    'versions.compare.removed': 'Verwijderd',
    'versions.compare.format_only': 'Opmaak gewijzigd',
    'versions.compare.unchanged': '{n} ongewijzigde onderdelen',
    'versions.compare.same': 'Geen verschillen in de tekst.',
    'versions.compare.loading': 'Vergelijken…',
    'versions.compare.load_failed': 'Deze versies konden niet worden geladen.',
    'versions.compare.failed': 'Deze twee versies konden niet worden vergeleken. Je kunt ze allebei nog steeds terugzetten.',
    'versions.compare.too_large': 'Deze versies zijn te lang om woord voor woord te vergelijken. De aantallen hierboven laten zien hoeveel er is veranderd.',
    'versions.atom.chart': 'Grafiek',
    'versions.atom.divider': 'Scheidingslijn',
    'versions.atom.formula': 'Formule',
    'versions.atom.image': 'Afbeelding',
    'versions.atom.other': 'Ingesloten item',

    // ── Comments: the panel, threads and replies ─────────────────────
    'comments.title': 'Opmerkingen',
    'comments.panel_label': 'Opmerkingen',
    'comments.close': 'Opmerkingen sluiten',
    'comments.loading': 'Opmerkingen laden…',
    'comments.add': 'Opmerking toevoegen',
    'comments.add_hint': 'Selecteer eerst tekst om een opmerking bij een passage te plaatsen.',
    'comments.new_label': 'Nieuwe opmerking',
    'comments.new_placeholder': 'Voeg een opmerking toe… Typ @ om iemand of de AI te noemen.',
    'comments.comment': 'Plaatsen',
    'comments.mention_menu': 'Iemand noemen',
    'comments.send_hint': 'Ctrl+Enter of ⌘+Enter om te versturen',
    'comments.filter_label': 'Welke discussies tonen',
    'comments.filter_open': 'Openstaand',
    'comments.filter_resolved': 'Opgelost',
    'comments.thread_label': 'Discussie',
    'comments.jump_to_passage': 'Deze passage tonen',
    'comments.anchor_outdated': 'Deze passage is gewijzigd of verwijderd.',
    'comments.anchor_unreadable': 'De passage bij deze discussie kon niet worden gelezen.',
    'comments.anchor_whole_document': 'Over het hele document',
    'comments.anchor_whole_task': 'Over deze taak',
    'comments.anchor_whole_notebook': 'Over het hele notitieboek',
    'comments.reply': 'Beantwoorden',
    'comments.reply_label': 'Antwoord',
    'comments.reply_placeholder': 'Antwoorden… Typ @ om iemand of de AI te noemen.',
    'comments.reply_reopens': 'Antwoord om deze discussie te heropenen…',
    'comments.resolve': 'Oplossen',
    'comments.reopen': 'Heropenen',
    'comments.edit': 'Bewerken',
    'comments.edit_label': 'Opmerking bewerken',
    'comments.edited': '(bewerkt)',
    'comments.save': 'Opslaan',
    'comments.cancel': 'Annuleren',
    'comments.retry': 'Opnieuw proberen',
    'comments.delete': 'Verwijderen',
    'comments.delete_confirm': 'Deze opmerking verwijderen?',
    'comments.delete_thread': 'Discussie verwijderen',
    'comments.delete_thread_confirm': 'Deze hele discussie verwijderen?',
    'comments.keep': 'Behouden',
    'comments.deleted': 'Deze opmerking is verwijderd.',
    'comments.unreadable': 'Deze opmerking kon niet worden gelezen.',
    'comments.someone': 'Een projectlid',
    'comments.read_only': 'Je kunt de opmerkingen lezen. Alleen de bewerkers van het project kunnen ze toevoegen.',
    'comments.empty_open_title': 'Geen openstaande opmerkingen',
    'comments.empty_open_document': 'Selecteer een passage in het document en kies Opmerking toevoegen om erover te overleggen. Noem @ai om de AI iets te vragen.',
    'comments.empty_open_notebook': 'Selecteer een passage in het notitieboek en kies Opmerking toevoegen om erover te overleggen. Noem @ai om de AI iets te vragen.',
    'comments.empty_open_task': 'Bespreek deze taak met het team. Noem iemand met @, of @ai om de AI te vragen.',
    'comments.empty_open_viewer': 'Als bewerkers opmerkingen bij dit item plaatsen, verschijnen hun discussies hier.',
    'comments.empty_resolved_title': 'Geen opgeloste discussies',

    // ── Comments: the AI in a thread ─────────────────────────────────
    'comments.ai_name': 'AI-assistent',
    'comments.ai_answering': 'AI antwoordt…',
    'comments.ask_ai': 'Vraag de AI',
    'comments.ask_ai_hint': 'Versturen en de AI vragen om in deze discussie te antwoorden',
    'comments.ai_mode_label': 'Wanneer de AI in deze discussie antwoordt',
    'comments.ai_mode_off': 'AI uit',
    'comments.ai_mode_mention': 'AI bij vermelding',
    'comments.ai_mode_auto': 'AI beslist zelf',
    'comments.ai_mode_auto_not_allowed': 'AI beslist zelf (niet toegestaan door je organisatie)',
    'comments.ai_joined': 'Deed uit zichzelf mee omdat hij kon helpen.',
    'comments.ai_joined_unanswered': 'Deed uit zichzelf mee: een vraag hier had nog geen antwoord.',
    'comments.ai_paused': 'Na feedback doet de AI tot {time} niet meer uit zichzelf mee in deze discussie. Noem @ai om hem iets te vragen.',
    'comments.ai_blocked': 'De privacybescherming heeft voorkomen dat de AI in deze discussie antwoordde.',
    'comments.ai_busy': 'De AI is nog aan het antwoorden in deze discussie. Vraag het opnieuw als hij klaar is.',
    'comments.ai_failed': 'De AI kon niet antwoorden. Vraag het opnieuw.',
    'comments.ai_limit': 'De AI heeft niet geantwoord: de gebruikslimiet voor AI is bereikt.',
    'comments.ai_off_notice': 'De AI staat uit in deze discussie en heeft dus niet geantwoord. Wijzig wanneer de AI antwoordt om hem iets te vragen.',
    'comments.ai_unavailable': 'De AI is nu niet beschikbaar en heeft dus niet geantwoord.',
    'comments.not_helpful': 'Niet nuttig',
    'comments.not_helpful_noted': 'Bedankt, genoteerd.',

    // ── Comments: what the server can answer with ────────────────────
    'comments.error_load': 'De opmerkingen konden niet worden geladen.',
    'comments.error_create': 'De opmerking kon niet worden toegevoegd. Je tekst staat er nog.',
    'comments.error_reply': 'Het antwoord kon niet worden verstuurd. Je tekst staat er nog.',
    'comments.error_edit': 'De wijziging kon niet worden opgeslagen. Je tekst staat er nog.',
    'comments.error_delete': 'De opmerking kon niet worden verwijderd.',
    'comments.error_delete_thread': 'De discussie kon niet worden verwijderd.',
    'comments.error_resolve': 'De discussie kon niet als opgelost worden gemarkeerd.',
    'comments.error_reopen': 'De discussie kon niet worden heropend.',
    'comments.error_ai_mode': 'Kon niet wijzigen wanneer de AI antwoordt.',
    'comments.error_ai_mode_not_allowed': 'Je organisatie laat de AI niet uit zichzelf meedoen in discussies. Kies een andere instelling voor de AI.',
    'comments.error_feedback': 'De feedback kon niet worden opgeslagen.',
    'comments.error_forbidden': 'Alleen de bewerkers van het project kunnen opmerkingen plaatsen.',
    'comments.error_not_author': 'Alleen de schrijver kan deze opmerking wijzigen.',
    'comments.error_not_creator': 'Alleen wie deze discussie is begonnen of de eigenaar van het project kan haar verwijderen.',
    'comments.error_key_unavailable': 'De encryptiesleutel van het project is nu niet beschikbaar, dus er is niets opgeslagen. Probeer het zo opnieuw.',
    'comments.error_rate_limited': 'Dat waren veel opmerkingen tegelijk. Wacht even en verstuur het opnieuw.',
    'comments.error_solution': 'Een Solution in Studio bevat geen opmerkingen. Plaats opmerkingen bij items in een project.',
    'comments.error_target_gone': 'Dit item staat niet meer in het project, dus de opmerkingen erbij zijn gesloten.',
    'comments.error_thread_gone': 'Deze discussie is verwijderd.',
    'comments.error_comment_gone': 'Deze opmerking is verwijderd.',

    // ── Comments: a long discussion in the list ──────────────────────
    'comments.show_earlier': '{count} eerdere opmerkingen tonen',
    'comments.earlier_failed': 'De eerdere opmerkingen konden niet worden geladen. Probeer het opnieuw.',

    // ── Project: what changed, activity sentences, the rail ──────────
    // {thing} is a quoted title or "een document", "een notitieboek", ...
    'project_home.activity.content_created': '{actor} maakte {thing} aan',
    'project_home.activity.content_edited': '{actor} bewerkte {thing}',
    'project_home.activity.content_edited_ai': '{actor} bewerkte {thing} met AI',
    'project_home.activity.content_moved_in': '{actor} verplaatste {thing} naar het project',
    'project_home.activity.content_moved_out': '{actor} haalde {thing} uit het project',
    'project_home.activity.content_named': '{actor} gaf een versie van {thing} een naam',
    'project_home.activity.content_renamed': '{actor} wijzigde de naam van {thing}',
    'project_home.activity.content_restored': '{actor} zette een eerdere versie van {thing} terug',
    'project_home.activity.comment_thread_created': '{actor} plaatste een opmerking bij {thing}',
    'project_home.activity.comment_created': '{actor} reageerde op een opmerking bij {thing}',
    'project_home.activity.comment_updated': '{actor} bewerkte een opmerking bij {thing}',
    'project_home.activity.comment_deleted': '{actor} verwijderde een opmerking bij {thing}',
    'project_home.activity.comment_resolved': '{actor} markeerde een discussie bij {thing} als opgelost',
    'project_home.activity.comment_reopened': '{actor} heropende een discussie bij {thing}',
    'project_home.activity.comment_thread_deleted': '{actor} verwijderde een discussie bij {thing}',
    'project_home.activity.comment_thread_updated': '{actor} wijzigde hoe de AI meedoet in een discussie bij {thing}',
    'project_home.activity.comment_mention': '{actor} noemde iemand in een opmerking bij {thing}',
    'project_home.activity.the_ai': 'De AI',
    'project_home.activity.with_ai': 'Met AI',
    'project_home.activity.saves': '{n} keer opgeslagen',
    'project_home.activity.words_added': '+{n} woorden',
    'project_home.activity.words_removed': '−{n} woorden',
    'project_home.activity.filter_changes': 'Alleen wijzigingen',
    'project_home.activity.empty_changes': 'Nog geen wijzigingen in notitieboeken, documenten of meetings.',
    'project_home.rail.unread': 'Nieuwe wijzigingen',
    'project_home.since.title': 'Sinds je laatste bezoek',
    'project_home.since.when': 'Je laatste bezoek was {when}.',
    'project_home.since.failed': 'Wat er sinds je laatste bezoek is veranderd, kon niet worden geladen.',
    'project_home.since.nothing': 'Niets nieuws. Alles wat anderen hebben gewijzigd, heb je al gezien.',
    'project_home.since.new': 'Nieuw in het project',
    'project_home.since.named': 'Er is een versie benoemd',
    'project_home.since.renamed': 'Naam gewijzigd',
    'project_home.since.restored': 'Er is een eerdere versie teruggezet',
    'project_home.since.moved_out': 'Uit het project gehaald',
    'project_home.since.a_team_chat': 'Een teamchat',
    'project_home.since.new_messages': '{n} nieuwe berichten',
    'project_home.since.new_messages_some': 'Nieuwe berichten',
    'project_home.since.gone_document': 'Een document dat hier niet meer is',
    'project_home.since.gone_meeting': 'Een meeting die hier niet meer is',
    'project_home.since.gone_notebook': 'Een notitieboek dat hier niet meer is',
    'project_home.since.small_edits': 'Kleine wijzigingen in nog {n} items',
    'project_home.since.unread': 'Nog niet gezien',
    'project_home.since.show_changes': 'Wijzigingen tonen',
    'project_home.since.open': 'Openen',
    'project_home.since.mark_all': 'Alles als gezien markeren',
    'project_home.since.mark_failed': 'Niet alles kon als gezien worden gemarkeerd. Probeer het opnieuw.',

    // ── Team chats: the Auto mode ────────────────────────────────────
    'project_chat.ai_mode_auto': 'Automatisch',
    'project_chat.ai_mode_auto_hint': 'AI doet mee als hij kan helpen',
    'project_chat.ai_badge_auto': 'AI doet mee als hij kan helpen',
    'project_chat.ai_mode_off_hint': 'De AI antwoordt nooit',
    'project_chat.ai_mode_mention_hint': 'De AI antwoordt als iemand hem noemt',
    'project_chat.ai_mode_always_hint': 'De AI antwoordt op elk bericht',
    'project_chat.ai_mode_not_allowed': 'Je organisatie staat dit niet toe',
    // A mode the organisation withdrew after the chat chose it.
    'project_chat.ai_mode_withdrawn': 'Beperkt',
    'project_chat.ai_mode_withdrawn_title': 'Je organisatie staat deze instelling hier niet meer toe, dus de AI antwoordt alleen als iemand hem noemt.',
    'project_chat.ai_mode_withdrawn_notice': 'Je organisatie laat de AI hier niet meer op elk bericht antwoorden. Noem @ai om hem iets te vragen.',
    'project_chat.archived_failed': 'De gearchiveerde teamchats konden niet worden geladen.',

    // ── AI that joins by itself: in the chat ─────────────────────────
    // {reason} completes "Deed mee omdat …", so every reason is a Dutch
    // subordinate clause with the verb at the end.
    'project_participation.joined_because': 'Deed mee omdat {reason}',
    'project_participation.reason_direct_request': 'iemand om zijn hulp vroeg',
    'project_participation.reason_open_question_answerable': 'er een vraag opkwam die hij kon beantwoorden',
    'project_participation.reason_unanswered_question': 'een vraag onbeantwoord was gebleven',
    'project_participation.reason_summary_or_next_steps_requested': 'iemand om een samenvatting of vervolgstappen vroeg',
    'project_participation.reason_factual_error_worth_flagging': 'iets feitelijk onjuist leek',
    'project_participation.reason_other': 'hij hier kon helpen',
    'project_participation.not_helpful': 'Niet nuttig',
    'project_participation.not_helpful_hint': 'Laat de AI zich in deze chat meer inhouden',
    'project_participation.feedback_thanks': 'Bedankt. De AI houdt zich hier voortaan meer in.',
    'project_participation.feedback_failed': 'Je feedback kon niet worden verstuurd. Probeer het opnieuw.',
    'project_participation.paused': 'Gepauzeerd',
    'project_participation.paused_title': 'Na de feedback "Niet nuttig" doet de AI hier niet meer uit zichzelf mee. Vanaf {time} doet hij weer mee. Je kunt het hem nog steeds vragen met @ai.',
    'project_participation.list_notice_auto_on': 'De AI doet nu uit zichzelf mee',
    'project_participation.notice_auto_on': '{name} liet de AI uit zichzelf meedoen in deze chat. Hij antwoordt als hij kan helpen, en zegt waarom.',
    'project_participation.notice_auto_on_you': 'Je liet de AI uit zichzelf meedoen in deze chat. Hij antwoordt als hij kan helpen, en zegt waarom.',
    'project_participation.notice_opt_out_hint': 'Onder Instellingen, Voorkeuren kun je voorkomen dat hij meedoet na je eigen berichten.',
    'project_participation.notice_opt_out_link': 'Je AI-instellingen',
    'project_participation.notice_other': 'De instellingen van de chat zijn gewijzigd',

    // ── AI that joins by itself: personal setting ────────────────────
    'project_participation.me_title': 'AI in teamchats',
    'project_participation.me_label': 'De AI laten meedoen na mijn berichten',
    'project_participation.me_desc': 'In teamchats die op Automatisch staan, kan de AI uit zichzelf antwoorden als je bericht iets vraagt waarbij hij kan helpen. Zet je dit uit, dan laten jouw berichten hem nooit uit zichzelf meedoen. Je kunt het hem nog steeds vragen met @ai.',
    'project_participation.me_load_failed': 'Deze instelling kon niet worden geladen.',
    'project_participation.me_save_failed': 'Deze instelling kon niet worden opgeslagen. Probeer het opnieuw.',
    'project_participation.retry': 'Opnieuw proberen',

    // ── AI that joins by itself: organisation settings ───────────────
    'project_participation.org_title': 'AI die uit zichzelf meedoet',
    'project_participation.org_intro': 'Of de AI uit zichzelf mag meedoen aan teamgesprekken, en hoeveel. Hij onderbreekt nooit: hij antwoordt in het gesprek, kort, en zegt waarom hij meedeed.',
    'project_participation.org_auto_allowed': 'De AI uit zichzelf laten meedoen in gesprekken',
    'project_participation.org_auto_allowed_desc': 'Teamchats die op Automatisch staan, krijgen een antwoord van de AI als hij kan helpen: een vraag die hij kan beantwoorden, een verzoek om een samenvatting, een vraag die niemand beantwoordde. Chats beginnen op "Bij vermelding"; een bewerker van de chat kiest Automatisch.',
    'project_participation.org_comments_allowed': 'Ook in opmerkingen',
    'project_participation.org_comments_allowed_desc': 'Discussies bij documenten en notitieboeken kunnen ook op Automatisch worden gezet.',
    'project_participation.org_always_allowed': '"Altijd" toestaan',
    'project_participation.org_always_allowed_desc': 'Een teamchat mag de AI op elk bericht laten antwoorden.',
    'project_participation.org_sensitivity': 'Hoe snel de AI meedoet',
    'project_participation.org_sensitivity_conservative': 'Terughoudend',
    'project_participation.org_sensitivity_conservative_desc': 'Doet alleen mee als hij er heel zeker van is dat het helpt.',
    'project_participation.org_sensitivity_balanced': 'Gebalanceerd',
    'project_participation.org_sensitivity_balanced_desc': 'Aanbevolen. Doet mee bij duidelijke vragen en verzoeken.',
    'project_participation.org_sensitivity_eager': 'Gretig',
    'project_participation.org_sensitivity_eager_desc': 'Doet vaker mee, ook als hij minder zeker is.',
    'project_participation.org_limits': 'Limieten',
    'project_participation.org_limits_hint': 'De AI blijft hierbinnen, ook als hij meer zou kunnen zeggen. Een antwoord waar iemand met @ai om vraagt, telt niet mee, maar start wel de rusttijd.',
    'project_participation.org_max_chat_hour': 'Antwoorden per chat, per uur',
    'project_participation.org_max_project_day': 'Antwoorden per project, per dag',
    'project_participation.org_cooldown': 'Rusttijd na een antwoord (minuten)',
    'project_participation.org_unanswered': 'Minuten die collega’s krijgen om een vraag eerst zelf te beantwoorden',
    'project_participation.org_privacy_note': 'Voordat hij meedoet, leest een korte controle de laatste berichten onder pseudoniemen en via het Privacy Shield. De redenen worden als codes bewaard, nooit als tekst. Iedereen kan voorkomen dat de eigen berichten hem laten meedoen.',
    'project_participation.org_loading': 'Laden…',
    'project_participation.org_load_failed': 'Deze instellingen konden niet worden geladen.',
    'project_participation.org_save': 'Opslaan',
    'project_participation.org_saved': 'Opgeslagen. Het geldt vanaf het volgende bericht.',
    'project_participation.org_save_failed': 'Deze instellingen konden niet worden opgeslagen. Probeer het opnieuw.',
    'project_participation.org_cancel': 'Annuleren',

    // ── Notebooks: opening, saving, editing together ─────────────────
    'notebooks.opening': 'Het notitieboek wordt geopend…',
    'notebooks.not_found_title': 'Dit notitieboek is niet beschikbaar',
    'notebooks.not_found_body': 'Het is misschien verwijderd, of het wordt niet meer met je gedeeld.',
    'notebooks.load_failed_title': 'Het notitieboek kon niet worden geopend',
    'notebooks.load_failed_body': 'Controleer je verbinding en probeer het opnieuw.',
    'notebooks.back_to_notebooks': 'Terug naar notitieboeken',
    'notebooks.try_again': 'Opnieuw proberen',
    'notebooks.view_only': 'Alleen lezen',
    'notebooks.view_only_hint': 'Je kunt dit notitieboek lezen en ermee chatten, maar het niet wijzigen.',
    'notebooks.detail_meta': '{sources} bronnen · {words} woorden · Gemaakt {when}',
    'notebooks.saved_ago': 'Opgeslagen {when}',
    'notebooks.saved_live': 'Opgeslagen terwijl je typt',
    'notebooks.save_conflict': 'Elders gewijzigd: kies hieronder',
    'notebooks.live_connecting': 'Deelnemen aan de live sessie…',
    'notebooks.live_offline': 'Offline: je wijzigingen worden bewaard en verstuurd als je weer verbinding hebt',
    'notebooks.collab_slow': 'Het duurt langer dan normaal om aan de live sessie deel te nemen. Je kunt wachten, of zelf verder bewerken; wat je opslaat, wordt dan vergeleken met wat alle anderen opslaan.',
    'notebooks.collab_go_solo': 'Zelf bewerken',
    'notebooks.collab_ended': 'De live sessie is beëindigd. Open het notitieboek opnieuw om verder te gaan.',
    'notebooks.collab_ended_keeping': 'De live sessie is beëindigd voordat je laatste wijzigingen de anderen bereikten. Ze worden bewaard in de versiegeschiedenis…',
    'notebooks.collab_ended_kept': 'De live sessie is beëindigd voordat je laatste wijzigingen de anderen bereikten. Ze zijn bewaard in de versiegeschiedenis. Open het notitieboek opnieuw om verder te gaan.',
    'notebooks.collab_ended_unkept': 'De live sessie is beëindigd voordat je laatste wijzigingen waren opgeslagen, en ze konden niet worden bewaard. Kopieer ze van de pagina voordat je het notitieboek opnieuw opent.',
    'notebooks.collab_joined': 'Dit notitieboek wordt nu samen bewerkt, dus je neemt deel aan de live sessie.',
    'notebooks.collab_joined_kept': 'Dit notitieboek wordt nu samen bewerkt, dus je neemt deel aan de live sessie. De tekst die je nog niet had opgeslagen, staat in de versiegeschiedenis.',
    'notebooks.collab_elsewhere': 'Dit notitieboek wordt nu samen bewerkt in zijn project, dus je wijziging is hier niet opgeslagen. Ze staat in de versiegeschiedenis.',
    'notebooks.reopen': 'Opnieuw openen',
    'notebooks.dismiss': 'Verbergen',
    'notebooks.conflict_label': 'Elders opgeslagen wijzigingen',
    'notebooks.conflict_title': 'Iemand anders heeft dit notitieboek opgeslagen terwijl jij aan het schrijven was',
    'notebooks.conflict_body': 'Er gaat niets verloren: je tekst staat in de versiegeschiedenis. Kies met welke versie je verdergaat; opslaan wacht tot je dat hebt gedaan.',
    'notebooks.conflict_compare': 'Tonen wat afwijkt van de opgeslagen versie',
    'notebooks.conflict_keep_mine': 'Mijn versie houden',
    'notebooks.conflict_use_theirs': 'De opgeslagen versie gebruiken',
    'notebooks.conflict_load_failed': 'De opgeslagen versie kon niet worden geladen: {message}',
    'notebooks.conflict_keep_failed': 'Je nieuwere tekst kon niet worden bewaard, dus er is niets vervangen: {message}',
    'notebooks.conflict_kept_later': 'Wat je na het conflict typte, staat ook in de versiegeschiedenis.',
    'notebooks.collab_joining': 'Dit notitieboek wordt nu samen bewerkt. Deelnemen aan de live sessie…',
    'notebooks.collab_join_failed': 'Deelnemen aan de live sessie is niet gelukt, dus wat je nu typt is nog niet opgeslagen. Het blijft op deze pagina staan; probeer het zo opnieuw.',
    'notebooks.collab_try_again': 'Opnieuw proberen',
    'notebooks.show_history': 'Geschiedenis tonen',
    'notebooks.toggle_comments': 'Opmerkingen',

    // ── Notebooks: name, commands, cards ─────────────────────────────
    'notebooks.rename_notebook': 'Naam van het notitieboek',
    'notebooks.rename_hint': 'Naam wijzigen',
    'notebooks.rename_failed': 'De naam kon niet worden opgeslagen: {message}',
    'notebooks.cmd_group_notebook': 'Notitieboek',
    'notebooks.rename_notebook_cmd': 'Naam van notitieboek wijzigen',
    'notebooks.import_file_cmd': 'Een bestand in het document importeren',
    'notebooks.find_in_document': 'Zoeken in document',
    'notebooks.keyboard_shortcuts': 'Sneltoetsen',
    'notebooks.card_edited_by': 'Bewerkt door {name} · {when}',
    'notebooks.card_open_changed': 'Notitieboek {name} openen (gewijzigd sinds je laatst keek)',

    // ── Notebooks: sources, uploads, chat ────────────────────────────
    'notebooks.sources_empty_readonly': 'Dit notitieboek heeft nog geen bronnen.',
    'notebooks.drag_to_reorder': 'Sleep om de volgorde te wijzigen',
    'notebooks.remove_source_confirm': 'Deze bron verwijderen?',
    'notebooks.remove': 'Verwijderen',
    'notebooks.keep': 'Behouden',
    'notebooks.source_removed': '“{name}” verwijderd',
    'notebooks.source_remove_failed': 'De bron kon niet worden verwijderd: {message}',
    'notebooks.uploads_progress': 'Uploaden: {done} van {total}',
    'notebooks.uploads_finished': 'Uploads klaar',
    'notebooks.upload_waiting': 'Wachten…',
    'notebooks.upload_uploading': 'Uploaden ({size})',
    'notebooks.upload_done': 'Toegevoegd, wordt nu gelezen',
    'notebooks.upload_retry': '{name} opnieuw proberen',
    'notebooks.upload_dismiss': '{name} uit de lijst verwijderen',
    'notebooks.new_chat': 'Nieuwe chat',
    'notebooks.new_chat_hint': 'Een nieuwe chat beginnen (deze geschiedenis wordt verwijderd)',
    'notebooks.chat_private_hint': 'Alleen jij ziet deze chat. Het document en de bronnen ervan worden gedeeld met het project.',
    'notebooks.cancelled_by_you': 'Geannuleerd',

    // ── Notebooks: starting one, import and export ───────────────────
    'notebooks.starters_label': 'Dit notitieboek beginnen',
    'notebooks.starters_title': 'Begin met een concept, een bestand of een opzet',
    'notebooks.starters_need_sources': 'Voeg links een bron toe, dan kan de AI er een concept uit schrijven.',
    'notebooks.starter_summary': 'Samenvatting van de bronnen',
    'notebooks.starter_summary_prompt': 'Schrijf een managementsamenvatting van mijn bronnen in het document, met de belangrijkste bevindingen en conclusies.',
    'notebooks.starter_briefing': 'Briefingdocument',
    'notebooks.starter_briefing_prompt': 'Schrijf vanuit mijn bronnen een briefing in het document: een samenvatting, de analyse en aanbevelingen.',
    'notebooks.starter_faq': 'Vragen en antwoorden',
    'notebooks.starter_faq_prompt': 'Schrijf korte vragen en antwoorden vanuit mijn bronnen in het document, gegroepeerd per onderwerp.',
    'notebooks.starter_table': 'Belangrijkste feiten in een tabel',
    'notebooks.starter_table_prompt': 'Zet de belangrijkste feiten en cijfers uit mijn bronnen in een tabel in het document.',
    'notebooks.starter_import': 'Een bestand importeren (PDF, Word, tekst)',
    'notebooks.starter_outline': 'Eenvoudige opzet',
    'notebooks.starter_outline_title': 'Titel',
    'notebooks.starter_outline_goal': 'Doel',
    'notebooks.starter_outline_notes': 'Notities',
    'notebooks.starter_outline_next': 'Volgende stappen',
    'notebooks.import_failed': 'Het bestand kon niet worden gelezen.',
    'notebooks.ai_fill_failed': 'AI-invullen is mislukt',
    'notebooks.export_failed_status': 'Exporteren mislukt ({status})',
    'notebooks.sign_failed_status': 'Versturen ter ondertekening mislukt ({status})',
    'notebooks.nextcloud_failed_status': 'Opslaan in Nextcloud mislukt ({status})',
    'notebooks.nextcloud_saved': 'Opgeslagen in Nextcloud: {path}',
    'editor.chart_delete': 'Grafiek verwijderen',
    'editor.chart_no_data': 'Geen grafiekgegevens',
    'editor.slash_menu_label': 'Blok invoegen',
});

/**
 * Keys whose Dutch IS the English string: AI, and words Dutch uses as they
 * are (Link, Live, Offline, Document, Diagram, Uploads), plus two pieces of
 * punctuation around a placeholder. Kept out of NL_TRANSLATIONS on purpose;
 * the test uses this list to tell "deliberately identical" from "forgotten".
 */
const SAME_AS_ENGLISH = Object.freeze([
    'editor.link_dialog',
    'editor.presence_live',
    'editor.presence_offline',
    'editor.shortcuts_group_document',
    'versions.ai_chip',
    'versions.atom.diagram',
    'versions.who.ai',
    'comments.ai_badge',
    'project_home.activity.ai_name',
    'project_home.activity.quoted',
    'notebooks.uploads_label',
    'notebooks.in_project',
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
        console.log(`[Migration] add-nl-collaboration-wave2-editor-versions-translations: added ${added} NL keys`);
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
