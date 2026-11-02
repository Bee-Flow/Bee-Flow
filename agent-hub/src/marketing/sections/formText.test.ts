/**
 * A website form on a Dutch page speaks Dutch in the parts the block does not
 * carry: required-field and e-mail messages, the error and unavailable notes,
 * the button fallback, and the field problems the server reports in English.
 *
 * Run: cd agent-hub && npx vitest run src/marketing/sections/formText.test.ts
 */
import { describe, it, expect } from 'vitest';
import { formText, localizeFieldErrors } from './formText';

describe('formText', () => {
    it('gives Dutch on a Dutch page', () => {
        expect(formText('nl').required).toBe('Dit veld is verplicht.');
        expect(formText('nl').send).toBe('Versturen');
    });

    it('falls back to English for every other language', () => {
        expect(formText('en').required).toBe('This field is required.');
        expect(formText('de').unavailable).toBe('This form is not available right now.');
        expect(formText(undefined).send).toBe('Send');
    });
});

describe('localizeFieldErrors', () => {
    const server = { email: 'Must be an email address.', consent: 'Please accept the consent statement.' };

    it('keeps the server wording on an English page', () => {
        expect(localizeFieldErrors(server, 'en')).toEqual(server);
    });

    it('replaces it on a Dutch page, field by field', () => {
        expect(localizeFieldErrors(server, 'nl')).toEqual({
            email: 'Controleer dit veld.',
            consent: 'Geef toestemming om je aanvraag te versturen.',
        });
    });
});
