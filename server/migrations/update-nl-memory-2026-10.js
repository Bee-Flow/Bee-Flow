#!/usr/bin/env node
/**
 * Dutch for the memory work (Oct 2026): the memory manager in Knowledge
 * (views, filters, review queue, bulk actions), the chat controls and the
 * "used / remembered" chips, the organisation Memory admin page, the extra
 * Settings -> Memory lines (sensitive topics, org switch, export, delete all)
 * and the encryption surface label.
 *
 * Terms: the feature is "geheugen", one item is "herinnering".
 *
 * Two kinds of key:
 *   NL_TRANSLATIONS  keys this work added; written when a workspace does not
 *                    have them yet, so a workspace's own wording is kept.
 *   NL_REWORDED      keys whose English changed meaning. "Conversation
 *                    memory" became "Context in long conversations" so it no
 *                    longer collides with the Memory feature, and "off" became
 *                    "paused". Replaced only while the workspace still has the
 *                    OLD shipped Dutch (`was`), so an admin's own wording stays.
 *
 * The earlier catalogues (add-nl-ui-complete-2026-10-translations,
 * add-nl-memory-switch-translations) are unchanged files, so the boot ledger
 * would not re-run them; the new Dutch reaches existing installs from here.
 * Idempotent. Auto-runs from server boot (boot/bootMigrations.js). Manual:
 *   node server/migrations/update-nl-memory-2026-10.js
 */

