#!/usr/bin/env node
/**
 * Dutch for the bell notifications of project collaboration (2026-10): a
 * mention in a team chat or a comment, being added, a role change, removal,
 * a member leaving, a change of owner, and the task notifications that moved
 * into the same catalogue (assigned, mentioned, due tomorrow / today, overdue).
 * The server renders these in the recipient's language.
 *
 * Terminology follows add-nl-project-workspace-translations: chat stays
 * English ("teamchat"), a project is een project, informal "je".
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-project-collab-translations.js
 */

const NL_TRANSLATIONS = {
    'project_collab.bell.chat_mention.title': 'Je bent genoemd in een teamchat',
    'project_collab.bell.chat_mention.message': 'In het project "{project}", door {actor}.',
    'project_collab.bell.comment_mention.title': 'Je bent genoemd in een reactie',
    'project_collab.bell.comment_mention.message': 'In het project "{project}", door {actor}.',
    'project_collab.bell.added.title': 'Je bent toegevoegd aan een project',
    'project_collab.bell.added.message': '{actor} heeft je toegevoegd aan "{project}".',
    'project_collab.bell.role_changed.title': 'Je rol in een project is gewijzigd',
    'project_collab.bell.role_changed.message': 'In "{project}": {role}.',
    'project_collab.bell.removed.title': 'Je bent uit een project verwijderd',
    'project_collab.bell.removed.message': 'Je hebt geen toegang meer tot "{project}".',
    'project_collab.bell.left.title': 'Een lid heeft je project verlaten',
    'project_collab.bell.left.message': '{actor} heeft "{project}" verlaten.',
    'project_collab.bell.owner_changed.title': 'Je bent nu eigenaar van een project',
    'project_collab.bell.owner_changed.message': '{actor} heeft "{project}" aan je overgedragen.',
    'project_collab.bell.owner_handed.title': 'Je hebt een project overgedragen',
    'project_collab.bell.owner_handed.message': '"{project}" is nu van {actor}.',
    'project_collab.bell.task_assigned.title': 'Er is een taak aan je toegewezen',
    'project_collab.bell.task_assigned.message': 'In het project "{project}".',
    'project_collab.bell.task_mention.title': 'Je bent genoemd bij een taak',
    'project_collab.bell.task_mention.message': 'In het project "{project}".',
    'project_collab.bell.task_due_1d.title': 'Een taak is morgen aan de beurt',
    'project_collab.bell.task_due_1d.message': 'In het project "{project}".',
    'project_collab.bell.task_due_today.title': 'Een taak moet vandaag klaar zijn',
    'project_collab.bell.task_due_today.message': 'In het project "{project}".',
    'project_collab.bell.task_overdue.title': 'Een taak is te laat',
    'project_collab.bell.task_overdue.message': 'In het project "{project}".',
    'project_collab.email.chat_mention.event': 'Genoemd in een teamchat',
    'project_collab.email.chat_mention.detail': 'Je bent genoemd in een teamchat van dit project.',
    'project_collab.email.comment_mention.event': 'Genoemd in een reactie',
    'project_collab.email.comment_mention.detail': 'Je bent genoemd in een reactie in dit project.',
    'project_collab.email.added.event': 'Toegevoegd aan een project',
    'project_collab.email.added.detail': 'Je hebt nu toegang tot dit project.',
    'project_collab.email.role_changed.event': 'Rol gewijzigd',
    'project_collab.email.role_changed.detail': 'Je rol in dit project is gewijzigd.',
    'project_collab.email.removed.event': 'Verwijderd uit een project',
    'project_collab.email.removed.detail': 'Je hebt geen toegang meer tot dit project.',
    'project_collab.email.left.event': 'Een lid is vertrokken',
    'project_collab.email.left.detail': 'Een lid heeft dit project verlaten.',
    'project_collab.email.owner_changed.event': 'Nieuwe eigenaar van een project',
    'project_collab.email.owner_changed.detail': 'Je bent nu eigenaar van dit project.',
    'project_collab.email.owner_handed.detail': 'Je hebt dit project aan een nieuwe eigenaar overgedragen.',
    'project_collab.email.chat_mention.intro': '{actor} heeft je genoemd in "{project}"',
    'project_collab.email.comment_mention.intro': '{actor} heeft je genoemd in een reactie in "{project}"',
    'project_collab.email.added.intro': '{actor} heeft je toegevoegd aan "{project}"',
    'project_collab.email.role_changed.intro': '{actor} heeft je rol in "{project}" gewijzigd',
    'project_collab.email.removed.intro': '{actor} heeft je verwijderd uit "{project}"',
    'project_collab.email.left.intro': '{actor} heeft "{project}" verlaten',
    'project_collab.email.owner_changed.intro': '{actor} heeft je eigenaar van "{project}" gemaakt',
    'project_collab.email.owner_handed.intro': 'Je hebt "{project}" overgedragen aan {actor}',
    'project_collab.email.task_assigned.event': 'Taak aan je toegewezen',
    'project_collab.email.task_assigned.detail': 'Er is een taak in dit project aan je toegewezen.',
    'project_collab.email.task_assigned.intro': '{actor} heeft je een taak toegewezen in "{project}"',
    'project_collab.prefs.title': 'Projectmeldingen',
    'project_collab.prefs.help': 'Kies hoe je op de hoogte wordt gehouden van wat er in je projecten gebeurt. Je kunt ook één project dempen in de instellingen ervan.',
    'project_collab.prefs.event': 'Wat er gebeurde',
    'project_collab.prefs.bell': 'Bel',
    'project_collab.prefs.email': 'E-mail',
    'project_collab.prefs.event.chat_mention': 'Genoemd in een teamchat',
    'project_collab.prefs.event.comment_mention': 'Genoemd in een reactie',
    'project_collab.prefs.event.added': 'Toegevoegd aan een project',
    'project_collab.prefs.event.role_changed': 'Mijn rol in een project is gewijzigd',
    'project_collab.prefs.event.removed': 'Verwijderd uit een project',
    'project_collab.prefs.event.left': 'Een lid heeft mijn project verlaten',
    'project_collab.prefs.event.owner_changed': 'Eigenaar van het project gewijzigd',
    'project_collab.prefs.event.task_assigned': 'Een taak is aan mij toegewezen',
    'project_collab.prefs.load_failed': 'Je meldingsvoorkeuren konden niet worden geladen.',
    'project_collab.prefs.save_failed': 'Die wijziging kon niet worden opgeslagen. Probeer het opnieuw.',
    'project_collab.mute.title': 'Meldingen',
    'project_collab.mute.label': 'Dit project voor mij dempen',
    'project_collab.mute.help': 'Geen bel en geen e-mail voor dit project. Dit geldt alleen voor jou en je kunt het altijd weer opheffen.',
    'project_collab.mute.done_muted': 'Project gedempt. Je krijgt hiervoor geen bel of e-mail.',
    'project_collab.mute.done_unmuted': 'Demping van het project opgeheven.',
    'project_collab.mute.failed': 'De demping kon niet worden gewijzigd.',
    'project_collab.mute.menu_mute': 'Dit project dempen',
    'project_collab.mute.menu_unmute': 'Demping van dit project opheffen',
};

const SAME_AS_ENGLISH = [];

async function up({ languageStore = require('../stores/languageStore') } = {}) {
    // Atomic across replicas (advisory lock in mutateConfig); existing values
    // win, only missing keys are added.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-project-collab-translations: added ${added} NL keys`);
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
