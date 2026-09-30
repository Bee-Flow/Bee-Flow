#!/usr/bin/env node
/**
 * Dutch for project tasks (2026-10): the Tasks tab (list and board, filters,
 * priority, labels, checklist), the task form, making tasks from a meeting's
 * action items, comments on a task, and the chat additions of the same round
 * (threads, tagged documents and notebooks, day separators, "how this answer
 * was made").
 *
 * Terminology follows add-nl-project-workspace-translations: chat, meeting,
 * agent stay English; a notebook is a notitieboek. A task is een taak.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-project-tasks-translations.js
 */

const NL_TRANSLATIONS = {
    // ── Tasks ────────────────────────────────────────────────────────
    'project_home.tab.tasks': 'Taken',
    'project_home.activity.task_created': '{actor} voegde een taak toe',
    'project_home.activity.task_deleted': '{actor} verwijderde een taak',
    'project_tasks.title': 'Taken',
    'project_tasks.new': 'Nieuwe taak',
    'project_tasks.new_title': 'Nieuwe taak',
    'project_tasks.edit_title': 'Taak',
    'project_tasks.task': 'Taak',
    'project_tasks.create': 'Taak maken',
    'project_tasks.close': 'Sluiten',
    'project_tasks.delete': 'Verwijderen',
    'project_tasks.delete_title': 'Deze taak verwijderen?',
    'project_tasks.delete_body': 'De taak verdwijnt voor iedereen in het project.',
    'project_tasks.untitled': 'Taak zonder titel',
    'project_tasks.open_count': '{count} open',
    'project_tasks.loading': 'Taken laden…',
    'project_tasks.load_failed': 'De taken van dit project konden niet worden geladen.',
    'project_tasks.empty_title': 'Nog geen taken',
    'project_tasks.empty_desc': 'Schrijf op wat er moet gebeuren, geef het aan iemand en koppel de documenten, notitieboeken en chats waar het over gaat. Of maak taken van de actiepunten van een meeting.',
    'project_tasks.no_matches': 'Geen taken die bij dit filter passen.',
    'project_tasks.no_people': 'Nog niemand om dit aan te geven.',
    'project_tasks.title_label': 'Wat moet er gebeuren?',
    'project_tasks.description_label': 'Omschrijving',
    'project_tasks.description_placeholder': 'Context, stappen, hoe je weet dat het klaar is…',
    'project_tasks.status_label': 'Status',
    'project_tasks.status_todo': 'Te doen',
    'project_tasks.status_doing': 'Bezig',
    'project_tasks.status_done': 'Klaar',
    'project_tasks.due_label': 'Deadline',
    'project_tasks.assignees': 'Toegewezen aan',
    'project_tasks.mark_done': 'Markeren als klaar',
    'project_tasks.mark_open': 'Markeren als niet klaar',
    'project_tasks.priority_label': 'Prioriteit',
    'project_tasks.priority_any': 'Elke prioriteit',
    'project_tasks.priority_low': 'Laag',
    'project_tasks.priority_normal': 'Normaal',
    'project_tasks.priority_high': 'Hoog',
    'project_tasks.priority_urgent': 'Urgent',
    'project_tasks.labels': 'Labels',
    'project_tasks.add_label': 'Label toevoegen',
    'project_tasks.remove_label': 'Label {name} verwijderen',
    'project_tasks.label_any': 'Elk label',
    'project_tasks.checklist': 'Checklist',
    'project_tasks.checklist_item': 'Checklist-item',
    'project_tasks.checklist_progress': '{done} van {total} stappen klaar',
    'project_tasks.add_item': 'Stap toevoegen',
    'project_tasks.remove_item': 'Item verwijderen',
    'project_tasks.comments': 'Reacties',
    // ── Links ────────────────────────────────────────────────────────
    'project_tasks.links_label': 'Gekoppeld',
    'project_tasks.links_count': '{count} gekoppeld',
    'project_tasks.add_link': 'Koppel een document, notitieboek, meeting of chat',
    'project_tasks.nothing_to_link': 'Niets meer om te koppelen',
    'project_tasks.remove_link': 'Koppeling verwijderen',
    'project_tasks.link_documents': 'Documenten',
    'project_tasks.link_notebooks': 'Notitieboeken',
    'project_tasks.link_meetings': 'Meetings',
    'project_tasks.link_chats': 'Chats',
    'project_tasks.meeting': 'Meeting',
    'project_tasks.thread_in': 'Thread in {chat}',
    'project_tasks.from_chat': 'Maak een taak van deze chat',
    'project_tasks.from_thread': 'Maak een taak van deze thread',
    'project_tasks.from_message': 'Maak een taak van dit bericht',
    // ── Filters, sorting, views ──────────────────────────────────────
    'project_tasks.show': 'Tonen',
    'project_tasks.filters': 'Taken filteren',
    'project_tasks.who_all': 'Alle taken',
    'project_tasks.who_me': 'Aan mij gegeven',
    'project_tasks.who_unassigned': 'Aan niemand gegeven',
    'project_tasks.overdue_only': 'Te laat',
    'project_tasks.clear_filters': 'Filters wissen',
    'project_tasks.sort': 'Sorteren op',
    'project_tasks.sort_due': 'Sorteren: deadline',
    'project_tasks.sort_priority': 'Sorteren: prioriteit',
    'project_tasks.sort_newest': 'Sorteren: nieuwste',
    'project_tasks.view': 'Weergave',
    'project_tasks.view_list': 'Lijst',
    'project_tasks.view_board': 'Bord',
    'project_tasks.move_to': 'Verplaatsen naar',
    'project_tasks.move_to_status': 'Verplaatsen naar: {status}',
    // ── From a meeting ───────────────────────────────────────────────
    'project_tasks.from_meeting_button': 'Uit een meeting',
    'project_tasks.from_meeting_title': 'Taken uit de meeting',
    'project_tasks.make_from_meeting': 'Maak taken van actiepunten',
    'project_tasks.pick_meeting': 'Kies een meeting',
    'project_tasks.loading_meetings': 'Meetings laden…',
    'project_tasks.no_meetings': 'Nog geen meetings in dit project. Neem er een op of upload er een op het tabblad Meetings.',
    'project_tasks.action_items': '{count} actiepunten',
    'project_tasks.loading_items': 'Actiepunten lezen…',
    'project_tasks.suggestions': 'Actiepunten',
    'project_tasks.suggestions_failed': 'De actiepunten van deze meeting konden niet worden gelezen.',
    'project_tasks.no_action_items': 'Deze meeting heeft geen actiepunten.',
    'project_tasks.review_hint': 'Vink de punten aan die een taak moeten worden. Elke taak verwijst terug naar de meeting.',
    'project_tasks.include_item': 'Maak een taak van: {text}',
    'project_tasks.select_all': 'Alles selecteren',
    'project_tasks.select_none': 'Niets selecteren',
    'project_tasks.make_n': 'Maak {count} taken',
    'project_tasks.made_count': '{count} taken gemaakt',
    'project_tasks.already_task': 'Al een taak',
    'project_tasks.done_in_meeting': 'In de notities als klaar gemarkeerd',
    'project_tasks.note_says': 'In de notities staat: {name}',
    'project_tasks.from_meeting': 'Uit de meeting "{title}".',
    'project_tasks.from_meeting_at': 'Uit de meeting "{title}", bij {at}.',
    'project_tasks.from_meeting_for': 'In de meeting was dit voor: {name}.',
    // ── Chat additions ───────────────────────────────────────────────
    'project_chat.composer_placeholder': 'Bericht aan het team. Typ @ om iemand, de AI, een document, een notitieboek of een meeting te noemen.',
    'project_chat.mention_document_hint': 'document',
    'project_chat.mention_notebook_hint': 'notitieboek',
    'project_chat.ref_document': 'Document',
    'project_chat.ref_notebook': 'Notitieboek',
    'project_chat.open_ref': '{name} openen',
    'project_chat.reply_in_thread': 'Reageren in thread',
    'project_chat.thread_title': 'Thread',
    'project_chat.close_thread': 'Thread sluiten',
    'project_chat.thread_one': '1 reactie',
    'project_chat.thread_many': '{count} reacties',
    'project_chat.thread_placeholder': 'Reageer in de thread. Typ @ om iemand, de AI, een document, een notitieboek of een meeting te noemen.',
    'project_chat.thread_no_replies': 'Nog geen reacties',
    'project_chat.thread_replies_heading': 'Reacties',
    'project_chat.today': 'Vandaag',
    'project_chat.yesterday': 'Gisteren',
    'project_chat.answer_auto_tier': 'Auto → {tier}',
    'project_chat.shield_one': '1 waarde vervangen door Privacybescherming',
    'project_chat.shield_many': '{count} waarden vervangen door Privacybescherming',
    'project_chat.trace_title': 'Hoe ik aan dit antwoord kwam',
    'project_chat.trace_loading': 'Laden…',
    'project_chat.trace_failed': 'Dit is niet meer beschikbaar.',
    'project_chat.trace_summary': 'Privacybescherming verving {count} waarden door plaatshouders voordat dit bij {model} kwam. De echte waarden zijn in het antwoord dat je las teruggezet.',
    'project_chat.trace_the_model': 'het model',
    'project_chat.trace_detected': 'Gevonden: {kinds}',
    'project_chat.trace_original': 'Oorspronkelijk bericht',
    'project_chat.trace_original_note': 'zoals geschreven in deze chat',
    'project_chat.trace_sent': 'Naar de AI gestuurd',
    'project_chat.trace_mapping': 'Plaatshouders',
    'project_chat.trace_mapping_note': '{count} items',
    'project_chat.trace_returned': 'Wat de AI teruggaf',
    'project_chat.trace_returned_note': 'plaatshouders intact',
    'project_chat.trace_copy': '{label} kopiëren',
    'project_chat.trace_copy_short': 'Kopiëren',
    'project_chat.trace_copied': 'Gekopieerd',
    'project_chat.trace_copy_failed': 'Kopiëren mislukt',
    // ── AI on tasks, meeting notes in projects ───────────────────────
    'project_tasks.improve_with_ai': 'Verbeter met AI',
    'project_tasks.ai_working': 'Verbeteren…',
    'project_tasks.ai_improving': 'De AI vult omschrijvingen, labels en wie het doet in…',
    'project_tasks.ai_chose_person': 'Voorgesteld door de AI',
    'project_tasks.ai_failed': 'De AI kon deze niet uitbreiden. Je kunt ze nog steeds zo maken, of het opnieuw proberen.',
    'project_tasks.ai_failed_one': 'De AI kon deze taak nu niet verbeteren.',
    'project_tasks.ai_suggested': 'De AI heeft suggesties ingevuld. Lees ze, pas aan wat je wilt en sla op.',
    'project_tasks.not_assigned': 'Niet toegewezen',
    'project_tasks.steps_count': '{count} stappen',
    'project_tasks.update_item': 'Werk de bestaande taak bij met de AI: {text}',
    'project_tasks.already_task_update': 'Al een taak: vink aan om de AI die te laten verbeteren',
    'project_tasks.update_n': 'Verbeter {count} taken',
    'project_tasks.make_and_update_n': 'Maak {made} taken en verbeter {updated}',
    'project_tasks.made_and_updated': '{made} taken gemaakt, {updated} verbeterd',
    'project_tasks.all_already': 'Elk open actiepunt is al een taak. Zodra de AI heeft geantwoord kun je er een aanvinken om die taak te laten verbeteren: een vollere omschrijving, labels, stappen en wie het doet.',
    'project_tasks.delete_task': 'Taak {name} verwijderen',
    'project_tasks.delete_named': '"{name}" verdwijnt voor iedereen in het project.',
    'project_tasks.deleted': 'Taak verwijderd',
    'project_home.color.violet': 'Paars',
    'project_home.members.colour_for': 'Kleur voor {name}',
    'project_home.members.colour_of': 'Kleur van {name}',
    'project_home.members.colour_auto': 'Automatisch',
    'project_chat.mention_meeting_hint': 'meeting',
    'project_chat.ref_meeting': 'Meeting',
    'project_content.meeting_already_shared': 'Al op een andere manier gedeeld. Maak de notitie eerst persoonlijk: een notitie in een project is open voor het hele project, en voor niemand anders.',
    'project_content.notebook_loading': 'Notitieboek openen…',
};

const SAME_AS_ENGLISH = [];

async function up({ languageStore = require('../stores/languageStore') } = {}) {
    // Atomic across replicas (advisory lock in mutateConfig); existing values
    // win, only missing keys are added.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-project-tasks-translations: added ${added} NL keys`);
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