const NL_TRANSLATIONS = Object.freeze({
    // Review fixes: paused import, refused writes, org sensitive switch, lazy previews
    'settings.memory_import_paused': 'Importeren is niet beschikbaar zolang het geheugen gepauzeerd is. Zet het geheugen aan om te importeren.',
    'chat.memory.used_loading': 'Laden…',
    'chat.memory.used_gone': 'Niet meer beschikbaar',
    'chat.memory.group_profile': 'Altijd gebruikt',
    'chat.memory.group_profile_desc': 'Je vaste instructies en voorkeuren',
    'chat.memory.group_relevant': 'Relevant voor dit bericht',
    'chat.memory.forget': 'Deze herinnering vergeten',
    'chat.memory.forgotten': 'Vergeten',
    'chat.memory.forget_failed': 'Kon deze herinnering niet vergeten.',
    'admin.org_memory.sensitive_off_title': 'Gevoelige onderwerpen niet meer toestaan?',
    'admin.org_memory.sensitive_off_desc': 'De gevoelige herinneringen van leden en hun keuze om zulke herinneringen te bewaren worden verwijderd. Dit kan niet ongedaan worden gemaakt.',
    'admin.org_memory.sensitive_off_confirm': 'Uitzetten en verwijderen',
    'admin.org_memory.deleted_sensitive': '1 gevoelige herinnering verwijderd.',
    'admin.org_memory.deleted_sensitive_plural': '{count} gevoelige herinneringen verwijderd.',
    'knowledge.memory_err_identifier': 'Dit lijkt op een wachtwoord, rekening- of ID-nummer. Zulke gegevens worden nooit opgeslagen.',
    'knowledge.memory_err_sensitive': 'Dit gaat over een gevoelig onderwerp. Zet gevoelige onderwerpen aan in Instellingen → Geheugen om het te bewaren, als je organisatie dat toestaat.',
    'knowledge.memory_err_disabled': 'Het geheugen staat uit voor je organisatie, dus er kan niets worden toegevoegd.',
    'knowledge.memory_err_unreadable': 'Deze herinnering kan niet meer worden geopend; je kunt haar verwijderen.',
    'knowledge.memory_import_err_paused': 'Importeren is niet beschikbaar terwijl het geheugen gepauzeerd of uitgeschakeld is.',
    'knowledge.memory_import_skipped_sensitive': '{count} overgeslagen omdat ze over een gevoelig onderwerp gaan.',
    'knowledge.memory_import_skipped_identifier': '{count} overgeslagen omdat ze lijken op een wachtwoord, rekening- of ID-nummer.',
    // Organisation admin page
    'admin.org_memory.title': 'Geheugen',
    'admin.org_memory.intro': 'Of de assistent over chats heen dingen over mensen onthoudt, en hoeveel. Geldt voor iedereen in de organisatie.',
    'admin.org_memory.enabled': 'Geheugen ingeschakeld voor deze organisatie',
    'admin.org_memory.enabled_desc': 'Als dit uit staat, wordt er voor niemand in de organisatie iets onthouden of in chats gelezen. Bestaande herinneringen blijven bewaard tot iemand ze verwijdert.',
    'admin.org_memory.sensitive': 'Leden toestaan gevoelige onderwerpen te activeren',
    'admin.org_memory.sensitive_desc': 'Leden kunnen dan in hun eigen instellingen kiezen dat het geheugen ook zaken als gezondheid of geloofsovertuiging bewaart. Standaard heeft niemand dit aan staan.',
    'admin.org_memory.max_label': 'Herinneringen per persoon',
    'admin.org_memory.max_hint': 'Tussen {min} en {max}. Als iemand de limiet bereikt, worden de minst nuttige herinneringen als eerste afgevoerd.',
    'admin.org_memory.max_invalid': 'Vul een geheel getal in tussen {min} en {max}.',
    'admin.org_memory.saved': 'Geheugeninstellingen opgeslagen',
    'admin.org_memory.save_failed': 'De geheugeninstellingen konden niet worden opgeslagen',
    'admin.org_memory.forbidden': 'Alleen een beheerder van deze organisatie kan dit wijzigen.',
    'admin.org_memory.load_failed': 'De geheugeninstellingen konden niet worden geladen.',
    'admin.org_memory.retry': 'Opnieuw proberen',
    'admin.org_memory.stats_title': 'Wat er is opgeslagen',
    'admin.org_memory.stats_desc': 'Alleen aantallen. Wat een herinnering zegt, blijft privé voor de persoon van wie ze is.',
    'admin.org_memory.stats': 'Actieve herinneringen: {memories}. Personen met herinneringen: {users}.',
    'admin.org_memory.danger_title': 'Gevarenzone',
    'admin.org_memory.danger_desc': 'Verwijdert alle herinneringen van alle leden. Gebruik dit als de organisatie met een schone lei wil beginnen.',
    'admin.org_memory.clear_button': 'Alle herinneringen in deze organisatie verwijderen',
    'admin.org_memory.clear_title': 'Alle herinneringen in deze organisatie verwijderen?',
    'admin.org_memory.clear_desc': 'Alle herinneringen van alle leden worden definitief verwijderd. Dit kan niet ongedaan worden gemaakt.',
    'admin.org_memory.clear_type': 'Typ {word} om te bevestigen',
    'admin.org_memory.clear_confirm': 'Alle herinneringen verwijderen',
    'admin.org_memory.cleared': '1 herinnering in deze organisatie verwijderd.',
    'admin.org_memory.cleared_plural': '{count} herinneringen in deze organisatie verwijderd.',
    'admin.org_memory.clear_failed': 'De herinneringen konden niet worden verwijderd. Er is niets gewijzigd.',
    'admin.encryption.surface_memories': 'Geheugen',

    // Chat: chips, controls and delete-chat dialog
    'chat.memory.used': '1 herinnering gebruikt',
    'chat.memory.used_plural': '{count} herinneringen gebruikt',
    'chat.memory.used_list': 'Herinneringen die voor dit antwoord zijn gebruikt',
    'chat.memory.manage': 'Geheugen beheren',
    'chat.memory.type_instruction': 'Instructie',
    'chat.memory.type_person': 'Persoon',
    'chat.memory.type_project': 'Project',
    'chat.memory.type_preference': 'Voorkeur',
    'chat.memory.type_workflow': 'Workflow',
    'chat.memory.type_fact': 'Feit',
    'chat.memory.type_context': 'Context',
    'chat.memory.remembered': 'Onthouden: {content}',
    'chat.memory.remembered_more': 'Onthouden: {content} (+{count} meer)',
    'chat.memory.undo': 'Ongedaan maken',
    'chat.memory.edit': 'Bewerken',
    'chat.memory.undone': 'Weer vergeten.',
    'chat.memory.undone_plural': 'Weer vergeten ({count} herinneringen).',
    'chat.memory.undo_failed': 'Dat kon niet ongedaan worden gemaakt. Je kunt het verwijderen via Geheugen beheren.',
    'chat.memory.control_label': 'Geheugen',
    'chat.memory.state_on': 'Aan',
    'chat.memory.state_read': 'Alleen lezen',
    'chat.memory.state_off': 'Uit voor deze chat',
    'chat.memory.hint_on': 'Geheugen aan: gebruikt wat onthouden is en slaat nieuwe dingen op. Klik voor Alleen lezen.',
    'chat.memory.hint_read': 'Alleen lezen: gebruikt wat onthouden is, maar slaat niets uit deze chat op. Klik om het geheugen voor deze chat uit te zetten.',
    'chat.memory.hint_off': 'Geheugen uit voor deze chat: er wordt niets gelezen of opgeslagen. Klik om het aan te zetten.',
    'chat.memory.lock_user_paused': 'Het geheugen is gepauzeerd. Hervat het via Instellingen, Geheugen, om het in chats te gebruiken.',
    'chat.memory.lock_org_off': 'Het geheugen is uitgeschakeld voor je organisatie. Een beheerder kan het inschakelen.',
    'chat.memory.delete_chat_title': 'Deze chat verwijderen?',
    'chat.memory.delete_chat_desc': 'Het gesprek wordt definitief verwijderd.',
    'chat.memory.forget_with_chat': 'Vergeet ook de herinneringen die in deze chat zijn opgedaan',
    'chat.memory.forgot_with_chat': 'Chat verwijderd. 1 herinnering die erin was opgedaan is vergeten.',
    'chat.memory.forgot_with_chat_plural': 'Chat verwijderd. {count} herinneringen die erin waren opgedaan zijn vergeten.',
    'chat.memory.delete_forget_failed': 'Chat verwijderd, maar de bijbehorende herinneringen konden niet worden verwijderd. Je kunt ze verwijderen via Geheugen beheren.',

    // Knowledge: memory manager
    'knowledge.memory_close': 'Sluiten',
    'knowledge.memory_import_prompt_label': 'Exportprompt',
    'knowledge.memory_importance_low': 'Laag',
    'knowledge.memory_importance_normal': 'Normaal',
    'knowledge.memory_importance_high': 'Hoog',
    'knowledge.memory_field_content': 'Herinnering',
    'knowledge.memory_field_type': 'Type',
    'knowledge.memory_field_importance': 'Belang',
    'knowledge.memory_view_active': 'Herinneringen',
    'knowledge.memory_view_review': 'Te beoordelen',
    'knowledge.memory_view_archived': 'Gearchiveerd',
    'knowledge.memory_scope_personal': 'Persoonlijk',
    'knowledge.memory_scope_agents': 'Agents',
    'knowledge.memory_scope_project': 'Project',
    'knowledge.memory_scope_all': 'Alle',
    'knowledge.memory_view_label': 'Tonen',
    'knowledge.memory_search_label': 'Herinneringen zoeken',
    'knowledge.memory_sort_label': 'Sorteren op',
    'knowledge.memory_sort_recent': 'Recent',
    'knowledge.memory_sort_last_used': 'Laatst gebruikt',
    'knowledge.memory_sort_importance': 'Belang',
    'knowledge.memory_source_label': 'Bron',
    'knowledge.memory_type_filter_label': 'Filteren op type',
    'knowledge.memory_archived_empty': 'Niets gearchiveerd',
    'knowledge.memory_archived_empty_desc': 'Herinneringen die zijn vervangen of afgevoerd verschijnen hier, en je kunt ze terugzetten.',
    'knowledge.memory_bulk_toolbar': 'Acties voor de geselecteerde herinneringen',
    'knowledge.memory_select_all': 'Alles selecteren',
    'knowledge.memory_bulk_type_label': 'Nieuw type voor de geselecteerde herinneringen',
    'knowledge.memory_change_type': 'Type wijzigen',
    'knowledge.memory_delete_selected': 'Geselecteerde verwijderen',
    'knowledge.memory_list_label': 'Herinneringen',
    'knowledge.memory_restore': 'Terugzetten',
    'knowledge.memory_loading_more': 'Laden…',
    'knowledge.memory_load_more': 'Meer laden ({count} resterend)',
    'knowledge.memory_saved': 'Herinnering opgeslagen',
    'knowledge.memory_save_error': 'Deze herinnering kon niet worden opgeslagen. Probeer het opnieuw.',
    'knowledge.memory_delete_title': 'Deze herinnering verwijderen?',
    'knowledge.memory_delete_desc': 'Ze wordt niet meer in je chats gebruikt. Dit kan niet ongedaan worden gemaakt.',
    'knowledge.memory_deleted': 'Herinnering verwijderd',
    'knowledge.memory_delete_error': 'Deze herinnering kon niet worden verwijderd. Probeer het opnieuw.',
    'knowledge.memory_bulk_delete_title': 'De geselecteerde herinneringen verwijderen?',
    'knowledge.memory_bulk_delete_desc': 'Ze worden niet meer in je chats gebruikt. Dit kan niet ongedaan worden gemaakt.',
    'knowledge.memory_bulk_deleted': 'Geselecteerde herinneringen verwijderd',
    'knowledge.memory_bulk_delete_error': 'De geselecteerde herinneringen konden niet worden verwijderd. Probeer het opnieuw.',
    'knowledge.memory_bulk_type_done': 'Type gewijzigd',
    'knowledge.memory_bulk_type_error': 'Het type kon niet worden gewijzigd. Probeer het opnieuw.',
    'knowledge.memory_added_toast': 'Herinnering toegevoegd',
    'knowledge.memory_add_error': 'Deze herinnering kon niet worden toegevoegd. Probeer het opnieuw.',
    'knowledge.memory_restored': 'Herinnering teruggezet',
    'knowledge.memory_restore_error': 'Deze herinnering kon niet worden teruggezet. Probeer het opnieuw.',
    'knowledge.memory_approved': 'Herinnering goedgekeurd',
    'knowledge.memory_review_error': 'Deze herinnering kon niet worden bijgewerkt. Probeer het opnieuw.',
    'knowledge.memory_rejected': 'Herinnering verwijderd',
    'knowledge.memory_export_error': 'Je herinneringen konden niet worden geëxporteerd. Probeer het opnieuw.',
    'knowledge.memory_empty_personal': 'Herinneringen worden automatisch uit gesprekken gehaald. Vertel je AI over jezelf om je geheugen op te bouwen!',
    'knowledge.memory_load_forbidden': 'Je hebt geen toegang meer tot deze herinneringen.',
    'knowledge.memory_load_error': 'Herinneringen laden mislukt',
    'knowledge.memory_count_stored': '{count} opgeslagen',
    'knowledge.memory_last_used': 'Laatst gebruikt {when}',
    'knowledge.memory_just_now': 'zojuist',
    'knowledge.memory_never_used': 'Nog nooit gebruikt',
    'knowledge.memory_select_one': 'Herinnering selecteren: {preview}',
    'knowledge.memory_sensitive': 'Gevoelig',
    'knowledge.memory_added': 'Toegevoegd {when}',
    'knowledge.memory_learned_in_chat': 'In deze chat opgedaan',
    'knowledge.memory_source_chat': 'Bronchat openen',
    'knowledge.memory_edit_named': 'Herinnering bewerken: {preview}',
    'knowledge.memory_delete_named': 'Herinnering verwijderen: {preview}',
    'knowledge.memory_origin_explicit': 'Door jou toegevoegd',
    'knowledge.memory_origin_inferred': 'In chat opgedaan',
    'knowledge.memory_origin_imported': 'Geïmporteerd',
    'knowledge.memory_origin_tool': 'Opgeslagen door assistent',
    'knowledge.memory_review_explainer': 'Deze herinneringen gaan over gevoelige onderwerpen, die je hebt toegestaan. Niets hiervan wordt in je chats gebruikt totdat je het goedkeurt. Afwijzen verwijdert de herinnering.',
    'knowledge.memory_review_empty': 'Niets te beoordelen',
    'knowledge.memory_review_empty_desc': 'Als de assistent iets gevoeligs oppikt, wacht het hier op jouw beslissing.',
    'knowledge.memory_review_list_label': 'Te beoordelen herinneringen',
    'knowledge.memory_approve': 'Goedkeuren',
    'knowledge.memory_reject': 'Afwijzen',
    'knowledge.memory_type_one_instruction': 'Instructie',
    'knowledge.memory_type_one_person': 'Persoon',
    'knowledge.memory_type_one_project': 'Project',
    'knowledge.memory_type_one_preference': 'Voorkeur',
    'knowledge.memory_type_one_workflow': 'Workflow',
    'knowledge.memory_type_one_fact': 'Feit',
    'knowledge.memory_type_one_context': 'Context',

    // Settings -> Memory
    'settings.memory_sensitive_off_title': 'Stoppen met het onthouden van gevoelige onderwerpen?',
    'settings.memory_sensitive_off_desc': 'Gevoelige herinneringen die al zijn opgeslagen of op jouw beoordeling wachten, worden verwijderd. Dit kan niet ongedaan worden gemaakt.',
    'settings.memory_sensitive_off_confirm': 'Uitzetten en verwijderen',
    'settings.memory_sensitive_error': 'Deze instelling kon niet worden gewijzigd. Probeer het opnieuw.',
    'settings.memory_cleared': 'Je persoonlijke herinneringen zijn verwijderd',
    'settings.memory_org_off': 'Je organisatie heeft het geheugen uitgezet. Er wordt niets opgeslagen of in chats gebruikt, en dit kun je hier niet wijzigen. Herinneringen die je al hebt blijven bewaard en je kunt ze nog beheren of exporteren.',
    'settings.memory_state_on': 'Aan',
    'settings.memory_state_paused': 'Gepauzeerd (bewaard, niet gebruikt of opgeslagen)',
    'settings.memory_sensitive': 'Gevoelige onderwerpen onthouden',
    'settings.memory_sensitive_desc': 'Standaard worden gezondheid, geloofsovertuiging, seksuele geaardheid en vergelijkbare onderwerpen nooit onthouden. Als je dit toestaat, wachten zulke herinneringen op jouw goedkeuring voordat ze worden gebruikt.',
    'settings.memory_last_updated': 'Laatst bijgewerkt {when}',
    'settings.memory_pending_review': '{count} wachten op jouw beoordeling',
    'settings.memory_export': 'Alle herinneringen exporteren',
    'settings.memory_clear_all': 'Alle persoonlijke herinneringen verwijderen',
});

