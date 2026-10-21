import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PublicFormRenderer, { FormEndingView } from './PublicFormRenderer';
import type { FormFieldDef } from './PublicFormRenderer.types';

/**
 * The wizard-style questions of a public form: radio buttons, multiple choice,
 * text blocks, option hints, conditional questions, answer rules and the
 * "one question per list item" groups. All data is synthetic.
 */

const form = (fields: FormFieldDef[]) => ({
    title: 'Intake',
    description: '',
    submitLabel: 'Send',
    successMessage: 'Thanks',
    theme: {},
    fields,
});

function setup(fields: FormFieldDef[], onSubmit = vi.fn(async (_v: Record<string, unknown>) => {})) {
    const user = userEvent.setup();
    render(<PublicFormRenderer form={form(fields)} onSubmit={onSubmit} />);
    const send = () => user.click(screen.getByRole('button', { name: 'Send' }));
    return { user, onSubmit, send };
}

const SIZES = [
    { value: 'sm', label: 'Small', hint: 'Fits one person' },
    { value: 'lg', label: 'Large', hint: 'Fits a team' },
];

describe('radio', () => {
    it('submits the option VALUE, not the label, and shows each hint', async () => {
        const { user, onSubmit, send } = setup([{ name: 'size', type: 'radio', label: 'Size', required: true, options: SIZES }]);
        const group = screen.getByRole('radiogroup', { name: /Size/ });
        expect(within(group).getAllByRole('radio')).toHaveLength(2);
        expect(screen.getByText('Fits one person')).toBeTruthy();
        expect(screen.getByRole('radio', { name: /Large/ }).getAttribute('aria-describedby')).toBeTruthy();

        await user.click(screen.getByRole('radio', { name: /Large/ }));
        await send();
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit.mock.calls[0][0]).toMatchObject({ size: 'lg' });
    });

    it('blocks a required radio left unanswered, with the error tied to the group', async () => {
        const { send, onSubmit } = setup([{ name: 'size', type: 'radio', label: 'Size', required: true, options: SIZES }]);
        await send();
        expect(onSubmit).not.toHaveBeenCalled();
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toBe('Size is required.');
        const group = screen.getByRole('radiogroup');
        expect(group.getAttribute('aria-invalid')).toBe('true');
        expect(group.getAttribute('aria-describedby')).toContain(alert.id);
    });
});

describe('select', () => {
    it('keeps the option hint as the option title', () => {
        setup([{ name: 'size', type: 'select', label: 'Size', options: SIZES }]);
        expect(screen.getByRole('option', { name: 'Large' }).getAttribute('title')).toBe('Fits a team');
    });
});

describe('multiselect', () => {
    const topics: FormFieldDef = {
        name: 'topics', type: 'multiselect', label: 'Topics', minSelected: 2, maxSelected: 3,
        options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta', hint: 'The second one' }, { value: 'c', label: 'Gamma' }, { value: 'd', label: 'Delta' }],
    };

    it('says how many to choose', () => {
        setup([topics]);
        expect(screen.getByText('Choose 2 to 3')).toBeTruthy();
        expect(screen.getByText('The second one')).toBeTruthy();
    });

    it('blocks a submit that breaks min or max, inline, then sends the VALUES as an array', async () => {
        const { user, onSubmit, send } = setup([topics]);
        await user.click(screen.getByRole('checkbox', { name: /Alpha/ }));
        await send();
        expect(onSubmit).not.toHaveBeenCalled();
        expect((await screen.findByRole('alert')).textContent).toBe('Topics must have at least 2 choices.');

        await user.click(screen.getByRole('checkbox', { name: /Gamma/ }));
        await user.click(screen.getByRole('checkbox', { name: /Beta/ }));
        await user.click(screen.getByRole('checkbox', { name: /Delta/ }));
        await send();
        expect(onSubmit).not.toHaveBeenCalled();
        expect((await screen.findByRole('alert')).textContent).toBe('Topics must have at most 3 choices.');

        await user.click(screen.getByRole('checkbox', { name: /Delta/ }));
        await send();
        expect(onSubmit).toHaveBeenCalledTimes(1);
        // In the order the question lists its choices, whatever order they were ticked.
        expect(onSubmit.mock.calls[0][0]).toMatchObject({ topics: ['a', 'b', 'c'] });
    });
});

