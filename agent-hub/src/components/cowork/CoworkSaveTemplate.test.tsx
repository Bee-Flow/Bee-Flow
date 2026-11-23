// "Save as template": the owner names the template (the item's title by default) and saves it; what the sanitiser
// cleared is said after saving. The network is the seam (a recording fetch), no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkSaveTemplate from './CoworkSaveTemplate';

let calls: RecordedCall[];
afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkSaveTemplate', () => {
    it('saves the item under the name given and says what was cleared', async () => {
        calls = stubRecordingFetch(() => jsonResponse({
            template: { id: 'tpl-1', title: 'Weekly radar', brief: 'B', repeatInterval: 'weekly', hasPlan: true, createdAt: null, mine: true },
            warnings: ['Cleared the datatable on step "table".'],
        }));
        renderWithClient(<CoworkSaveTemplate coworkId="w1" title="Supplier radar" />);
        const user = userEvent.setup();
        await user.click(screen.getByText('Save as template', { selector: 'summary' }));
        const name = screen.getByLabelText('Name of the template');
        expect(name).toHaveValue('Supplier radar');
        await user.clear(name);
        await user.type(name, 'Weekly radar');
        await user.click(screen.getByRole('button', { name: 'Save as template' }));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Cleared the datatable'));
        expect(calls).toHaveLength(1);
        expect(calls[0]?.method).toBe('POST');
        expect(calls[0]?.url).toMatch(/\/api\/cowork\/w1\/save-as-template$/);
        expect(calls[0]?.body).toEqual({ title: 'Weekly radar' });
    });
});
