#!/usr/bin/env node
/**
 * Migration: Dutch translations for the Condition node's "is about" rules
 * (routines.builder.topics.*): the topic box, its sensitivity, why the rule
 * cannot run when no topic classifier is installed, and "Check the sample
 * rows" in Suggest outputs.
 *
 * The operator names themselves ("is about", "is not about") live in the
 * editor's operator list next to "equals" and "contains", which are not
 * translated yet; the Dutch below quotes them as they appear on screen.
 *
 * Idempotent: only inserts keys that do not have a NL value yet. Runs at boot
 * from boot/bootMigrations.js (NL_TRANSLATIONS).
 *
 * Manual usage:
 *   node server/migrations/add-nl-topic-rules-translations.js
 */

const NL_TRANSLATIONS = {
    'automations.builder.topics.placeholder': 'een klacht',
    'automations.builder.topics.topic_label': 'Onderwerp',
    'automations.builder.topics.sensitivity': 'Hoe zeker het moet zijn',
    'automations.builder.topics.sensitivity_loose': 'Ruim',
    'automations.builder.topics.sensitivity_normal': 'Normaal',
    'automations.builder.topics.hint': 'Een classifier op deze server leest het begin en het einde van elke tekst en beslist. Er gaat niets de server uit. Noem één ding per onderwerp, zoals “een klacht”.',
    'automations.builder.topics.hint_together': 'De onderwerpen in deze stap worden samen beoordeeld: een onderwerp toevoegen kan de andere iets verschuiven, en een item dat bij twee onderwerpen past gaat soms maar één kant op.',
    'automations.builder.topics.reason_not_configured': 'Er is geen onderwerp-classifier geïnstalleerd op deze server. Vraag een beheerder om classify-service te starten; tot die tijd kan deze regel niet draaien.',
    'automations.builder.topics.reason_unreachable': 'De onderwerp-classifier antwoordt nu niet. De regel is bewaard, maar een run zou hier stoppen.',
    'automations.builder.topics.reason_loading': 'De onderwerp-classifier start nog op. Probeer het over een minuut opnieuw.',
    'automations.builder.topics.reason_error': 'De onderwerp-classifier meldt een probleem. Vraag een beheerder om classify-service te controleren.',
    'automations.builder.topics.decided_at_run': '“Is about”-regels worden door de onderwerp-classifier beslist als de stap draait, dus ze worden hier nog niet geteld.',
    'automations.builder.topics.check': 'Voorbeeld-{unit} controleren',
    'automations.builder.topics.checking': 'Voorbeeld-{unit} worden gecontroleerd…',
    'automations.builder.topics.check_sends': 'Dit stuurt de tekst van maximaal 25 voorbeeld-{unit} naar de onderwerp-classifier op deze server. Er wordt niets bewaard en er gaat niets de server uit.',
    'automations.builder.topics.checked_first': 'Gecontroleerd door de onderwerp-classifier op de eerste {n} van {total} voorbeeld-{unit}.',
    'automations.builder.topics.check_not_installed': 'Er is geen onderwerp-classifier geïnstalleerd op deze server, dus deze regels kunnen niet gecontroleerd worden.',
    'automations.builder.topics.check_failed': 'De onderwerp-classifier antwoordde niet. Probeer het zo opnieuw.',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomic across replicas (advisory lock in mutateConfig); existing values
    // win, only missing keys are added.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-topic-rules-translations applied (+${added} keys)`);
    }
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