describe('info', () => {
    it('renders markdown and keeps raw HTML as text', () => {
        setup([
            { name: 'intro', type: 'info', label: 'Before you start', content: 'Read **this** first.\n\n<script>alert(1)</script><img src=x onerror=alert(2)>' },
            { name: 'x', type: 'text', label: 'Anything' },
        ]);
        expect(screen.getByText('this').tagName).toBe('STRONG');
        expect(document.querySelector('script')).toBeNull();
        expect(document.querySelector('img')).toBeNull();
        expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeTruthy();
    });

    it('is never part of the submission', async () => {
        const { send, onSubmit } = setup([{ name: 'intro', type: 'info', content: 'Hello' }, { name: 'x', type: 'text', label: 'Anything' }]);
        await send();
        expect(Object.keys(onSubmit.mock.calls[0][0]).sort()).toEqual(['website_url', 'x']);
    });

    it('also shows on the closing page', () => {
        render(<FormEndingView form={{ title: 'Done', description: '', fields: [{ name: 'next', type: 'info', label: 'What happens next', content: 'We will call you.' }] }} />);
        expect(screen.getByText('What happens next')).toBeTruthy();
        expect(screen.getByText('We will call you.')).toBeTruthy();
    });
});

describe('showIf', () => {
    const fields: FormFieldDef[] = [
        { name: 'contact', type: 'radio', label: 'Contact by', options: ['email', 'phone'] },
        { name: 'email', type: 'email', label: 'Email', required: true, showIf: 'form.contact == "email"' },
        { name: 'topics', type: 'multiselect', label: 'Topics', options: ['billing', 'other'] },
        { name: 'invoice', type: 'text', label: 'Invoice number', showIf: 'contains(form.topics, "billing")' },
    ];

    it('hides a required question until its condition holds, live', async () => {
        const { user } = setup(fields);
        expect(screen.queryByLabelText(/Email/)).toBeNull();
        await user.click(screen.getByRole('radio', { name: 'email' }));
        expect(screen.getByLabelText(/Email/)).toBeTruthy();
        await user.click(screen.getByRole('radio', { name: 'phone' }));
        expect(screen.queryByLabelText(/Email/)).toBeNull();
        await user.click(screen.getByRole('checkbox', { name: 'billing' }));
        expect(screen.getByLabelText('Invoice number')).toBeTruthy();
    });

    it('lets the submit go through without the hidden question, and leaves its stale value out of the body', async () => {
        const { user, onSubmit, send } = setup(fields);
        await user.click(screen.getByRole('radio', { name: 'email' }));
        await user.type(screen.getByLabelText(/Email/), 'a@example.test');
        await user.click(screen.getByRole('radio', { name: 'phone' }));
        await send();
        expect(onSubmit).toHaveBeenCalledTimes(1);
        const body = onSubmit.mock.calls[0][0];
        expect(body).toMatchObject({ contact: 'phone', topics: [] });
        expect(body).not.toHaveProperty('email');
        expect(body).not.toHaveProperty('invoice');
    });

    it('clears the error of a question that disappears', async () => {
        const { user, send } = setup(fields);
        await user.click(screen.getByRole('radio', { name: 'email' }));
        await send();
        expect(await screen.findByText('Email is required.')).toBeTruthy();
        await user.click(screen.getByRole('radio', { name: 'phone' }));
        await user.click(screen.getByRole('radio', { name: 'email' }));
        expect(screen.queryByText('Email is required.')).toBeNull();
    });
});

