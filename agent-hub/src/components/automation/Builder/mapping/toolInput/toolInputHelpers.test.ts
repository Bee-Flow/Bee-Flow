// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { paramLabel } from './toolInputHelpers';

describe('paramLabel — a parameter in words', () => {
    it('uses the title, else a short description, else the key made readable', () => {
        expect(paramLabel('to', { type: 'string', title: 'Recipient' })).toBe('Recipient');
        expect(paramLabel('cc', { type: 'array', description: 'Extra recipients' })).toBe('Extra recipients');
        expect(paramLabel('subject', { type: 'string', description: 'subject line.' })).toBe('Subject line');
        expect(paramLabel('to', { type: 'string' })).toBe('To');
        expect(paramLabel('body_html', undefined)).toBe('Body HTML');
    });

    it('a description that is a sentence is a hint, not a name', () => {
        expect(paramLabel('to', { description: 'Who gets the e-mail. Separate several with commas.' })).toBe('To');
        expect(paramLabel('priority', { description: 'Priority (1 is highest, 5 is lowest)' })).toBe('Priority');
    });
});
