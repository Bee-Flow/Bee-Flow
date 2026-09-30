/**
 * The approval editor on screen: the approver is picked from the org's
 * directory; a question's binding name is minted when its label is left and
 * shown as stored; turning stages on carries the approver into stage 1, and
 * removing the last stage goes back to one round.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { api } from '@/core/api/client';
import type { FlowNode } from '@/features/flow-editor/bindings';

import { renderEditor } from '../testing';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const get = api.get as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
    get.mockImplementation(async (url: string) =>
        url === '/api/automation/approvals/directory' ? { members: [{ id: 'u1', name: 'Ann' }], groups: [{ id: 'g1', name: 'Finance' }] } : [],
    );
});

const step = { id: 'a1', type: 'approval', label: 'Sign off', icon: 'Check', prompt: 'Send it?', approval: { expiresInHours: 168 } } as unknown as FlowNode;

describe('ApprovalEditor', () => {
    it('points at Insert data, and shows its examples as their pills read, never as {{…}}', async () => {
        await renderEditor({ ...step, prompt: '' } as FlowNode);
        expect(await screen.findByText(/Tap Insert data to pull in values from earlier steps/)).toBeTruthy();
        expect(screen.getByPlaceholderText('Send the ‹Previous step ▸ Total› quote to ‹Trigger ▸ Client›?')).toBeTruthy();
        expect(screen.getByPlaceholderText('**Client:** ‹Trigger ▸ Client›\n**Total:** ‹Previous step ▸ Total›')).toBeTruthy();
        expect(screen.queryByText(/\{\{/)).toBeNull();
    });

    it('picks who decides from the directory', async () => {
        const h = await renderEditor(step);
        await fireEvent.press(await screen.findByTestId('approval-assignee-select'));
        await fireEvent.press(await screen.findByTestId('approval-assignee-option-g:g1'));
        expect(h.patch().approval).toMatchObject({ assignee: { groupId: 'g1' } });
    });

    it('mints a question’s name when its label is left, and shows the binding', async () => {
        const h = await renderEditor(step);
        await fireEvent.press(await screen.findByTestId('approval-question-add'));
        const label = screen.getByTestId('approval-question-1-label');
        await fireEvent.changeText(label, 'Invoice number');
        expect(screen.getByText('Later steps read this answer as output.answers.q1')).toBeTruthy();
        await fireEvent(label, 'blur');
        expect(screen.getByText('Later steps read this answer as output.answers.invoice_number')).toBeTruthy();
        expect(h.patch().approval).toMatchObject({ fields: [{ name: 'invoice_number', label: 'Invoice number', type: 'text' }] });
    });

    it('turns stages on with the approver in stage 1, and back to one round', async () => {
        const one = { ...step, approval: { expiresInHours: 24, assignee: { userId: 'u1' } } } as unknown as FlowNode;
        const h = await renderEditor(one);
        await fireEvent.press(await screen.findByTestId('approval-use-stages'));
        expect(screen.getByText('Stage 1 of 1')).toBeTruthy();
        expect(h.patch().approval).toEqual({ expiresInHours: 24, stages: [{ key: 's1', approvers: [{ userId: 'u1' }], rule: 'all' }] });
        await fireEvent.press(screen.getByTestId('approval-use-simple'));
        await waitFor(() => expect(screen.getByTestId('approval-assignee-select')).toBeTruthy());
        expect(h.patch()).toEqual({});
    });

    it('sets a deadline, and offers escalation only to a single approver', async () => {
        const h = await renderEditor(step);
        await fireEvent.press(await screen.findByTestId('approval-deadline-select'));
        await fireEvent.press(screen.getByTestId('approval-deadline-option-0'));
        expect(h.patch().approval).toMatchObject({ expiresInHours: 0 });
        expect(screen.getByText('Escalate to')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('approval-more'));
        expect(screen.queryByText('Escalate to')).toBeNull();
    });
});
