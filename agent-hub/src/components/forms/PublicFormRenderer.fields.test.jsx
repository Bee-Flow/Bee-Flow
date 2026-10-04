import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PublicFormRenderer, { initialValues } from './PublicFormRenderer';

/**
 * The ten declared field types, and what "validation" means on this form today.
 *
 * Characterisation only (FRM-0). The renderer is the SAME component on the
 * hosted page and in the builder preview, so every rule pinned here is a rule
 * the author sees while editing as well.
 *
 * The short version of today's contract: the form is `noValidate`, so the
 * browser checks nothing; the component checks REQUIREDNESS and nothing else;
 * and everything about a value's shape — is that an email, is that a number in
 * range — is the server's call, arriving back as per-field messages.
 */

const form = (fields, over = {}) => ({
    title: 'Get in touch',
    description: '',
    submitLabel: 'Send',
    successMessage: 'Thanks — we got your answer.',
    theme: {},
    fields,
    ...over,
});

const send = () => screen.getByRole('button', { name: 'Send' });

function renderForm(fields, props = {}) {
    const onSubmit = vi.fn(async () => {});
    const utils = render(<PublicFormRenderer form={form(fields)} onSubmit={onSubmit} {...props} />);
    return { ...utils, onSubmit };
}

describe('PublicFormRenderer — how each declared type renders', () => {
    it('gives text, email, number and date their own native input type', () => {
        const { container } = renderForm([
            { name: 'name', type: 'text', label: 'Your name', placeholder: 'Jane' },
            { name: 'email', type: 'email', label: 'Your email' },
            { name: 'count', type: 'number', label: 'How many' },
            { name: 'when', type: 'date', label: 'Which day' },
        ]);
        expect(container.querySelector('#ff_name').type).toBe('text');
        expect(container.querySelector('#ff_name').placeholder).toBe('Jane');
        expect(container.querySelector('#ff_email').type).toBe('email');
        expect(container.querySelector('#ff_count').type).toBe('number');
        expect(container.querySelector('#ff_when').type).toBe('date');
    });

    it('renders a type it does not know as plain short text rather than dropping the question', () => {
        // The server maps anything outside its FIELD_TYPES list to 'text'
        // before this component ever sees it; the renderer degrades the same
        // way on its own, which is what keeps the builder preview honest.
        const { container } = renderForm([{ name: 'phone', type: 'tel', label: 'Your phone' }]);
        expect(container.querySelector('#ff_phone').type).toBe('text');
    });

    it('gives long text a five-row textarea', () => {
        const { container } = renderForm([{ name: 'note', type: 'textarea', label: 'Message' }]);
        const box = container.querySelector('#ff_note');
        expect(box.tagName).toBe('TEXTAREA');
        expect(box.rows).toBe(5);
    });

    it('opens a dropdown on an empty choice, so nothing is picked for the visitor', () => {
        renderForm([{
            name: 'topic', type: 'select', label: 'Topic',
            options: [{ value: 'sales', label: 'Sales' }, { value: 'support', label: 'Support' }],
        }]);
        const select = screen.getByLabelText('Topic');
        const options = [...select.querySelectorAll('option')];
        expect(options.map(o => o.value)).toEqual(['', 'sales', 'support']);
        expect(options[0].textContent).toBe('Choose…');
        expect(select.value).toBe('');
    });

    it('lets a dropdown\'s placeholder stand in for that empty choice', () => {
        renderForm([{ name: 'topic', type: 'select', label: 'Topic', placeholder: 'Pick a subject', options: [] }]);
        expect(screen.getByLabelText('Topic').querySelector('option').textContent).toBe('Pick a subject');
    });

    it('puts a checkbox\'s label beside the box instead of above it', () => {
        renderForm([
            { name: 'agree', type: 'checkbox', label: 'I agree', required: true, help: 'Our terms' },
            { name: 'name', type: 'text', label: 'Your name' },
        ]);
        const box = screen.getByLabelText(/I agree/);
        expect(box.type).toBe('checkbox');
        expect(box.checked).toBe(false);
        // The box sits INSIDE the label that names it — that is the whole
        // difference with every other type, where `Field` puts its
        // <label htmlFor> ABOVE the control as a sibling. `getByLabelText`
        // is satisfied by either shape, so the WRAPPING is what has to be
        // asserted, and the text field below is the control that proves it.
        const wrapper = box.closest('label');
        expect(wrapper).toBeTruthy();
        expect(wrapper.getAttribute('for')).toBe('ff_agree');
        expect(wrapper.textContent).toContain('I agree');
        expect(screen.getByText('Our terms')).toBeTruthy();
        expect(screen.getByLabelText('Your name').closest('label')).toBeNull();
    });

    it('offers a file field as a labelled picker that names its own size limit', () => {
        const { container } = renderForm([{ name: 'proof', type: 'file', label: 'Proof', maxSizeMb: 5 }]);
        expect(screen.getByText('Choose a file (max 5 MB)')).toBeTruthy();
        const input = container.querySelector('input[type="file"]');
        expect(input.className).toContain('sr-only');
    });

    it('shows the help line under a short-text question', () => {
        renderForm([{ name: 'name', type: 'text', label: 'Your name', help: 'As it appears on the invoice' }]);
        expect(screen.getByText('As it appears on the invoice')).toBeTruthy();
    });

    it('marks a required question with an asterisk that screen readers skip', () => {
        const { container } = renderForm([{ name: 'name', type: 'text', label: 'Your name', required: true }]);
        const star = container.querySelector('label[for="ff_name"] span[aria-hidden="true"]');
        expect(star.textContent.trim()).toBe('*');
    });

    it('carries a hidden honeypot that no visitor can reach', () => {
        const { container } = renderForm([{ name: 'name', type: 'text', label: 'Your name' }]);
        const pot = container.querySelector('#website_url');
        expect(pot.tabIndex).toBe(-1);
        expect(pot.closest('[aria-hidden="true"]')).toBeTruthy();
    });
});

