#!/usr/bin/env node
/**
 * Dutch for the collaboration client (2026-10): invite by typing a name,
 * transferring ownership, archiving and restoring a project, notification
 * preferences and muting a project, and who is viewing an item.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-project-collab-client-translations.js
 */

const NL_TRANSLATIONS = {
    'project_home.archive.confirm': 'Archiveren',
    'project_home.archive.confirm_body': 'Iedereen houdt leestoegang, maar er kan niets worden toegevoegd of gewijzigd totdat je het project terughaalt. Het verdwijnt uit de zijbalk.',
    'project_home.archive.confirm_title': 'Dit project archiveren?',
    'project_home.archive.done': 'Project gearchiveerd.',
    'project_home.archive.help': 'Sluit het project af zonder het te verwijderen. Je kunt het op elk moment terughalen.',
    'project_home.archive.is_archived': 'Dit project is gearchiveerd. Haal het terug om er weer in te werken.',
    'project_home.archive.open': 'Dit project archiveren',
    'project_home.archive.restore': 'Terughalen',
    'project_home.archive.restored': 'Project teruggehaald.',
    'project_home.archived.band': 'Gearchiveerd op {date} door {name}',
    'project_home.archived.band_no_name': 'Gearchiveerd op {date}',
    'project_home.archived.chip': 'Gearchiveerd',
    'project_home.archived.read_only': 'Dit project is gearchiveerd en alleen-lezen. Haal het terug om iets te wijzigen.',
    'project_home.archived.refused': 'Dit project is gearchiveerd en alleen-lezen. De eigenaar kan het terughalen.',
    'project_home.list.filter_archived': 'Gearchiveerd',
    'project_home.list.none_archived': 'Geen gearchiveerde projecten.',
    'project_home.members.admin_transfer': 'Als beheerder van de organisatie kun je een nieuwe eigenaar voor dit project aanwijzen.',
    'project_home.members.ask_owner': 'Vraag de eigenaar om mensen uit te nodigen.',
    'project_home.members.pick_other': 'Kies iemand anders',
    'project_home.members.search_label': 'Zoek mensen en groepen',
    'project_home.members.search_placeholder': 'Typ een naam…',
    'project_home.members.type_more': 'Typ minstens {n} tekens',
    'project_home.settings.archive': 'Archief',
    'project_home.settings.collab': 'Samenwerking',
    'project_home.settings.editors_can_invite': 'Editors mogen mensen uitnodigen',
    'project_home.settings.editors_can_invite_help': 'Editors kunnen mensen en groepen toevoegen als viewer of editor. Rollen wijzigen en mensen verwijderen blijft bij de eigenaar.',
    'project_home.settings.ownership': 'Eigenaarschap',
    'project_home.settings.ownership_help': 'Draag het project over aan een ander lid. Jij kiest wat je daarna blijft.',
    'project_home.transfer.afterwards': 'Daarna ben jij',
    'project_home.transfer.body': 'De nieuwe eigenaar beheert de leden en kan het project verwijderen. Alleen een lid kan eigenaar worden.',
    'project_home.transfer.cancel': 'Annuleren',
    'project_home.transfer.confirm': 'Overdragen',
    'project_home.transfer.done': 'Eigenaarschap overgedragen.',
    'project_home.transfer.failed': 'Het eigenaarschap kon niet worden overgedragen.',
    'project_home.transfer.keep_editor': 'Blijf editor',
    'project_home.transfer.keep_none': 'Verlaat het project',
    'project_home.transfer.keep_viewer': 'Blijf viewer',
    'project_home.transfer.new_owner': 'Nieuwe eigenaar',
    'project_home.transfer.not_a_member': 'Alleen een lid van dit project kan eigenaar worden.',
    'project_home.transfer.open': 'Eigenaarschap overdragen…',
    'project_home.transfer.owner_changed': 'De eigenaar is intussen gewijzigd. Laad de pagina opnieuw en probeer het nog eens.',
    'project_home.transfer.pick_first': 'Kies eerst de nieuwe eigenaar.',
    'project_home.transfer.title': 'Eigenaarschap overdragen',
    'project_home.transfer.transfer_first': 'Draag het project eerst over aan iemand anders.',
    'project_home.transfer.unnamed': 'Een lid',
    'project_collab.mute.done_muted': 'Project gedempt. Je krijgt er geen bel of e-mail meer voor.',
    'project_collab.mute.done_unmuted': 'Project weer ingeschakeld.',
    'project_collab.mute.failed': 'De demping kon niet worden gewijzigd.',
    'project_collab.mute.help': 'Geen bel en geen e-mail voor dit project. Dit geldt alleen voor jou en je kunt het altijd weer aanzetten.',
    'project_collab.mute.label': 'Dit project voor mij dempen',
    'project_collab.mute.menu_mute': 'Dit project dempen',
    'project_collab.mute.menu_unmute': 'Demping opheffen',
    'project_collab.mute.title': 'Meldingen',
    'project_collab.prefs.bell': 'Bel',
    'project_collab.prefs.event': 'Wat er gebeurde',
    'project_collab.prefs.event.added': 'Toegevoegd aan een project',
    'project_collab.prefs.event.chat_mention': 'Genoemd in een teamchat',
    'project_collab.prefs.event.comment_mention': 'Genoemd in een opmerking',
    'project_collab.prefs.event.left': 'Een lid heeft mijn project verlaten',
    'project_collab.prefs.event.owner_changed': 'Eigenaarschap van het project gewijzigd',
    'project_collab.prefs.event.removed': 'Verwijderd uit een project',
    'project_collab.prefs.event.role_changed': 'Mijn rol in een project is gewijzigd',
    'project_collab.prefs.event.task_assigned': 'Er is een taak aan mij toegewezen',
    'project_collab.prefs.help': 'Kies hoe je hoort over wat er in je projecten gebeurt. Je kunt ook één project dempen in de instellingen ervan.',
    'project_collab.prefs.load_failed': 'Je meldingsvoorkeuren konden niet worden geladen.',
    'project_collab.prefs.save_failed': 'Die wijziging kon niet worden opgeslagen. Probeer het opnieuw.',
    'project_collab.prefs.title': 'Meldingen van projecten',
    'project_home.presence.viewing': '{name} bekijkt dit',
};

/** Spelled the same in Dutch: left out of the catalogue on purpose. */
const SAME_AS_ENGLISH = ['project_collab.prefs.email'];

/** @param {{ languageStore?: { addMissingGUITranslations: Function } }} [deps]  the real store unless a test hands one in */
async function up({ languageStore = require('../stores/languageStore') } = {}) {
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-project-collab-client-translations: added ${added} NL keys`);
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
