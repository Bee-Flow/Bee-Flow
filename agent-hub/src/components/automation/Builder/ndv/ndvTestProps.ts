import { render, type RenderOptions } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import QueryTestWrapper from './QueryTestWrapper';

/**
 * Props and a render for a NodeDetailView under test, shared by its suites
 * (NodeDetailView.*.test.jsx) so each one states only what its case is about.
 *
 * Every builder returns fresh vi.fn()s per call. The component is not
 * imported here: several suites load it after their vi.mock()s, with an
 * `await import('./NodeDetailView')`.
 */

type Step = { id: string; type: string } & Record<string, unknown>;
type Definition = { trigger: Step; steps: Step[]; edges: Array<{ from: string; to: string }> };
type Props = Record<string, unknown>;

/** Open `step` of `definition`: no run yet, no validation findings. `overrides` win. */
export function ndvProps(step: Step, definition: Definition, overrides: Props = {}): Props {
    return {
        step,
        runStep: null,
        runSteps: [],
        definition,
        rootDefinition: definition,
        onSaveStep: vi.fn().mockResolvedValue(undefined),
        validation: { errors: [], warnings: [] },
        modelTiers: {},
        onClose: vi.fn(),
        ...overrides,
    };
}

/** An AI step alone in a manual routine: what the plain suites open. */
export const AI_STEP: Step = { id: 's1', type: 'ai_step', label: 'My AI', prompt: 'Do X', inputs: {}, outputFields: [] };
export const AI_DEFINITION: Definition = { trigger: { id: 't1', type: 'trigger', kind: 'manual' }, steps: [AI_STEP], edges: [] };

/** AI_STEP opened, with Execute and Retry wired. */
export const aiStepProps = (overrides: Props = {}): Props =>
    ndvProps(AI_STEP, AI_DEFINITION, { onExecuteStep: vi.fn(), onRetryFromStep: vi.fn(), ...overrides });

/** A tool catalog with one app (Gmail, one action), so a tool step has a readable name. */
export const GMAIL_CATALOG = {
    apps: [{
        id: 'gmail',
        label: 'Gmail',
        available: true,
        actions: [{ name: 'gmail_search', label: 'Search' }],
    }],
    triggerOutputs: {},
};

/**
 * `step` as the only step after a schedule trigger (a trigger opens the
 * trigger itself), in a saved routine, with GMAIL_CATALOG.
 */
export function scheduledStepProps(step: Step, extra: Props = {}): Props {
    const trigger: Step = { id: 'trg', type: 'trigger', kind: 'schedule', output: {} };
    const steps = step.type === 'trigger' ? [] : [step];
    const definition: Definition = { trigger, steps, edges: steps.length ? [{ from: 'trg', to: step.id }] : [] };
    return ndvProps(step.type === 'trigger' ? trigger : step, definition, {
        automation: { id: 'a1', definition },
        catalog: GMAIL_CATALOG,
        ...extra,
    });
}

/** render() inside the QueryClient the drawer's editors read through. */
export const renderInQueryClient = (ui: ReactElement, opts?: RenderOptions) =>
    render(ui, { wrapper: QueryTestWrapper, ...opts });
