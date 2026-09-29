#!/usr/bin/env node
/**
 * Dutch for Studio → Playbooks (2026-09-13): the section list, the New dialog,
 * the run page (bar, phase rail, handoff card, the four stages, done card)
 * and the three Studio registry words.
 *
 * A playbook is a phased AI build that stops after every phase for the
 * person's go-ahead. The vocabulary is the builders' where the two say the
 * same thing ("Bezig met bouwen", "Stop") and the datatables' for the table
 * ("Tabel", "rijen", "kolommen"). Phases are called "fase"; a landed phase
 * "is geland" — the film's word, not "voltooid".
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-playbooks-translations.js
 */

const NL_TRANSLATIONS = {
    // ── Studio-register ──────────────────────────────────────────────────────
    'studio.tab.playbooks_desc': 'Kijk hoe de AI een tabel, een automatisering en een app bouwt — fase voor fase',

    // ── Sectie: lijst ────────────────────────────────────────────────────────
    'playbooks.intro': 'Kijk hoe de AI een werkend geheel bouwt — een tabel, een automatisering die haar vult, een app erbovenop — en zeg na elke fase ja.',
    'playbooks.new': 'Nieuw playbook',
    'playbooks.loading': 'Laden…',
    'playbooks.reload': 'Opnieuw laden',
    'playbooks.err_list': 'Je playbooks konden niet worden geladen',
    'playbooks.err_load': 'Dit playbook kon niet worden geladen',
    'playbooks.err_conflict': 'Dit playbook is elders gewijzigd — je ziet nu de laatste stand.',
    'playbooks.empty_title': 'Nog geen playbooks',
    'playbooks.empty_body': 'Start er een en kijk mee: de tabel verschijnt, de automatisering krijgt vorm, de rijen komen binnen, de app bouwt zichzelf — jij zegt tussen de fases "ga door".',
    'playbooks.empty_cannot_create': 'Playbooks worden gestart door wie hier apps en automatiseringen mag bouwen. Vraag een beheerder.',
    'playbooks.progress': '{done}/{total} fases',
    'playbooks.just_now': 'zojuist',
    'playbooks.minutes_ago': '{n} min geleden',
    'playbooks.hours_ago': '{n} u geleden',
    'playbooks.days_ago': '{n} d geleden',

    // ── Recept ───────────────────────────────────────────────────────────────
    'playbooks.recipe.invoice_tracker': 'Facturen bijhouden',
    'playbooks.recipe.invoice_tracker_blurb': 'Leest de pdf-facturen in een Nextcloud-map in een tabel en bouwt er een factuur-app op — met een goedkeuringsflow.',

    // ── Fases en toestanden ──────────────────────────────────────────────────
    'playbooks.phase.table': 'Tabel',
    'playbooks.phase.fill': 'Eerste rijen',
    'playbooks.phase.approvals': 'Goedkeuringsflow',
    'playbooks.state.ready': 'Klaar om te starten',
    'playbooks.state.running': 'Bezig met bouwen',
    'playbooks.state.awaiting': 'Wacht op jou',
    'playbooks.state.done': 'Klaar',
    'playbooks.state.failed': 'Mislukt',
    'playbooks.state.skipped': 'Overgeslagen',
    'playbooks.state.locked': 'Vergrendeld',
    'playbooks.status.stopped': 'Gestopt',
    'playbooks.skip.no_status_column': 'De tabel heeft geen statuskolom',
    'playbooks.rail.aria': 'Fases',
    'playbooks.fact.table_rows': '{name} · {n} rijen',
    'playbooks.fact.fill': '{n} rijen',

    // ── Nieuw-dialoog ────────────────────────────────────────────────────────
    'playbooks.new.title': 'Nieuw playbook',
    'playbooks.new.subtitle': 'De AI bouwt in fases en stopt na elke fase voor jouw akkoord.',
    'playbooks.new.name': 'Naam',
    'playbooks.new.table_mode': 'Waar de facturen heen gaan',
    'playbooks.new.table_new': 'Een nieuwe tabel',
    'playbooks.new.table_existing': 'Een bestaande tabel',
    'playbooks.new.table_existing_hint': 'Eigen tabel of een Nextcloud-spiegel — je hebt bewerkrechten nodig; de kolommen worden in de eerste fase gecontroleerd.',
    'playbooks.new.pick_table': 'Tabel',
    'playbooks.new.pick_table_placeholder': 'Kies een tabel…',
    'playbooks.new.loading_tables': 'Je tabellen worden geladen…',
    'playbooks.new.folder': 'Nextcloud-map met de facturen',
    'playbooks.new.folder_hint': 'De automatisering leest deze map via je Nextcloud-koppeling.',
    'playbooks.new.err_folder': 'De map is een absoluut Nextcloud-pad, bijvoorbeeld /Facturen.',
    'playbooks.new.tier_hint_generic': 'Elke fase van dit playbook wordt gebouwd op de tier die je hier kiest; Auto kiest er per beurt een.',
    'playbooks.new.approver': 'Goedkeurende groep (optioneel)',
    'playbooks.new.approver_me': 'Ik (de eigenaar)',
    'playbooks.new.approvals_locked': 'De goedkeuringsflow vraagt het Enterprise-plan — het playbook slaat die fase over.',
    'playbooks.new.cancel': 'Annuleren',
    'playbooks.new.start': 'Starten',
    'playbooks.new.err_options': 'Controleer de opties.',
    'playbooks.new.err_create': 'Het playbook kon niet worden gestart.',

    // ── Balk ─────────────────────────────────────────────────────────────────
    'playbooks.bar.back': 'Terug naar playbooks',
    'playbooks.bar.phase': 'Fase {n} van {total}: {phase}',
    'playbooks.bar.pauses': 'Pauzeert na deze fase',
    'playbooks.bar.presenter': 'Presentatie',
    'playbooks.bar.autopilot': 'Automatisch door',

    // ── Overdrachtskaart ─────────────────────────────────────────────────────
    'playbooks.handoff.title': 'Fase {n} van {total} is geland',
    'playbooks.handoff.next_brief': 'Volgende: {phase} — de opdracht die de AI krijgt (pas gerust aan)',
    'playbooks.handoff.brief_edit': 'Aanpassen',
    'playbooks.handoff.last': 'Dit was de laatste fase — rond af om het resultaat te zien.',
    'playbooks.handoff.continue': 'Doorgaan',
    'playbooks.handoff.finish': 'Afronden',
    'playbooks.handoff.skip_next': '{phase} overslaan',
    'playbooks.handoff.skip': 'Deze fase overslaan',
    'playbooks.handoff.retry': 'Opnieuw proberen',
    'playbooks.handoff.failed_title': 'Fase {n} is niet geland',
    'playbooks.handoff.needs_input_title': 'De bouwer heeft een vraag gesteld',
    'playbooks.handoff.needs_input_body': 'Antwoord links in de chat en de fase gaat verder. Of, als wat er staat genoeg is, markeer haar als klaar.',
    'playbooks.handoff.mark_done': 'Markeer als klaar',
    'playbooks.err.aborted': 'De bouwer stopte voordat hij klaar was.',
    'playbooks.err.stopped': 'De beurt is gestopt.',
    'playbooks.err.model_empty_reply': 'Het model gaf niets bruikbaars terug — probeer het opnieuw.',

    // ── Stoppen ──────────────────────────────────────────────────────────────
    'playbooks.stop.title': 'Dit playbook stoppen?',
    'playbooks.stop.note': 'Wat geland is blijft staan — de tabel, het concept van de automatisering, de app. Een bouwbeurt die nog loopt maakt zichzelf af.',
    'playbooks.stop.confirm': 'Stoppen',

    // ── Fase: tabel ──────────────────────────────────────────────────────────
    'playbooks.table.pending_name': 'De tabel',
    'playbooks.table.starting': 'Starten…',
    'playbooks.table.creating': 'Tabel wordt aangemaakt…',
    'playbooks.table.checking': 'Kolommen worden gecontroleerd…',
    'playbooks.table.ready': 'Tabel klaar',
    'playbooks.table.rows': '{n} rijen',
    'playbooks.table.failed': 'De tabel is niet geland',
    'playbooks.table.mirror': 'Nextcloud-spiegel',
    'playbooks.table.no_status': 'Geen statuskolom — de goedkeuringsflow wordt overgeslagen.',

    'playbooks.table.no_columns': 'De tabel staat er, maar heeft nog geen kolommen.',
    'playbooks.design.look_words': 'Stijl {preset}{mood}',
    // ── Fase: routine ────────────────────────────────────────────────────────
    'playbooks.routine.starting': 'De opdracht gaat naar de automatiseringsbouwer…',
    'playbooks.routine.unwired': 'De stap "{step}" hangt niet aan de flow, dus hij zou nooit draaien. Sluit hem aan en rond opnieuw af.',
    'playbooks.routine.back': 'Terug naar het playbook',
    'playbooks.routine.summary': 'Automatisering "{title}" klaar{steps}',
    'playbooks.routine.steps': '{n} stappen',

    // ── Fase: eerste rijen ───────────────────────────────────────────────────
    'playbooks.fill.steps': 'De run, stap voor stap',
    'playbooks.fill.starting': 'De automatisering wordt gestart…',
    'playbooks.fill.not_started': 'De run is niet gestart',
    'playbooks.fill.rows_so_far': 'rijen in de tabel',
    'playbooks.fill.rows_so_far_n': '{n} rijen in de tabel',
    'playbooks.fill.done': '{n} rijen · klaar',
    'playbooks.fill.failed': 'De run is mislukt',
    'playbooks.fill.added': '+{n} deze run',

    // ── Fase: app ────────────────────────────────────────────────────────────
    'playbooks.app.no_app': 'Voor deze fase is geen app klaargezet — probeer de vorige stap opnieuw.',
    'playbooks.app.load_failed': 'De app kon niet worden geopend.',
    'playbooks.app.opening': 'De app wordt geopend…',
    'playbooks.app.handing': 'De opdracht gaat naar de app-bouwer…',
    'playbooks.app.summary_app': 'App "{name}" gebouwd.',
    'playbooks.app.summary_turn': '{phase} is klaar op "{name}".',
    'playbooks.app.turn_framing': 'Deze app is al gebouwd en afgerond. Voer ALLEEN de wijziging hieronder door. Roep app_set_theme, app_upsert_table of app_seed_records niet aan en bouw bestaande schermen niet opnieuw.',
    'playbooks.err.artifacts_missing': 'De vorige fase heeft niets opgeleverd om op verder te bouwen.',
    'playbooks.err.app_unreadable': 'De app kon niet worden geopend.',
    'playbooks.app.summary_approvals': 'Goedkeuringsflow aan de app toegevoegd.',

    // ── Klaar ────────────────────────────────────────────────────────────────
    'playbooks.done.title': '{title} is klaar',
    'playbooks.done.stopped_title': 'Gestopt — dit is geland',
    'playbooks.done.phases': '{n} van {total} fases gebouwd',
    'playbooks.done.rows': '{n} rijen',
    'playbooks.done.routine_unnamed': 'De automatisering',
    'playbooks.done.table': 'Tabel',
    'playbooks.done.compliance_done': 'Gecontroleerd',
    'playbooks.done.table_unnamed': 'De tabel',
    'playbooks.done.open': 'Openen',
    'playbooks.done.locked': 'niet in dit plan',
    'playbooks.done.skipped': 'overgeslagen',
    'playbooks.done.not_reached': 'niet bereikt',
    'playbooks.done.back': 'Terug naar playbooks',
    'playbooks.bar.autopilot_in': 'Automatisch door in {n} s',
    'playbooks.bar.autopilot_now': 'Nu doorgaan',
    'playbooks.handoff.next_design': 'Volgende: {phase} — de AI ontwerpt de app eerst als ontwerper, voordat hij bouwt.',
    'playbooks.handoff.next_fill': 'Volgende: {phase} — de automatisering draait één keer, zodat de tabel echte rijen heeft.',
    'playbooks.handoff.next_table': 'Volgende: {phase} — de tabel wordt aangemaakt.',
    'playbooks.handoff.next_plain': 'Volgende: {phase} — de opdracht wordt samengesteld zodra je doorgaat.',
    'playbooks.handoff.next_access': 'Hierna: {phase} — jij bepaalt wie de app mag openen. Er wordt niets toegepast totdat je akkoord geeft.',
    'playbooks.handoff.next_compliance': 'Hierna: {phase} — wat er is gebouwd wordt gelezen langs de kaders die jouw organisatie aan heeft staan.',
    'playbooks.handoff.next_routine': 'Hierna: {phase} — de automatiseringsbouwer krijgt een opdracht en bouwt hem terwijl je meekijkt.',
    'playbooks.handoff.next_app': 'Hierna: {phase} — de app-bouwer krijgt een opdracht en bouwt hem terwijl je meekijkt.',
    'playbooks.fill.running': 'loopt',
    'playbooks.fill.loading_flow': 'De flow wordt geladen…',
    'playbooks.rows.title': 'Wat er in de tabel is geland',
    'playbooks.rows.arriving': 'Rijen komen binnen in de tabel',
    'playbooks.rows.existing': 'Wat de tabel vandaag bevat',
    'playbooks.rows.showing': '{shown} van {total}',
    'playbooks.rows.open': 'Open de tabel',
    'playbooks.rows.loading': 'Rijen worden gelezen…',
    'playbooks.rows.err': 'De rijen konden nu niet worden gelezen.',
    'playbooks.rows.empty': 'Nog geen rijen.',
    'playbooks.phase.design': 'Ontwerp',
    'playbooks.fact.design': '"{name}" · {n} schermen',
    'playbooks.design.counts': '{screens} schermen · {elements} elementen',
    'playbooks.design.title': 'De app wordt ontworpen',
    'playbooks.design.failed': 'De ontwerper gaf geen antwoord',
    'playbooks.design.thinking': 'De AI denkt eerst als ontwerper over deze app na — schermen, hiërarchie, één accentkleur — nog voordat hij één bouwsteen kent.',
    'playbooks.new.err_compose': 'De AI kon geen werkend playbook schrijven — probeer een concretere beschrijving.',
    'playbooks.new.describe': 'Beschrijf het',
    'playbooks.new.describe_blurb': 'Zeg wat er gelezen, opgeslagen en gebouwd moet worden — de AI schrijft de fases.',
    'playbooks.new.describe_note': 'Tabel → automatisering → eerste rijen → app → meer',
    'playbooks.new.describe_label': 'Wat moet dit playbook bouwen?',
    'playbooks.new.describe_placeholder': 'bijv. Lees de leverancierscontracten in /Contracten in een tabel met leverancier, startdatum, einddatum en bedrag, en bouw een app die laat zien welke contracten binnen 90 dagen aflopen.',
    'playbooks.new.compose_again': 'Schrijf opnieuw',
    'playbooks.new.compose': 'Laat de AI de fases schrijven',
    'playbooks.new.composing': 'Het playbook wordt geschreven…',
    'playbooks.new.table_mode_generic': 'Waar de rijen heen gaan',
    'playbooks.new.preview_columns': 'Kolommen: {list}',
    'playbooks.new.preview_columns_synthesized': 'De AI gaf deze kolommen niet zelf op — ze zijn afgeleid uit de verwijzingen in haar briefings. Controleer ze voordat je start.',
    'playbooks.new.err_compose_truncated': 'Het playbook werd langer dan het model in één antwoord kan schrijven — beschrijf minder schermen en stappen, of splits het in twee playbooks.',
    'playbooks.phase.app_turn': 'App, volgende beurt',
    'playbooks.done.resume': 'Hervatten',
    'playbooks.done.interrupted': 'halverwege gestopt — hervat om opnieuw te proberen',
    'playbooks.err.interrupted': 'Halverwege gestopt. Opnieuw proberen geeft de bouwer de opdracht weer, op wat er al staat; Markeer als klaar houdt het zoals het is.',
    'playbooks.handoff.dismiss': 'Verbergen',

    // ── Automatisering, niet "routine": het woord dat Studio zelf gebruikt ────
    'playbooks.done.routine': 'Automatisering',
    'playbooks.fact.routine': 'Automatisering "{name}"',
    'playbooks.phase.routine': 'Automatisering',

    // ── Fase: compliance-check (getoetst aan de kaders van de organisatie) ──
    'playbooks.phase.compliance': 'Compliance-check',
    'playbooks.fact.compliance': '{n} om naar te kijken',
    'playbooks.fact.compliance_clean': 'Niets gevonden',
    'playbooks.compliance.title': 'Getoetst aan jouw kaders',
    'playbooks.compliance.running': 'De tabel, de automatiseringen en de app worden gelezen…',
    'playbooks.compliance.against': 'Getoetst aan: {list}',
    'playbooks.compliance.none_active': 'Er staat geen kader aan in het Compliance Center, dus er was niets om aan te toetsen.',
    'playbooks.compliance.model_note': 'De AI-beoordelaar was niet bereikbaar — dit is wat de regels alleen vonden.',
    'playbooks.compliance.clean': 'Er kwam niets uit. Wat hier gebouwd is raakt de regels die jij aan hebt staan niet.',
    'playbooks.compliance.by_ai': 'gezien door de AI',
    'playbooks.compliance.by_rule': 'uit de feiten',
    'playbooks.compliance.fix': 'Wat te doen',
    'playbooks.compliance.goto': 'Breng me erheen',
    'playbooks.compliance.keep': 'Zet dit in het risicoregister',
    'playbooks.compliance.register_title': 'Leg deze verwerking vast',
    'playbooks.compliance.register_intro': 'Dit is de Art. 30-registratie voor "{table}". Vastleggen zet ook de bewaartermijn-opruiming aan.',
    'playbooks.compliance.legal_basis': 'Grondslag',
    'playbooks.compliance.retention': 'Bewaren (dagen)',
    'playbooks.compliance.subject_column': 'Welke kolom noemt de persoon',
    'playbooks.compliance.register_go': 'Vastleggen',
    'playbooks.compliance.register_note': 'Verder schrijft niets op dit scherm iets weg.',
    'playbooks.compliance.register_failed': 'Vastleggen lukte niet.',
    'playbooks.compliance.registered': 'Vastgelegd. Het staat nu in het Compliance Center.',
    'playbooks.compliance.date_created': 'Toen de rij werd toegevoegd',
    'playbooks.compliance.date_updated': 'Toen de rij voor het laatst wijzigde',
    'playbooks.compliance.suggest': 'Laat AI dit invullen',
    'playbooks.compliance.suggest_done': 'Hieronder ingevuld — lees het na, pas aan wat je wilt en druk dan op Vastleggen.',
    'playbooks.compliance.suggest_none': 'Er viel niets toe te voegen aan wat er al staat.',
    'playbooks.compliance.suggest_failed': 'Er kon geen voorstel worden bedacht.',
    'playbooks.compliance.verdict_clean': 'Niets op te ruimen',
    'playbooks.compliance.verdict_none': 'Er is niets gecontroleerd',
    'playbooks.compliance.failed': 'De controle is niet gelopen — probeer het opnieuw.',
    'playbooks.compliance.verdict_some': '{n} dingen om op te ruimen',
    'playbooks.compliance.verdict_some_one': '1 ding om op te ruimen',
    'playbooks.compliance.verdict_clean_count': '{clean} van de {ran} controles kwamen schoon terug',
    'playbooks.compliance.method_values': 'Persoonsgegevens gevonden door de waarden in {names} te lezen',
    'playbooks.compliance.method_names': 'Persoonsgegevens afgeleid uit de kolomnamen {names} — de privacywacht kon de waarden niet lezen',
    'playbooks.compliance.delta': '{n} minder dan zojuist.',
    'playbooks.compliance.recheck': 'Opnieuw controleren',
    'playbooks.compliance.recheck_failed': 'Het kon niet opnieuw gelezen worden.',
    'playbooks.compliance.notes': '{n} opmerkingen, goed om te weten',
    'playbooks.compliance.notes_one': '1 opmerking, goed om te weten',
    'playbooks.compliance.sev_high': 'Eerst regelen, dan delen',
    'playbooks.compliance.sev_medium': 'De moeite waard',
    'playbooks.compliance.sev_low': 'Goed om te weten',
    'playbooks.compliance.kind_table': 'Tabel',
    'playbooks.compliance.kind_automation': 'Automatisering',
    'playbooks.compliance.needs_you': 'Dit is een afweging — daar ben jij voor nodig.',
    'playbooks.compliance.resolve': 'Los op met AI',
    'playbooks.compliance.fix_thinking': 'Uitzoeken wat er moet veranderen…',
    'playbooks.compliance.fix_apply': 'Deze wijziging doorvoeren',
    'playbooks.compliance.fix_cancel': 'Laat maar',
    'playbooks.compliance.fix_gate': 'Er wordt niets weggeschreven tot je op Doorvoeren drukt.',
    'playbooks.compliance.fix_no_model': 'De AI was niet bereikbaar, dus dit is wat de regels alleen zouden doen.',
    'playbooks.compliance.fix_plan_failed': 'Voor deze kon geen oplossing worden bedacht.',
    'playbooks.compliance.fix_done': 'Gedaan. We lezen het opnieuw…',
    'playbooks.compliance.fix_partial': 'Deels gelukt — {why} ging niet door.',
    'playbooks.compliance.fix_failed': 'Er is niets veranderd — {why}',
    'playbooks.compliance.categories': 'Persoonsgegevens in deze tabel',
    'playbooks.compliance.cat_values': 'gevonden door de waarden te lezen',
    'playbooks.compliance.cat_names': 'afgeleid uit de kolomnaam',
    'playbooks.compliance.retention_field': 'Geteld vanaf',
    'playbooks.compliance.basis_choose': 'Kies er één — wij doen dat niet voor je',
    'playbooks.compliance.basis_configured': 'in gebruik bij jouw organisatie',
    'playbooks.compliance.basis_open': 'Nog geen grondslag gekozen. Niets hier kiest er één voor je — art. 6 is een oordeel over waarom je deze gegevens mag hebben, en een vooringevuld antwoord zou dat oordeel namens jou zijn. De registratie blijft onvolledig tot je kiest.',
    'playbooks.compliance.retention_derived': 'de standaard van je organisatie — pas hem aan als deze tabel anders is',
    'playbooks.compliance.retention_checking': 'De tabel wordt gelezen…',
    'playbooks.compliance.retention_failed': 'De tabel kon niet gelezen worden.',
    'playbooks.compliance.retention_ok': 'De oudste van {total} rijen is {age} dagen oud, dus vandaag valt er niets buiten een venster van {days} dagen.',
    'playbooks.compliance.retention_outside': 'De oudste rij is {age} dagen oud — {n} van de {total} rijen vallen buiten een venster van {days} dagen en zouden verwijderd worden.',
    'playbooks.compliance.retention_unusable': '"{field}" bevat geen leesbare datums, dus er zou nooit iets verwijderd worden. Kies een andere kolom.',
    'playbooks.compliance.retention_needs_field': 'Kies de datum waarvandaan geteld wordt, anders heeft de opruiming niets om aan te meten.',
    'playbooks.compliance.retention_no_dates': 'Deze tabel heeft geen datumkolom, dus er kan nog geen bewaartermijn voor worden vastgelegd.',
    'playbooks.compliance.basis_consent': 'Toestemming',
    'playbooks.compliance.basis_contract': 'Uitvoering van een overeenkomst',
    'playbooks.compliance.basis_legal_obligation': 'Een wettelijke verplichting',
    'playbooks.compliance.basis_vital_interests': 'Vitale belangen',
    'playbooks.compliance.basis_public_task': 'Een publieke taak',
    'playbooks.compliance.basis_legitimate_interests': 'Gerechtvaardigd belang',
    'playbooks.compliance.wrote_ropa': 'de tabel staat in het verwerkingsregister',
    'playbooks.compliance.wrote_risks': '{n} punten geopend in het risicoregister',
    'playbooks.compliance.wrote_risks_one': '1 punt geopend in het risicoregister',
    'playbooks.compliance.wrote_evidence': 'deze beoordeling staat op de bewijsketen',
    'playbooks.compliance.open_ropa': 'Open deze vermelding in het verwerkingsregister',
    'playbooks.compliance.disclaimer': 'Een lezing van wat er gebouwd is, geen juridisch advies — de review zelf wijzigde niets.',
    'playbooks.compliance.frameworks': 'Kaders',
    'playbooks.compliance.findings': 'Bevindingen',

    // ── Fase: toegang (wie gebruikt de app, en met welke rol) ───────────────
    'playbooks.phase.access': 'Toegang',
    'playbooks.fact.access': 'Toegang ingesteld',
    'playbooks.access.title': 'Wie gebruikt "{name}"?',
    'playbooks.access.intro': 'Zeg het in één zin of stel het zelf in. Er wordt niets toegepast tot jij het goedkeurt.',
    'playbooks.access.failed': 'Deze fase is niet gelukt — probeer het opnieuw.',
    'playbooks.access.no_app': 'Er is geen app om toegang toe te geven.',
    'playbooks.access.ask_label': 'Zeg wie deze app moet gebruiken',
    'playbooks.access.ask_placeholder': 'bijv. Finance mag meekijken, Ann keurt goed, verder niemand.',
    'playbooks.access.ask_send': 'Voorstellen',
    'playbooks.access.asking': 'Bezig met lezen…',
    'playbooks.access.ask_failed': 'De assistent kon dat niet lezen — zeg het eens anders.',
    'playbooks.access.unresolved': '{kind} "{name}" niet gevonden',
    'playbooks.access.audience': 'Wie de app mag openen',
    'playbooks.access.private': 'Alleen ik',
    'playbooks.access.organisation': 'De hele organisatie',
    'playbooks.access.groups': 'Gekozen groepen',
    'playbooks.access.no_groups': 'Geen groepen die jij hier ziet — vraag het hierboven in een zin.',
    'playbooks.access.group_roles': 'Wat een groep mag',
    'playbooks.access.people': 'Een rol voor één persoon',
    'playbooks.access.role_for': 'Rol voor {name}',
    'playbooks.access.role_scope': 'ziet alleen rijen waar {column} {value} is',
    'playbooks.access.role_all': 'ziet elke rij',
    'playbooks.access.sum_rules': '{n} daarvan zien alleen hun eigen rijen',
    'playbooks.access.role_app': 'Mag de app gebruiken',
    'playbooks.access.role_member': 'Lid',
    'playbooks.access.loading': 'De rollen van de app worden gelezen…',
    'playbooks.access.approve': 'Goedkeuren en toepassen',
    'playbooks.access.discard': 'Weggooien',
    'playbooks.access.gate': 'Er wordt niets weggeschreven voordat jij op Goedkeuren drukt.',
    'playbooks.access.apply_failed': 'Kon niet toepassen: {what}',
    'playbooks.access.sum_org': 'de hele organisatie',
    'playbooks.access.sum_private': 'niemand behalve jij',
    'playbooks.access.sum_shared': 'Gedeeld met {who}',
    'playbooks.access.sum_roles': '{n} nieuwe rol(len)',
    'playbooks.access.sum_people': '{n} persoon/personen een rol gegeven',
    'playbooks.access.sum_nothing': 'Er verandert niets — de app blijft alleen van jou.',
    'playbooks.access.now_private': 'Alleen jij kunt hem openen',
    'playbooks.access.now_org': 'Iedereen in de organisatie kan hem openen',
    'playbooks.access.now_groups': '{n} groepen kunnen hem openen',
    'playbooks.access.now_groups_one': '1 groep kan hem openen',
    'playbooks.access.now_named': '{n} personen hebben een benoemde rol',
    'playbooks.access.now_named_one': '1 persoon heeft een benoemde rol',
    'playbooks.access.now_nobody': 'Nog niemand heeft een benoemde rol',
    'playbooks.access.ask_title': 'Zeg wie hem moet gebruiken',
    'playbooks.access.eg_finance': 'Finance mag meekijken, verder niemand.',
    'playbooks.access.eg_scoped': 'Een rol per leverancier — ieder ziet alleen zijn eigen rijen.',
    'playbooks.access.eg_me': 'Voorlopig alleen voor mij.',
    'playbooks.access.role_none_words': 'Geen toegang',
    'playbooks.access.already': 'heeft nu "{role}"',
    'playbooks.access.people_search': 'Zoek iemand…',
    'playbooks.access.people_none': 'Niemand met die naam.',
    'playbooks.access.will_do': 'Goedkeuren doet dit:',
    'playbooks.access.will_nothing': 'Nog niets gekozen',
    'playbooks.access.change_private': 'Haal de app uit de deling — alleen jij kunt hem openen.',
    'playbooks.access.change_org': 'Publiceer hem voor iedereen in de organisatie.',
    'playbooks.access.change_groups': 'Publiceer hem voor {names}.',
    'playbooks.access.change_role': 'Maak de rol "{label}".',
    'playbooks.access.change_role_scoped': 'Maak de rol "{label}", die {what}.',
    'playbooks.access.change_group_role': 'Geef {group} de rol "{role}".',
    'playbooks.access.change_member': 'Geef {name} de rol "{role}".',
    'playbooks.access.change_nc': 'Zet de app in je Nextcloud-appmenu.',
    'playbooks.access.change_copy': 'Publiceren maakt een kopie van de app precies zoals hij nu is.',
    'playbooks.access.why_empty': 'Kies wie de app mag openen, of zeg het hierboven in een zin.',
    'playbooks.access.why_no_group': 'Kies minstens één groep, of kies een ander publiek.',
    'playbooks.access.published_now': 'Nu gepubliceerd{v}. Met Goedkeuren publiceer je een verse kopie van de app zoals hij nu is.',
    'playbooks.access.private_now': 'Voorlopig een priv\u00e9-concept. Kies je een publiek en keur je goed, dan wordt een kopie van de app zoals hij nu is gepubliceerd.',
    'playbooks.access.nc_menu': 'Tonen in het Nextcloud-appmenu',
    'playbooks.access.nc_menu_desc': 'Zet de app in de bovenbalk van de Nextcloud van je organisatie, op een eigen pagina. Iedereen daar ziet het icoon; alleen het publiek hierboven kan hem openen.',
    'playbooks.access.nc_not_connected': 'Er is nog geen Nextcloud gekoppeld — het icoon verschijnt zodra dat wel zo is.',
    'playbooks.access.nc_synced': 'Hij staat in het Nextcloud-appmenu — herlaad Nextcloud om hem te zien.',
    'playbooks.access.nc_pending': 'Het icoon verschijnt binnen een paar minuten in Nextcloud.',
    'playbooks.access.sum_nc_menu': 'in het Nextcloud-appmenu',
    'playbooks.access.blockers': 'De app zelf houdt het publiceren tegen:',

    // ── Fase-inspecteur, de rail en het ontwerp herzien ─────────────────────
    'playbooks.inspect.title': 'Wat deze fase deed',
    'playbooks.inspect.close': 'Sluiten',
    'playbooks.inspect.took': 'Duurde {time}',
    'playbooks.inspect.summary': 'Wat er geland is',
    'playbooks.inspect.error': 'Wat er misging',
    'playbooks.inspect.brief': 'De opdracht waar de AI mee werkt',
    'playbooks.inspect.made': 'Wat het opleverde',
    'playbooks.inspect.columns': 'Kolommen',
    'playbooks.inspect.empty': 'Deze fase heeft nog niet gedraaid.',
    'playbooks.inspect.stuck': 'Duurt het te lang? Sla hem over, of Stop en hervat — bij hervatten mislukt alles wat nog draait.',
    'playbooks.inspect.key': 'Sleutel',
    'playbooks.inspect.rows': 'Rijen',
    'playbooks.inspect.kind': 'Soort',
    'playbooks.inspect.run': 'Uitvoering',
    'playbooks.inspect.added': 'Toegevoegd',
    'playbooks.inspect.screens': 'Schermen',
    'playbooks.inspect.elements': 'Elementen',
    'playbooks.inspect.accent': 'Uiterlijk',
    'playbooks.inspect.open_automation': 'Open de automatisering',
    'playbooks.inspect.open_app': 'Open de app',
    'playbooks.rail.collapse': 'Verberg de fases',
    'playbooks.rail.expand': 'Toon de fases',
    'playbooks.rail.open_phase': 'Laat zien wat deze fase deed',
    'playbooks.design.revise_label': 'Vraag om een wijziging',
    'playbooks.design.revise_placeholder': 'Zet de totalen bovenaan, geef elke leverancier een eigen scherm…',
    'playbooks.design.revise_send': 'Opnieuw tekenen',
    'playbooks.design.revising': 'Wordt opnieuw getekend…',
    'playbooks.design.revise_hint': 'Het ontwerp wordt met jouw wijziging opnieuw getekend — de app wordt gebouwd op wat hier staat.',
    'playbooks.design.revise_failed': 'De ontwerper kon het niet opnieuw tekenen — zeg het eens anders.',
    'playbooks.design.revisions': 'Je vroeg om: {list}',
};

// The Dutch really is the English word (or a proper name).
const SAME_AS_ENGLISH = [
    'playbooks.compliance.kind_app',
    'playbooks.compliance.open_center', // identical
    'playbooks.access.role_none', // identical
    'studio.tab.playbooks',      // "Playbooks"
    'studio.new.playbook',       // "Playbook"
    'playbooks.title',           // "Playbooks"
    'playbooks.heading',         // "Playbooks"
    'playbooks.design.look', // identical
    'playbooks.done.elapsed', // identical
    'playbooks.new.recipe', // identical
    'playbooks.fact.app', // identical
    'playbooks.state.pending', // identical
    'playbooks.phase.app',       // "App"
    'playbooks.new.tier',        // "Model"
    'playbooks.bar.stop',        // "Stop"
    'playbooks.handoff.stop',    // "Stop"
    'playbooks.done.app',        // "App"
];

async function up() {
    const languageStore = require('../stores/languageStore');
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-playbooks-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS, SAME_AS_ENGLISH };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-playbooks-translations failed:', e.message);
        process.exit(1);
    });
}
