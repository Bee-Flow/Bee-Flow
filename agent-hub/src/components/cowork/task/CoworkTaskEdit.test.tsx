// Editing a task (./CoworkTaskEdit.tsx): "Save" for a new name or time, "Save and test" once the steps must be made
// again, and what each save sends. A recording fetch is the seam; no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkTaskEdit from './CoworkTaskEdit';
import { draftOf } from './coworkTaskEditModel';
import type { CoworkItem } from '@/api/cowork.types';
import type { TaskMode } from './coworkTaskModel';

const t = (_key: string | undefined, fallback?: unknown, params?: unknown) => {
    let text = typeof fallback === 'string' ? fallback : '';
    for (const [k, v] of Object.entries((params ?? {}) as Record<string, unknown>)) text = text.replaceAll(`{${k}}`, String(v));
    return text;
};
const ITEM: CoworkItem = {
    id: 'w1', title: 'Weekly digest', prompt: 'Sum up the week.', isActive: true, repeatInterval: 'daily', daysOfWeek: null, timeOfDay: '09:00',
    nextRunAt: '2099-11-30T08:00:00.000Z', runCount: 3, agentId: null,
};

let calls: RecordedCall[];
afterEach(() => { vi.unstubAllGlobals(); });

function edit(mode: TaskMode) {
    calls = stubRecordingFetch(() => jsonResponse({}));
    const onRebuild = vi.fn();
    const onBack = vi.fn();
    renderWithClient(<CoworkTaskEdit itemId="w1" initial={draftOf(ITEM, null, mode)} agents={[]} mayPlan onRebuild={onRebuild} onBack={onBack} t={t} />);
    return { onRebuild, onBack, user: userEvent.setup() };
}

describe('CoworkTaskEdit', () => {
    it('saves a new name right away, and the steps stay as they are', async () => {
        const { onRebuild, onBack, user } = edit('steps');
        await user.type(screen.getByLabelText('Name'), ' on Monday');
        expect(screen.getByTestId('cowork-task-edit-note')).toHaveTextContent('The steps stay as they are.');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(onBack).toHaveBeenCalled());
        const put = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/api/cowork/w1'));
        expect(put?.body).toMatchObject({ title: 'Weekly digest on Monday', prompt: 'Sum up the week.', triggerKind: 'schedule', repeatInterval: 'daily' });
        expect(onRebuild).not.toHaveBeenCalled();
    });

    it('says "Save and test" once the sentence of a task with fixed steps changes, and has the steps made again', async () => {
        const { onRebuild, onBack, user } = edit('steps');
        await user.type(screen.getByLabelText('What should be done?'), ' Add the open invoices.');
        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Save and test' }));
        await waitFor(() => expect(onRebuild).toHaveBeenCalledTimes(1));
        expect(onBack).toHaveBeenCalled();
    });

    it('turns a task the AI does into fixed steps with "Save and test"', async () => {
        const { user } = edit('ai');
        expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
        await user.click(screen.getByRole('radio', { name: /Fixed steps/ }));
        expect(screen.getByRole('button', { name: 'Save and test' })).toBeEnabled();
    });

    it('turns fixed steps back into the AI with "Save", and takes the steps off', async () => {
        const { onRebuild, user } = edit('steps');
        await user.click(screen.getByRole('radio', { name: /The AI does it each time/ }));
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/api/cowork/w1/plan'))).toBe(true));
        expect(onRebuild).not.toHaveBeenCalled();
    });
});
