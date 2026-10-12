#!/usr/bin/env node
/**
 * Dutch for chat signals (namespace chat_monitoring): checking whether the
 * Privacy Shield works in chat. The admin card in Compliance → Settings, the
 * processing-register preview, the notice text to copy, the 422 "missing"
 * labels, the figures table, the line and banner in the chat on web and
 * desktop, the embed's visitor line and its AI line, and the three checks.
 *
 * Word choices, so later edits stay consistent:
 * - "Chat signals" is "Chatsignalen". The purpose is always checking whether
 *   the Privacy Shield works; nothing here calls it monitoring people.
 * - Legal terms as a Dutch DPO writes them: verwerkingsgrondslag,
 *   gerechtvaardigd belang (with "belangenafweging" for the balancing test),
 *   ondernemingsraad, instemming, vervangende toestemming van de
 *   kantonrechter, cao, personeelsvertegenwoordiging, DPIA, FG (functionaris
 *   gegevensbescherming), toezichthouder, voorafgaande raadpleging,
 *   privacyverklaring, Verwerkingsregister, bewaartermijn. Articles are cited
 *   the Dutch way: "art. 6 lid 1 sub f AVG", "art. 27 lid 1 sub l WOR".
 * - Informal "je" throughout, also in the notice text and the embed.
 * - Product names stay as the Dutch UI shows them: Privacy Shield (het),
 *   Usage & Monitoring, Swarm, Bee Flow.
 * - The objection switch is "Tel mijn chatberichten niet mee"; the notice
 *   text and the "missing" label quote it word for word.
 *
 * SAME_AS_ENGLISH lists the keys whose Dutch is the English text itself
 * ("<5"). They are not seeded: t() already falls back to English, and a
 * seeded copy could not be told apart from a forgotten translation if the
 * English is reworded later.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-chat-monitoring-translations.js
 */

