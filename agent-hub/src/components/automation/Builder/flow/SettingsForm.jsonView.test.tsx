import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import SettingsForm from './SettingsForm';
import scopedStorage from '@/utils/scopedStorage';
import { VariablePickerProvider } from '../mapping/VariablePickerContext';
import type { ComponentProps } from 'react';

const noIssues = { errors: [], warnings: [] };

/**
 * BFSF-481 — "Advanced options are available in the JSON view" used to be
 * dead text; the JSON view it named did not exist. Now the sentence IS the
 * control, and the view edits the same draft the form edits.
 */
function renderForm(step: ComponentProps<typeof SettingsForm>['step'], { onPatch = vi.fn() } = {}) {
    const utils = render(
        <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()}>
            <SettingsForm step={step} modelTiers={{}} stepIssues={noIssues} saving={false} saveError={null} onPatch={onPatch} catalog={null} groups={[]} />
        </VariablePickerProvider>,
    );
    return { onPatch, ...utils };
}

const waitStep = () => ({ id: 'w1', type: 'wait', label: 'Hold on', seconds: 60 });

describe('SettingsForm — JSON view of the step config (BFSF-481)', () => {
    beforeEach(() => {
        cleanup();
        scopedStorage.setCurrentUser('json-view-test-user');
        try { localStorage.clear(); } catch {}
    });

    it('the advanced-options text is a working toggle that opens a JSON editor of the draft', async () => {
        const user = userEvent.setup();
        renderForm(waitStep());
        const toggle = screen.getByTestId('settings-json-toggle');
        expect(toggle.textContent).toBe('Edit as JSON');
        await user.click(toggle);
        const box = screen.getByLabelText('Step config as JSON');
        expect(JSON.parse((box as HTMLInputElement).value)).toMatchObject({ label: 'Hold on', seconds: 60 });
        // And it closes again.
        await user.click(screen.getByText('Back to the form'));
        expect(screen.queryByLabelText('Step config as JSON')).toBeNull();
    });

    it('an Apply lands the edit in the same save path as a form edit', async () => {
        const user = userEvent.setup();
        const { onPatch } = renderForm(waitStep());
        await user.click(screen.getByTestId('settings-json-toggle'));
        fireEvent.change(screen.getByLabelText('Step config as JSON'), {
            target: { value: JSON.stringify({ label: 'Hold longer', seconds: 300 }) },
        });
        await user.click(screen.getByText('Apply JSON'));
        // The editor closed and the form reflects the new draft.
        expect(screen.queryByLabelText('Step config as JSON')).toBeNull();
        expect((screen.getByLabelText('Step name') as HTMLInputElement).value).toBe('Hold longer');
        await user.click(screen.getByText('Save'));
        expect(onPatch).toHaveBeenCalledTimes(1);
        expect(onPatch.mock.calls[0][0]).toMatchObject({ label: 'Hold longer', seconds: 300 });
    });

    it('invalid JSON is reported and never touches the draft', async () => {
        const user = userEvent.setup();
        const { onPatch } = renderForm(waitStep());
        await user.click(screen.getByTestId('settings-json-toggle'));
        await user.clear(screen.getByLabelText('Step config as JSON'));
        await user.type(screen.getByLabelText('Step config as JSON'), '{{ nope');
        await user.click(screen.getByText('Apply JSON'));
        expect(screen.getByRole('alert').textContent).toContain('Invalid JSON');
        expect((screen.getByLabelText('Step name') as HTMLInputElement).value).toBe('Hold on');

        await user.clear(screen.getByLabelText('Step config as JSON'));
        await user.type(screen.getByLabelText('Step config as JSON'), '[[1, 2]');
        await user.click(screen.getByText('Apply JSON'));
        expect(screen.getByRole('alert').textContent).toContain('must be a JSON object');
        expect(onPatch).not.toHaveBeenCalled();
    });
});
