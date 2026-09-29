import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ComponentType, ReactNode } from 'react';
import SettingsFormJs from '../../SettingsForm';
import { VariablePickerProvider as VariablePickerProviderJs } from '../../../mapping/VariablePickerContext';
import scopedStorage from '../../../../../../utils/scopedStorage';

const SettingsForm = SettingsFormJs as unknown as ComponentType<Record<string, unknown>>;
const VariablePickerProvider = VariablePickerProviderJs as unknown as ComponentType<Record<string, unknown> & { children: ReactNode }>;

// Artboard 4a: the setting the last run failed on carries the red ring. The
// server names it the way utils/stepErrorInfo.js does: 'inputs.<name>' for an
// input, 'connection' or 'tool' for the action itself.
const catalog = {
    apps: [{
        id: 'nextcloud',
        label: 'Nextcloud',
        actions: [{
            name: 'nextcloud_read_file',
            label: 'Read file',
            inputSchema: {
                type: 'object',
                properties: { path: { type: 'string', title: 'Path' } },
                required: ['path'],
            },
        }],
    }],
};

const step = {
    id: 'i1', type: 'integration_action', label: 'Read invoice', tool: 'nextcloud_read_file',
    inputs: { path: { kind: 'literal', value: '/Invoices/a.pdf' } },
};

const failedRun = (settingKey: string, status = 'error') => ({
    status,
    errorInfo: {
        code: 'nextcloud_no_access',
        title: 'Bee may not open this folder',
        titleKey: 'routines.step_error.nextcloud_no_access.title',
        settingKey,
        fixes: [],
    },
});

function renderForm(runStep: Record<string, unknown>) {
    return render(
        <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()}>
            <SettingsForm
                step={step}
                modelTiers={{}}
                stepIssues={{ errors: [], warnings: [] }}
                saving={false}
                saveError={null}
                onPatch={vi.fn()}
                catalog={catalog}
                groups={[]}
                runStep={runStep}
            />
        </VariablePickerProvider>,
    );
}

describe('the failing setting gets the red ring', () => {
    beforeEach(() => {
        cleanup();
        scopedStorage.setCurrentUser('test-user');
        try { localStorage.clear(); } catch { /* ignore */ }
    });

    it("rings the input the server names as 'inputs.<name>'", () => {
        renderForm(failedRun('inputs.path'));
        expect(screen.getByTestId('param-path').getAttribute('data-problem')).toBe('true');
        expect(screen.getByTestId('param-problem').textContent).toBe('Bee may not open this folder');
    });

    it("rings the action card for 'connection', not an input", () => {
        renderForm(failedRun('connection'));
        expect(screen.getByTestId('param-path').getAttribute('data-problem')).toBeNull();
        const card = screen.getByTestId('action-card').parentElement;
        expect(card?.getAttribute('data-problem')).toBe('true');
    });

    it('also rings after an error branch caught the failure', () => {
        renderForm(failedRun('inputs.path', 'handled_error'));
        expect(screen.getByTestId('param-path').getAttribute('data-problem')).toBe('true');
    });

    it('rings nothing when the step succeeded', () => {
        renderForm({ ...failedRun('inputs.path'), status: 'success' });
        expect(screen.queryByTestId('param-problem')).toBeNull();
    });
});
