import { describe, expect, it } from 'vitest';
import { answerableFields, describeFormPage, formFieldSample } from './formAnswers';
import type { UpstreamNode } from './upstream.types';

describe('formFieldSample', () => {
    it('answers a radio question with the first choice value', () => {
        expect(formFieldSample({ name: 'c', type: 'radio', options: [{ value: 'email', label: 'By email' }, 'phone'] })).toBe('email');
        expect(formFieldSample({ name: 'c', type: 'radio', options: ['a', 'b'] })).toBe('a');
    });

    it('answers a several-choices question with a list holding the first value', () => {
        expect(formFieldSample({ name: 't', type: 'multiselect', options: ['billing', 'other'] })).toEqual(['billing']);
        // Choices that come from a list on an earlier step are not known yet.
        expect(formFieldSample({ name: 't', type: 'multiselect', optionsFrom: { ref: 'steps.a.output.rows' } })).toEqual(['choice_1']);
    });

    it('answers a question asked once per item with a list of key / label / answer', () => {
        expect(formFieldSample({ name: 'rate', type: 'number', fieldsFrom: { ref: 'steps.a.output.rows' } }))
            .toEqual([{ key: 'item_1', label: 'Item 1', answer: 42 }]);
        expect(formFieldSample({ name: 'ok', type: 'checkbox', fieldsFrom: { ref: 'steps.a.output.rows' } }))
            .toEqual([{ key: 'item_1', label: 'Item 1', answer: true }]);
    });

    it('keeps the samples of the older types', () => {
        expect(formFieldSample({ name: 'e', type: 'email' })).toBe('visitor@example.com');
        expect(formFieldSample({ name: 'n', type: 'number' })).toBe(42);
        expect(formFieldSample({ name: 't', type: 'text', label: 'Your name' })).toBe('Your name');
    });
});

describe('answerableFields', () => {
    it('leaves out the display fields: they give instead of ask', () => {
        const names = answerableFields({ fields: [
            { name: 'note', type: 'info' }, { name: 'doc', type: 'download' }, { name: 'nb', type: 'notebook' }, { name: 'q', type: 'text' }, { type: 'text' } as never,
        ] }).map(f => f.name);
        expect(names).toEqual(['q']);
    });
});

describe('describeFormPage', () => {
    it('describes the answers by name, including the new shapes, and nothing for a text block', () => {
        const node = {
            id: 'p1', mode: 'input', label: 'Details',
            form: { fields: [
                { name: 'intro', type: 'info' },
                { name: 'contact', type: 'radio', options: ['email', 'phone'] },
                { name: 'topics', type: 'multiselect', options: ['billing'] },
                { name: 'rate', type: 'number', fieldsFrom: { ref: 'steps.a.output.rows' } },
            ] },
        } as UpstreamNode;
        const group = describeFormPage(node);
        expect(group?.basePath).toBe('steps.p1.output');
        expect(group?.sample).toEqual({ contact: 'email', topics: ['billing'], rate: [{ key: 'item_1', label: 'Item 1', answer: 42 }] });
        expect(group?.fields.map(f => f.path)).toEqual(['steps.p1.output.contact', 'steps.p1.output.topics', 'steps.p1.output.rate']);
    });

    it('has nothing to bind on a closing page', () => {
        expect(describeFormPage({ id: 'e', mode: 'ending', form: { fields: [] } } as UpstreamNode)).toBeNull();
    });
});
