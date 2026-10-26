import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import SettingsForm from './SettingsForm';
import { editor, typeInEditor } from '../../../../test/refEditor';
import scopedStorage from '../../../../utils/scopedStorage';
import { VariablePickerProvider } from '../mapping/VariablePickerContext';
import type { ComponentProps } from 'react';
import { partial, stub } from '@/test/mocks';

/**
 * The notification step's delivery target. `channels` was honoured by the
 * runner from the start (in-app bell and email, both real) but the form never
 * rendered it, so the step could say WHAT to send and never WHERE — and email
 * was reachable only by hand-editing the JSON (BFSF-350).
 */

const noIssues = { errors: [], warnings: [] };

function renderForm(step: ComponentProps<typeof SettingsForm>['step']) {
    const onPatch = vi.fn();
    const utils = render(
        <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()}>
            <SettingsForm step={step} modelTiers={{}} stepIssues={noIssues} saving={false} saveError={null} onPatch={onPatch} catalog={null} groups={[]} />
        </VariablePickerProvider>,
    );
    return { onPatch, ...utils };
}

const notifyStep = (over = {}) => ({ id: 'n1', type: 'notification', title: 'Invoice in', body: '', ...over });
const pill = (name: string) => screen.getByRole('button', { name: new RegExp(name, 'i') });

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    scopedStorage.setCurrentUser('notification-test-user');
    try { localStorage.clear(); } catch {}
});

describe('SettingsForm — notification channels', () => {
    it('says where the message goes, and that the bell is the Bee Flow one', () => {
        renderForm(stub<Parameters<typeof renderForm>[0]>(notifyStep()));
        expect(screen.getByText('Send to')).toBeTruthy();
        // In the open, not behind a hint icon — "where does this even go?" was
        // the whole of the report.
        expect(screen.getByText(/notification centre/i)).toBeTruthy();
        expect(screen.getByText(/email goes to the person/i)).toBeTruthy();
    });

    it('shows the bell lit for a step that never set a channel', () => {
        renderForm(stub<Parameters<typeof renderForm>[0]>(notifyStep()));
        expect(pill('In-app bell').getAttribute('aria-pressed')).toBe('true');
        expect(pill('Email').getAttribute('aria-pressed')).toBe('false');
    });

    it("lights the bell for a step using the runner's own name for it", () => {
        // The step vocabulary calls the bell `notification`; the run-level
        // policy calls the same thing `inapp`. Either must read as "the bell".
        renderForm(stub<Parameters<typeof renderForm>[0]>(notifyStep({ channels: ['notification'] })));
        expect(pill('In-app bell').getAttribute('aria-pressed')).toBe('true');
    });

    it('adds email to the step when the pill is pressed', async () => {
        const user = userEvent.setup();
        const { onPatch } = renderForm(stub<Parameters<typeof renderForm>[0]>(notifyStep()));
        await user.click(pill('Email'));
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        const patch = onPatch.mock.calls.at(-1)![0];
        expect(patch.channels).toContain('email');
        expect(patch.channels).toContain('inapp');
    });

    it('takes email away again, and never the bell', async () => {
        const user = userEvent.setup();
        const { onPatch } = renderForm(stub<Parameters<typeof renderForm>[0]>(notifyStep({ channels: ['inapp', 'email'] })));
        expect(pill('Email').getAttribute('aria-pressed')).toBe('true');
        await user.click(pill('Email'));
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        expect(onPatch.mock.calls.at(-1)![0].channels).toEqual(['inapp']);

        // The runner rejects a notification with no known channel, so the bell
        // is not something the form lets you switch off.
        expect((pill('In-app bell') as HTMLInputElement).disabled).toBe(true);
    });

    it('offers no channels without a backend (the "soon" pills are gone)', () => {
        renderForm(stub<Parameters<typeof renderForm>[0]>(notifyStep()));
        for (const name of ['Slack', 'Push']) {
            expect(screen.queryByRole('button', { name: new RegExp(name) })).toBeNull();
        }
    });

    it('leaves an untouched step alone rather than stamping a default in', async () => {
        // Editing something ELSE must not write a `channels` key the step never
        // had — every notification step the user merely opened would go dirty.
        const { onPatch, container } = renderForm(stub<Parameters<typeof renderForm>[0]>(notifyStep()));
        typeInEditor(editor(partial<Parameters<typeof editor>[0]>({ container })), 'Changed');
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        expect(onPatch.mock.calls.at(-1)![0]).not.toHaveProperty('channels');
    });
});
