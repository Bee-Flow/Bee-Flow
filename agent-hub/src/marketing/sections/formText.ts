import type { FormErrors } from './formBlockModel';

/**
 * The fixed wording of a website form in the page's language. Labels,
 * placeholders, the consent text and the thank-you come from the block and
 * its translation; these are the strings the block does not carry, which a
 * Dutch page used to show in English.
 */
export interface FormText {
    required: string;
    email: string;
    /** Shown on a Dutch page instead of the server's English field message. */
    checkField: string;
    consent: string;
    unavailable: string;
    error: string;
    send: string;
    form: string;
}

const TEXT: Record<'en' | 'nl', FormText> = {
    en: {
        required: 'This field is required.',
        email: 'Enter a valid email address.',
        checkField: 'Check this field.',
        consent: 'Please accept the consent statement.',
        unavailable: 'This form is not available right now.',
        error: 'Something went wrong. Please try again.',
        send: 'Send',
        form: 'Form',
    },
    nl: {
        required: 'Dit veld is verplicht.',
        email: 'Vul een geldig e-mailadres in.',
        checkField: 'Controleer dit veld.',
        consent: 'Geef toestemming om je aanvraag te versturen.',
        unavailable: 'Dit formulier is nu niet beschikbaar.',
        error: 'Er ging iets mis. Probeer het opnieuw.',
        send: 'Versturen',
        form: 'Formulier',
    },
};

/** The wording for a page locale; anything but Dutch is English, like the cookie banner. */
export function formText(locale: string | undefined): FormText {
    return locale === 'nl' ? TEXT.nl : TEXT.en;
}

/**
 * The server answers field problems in English. On a Dutch page each one is
 * replaced by the Dutch wording; the field it belongs to stays the same.
 */
export function localizeFieldErrors(errors: FormErrors, locale: string | undefined): FormErrors {
    if (locale !== 'nl') return errors;
    const text = formText(locale);
    const out: FormErrors = {};
    for (const field of Object.keys(errors)) out[field] = field === 'consent' ? text.consent : text.checkField;
    return out;
}
