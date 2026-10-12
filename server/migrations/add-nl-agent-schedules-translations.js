#!/usr/bin/env node
/**
 * One-time migration: Dutch for the schedules panel of the agent builder
 * (namespace agent_schedules): Cowork items that run as this agent, which used
 * to be "agent routines".
 *
 * Usage:  node server/migrations/add-nl-agent-schedules-translations.js
 *
 * Merges into the existing i18n_gui_nl config without overwriting any
 * translation that already exists.
 */

const NL_TRANSLATIONS = {
    'agent_schedules.add': 'Planning toevoegen',
    'agent_schedules.additional_instructions_optional': 'Extra instructies (optioneel)',
    'agent_schedules.beta_badge': 'Bèta',
    'agent_schedules.cadence_biweekly': 'Elke 2 weken',
    'agent_schedules.cadence_daily': 'Dagelijks',
    'agent_schedules.cadence_hourly': 'Elk uur',
    'agent_schedules.cadence_monthly': 'Maandelijks',
    'agent_schedules.cadence_weekdays': 'Werkdagen (ma–vr)',
    'agent_schedules.cadence_weekly': 'Wekelijks',
    'agent_schedules.cancel': 'Annuleren',
    'agent_schedules.day_n': 'Dag {n}',
    'agent_schedules.day_of_month': 'Dag van de maand',
    'agent_schedules.day_of_week': 'Dag van de week',
    'agent_schedules.delete': 'Verwijderen',
    'agent_schedules.delete_body': '"{title}" verwijderen?',
    'agent_schedules.delete_title': 'Planning verwijderen',
    'agent_schedules.edit': 'Planning bewerken',
    'agent_schedules.error_prompt_required': 'Een prompt is verplicht',
    'agent_schedules.error_title_required': 'Een titel is verplicht',
    'agent_schedules.hour_one': '1 uur',
    'agent_schedules.new': 'Nieuwe planning',
    'agent_schedules.none_for_agent': 'Nog geen planningen voor deze agent.',
    'agent_schedules.overdue': 'Te laat',
    'agent_schedules.pause': 'Pauzeren',
    'agent_schedules.paused': 'Gepauzeerd',
    'agent_schedules.placeholder_what_should_agent_do': 'Wat moet {agent} doen?',
    'agent_schedules.repeat': 'Herhalen',
    'agent_schedules.resume': 'Hervatten',
    'agent_schedules.run_every': 'Draai elke',
    'agent_schedules.run_now': 'Nu uitvoeren',
    'agent_schedules.save_changes': 'Wijzigingen opslaan',
    'agent_schedules.scheduled_for': 'Gepland voor',
    'agent_schedules.task_name': 'Naam van de planning',
    'agent_schedules.time': 'Tijd',
    'agent_schedules.timezone': 'Tijdzone',
    'agent_schedules.title': 'Planningen',
    'agent_schedules.title_placeholder': 'bijv. Dagelijkse stand-upsamenvatting',
    'agent_schedules.today_at': 'Vandaag om',
    'agent_schedules.tomorrow_at': 'Morgen om',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-agent-schedules-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then((r) => {
        console.log(r.added === 0
            ? 'All translations already exist. Nothing to do.'
            : `✓ Done! Added ${r.added} translations.`);
        process.exit(0);
    }).catch(err => {
        console.error('Migration failed:', err);
        process.exit(1);
    });
}
