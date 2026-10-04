#!/usr/bin/env node
/**
 * One-time migration: Dutch for the Privacy Shield round-3 layout (2026-09).
 *
 * Round 3 rebuilt every pane on the same features: the header now shows the
 * detection service's state and a numbered PATH strip, the Overview became a
 * review card plus four step cards, "What we look for" one matrix, the two
 * checks a flow card with two numbered cards, and "What happened" one log of
 * messages and calls with findings, KPIs and a day-by-day chart. Each pane
 * has its own namespace (shield_shell, shield_overview, shield_look,
 * shield_checks, shield_activity); this catalogue owns all five. The map's
 * new strings are in add-nl-egress-map-translations; "Your own data"
 * (shield_data) has no Dutch catalogue yet and stays English as a whole
 * rather than half.
 *
 * Terminology follows add-nl-privacy-shield-redesign-translations: setting
 * and level names stay English ("How strict", "Low", "High", "Show what was
 * sent", "EU-hosted AI only"), the prose around them is Dutch;
 * persoonsgegevens, soort, placeholder, aanroep, detectieservice.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-privacy-shield-v3-translations.js
 */

const NL_TRANSLATIONS = {
    // ── The shell: header, path strip, save bar, How this works ───────────────
    'shield_shell.guard_running': 'Detectie actief',
    'shield_shell.guard_running_checked': 'Detectie actief · gecontroleerd {when}',
    'shield_shell.hiw_two_checks': 'Stap 3 is de poort die altijd dichtgaat; stap 4 is één extra blik, alleen vóór een model buiten je organisatie, en de enige plek waar een medewerker iets te zeggen heeft. Het bericht bij stap 3 tegenhouden levert géén Ask-venster op — dat is stap 4 op “Ask”.',
    'shield_shell.hiw_two_checks_lead': 'Stap 3 en 4 zijn geen alternatieven.',
    'shield_shell.path_label': 'Pad',
    'shield_shell.save_changes': 'Wijzigingen opslaan',
    'shield_shell.summary_kinds': '{n} van {total} soorten',
    'shield_shell.summary_last_days': 'laatste {n} dagen',
    'shield_shell.summary_replace': 'vervangen door placeholders',
    'shield_shell.summary_review': '{n} om na te kijken',
    'shield_shell.unsaved_on_one': 'op 1 stap:',

    // ── Overview: review card, step cards, last 30 days, what people see, compliance ───
    'shield_overview.add_step': 'Toevoegen aan {step}',
    'shield_overview.allow_public': '221 bekende bedrijven',
    'shield_overview.allow_public_own': '221 bekende bedrijven + {n} van jezelf',
    'shield_overview.change_setting': '{setting} wijzigen',
    'shield_overview.change_step': '{step} wijzigen',
    'shield_overview.compliance_desc': 'Opslaan voert deze checks in het Compliance Center opnieuw uit.',
    'shield_overview.compliance_title': 'Gekoppeld aan Compliance',
    'shield_overview.covered': 'Gedekt',
    'shield_overview.held_back_value': '{external} van {total} buiten · {internal} van {total} eigen server',
    'shield_overview.hold_back': 'Soorten tegenhouden',
    'shield_overview.kpi_replaced': 'vervangen',
    'shield_overview.kpi_stopped': 'tegengehouden',
    'shield_overview.kpi_tool': 'vertrok met een tool',
    'shield_overview.last_days': 'Laatste {days} dagen',
    'shield_overview.not_covered': 'Niet gedekt',
    'shield_overview.own_types_none': 'Nog geen',
    'shield_overview.preview_audience': 'iedereen in dit gesprek',
    'shield_overview.preview_desc': 'Zo ziet een chat eruit met je huidige instellingen.',
    'shield_overview.preview_replaced': '{n} gegevens vervangen',
    'shield_overview.preview_replaced_tail': 'voordat dit naar de AI ging',
    'shield_overview.preview_reveal': 'Klik om te zien',
    'shield_overview.review_action_title': 'Placeholders zitten niet in je plan',
    'shield_overview.review_allow_title': '{n} uitzondering van jezelf wordt nooit verborgen',
    'shield_overview.review_allow_title_plural': '{n} uitzonderingen van jezelf worden nooit verborgen',
    'shield_overview.review_basis': 'op basis van je instellingen',
    'shield_overview.review_basis_evidence': 'op basis van je instellingen en de laatste {days} dagen',
    'shield_overview.review_count': '{n} punt om na te kijken',
    'shield_overview.review_count_plural': '{n} punten om na te kijken',
    'shield_overview.review_dlp_body': 'Optioneel. Staat het aan, dan zien mensen wat er op het punt staat te vertrekken en kunnen ze aanwijzen wat de detectie miste.',
    'shield_overview.review_dlp_title': 'Niemand krijgt een laatste check vóór een AI buiten je organisatie',
    'shield_overview.review_eu_title': 'EU-hosted AI only staat uit',
    'shield_overview.review_guard_missing': 'De detectieservice is niet geïnstalleerd',
    'shield_overview.review_guard_unreachable': 'De detectieservice reageert niet',
    'shield_overview.review_kinds_title': 'Er zijn geen soorten gegevens gekozen',
    'shield_overview.review_reveal_body': '“Show what was sent” staat aan. Dat is goed voor het vertrouwen, maar het betekent ook dat gedeelde gesprekken de originele waarden laten zien.',
    'shield_overview.review_reveal_title': 'Iedereen in een gesprek kan de echte waarden zichtbaar maken',
    'shield_overview.review_tools_left': 'In de laatste {days} dagen vertrok {n} tool-aanroep met persoonsgegevens.',
    'shield_overview.review_tools_left_abroad': 'In de laatste {days} dagen vertrok {n} tool-aanroep met persoonsgegevens, naar een server buiten Europa.',
    'shield_overview.review_tools_left_abroad_plural': 'In de laatste {days} dagen vertrokken {n} tool-aanroepen met persoonsgegevens — {leaked} daarvan buiten Europa.',
    'shield_overview.review_tools_left_plural': 'In de laatste {days} dagen vertrokken {n} tool-aanroepen met persoonsgegevens.',
    'shield_overview.review_tools_none': 'Geen enkele soort wordt tegengehouden bij tools buiten je organisatie ({external} van {total}).',
    'shield_overview.review_tools_some': '{external} van {total} soorten worden tegengehouden bij tools buiten je organisatie.',
    'shield_overview.review_tools_title': 'Tools kunnen alle persoonsgegevens mee naar buiten nemen',
    'shield_overview.row_action': 'Actie',
    'shield_overview.row_kinds': 'Soorten gegevens',
    'shield_overview.row_knowledge': 'Kennisbanken',
    'shield_overview.row_last_check': 'Laatste check',
    'shield_overview.row_own_types': 'Je eigen soorten',
    'shield_overview.row_suggested': 'Voorgesteld',
    'shield_overview.rules_body': 'Deze regels gelden vóór regels op een losse agent. Als de twee elkaar tegenspreken, wint de strengste.',
    'shield_overview.rules_lead': 'Agents mogen strenger zijn, nooit losser.',
    'shield_overview.see_calls': 'Bekijk de aanroepen',
    'shield_overview.stand_subtitle': 'in de volgorde waarin een bericht erdoorheen gaat',

    // ── What we look for: intro, how strict, the one-table matrix, link cards ───
    'shield_look.col_count': '{n} van {total}',
    'shield_look.col_detect_sub': 'ernaar zoeken · {n} van {total}',
    'shield_look.col_external': 'Tegenhouden · tools buiten je org',
    'shield_look.col_external_locked': '{n} van {total} · Enterprise',
    'shield_look.col_external_none': '{n} van {total} — alles mag mee',
    'shield_look.col_internal': 'Tegenhouden · eigen server',
    'shield_look.group_hidden': '{n} van {total} verborgen',
    'shield_look.intro_body': 'Wat we vinden, wordt verborgen voor de AI. Dat gebeurt op je eigen server — er wordt niets naar een ander gestuurd om het te laten controleren.',
    'shield_look.intro_title': 'Voordat een bericht naar de AI gaat, leest Bee Flow het en zoekt het naar persoonsgegevens.',
    'shield_look.left_with_tools': '{n} meegenomen door tools',
    'shield_look.left_with_tools_title': '{n} tool-aanroepen namen deze soort mee in de afgelopen {days} dagen.',
    'shield_look.link_never': '{n} van jezelf. Alleen exacte overeenkomsten: "Shell" dekt "Shell Advies BV" niet.',
    'shield_look.link_never_public': '221 bekende bedrijven · {n} van jezelf. Alleen exacte overeenkomsten: "Shell" dekt "Shell Advies BV" niet.',
    'shield_look.link_own_empty': 'Nog niets — voeg projectcodes, klantnummers en meer toe.',
    'shield_look.matrix_hint': '{n} soorten · één rij per soort',
    'shield_look.public_orgs_note': '221 bekende bedrijven worden nooit verborgen',
    'shield_look.strict_advanced_show': 'Geavanceerd: exact percentage',
    'shield_look.strict_scale_high': 'verbergt meer, ook gewone woorden →',
    'shield_look.strict_scale_low': '← mist meer, minder onderbrekingen',

    // ── When we find something + Leaving your org: the flow card and the two checks ───
    'shield_checks.action_heading': 'Als we persoonsgegevens vinden',
    'shield_checks.automations_desc': 'Automatiseringen draaien zelfstandig, zonder dat iemand meekijkt. Hun gegevens en AI-stappen worden op dezelfde manier gecontroleerd als chat.',
    'shield_checks.dlp_desc': 'Vlak voordat een bericht naar een AI buiten je organisatie gaat, wordt het nog één keer op persoonsgegevens gecontroleerd en afgehandeld zoals jij kiest.',
    'shield_checks.eu_desc_bold': 'alleen modellen',
    'shield_checks.eu_desc_lead': 'Chats gaan alleen naar AI-modellen die in de EU worden gehost (in te stellen onder AI Config → Chat Models). Geldt voor',
    'shield_checks.eu_desc_tail': '— voor gekoppelde apps zoals Gmail gelden de tool-kolommen.',
    'shield_checks.every_sub': 'altijd aan · geldt voor elke AI, binnen of buiten je organisatie',
    'shield_checks.every_title': 'Bij elk bericht',
    'shield_checks.flow_done': 'klaar',
    'shield_checks.flow_every': 'elk bericht, altijd',
    'shield_checks.flow_inside': 'AI op je eigen server',
    'shield_checks.flow_kinds': '{n} soorten · op je eigen server',
    'shield_checks.flow_label': 'Hoe een bericht wordt gecontroleerd',
    'shield_checks.flow_look': 'Zoeken naar persoonsgegevens',
    'shield_checks.flow_off': 'uit',
    'shield_checks.flow_on': 'aan',
    'shield_checks.flow_outside': '② AI buiten je organisatie: laatste controle',
    'shield_checks.flow_tools_follow': 'Daarvoor gelden de tool-kolommen in de matrix.',
    'shield_checks.flow_tools_skip': 'Tool-aanroepen slaan ① en ② over',
    'shield_checks.flow_unlicensed': 'niet in je abonnement · in plaats daarvan tegengehouden',
    'shield_checks.integ_monitor_desc': 'Elke aanroep van een gekoppelde app wordt altijd vastgelegd. Dit controleert ook de inhoud, zodat de rapporten kunnen laten zien welke soort gegevens is vertrokken.',
    'shield_checks.leaving_sub': 'alleen voor een AI buiten je organisatie · de enige stap waarin mensen zelf beslissen',
    'shield_checks.leaving_title': 'Voordat het je organisatie verlaat',
    'shield_checks.raw_payload_desc': 'Voegt het origineel, de versie die de AI kreeg en de placeholders toe aan "Hoe ik aan dit antwoord kwam".',
    'shield_checks.raw_payload_warn': 'Iedereen die het gesprek kan openen, kan de echte waarden zichtbaar maken.',
    'shield_checks.scan_kbs_desc': 'Persoonsgegevens worden vervangen voordat ze worden opgeslagen. Dat is achteraf niet terug te draaien: de opgeslagen tekst is de gecontroleerde tekst.',
    'shield_checks.search_upload_desc': 'Zo komt er niets uit een bijgevoegd document in een zoekvak terecht.',
    'shield_checks.tokenize_desc_lead': 'De AI ziet',
    'shield_checks.tokenize_desc_tail': 'in plaats van het adres. Bee Flow zet de echte waarde terug in het antwoord.',
    'shield_checks.tools_gap_after_count': 'Stap ① en ② veranderen daar niets aan — houd soorten tegen in de',
    'shield_checks.tools_gap_count': '{n} tool-aanroepen bevatten persoonsgegevens in de afgelopen {days} dagen.',
    'shield_checks.tools_gap_count_one': '1 tool-aanroep bevatte persoonsgegevens in de afgelopen {days} dagen.',
    'shield_checks.tools_gap_link': 'tool-kolommen van de matrix',
    'shield_checks.tools_gap_no_count': 'Stap ① en ② gelden niet voor tool-aanroepen — houd soorten tegen in de',

    // ── What happened: in short, worth a look, KPIs, day by day, where it went, the log ───
    'shield_activity.action_held': 'Bestand tegengehouden',
    'shield_activity.action_partial_redacted': 'Deels vervangen',
    'shield_activity.action_stripped': 'Verborgen tekens verwijderd',
    'shield_activity.action_tool_blocked': 'Tool-aanroep gestopt',
    'shield_activity.action_tool_result_redacted': 'Verborgen in een tool-resultaat',
    'shield_activity.axis_day': 'Dag',
    'shield_activity.axis_dest': 'Bestemming',
    'shield_activity.axis_outcome': 'Uitkomst',
    'shield_activity.axis_region': 'Regio',
    'shield_activity.chip_pii': 'Bevat persoonsgegevens',
    'shield_activity.col_happened': 'Wat er gebeurde',
    'shield_activity.col_started': 'Begonnen in',
    'shield_activity.col_went': 'Ging naar',
    'shield_activity.count': '{n} van {total} berichten en aanroepen',
    'shield_activity.count_capped': '{n} van de laatste {total} berichten en aanroepen',
    'shield_activity.day_bar_label': '{day}: {n} berichten en aanroepen',
    'shield_activity.day_count': '{n} berichten en aanroepen',
    'shield_activity.day_count_one': '1 bericht of aanroep',
    'shield_activity.day_hint': 'wijs een dag aan voor details · klik om erop te filteren',
    'shield_activity.day_peak': 'piek {n} op {day}',
    'shield_activity.day_since': 'Alleen de meest recente rijen zijn geladen, dus dit loopt vanaf {date}.',
    'shield_activity.day_title': 'Per dag',
    'shield_activity.day_total': '{day} · {n} in totaal',
    'shield_activity.f_protected_body': 'Het verving of stopte persoonsgegevens {n} keer en liet niets door.',
    'shield_activity.f_protected_title': 'Niets kwam onbeschermd langs het schild',
    'shield_activity.f_tool_pii_held': 'Tools houden {held} van de {total} soorten tegen.',
    'shield_activity.f_tool_pii_hosts_one': 'De meeste gingen naar {a}.',
    'shield_activity.f_tool_pii_hosts_two': 'De meeste gingen naar {a} en {b}.',
    'shield_activity.f_tool_pii_outside': '{n} daarvan gingen naar een server buiten Europa.',
    'shield_activity.f_tool_pii_title': '{n} tool-aanroepen namen persoonsgegevens onveranderd mee naar buiten',
    'shield_activity.f_tool_pii_title_one': '1 tool-aanroep nam persoonsgegevens onveranderd mee naar buiten',
    'shield_activity.f_unknown_hosts': 'Geen bekend land voor {hosts}.',
    'shield_activity.f_unknown_hosts_more': 'Geen bekend land voor {hosts} en nog {more}.',
    'shield_activity.f_unknown_pii': 'Aanroepen naar deze servers bevatten {n} keer persoonsgegevens.',
    'shield_activity.f_unknown_pii_one': 'Aanroepen naar deze servers bevatten één keer persoonsgegevens.',
    'shield_activity.f_unknown_title': '{n} aanroepen gingen naar een server die we niet konden plaatsen',
    'shield_activity.f_unknown_title_one': '1 aanroep ging naar een server die we niet konden plaatsen',
    'shield_activity.f_via_body': 'Alleen de rand van het netwerk is zichtbaar, waar je gegevens binnenkwamen; waar de dienst erachter draait, niet. Deze aanroepen tellen niet als binnen of buiten Europa.',
    'shield_activity.f_via_title': '{n} aanroepen gingen via {network}',
    'shield_activity.f_via_title_one': '1 aanroep ging via {network}',
    'shield_activity.f_via_title_unnamed': '{n} aanroepen gingen via een wereldwijd netwerk',
    'shield_activity.f_via_title_unnamed_one': '1 aanroep ging via een wereldwijd netwerk',
    'shield_activity.findings_many': '{n} bevindingen',
    'shield_activity.findings_one': '1 bevinding',
    'shield_activity.fix_tools_link': 'Houd soorten tegen bij tools',
    'shield_activity.in_short': 'In het kort',
    'shield_activity.in_short_passed': '{passed} keer liet het schild toch iets door: iemand koos ervoor het te versturen, het werd alleen genoteerd, of de controle kon niet draaien.',
    'shield_activity.in_short_passed_one': 'Eén keer liet het schild toch iets door: iemand koos ervoor het te versturen, het werd alleen genoteerd, of de controle kon niet draaien.',
    'shield_activity.in_short_sentence': '{events} keer greep het schild in bij een bericht en {calls} aanroepen gingen naar externe diensten. Het schild verving persoonsgegevens {replaced} keer en stopte er {stopped} — maar {tool} keer gingen ze onveranderd mee met een tool.',
    'shield_activity.in_short_sentence_no_tool': '{events} keer greep het schild in bij een bericht en {calls} aanroepen gingen naar externe diensten. Het schild verving persoonsgegevens {replaced} keer en stopte er {stopped}, en in geen enkele tool-aanroep werden persoonsgegevens gevonden.',
    'shield_activity.in_short_sentence_plain': '{events} keer greep het schild in bij een bericht en {calls} aanroepen gingen naar externe diensten. Het schild verving persoonsgegevens {replaced} keer en stopte er {stopped}.',
    'shield_activity.in_short_unchecked': '{unchecked} aanroepen zijn niet op persoonsgegevens gecontroleerd.',
    'shield_activity.in_short_unchecked_one': 'Eén aanroep is niet op persoonsgegevens gecontroleerd.',
    'shield_activity.kinds_title': 'Gevonden soorten gegevens',
    'shield_activity.kpi_eu_sub': '{own} eigen server · {eea} EER · {out} buiten',
    'shield_activity.kpi_eu_unplaced': '{n} niet geplaatst',
    'shield_activity.kpi_found': 'Persoonsgegevens gevonden',
    'shield_activity.kpi_found_sub': 'in {n} berichten en aanroepen',
    'shield_activity.kpi_found_sub_one': 'in 1 bericht of aanroep',
    'shield_activity.kpi_or_more': 'of meer',
    'shield_activity.kpi_stepped_in': 'Schild greep in',
    'shield_activity.kpi_stepped_in_sub': '{replaced} vervangen · {stopped} gestopt',
    'shield_activity.kpi_tool': 'Onveranderd mee met een tool',
    'shield_activity.kpi_tool_sub': '{n} daarvan buiten Europa',
    'shield_activity.log_hint': 'klik een rij om alles te zien wat is vastgelegd',
    'shield_activity.log_title': 'Logboek',
    'shield_activity.map_hint': 'klik een punt of een rij om te filteren',
    'shield_activity.map_stayed': '{p}% bleef in Europa',
    'shield_activity.map_title': 'Waar het heen ging',
    'shield_activity.no_filter': 'Alles wordt getoond. Klik hieronder op iets om te verfijnen — filters stapelen.',
    'shield_activity.no_rows': 'Niets past bij deze combinatie.',
    'shield_activity.nothing': 'niets',
    'shield_activity.outcome_clean': 'Geen persoonsgegevens',
    'shield_activity.outcome_other': 'Overig',
    'shield_activity.outcome_passed': 'Doorgelaten',
    'shield_activity.outcome_replaced': 'Vervangen door placeholders',
    'shield_activity.outcome_short_replaced': 'Vervangen',
    'shield_activity.outcome_short_tool': 'Onveranderd weg',
    'shield_activity.outcome_short_unchecked': 'Niet gecontroleerd',
    'shield_activity.outcome_stopped': 'Gestopt',
    'shield_activity.outcome_tool': 'Onveranderd mee met een tool',
    'shield_activity.outcome_unchecked': 'Niet op persoonsgegevens gecontroleerd',
    'shield_activity.outcomes_label': 'Filter op wat er gebeurde',
    'shield_activity.people_hint': 'op berichten met persoonsgegevens',
    'shield_activity.people_title': 'Mensen',
    'shield_activity.places_title': 'Waar het begon',
    'shield_activity.rank_sampled': 'Geteld over de laatste {n} berichten & aanroepen',
    'shield_activity.range_30d': '30 dagen',
    'shield_activity.range_7d': '7 dagen',
    'shield_activity.range_90d': '90 dagen',
    'shield_activity.range_label': 'Periode',
    'shield_activity.region_eu': 'Binnen Europa (EER)',
    'shield_activity.region_unknown': 'Locatie onbekend',
    'shield_activity.show_more': 'Toon {n} meer',
    'shield_activity.show_these': 'Toon deze',
    'shield_activity.showing': '{n} van {total} getoond',
    'shield_activity.showing_these': 'Deze worden getoond',
    'shield_activity.subtitle': 'Elke keer dat het schild ingreep bij een bericht, en elke aanroep van je organisatie naar een externe dienst.',
    'shield_activity.type_web_search': 'Webzoekopdracht',
    'shield_activity.worth_a_look': 'Het bekijken waard',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomic across replicas (advisory lock in mutateConfig); existing values
    // win, only missing keys are added.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-privacy-shield-v3-translations: added ${added} NL keys`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(({ added }) => {
        console.log(`Done (${added} added).`);
        process.exit(0);
    }).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
