import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ComponentType } from 'react';

// NDV fetches the tool catalog on mount: stub the API with one Nextcloud action.
const { api } = vi.hoisted(() => ({
    api: {
        getCatalog: vi.fn().mockResolvedValue({
            apps: [{
                id: 'nextcloud',
                label: 'Nextcloud',
                actions: [{
                    name: 'nextcloud_read_file',
                    label: 'Read file',
                    inputSchema: { type: 'object', properties: { path: { type: 'string', title: 'Path' } }, required: ['path'] },
                }],
            }],
            triggerOutputs: {},
        }),
    },
}));
vi.mock('../../../hooks/useAutomationApi', () => ({ default: () => api }));

import QueryTestWrapper from './ndv/QueryTestWrapper';
import NodeDetailViewJs from './NodeDetailView';

const NodeDetailView = NodeDetailViewJs as unknown as ComponentType<Record<string, unknown>>;

const step = {
    id: 's1', type: 'integration_action', label: 'Read invoice', tool: 'nextcloud_read_file',
    inputs: { path: { kind: 'literal', value: '/Invoices/a.pdf' } },
};
const definition = { trigger: { id: 't1', type: 'trigger', kind: 'manual' }, steps: [step], edges: [] };

const failedRun = (settingKey: string) => ({
    stepId: 's1',
    status: 'error',
    error: 'HTTP 404',
    errorInfo: {
        code: 'nextcloud_not_found',
        title: 'The file was not found',
        cause: 'Nothing lives at /Invoices/a.pdf.',
        settingKey,
        fixes: [
            { id: 'pick_other', label: 'Pick another', labelKey: 'routines.output.fix_pick_other', params: { settingKey } },
            { id: 'retry', label: 'Try again', labelKey: 'routines.output.fix_retry' },
        ],
        technical: 'HTTP 404',
    },
});

function renderNdv(runStep: Record<string, unknown>, onRetryFromStep = vi.fn()) {
    render(
        <NodeDetailView
            step={step}
            runStep={runStep}
            runSteps={[runStep]}
            definition={definition}
            rootDefinition={definition}
            onSaveStep={vi.fn().mockResolvedValue(undefined)}
            validation={{ errors: [], warnings: [] }}
            modelTiers={{}}
            onExecuteStep={vi.fn()}
            onRetryFromStep={onRetryFromStep}
            onClose={vi.fn()}
            density="full"
        />,
        { wrapper: QueryTestWrapper },
    );
    return { onRetryFromStep };
}

describe('the error card fixes reach the drawer (artboard 4a)', () => {
    beforeEach(() => {
        cleanup();
        Element.prototype.scrollIntoView = vi.fn();
    });

    it('"Pick another" shows the ringed setting in column 2', async () => {
        const user = userEvent.setup();
        renderNdv(failedRun('inputs.path'));
        const ringed = await screen.findByTestId('param-path');
        await waitFor(() => expect(ringed.getAttribute('data-problem')).toBe('true'));
        await user.click(screen.getByRole('button', { name: 'Pick another' }));
        expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
        expect(ringed.contains(document.activeElement)).toBe(true);
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('explains in words when no setting is ringed', async () => {
        const user = userEvent.setup();
        renderNdv(failedRun('modelTier'));
        await user.click(await screen.findByRole('button', { name: 'Pick another' }));
        await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Model'));
    });

    it('"Try again" retries from this step', async () => {
        const user = userEvent.setup();
        const { onRetryFromStep } = renderNdv(failedRun('inputs.path'));
        await user.click(await screen.findByRole('button', { name: 'Try again' }));
        expect(onRetryFromStep).toHaveBeenCalledWith('s1');
    });
});
