import { render, screen, cleanup, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import FormEditorModal from './FormEditorModal';
import type { FormPageEntry } from './formPages';

const f = (title: string, label: string) => ({ title, description: '', submitLabel: 'Go', successMessage: 'Ok', theme: null, fields: [{ name: 'q', type: 'text', label, required: false, placeholder: '' }] });

const pages: FormPageEntry[] = [
    { id: 't', kind: 'trigger', label: 'Start page', form: f('Start page', 'First question'), bindingBase: 'trigger.output', allowVariables: false },
    { id: 'p2', kind: 'page', label: 'Details', form: f('Details', 'Second question'), bindingBase: 'steps.p2.output', allowVariables: true },
    { id: 'e', kind: 'ending', label: 'Bye', form: { title: 'Bye', description: 'See you', fields: [], theme: null }, bindingBase: 'steps.e.output', allowVariables: true },
];

describe('FormEditorModal', () => {
    beforeEach(() => { cleanup(); vi.useRealTimers(); });
    afterEach(() => vi.useRealTimers());

    it('lists every page in order and marks the closing page', () => {
        render(<FormEditorModal pages={pages} currentId="t" onChangePage={() => {}} onClose={() => {}} />);
        const dialog = screen.getByRole('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        const nav = within(screen.getByRole('navigation', { name: 'Form pages' }));
        expect(nav.getByText('1. Start page')).toBeTruthy();
        expect(nav.getByText('2. Details')).toBeTruthy();
        expect(nav.getByText('3. Bye')).toBeTruthy();
        expect(nav.getByText('Closing page')).toBeTruthy();
    });

    it('edits the page it was opened from first, and switches pages on click', async () => {
        const user = userEvent.setup();
        render(<FormEditorModal pages={pages} currentId="t" onChangePage={() => {}} onClose={() => {}} />);
        const middle = () => within(screen.getByTestId('form-editor-middle'));
        expect(middle().getByText('First question')).toBeTruthy();
        await user.click(screen.getByTestId('form-editor-page-p2'));
        expect(middle().getByText('Second question')).toBeTruthy();
        expect(middle().queryByText('First question')).toBeNull();
        // The inline preview of the side panel is replaced by the sticky one.
        expect(screen.queryByText('Preview the form')).toBeNull();
        expect(screen.getByTestId('form-editor-preview')).toBeTruthy();
    });

    it('hands an edit to onChangePage with the page id and the whole next form', async () => {
        const user = userEvent.setup();
        const onChangePage = vi.fn();
        render(<FormEditorModal pages={pages} currentId="t" onChangePage={onChangePage} onClose={() => {}} />);
        await user.click(screen.getByTestId('form-editor-page-p2'));
        await user.click(screen.getByLabelText('Remove Second question'));
        // Held briefly so a burst of typing is one save; closing flushes it too.
        await act(async () => { await new Promise(r => setTimeout(r, 650)); });
        expect(onChangePage).toHaveBeenCalledTimes(1);
        const [id, next] = onChangePage.mock.calls[0];
        expect(id).toBe('p2');
        expect(next.fields).toEqual([]);
        expect(next.title).toBe('Details');
    });

    it('flushes a pending edit when it closes', async () => {
        const user = userEvent.setup();
        const onChangePage = vi.fn();
        const onClose = vi.fn();
        render(<FormEditorModal pages={pages} currentId="t" onChangePage={onChangePage} onClose={onClose} />);
        await user.click(screen.getByLabelText('Remove First question'));
        await user.click(screen.getByLabelText('Close form editor'));
        expect(onChangePage).toHaveBeenCalledWith('t', expect.objectContaining({ fields: [] }));
        expect(onClose).toHaveBeenCalled();
    });

    it('closes on Escape', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(<FormEditorModal pages={pages} currentId="t" onChangePage={() => {}} onClose={onClose} />);
        await user.keyboard('{Escape}');
        expect(onClose).toHaveBeenCalled();
    });

    it('toggles the preview between desktop and mobile width', async () => {
        const user = userEvent.setup();
        render(<FormEditorModal pages={pages} currentId="t" onChangePage={() => {}} onClose={() => {}} />);
        expect(screen.getByTestId('form-editor-preview').getAttribute('data-device')).toBe('desktop');
        await user.click(screen.getByLabelText('Mobile'));
        expect(screen.getByTestId('form-editor-preview').getAttribute('data-device')).toBe('mobile');
    });

    it('a later page previews in the first page\'s style, its own keys on top, on the theme\'s page ground', async () => {
        const user = userEvent.setup();
        const styled: FormPageEntry[] = [
            { ...pages[0], form: { ...pages[0].form, theme: { primary: '#0F766E', canvas: '#fef3c7' }, style: { font: 'serif', width: 'wide' } } },
            { ...pages[1], form: { ...pages[1].form, style: { width: 'narrow' } } },
            pages[2],
        ];
        render(<FormEditorModal pages={styled} currentId="t" onChangePage={() => {}} onClose={() => {}} />);
        await user.click(screen.getByTestId('form-editor-page-p2'));
        const preview = screen.getByTestId('form-editor-preview');
        const root = preview.querySelector('form') as HTMLFormElement;
        expect(root.style.getPropertyValue('--bf-font')).toMatch(/serif/);
        expect(root.style.getPropertyValue('--bf-form-width')).toBe('480px');
        expect(preview.style.getPropertyValue('--app-canvas')).toBe('#fef3c7');
    });
});