describe('PublicFormRenderer — what counts as an answer', () => {
    it('blocks the submission and names every empty required question at once', async () => {
        const { onSubmit } = renderForm([
            { name: 'name', type: 'text', label: 'Your name', required: true },
            { name: 'email', type: 'email', label: 'Your email', required: true },
            { name: 'note', type: 'textarea', label: 'Message', required: false },
        ]);
        fireEvent.click(send());

        expect(await screen.findByText('Your name is required.')).toBeTruthy();
        expect(screen.getByText('Your email is required.')).toBeTruthy();
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('treats spaces as nothing at all', async () => {
        const { onSubmit } = renderForm([{ name: 'name', type: 'text', label: 'Your name', required: true }]);
        fireEvent.change(screen.getByLabelText(/Your name/), { target: { value: '   ' } });
        fireEvent.click(send());
        expect(await screen.findByText('Your name is required.')).toBeTruthy();
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('accepts a zero as an answer to a required number', async () => {
        const { onSubmit } = renderForm([{ name: 'count', type: 'number', label: 'How many', required: true }]);
        fireEvent.change(screen.getByLabelText(/How many/), { target: { value: '0' } });
        fireEvent.click(send());
        await waitFor(() => expect(onSubmit).toHaveBeenCalled());
        expect(onSubmit.mock.calls[0][0].count).toBe('0');
    });

    it('a required checkbox has to be ticked, not merely touched', async () => {
        const { onSubmit } = renderForm([{ name: 'agree', type: 'checkbox', label: 'I agree', required: true }]);
        fireEvent.click(send());
        expect(await screen.findByText('I agree is required.')).toBeTruthy();

        fireEvent.click(screen.getByLabelText(/I agree/));
        fireEvent.click(send());
        await waitFor(() => expect(onSubmit).toHaveBeenCalled());
        expect(onSubmit.mock.calls[0][0].agree).toBe(true);
    });

    it('a required file needs an uploaded descriptor, not a picked file', async () => {
        const { onSubmit } = renderForm([{ name: 'proof', type: 'file', label: 'Proof', required: true, maxSizeMb: 5 }]);
        fireEvent.click(send());
        expect(await screen.findByText('Proof is required.')).toBeTruthy();
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('lets a badly-shaped answer through — the server, not the form, decides what is valid', async () => {
        // `noValidate` is on the form, so the browser's own email check never
        // runs either. wart: the visitor learns "that is not an email" only
        // after a round trip; a stage that wants inline format checking has to
        // add it here first.
        const { onSubmit, container } = renderForm([
            { name: 'email', type: 'email', label: 'Your email', required: true },
        ]);
        expect(container.querySelector('form').noValidate).toBe(true);
        fireEvent.change(screen.getByLabelText(/Your email/), { target: { value: 'nope' } });
        fireEvent.click(send());
        await waitFor(() => expect(onSubmit).toHaveBeenCalled());
        expect(onSubmit.mock.calls[0][0].email).toBe('nope');
    });

    it('clears a question\'s error the moment it is answered, without re-submitting', async () => {
        renderForm([{ name: 'name', type: 'text', label: 'Your name', required: true }]);
        fireEvent.click(send());
        await screen.findByText('Your name is required.');

        fireEvent.change(screen.getByLabelText(/Your name/), { target: { value: 'Jane' } });
        expect(screen.queryByText('Your name is required.')).toBeNull();
    });
});

describe('PublicFormRenderer — sending it', () => {
    const one = [{ name: 'name', type: 'text', label: 'Your name' }];

    it('sends every declared key plus the empty honeypot', async () => {
        const { onSubmit } = renderForm([
            ...one,
            { name: 'agree', type: 'checkbox', label: 'I agree' },
            { name: 'proof', type: 'file', label: 'Proof', maxSizeMb: 5 },
        ]);
        fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Jane' } });
        fireEvent.click(send());

        await waitFor(() => expect(onSubmit).toHaveBeenCalled());
        expect(onSubmit.mock.calls[0][0]).toEqual({
            name: 'Jane', agree: false, proof: null, website_url: '',
        });
    });

    it('disables the button while the submission is in flight, so a double click sends once', async () => {
        let release;
        const onSubmit = vi.fn(() => new Promise((resolve) => { release = resolve; }));
        render(<PublicFormRenderer form={form(one)} onSubmit={onSubmit} />);

        fireEvent.click(send());
        await waitFor(() => expect(send().disabled).toBe(true));
        fireEvent.click(send());
        expect(onSubmit).toHaveBeenCalledTimes(1);

        release();
        await waitFor(() => expect(screen.getByText('Thanks — we got your answer.')).toBeTruthy());
    });

    it('replaces the form with the thank-you message when it owns the ending', async () => {
        renderForm(one);
        fireEvent.click(send());
        expect(await screen.findByText('Thanks — we got your answer.')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    });

    it('leaves the form standing when the page that polls owns the ending', async () => {
        const { onSubmit } = renderForm(one, { showSuccess: false });
        fireEvent.click(send());
        await waitFor(() => expect(onSubmit).toHaveBeenCalled());
        expect(screen.queryByText('Thanks — we got your answer.')).toBeNull();
        expect(send()).toBeTruthy();
    });

    it('spreads a rejection\'s per-field messages over the questions they belong to', async () => {
        const err = new Error('Some answers need attention');
        err.fields = [{ field: 'name', message: 'That name is too short.' }];
        const onSubmit = vi.fn(async () => { throw err; });
        render(<PublicFormRenderer form={form(one)} onSubmit={onSubmit} />);

        fireEvent.click(send());
        expect(await screen.findByText('That name is too short.')).toBeTruthy();
        // The form-level line stays away when the fields carry the story.
        expect(screen.queryByText('Some answers need attention')).toBeNull();
        expect(send().disabled).toBe(false);
    });

    it('shows a rejection with no field detail once, above the button', async () => {
        const onSubmit = vi.fn(async () => { throw new Error('The automation is not accepting answers.'); });
        render(<PublicFormRenderer form={form(one)} onSubmit={onSubmit} />);
        fireEvent.click(send());
        expect(await screen.findByRole('alert')).toHaveTextContent('The automation is not accepting answers.');
    });

    it('sends an empty form as an empty answer set — a declaration with no questions is draft-legal', async () => {
        const { onSubmit } = renderForm([]);
        expect(screen.getByText('Get in touch')).toBeTruthy();
        fireEvent.click(send());
        await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ website_url: '' }));
    });

    it('keeps the page\'s display fields on the thank-you card, with nothing behind them', async () => {
        // wart: the success card is built from the SAME declaration
        // (`{ ...form, title: successMessage }`), so a download declared on a
        // question page comes back on the thank-you — and FormEndingView is
        // handed no href there, so it is the inert "unavailable" card. Nothing
        // is broken, but the visitor is shown a dead button as their last
        // impression of the form.
        renderForm([
            { name: 'name', type: 'text', label: 'Your name' },
            { name: 'doc', type: 'download', label: 'Your copy', filename: 'copy.pdf', size: 1024 },
        ]);
        fireEvent.click(send());

        await screen.findByText('Thanks — we got your answer.');
        const card = screen.getByTestId('form-download-doc');
        expect(card.querySelector('a')).toBeNull();
        expect(card.querySelector('[aria-disabled="true"]')).toBeTruthy();
    });

    it('is inert in the builder preview — no submission, no network, nothing disabled-looking to click', async () => {
        const onSubmit = vi.fn();
        render(<PublicFormRenderer form={form(one)} onSubmit={onSubmit} preview />);
        expect(send().disabled).toBe(true);
        fireEvent.click(send());
        expect(onSubmit).not.toHaveBeenCalled();
    });
});

describe('PublicFormRenderer — a file rides as a descriptor, never as bytes', () => {
    const fileField = (over = {}) => [{ name: 'proof', type: 'file', label: 'Proof', maxSizeMb: 5, ...over }];
    const pick = (container, file) => fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });
    const pdf = (bytes = 3) => new File(['x'.repeat(bytes)], 'p.pdf', { type: 'application/pdf' });

    it('uploads on pick and keeps only what the submission needs', async () => {
        const onUpload = vi.fn(async () => ({ fileId: 'up_1', filename: 'p.pdf', size: 3 }));
        const onSubmit = vi.fn(async () => {});
        const { container } = render(
            <PublicFormRenderer form={form(fileField())} onSubmit={onSubmit} onUpload={onUpload} />,
        );

        pick(container, pdf());
        expect(await screen.findByText('p.pdf')).toBeTruthy();
        expect(onUpload.mock.calls[0][1]).toBe('proof');

        fireEvent.click(send());
        await waitFor(() => expect(onSubmit).toHaveBeenCalled());
        expect(onSubmit.mock.calls[0][0].proof).toEqual({
            kind: 'form_upload', fileId: 'up_1', filename: 'p.pdf', size: 3,
        });
    });

    it('refuses a file over the declared limit before any byte leaves the browser', async () => {
        const onUpload = vi.fn();
        const { container } = render(
            <PublicFormRenderer form={form(fileField({ maxSizeMb: 1 }))} onSubmit={vi.fn()} onUpload={onUpload} />,
        );
        pick(container, pdf(2 * 1024 * 1024));
        expect(await screen.findByText('That file is larger than 1 MB.')).toBeTruthy();
        expect(onUpload).not.toHaveBeenCalled();
    });

    it('applies no limit at all when the declaration forgot one', async () => {
        // wart: `file.size > undefined * 1024 * 1024` is NaN-false, so the cap
        // silently disappears and the picker reads "max undefined MB". Only the
        // server's normalizeFields keeps this off the hosted page today — a
        // caller that renders a raw declaration (a preview, a future editor)
        // gets neither the number nor the check.
        const onUpload = vi.fn(async () => ({ fileId: 'up_1', filename: 'p.pdf', size: 99 }));
        const { container } = render(
            <PublicFormRenderer form={form([{ name: 'proof', type: 'file', label: 'Proof' }])} onSubmit={vi.fn()} onUpload={onUpload} />,
        );
        expect(screen.getByText('Choose a file (max undefined MB)')).toBeTruthy();
        pick(container, pdf(50 * 1024 * 1024));
        await waitFor(() => expect(onUpload).toHaveBeenCalled());
    });

    it('says why an upload failed and lets the same file be picked again', async () => {
        const onUpload = vi.fn(async () => { throw new Error('Upload failed'); });
        const { container } = render(
            <PublicFormRenderer form={form(fileField())} onSubmit={vi.fn()} onUpload={onUpload} />,
        );
        pick(container, pdf());
        expect(await screen.findByText('Upload failed')).toBeTruthy();
        // The input clears itself, so re-picking the same file still fires.
        expect(container.querySelector('input[type="file"]').value).toBe('');
    });

    it('lets an attached file be taken off again', async () => {
        const onUpload = vi.fn(async () => ({ fileId: 'up_1', filename: 'p.pdf', size: 3 }));
        const { container } = render(
            <PublicFormRenderer form={form(fileField())} onSubmit={vi.fn()} onUpload={onUpload} />,
        );
        pick(container, pdf());
        fireEvent.click(await screen.findByRole('button', { name: 'Remove p.pdf' }));
        expect(screen.getByText('Choose a file (max 5 MB)')).toBeTruthy();
    });
});

describe('initialValues — the shape a submission has before anyone types', () => {
    it('gives every collecting field its empty value, by type', () => {
        expect(initialValues([
            { name: 'name', type: 'text' },
            { name: 'agree', type: 'checkbox' },
            { name: 'proof', type: 'file' },
            { name: 'note', type: 'textarea' },
        ])).toEqual({ name: '', agree: false, proof: null, note: '' });
    });

    it('leaves out the fields that give instead of ask', () => {
        expect(initialValues([
            { name: 'name', type: 'text' },
            { name: 'doc', type: 'download' },
            { name: 'nb', type: 'notebook' },
        ])).toEqual({ name: '' });
    });

    it('answers with an empty object for anything that is not a field list', () => {
        expect(initialValues(null)).toEqual({});
        expect(initialValues(undefined)).toEqual({});
    });
});