/**
 * English meaning changed; `was` is the Dutch that shipped for the old
 * English (add-nl-ui-complete-2026-10-translations and
 * add-nl-memory-switch-translations), `now` the Dutch for the new text.
 */
const NL_REWORDED = Object.freeze({
    'settings.ai_context': {
        was: 'Gespreksgeheugen',
        now: 'Context in lange gesprekken',
    },
    'settings.memory_switch_off_desc': {
        was: 'Geheugen staat uit: er wordt niets nieuws opgeslagen en je opgeslagen herinneringen worden niet in chats gebruikt. Ze blijven hier staan — je kunt ze nog steeds beheren, exporteren of importeren.',
        now: 'Geheugen is gepauzeerd: er wordt niets nieuws opgeslagen en je opgeslagen herinneringen worden niet in chats gebruikt. Ze blijven hier bewaard en je kunt ze nog steeds beheren of exporteren.',
    },
    'learn.encryption-tiers.weakenings.body': {
        // Paragraph 1 went from three to four surfaces (memories added).
        was: "Beide zijn met opzet gedocumenteerd, en beide horen in elk eerlijk antwoord.\n\n**1. Drie onderdelen gebruiken nog de escrow van de organisatie.** De tokenmap van de Privacy Shield, de gespreksamenvatting die Gespreksgeheugen schrijft en de gegenereerde gesprekstitel. Alle drie worden geschreven door code zonder gebruikerssessie in beeld: een scanner, een samenvattingstaak om 3 uur 's nachts. Een sleutel in handen van de organisatie is zwakker dan zero-knowledge en veel sterker dan de platte tekst die ze eerder waren. **Berichtteksten horen bewust niet in die set**: dat is de grens die het niveau de moeite waard maakt.\n\n**2. Alles wat gedeeld is, is aan de organisatie gekoppeld.** Een gesprek dat in een project wordt gedeeld, en elke vergadertranscriptie, op elk niveau. Bij Zero-knowledge is een transcript dus leesbaar voor de beheerder. Zeg dat hardop voordat iemand een gevoelige vergadering opneemt.",
        now: "Beide zijn met opzet gedocumenteerd, en beide horen in elk eerlijk antwoord.\n\n**1. Vier onderdelen gebruiken nog de escrow van de organisatie.** De tokenmap van de Privacy Shield, de gespreksamenvatting die voor lange gesprekken wordt geschreven, de gegenereerde gesprekstitel en de herinneringen die de assistent over mensen bewaart. Alle vier worden geschreven of gelezen door code zonder gebruikerssessie in beeld: een scanner, een samenvattingstaak om 3 uur 's nachts, een automatisering. Een sleutel in handen van de organisatie is zwakker dan zero-knowledge en veel sterker dan de platte tekst die ze eerder waren. **Berichtteksten horen bewust niet in die set**: dat is de grens die het niveau de moeite waard maakt.\n\n**2. Alles wat gedeeld is, is aan de organisatie gekoppeld.** Een gesprek dat in een project wordt gedeeld, en elke vergadertranscriptie, op elk niveau. Bij Zero-knowledge is een transcript dus leesbaar voor de beheerder. Zeg dat hardop voordat iemand een gevoelige vergadering opneemt.",
    },
    'admin.ai_context.title': {
        was: 'Gespreksgeheugen',
        now: 'Context in lange gesprekken',
    },
    'admin.ai_context.intro': {
        was: 'Hoeveel van een lang gesprek de assistent in beeld houdt. Geldt voor chats en agents in de hele organisatie en gaat in bij het volgende bericht.',
        now: 'Hoeveel van een lang gesprek de assistent in beeld houdt. Dit is niet dat de assistent dingen over mensen onthoudt; dat is de Geheugen-instelling. Geldt voor chats en agents in de hele organisatie en gaat in bij het volgende bericht.',
    },
    'admin.ai_context.choose': {
        was: 'Gespreksgeheugen',
        now: 'Context in lange gesprekken',
    },
    'admin.ai_context.saved': {
        was: 'Instellingen voor gespreksgeheugen opgeslagen',
        now: 'Instellingen voor context in lange gesprekken opgeslagen',
    },
    'admin.ai_context.save_failed': {
        was: 'Instellingen voor gespreksgeheugen opslaan mislukt',
        now: 'Instellingen voor context in lange gesprekken opslaan mislukt',
    },
    'admin.ai_context.load_failed': {
        was: 'Instellingen voor gespreksgeheugen laden mislukt.',
        now: 'Instellingen voor context in lange gesprekken laden mislukt.',
    },
});