describe('answer rules', () => {
    const fields: FormFieldDef[] = [
        { name: 'code', type: 'text', label: 'Code', pattern: '[A-Z]{2}-[0-9]{3}', patternMessage: 'Use a code like AB-123.' },
        { name: 'bio', type: 'textarea', label: 'About you', minLength: 10 },
        { name: 'age', type: 'number', label: 'Age', min: 18, max: 99 },
    ];

    it('checks a pattern on blur and shows the authored message', async () => {
        const { user } = setup(fields);
        const input = screen.getByLabelText('Code');
        await user.type(input, 'ab-1');
        await user.tab();
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toBe('Use a code like AB-123.');
        expect(input.getAttribute('aria-invalid')).toBe('true');
        expect(input.getAttribute('aria-describedby')).toContain(alert.id);

        // Typing again clears it; a good value stays clean.
        await user.clear(input);
        await user.type(input, 'AB-123');
        await user.tab();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('does not shout about an empty optional question on blur', async () => {
        const { user } = setup(fields);
        await user.click(screen.getByLabelText('About you'));
        await user.tab();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('checks length and number bounds on submit and blocks it', async () => {
        const { user, onSubmit, send } = setup(fields);
        await user.type(screen.getByLabelText('About you'), 'short');
        await user.type(screen.getByLabelText('Age'), '12');
        await send();
        expect(onSubmit).not.toHaveBeenCalled();
        expect(screen.getByText('About you must be at least 10 characters.')).toBeTruthy();
        expect(screen.getByText('Age must be at least 18.')).toBeTruthy();
    });
});

describe('groups (one question per list item)', () => {
    const fields: FormFieldDef[] = [
        { name: 'rate__0', type: 'info', label: 'Rate each item', content: 'Be **honest**.', group: 'rate', groupHeader: true },
        { name: 'rate__1', type: 'radio', label: 'Item A', help: 'The first one', group: 'rate', groupKey: 'a', options: ['good', 'poor'] },
        { name: 'rate__2', type: 'radio', label: 'Item B', group: 'rate', groupKey: 'b', options: ['good', 'poor'] },
        { name: 'other__0', type: 'info', label: 'Nothing to ask', group: 'other', groupHeader: true },
    ];

    it('draws the header over its items and sends the expanded names', async () => {
        const { user, onSubmit, send } = setup(fields);
        const group = screen.getByRole('group', { name: 'Rate each item' });
        expect(within(group).getByText('honest')).toBeTruthy();
        expect(within(group).getByRole('radiogroup', { name: /Item A/ })).toBeTruthy();
        expect(within(group).getByText('The first one')).toBeTruthy();

        const itemA = within(group).getByRole('radiogroup', { name: /Item A/ });
        await user.click(within(itemA).getByRole('radio', { name: 'poor' }));
        await send();
        expect(onSubmit.mock.calls[0][0]).toMatchObject({ rate__1: 'poor', rate__2: '' });
        expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('rate__0');
    });

    it('draws no header for a list that came back empty', () => {
        setup(fields);
        expect(screen.queryByText('Nothing to ask')).toBeNull();
    });
});

describe('a list that came back empty', () => {
    it('shows a short note and does not block the submit', async () => {
        const { onSubmit, send } = setup([
            { name: 'pick', type: 'radio', label: 'Pick one', required: false, noOptions: true, options: [] },
            { name: 'many', type: 'multiselect', label: 'Pick some', required: true, noOptions: true, options: [] },
            { name: 'one', type: 'select', label: 'Pick', required: true, noOptions: true, options: [] },
        ]);
        expect(screen.getAllByText('No choices available.')).toHaveLength(3);
        await send();
        expect(onSubmit).toHaveBeenCalledTimes(1);
    });
});

describe('server errors', () => {
    it('maps a 400 with per-field messages onto the questions, expanded group names included', async () => {
        const onSubmit = vi.fn(async () => {
            throw Object.assign(new Error('Check your answers.'), {
                fields: [{ field: 'size', message: 'Size is not one of the offered choices.' }, { field: 'rate__1', message: 'Item A is required.' }],
            });
        });
        const { send } = setup([
            { name: 'size', type: 'radio', label: 'Size', options: SIZES },
            { name: 'rate__0', type: 'info', label: 'Rate', group: 'rate', groupHeader: true },
            { name: 'rate__1', type: 'radio', label: 'Item A', group: 'rate', groupKey: 'a', options: ['good'] },
        ], onSubmit);
        await send();
        expect(await screen.findByText('Size is not one of the offered choices.')).toBeTruthy();
        expect(screen.getByText('Item A is required.')).toBeTruthy();
        expect(screen.getByRole('radiogroup', { name: /Size/ }).getAttribute('aria-invalid')).toBe('true');
    });
});
