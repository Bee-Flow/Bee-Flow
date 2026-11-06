#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for the knowledge-base search log: the Studio tab and enable form
 * (namespace knowledge, knowledge.query_log.*), the Compliance Center pages
 * and access-log labels (compliance.kql_*, rail/tab/aa_action keys), the
 * App Studio steps (studio_apps_edit.step_catalog.kb_log_*) and the
 * automation step (automations.node.kb_query_log.*).
 *
 * The user's acknowledgement is "kennisname" / "Begrepen", never "toestemming":
 * the legal basis is the organisation's legitimate interest, not consent.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. Auto-runs from server boot (boot/bootMigrations.js).
 * Manual usage:
 *   node server/migrations/add-nl-kb-query-log-translations-2026-11.js
 */

const NL_TRANSLATIONS = Object.freeze({
    // Compliance Center: labels
    'compliance.kql_outcome_answered': 'Beantwoord',
    'compliance.kql_outcome_no_results': 'Niets gevonden',
    'compliance.kql_outcome_error': 'Fout',
    'compliance.kql_status_to_review': 'Te beoordelen',
    'compliance.kql_status_reviewed': 'Beoordeeld',
    'compliance.kql_status_needs_addition': 'Aanvulling nodig',
    'compliance.kql_channel_agent_chat': 'Agentchat',
    'compliance.kql_channel_agent_chat_sync': 'Agentchat (API)',
    'compliance.kql_channel_direct_chat': 'Directe chat',
    'compliance.kql_channel_template_chat': 'Sjabloonchat',
    'compliance.kql_channel_notebook': 'Notitieboek',
    'compliance.kql_channel_webpage': 'AI-webpagina',
    'compliance.kql_channel_project_assistant': 'Projectassistent',
    'compliance.kql_channel_automation_ai_step': 'AI-stap in een automatisering',
    'compliance.kql_channel_studio_kb_query': 'App: kennisvraag',
    'compliance.kql_channel_studio_ai_generate': 'App: AI-generatie',
    'compliance.kql_channel_studio_ai_extract': 'App: AI-extractie',
    'compliance.kql_channel_studio_ai_chat': 'App: AI-chat',
    'compliance.kql_channel_kb_test': 'Testzoekopdracht',
    'compliance.kql_channel_api_search': 'Zoek-API',
    // Compliance Center: overview
    'compliance.kql_read_failed': 'Het overzicht van het zoeklog kon niet worden gelezen.',
    'compliance.kql_col_kb': 'Kennisbank',
    'compliance.kql_col_retention': 'Bewaard',
    'compliance.kql_col_changed': 'Laatst gewijzigd',
    'compliance.kql_col_managers': 'Beheerders',
    'compliance.kql_col_outcomes': 'Uitkomsten',
    'compliance.kql_col_statuses': 'Beoordelingsstatus',
    'compliance.kql_changed': '{when} door {who}',
    'compliance.kql_days': '{n} dagen',
    'compliance.kql_logging_on': 'Aan',
    'compliance.kql_logging_off': 'Uit',
    'compliance.kql_overview_intro': 'Welke kennisbanken een log bijhouden van waarnaar mensen zochten en wat ze als antwoord kregen, hoe lang, en wie dat heeft besloten. Dit overzicht toont alleen aantallen: wat mensen vroegen zie je hier nooit.',
    'compliance.kql_open_audit': 'Wijzigingen in het toegangslog',
    'compliance.kql_open_kb_log': 'Zoeklog openen bij de kennisbank',
    'compliance.kql_unlicensed': 'De licentie voor het zoeklog is afgelopen: er wordt niets nieuws gelogd. Bestaande regels blijven staan tot hun bewaartermijn om is en kun je nog steeds exporteren of wissen.',
    'compliance.kql_overview_title': 'Zoeklog per kennisbank',
    'compliance.kql_overview_empty_title': 'Geen kennisbank logt zoekopdrachten',
    'compliance.kql_overview_empty_sub': 'Een beheerder van een kennisbank kan het log aanzetten in de instellingen van de kennisbank. Tot die tijd wordt niets vastgelegd.',
    'compliance.kql_entries_count': '{n} regels',
    'compliance.kql_export_failed': 'De export kon niet worden gemaakt.',
    // Compliance Center: entries
    'compliance.kql_col_when': 'Wanneer',
    'compliance.kql_col_person': 'Persoon',
    'compliance.kql_col_channel': 'Kanaal',
    'compliance.kql_col_outcome': 'Uitkomst',
    'compliance.kql_read_failed_entries': 'De regels konden niet worden gelezen.',
    'compliance.kql_entries_intro': 'Wanneer een zoekopdracht is gelogd, waar, door wie en hoe die afliep. Niet wat er gevraagd is: de tekst van een zoekopdracht open je alleen voor een openstaand verzoek van een betrokkene.',
    'compliance.kql_export_csv': 'Metadata exporteren (CSV)',
    'compliance.kql_tab_entries_title': 'Gelogde zoekopdrachten',
    'compliance.kql_entries_empty': 'Geen gelogde zoekopdrachten in deze selectie',
    'compliance.kql_entries_empty_sub': 'Zoekopdrachten worden alleen gelogd in kennisbanken waarvan het log aanstaat, vanaf het moment dat het is aangezet.',
    // Compliance Center: AVG requests
    'compliance.kql_dsr_none': 'Kies een openstaand verzoek',
    'compliance.kql_dsr_request': 'verzoek',
    'compliance.kql_erased': '{n} regels gewist',
    'compliance.kql_requests_intro': 'Kies een persoon om te zien hoeveel gelogde zoekopdrachten die heeft. Om de tekst te lezen, te exporteren of te wissen kies je het openstaande verzoek van de betrokkene waar het bij hoort.',
    'compliance.kql_pick_person': 'Kies een persoon',
    'compliance.kql_subject_total': 'gelogde zoekopdrachten',
    'compliance.kql_read_failed_subject': 'De aantallen van deze persoon konden niet worden gelezen.',
    'compliance.kql_viewing_logged': 'Het lezen, exporteren of wissen van de tekst wordt zelf ook vastgelegd in het toegangslog, met het nummer van het verzoek.',
    'compliance.kql_dsr_label': 'Openstaand verzoek van een betrokkene',
    'compliance.kql_reason_label': 'Reden om te wissen (verplicht om te wissen)',
    'compliance.kql_view_content': 'Inhoud tonen',
    'compliance.kql_export_json': 'Exporteren (JSON)',
    'compliance.kql_export_csv_short': 'Exporteren (CSV)',
    'compliance.kql_erase': 'Regels wissen',
    'compliance.kql_dsr_required': 'Hiervoor is een openstaand verzoek van een betrokkene van deze organisatie over deze persoon nodig. Kies een verzoek dat nog openstaat en over deze persoon gaat.',
    'compliance.kql_action_failed': 'Dat is niet gelukt. Er is niets gewijzigd.',
    'compliance.kql_content_count': '{n} regels',
    'compliance.kql_asked': 'Gevraagd',
    'compliance.kql_answered': 'Antwoord',
    'compliance.kql_erase_title': 'Deze regels wissen?',
    'compliance.kql_erase_body': 'Alle gelogde zoekopdrachten van deze persoon, met wat er gevraagd is en wat het antwoord was, worden definitief gewist. Dit kun je niet ongedaan maken. Het wissen en je reden worden vastgelegd in het toegangslog.',
    'compliance.kql_erase_confirm': 'Definitief wissen',
    'compliance.kql_erase_cancel': 'Annuleren',
    // Compliance Center: navigation, requests and access log
    'compliance.rail_kb_query_log': 'Zoeklog kennisbanken',
    'compliance.tab_kb_query_log_overview': 'Overzicht',
    'compliance.tab_kb_query_log_entries': 'Regels',
    'compliance.tab_kb_query_log_requests': 'AVG-verzoeken',
    'compliance.dsr_discovery_kb_query_log': 'Regels in het zoeklog van kennisbanken',
    'compliance.aa_action_kb_query_log_enabled': 'Zoeklog aangezet',
    'compliance.aa_action_kb_query_log_disabled': 'Zoeklog uitgezet',
    'compliance.aa_action_kb_query_log_retention_changed': 'Bewaartermijn van het zoeklog gewijzigd',
    'compliance.aa_action_kb_query_log_purged': 'Regels van het zoeklog gewist',
    'compliance.aa_action_kb_query_log_exported': 'Metadata van het zoeklog geëxporteerd',
    'compliance.aa_action_kb_query_log_content_viewed': 'Inhoud van het zoeklog geopend',
    'compliance.aa_action_kb_query_log_subject_exported': 'Zoeklog van een persoon geëxporteerd',
    'compliance.aa_action_kb_query_log_subject_deleted': 'Zoeklog van een persoon gewist',
    // Compliance Center: attestation
    'compliance.kql_col_attestation': 'Verklaring',
    'compliance.kql_col_acknowledged': 'Kennisgenomen door',
    'compliance.kql_ack_users': '{n} bevestigd',
    'compliance.kql_att_dpia_done': 'DPIA: uitgevoerd',
    'compliance.kql_att_dpia_not_required': 'DPIA: niet nodig',
    'compliance.kql_att_council': 'Ondernemingsraad: {value}',
    'compliance.kql_att_notice_yes': 'Privacyverklaring: bijgewerkt',
    'compliance.kql_att_notice_no': 'Privacyverklaring: niet bevestigd',
    'compliance.kql_att_by': 'Verklaard {when} door {who}',
    'compliance.kql_att_missing': 'Geen bevestiging vastgelegd: logging staat op pauze, er wordt niets gelogd',
    'compliance.kql_att_names_shown': 'Beheerders zien namen',
    'compliance.kql_att_names_hidden': 'Beheerders zien pseudoniemen',
    'compliance.kql_att_high_risk': 'AI-systeem met hoog risico (AI-verordening)',

    // Knowledge Studio: the search log tab
    'knowledge.query_log.answer': 'Antwoord',
    'knowledge.query_log.answer_ms': 'Antwoord duurde',
    'knowledge.query_log.any': 'Alle',
    'knowledge.query_log.channel.agent_chat': 'Agentchat',
    'knowledge.query_log.channel.agent_chat_sync': 'Agent (synchroon)',
    'knowledge.query_log.channel.api_search': 'API-zoekopdracht',
    'knowledge.query_log.channel.automation_ai_step': 'AI-stap in een automatisering',
    'knowledge.query_log.channel.direct_chat': 'Directe chat',
    'knowledge.query_log.channel.kb_test': 'Testvraag',
    'knowledge.query_log.channel.notebook': 'Notitieboek',
    'knowledge.query_log.channel.project_assistant': 'Projectassistent',
    'knowledge.query_log.channel.studio_ai_chat': 'App: AI-chat',
    'knowledge.query_log.channel.studio_ai_extract': 'App: AI-extractie',
    'knowledge.query_log.channel.studio_ai_generate': 'App: AI-generatie',
    'knowledge.query_log.channel.studio_kb_query': 'App: kennisvraag',
    'knowledge.query_log.channel.template_chat': 'Sjabloonchat',
    'knowledge.query_log.channel.webpage': 'Webpagina',
    'knowledge.query_log.citations': 'Bronverwijzingen',
    'knowledge.query_log.col_channel': 'Kanaal',
    'knowledge.query_log.col_outcome': 'Uitkomst',
    'knowledge.query_log.col_person': 'Persoon',
    'knowledge.query_log.col_question': 'Vraag',
    'knowledge.query_log.col_time': 'Tijd',
    'knowledge.query_log.days': '{n} dagen',
    'knowledge.query_log.detail_title': 'Gelogde vraag',
    'knowledge.query_log.disable_delete': 'Uitzetten en wissen',
    'knowledge.query_log.purge_unlicensed': 'Het log uitzetten en wissen',
    'knowledge.query_log.paused_no_attestation': 'Logging staat op pauze: de organisatie heeft de voorwaarden nog niet bevestigd. Tot dan wordt er niets gelogd.',
    'knowledge.query_log.complete_attestation': 'Voorwaarden bevestigen',
    'knowledge.query_log.purge_unlicensed_text': 'Zonder de Enterprise-licentie wordt er niets nieuws gelogd. Dit zet de instelling uit en wist nu elke gelogde vraag en elk antwoord van deze kennisbank. Dit kun je niet ongedaan maken.',
    'knowledge.query_log.disable_delete_option': 'Alle regels nu wissen. Dit kun je niet ongedaan maken.',
    'knowledge.query_log.disable_keep': 'Uitzetten',
    'knowledge.query_log.disable_keep_option': 'Bewaren tot hun bewaartermijn om is ({n} dagen na elke vraag). Er wordt niets nieuws gelogd.',
    'knowledge.query_log.disable_legend': 'Wat er gebeurt met de regels die al gelogd zijn',
    'knowledge.query_log.disable_title': 'Logging uitzetten?',
    'knowledge.query_log.empty': 'Nog niets gelogd voor deze filters.',
    'knowledge.query_log.enable_confirm': 'Logging aanzetten',
    'knowledge.query_log.enable_title': 'Vragen en antwoorden loggen?',
    'knowledge.query_log.err_export': 'Het log kon niet worden geëxporteerd.',
    'knowledge.query_log.err_save': 'De instellingen van het zoeklog konden niet worden opgeslagen.',
    'knowledge.query_log.export': 'CSV exporteren',
    'knowledge.query_log.f_channel': 'Kanaal',
    'knowledge.query_log.f_outcome': 'Uitkomst',
    'knowledge.query_log.f_period': 'Periode',
    'knowledge.query_log.f_person': 'Persoon',
    'knowledge.query_log.f_text': 'Tekst',
    'knowledge.query_log.f_text_placeholder': 'In vraag of antwoord',
    'knowledge.query_log.hint': 'Bewaar de vragen die aan deze kennisbank zijn gesteld, de passages die zijn gevonden en de antwoorden die zijn gegeven, zodat de beheerders kunnen zien wat er ontbreekt. Standaard uit.',
    'knowledge.query_log.next': 'Volgende',
    'knowledge.query_log.no_answer': 'Er is geen antwoord gegeven.',
    'knowledge.query_log.note': 'Notitie',
    'knowledge.query_log.note_placeholder': 'Wat moet er worden toegevoegd of aangepast?',
    'knowledge.query_log.notice': 'Vragen aan {names} worden gelogd, zodat de beheerders van de kennisbank de antwoorden kunnen controleren.',
    'knowledge.query_log.outcome.answered': 'Beantwoord',
    'knowledge.query_log.outcome.error': 'Fout',
    'knowledge.query_log.outcome.no_results': 'Niets gevonden',
    'knowledge.query_log.page': 'pagina {n}',
    'knowledge.query_log.passages': 'Gevonden passages ({n})',
    'knowledge.query_log.period_all': 'Altijd',
    'knowledge.query_log.period_days': 'Laatste {n} dagen',
    'knowledge.query_log.prev': 'Vorige',
    'knowledge.query_log.privacy_term': 'Regels worden na {n} dagen gewist. Je kunt dat altijd aanpassen, of alles wissen.',
    'knowledge.query_log.privacy_what': 'Vanaf nu bewaart deze kennisbank elke vraag die eraan wordt gesteld, de gevonden passages en het antwoord als dat er is, samen met wie het vroeg en waar.',
    'knowledge.query_log.privacy_who': 'De beheerders van deze kennisbank en je compliance officers kunnen het lezen. Wie een vraag stelt, ziet eerst een melding en bevestigt die. Tot dan worden zijn of haar vragen niet gelogd.',
    'knowledge.query_log.privacy_zk': 'De inhoud is versleuteld met een sleutel van de organisatie. Dat is geen zero-knowledge-versleuteling, ook niet als je organisatie zero-knowledge gebruikt voor haar chats: de organisatie kan dit log lezen.',
    'knowledge.query_log.question': 'Vraag',
    'knowledge.query_log.range': '{from}–{to} van {total}',
    'knowledge.query_log.retention': 'Bewaren',
    'knowledge.query_log.retrieval_ms': 'Zoeken duurde',
    'knowledge.query_log.review': 'Beoordelen',
    'knowledge.query_log.save': 'Opslaan',
    'knowledge.query_log.saved': 'Opgeslagen',
    'knowledge.query_log.search': 'Zoeken',
    'knowledge.query_log.status.needs_addition': 'Aanvulling nodig',
    'knowledge.query_log.status.reviewed': 'Beoordeeld',
    'knowledge.query_log.status.to_review': 'Te beoordelen',
    'knowledge.query_log.title': 'Zoekopdrachten en antwoorden loggen',
    'knowledge.query_log.unreadable': 'Kan niet worden ontsleuteld',
    'knowledge.query_log.unreadable_long': 'De inhoud van deze regel kan niet worden ontsleuteld. Alleen de gegevens eromheen worden getoond.',
    'knowledge.tab_search_log': 'Zoeklog',
    // Knowledge Studio: notice for the people asking (kennisname, not toestemming)
    'knowledge.query_log.ack_button': 'Begrepen',
    'knowledge.query_log.ack_failed': 'Dit kon niet worden opgeslagen. Probeer het opnieuw.',
    'knowledge.query_log.ack_not_yet': 'Zolang je dit niet bevestigt, worden je vragen niet gelogd.',
    'knowledge.query_log.ack_term': 'Regels worden maximaal {n} dagen bewaard.',
    'knowledge.query_log.ack_title': 'Vragen kunnen worden gelogd',
    'knowledge.query_log.ack_what': 'Je vragen aan {names}, de gevonden passages en de antwoorden kunnen worden gelogd, zodat de beheerders van de kennisbank de antwoorden kunnen controleren en kunnen zien wat er ontbreekt.',
    'knowledge.query_log.ack_who_names': 'De beheerders zien je naam.',
    'knowledge.query_log.ack_who_pseudonym': 'De beheerders zien een pseudoniem, niet je naam.',
    // Knowledge Studio: the enable form (legitimate interest)
    'knowledge.query_log.attest_dpia': 'Gegevensbeschermingseffectbeoordeling (DPIA)',
    'knowledge.query_log.attest_dpia_none': 'Er is nog geen DPIA vastgelegd voor je organisatie. Vraag een compliance officer om die vast te leggen in het Compliance Center.',
    'knowledge.query_log.attest_dpia_pick': 'Welke DPIA',
    'knowledge.query_log.attest_notice': 'In onze privacyverklaring staat dat vragen aan kennisbanken kunnen worden gelogd.',
    'knowledge.query_log.attest_notice_short': 'Privacyverklaring',
    'knowledge.query_log.attest_notice_yes': 'Bijgewerkt',
    'knowledge.query_log.attest_purpose': 'We gebruiken het log alleen om AI-antwoorden te controleren en de kennisbank te verbeteren, niet om medewerkers te beoordelen.',
    'knowledge.query_log.basis': 'De grondslag is het gerechtvaardigd belang van je organisatie. Als vragen te herleiden zijn tot personen, heeft de ondernemingsraad mogelijk instemmingsrecht (WOR art. 27). Een gegevensbeschermingseffectbeoordeling (DPIA) kan verplicht zijn.',
    'knowledge.query_log.cancel': 'Annuleren',
    'knowledge.query_log.choose': 'Kies…',
    'knowledge.query_log.doc_version': 'versie {v}',
    'knowledge.query_log.dpia_done': 'Er is een DPIA uitgevoerd',
    'knowledge.query_log.dpia_expired': 'verlopen',
    'knowledge.query_log.dpia_not_required': 'Een DPIA is niet nodig',
    'knowledge.query_log.high_risk': 'AI-systeem met hoog risico onder de AI-verordening',
    'knowledge.query_log.high_risk_hint': 'Logs moeten dan minstens 6 maanden bewaard blijven (180 of 365 dagen).',
    'knowledge.query_log.show_names': 'Namen van vragenstellers tonen aan beheerders',
    'knowledge.query_log.show_names_hint': 'Uit: beheerders zien een pseudoniem zoals “Medewerker 7F3K”, elke keer hetzelfde. Compliance officers kunnen het bij een AVG-verzoek nog wel herleiden.',

    // App Studio steps
    'studio_apps_edit.step_catalog.kb_log_query_blurb': 'Lees wat mensen aan een kennisbank vroegen en wat het antwoord was (Enterprise).',
    'studio_apps_edit.step_catalog.kb_log_query_label': 'Zoeklog van de kennisbank lezen',
    'studio_apps_edit.step_catalog.kb_log_review_blurb': 'Zet de beoordelingsstatus en notitie van een regel in het zoeklog van een kennisbank (Enterprise).',
    'studio_apps_edit.step_catalog.kb_log_review_label': 'Een regel in het zoeklog beoordelen',

    // Automation step
    'automations.node.kb_query_log.typeLabel': 'Zoeklog van kennisbank',
    'automations.node.kb_query_log.defaultLabel': 'Zoeklog van kennisbank',
    'automations.node.kb_query_log.label': 'Zoeklog van kennisbank',
    'automations.node.kb_query_log.desc': 'Lees wat mensen aan een kennisbank vroegen, of markeer een regel als beoordeeld',
    'automations.node.kb_query_log.help': 'Leest het zoeklog van een kennisbank (wat mensen vroegen, wat er gevonden en geantwoord is) of zet de beoordelingsstatus van één regel. Alleen met Enterprise, en de eigenaar van de automatisering moet de kennisbank beheren.',
});

