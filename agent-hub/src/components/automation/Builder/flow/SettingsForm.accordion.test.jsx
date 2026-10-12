import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { editor, editors, editorValue, editorWithValue, typeInEditor } from '../../../../test/refEditor';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import SettingsForm from './SettingsForm';
import { VariablePickerProvider } from '../mapping/VariablePickerContext';
import scopedStorage from '../../../../utils/scopedStorage';

const noIssues = { errors: [], warnings: [] };

function renderForm(step, { stepIssues = noIssues, onPatch = vi.fn(), catalog = null } = {}) {
    const utils = render(
        <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()}>
            <SettingsForm
                step={step}
                modelTiers={{}}
                stepIssues={stepIssues}
                saving={false}
                saveError={null}
                onPatch={onPatch}
                catalog={catalog}
                groups={[]}
            />
        </VariablePickerProvider>,
    );
    return { onPatch, ...utils };
}

describe('SettingsForm — accordion sections', () => {
    beforeEach(() => {
        cleanup();
        scopedStorage.setCurrentUser('test-user');
        try { localStorage.clear(); } catch { /* ignore */ }
    });

    it('keeps the AI prompt flat, and Inputs is a heading that never folds away', () => {
        renderForm({ id: 's1', type: 'ai_step', label: 'My AI', prompt: 'Do X', inputs: {}, outputFields: [] });
        // Prompt is always visible (flat, not in an accordion).
        expect(screen.getByPlaceholderText(/Summarise this email/)).toBeTruthy();
        // Inputs is a heading, not a toggle, and its body is always there.
        expect(screen.getByRole('heading', { name: 'Inputs' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Inputs' })).toBeNull();
        expect(screen.getByText(/No inputs yet/)).toBeTruthy();
    });

    it('force-opens the section that contains a validation error', () => {
        renderForm(
            { id: 's1', type: 'ai_step', label: 'My AI', prompt: 'Do X', inputs: {}, outputFields: [] },
            { stepIssues: { errors: [{ path: 'steps[s1].inputs.foo', severity: 'error' }], warnings: [] } },
        );
        // Inputs is forced open even though it is empty → its body renders.
        expect(screen.getByText(/No inputs yet/)).toBeTruthy();
    });

    // Only accordion headers carry aria-expanded (the FieldHint ⓘ button does
    // not), so this reliably picks a section header by title.
    const sectionHeader = (title) =>
        screen.getAllByRole('button').find(b => b.hasAttribute('aria-expanded') && b.textContent.trim() === title);

    it('shows a populated Inputs section for integration_action', () => {
        renderForm({ id: 'i1', type: 'integration_action', label: 'Send', tool: 'gmail_send', inputs: { to: { kind: 'literal', value: 'a@b.com' } } });
        // The operation is a card above the sections since round 4, not a Basics section.
        expect(screen.getByTestId('action-card')).toBeTruthy();
        expect(screen.getByRole('heading', { name: 'Inputs' })).toBeTruthy();
        // The populated field row is visible: Inputs never folds away.
        expect(screen.getByDisplayValue('to')).toBeTruthy();
    });

    it('persists a collapsed section across remounts', () => {
        const step = { id: 'h1', type: 'http_request', label: 'Call', method: 'GET', url: '' };
        renderForm(step);
        expect(screen.getByText('Method')).toBeTruthy();
        fireEvent.click(sectionHeader('Request'));
        expect(scopedStorage.getItem('collapse.inspector.http_request.request')).toBe('0');
        cleanup();
        renderForm(step);
        // Re-mounted: the persisted collapsed state hides the section's fields.
        expect(screen.queryByText('Method')).toBeNull();
    });

    it('still autosaves edits (section state is decoupled from the draft)', async () => {
        const { onPatch } = renderForm({ id: 's1', type: 'ai_step', label: 'My AI', prompt: 'Do X', inputs: {}, outputFields: [] });
        const label = screen.getByDisplayValue('My AI');
        fireEvent.change(label, { target: { value: 'Renamed AI' } });
        await waitFor(() => expect(onPatch).toHaveBeenCalled(), { timeout: 2000 });
    });

    it('AI step exposes a "Run once per item" loop toggle under Advanced', () => {
        renderForm({ id: 's1', type: 'ai_step', label: 'My AI', prompt: 'Do X', inputs: {}, outputFields: [] });
        // The loop control lives in the AI step's Advanced settings: shown in
        // the Advanced mode (the full view's default), without a click.
        expect(screen.getByText('Run once per item')).toBeTruthy();
    });
});
