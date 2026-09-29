#!/usr/bin/env node
/**
 * One-time migration: Dutch for the Privacy Shield redesign (2026-09).
 *
 * The round-2 artboards turned the tab strip into a pipeline, folded the three
 * 21-item category grids into one matrix, put the two checks on one pane, and
 * rebuilt "What happened" as a single cross-filter. Roughly 130 new keys.
 *
 * ── Terminology, following the existing NL catalogue ──────────────────────
 *   - the SETTING NAMES stay English on purpose ("What we look for", "Hide
 *     from AI", "One last check before an outside AI"). They are the product's
 *     own vocabulary, they appear in the docs and in support threads, and the
 *     artboards kept them in English while writing the surrounding prose in
 *     Dutch. Translating the switch but not the manual is worse than either.
 *   - persoonsgegevens (never "PII"), organisatie, routine, detectieservice
 *   - "soort" for a kind of personal data — the matrix's row label
 *   - a placeholder is a "placeholder"; tokeniseren is not a Dutch verb here
 *
 * Idempotent: only fills keys that are missing, so a workspace that already
 * curated its own wording keeps it. Auto-runs from server boot
 * (server/index.js). Manual usage:
 *   node server/migrations/add-nl-privacy-shield-redesign-translations.js
 */

const NL_TRANSLATIONS = {
    // ── The shell: header, pipeline, save bar ────────────────────────────
    'admin.shield_header_members': 'geldt voor {n} mensen',
    'admin.shield_guard_not_installed': 'Detectieservice niet geïnstalleerd',
    'admin.shield_guard_unreachable': 'Detectieservice reageert niet',
    'admin.shield_how_this_works': 'Hoe dit werkt',
    'admin.shield_pipeline_in': 'Bericht',
    'admin.shield_pipeline_out': 'AI-model',
    'admin.shield_reload': 'Opnieuw laden',
    'admin.shield_no_unsaved': 'Geen wijzigingen',
    'admin.shield_unsaved_on': 'op {n} stappen:',
    'admin.shield_discard': 'Verwerpen',
    'admin.shield_manage': 'Beheren',
    'admin.shield_review': 'Nakijken',

    // The read-outs on the strip itself.
    'admin.shield_summary_all_clear': 'alles in orde',
    'admin.shield_summary_attention': '{n} vragen aandacht',
    'admin.shield_summary_stopped': 'tegengehouden',
    'admin.shield_summary_check_on': 'check aan',
    'admin.shield_summary_check_off': 'geen laatste check',
    'admin.shield_summary_days': '30 dagen',

    // ── Overview: the posture table ──────────────────────────────────────
    'admin.shield_posture_title': 'Zo staat het er nu voor',
    'admin.shield_posture_subtitle': 'alles afgeleid · niets is hier ook instelbaar',
    'admin.shield_posture_attention': '{n} vragen aandacht',
    'admin.shield_posture_diagnose': 'Onderzoeken',
    'admin.shield_enable_desc_strong': 'Geldt voor elke chat en elke agent in deze organisatie. Uit betekent dat er niets wordt gecontroleerd, helemaal niets.',
    'admin.shield_disabled_note_steps': 'De bescherming staat uit voor deze organisatie. Berichten gaan ongewijzigd naar de AI, en de andere stappen blijven inactief tot je hem aanzet.',
    'admin.shield_posture_sensitivity_tested': '— de geteste instelling',
    'admin.shield_posture_dlp_off_note': '— er wordt niemand iets gevraagd',
    'admin.shield_posture_toolcalls_note': '· eigen server {internal}/{total}',
    'admin.shield_posture_toolcalls_hint': '{kinds} mogen mee: {n} tool-aanroepen stuurden ze buiten Europa.',
    'admin.shield_posture_personal_data': 'Persoonsgegevens',
    'admin.shield_posture_transparency_hint': 'Iedereen die het gesprek kan openen, kan de echte waarden zichtbaar maken.',
    'admin.shield_posture_eu_hint': 'Een chat mag naar een AI-model buiten Europa. Dit gaat NIET over verbonden apps zoals Gmail — die regel je met de tool-kolommen.',
    'admin.shield_posture_allow_value_public': 'Bekende bedrijven + {n} van jezelf',

    // ── Overview: what your people see ───────────────────────────────────
    'admin.shield_preview_title': 'Wat je mensen hiervan zien',
    'admin.shield_preview_desc': 'Een aantal van je keuzes is zichtbaar voor iedereen in deze organisatie. Zo ziet een chat er nu uit.',
    'admin.shield_preview_reveal': 'klik om te zien',
    'admin.shield_preview_audience': 'iedereen in dit gesprek',
    'admin.shield_preview_blocked_body': 'Het bericht bereikt de AI nooit. De persoon hoort dat er persoonsgegevens in stonden en wordt gevraagd het te herschrijven.',
    'admin.shield_preview_dlp_ask': 'Bij een model buiten je organisatie ziet de persoon wat er gevonden is en kiest zelf.',
    'admin.shield_preview_dlp_redact': 'Niemand wordt gestoord — wat gevonden is wordt verborgen en het bericht gaat.',
    'admin.shield_preview_dlp_block': 'Het bericht wordt tegengehouden voordat het een model buiten je organisatie bereikt.',
    'admin.shield_preview_dlp_off': 'Staat uit. Zet “One last check” op Ask en de persoon krijgt dit venster — en kan aanwijzen wat de detectie miste.',
    'admin.shield_preview_dlp_enable': 'Aanzetten',
    'admin.shield_preview_guard_down': 'Zolang de detectieservice stil ligt, zegt de chat dat de bescherming tijdelijk niet beschikbaar is en gaat het bericht niet weg. Er staat nooit “beschermd”.',

    // ── Overview: compliance ─────────────────────────────────────────────
    'admin.shield_compliance_title': 'Raakt Compliance',
    'admin.shield_compliance_desc': 'Opslaan hier hertest meteen twee checks in het Compliance Center. Dit scherm en dat scherm zijn twee vensters op één feit.',
    'admin.shield_compliance_dlp_ok': 'Bescherming tegen datalekken actief',
    'admin.shield_compliance_dlp_partial': 'Bescherming tegen datalekken maar deels actief',
    'admin.shield_compliance_logging': 'Logging en monitoring',
    'admin.shield_compliance_ok': 'in orde',
    'admin.shield_compliance_attention': 'let op',
    'admin.shield_activity_country_unknown': 'Onbekend',
    'admin.shield_last_changed': 'Laatst gewijzigd {when}',

    // ── "Saved, with notes": what the plan clamped, and what was refused ──
    'admin.shield_clamp_action': 'Vervangen door placeholders — berichten worden in plaats daarvan tegengehouden',
    'admin.shield_clamp_web_guard': 'Zoekopdrachten beschermen — weer uitgezet',
    'admin.shield_clamp_web_guard_cats': 'de soorten die uit zoekopdrachten worden gehouden — geleegd',
    'admin.shield_clamp_tool_policy': 'de soorten die worden tegengehouden bij tools buiten je organisatie — geleegd',
    'admin.shield_clamp_other': '{n} andere instellingen',
    'admin.shield_clamp_lead': 'Opgeslagen, met opmerkingen. Je plan bevat niet: {what}. Alle andere wijzigingen staan er wél op.',
    'admin.shield_clamp_generic': 'Opgeslagen. Een aantal instellingen is aangepast aan de grenzen van je plan.',
    'admin.shield_clamp_load': 'Je plan bevat niet: {what}. Wat je hier ziet, is wat er geldt.',
    'admin.shield_clamp_load_generic': 'Een aantal instellingen wordt beperkt door je huidige plan.',
    'admin.shield_terms_rejected': 'Opgeslagen, met opmerkingen. {n} van je eigen woorden of patronen zijn geweigerd en gelden NIET — de betreffende rijen staan hieronder gemarkeerd.',

    // ── "How this works", the in-app explainer ───────────────────────────
    'admin.shield_hiw_title': 'Hoe het Privacy Shield werkt',
    'admin.shield_hiw_subtitle': 'Wat er met een bericht gebeurt, in de volgorde waarin het gebeurt, en welk van deze panelen waarover beslist.',
    'admin.shield_hiw_own_server': 'Dit gebeurt allemaal op je eigen server. Een bericht wordt gelezen en ontdaan van persoonsgegevens VOORDAT het ergens heen gaat, en er gaat niets naar elders om het te controleren.',
    'admin.shield_hiw_in_title': 'Iemand stuurt een bericht',
    'admin.shield_hiw_in_body': 'Een chat, een agent, of — als je “Also protect routines” aan laat staan — een routine die \'s nachts draait zonder dat iemand meekijkt.',
    'admin.shield_hiw_detect_body': 'De tekst wordt doorzocht op de soorten persoonsgegevens die je hebt aangevinkt. Een soort die je NIET hebt aangevinkt wordt nooit aan het model gevraagd en kan dus ook nooit gevonden worden — daarom vindt een schild dat aan staat zonder aangevinkte soorten helemaal niets.',
    'admin.shield_hiw_open_detection': 'Open de matrix',
    'admin.shield_hiw_process_body': 'Wat er gevonden is wordt óf vervangen door placeholders — de AI ziet [email_1], nooit het adres, en Bee Flow zet de echte waarde terug in het antwoord — óf het bericht wordt tegengehouden en de persoon wordt gevraagd het te herschrijven. Deze poort gaat bij ELK bericht dicht.',
    'admin.shield_hiw_open_processing': 'Open de twee checks',
    'admin.shield_hiw_outbound_body': 'Alleen als het model BUITEN je organisatie draait: nog één keer kijken, en dat kan pauzeren om de persoon zelf te laten beslissen. Hier zeg je ook welke soorten een verbonden app nooit mag meenemen — Gmail, Drive, een zoekopdracht.',
    'admin.shield_hiw_open_outbound': 'Open de twee checks',
    'admin.shield_hiw_out_title': 'De AI antwoordt',
    'admin.shield_hiw_out_body': 'En alles wat er onderweg is gebeurd, is vastgelegd — wie, wat er gevonden is, wat we ermee deden, en waar een uitgaande aanroep heen ging.',
    'admin.shield_hiw_open_activity': 'Open het bewijs',
    'admin.shield_hiw_two_checks_lead': 'Stap 1 en 2 zijn geen alternatieven.',
    'admin.shield_hiw_two_checks': 'Stap 2 is de poort die altijd dichtgaat; stap 3 is één extra blik, alleen vóór een model buiten je organisatie, en de enige plek waar een medewerker iets te zeggen heeft. Stap 2 op “Do not send the message” zetten levert géén Ask-venster op — dat is stap 3 op “Ask”.',
    'admin.shield_hiw_also_title': 'Nog drie dingen die goed zijn om te weten',
    'admin.shield_hiw_dial_title': 'De strengheidsknop werkt omgekeerd',
    'admin.shield_hiw_dial_body': 'Het is een betrouwbaarheidsdrempel, dus een LAGER percentage vindt MEER. Daarom hebben de niveaus namen in plaats van cijfers, en daarom staat er “vindt méér” en “vindt mínder” bij de schuif in plaats van 10% en 100%. Balanced is de instelling waarop elk gepubliceerd kwaliteitscijfer is gemeten.',
    'admin.shield_hiw_precedence_title': 'Deze regels gaan voor',
    'admin.shield_hiw_precedence_body': 'Ze gelden vóór regels die op een losse agent zijn gezet. Een agent mag strenger zijn, nooit losser — als de twee elkaar tegenspreken, wint de strengste.',
    'admin.shield_hiw_exceptions_title': 'Twee lijsten werken precies andersom',
    'admin.shield_hiw_exceptions_body': '“Always hide these” voegt je eigen woorden en patronen toe bovenop al het andere — en blijft werken als de detectieservice stil ligt, want er is geen model voor nodig. “Never hide these” doet het omgekeerde: die waarden blijven zichtbaar voor de AI, in élke categorie, permanent, en ze moeten exact overeenkomen — “Shell” toestaan staat “Shell Advies BV” niet toe.',
    'admin.shield_hiw_guard': 'Het scannen zelf doet een aparte service op je eigen infrastructuur (de PII Guard). Als die ooit stilstaat of onbereikbaar is, vinden de soorten op deze pagina niets tot hij terug is — de koptekst zegt het dan — terwijl je eigen woorden en patronen blijven werken, want daar is geen model voor nodig.',
    'admin.shield_hiw_guard_down': 'De detectieservice reageert nu niet, dus er worden geen persoonsgegevens GEVONDEN — elke soort op deze pagina is inactief tot hij terug is. Je eigen woorden en patronen werken nog wel; daar is geen model voor nodig. Een platformbeheerder installeert en herstart hem.',

    // ── The matrix ───────────────────────────────────────────────────────
    'admin.shield_matrix_col_kind': 'Soort',
    'admin.shield_matrix_col_detect': 'Verbergen voor AI',
    'admin.shield_matrix_col_external': 'Tools buiten je org',
    'admin.shield_matrix_col_internal': 'Eigen server',
    'admin.shield_matrix_hint': '{n} soorten · drie vragen, één tabel',
    'admin.shield_matrix_desc': 'Een soort die niet is aangevinkt bij “Verbergen voor AI” wordt nooit aan het model gevraagd — en kan dus ook nooit gevonden worden. De twee rechterkolommen gaan niet over vinden, maar over wat een tool mag meenemen.',
    'admin.shield_matrix_caption': 'Per soort persoonsgegeven: of hij verborgen wordt voor de AI, of tools buiten je organisatie hem mogen meenemen, en of tools op je eigen server hem mogen meenemen.',
    'admin.shield_matrix_public_orgs': '221 uitgezonderd',
    'admin.shield_matrix_half_open_title': '{n} soorten zijn maar half beschermd:',
    'admin.shield_matrix_half_open_desc': 'je zoekt er wel naar, maar geen enkele tool houdt ze tegen — een verbonden app mag ze dus nog steeds je organisatie uit dragen.',
    'pii.group_personal': 'Persoonlijk',
    'pii.group_financial': 'Financieel',
    'pii.group_identity': 'Identiteit',
    'pii.group_digital': 'Digitaal',
    'pii.group_organization': 'Organisatie',
    'pii.group_eu_nl': 'EU / Nederland',

    // ── Detection: the intro, the dial, the term lists ───────────────────
    'admin.shield_pii_master_desc_lead': 'Voordat een bericht naar de AI gaat, leest Bee Flow het en zoekt naar persoonsgegevens — namen, e-mailadressen, telefoonnummers, adressen, bankgegevens, identiteitsnummers, gezondheidsinformatie en meer. Wat gevonden wordt, wordt verborgen voor de AI.',
    'admin.shield_pii_master_desc_own_server': 'Dit gebeurt op je eigen server; er gaat niets naar elders om het te controleren.',
    'privacy.sensitivity_finds_more': 'vindt méér',
    'privacy.sensitivity_finds_less': 'vindt mínder',
    'privacy.sensitivity_slider_label': 'Gevoeligheid van de detectie',
    'privacy.sensitivity_valuetext': '{pct}% — lager vindt meer',
    'admin.shield_custom_terms_title': 'Altijd verbergen — je eigen woorden en patronen',
    'admin.shield_custom_terms_summary': '{n} in gebruik · {sample} · deze werken ook zonder detectieservice',
    'admin.shield_custom_terms_empty_summary': 'Nog niets toegevoegd · deze werken ook zonder detectieservice',
    'admin.shield_allow_terms_title': 'Nooit verbergen — {n} uitzonderingen',
    'admin.shield_allow_terms_title_public': 'Nooit verbergen — {n} uitzonderingen + 221 bekende bedrijven',
    'admin.shield_allow_terms_summary': 'Exact, in ELKE categorie, permanent: “Shell” staat “Shell Advies BV” niet toe.',

    // ── The two checks on one pane ───────────────────────────────────────
    'admin.shield_step_always': 'altijd aan · elk bericht',
    'admin.shield_step_external_only': 'alleen bij een AI buiten je organisatie',
    'dlp.action_footnote_adjacent': 'Wil je dat mensen het zelf per keer beslissen? Dat is de check hiernaast — zet “One last check” op Ask.',
    'admin.shield_tool_block_moved_lead': 'Wat een tool mag meenemen stel je niet hier in, maar in de',
    'admin.shield_tool_block_moved_link': 'categorie-matrix',
    'admin.shield_tool_block_moved_tail': 'waar je per soort tegelijk ziet of we hem zoeken en of hij de deur uit mag.',
    'admin.shield_eu_models_only': 'Dit geldt alleen voor MODELLEN — verbonden apps zoals Gmail of Drive vallen er niet onder.',
    'admin.shield_eu_models_use_matrix': 'Die houd je tegen met de tool-kolommen in de matrix.',
    'admin.shield_steps_footer': 'Stap 1 is de poort die altijd dichtgaat. Stap 2 is het laatste kijkje vóór een AI buiten je organisatie — en de enige plek waar een medewerker zelf iets beslist.',

    // ── What happened: the cross-filter ──────────────────────────────────
    'admin.shield_activity_no_filter': 'Geen filter — klik op een KPI, een balk, een bestemming op de kaart, een persoon of een soort gegeven.',
    'admin.shield_activity_clear_all': 'Alles wissen',
    'admin.shield_activity_chip_remove': 'Dit filter verwijderen',
    'admin.shield_activity_chip_period': 'periode {n}',
    'admin.shield_activity_row_count': '{n} van {total} rijen',
    'admin.shield_activity_stops_at': 'stopt bij {n}',
    'admin.shield_activity_sampled': 'Zolang er een filter aan staat worden de cijfers geteld over de {n} meest recente rijen in plaats van over de hele periode — lees ze dus als “minstens”.',
    'admin.shield_activity_fix_tools': 'Houd deze soorten tegen bij tools',
    'admin.shield_activity_kpi_events_hint': 'klik: toon de schild-tabel',
    'admin.shield_activity_kpi_personal_hint': 'klik: filter op {kind}',
    'admin.shield_activity_kpi_calls_hint': 'klik: toon het app-verkeer',
    'admin.shield_activity_score_hint_short': 'persoonsgegevens buiten Europa tellen dubbel',

    // The map.
    'admin.shield_activity_map_title': 'Waar je data heen ging',
    'admin.shield_activity_map_hint': 'klik een punt om op die bestemming te filteren',
    'admin.shield_activity_destinations': 'Bestemmingen',
    'admin.shield_activity_no_destinations': 'Geen uitgaande aanroepen in deze periode.',
    'admin.shield_activity_own_server': 'je eigen server',
    'admin.shield_activity_own_server_col': 'Je eigen server',
    'admin.shield_activity_tools_note_lead': 'Dit is grotendeels tool-verkeer',
    'admin.shield_activity_tools_note': 'van een verbonden app, geen AI-model. “Use only AI hosted in the EU” verandert hier niets; de tool-kolommen in de matrix wel.',
    'admin.shield_map_loading': 'De kaart wordt getekend…',
    'admin.shield_map_alt': 'Wereldkaart: je eigen server in Nederland, met een lijn naar elk land waar gegevens naartoe zijn gestuurd.',
    'admin.shield_map_pin': '{host} in {country}: {n} aanroepen',
    'admin.shield_map_legend_eea': 'EER — binnen Europa',
    'admin.shield_map_legend_other': 'buiten Europa',
    'admin.shield_map_unplaced': '{n} bestemmingen konden niet op de kaart worden geplaatst (land onbekend) — ze staan ernaast in de lijst.',
    'admin.shield_map_footnote': 'Landen komen van het IP-adres van de ontvangende server, niet van wie hem beheert. Je eigen server is het vertrekpunt — daar wordt ook gescand.',

    // The trend and the table.
    'admin.shield_activity_trend_hint': 'klik een balk om op die periode te filteren',
    'admin.shield_activity_bar_title': '{n} gevonden',
    'admin.shield_activity_bar_label': 'Periode {i}: {n} gevonden',
    'admin.shield_activity_details_hint': 'klik een rij voor het bewijs · klik een gekleurde soort om erop te filteren',
    'admin.shield_activity_col_went': 'Waar het heen ging',
    'admin.shield_activity_row_expand': 'Toon het bewijs voor deze rij',
    'admin.shield_activity_no_rows_combo': 'Geen rijen met deze combinatie van filters.',
    'admin.shield_activity_nothing_here': 'Niets in deze selectie.',
    'admin.shield_activity_filter_kind': 'Filter op {kind}',
    'admin.shield_activity_filter_person': 'Filter op {person}',
    'admin.shield_activity_filter_place': 'Filter op {place}',
    'admin.shield_activity_filter_dest': 'Filter op {host}',
    'admin.shield_activity_d_result': 'Resultaat',
    'admin.shield_activity_d_run': 'Routine-uitvoering',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-privacy-shield-redesign-translations: added ${added} NL keys`);
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