/**
 * Keys whose Dutch IS the English text (loanwords used as-is in Dutch UI: Status, Model,
 * Support, Skill, Enterprise, Logging, Passages, score). Declared so the catalogue checks
 * can tell them from a key nobody translated (migrations/nlCatalogues.test.js).
 */
const SAME_AS_ENGLISH = Object.freeze([
    'compliance.kql_channel_support',
    'compliance.kql_channel_skill',
    'compliance.kql_col_logging',
    'compliance.kql_col_status',
    'compliance.kql_passages',
    'knowledge.query_log.channel.skill',
    'knowledge.query_log.channel.support',
    'knowledge.query_log.col_status',
    'knowledge.query_log.enterprise',
    'knowledge.query_log.f_status',
    'knowledge.query_log.model',
    'knowledge.query_log.score',
]);

/**
 * The mutation itself, on a copy of the 'nl' blob. Pure, so the store's mutator may run it more than once.
 * @param {Record<string, string>} merged
 */
function applyNl(merged) {
    let added = 0;
    for (const [key, value] of Object.entries(NL_TRANSLATIONS)) {
        if (!merged[key]) {
            merged[key] = value;
            added++;
        }
    }
    return { merged, added };
}

async function up() {
    const languageStore = require('../stores/languageStore');
    let added = 0;
    await languageStore.mutateGUITranslations('nl', (/** @type {Record<string, string>} */ current) => {
        const result = applyNl(current);
        added = result.added;
        return result.merged;
    });
    if (added > 0) {
        console.log(`[Migration] add-nl-kb-query-log-translations-2026-11 applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, applyNl, NL_TRANSLATIONS, SAME_AS_ENGLISH };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
