import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import SettingsForm from '../SettingsForm';
import { VariablePickerProvider } from '../../mapping/VariablePickerContext';
import EntitlementsContext from '../../../../licensing/EntitlementsContext';
import { authFetch } from '../../../../../utils/helpers';

vi.mock('../../../../../utils/helpers', async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: vi.fn(),
}));

/**
 * The Privacy Shield editor without the plan's privacy steps
 * (flow/planLockModel.ts): it will not turn a step INTO a kind the plan locks,
 * and says why. The step's own kind stays selectable, so an existing (maybe
 * live) step keeps its editor, and "Show real values again" is never locked.
 */

const LOCKED = { loading: false, error: null, lockReason: (id: string) => (id === 'automation_privacy_steps' ? 'ceiling' : null) };
const GRANTED = { loading: false, error: null, lockReason: () => null };

function renderEditor(step: Record<string, unknown>, ent: unknown) {
    return render(
        <EntitlementsContext.Provider value={ent as never}>
            <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()} stepTypeById={new Map()}>
                <SettingsForm step={step} modelTiers={{}} stepIssues={{ errors: [], warnings: [] }} saving={false} saveError={null} onPatch={vi.fn()} catalog={null} groups={[]} />
            </VariablePickerProvider>
        </EntitlementsContext.Provider>,
    );
}

// The mode buttons are the ones with aria-pressed; the label also names the step elsewhere on the form.
const modeButton = (label: string) => screen.getAllByRole('button')
    .find(b => b.hasAttribute('aria-pressed') && (b.textContent || '').startsWith(label)) as HTMLButtonElement;

beforeEach(() => {
    cleanup();
    vi.mocked(authFetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'ok' }) } as unknown as Response);
});

describe('Privacy Shield editor: the plan', () => {
    it('a restore step cannot become a check or a hide, and the editor says why', () => {
        renderEditor({ id: 'u1', type: 'untokenize', sourceRef: 'steps.t.output.text' }, LOCKED);
        expect(modeButton('Show real values again').disabled).toBe(false);
        expect(modeButton('Check for personal data').disabled).toBe(true);
        expect(modeButton('Check and hide').disabled).toBe(true);
        expect(modeButton('Hide personal data').disabled).toBe(true);
        expect(screen.getByTestId('privacy-plan-locked').textContent).toMatch(/part of the Enterprise plan/);
    });

    it('an existing check keeps its own kind, but cannot become a hide step', () => {
        renderEditor({ id: 'g1', type: 'guard', sourceRef: 'trigger.output.text' }, LOCKED);
        expect(modeButton('Check for personal data').disabled).toBe(false);
        expect(modeButton('Check and hide').disabled).toBe(false);
        expect(modeButton('Hide personal data').disabled).toBe(true);
        expect(modeButton('Show real values again').disabled).toBe(false);
    });

    it('with the plan nothing is locked', () => {
        renderEditor({ id: 'u1', type: 'untokenize', sourceRef: 'steps.t.output.text' }, GRANTED);
        for (const label of ['Check for personal data', 'Check and hide', 'Hide personal data', 'Show real values again']) {
            expect(modeButton(label).disabled).toBe(false);
        }
        expect(screen.queryByTestId('privacy-plan-locked')).toBeNull();
    });
});