/** The mutation itself, on a copy of the 'nl' blob. Pure, so the store's mutator may run it more than once. */
function applyNl(merged) {
    let added = 0;
    let reworded = 0;
    for (const [key, value] of Object.entries(NL_TRANSLATIONS)) {
        if (!merged[key]) {
            merged[key] = value;
            added++;
        }
    }
    for (const [key, { was, now }] of Object.entries(NL_REWORDED)) {
        // Missing -> write the current text; present and still the old shipped
        // text -> replace; anything else is the workspace's own wording and stays.
        if (!merged[key] || merged[key] === was) {
            if (merged[key] !== now) reworded++;
            merged[key] = now;
        }
    }
    return { merged, added, reworded };
}

async function up() {
    const languageStore = require('../stores/languageStore');
    let added = 0;
    let reworded = 0;
    await languageStore.mutateGUITranslations('nl', (current) => {
        const result = applyNl(current);
        added = result.added;
        reworded = result.reworded;
        return result.merged;
    });
    if (added > 0 || reworded > 0) {
        console.log(`[Migration] update-nl-memory-2026-10 applied (+${added} keys, ${reworded} reworded)`);
    }
    return { added, reworded };
}

module.exports = { up, applyNl, NL_TRANSLATIONS, NL_REWORDED };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