const NL_TRANSLATIONS = {
    // card: off state and framing
    'chat_monitoring.title': 'Chatsignalen (optioneel)',
    'chat_monitoring.purpose': 'Controleer of het Privacy Shield werkt in de chat: tel per chattype hoe het elk bericht heeft afgehandeld, en eventueel welke soorten persoonsgegevens het vond.',
    'chat_monitoring.not_people': 'Dit meet het Privacy Shield, niet mensen. Het wordt nooit gebruikt om medewerkers, hun prestaties, verzuim of gezondheid te beoordelen.',
    'chat_monitoring.legal_caveat': 'Met chatsignalen controleer je of het Privacy Shield werkt. Dit is geen juridisch advies. Je organisatie is de verwerkingsverantwoordelijke, dus jullie bepalen of je dit mag aanzetten en op welke verwerkingsgrondslag. Jullie voeren de DPIA uit, zorgen voor instemming van de ondernemingsraad waar die nodig is, en informeren mensen voordat het tellen begint. In kleine teams kunnen totalen nog steeds naar personen wijzen, daarom worden cijfers van minder dan 5 mensen (10 voor soorten gegevens) verborgen. Gezondheidsgegevens worden nooit geteld. Overleg met je functionaris gegevensbescherming (FG) of een jurist voordat je dit aanzet.',
    'chat_monitoring.never_kept_title': 'Wordt nooit bewaard',
    'chat_monitoring.never_kept_text': 'Wat iemand schreef',
    'chat_monitoring.never_kept_values': 'De persoonsgegevens die werden gevonden',
    'chat_monitoring.never_kept_ids': 'Wie het schreef: geen gebruiker, gesprek of agent',
    'chat_monitoring.never_kept_per_person': 'Cijfers per persoon, per agent of per gesprek',
    'chat_monitoring.never_kept_health': 'Gezondheidsgegevens, in welke vorm dan ook',
    'chat_monitoring.h2h_line': 'Berichten tussen mensen worden nooit geteld.',
    'chat_monitoring.set_up': 'Instellen',
    'chat_monitoring.change': 'Wijzigen',
    'chat_monitoring.save': 'Opslaan',
    'chat_monitoring.saving': 'Opslaan…',
    'chat_monitoring.cancel': 'Annuleren',
    'chat_monitoring.switch_on': 'Aanzetten',
    'chat_monitoring.switch_off': 'Uitzetten',
    'chat_monitoring.also_delete': 'Ook de verzamelde tellingen verwijderen',
    'chat_monitoring.delete_counts': 'Verzamelde tellingen verwijderen',
    'chat_monitoring.delete_confirm': 'Alle verzamelde tellingen van chatsignalen voor deze organisatie verwijderen? Dit kan niet ongedaan worden gemaakt.',
    'chat_monitoring.deleted': 'Verzamelde tellingen verwijderd.',
    'chat_monitoring.state_off': 'Uit',
    'chat_monitoring.starts_on': 'Begint op {date}',
    'chat_monitoring.on_since': 'Aan sinds {date}',
    'chat_monitoring.on_since_by': 'Aan sinds {date}, aangezet door {name}',
    'chat_monitoring.paused': 'Gepauzeerd: {surface}',
    'chat_monitoring.paused_hint': 'Het tellen en de melding in de chat zijn samen gestopt tot dit is opgelost:',
    'chat_monitoring.loading': 'De instellingen voor chatsignalen worden gelezen…',
    'chat_monitoring.read_failed': 'De instellingen voor chatsignalen konden niet worden gelezen.',
    'chat_monitoring.retry': 'Opnieuw proberen',
    'chat_monitoring.choose': 'Kies…',
    // surfaces and signals
    'chat_monitoring.surfaces_label': 'Waar wordt geteld',
    'chat_monitoring.surface.direct': 'Directe chat',
    'chat_monitoring.surface.direct_hint': 'Inclusief het Swarm-niveau en chats die in een project zijn gedeeld. Alleen de web- en desktopapp tellen mee; de mobiele app wordt nog niet geteld.',
    'chat_monitoring.surface.agent': 'Agentchat',
    'chat_monitoring.surface.agent_hint': 'Alleen leden van je eigen organisatie die je agents gebruiken.',
    'chat_monitoring.surface.agent_public': 'Ingesloten agents',
    'chat_monitoring.surface.agent_public_hint': 'Bezoekers van je website die chatten met een ingesloten agent.',
    'chat_monitoring.surface.notebook': 'Notitieboekchat',
    'chat_monitoring.surface.coming': 'Komt later',
    'chat_monitoring.population.employees': 'Medewerkers',
    'chat_monitoring.population.visitors': 'Websitebezoekers',
    'chat_monitoring.contributors': '{band} actieve mensen in de afgelopen 4 weken',
    'chat_monitoring.band.lt5': 'Minder dan 5',
    'chat_monitoring.band.5_9': '5 tot en met 9',
    'chat_monitoring.band.10_24': '10 tot en met 24',
    'chat_monitoring.band.25_plus': '25 of meer',
    'chat_monitoring.signals_label': 'Wat wordt geteld',
    'chat_monitoring.signal.outcomes': 'Uitkomsten van het Privacy Shield',
    'chat_monitoring.signal.outcomes_hint': 'Schoon, beschermd, geblokkeerd, toch verstuurd, scan mislukt, niet gescand. Staat altijd aan.',
    'chat_monitoring.signal.kinds': 'Soorten persoonsgegevens',
    'chat_monitoring.signal.kinds_hint': 'Welke soorten werden gevonden, zoals namen, e-mailadressen of identificatienummers, nooit de waarden zelf. Gezondheidsgegevens worden nooit geteld.',
    // legal basis
    'chat_monitoring.legal_basis_label': 'Verwerkingsgrondslag',
    'chat_monitoring.legal_basis.art6_1_f': 'Gerechtvaardigd belang (art. 6 lid 1 sub f AVG)',
    'chat_monitoring.legal_basis.art6_1_e': 'Taak van algemeen belang (art. 6 lid 1 sub e AVG)',
    'chat_monitoring.legal_basis.art6_1_c': 'Wettelijke verplichting (art. 6 lid 1 sub c AVG)',
    'chat_monitoring.legal_basis_hint': 'Overheidsorganisaties kunnen zich bij het uitvoeren van hun taken niet beroepen op gerechtvaardigd belang.',
    'chat_monitoring.ack_lia': 'We hebben de belangenafweging voor het gerechtvaardigd belang vastgelegd.',
    // DPIA
    'chat_monitoring.dpia_label': 'Gegevensbeschermingseffectbeoordeling (DPIA)',
    'chat_monitoring.dpia_current_until': 'Actueel tot {date}',
    'chat_monitoring.dpia_expired': 'Verlopen op {date}',
    'chat_monitoring.dpia_none': 'Geen DPIA vastgelegd',
    'chat_monitoring.dpia_record': 'DPIA vastleggen',
    'chat_monitoring.dpia_expires_hint': 'Zonder einddatum geldt een DPIA één jaar als actueel.',
    'chat_monitoring.dpia_hint': 'De DPIA moet ook gaan over: het eigen logboek van het Privacy Shield met wat het per gebruiker beschermde of blokkeerde, de overzichten per persoon in Usage & Monitoring, de projecthints die de resultaten van het Shield lezen voor teamchats in projecten, en dat totalen in kleine groepen naar personen kunnen wijzen.',
    'chat_monitoring.dpia_external': 'We bewaren de DPIA buiten Bee Flow',
    'chat_monitoring.dpia_ref': 'Kenmerk van de DPIA',
    'chat_monitoring.dpia_at': 'Datum van de DPIA',
    'chat_monitoring.dpia_risk': 'Risiconiveau in de DPIA',
    'chat_monitoring.dpia_valid_until': 'Geldig tot (optioneel)',
    'chat_monitoring.dpia_measures': 'Maatregelen (één per regel)',
    'chat_monitoring.dpia_record_failed': 'De DPIA kon niet worden vastgelegd. Probeer het opnieuw.',
    'chat_monitoring.risk.low': 'Laag',
    'chat_monitoring.risk.medium': 'Gemiddeld',
    'chat_monitoring.risk.high': 'Hoog',
    'chat_monitoring.prior_consultation_at': 'Voorafgaande raadpleging van de toezichthouder (datum)',
    'chat_monitoring.prior_consultation_hint': 'Verplicht als de DPIA een hoog risico vaststelt (art. 36 lid 1 AVG).',
    'chat_monitoring.dpo_advice_at': 'Advies van de FG over de DPIA (datum)',
    'chat_monitoring.dpo_advice_hint': 'Verplicht omdat er een functionaris gegevensbescherming is vastgelegd (art. 35 lid 2 AVG).',
    // works council
    'chat_monitoring.works_council_label': 'Ondernemingsraad',
    'chat_monitoring.works_council.consent': 'Instemming verkregen',
    'chat_monitoring.works_council.court_replacement': 'Vervangende toestemming van de kantonrechter',
    'chat_monitoring.works_council.not_applicable': 'Niet van toepassing',
    'chat_monitoring.works_council.pending': 'In afwachting',
    'chat_monitoring.works_council_pending_hint': 'Chats van medewerkers kunnen niet worden geteld zolang de instemming er nog niet is (art. 27 lid 1 sub l WOR).',
    'chat_monitoring.works_council_headcount_hint': 'Of dit geldt, hangt af van hoeveel mensen er in je onderneming werken, niet van hoeveel mensen Bee Flow gebruiken.',
    'chat_monitoring.works_council_reason_label': 'Waarom niet van toepassing',
    'chat_monitoring.works_council_reason.no_works_council': 'We hebben geen ondernemingsraad',
    'chat_monitoring.works_council_reason.pvt_without_consent_right': 'Personeelsvertegenwoordiging zonder instemmingsrecht',
    'chat_monitoring.works_council_reason.cao_regulates': 'Een cao regelt dit al',
    'chat_monitoring.works_council_reason.outside_nl': 'Buiten Nederland',
    'chat_monitoring.works_council_outside_nl_hint': 'Medezeggenschap loopt dan via het recht dat voor jullie geldt. Dat betekent niet dat er geen instemming nodig is.',
    'chat_monitoring.works_council_at': 'Datum van het besluit',
    'chat_monitoring.works_council_scope': 'Waar de instemming over gaat',
    'chat_monitoring.works_council_scope_hint': 'Meer tellen dan dit vraagt om nieuwe instemming, met een nieuwe datum.',
    'chat_monitoring.works_council_max_retention': 'Langste bewaartermijn waar de instemming over gaat (dagen)',
    // notice, start, retention, register
    'chat_monitoring.notice_url': 'Privacyverklaring voor medewerkers (link)',
    'chat_monitoring.notice_published_at': 'Gepubliceerd op',
    'chat_monitoring.ack_notice_published': 'De gepubliceerde privacyverklaring gaat ook over chatsignalen.',
    'chat_monitoring.visitor_notice_hint': 'Websitebezoekers zien je privacyverklaring, tenzij je hierboven een aparte verklaring instelt.',
    'chat_monitoring.effective_from': 'Startdatum',
    'chat_monitoring.effective_from_hint': 'Zeven dagen na het opslaan, zodat mensen het eerst te horen krijgen. Medewerkers zien de startdatum in de chat.',
    'chat_monitoring.ack_informed': 'Mensen zijn vóór deze datum geïnformeerd.',
    'chat_monitoring.retention_days': 'Bewaartermijn van de tellingen (dagen)',
    'chat_monitoring.retention_hint': '30 tot en met 90 dagen. Hele weken worden verwijderd zodra ze ouder zijn.',
    'chat_monitoring.ack_ropa': 'Ik heb de vermelding in het Verwerkingsregister bekeken.',
    'chat_monitoring.ropa_preview': 'Vermelding in het Verwerkingsregister',
    'chat_monitoring.ropa.preview_note': 'Voorbeeld: de vermelding verschijnt in het Verwerkingsregister zodra je opslaat.',
    'chat_monitoring.ropa.f_purpose': 'Doel',
    'chat_monitoring.ropa.f_processing': 'Verwerking',
    'chat_monitoring.ropa.f_data': 'Gegevens',
    'chat_monitoring.ropa.f_subjects': 'Betrokkenen',
    'chat_monitoring.ropa.f_legal_basis': 'Verwerkingsgrondslag',
    'chat_monitoring.ropa.f_retention': 'Bewaartermijn',
    'chat_monitoring.ropa.f_security': 'Beveiligingsmaatregelen',
    'chat_monitoring.ropa.name': 'Chatsignalen: controleren of het Privacy Shield werkt',
    'chat_monitoring.ropa.purpose': 'Controleren of het Privacy Shield werkt bij chatberichten (art. 32 lid 1 sub d AVG) en dit register actueel houden (art. 30 lid 1 sub c AVG). Wordt nooit gebruikt om medewerkers, hun prestaties, verzuim of gezondheid te beoordelen.',
    'chat_monitoring.ropa.processing': 'Voor elk geteld bericht wordt de uitkomst die het Privacy Shield al had bepaald (en, als dat aanstaat, de soorten persoonsgegevens die het vond) binnen hetzelfde verzoek omgezet in een teller. Het bericht wordt hiervoor niet opgeslagen.',
    'chat_monitoring.ropa.retention': '{days} dagen. Een hele week (een dag voor websitebezoekers) wordt verwijderd zodra die helemaal ouder is dan {days} dagen.',
    'chat_monitoring.ropa.legal_basis_f': 'Art. 6 lid 1 sub f AVG, gerechtvaardigd belang: persoonsgegevens veilig houden wanneer mensen AI gebruiken in de chat (netwerk- en informatiebeveiliging, overweging 49), afgewogen in de DPIA',
    'chat_monitoring.ropa.legal_basis_e': 'Art. 6 lid 1 sub e AVG, taak van algemeen belang',
    'chat_monitoring.ropa.legal_basis_c': 'Art. 6 lid 1 sub c AVG, wettelijke verplichting (art. 32 AVG)',
    'chat_monitoring.ropa.data_counts': 'Wekelijkse tellingen per chattype (medewerkers) en dagelijkse tellingen (websitebezoekers) van hoe het Privacy Shield berichten afhandelde',
    'chat_monitoring.ropa.data_kinds': 'Tellingen van de soorten gevonden persoonsgegevens, zonder de waarden; gezondheidsgegevens worden nooit geteld',
    'chat_monitoring.ropa.data_small_groups': 'In kleine groepen kunnen deze tellingen over herkenbare personen gaan',
    'chat_monitoring.ropa.subjects_employees': 'Medewerkers en leden die dit gebruiken: {surfaces}',
    'chat_monitoring.ropa.subjects_visitors': 'Websitebezoekers die chatten met een ingesloten agent',
    'chat_monitoring.ropa.subjects_third_parties': 'Mensen die in die berichten worden genoemd (derden)',
    'chat_monitoring.small_groups': 'Cijfers van minder dan 5 mensen (10 voor soorten gegevens) worden verborgen. In kleine groepen kunnen totalen nog steeds naar personen wijzen.',
    'chat_monitoring.notice_template_title': 'Tekst voor de privacyverklaring, om te kopiëren',
    'chat_monitoring.notice_template': 'Chatsignalen bij {organisation}\n\nWat we doen: om te controleren of het Privacy Shield werkt, tellen we hoe het berichten heeft afgehandeld in {surfaces}. We tellen de uitkomst, bijvoorbeeld beschermd, geblokkeerd, toch verstuurd of scan mislukt{kinds_clause}. De telling bewaart niet wat je schreef, niet de persoonsgegevens die werden gevonden en niet wie het schreef.\n\nWaarom, en op welke grondslag: {legal_basis}.{interest}\n\nWat we er nooit mee doen: we kijken niet naar personen. De tellingen worden nooit gebruikt om jou, je prestaties, verzuim of gezondheid te beoordelen. Berichten tussen collega\'s worden nooit geteld.\n\nKleine groepen: als maar weinig mensen een chat gebruiken, kunnen totalen toch naar personen wijzen. We verbergen cijfers van minder dan 5 mensen (10 voor soorten gegevens).\n\nHoe lang: {retention_days} dagen. Het tellen begint op {start_date}.\n\nHet eigen activiteitenlogboek van het Privacy Shield: los van deze tellingen houdt het Privacy Shield per gebruiker bij wat het beschermde of blokkeerde: het tijdstip, de soort gegevens en de actie, nooit de tekst van het bericht. Beheerders zien dit in Usage & Monitoring, ook in overzichten per persoon: een ranglijst van mensen naar Privacy Shield-meldingen en een lijst van de meldingen per persoon. Bewaartermijn: {shield_log_retention}. Het logboek wordt alleen gebruikt om vermoedelijke incidenten te onderzoeken.\n\nJe keuzes: je kunt bezwaar maken. Kies in de chat "Tel mijn chatberichten niet mee", dan worden je berichten niet meer geteld. Wil je je gegevens inzien of laten wissen, gebruik dan {dsr_channel}.\n\nVragen: neem contact op met onze functionaris gegevensbescherming via {dpo_contact}.',
    'chat_monitoring.notice_template_kinds': ', en welke soorten persoonsgegevens het vond, zoals namen of e-mailadressen',
    'chat_monitoring.notice_interest_f': ' Ons gerechtvaardigd belang is dat persoonsgegevens veilig blijven wanneer mensen AI gebruiken: we moeten weten of de bescherming werkt.',
    'chat_monitoring.notice_no_limit': 'zolang de installatie het bewaart (er is geen termijn ingesteld)',
    'chat_monitoring.notice_days': '{days} dagen',
    'chat_monitoring.notice_gap': '[nog invullen]',
    'chat_monitoring.copy': 'Kopiëren',
    'chat_monitoring.copied': 'Gekopieerd',
    // errors and missing codes
    'chat_monitoring.err_preconditions': 'Dit kan nog niet worden opgeslagen. Wat ontbreekt:',
    'chat_monitoring.err_forbidden': 'Alleen een beheerder van de organisatie kan dit aanzetten of meer laten tellen. Jij kunt het uitzetten of minder laten tellen.',
    'chat_monitoring.err_generic': 'Opslaan is niet gelukt. Probeer het opnieuw.',
    'chat_monitoring.missing.surfaces_required': 'Kies minstens één chattype',
    'chat_monitoring.missing.surface_not_available': 'Een chattype dat deze versie niet kan tellen',
    'chat_monitoring.missing.outcomes_required': 'De uitkomsten van het Privacy Shield moeten worden geteld',
    'chat_monitoring.missing.signal_not_available': 'Iets om te tellen dat deze versie niet ondersteunt',
    'chat_monitoring.missing.legal_basis': 'Een verwerkingsgrondslag',
    'chat_monitoring.missing.lia_documented': 'Bevestiging dat de belangenafweging is vastgelegd',
    'chat_monitoring.missing.retention_days': 'Een bewaartermijn van 30 tot en met 90 dagen',
    'chat_monitoring.missing.notice_published': 'Bevestiging dat de gepubliceerde privacyverklaring ook over chatsignalen gaat',
    'chat_monitoring.missing.ropa_reviewed': 'Bevestiging dat je de vermelding in het Verwerkingsregister hebt bekeken',
    'chat_monitoring.missing.effective_from': 'Een startdatum die niet in het verleden ligt',
    'chat_monitoring.missing.informed_before_start': 'Bevestiging dat mensen vóór een eerdere startdatum zijn geïnformeerd',
    'chat_monitoring.missing.objection_unavailable': 'De keuze "Tel mijn chatberichten niet mee", die in deze versie ontbreekt',
    'chat_monitoring.missing.default_bucket_has_orgs': 'Chats van medewerkers zonder organisatie kunnen niet worden geteld op een installatie met organisaties',
    'chat_monitoring.missing.dpia': 'Een actuele DPIA',
    'chat_monitoring.missing.dpia_risk_level': 'Het risiconiveau van de externe DPIA',
    'chat_monitoring.missing.prior_consultation_at': 'De datum van de voorafgaande raadpleging (DPIA met hoog risico)',
    'chat_monitoring.missing.dpo_advice_at': 'De datum van het advies van de FG',
    'chat_monitoring.missing.works_council': 'Instemming van de ondernemingsraad, of waarom die niet nodig is',
    'chat_monitoring.missing.works_council_reason': 'Waarom de ondernemingsraad niet van toepassing is',
    'chat_monitoring.missing.works_council_at': 'De datum van het besluit van de ondernemingsraad',
    'chat_monitoring.missing.works_council_scope': 'Instemming van de ondernemingsraad die dit dekt, met een nieuwe datum',
    'chat_monitoring.missing.notice_url': 'Een https-link naar de privacyverklaring voor medewerkers',
    'chat_monitoring.missing.notice_published_at': 'De publicatiedatum van de privacyverklaring, op of vóór de startdatum',
    'chat_monitoring.missing.agent_public_notice': 'Een privacyverklaring via https voor websitebezoekers',
    // labels
    'chat_monitoring.outcome.clean': 'Schoon',
    'chat_monitoring.outcome.protected': 'Beschermd',
    'chat_monitoring.outcome.blocked': 'Geblokkeerd',
    'chat_monitoring.outcome.sent_unprotected': 'Toch verstuurd',
    'chat_monitoring.outcome.scan_failed_open': 'Scan mislukt, verstuurd',
    'chat_monitoring.outcome.scan_failed_closed': 'Scan mislukt, tegengehouden',
    'chat_monitoring.outcome.unscanned': 'Niet gescand',
    'chat_monitoring.kind.name': 'Namen',
    'chat_monitoring.kind.email': 'E-mailadressen',
    'chat_monitoring.kind.phone': 'Telefoonnummers',
    'chat_monitoring.kind.address': 'Adressen',
    'chat_monitoring.kind.birth': 'Geboortedata',
    'chat_monitoring.kind.financial': 'Bank- en betaalgegevens',
    'chat_monitoring.kind.online_id': 'Online-identificatoren',
    'chat_monitoring.kind.id_number': 'Identificatienummers',
    'chat_monitoring.kind.credential': 'Geheimen en wachtwoorden',
    'chat_monitoring.kind.other': 'Andere persoonsgegevens',
    // summary
    'chat_monitoring.summary.show': 'Cijfers tonen',
    'chat_monitoring.summary.loading': 'De cijfers worden gelezen…',
    'chat_monitoring.summary.failed': 'De cijfers konden niet worden gelezen. Probeer het later opnieuw.',
    'chat_monitoring.summary.title': 'Afgelopen {days} dagen',
    'chat_monitoring.summary.days_30': '30 dagen',
    'chat_monitoring.summary.days_90': '90 dagen',
    'chat_monitoring.summary.col_surface': 'Chattype',
    'chat_monitoring.summary.col_turns': 'Berichten',
    'chat_monitoring.summary.col_scanned': 'Gescand',
    'chat_monitoring.summary.col_protected': 'Beschermd bij een vondst',
    'chat_monitoring.summary.col_blocked': 'Geblokkeerd',
    'chat_monitoring.summary.col_sent_unprotected': 'Toch verstuurd',
    'chat_monitoring.summary.col_failed': 'Scan mislukt',
    'chat_monitoring.summary.col_unscanned_external': 'Niet gescand, extern model',
    'chat_monitoring.summary.col_kinds': 'Gevonden soorten',
    'chat_monitoring.summary.kind_protected': 'beschermd',
    'chat_monitoring.summary.kind_exposed': 'toch verstuurd',
    'chat_monitoring.summary.hidden': 'verborgen',
    'chat_monitoring.summary.hidden_hint': 'Verborgen, zodat je met de andere cijfers geen klein aantal kunt terugrekenen.',
    'chat_monitoring.summary.suppressed': 'Verborgen: minder dan {k} mensen gebruikten dit in deze periode.',
    'chat_monitoring.summary.no_full_period': 'Nog geen volledige week.',
    'chat_monitoring.summary.no_data': 'Nog geen tellingen.',
    'chat_monitoring.summary.weeks_note': 'Chats van medewerkers worden alleen in volledige weken getoond.',
    'chat_monitoring.summary.approx': 'De tellingen zijn bij benadering.',
    'chat_monitoring.summary.audit_note': 'Het openen van deze tabel wordt vastgelegd in het toegangslogboek.',
    'chat_monitoring.summary.checks_link': 'Bekijk de checks',
    // in-chat (web, desktop)
    'chat_monitoring.chat.line': 'Je organisatie telt hoe het Privacy Shield berichten hier afhandelt. De telling bewaart niet wat je schreef of wie het schreef.',
    'chat_monitoring.chat.line_kinds': 'Je organisatie telt hoe het Privacy Shield berichten hier afhandelt, en welke soorten persoonsgegevens het vindt. De telling bewaart niet wat je schreef of wie het schreef.',
    'chat_monitoring.chat.scheduled': 'Vanaf {date} telt je organisatie hoe het Privacy Shield berichten hier afhandelt. De telling bewaart niet wat je schreef of wie het schreef.',
    'chat_monitoring.chat.scheduled_kinds': 'Vanaf {date} telt je organisatie hoe het Privacy Shield berichten hier afhandelt, en welke soorten persoonsgegevens het vindt. De telling bewaart niet wat je schreef of wie het schreef.',
    'chat_monitoring.chat.notice_link': 'Privacyverklaring',
    'chat_monitoring.chat.dont_count': 'Tel mijn chatberichten niet mee',
    'chat_monitoring.chat.not_counted': 'Je chatberichten worden niet meegeteld.',
    'chat_monitoring.chat.count_again': 'Weer meetellen',
    'chat_monitoring.chat.pref_error': 'Je keuze kon niet worden opgeslagen. Probeer het opnieuw.',
    'chat_monitoring.chat.banner_title_scheduled': 'Chatsignalen beginnen op {date}',
    'chat_monitoring.chat.banner_title_on': 'Chatsignalen staan aan',
    'chat_monitoring.chat.banner_body': 'Je organisatie controleert of het Privacy Shield werkt door te tellen hoe het berichten in deze chat afhandelt. De telling bewaart niet wat je schreef of wie het schreef. Je kunt ervoor kiezen om niet meegeteld te worden.',
    'chat_monitoring.chat.dismiss': 'Begrepen',
    // embed (website visitors)
    'chat_monitoring.embed.ai_line': 'Je chat met een AI-assistent, niet met een mens.',
    'chat_monitoring.embed.line': 'Deze chat telt hoe het Privacy Shield persoonsgegevens in berichten afhandelt. Daarvoor wordt geen berichtinhoud bewaard.',
    'chat_monitoring.embed.line_kinds': 'Deze chat telt hoe het Privacy Shield persoonsgegevens in berichten afhandelt, en welke soorten het vindt. Daarvoor wordt geen berichtinhoud bewaard.',
    'chat_monitoring.embed.scheduled': 'Vanaf {date} telt deze chat hoe het Privacy Shield persoonsgegevens in berichten afhandelt. Daarvoor wordt geen berichtinhoud bewaard.',
    'chat_monitoring.embed.privacy_link': 'Privacyverklaring',
    'chat_monitoring.embed.dont_count': 'Tel mijn berichten niet mee',
    // checks
    'chat_monitoring.checks.gdpr_art32_chat_cov.title': 'Het Privacy Shield dekt chatberichten',
    'chat_monitoring.checks.gdpr_art32_chat_cov.desc': 'Meet per chattype of berichten een scan van het Privacy Shield hebben doorlopen voordat ze het model bereikten, en of gevonden persoonsgegevens werden beschermd. Leest alleen de totalen van chatsignalen, waarin cijfers onder de 5 verborgen zijn.',
    'chat_monitoring.checks.gdpr_art32_chat_cov.fix': 'Dicht de gaten die de details noemen: zet het Privacy Shield aan voor de chattypes die ongescand blijven, zorg dat de guard-service bereikbaar is, of maak het beleid strenger waar veel berichten toch worden verstuurd. Leg het Shield uit aan mensen die vaak kiezen om toch te versturen.',
    'chat_monitoring.checks.gdpr_art35_chat_mon.title': 'Chatsignalen houden hun waarborgen',
    'chat_monitoring.checks.gdpr_art35_chat_mon.desc': 'Zolang chatsignalen aanstaan, moeten de DPIA, het besluit van de ondernemingsraad en waar het over gaat, de gepubliceerde privacyverklaring, de verwerkingsgrondslag en de bewaartermijn op orde blijven. Een chattype waarvan een waarborg vervalt, stopt met tellen tot dat is opgelost.',
    'chat_monitoring.checks.gdpr_art35_chat_mon.fix': 'Los op wat de details noemen onder Compliance → Instellingen → Chatsignalen: vernieuw de DPIA, leg het besluit van de ondernemingsraad vast, publiceer de privacyverklaring vóór de startdatum, of zet het chattype uit.',
    'chat_monitoring.checks.gdpr_art35_per_user_view.title': 'Overzichten per persoon van het Privacy Shield zijn beoordeeld',
    'chat_monitoring.checks.gdpr_art35_per_user_view.desc': 'Usage & Monitoring kan mensen bij naam rangschikken op gebeurtenissen van het Privacy Shield en gebeurtenissen per persoon tonen. Zo\'n overzicht is geschikt om gedrag of prestaties van medewerkers te controleren, dus het vraagt om een DPIA, instemming van de ondernemingsraad die het dekt, en een privacyverklaring die het noemt.',
    'chat_monitoring.checks.gdpr_art35_per_user_view.fix': 'Leg een DPIA vast die de overzichten per persoon dekt, zorg voor instemming van de ondernemingsraad waar die nodig is, noem de overzichten in je privacyverklaring voor medewerkers, en beperk hoe lang gebeurtenissen per persoon worden bewaard. Leg vóór 2 december 2027 een beoordeling van de ranglijst onder de AI-verordening vast, of haal de ranglijst weg.',
};

/** Keys whose Dutch is the English text itself; not seeded (see the header). */
const SAME_AS_ENGLISH = [
    'chat_monitoring.summary.lt5',
];

async function up({ languageStore = require('../stores/languageStore') } = {}) {
    // Atomic across replicas (advisory lock in mutateConfig); existing values
    // win, only missing keys are added.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-chat-monitoring-translations: added ${added} NL keys`);
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
