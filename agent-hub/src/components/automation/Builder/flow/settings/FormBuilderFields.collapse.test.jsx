import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React, { useState } from 'react';
import FormBuilderFields from './FormBuilderFields';

const form = (fields) => ({ title: 'T', description: '', submitLabel: 'Submit', successMessage: 'Thanks!', fields, theme: null });
const q = (name, label, over = {}) => ({ name, type: 'text', label, required: false, placeholder: '', ...over });

function Controlled({ initial, ...props }) {
    const [value, setValue] = useState(initial);
    return <FormBuilderFields form={value} onChange={setValue} bindingBase="trigger.output" {...props} />;
}

describe('FormBuilderFields: collapsible questions', () => {
    beforeEach(cleanup);

    it('shows one compact row per question, with its type and a required badge', () => {
        render(<Controlled initial={form([q('a', 'Alpha', { required: true }), q('b', 'Beta', { type: 'email' })])} />);
        expect(screen.queryByLabelText('Question 1 label')).toBeNull();
        expect(screen.getByText('Alpha')).toBeTruthy();
        expect(screen.getByText('Email')).toBeTruthy();
        expect(screen.getAllByTestId('required-badge')).toHaveLength(1);
        // The row actions stay reachable while collapsed.
        expect(screen.getAllByLabelText('Move question up')).toHaveLength(2);
        expect(screen.getByLabelText('Remove Alpha')).toBeTruthy();
    });

    it('expands a question when its row is clicked, and collapses it again', async () => {
        const user = userEvent.setup();
        render(<Controlled initial={form([q('a', 'Alpha')])} />);
        await user.click(screen.getByLabelText('Expand question 1'));
        expect(screen.getByLabelText('Question 1 label')).toBeTruthy();
        await user.click(screen.getByLabelText('Collapse question 1'));
        expect(screen.queryByLabelText('Question 1 label')).toBeNull();
    });

    it('opens a newly added question expanded', async () => {
        const user = userEvent.setup();
        render(<Controlled initial={form([q('a', 'Alpha')])} />);
        await user.click(screen.getByText('Add a question'));
        expect(screen.getByLabelText('Question 2 label')).toBeTruthy();
        expect(screen.queryByLabelText('Question 1 label')).toBeNull();
    });

    it('expands and collapses every question at once', async () => {
        const user = userEvent.setup();
        render(<Controlled initial={form([q('a', 'Alpha'), q('b', 'Beta')])} />);
        await user.click(screen.getByText('Expand all'));
        expect(screen.getByLabelText('Question 1 label')).toBeTruthy();
        expect(screen.getByLabelText('Question 2 label')).toBeTruthy();
        await user.click(screen.getByText('Collapse all'));
        expect(screen.queryByLabelText('Question 2 label')).toBeNull();
    });

    it('keeps the open state with the question when it moves', async () => {
        const user = userEvent.setup();
        render(<Controlled initial={form([q('a', 'Alpha'), q('b', 'Beta')])} />);
        await user.click(screen.getByLabelText('Expand question 1'));
        await user.click(screen.getAllByLabelText('Move question down')[0]);
        // Alpha is now second and still open.
        expect(screen.getByLabelText('Question 2 label')).toHaveProperty('value', 'Alpha');
        expect(screen.queryByLabelText('Question 1 label')).toBeNull();
    });
});

describe('FormBuilderFields: editor and test bar props', () => {
    beforeEach(cleanup);

    it('offers the form editor and hides the inline preview when asked', async () => {
        const user = userEvent.setup();
        const onOpenEditor = vi.fn();
        render(<FormBuilderFields form={form([])} onChange={() => {}} onOpenEditor={onOpenEditor} hidePreview />);
        await user.click(screen.getByText('Open form editor'));
        expect(onOpenEditor).toHaveBeenCalled();
        expect(screen.queryByText('Preview the form')).toBeNull();
    });

    it('swaps the trigger preview for a compact test bar when a test path exists', async () => {
        const user = userEvent.setup();
        const onTestForm = vi.fn();
        render(<FormBuilderFields form={form([q('a', 'Alpha')])} onChange={() => {}} onTestSubmit={async () => {}} onTestForm={onTestForm} />);
        expect(screen.queryByTestId('form-preview')).toBeNull();
        await user.click(screen.getByText('Test this form'));
        expect(onTestForm).toHaveBeenCalled();
    });
});

describe('FormBuilderFields: the inline test preview', () => {
    beforeEach(cleanup);

    it('still submits typed answers through onTestSubmit when there is no overlay test path', async () => {
        const user = userEvent.setup();
        const onTestSubmit = vi.fn().mockResolvedValue({});
        render(<FormBuilderFields form={form([q('name', 'Your name')])} onChange={() => {}} onTestSubmit={onTestSubmit} />);
        await user.type(screen.getByLabelText(/Your name/, { selector: 'input[type="text"]:not([aria-label])' }), 'Ada');
        await user.click(screen.getByRole('button', { name: 'Submit' }));
        expect(onTestSubmit).toHaveBeenCalled();
        expect(onTestSubmit.mock.calls[0][0]).toMatchObject({ name: 'Ada' });
    });
});
