#!/usr/bin/env node
// @typecheck noImplicitAny
/**
 * Dutch for the checks a filled-in form shows: "required", the choice
 * placeholders and limits, the per-question rule messages (minimum, maximum,
 * dates, length, format, number of choices) and the "usually takes" line.
 *
 * Terminology follows add-nl-forms-answers-translations: a form is a
 * "formulier", a question a "vraag"; the messages start with the question's
 * label, so they read as a sentence about that question.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-forms-validation-translations.js
 */

const NL_TRANSLATIONS = {
    'forms.required': '{label} is verplicht.',
    'forms.choose': 'Kies…',
    'forms.no_options': 'Geen keuzes beschikbaar.',
    'forms.choose_up_to': 'Kies maximaal {n}',
    'forms.choose_at_least': 'Kies minimaal {n}',
    'forms.choose_exactly': 'Kies precies {n}',
    'forms.choose_between': 'Kies {min} tot {max}',
    'forms.rule.min': '{label} moet minimaal {n} zijn.',
    'forms.rule.max': '{label} mag maximaal {n} zijn.',
    'forms.rule.date_min': '{label} moet op of na {date} liggen.',
    'forms.rule.date_max': '{label} moet op of voor {date} liggen.',
    'forms.rule.min_length': '{label} moet minimaal {n} tekens bevatten.',
    'forms.rule.max_length': '{label} mag maximaal {n} tekens bevatten.',
    'forms.rule.pattern': '{label} heeft niet het verwachte formaat.',
    'forms.rule.min_selected_one': '{label} moet minimaal 1 keuze hebben.',
    'forms.rule.min_selected': '{label} moet minimaal {n} keuzes hebben.',
    'forms.rule.max_selected_one': '{label} mag maximaal 1 keuze hebben.',
    'forms.rule.max_selected': '{label} mag maximaal {n} keuzes hebben.',
    'forms.typical.under_minute': 'Duurt meestal minder dan een minuut',
    'forms.typical.minute': 'Duurt meestal ongeveer 1 minuut',
    'forms.typical.minutes': 'Duurt meestal ongeveer {n} minuten',
    'forms.typical.hour': 'Duurt meestal ongeveer 1 uur',
    'forms.typical.hours': 'Duurt meestal ongeveer {n} uur',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-forms-validation-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS };
