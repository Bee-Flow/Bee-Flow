import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ComponentType, ReactNode } from 'react';
import SettingsFormJs from '../SettingsForm';
import { VariablePickerProvider as VariablePickerProviderJs } from '../../mapping/VariablePickerContext';
import scopedStorage from '../../../../../utils/scopedStorage';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import { runStepProblem } from './runProblem';

const SettingsForm = SettingsFormJs as unknown as ComponentType<Record<string, unknown>>;
const VariablePickerProvider = VariablePickerProviderJs as unknown as ComponentType<Record<string, unknown> & { children: ReactNode }>;

// Artboard 4a on an AI step: the server blames 'prompt' (context too long,
// the model refused) or 'modelTier' (the model is unavailable).
const step = { id: 'a1', type: 'ai_step', label: 'Summarise', prompt: 'Summarise {{trigger.output.text}}', modelTier: 'fast' };

const failedRun = (settingKey: string, status = 'error') => ({
    status,
    errorInfo: { code: 'model_context_too_long', title: 'The text is too long for the model', settingKey, fixes: [] },
});

function renderForm(runStep: Record<string, unknown>) {
    return render(
        <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()}>
            <SettingsForm
                step={step}
                modelTiers={{ fast: { label: 'Fast' } }}
                stepIssues={{ errors: [], warnings: [] }}
                saving={false}
                saveError={null}
                onPatch={vi.fn()}
                catalog={{ apps: [] }}
                groups={[]}
                runStep={runStep}
            />
        </VariablePickerProvider>,
    );
}

const t: TranslateFn = (_key, fallback) => (typeof fallback === 'string' ? fallback : '');

describe('runStepProblem', () => {
    it('reads the setting and the title of a failed row only', () => {
        expect(runStepProblem(failedRun('prompt'), t)).toEqual({ settingKey: 'prompt', text: 'The text is too long for the model' });
        expect(runStepProblem(failedRun('prompt', 'handled_error'), t)?.settingKey).toBe('prompt');
        expect(runStepProblem({ ...failedRun('prompt'), status: 'success' }, t)).toBeNull();
        expect(runStepProblem({ status: 'error', errorInfo: { settingKey: null } }, t)).toBeNull();
        expect(runStepProblem(null, t)).toBeNull();
    });

    it('falls back to the cause, then to a generic sentence', () => {
        expect(runStepProblem({ status: 'error', errorInfo: { settingKey: 'prompt', cause: 'Too long.' } }, t)?.text).toBe('Too long.');
        expect(runStepProblem({ status: 'error', errorInfo: { settingKey: 'prompt' } }, t)?.text).toBe('The last run failed on this setting');
    });
});

describe('the AI step rings the setting the run failed on', () => {
    beforeEach(() => {
        cleanup();
        scopedStorage.setCurrentUser('test-user');
        try { localStorage.clear(); } catch { /* ignore */ }
    });

    it("rings the prompt for 'prompt'", () => {
        const { container } = renderForm(failedRun('prompt'));
        const ringed = container.querySelectorAll('[data-problem="true"]');
        expect(ringed).toHaveLength(1);
        expect(ringed[0].textContent).toContain('Prompt');
        expect(screen.getByTestId('param-problem').textContent).toBe('The text is too long for the model');
    });

    it("rings the model tier for 'modelTier' and opens Advanced to show it", () => {
        const { container } = renderForm(failedRun('modelTier'));
        const ringed = container.querySelectorAll('[data-problem="true"]');
        expect(ringed).toHaveLength(1);
        expect(ringed[0].textContent).toContain('Model tier');
    });

    it('rings nothing after a successful run', () => {
        const { container } = renderForm({ ...failedRun('prompt'), status: 'success' });
        expect(container.querySelector('[data-problem="true"]')).toBeNull();
    });
});
