import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PublicFormRenderer from './PublicFormRenderer';
import { valuesWithPrefill } from './prefill';
import type { FormDef, FormFieldDef } from './PublicFormRenderer.types';

const field = (over: Partial<FormFieldDef> & { name: string; type: string }): FormFieldDef => ({
    label: over.name, required: false, placeholder: '', help: '', ...over,
} as FormFieldDef);

const FIELDS: FormFieldDef[] = [
    field({ name: 'city', type: 'text', label: 'City' }),
    field({ name: 'note', type: 'text', label: 'Note' }),
    field({ name: 'agree', type: 'checkbox', label: 'Agree' }),
    field({ name: 'tags', type: 'multiselect', label: 'Tags', options: ['a', 'b', 'c'] } as Partial<FormFieldDef> & { name: string; type: string }),
    field({ name: 'cv', type: 'file', label: 'CV' }),
    field({ name: 'about', type: 'info', label: 'About' }),
];
const FORM = { title: 'Request', description: '', submitLabel: 'Send', successMessage: 'Thanks', theme: {}, fields: FIELDS } as unknown as FormDef;

afterEach(() => cleanup());

describe('valuesWithPrefill', () => {
    it('fills declared, collecting questions only', () => {
        const v = valuesWithPrefill(FIELDS, { city: 'Utrecht', unknown: 'x', about: 'y', agree: true, tags: ['a', 3], cv: 'file.pdf' });
        expect(v).toEqual({ city: 'Utrecht', note: '', agree: true, tags: ['a'], cv: null });
        expect('unknown' in v).toBe(false);
        expect('about' in v).toBe(false);
    });

    it('turns numbers into text and ignores answers of the wrong kind', () => {
        const v = valuesWithPrefill(FIELDS, { city: 12, note: { nested: true }, agree: 'maybe', tags: 'a' });
        expect(v).toMatchObject({ city: '12', note: '', agree: false, tags: [] });
    });

    it('starts empty without a prefill', () => {
        expect(valuesWithPrefill(FIELDS, null)).toEqual({ city: '', note: '', agree: false, tags: [], cv: null });
    });
});

describe('PublicFormRenderer prefill', () => {
    const city = () => (screen.getByLabelText('City') as HTMLInputElement).value;
    const note = () => (screen.getByLabelText('Note') as HTMLInputElement).value;

    it('shows the saved answers from the first render', () => {
        render(<PublicFormRenderer form={FORM} prefill={{ city: 'Utrecht', note: 'Call me' }} showSuccess={false} />);
        expect(city()).toBe('Utrecht');
        expect(note()).toBe('Call me');
    });

    it('fills again when a new set arrives, and clears what the new set does not answer', () => {
        const { rerender } = render(<PublicFormRenderer form={FORM} prefill={{ city: 'Utrecht', note: 'Call me' }} showSuccess={false} />);
        rerender(<PublicFormRenderer form={FORM} prefill={{ city: 'Leiden' }} showSuccess={false} />);
        expect(city()).toBe('Leiden');
        expect(note()).toBe('');
        rerender(<PublicFormRenderer form={FORM} prefill={null} showSuccess={false} />);
        expect(city()).toBe('');
    });

    it('leaves what was typed alone when the same set is passed again', async () => {
        const user = userEvent.setup();
        const set = { city: 'Utrecht' };
        const { rerender } = render(<PublicFormRenderer form={FORM} prefill={set} showSuccess={false} />);
        await user.type(screen.getByLabelText('City'), ' Centre');
        rerender(<PublicFormRenderer form={FORM} prefill={set} showSuccess={false} />);
        expect(city()).toBe('Utrecht Centre');
    });
});
